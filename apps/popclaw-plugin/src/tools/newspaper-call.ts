import { readNewspaperPage } from '../newspaper/reading-page.js';
import type { HouseRuntime } from '../runtime/house-lifecycle/house-runtime.js';
import { publicMaterialSource, PublicMaterialRefusal } from '../newspaper/public-material-source.js';
/**
 * popclaw_newspaper's one call, as the steps it always ran in: read the
 * arguments → refuse a hand-in whose picks were lost → dispatch a bare call to
 * the dedicated workshop session → read the paper's context → either answer
 * the writer's picks with the material page, or gather the candidate page.
 * The tool's registration and description stay in newspaper-tools.ts.
 */

import { PER_AUTHOR_MAX, PICK_FLOOR } from '../newspaper/gather-materials.js';
import { buildIssueFromPicks, type Picks } from '../newspaper/pick-issue.js';
import { getIssue, sweepStaleIssues } from '../newspaper/issue-store.js';
import { ownerLang, ownerLangTag, failureText } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { tierLabel } from '../bonds/bond-tier.js';
import {
  readLearnedTaste,
  readTasteProfile,
  LEARNED_DREAMED,
  LEARNED_FROM_MEMORY,
} from '../taste/learned-writer.js';
import { hostDbSlug, houseUrlOf } from '../ingress/host-slug.js';
import type { BondTier } from '../bonds/bond-tier.js';
import { gatherNewspaperMaterials, type GatherDeps, type NewspaperBond } from '../newspaper/gather-materials.js';
import {
  NewspaperStageStore,
  defaultIssueHint,
  isDedicatedSession,
  isModelOverrideRefusal,
  runDedicatedNewspaper,
} from '../newspaper/dedicated-session.js';
import { recordNewspaperDispatch } from '../host/local-newspaper-artifacts.js';
import type { PopclawPaths } from '../host/popclaw-paths.js';
import { readNewspaperContentRules, readNewspaperStyle } from '../newspaper/newspaper-files.js';
import { readHouseEntry, readHouseHandshake, readHouseVoice } from '../world/house-handshake.js';
import { readHouseDigestUrl, refreshHouseDigest, type WorldDigest } from '../world/digest-client.js';
import { type ToolsCtx } from './tools-context.js';
import { cleanProvenanceId, isCandidateId, isPlaceholderId, mintIssueToken } from '../newspaper/issue-identity.js';

/**
 * Taste tags used for the daily paper's recommendation rationale — the
 * frontmatter tags from both learned sources, merged.
 * Only tags are taken, not body text: tags are the half that **can be matched
 * with a plain local string match** (ADR-0030, zero LLM).
 */
async function readTasteTags(paths: PopclawPaths): Promise<string[]> {
  const opts = { tasteRoot: paths.tasteDir() };
  const [dreamed, memory] = await Promise.all([
    readLearnedTaste(opts, LEARNED_DREAMED),
    readLearnedTaste(opts, LEARNED_FROM_MEMORY),
  ]);
  return [...new Set([...dreamed.tags, ...memory.tags])];
}

/** The bond book, one line per person: who they are to the owner, and what happened lately. */
function bondBookLines(
  store: {
    list?(opts?: { limit?: number }): readonly {
      popclawId: string;
      nickname?: string;
      remarkName?: string;
      tier: BondTier;
      sigil?: string;
    }[];
    recentDynamics?(id: string, limit: number): readonly { summary: string }[];
  },
  nameOf?: (id: string, baked: string) => string,
): string[] {
  return (store.list?.() ?? []).map((b) => {
    const name = nameOf?.(b.popclawId, b.nickname ?? '') || b.remarkName || b.nickname || '';
    const dyn = store.recentDynamics?.(b.popclawId, 1)[0]?.summary;
    return [name && b.sigil ? `${name}#${b.sigil}` : name || b.popclawId.slice(0, 8), tierLabel(b.tier), dyn]
      .filter(Boolean)
      .join(' · ');
  });
}

type TextResult = { type: 'text'; text: string };

