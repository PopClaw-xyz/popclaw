/**
 * Dreaming — the two-tool shape (spec `docs/superpowers/specs/2026-07-26-social-log-and-dream-architecture.md`
 * §1/§2 + Appendix A, step 3). Replaces the old `DreamerPass` + `DreamerService`.
 *
 * ## Why split into two tools
 *
 * > **The plugin never thinks for itself. It does exactly two things: prepare
 * > material, and file away the result.** (spec §0)
 *
 * The old `DreamerPass` called `llmComplete` itself. On a subscription host
 * there's no static key, and it only ever worked because the owner had once
 * hand-configured the `popclaw-recommend` side-agent — swap to a different
 * machine and it fails silently. The new shape is isomorphic to the daily
 * paper, which already works end to end:
 *
 *   `popclaw_dream` (fetch material) → agent thinks with **the host's own model**
 *   → `popclaw_record_dream` (write back)
 *
 * ## Why setInterval was removed
 *
 * Scheduling is now OpenClaw cron's job, and **only gets set up when the owner
 * says the word and has the agent schedule it** — the plugin does not stuff a
 * cron job into the user's system on its own (spec §1). Cron has an
 * `openclaw cron runs` history you can inspect — that's the sole criterion
 * (from the ADR-0012 Correction 2026-07-26 lesson: "only take responsibility
 * for what you can report success/failure on") that clears it for use here.
 *
 * ## The window: ask "last dream → now", never "yesterday"
 *
 * Miss a knock and the next window just grows to cover it; machine sleep,
 * shutdown, cron outages all self-heal — **none of this depends on cron's
 * catch-up/backfill semantics**. Two separate cursors each own their own
 * span: `bonds.last_dream_ts` covers each person's posts (already existed),
 * and this module's `lastDreamAt` covers the social-log span.
 *
 * ## Two raw materials, two outputs
 *
 * Raw material A (the world's chatter) + raw material B (the social log) →
 * output ① the bond book ② the learned layer of taste. **Output must carry
 * tags**: the tail hooks onto every tool call and can only do local matching
 * — free-form prose can only be fed to an LLM (expensive). So `recordDream`
 * hard-rejects taste conclusions with no tags (Appendix A.3).
 */
import type { Bond, BondsStore } from '../bonds/bonds-store.js';
import type { SocialLogRecord } from '../social-log/social-log.js';
import type { LearnedTaste } from '../taste/learned-writer.js';
import type { DreamCronState } from './dream-cron.js';
import type { CreatedProposal } from '../bonds/propose-tier-changes.js';
import type { NotificationKind } from '../notifier/types.js';
import { resolveTz, timeContext } from '../time/time-context.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

const DREAM_SCAN_LIMIT = 1000; // Scan the most recent N world-feed entries (same as the old DreamerPass)
const MAX_POSTS_PER_PERSON = 10; // Cap on posts per person going into the prompt
const MAX_LOG_ENTRIES = 200; // Max social-log entries digested per dream
const LOG_TEXT_PREVIEW = 300; // Truncation length for each log entry's body
const MAX_TAGS = 8;
/** First window when a dream has never happened before. Without a cap this would dump a whole year of logs into the prompt at once. */
const FIRST_DREAM_WINDOW_SECS = 30 * 24 * 3600;
/** No dream for this long in a row → status raises a to-do (③ the degradation must sound). */
export const DREAM_STALE_SECS = 3 * 24 * 3600;

/** The handful of world-feed entry fields dreaming needs (structured, decoupled from WorldFeedCache). */
export interface DreamPost {
  authorPopclawId: string;
  handle: string;
  textPreview: string;
  platform: string;
  platformPostCreatedAt: number; // seconds
}

export interface DreamCacheLike {
  recent(n: number): readonly DreamPost[];
}

/** What the token binds: the agent can only write back this exact batch of people, and the cursors here decide it too — not the agent. */
interface DreamManifest {
  /** popclaw_id → the latest post ts processed this round (used by markDreamed on write-back). */
  readonly cursors: ReadonlyMap<string, number>;
  readonly windowTo: number;
}