/** What one call needs from the registration site. */
export interface NewspaperCall {
  api: ToolsCtx['api'];
  runtime: ToolsCtx['runtime'];
  deps: ToolsCtx['deps'];
  /** The host's tool context; its `sessionKey` tells the workshop session from the owner's chat. */
  toolCtx: { sessionKey?: string };
}

interface NewspaperParams {
  page_cursor?: string;
  hours?: number;
  picks?: Picks;
  picks_flat?: readonly number[];
  candidate_token?: string;
  publish_token?: string;
  /** The candidate batch id printed on the candidate page (2026-09-06 r25, renamed 2026-09-12). */
  candidate_basis?: string;
  /** The pre-2026-09-12 name of the same argument, still accepted silently. */
  basis?: string;
}

/** The runtime slots this call reads. */
interface NewspaperRuntime {
  houseRuntime?: HouseRuntime;
  houseFeedReader?: import('../ingress/house-feed-reader.js').HouseFeedReader;
  worldFeedCache: GatherDeps['cache'];
  inboxStore: GatherDeps['inbox'];
  socialGraph: { followsIn(popclawId: string, houseSlug?: string): boolean };
  boot: {
    nickname: string;
    webBaseUrl: string;
    popclawId?: string;
    loreHouseUrls?: readonly string[];
  };
  paths: PopclawPaths;
  nameOf?: GatherDeps['nameOf'];
  bondsStore?: {
    get(id: string): NewspaperBond | null;
    recentDynamics?(id: string, limit: number): { summary: string }[];
    list?(opts?: { limit?: number }): {
      popclawId: string;
      nickname?: string;
      remarkName?: string;
      tier: BondTier;
      sigil?: string;
    }[];
  };
}

interface NewspaperArgs {
  p: NewspaperParams;
  hours: number | undefined;
  picks: Picks | undefined;
  bothGiven: boolean;
  hasPicks: boolean;
  candidateBasis: string | undefined;
}

function readNewspaperArgs(params: unknown): NewspaperArgs {
  const p = params as NewspaperParams;
  const h = p.hours;
  // Not providing hours (or providing an out-of-range one) = a true calendar-day cut for "today" (ADR-0045);
  // providing a valid one honors it as a rolling window — that's the escape hatch for wanting to look back further.
  const hours = typeof h === 'number' && Number.isInteger(h) && h > 0 && h <= 168 ? h : undefined;

  // `picks_flat` is the union-free way in for a writer whose numbers keep coming out as a
  // bare array: a top-level field needs no `anyOf`, which is what the host collapses.
  //
  // Whichever one actually carries numbers wins — **not** whichever one is merely
  // present. A host that fills a declared-but-unset object field with `{}` would
  // otherwise let an empty `picks` swallow a perfectly good `picks_flat`, which is the
  // exact species of host quirk this field exists to route around.
  const hasNumbers = (v: Picks | undefined): boolean =>
    Array.isArray(v) ? v.length > 0 : Boolean(v && Object.values(v).some((x) => x?.length));
  // Hosts hand nested objects over as JSON strings often enough that `record_dream`
  // already parses once before giving up (see `coerceRecordDream` in dream-taste-tools.ts). picks arrives
  // the same way, and without this it lands as "no usable numbers in picks" — a real
  // error message about the wrong thing, which is how a whole evening goes missing.
  const parsed = (v: unknown): Picks | undefined => {
    if (typeof v !== 'string') return v as Picks | undefined;
    try {
      return JSON.parse(v) as Picks;
    } catch {
      return undefined;
    }
  };
  const given = parsed(p.picks);
  const flat: Picks | undefined = p.picks_flat?.length ? [...p.picks_flat] : undefined;
  const picks: Picks | undefined = hasNumbers(given) ? given : flat;
  // Both carrying numbers is not an error, but silently using one of them is: every other
  // place that drops something says so in the notes, and this was the one that did not.
  const bothGiven = hasNumbers(given) && hasNumbers(flat);
  const hasPicks = hasNumbers(picks);
  // The candidate page's id, under either name: `candidate_basis` since 2026-09-12,
  // `basis` before it. One word had been naming two pages — this one and the material
  // page's id inside `edit.basis` — and a strong model duly carried the candidate id
  // into the hand-in and lost two rounds to refusals. The old name stays accepted
  // silently so a page minted before the rename still resolves within its 2h TTL.
  const candidateBasis = p.candidate_basis ?? p.basis;
  return { p, hours, picks, bothGiven, hasPicks, candidateBasis };
}