// ponytail: an in-process Map, same pattern as newspaper/manifest-store.ts. Fetch-material →
// write-back happens within the same agent turn; entries are short-lived. The cap only
// guards against a stuck-token leak.
//
// The receipt id is printed on the material page under TWO names (owner ruling
// 2026-09-06): `dream_token` (the primary leg, a top-level
// `*_token` argument) and `dream_basis` (the compatible leg — the same id handed
// back under a plain, non-token name, mirroring the newspaper's `edit.basis`
// protocol). Why two: on the night of 2026-09-06 the run's record_dream calls
// (five, per an independent read of the transcript) all arrived with
// `dream_token` as a placeholder and were refused, while the id was printed in
// full on the material page the model had just read. Where the placeholder comes
// from is UNKNOWN — model output, an in-flight rewrite and log redaction were
// never distinguished — so nothing here promises a plain name cannot be washed
// too; that is exactly why `recordDream` refuses unprovable hand-ins instead of
// guessing. A real token still works exactly as before; the basis gets the SAME
// batch/lifetime checks; two reliable ids naming different batches refuse; a
// hand-in with neither usable refuses. Every refusal leaves the ledger entry and
// every cursor untouched.
const MAX_TOKENS = 16;
const tokens = new Map<string, DreamManifest>();

/** For test cleanup only. Do not call from production code. */
export function _resetDreamTokensForTest(): void {
  tokens.clear();
}

// ---------------------------------------------------------------------------
// Fetch material
// ---------------------------------------------------------------------------

export interface GatherDreamDeps {
  bondsStore: Pick<BondsStore, 'list'>;
  cache: DreamCacheLike;
  /** Curried form of `readSocialLog(dir, from, to)`; the directory is injected by index.ts. */
  readSocialLog: (fromSec: number, toSec: number) => readonly SocialLogRecord[];
  /** The owner-sovereign taste text (merged body of core/*.md); may be empty. */
  coreTaste: string;
  /** The learned layer written by the last dream; this dream must MERGE on top of it. */
  learned: LearnedTaste;
  /**
   * Another line of inference: mined from the owner's and agent's conversation
   * history (`learned/from-memory.md`). **Read-only context, not managed by
   * dreaming** — the two files never overwrite each other. It's shown here so
   * the same fact doesn't get stated twice in two places with two different
   * versions (the owner would see the two files contradicting each other).
   */
  fromMemory?: LearnedTaste;
  /** Timestamp of the last successful write-back (seconds); null = never dreamed. */
  lastDreamAt: number | null;
  now: () => number; // seconds
  mintToken: () => string;
  /** S3 rollout — the owner-facing "empty" message only; defaults to `ownerLang()`. */
  lang?: Lang;
}

export type GatherDreamResult =
  | { kind: 'empty'; message: string }
  | { kind: 'ready'; payload: string; dreamToken: string };

interface PersonBlock {
  bond: Bond;
  posts: readonly DreamPost[];
  maxTs: number;
}

function daysAgo(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 86_400));
}

/**
 * Dates are always the owner's local time (ADR-0045). **Each social log entry
 * is narrated in the `tz` it stored at its own write-time** — "whatever
 * timezone it was in on that day" is exactly what charter D3 exists to
 * protect; only an entry with no stored tz (a historical row predating this
 * field) falls back to the current owner tz.
 */
function ymd(tsSec: number, tz?: string): string {
  return timeContext(tsSec, resolveTz(tz)).ymd;
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
}

/**
 * Compress one social log entry into a single line. A field we can't get
 * simply doesn't appear (the log itself already follows "omit what you
 * can't get").
 *
 * S2 scope call (rollout slice 4, same call as bonds/find-bonds.ts): this
 * feeds straight into `buildDreamPayload`'s LLM-facing material, not
 * owner-facing copy, so it lives in plain English — no lexicon lane.
 */
function renderLogLine(r: SocialLogRecord): string {
  const who = r.actor?.name || r.actor?.sigil || r.actor?.id?.slice(0, 8) || '';
  const tier = r.actor?.tier_then ? `, tier=${r.actor.tier_then}` : '';
  const head = who ? ` with=${who}${tier}` : '';
  const text = r.text ? ` text="${clip(r.text, LOG_TEXT_PREVIEW)}"` : '';
  const quoted = r.in_reply_to?.text ? ` replying to="${clip(r.in_reply_to.text, LOG_TEXT_PREVIEW)}"` : '';
  return `- ${ymd(r.ts, r.tz)} ${r.kind}${head}${text}${quoted}`;
}