// A caller carrying a candidate_token OR candidate_basis meant to submit picks. If the picks did not
// survive the trip — the wrong shape, dropped by the host's own schema check, an empty
// object — then falling through to the gather branch hands back a **fresh candidate
// page with a fresh token**, and the writer can only read that as "my token expired".
// It tries again, and again. Real hardware, 2026-08-30: eight candidate sets minted in
// two minutes and not one issue among them, while the writer told the owner the tool
// chain was broken. It was, but not in the way either of them could see.
// Check every selector independently: an empty legacy token must not mask
// a basis-only hand-in (or another non-empty compatibility field).
function picksLostReply(args: NewspaperArgs): TextResult | undefined {
  const { p, hasPicks, candidateBasis } = args;
  if (!hasPicks && (candidateBasis || p.candidate_token || p.publish_token)) {
    const shape = (name: string, v: unknown): string | undefined =>
      v === undefined
        ? undefined
        : Array.isArray(v)
          ? `${name}=an empty array`
          : `${name}=${typeof v} with no numbers in it`;
    const got =
      [shape('picks', p.picks), shape('picks_flat', p.picks_flat)].filter(Boolean).join(' and ') ||
      'neither picks nor picks_flat';
    return {
      type: 'text' as const,
      text:
        `⚠️ Your ${candidateBasis ? 'candidate_basis' : 'candidate_token'} arrived but the picks did not (this call carried ${got}). ` +
        'Nothing was re-gathered — the candidate page you already have is still good, so do not ask for a new one ' +
        '**unless it was gathered more than two hours ago**, which is when the ledger drops it.\n' +
        'Hand the numbers back in one of these two shapes, and nothing else:\n' +
        '  picks={"taste":[…], "bond":[…], "lively":[…]}   ← preferred; it is what lets the paper tell the owner how much was chosen for him\n' +
        '  picks_flat=[…]                                  ← if you cannot say why you chose them\n' +
        'Keep the same candidate_token or candidate_basis from the candidate page. If a shape keeps being rejected before it reaches popclaw, use the other one.',
    };
  }
  return undefined;
}

/** Hand the whole job to the workshop session; if it cannot start, say why the caller degrades. */
async function dispatchToWorkshop(
  call: NewspaperCall,
  rt: NewspaperRuntime,
  hours: number | undefined,
): Promise<{ dispatched: TextResult } | { modelIgnoredNote: string | undefined }> {
  const { api, deps, toolCtx } = call;
  let modelIgnoredNote: string | undefined;
  // The getter itself lives inside the try on purpose: a getter that
  // throws (a malformed dep, a host surface that explodes on touch)
  // must degrade to the in-session flow like every other dispatch
  // failure — not surface as this tool's own failureText with no
  // dispatch AND no paper path.
  let requestedModel: string | undefined;
  try {
    const surface = deps.getSubagent?.();
    if (surface) {
      // Cut 2 (2026-09-03): the workshop's model profile, plugin config
      // `newspaper.model`. Empty/absent = the host default, in which case
      // the model key is omitted entirely (the host's override-authorization
      // gate only trips when a model IS present).
      const model = (await deps.getNewspaperModel?.())?.trim() || undefined;
      requestedModel = model;
      // The belt-and-braces channel push (gateway-only; a notifier that
      // can't be resolved just means the receipt stays in this tool result).
      const push = deps.getOwnerPush ? await deps.getOwnerPush().catch(() => undefined) : undefined;
      const text = await runDedicatedNewspaper({
        subagent: surface,
        ...(model ? { model } : {}),
        ...(push ? { deliverNow: (t) => push.deliverNow(t) } : {}),
        makeIssueHint: defaultIssueHint,
        // Two jobs (#575 and the multi-agent refusal, 2026-09-11/12): it
        // names the agent the child session must belong to — a host with
        // several agents refuses an unowned key and the dispatch silently
        // degrades every time — and it is the key the one-request-one-paper
        // guard lives under, so an impatient retry is answered instead of
        // producing a second edition.
        ...(toolCtx.sessionKey ? { parentSessionKey: toolCtx.sessionKey } : {}),
        ...(hours !== undefined ? { hours } : {}),
        // Clean slate per workshop (2026-09-03 night ruling): every ledger
        // entry stamped another day is deleted before the child runs, so a
        // fresh paper is never hijacked by a previous day's leftovers.
        // Lazy on purpose — the fake runtimes of old test rigs carry no
        // `paths`, and the sweep degrades to a logged no-op inside the
        // dispatch rather than blocking it.
        sweepStaleIssues: () => sweepStaleIssues(rt.paths.newspaperManifestsDir()),
        // Every dispatch outcome, success and failure alike, appended to the
        // durable ledger next to the issue archive. Until this existed a failed
        // run left one line in a volatile container log and nothing to count
        // (2026-09-13). Lazy for the same reason the sweep above is: old test
        // rigs carry no `paths`, and the writer swallows its own IO errors.
        recordDispatch: (record) =>
          recordNewspaperDispatch(rt.paths.newspaperDir(), record, {
            ...(api.logger ? { log: (m: string) => api.logger!.info(m) } : {}),
          }),
        ...(api.logger ? { log: (m) => api.logger!.info(m) } : {}),
      });
      return { dispatched: { type: 'text' as const, text } };
    }
  } catch (err) {
    // The dispatch could not even start (a missing request scope on the
    // subagent surface, a host refusal). Degrade honestly to the
    // in-session flow below — the owner still gets a paper today, the
    // budgetKnown() precedent: when we can't, we say so and don't guess.
    // ONE refusal is named in the receipt as well, not just logged: a
    // configured model the host declined to authorize — in EITHER
    // family (the fallback family is what cron wakeups hit, the
    // newspaper's main scheduled path; see MODEL_OVERRIDE_REFUSALS).
    // Swallowing these silently is how a model profile quietly does
    // nothing for weeks.
    if (requestedModel !== undefined && isModelOverrideRefusal(err)) {
      api.logger?.info(
        `popclaw: newspaper model ${requestedModel} refused by the host (subagent.allowModelOverride not granted) — dispatch degraded, producing in this session on the default model`,
      );
      modelIgnoredNote = renderCopy(ownerLang(), 'newspaper.dispatch.modelIgnored', {
        model: requestedModel,
      });
    } else {
      api.logger?.info(
        `popclaw: newspaper workshop dispatch unavailable (${String(err)}) — producing in this session instead`,
      );
    }
  }
  return { modelIgnoredNote };
}

/** What both the picks answer and the candidate page are built from. */
async function readPaperContext(rt: NewspaperRuntime) {
  const bondsStore = rt.bondsStore;
  const houseSlugs = (rt.boot.loreHouseUrls ?? []).map(hostDbSlug);
  // G1 lore-house digest: **only fetched once, on this newspaper path** (ADR-0035:
  // never touch the register/startup path). Each house is best-effort on its own —
  // if the fetch fails, fall back to the on-disk cache; with no cache, treat it as
  // absent. One house going down only drops that house's own Mantel tier ① line and
  // "houses" column; it must never fail the whole edition.
  const digests = new Map<string, WorldDigest>();
  await Promise.all(
    houseSlugs.map(async (slug) => {
      const url = readHouseDigestUrl(rt.paths, slug, rt.boot.popclawId ?? '');
      if (!url) return; // House hasn't declared one = no digest, never guess the path
      const d = await refreshHouseDigest(url, { paths: rt.paths, slug });
      if (d) digests.set(slug, d);
    }),
  );
  // Taste tags: the taste frontmatter's tags are **the only half that can be matched
  // locally** (the body text is for an LLM to read). Both learned sources are read:
  // what dreaming wrote + what was harvested from conversation memory.
  // The recommendation rationale is icing on the cake — any hiccup on the taste side
  // should only cost one small line of text, and must never take down the whole edition.
  const tasteTags = await readTasteTags(rt.paths).catch(() => [] as string[]);
  // The taste **as prose** and the bond book **as lines** are what the candidate page
  // hands the writer to choose by: on real hardware the tag matcher scored 0 hits out
  // of 51 (Chinese tags against an English feed), so a judgement is the only thing that
  // can carry this — and only the writer can make one.
  const tasteText = await readTasteProfile({ tasteRoot: rt.paths.tasteDir() }).catch(() => '');
  const bondLines = bondsStore ? bondBookLines(bondsStore, rt.nameOf) : [];
  return { bondsStore, houseSlugs, digests, tasteTags, tasteText, bondLines };
}