export function gatherDreamMaterials(deps: GatherDreamDeps): GatherDreamResult {
  const now = deps.now();
  const windowFrom = deps.lastDreamAt ?? now - FIRST_DREAM_WINDOW_SECS;

  // ── Raw material A: new posts from followed people (one cursor per person, same convention as the old implementation)
  const followed = deps.bondsStore.list({}).filter((b) => b.followed);
  const byAuthor = new Map<string, DreamPost[]>();
  for (const it of deps.cache.recent(DREAM_SCAN_LIMIT)) {
    const arr = byAuthor.get(it.authorPopclawId);
    if (arr) arr.push(it);
    else byAuthor.set(it.authorPopclawId, [it]);
  }
  const people: PersonBlock[] = [];
  for (const bond of followed) {
    const fresh = (byAuthor.get(bond.popclawId) ?? [])
      .filter((p) => p.platformPostCreatedAt > (bond.lastDreamTs ?? 0))
      .sort((a, b) => a.platformPostCreatedAt - b.platformPostCreatedAt);
    if (fresh.length === 0) continue;
    people.push({
      bond,
      posts: fresh.slice(-MAX_POSTS_PER_PERSON),
      maxTs: fresh[fresh.length - 1]!.platformPostCreatedAt,
    });
  }

  // ── Raw material B: the social log (evidence for both bonds and taste at once)
  const log = deps.readSocialLog(windowFrom, now).slice(-MAX_LOG_ENTRIES);

  // Both empty = nothing to digest. Say so honestly (an empty world feed is
  // often a scraping problem), and **do not advance the cursor** — so
  // status's "hasn't dreamed in N days" keeps firing as normal (③).
  if (people.length === 0 && log.length === 0) {
    return {
      kind: 'empty',
      message: renderCopy(deps.lang ?? ownerLang(), 'dream.emptyMaterial', { window: ymd(windowFrom) }),
    };
  }

  const cursors = new Map(people.map((p) => [p.bond.popclawId, p.maxTs]));
  const dreamToken = deps.mintToken();
  if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value as string);
  tokens.set(dreamToken, { cursors, windowTo: now });

  return { kind: 'ready', payload: buildDreamPayload(deps, { people, log, windowFrom, now, dreamToken }), dreamToken };
}

/**
 * S2 scope call (rollout slice 4, same call as bonds/find-bonds.ts): this
 * whole payload is LLM-facing material for the agent's own reasoning
 * (popclaw_dream → agent thinks → popclaw_record_dream), never relayed to
 * the owner verbatim, so it lives in plain English like every other
 * agent-facing prompt in this codebase — no lexicon lane. The owner-facing
 * receipts in `recordDream` below are the bilingual surface.
 */