type PaperContext = Awaited<ReturnType<typeof readPaperContext>>;

/** Second call: bind the picks to the candidate page they were read against, then build the material page. */
function answerPicks(call: NewspaperCall, rt: NewspaperRuntime, args: NewspaperArgs, picks: Picks): TextResult {
  const { api, toolCtx } = call;
  const { p, candidateBasis, bothGiven } = args;
  // `publish_token` is still read as a fallback: on the first real day a writer sent
  // its picks under the old field name, and rejecting that would have cost the owner
  // an issue over a rename.
  // Trimmed first (both provenance fields, one helper — the same cleaning publish
  // applies): an id arriving with stray whitespace or quotes would otherwise fail
  // the `c` prefix check downstream and be told "that is a publish_token" — a
  // confident wrong answer.
  const givenToken = cleanProvenanceId(p.candidate_token ?? p.publish_token);
  // Deliberately stricter than isPlaceholderId, and without its `redacted`: the
  // picks path has always wanted a token's full shape here. The difference is
  // pinned in tests/unit/newspaper/issue-identity-baseline.test.ts and is a
  // maintenance question, not something this module decides.
  const tokenReliable = Boolean(
    givenToken && /^c[A-Za-z0-9_-]{6,}$/.test(givenToken) && !/\.\.\.|[*<>]|xxx/i.test(givenToken),
  );
  const basis = cleanProvenanceId(candidateBasis);
  const basisReliable = !isPlaceholderId(basis);
  // The picks provenance gate (2026-09-06 r25) — publish's no-guess contract,
  // mirrored one step earlier. The numbers in `picks` are positions on ONE
  // candidate page, and only a field that NAMES that page says which one:
  //   · token and basis both reliable but different → a contradiction; refuse,
  //     never silently pick either;
  //   · neither reliable → refuse. The "newest candidate page in this session"
  //     fallback is DELETED — scope was never proof of which page the writer
  //     read, the same ruling that removed publish's exactly-one bind (a
  //     scrubbed token used to resolve to the session's newest page, which
  //     re-keyed every number when two pages were live);
  //   · candidate_basis alone → binds exactly that page. It is the batch id the
  //     candidate page prints at both ends (the candidate token itself, carried as
  //     a plain non-token field where token-scrubbing channels have no rule; a
  //     protocol requirement, not a physical guarantee any host must honor). It is
  //     NOT `edit.basis`, which is the material page's own id — one word naming
  //     both is what cost a live host two rounds on 2026-09-11;
  //   · token alone, or both agreeing → unchanged.
  // No refusal touches the ledger: an expired candidate page is refused where
  // it lies, never consumed, never deleted.
  if (tokenReliable && basisReliable && basis !== givenToken) {
    return {
      type: 'text' as const,
      text: renderCopy(ownerLang(), 'newspaper.picks.tokenBasisConflict', { basis, token: givenToken }),
    };
  }
  let candidateToken: string | undefined;
  let resolvedNote: string[] = [];
  if (tokenReliable) {
    candidateToken = givenToken;
  } else if (basisReliable) {
    if (!getIssue(basis, rt.paths.newspaperManifestsDir())) {
      return {
        type: 'text' as const,
        text: renderCopy(ownerLang(), 'newspaper.picks.basisExpired', { basis }),
      };
    }
    if (!isCandidateId(basis)) {
      return {
        type: 'text' as const,
        text: renderCopy(ownerLang(), 'newspaper.picks.basisNotCandidate', { basis }),
      };
    }
    candidateToken = basis;
    resolvedNote = [
      `picks: resolved by the candidate_basis you carried (${basis}) — its numbering is the one your picks were read against`,
    ];
  } else {
    return { type: 'text' as const, text: renderCopy(ownerLang(), 'newspaper.picks.noProvenance') };
  }
  const materialSource = publicMaterialSource(rt);
  const picked = buildIssueFromPicks(candidateToken, picks, {
    ...(materialSource ? { validateMaterials: (issue) => materialSource.validate(issue) } : {}),
    manifestDir: rt.paths.newspaperManifestsDir(),
    mintToken: mintIssueToken,
    contentRules: readNewspaperContentRules(rt.paths.newspaperDir()),
    leadMax: readNewspaperStyle(rt.paths.newspaperDir()).style.leadMax,
    perAuthorMax: PER_AUTHOR_MAX,
    floor: PICK_FLOOR,
    // The top-up lands ON the floor, never above it (2026-09-13). It used to aim
    // at PICK_SUGGESTED_MIN, so a writer that chose fourteen — a deliberate answer
    // from the one party that can judge what belongs — had six items of "whatever
    // was liveliest" added on top of it. The floor is the only number the plugin
    // is entitled to enforce; the suggested range stays what it is, a suggestion
    // printed on the candidate page.
    topUpTo: PICK_FLOOR,
    sessionKey: toolCtx.sessionKey,
    ...(api.logger ? { log: (m: string) => api.logger!.info(m) } : {}),
  });
  if (picked.kind === 'error') return { type: 'text' as const, text: `⚠️ ${picked.message}` };
  // Anything the picks broke is said here, in the same breath as the material — a
  // rule enforced silently is a rule the writer never learns.
  const allNotes = [
    ...resolvedNote,
    ...(bothGiven ? ['picks and picks_flat both carried numbers — used `picks`, ignored `picks_flat`'] : []),
    ...picked.notes,
  ];
  const said = allNotes.length ? `${allNotes.map((n: string) => `▢ ${n}`).join('\n')}\n\n` : '';
  // Stage, from what this call itself just did: a material page exists and is
  // going back to the writer. Nothing here reads the child's account of anything.
  NewspaperStageStore.note(toolCtx.sessionKey, 'materialPage');
  return { type: 'text' as const, text: `${said}${picked.payload}` };
}

/** First call (or a degraded dispatch): gather the day into a candidate page. */
async function gatherCandidatePage(
  call: NewspaperCall,
  rt: NewspaperRuntime,
  hours: number | undefined,
  paper: PaperContext,
  modelIgnoredNote: string | undefined,
): Promise<TextResult> {
  const { api, toolCtx } = call;
  const { bondsStore, houseSlugs, digests, tasteTags, tasteText, bondLines } = paper;
  const materialSource = publicMaterialSource(rt);
  const publicBatch = await materialSource?.prepareCollect();
  const r = gatherNewspaperMaterials(
    {
      ...(publicBatch ? { publicBatch, validateMaterials: (issue) => materialSource!.validate(issue) } : {}),
      cache: rt.worldFeedCache,
      inbox: rt.inboxStore,
      readContentRules: () => readNewspaperContentRules(rt.paths.newspaperDir()),
      readStyle: () => readNewspaperStyle(rt.paths.newspaperDir()).style,
      ownerNickname: rt.boot.nickname,
      ...(rt.boot.popclawId ? { ownerPopclawId: rt.boot.popclawId } : {}),
      webBaseUrl: rt.boot.webBaseUrl,
      now: () => Math.floor(Date.now() / 1000),
      mintToken: mintIssueToken,
      // The follow-status tag must be honest (mislabeling "not following" is worse than
      // not labeling at all), and is decided **per house** — ADR-0037: following someone
      // on the me house doesn't mean following them on the world house too.
      isFollowing: (id, houseSlug) => !!id && rt.socialGraph.followsIn(id, houseSlug),
      // The owner's alias overrides the name baked into the post (the single name chain).
      ...(rt.nameOf ? { nameOf: rt.nameOf } : {}),
      // The bond book is the single source of truth for local social assets: tier
      // up/downgrades read it, **and it's also what keeps blocked/rejected people out of
      // the paper**; their most recent status update is material for the "editor's note."
      ...(bondsStore
        ? {
            bondOf: (id: string) => {
              const b = bondsStore.get(id);
              if (!b) return null;
              const dyn = bondsStore.recentDynamics?.(id, 1)[0]?.summary;
              return dyn ? { ...b, dynamic: dyn } : b;
            },
          }
        : {}),
      ...(tasteTags.length ? { tasteTags } : {}),
      ...(tasteText ? { tasteText } : {}),
      ...(bondLines.length ? { bondLines } : {}),
      // A house's notice board: the guide text cached to disk at mount-handshake time; the frontmatter's voice IS the house's own self-description.
      houseVoiceOf: (slug: string) => readHouseVoice(rt.paths, slug),
      // Subscribed houses (`lore_houses`): a house with zero materials that day still
      // gets a stack — if it's subscribed but its entire stack just vanishes, the owner
      // will only think the house has dropped off (on real hardware, popclaw.world's
      // no-feed day is exactly what this looked like disappearing).
      // Unreadable (old wiring / test stub) → empty list, falls back to the old behavior
      // of only listing houses that actually showed up.
      configuredHouseSlugs: houseSlugs,
      // F2: the "go take a look" page can only be assembled for the primary house
      // (webBaseUrl is its web surface). Other houses' event_ids simply don't exist on
      // popclaw.me — assembling one would just be a 404; better to omit than dead-link.
      ...(rt.boot.loreHouseUrls?.[0]
        ? { primaryHouseSlug: hostDbSlug(rt.boot.loreHouseUrls[0]) }
        : {}),
      // F3: a letter from a house's official name is a family letter, not a ping (official_ids cached from the handshake).
      houseOfficialIds: (slug: string) => readHouseHandshake(rt.paths, slug)?.official_ids ?? [],
      // F4④: the house's self-reported door card (the guide frontmatter's `entry:`), the clickable door for the zero-event state.
      houseEntryOf: (slug: string) =>
        readHouseEntry(rt.paths, slug, houseUrlOf(rt.boot.loreHouseUrls ?? [], slug)),
      // G1: the house digest (Mantel tier ① + "homes worth visiting"). A house that can't be fetched simply doesn't get one.
      digestOf: (slug: string) => digests.get(slug),
      // G3 name-chain reverse lookup: the digest's `owner.popclaw_id` (shipped
      // 2026-07-31T07:32) takes priority; when an old house / stale cache doesn't
      // provide it, only the sigil is left, and the bond book's list is the local basis
      // for recognizing who that actually is (the world-feed author list contributes on
      // its own from the cache). Falls back to the house-supplied display name if it
      // still can't be found. If there's no houses column to lay out, this whole-table
      // scan is skipped — on the vast majority of machines this line costs zero.
      knownPopclawIds: [...digests.values()].some((d) => d.homes.length)
        ? (bondsStore?.list?.() ?? []).map((b) => b.popclawId)
        : [],
      // The masthead date follows "what language the owner is actually speaking right
      // now," read through the single language-registry entry point — it already ranks
      // an explicit cadence at the top internally, so an owner who has configured one
      // sees no behavior change. An owner who hasn't configured one used to read cadence
      // directly and always got the default en-US, resulting in a Chinese masthead with
      // an English date (screenshot from real hardware, 2026-07-31). Never read
      // delivery.primaryLanguage directly again.
      language: ownerLangTag(),
      // Slice H: the token ledger is persisted to disk — when the main agent hands the
      // newspaper task off to a subagent, the publish half runs under a different plugin
      // context, and an in-process-memory ledger is guaranteed to come up empty (real
      // hardware incident, 2026-07-31).
      manifestDir: rt.paths.newspaperManifestsDir(),
      // Cut 1: the page budget is bucketed per session — the workshop session
      // and the chat session can sit on different models with different windows.
      sessionKey: toolCtx.sessionKey,
      // One info line per page build: which key the budget was looked up under, where
      // the number came from, and what the page weighed. info, never warn — an MCP
      // host swallows warn and error entirely.
      ...(api.logger ? { log: (m: string) => api.logger!.info(m) } : {}),
    },
    hours === undefined ? {} : { hours },
  );
  // The refused-model degrade (if it happened) is said in the same breath
  // as the page the legacy flow returns — a note only the log swallows is
  // a note the owner never hears.
  const legacyPage = r.kind === 'empty' ? r.message : r.payload;
  if (r.kind === 'candidates') NewspaperStageStore.note(toolCtx.sessionKey, 'candidatePage');
  else NewspaperStageStore.collection(toolCtx.sessionKey, publicBatch?.coverage.some(s => s.unavailable || s.incomplete || s.truncated) ? 'partial-no-material' : 'empty');
  return {
    type: 'text' as const,
    text: modelIgnoredNote ? `${modelIgnoredNote}\n\n${legacyPage}` : legacyPage,
  };
}