function buildDreamPayload(
  deps: GatherDreamDeps,
  x: { people: PersonBlock[]; log: readonly SocialLogRecord[]; windowFrom: number; now: number; dreamToken: string },
): string {
  const L: string[] = [];
  const since =
    deps.lastDreamAt === null ? 'never dreamed before' : `last dreamed ${daysAgo(deps.lastDreamAt, x.now)} day(s) ago`;

  // The receipt pair, rendered ONCE and printed in TWO places (front of page +
  // [How to deliver]) from the same `x.dreamToken` — the front block exists so
  // the ids are read BEFORE any history material (the 2026-09-06 F1
  // incident: the PERSISTED
  // copy of that page contained the batch receipts; the history material
  // contained a quoted OLD bug report; narrative interference is a HYPOTHESIS —
  // the host's final-to-model text and the model's internal reasons are
  // unverified). Layout only: no validation, window/cursor/sampling, or
  // renderLogLine trimming changes. The instruction deliberately does NOT
  // promise "this page is complete" (real transmission can still truncate),
  // and does NOT require both fields — any ONE usable leg (dream_token,
  // top-level dream_basis, or a basis copied inside people) proves the batch.
  const receiptTokenLine = `  dream_token = "${x.dreamToken}"`;
  const receiptBasisLine = `  dream_basis = "${x.dreamToken}"`;
  L.push(
    "[This batch's metadata — read before the history below]",
    receiptTokenLine,
    `${receiptBasisLine} (the same id under a plain, non-token name — either one alone proves this batch)`,
    "  The error reports quoted in the history below describe PAST calls, not this one. Use THIS batch's metadata above;",
    '  if the current receipt is missing or conflicts, stop — do not guess, do not fall back to values found in history.',
    '',
  );

  L.push(
    "You're dreaming on the owner's behalf: digest this stretch of time into two lasting assets.",
    `Window: ${ymd(x.windowFrom)} → ${ymd(x.now)} (${since}).`,
    '',
    '[Two outputs]',
    '① Bond book — what you know about OTHER people: who they are, what they are talking about, any major news.',
    '② Taste — what you know about the OWNER: what they care about, what they do not want to see.',
    '',
    '[How to think about it]',
    "· Material A (new posts from people they follow) tells you what those people are talking about, and also what has crossed the owner's view.",
    '· Material B (the owner\'s own social actions) is evidence for BOTH bonds and taste at once — replying to',
    '  someone three times shows both that you two are close, and that this topic is something they care about.',
    '  Weigh material B more heavily for taste; A is just background.',
    '· What the owner wrote down themselves is the SOVEREIGN layer; your conclusions are the SUGGESTED layer: you',
    '  may add to it, never overrule what they said themselves.',
    '',
  );

  if (x.people.length > 0) {
    L.push(`[Material A · new posts from people you follow] ${x.people.length} people`, '');
    x.people.forEach(({ bond, posts }, i) => {
      const name = bond.remarkName || bond.nickname || '';
      L.push(`[person ${i + 1}] popclaw_id=${bond.popclawId}${name ? ` name=${name}` : ''} tier=${bond.tier}`);
      L.push(`  existing tags: ${bond.tags.length ? bond.tags.join(', ') : '(none)'}`);
      L.push(`  existing profile: ${bond.description || '(none)'}`);
      for (const p of posts) L.push(`  · (${p.platform}) ${clip(p.textPreview, LOG_TEXT_PREVIEW)}`);
      L.push('');
    });
  } else {
    L.push('[Material A · new posts from people you follow] No new posts in this window.', '');
  }

  if (x.log.length > 0) {
    L.push(`[Material B · the owner's own social actions] ${x.log.length} entries`, ...x.log.map(renderLogLine), '');
  } else {
    L.push("[Material B · the owner's own social actions] No actions in this window.", '');
  }

  L.push(
    '[What the owner wrote down themselves (sovereign layer, never overrule)]',
    deps.coreTaste.trim() || '(they have not said anything yet)',
    '',
    '[Taste from the last dream (suggested layer, add to/remove from this)]',
    `Likes: ${deps.learned.tags.length ? deps.learned.tags.join(', ') : '(none)'}`,
    `Mutes: ${deps.learned.mute.length ? deps.learned.mute.join(', ') : '(none)'}`,
    deps.learned.summary || '',
    '',
    ...(deps.fromMemory && (deps.fromMemory.tags.length || deps.fromMemory.mute.length)
      ? [
          '[Another source: dug from my own conversation history with the owner (read-only, not yours to manage, do not repeat it)]',
          `Likes: ${deps.fromMemory.tags.join(', ') || '(none)'}`,
          `Mutes: ${deps.fromMemory.mute.join(', ') || '(none)'}`,
          '',
        ]
      : []),
    '[How to deliver] Call popclaw_record_dream with your conclusions (do not just tell the owner directly — only writing it back counts):',
    receiptTokenLine,
    `${receiptBasisLine} — the SAME id under a plain, non-token name. Pass it back as the dream_basis argument of popclaw_record_dream (copying it into every people entry works too — same value; either way it must not depend on having people to report). On some channels the token-shaped argument has come back as a placeholder (where that happens is unknown); this plain-named id then proves which batch of material your conclusions came from, and it is checked exactly like the token.`,
    '  people = one entry per person with a new post: {popclaw_id, dream_basis (copy the line above, verbatim), tags (add/remove on top of existing tags, lowercase, 1-3 words, up to ' +
      `${MAX_TAGS}), description (profile, <=60 chars), dynamics: [{summary (recent update, <=20 chars), milestone (true only for birth/marriage/graduation/new job/funding/award/serious illness or death/going viral)}]}`,
    '  · Skip a person ENTIRELY if you are not sure — their cursor will not advance, you will see them again next dream.',
    '  taste = {tags: [...], mute: [...], summary: "..."}',
    "  · tags is REQUIRED and must not be empty — the owner's relevance hints on every tool call can only do local",
    '    tag matching, it cannot run an LLM. Submitting only prose means nothing gets captured — the tool will reject it.',
    '  · tags/mute are a FULL OVERWRITE: carry the suggested layer above forward with your additions/removals, do not submit only what is new this round.',
    // r39 adjacent copy fix: this one sentence used to name only the people-inner
    // basis leg, which contradicted both the page's own front matter and
    // recordDream's actual legs (top-level dream_basis argument included). Copy
    // only — no behavior change.
    '  · A hand-in with neither a real dream_token, nor a dream_basis (top-level or inside people) is refused, not guessed — and a',
    '    refusal never consumes the material, so fix the field up and submit again.',
  );
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Write back
// ---------------------------------------------------------------------------

export interface DreamPersonResult {
  popclaw_id: string;
  /**
   * Compatible provenance, people-payload form (owner ruling 2026-09-06):
   * the receipt id the material page prints as
   * `dream_basis`, accepted here for hand-ins that already carried it inside the
   * payload. The TOP-LEVEL `dream_basis` argument (RecordDreamInput.dreamBasis)
   * is the taught leg — it keeps the receipt working when there are no people to
   * report (taste-only hand-ins, or every person skipped), which the per-entry
   * form could never cover. Per-BATCH, not per-person; both forms must agree.
   * `recordDream` reads it, the write-back below ignores it.
   */
  dream_basis?: string;
  tags?: string[];
  description?: string;
  dynamics?: { summary: string; milestone?: boolean }[];
}

export interface RecordDreamInput {
  /** The primary leg. Empty/placeholder when the channel hands back a washed token — the basis leg then carries provenance. */
  dreamToken: string;
  /** The compatible leg (r26 top-level form): the receipt id printed as `dream_basis` on the material page. */
  dreamBasis?: string;
  people?: DreamPersonResult[];
  taste?: { tags?: string[]; mute?: string[]; summary?: string };
}

export interface RecordDreamDeps {
  bondsStore: Pick<BondsStore, 'setKnowledge' | 'addDynamic' | 'markDreamed'>;
  writeLearnedTaste: (t: LearnedTaste) => Promise<void>;
  /** Bond-tier upgrade suggestions (reads interaction density, no LLM needed) — used to hang off the dreamer tick. */
  proposeTierChanges: () => CreatedProposal[];
  /**
   * Hands the night's findings to the notifier as L2. Without it the
   * dreamer's work is silent: the proposals and the
   * milestones sit in the review card, and an owner who never runs
   * `/popclaw review` never learns they exist.
   *
   * L2 on purpose — "write the inbox, tell them next time they speak" is
   * exactly the right loudness for something the dreamer noticed at 3am.
   * Not injected = the old silence, byte for byte.
   */
  notify?: (item: { level: 'L2'; kind: NotificationKind; payload: Record<string, unknown> }) => void;
  /** Records "this dream succeeded"; the next window starts counting from here. */
  stampDream: (ts: number) => void;
  /** Local backup (a mechanical action, not part of dreaming; also used to hang off the dreamer tick). A failure must not sink the write-back. */
  backup?: () => void | Promise<void>;
  /**
   * Whether the dream cron job got scheduled. `null` / not injected = couldn't
   * check → **don't ask** (couldn't check ≠ not scheduled). Only ask, at the
   * moment the dream finishes, when it's confirmed "not scheduled".
   */
  dreamCron?: () => Promise<DreamCronState>;
  now: () => number;
  logger?: { info(m: string): void; warn(m: string): void };
  /** S3 rollout — the owner-facing receipts only; defaults to `ownerLang()`. */
  lang?: Lang;
}

export async function recordDream(
  deps: RecordDreamDeps,
  input: RecordDreamInput,
): Promise<{ text: string }> {
  const lang = deps.lang ?? ownerLang();

  // ── Provenance: two legs, no guessing (the newspaper `edit.basis` pattern,
  // owner ruling 2026-09-06; r26: the basis no longer depends on people). The
  // primary leg is the `dream_token` argument, unchanged; the compatible leg is
  // the same id handed back under the plain name `dream_basis` — as a top-level
  // argument (the taught form, so taste-only hand-ins and all-persons-skipped
  // hand-ins have a path too) and/or copied inside people entries. All forms
  // are normalized by one helper and one placeholder predicate, and every
  // refusal below returns BEFORE any write, stamp or ledger consumption —
  // rejecting is not the same as losing the material.
  const cleanId = (v: unknown): string =>
    typeof v === 'string' ? v.trim().replace(/^["']|["']$/g, '') : '';
  const placeholderShape = (v: string): boolean => !v || /\.\.\.|[*<>]|xxx|redacted/i.test(v);

  const givenToken = cleanId(input.dreamToken);
  const tokenReliable = !placeholderShape(givenToken);
  // The basis is a per-BATCH claim; collect the distinct reliable values across
  // BOTH forms (top-level argument + person entries). One value is the basis;
  // two different values are a contradiction inside a single hand-in
  // (conclusions merged from two material pages) — picking either would be a
  // guess, so it refuses too.
  const bases = [
    ...new Set(
      [cleanId(input.dreamBasis), ...(input.people ?? []).map((p) => cleanId(p?.dream_basis))].filter(
        (b) => !placeholderShape(b),
      ),
    ),
  ];
  if (bases.length > 1) {
    return { text: renderCopy(lang, 'dream.basisContradictory', { bases: bases.join(', ') }) };
  }
  const basis = bases[0] ?? '';
  const basisReliable = basis !== '';
  // Two reliable ids naming two different batches is a contradiction: resolving
  // it by silently picking either is a guess. (A scrubbed/missing basis carries
  // no claim at all — the token proceeds alone, exactly as before.)
  if (tokenReliable && basisReliable && basis !== givenToken) {
    return { text: renderCopy(lang, 'dream.tokenBasisConflict', { token: givenToken, basis }) };
  }
  let receiptId = givenToken;
  let viaBasis = false;
  if (!tokenReliable) {
    // No usable token. There is no "bind the newest batch" fallback to lean on:
    // which batch of material these conclusions belong to would be a guess, and
    // the wrong guess writes one night's conclusions onto another night's
    // cursors. Name a usable basis or refuse.
    if (!basisReliable) {
      return { text: renderCopy(lang, 'dream.noProvenance') };
    }
    receiptId = basis;
    viaBasis = true;
  }
  const manifest = tokens.get(receiptId);
  if (!manifest) {
    // Same lifetime rule on both legs: an id that names nothing live is dead,
    // whichever name it traveled under.
    return {
      text: viaBasis
        ? renderCopy(lang, 'dream.basisExpired', { basis: receiptId })
        : renderCopy(lang, 'dream.tokenExpired'),
    };
  }

  // The hard gate for ②: a taste conclusion with no tags equals no conclusion
  // at all. **Do not consume the token** — let the agent add tags and resubmit
  // (same pattern as publishNewspaper's fidelity gate: rejecting is not the
  // same as losing the material).
  const tasteTags = dedupe(input.taste?.tags);
  if (tasteTags.length === 0) {
    return { text: renderCopy(lang, 'dream.tagsEmpty') };
  }

  let updated = 0;
  let dynamics = 0;
  let milestones = 0;
  const bigNews: { popclawId: string; summary: string }[] = [];
  for (const p of input.people ?? []) {
    // The cursor only recognizes the batch bound to the token: if the agent
    // reports someone not in the material, we never write for them.
    const maxTs = manifest.cursors.get(p.popclaw_id);
    if (maxTs === undefined) continue;
    const tags = dedupe(p.tags).slice(0, MAX_TAGS);
    const description = (p.description ?? '').trim();
    // Everything empty = the agent came up with nothing for this person →
    // don't write, don't advance the cursor, look at them again next time.
    const dyns = (p.dynamics ?? []).filter((d) => typeof d?.summary === 'string' && d.summary.trim());
    if (tags.length === 0 && !description && dyns.length === 0) continue;

    deps.bondsStore.setKnowledge(p.popclaw_id, {
      ...(tags.length ? { tags } : {}),
      ...(description ? { description } : {}),
    });
    for (const d of dyns) {
      deps.bondsStore.addDynamic(p.popclaw_id, {
        ts: maxTs,
        summary: d.summary.trim(),
        isMilestone: d.milestone === true,
      });
      dynamics++;
      if (d.milestone === true) {
        milestones++;
        bigNews.push({ popclawId: p.popclaw_id, summary: d.summary });
      }
    }
    deps.bondsStore.markDreamed(p.popclaw_id, maxTs);
    updated++;
  }

  await deps.writeLearnedTaste({
    tags: tasteTags,
    mute: dedupe(input.taste?.mute),
    summary: (input.taste?.summary ?? '').trim(),
  });

  const proposals = deps.proposeTierChanges();
  const proposed = proposals.length;
  // Nothing found = nothing said. A dream that reports its own emptiness is
  // just noise the owner has to clear.
  for (const pr of proposals) {
    deps.notify?.({ level: 'L2', kind: 'bond_proposal', payload: { ...pr } });
  }
  for (const news of bigNews) {
    deps.notify?.({ level: 'L2', kind: 'bond_milestone', payload: { ...news } });
  }
  deps.stampDream(manifest.windowTo);
  tokens.delete(receiptId);

  // Backup is a mechanical action, not part of dreaming; it's hooked in here
  // only because it needs an "once a day" moment to hang off.
  try {
    await deps.backup?.();
  } catch (err) {
    deps.logger?.warn(`dream: daily backup failed (non-fatal) — ${String(err)}`);
  }

  const parts = [
    renderCopy(lang, 'dream.part.updated', { n: String(updated) }),
    renderCopy(lang, 'dream.part.dynamics', { n: String(dynamics) }),
  ];
  if (milestones > 0) parts.push(renderCopy(lang, 'dream.part.milestones', { n: String(milestones) }));
  if (proposed > 0) parts.push(renderCopy(lang, 'dream.part.proposals', { n: String(proposed) }));
  deps.logger?.info(
    `dream: recorded updated=${updated} dynamics=${dynamics} milestones=${milestones} proposals=${proposed} tags=${tasteTags.length}`,
  );
  return {
    text:
      renderCopy(lang, 'dream.receipt', {
        parts: parts.join(renderCopy(lang, 'dream.partSep')),
        tags: tasteTags.slice(0, 6).join(renderCopy(lang, 'dream.sep')),
      }) + (await scheduleInvite(deps, lang)),
  };
}

/**
 * **A capability should introduce itself the moment it first proves genuinely
 * valuable** (spec §5; same pattern as the daily paper's step 6).
 *
 * A mechanism that only works if it's scheduled, yet never asks to be
 * scheduled — that's not "leaving it for later", that's unfinished. The
 * owner has just watched the dream's output with their own eyes; this is the
 * only moment they can actually **know what they're agreeing to**: try it
 * first, subscribe after.
 *
 * Only ask when it's **confirmed not scheduled**. Don't ask when we couldn't
 * check (`null`) — couldn't check ≠ not scheduled; better to ask one fewer
 * time than to ask every night about someone who's already scheduled.
 */
async function scheduleInvite(deps: RecordDreamDeps, lang: Lang): Promise<string> {
  if (!deps.dreamCron) return '';
  const state = await deps.dreamCron().catch(() => null);
  if (state === null || state.scheduled) return '';
  return renderCopy(lang, 'dream.scheduleInvite');
}

/** Trim whitespace, dedupe, preserve order. Duplicate tags coming back from the LLM are the norm. */
function dedupe(xs: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const x of xs ?? []) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