/** popclaw_newspaper's execute. */
export async function runNewspaperCall(call: NewspaperCall, params: unknown): Promise<TextResult> {
  try {
    const constraints = params as Record<string, unknown>;
    if (constraints && (constraints.draft_only === true || constraints.no_upload === true || constraints.public_only === true
      || constraints.preview === true || constraints.publish === false || constraints.upload === false))
      return { type: 'text', text: renderCopy(ownerLang(), 'newspaper.source.unsupportedDraft') };
    const pageCursor = constraints?.page_cursor;
    if (pageCursor !== undefined) {
      if (typeof pageCursor !== 'string' || !pageCursor.trim()) throw new Error('invalid newspaper page_cursor');
      if (Object.keys(constraints).some(key => key !== 'page_cursor' && constraints[key] !== undefined))
        throw new Error('page_cursor must be supplied alone; continuation never gathers or changes picks');
      const rt = (await call.runtime()) as NewspaperRuntime;
      const materialSource = publicMaterialSource(rt);
      return { type: 'text', text: readNewspaperPage(pageCursor, {
        manifestDir: rt.paths.newspaperManifestsDir(), sessionKey: call.toolCtx.sessionKey,
        ...(materialSource ? { validateMaterials: (issue) => materialSource.validate(issue) } : {}),
      }) };
    }
    const args = readNewspaperArgs(params);
    const refused = picksLostReply(args);
    if (refused) return refused;
    const rt = (await call.runtime()) as NewspaperRuntime;
    // ── The dedicated workshop dispatch (2026-09-03 cut 1) ──
    //
    // In the owner's chat session, a bare "produce the paper" call hands the
    // whole job to a throwaway child session instead of filling this one
    // with two heavy pages: the chat history stops being input the paper has
    // to fit around, and the workshop can't blow the chat model's budget
    // (two machines died of exactly that on 2026-09-02). Only on the GATHER
    // branch — a picks-carrying call belongs to an in-session flow already
    // under way (e.g. a previous dispatch degraded) and dispatching under it
    // would orphan its candidate page. Inside the workshop itself the check
    // below is false by construction, so dispatch never recurses.
    // Set when a configured workshop model was refused by the host (its
    // authorization gate): the legacy receipt below then names it — the one
    // degrade with a cause the OWNER can act on must not be log-only.
    let modelIgnoredNote: string | undefined;
    if (!args.hasPicks && !isDedicatedSession(call.toolCtx.sessionKey)) {
      const dispatch = await dispatchToWorkshop(call, rt, args.hours);
      if ('dispatched' in dispatch) return dispatch.dispatched;
      modelIgnoredNote = dispatch.modelIgnoredNote;
    }
    const paper = await readPaperContext(rt);
    // Second call: the writer read the candidate page and named its picks. The candidate
    // set is already on disk, so nothing is gathered again — re-reading the feed here
    // would let the world move underneath the numbers it is answering with.
    if (args.hasPicks && args.picks) return answerPicks(call, rt, args, args.picks);
    return await gatherCandidatePage(call, rt, args.hours, paper, modelIgnoredNote);
  } catch (err) {
    if (err instanceof PublicMaterialRefusal) NewspaperStageStore.collection(call.toolCtx.sessionKey, 'source-refused');
    return { type: 'text' as const, text: err instanceof PublicMaterialRefusal ? renderCopy(ownerLang(), 'newspaper.source.refused', { reason: err.code }) : failureText('popclaw_newspaper', err) };
  }
}
