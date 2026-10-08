/**
 * Second half of the paper's choosing step: the writer read the candidate page and named
 * the numbers it wants, and this turns that answer into the issue.
 *
 * It never regathers the feed; retained public evidence is only revalidated. The candidate set was stored whole when the page was
 * built, so the numbers the writer is answering with mean exactly what they meant when it
 * read them — re-gathering here would let the world move underneath the picks and silently
 * shift every number (the same trap the offline preview harness documents).
 *
 * The ceilings are enforced here rather than asked for politely. The per-author cap is the
 * one rule the day's loudest account will always be in a position to break: on 2026-08-26 a
 * single account posted 153 of the day's 479 items, and the paper it produced gave two
 * accounts 63% of the page. A cap that only lives in the prompt is a cap that fails on the
 * exact day it matters.
 */
import { retainPublicMaterialBasis, publicCoverageText } from './public-material-source.js';
import { weightedChars } from './gather-materials.js';
import { pageBudgetDecision, pageBudgetLogLine } from './host-budget.js';
import { beginReading, previewReading } from './reading-page.js';
import { getIssue, putIssue } from './issue-store.js';
import { buildNewspaperPrompt } from './build-newspaper-prompt.js';
import { houseCounts, type IssueData, type PulseItem } from './issue.js';
import { authorKey, candidateNumberAt, isCandidateId } from './issue-identity.js';

export interface PickOptions {
  validateMaterials?: (issue: IssueData) => void;
  /** Where the candidate set was stored and where the issue goes. */
  manifestDir?: string;
  /** Mints the publish token the writing half will carry. */
  mintToken: () => string;
  contentRules: string;
  leadMax: number;
  /** Legacy assembly option; explicit author selections are no longer capped. */
  perAuthorMax: number;
  /** Under this the issue reads as empty and is topped up by heat. There is no target above it. */
  floor: number;
  /** Where a topped-up issue lands. */
  topUpTo: number;
  /**
   * The session this issue is built for (dedicated-session cut 1): the page
   * budget is bucketed per sessionKey, and the chat session and the newspaper
   * workshop can sit on different models. Not injected = the default bucket
   * (the old single-number behavior).
   */
  sessionKey?: string;
  /**
   * Where the one-line page-build trail goes (`api.logger.info`). Absent = silent, which is
   * every test rig and every old assembly. **info, never warn**: an MCP host swallows warn
   * and error entirely.
   */
  log?: (m: string) => void;
}

export type PickResult =
  | { kind: 'ready'; payload: string; publishToken: string; notes: readonly string[] }
  | { kind: 'error'; message: string };

/**
 * Apply the picks to a stored candidate set.
 *
 * Page order is the candidate set's order, never the order the numbers arrived in: the
 * writer is choosing what belongs, not what goes where — where things go is the layout's
 * business, and it has its own rules for that.
 */
/** What the writer handed back: numbers, and — when it said so — why each one is here. */
export type Picks =
  | readonly number[]
  | { taste?: readonly number[]; bond?: readonly number[]; lively?: readonly number[]; all?: readonly number[] };

/** Flatten the picks into page-ordered numbers plus the reason each one was given. */
function readPicks(picks: Picks): { list: number[]; why: Map<number, 'taste' | 'bond' | 'lively'> } {
  if (Array.isArray(picks)) return { list: [...picks], why: new Map() };
  const grouped = picks as {
    taste?: readonly number[];
    bond?: readonly number[];
    lively?: readonly number[];
    all?: readonly number[];
  };
  const why = new Map<number, 'taste' | 'bond' | 'lively'>();
  // `all` is the flat escape hatch: chosen, but with no reason given, so it is added to the
  // list and deliberately left out of `why` — the ledger must not invent an attribution.
  const list: number[] = [...(grouped.all ?? [])];
  for (const reason of ['taste', 'bond', 'lively'] as const) {
    for (const n of grouped[reason] ?? []) {
      list.push(n);
      // First reason wins: an item chosen for the owner's taste stays that even if the
      // writer also listed it as lively.
      if (!why.has(n)) why.set(n, reason);
    }
  }
  return { list, why };
}

export function buildIssueFromPicks(
  candidateToken: string,
  rawPicks: Picks,
  opts: PickOptions,
): PickResult {
  // Candidate tokens carry a `c`; issue tokens do not, and both live in the same ledger with
  // the same shape. Without this, a writer that hands back an **issue** token gets a silent
  // hit: its 1..53 land on a pulse of twenty, the out-of-range ones are dropped as "not on
  // the page", and the rest point at entirely different items. The material page then comes
  // back full of those, the writer writes from it, and the paper is internally consistent
  // and about the wrong things. Writers have confused these tokens twice already
  // (2026-08-27, 2026-08-29). The publish side has had the mirror of this check since
  // 2026-08-29; the choosing side did not.
  if (!isCandidateId(candidateToken)) {
    return {
      kind: 'error',
      message:
        `that is a publish_token, not the candidate_token — picks belong to the candidate page. ` +
        `Copy the token printed on that page (it starts with 'c'), or call popclaw_newspaper with no arguments for a fresh one.`,
    };
  }
  const candidates = getIssue(candidateToken, opts.manifestDir);
  if (!candidates) {
    return {
      kind: 'error',
      message: 'candidate set not found or expired — call popclaw_newspaper again with no picks to get a fresh candidate page',
    };
  }
  opts.validateMaterials?.(candidates);
  const notes: string[] = [];
  const { list: picks, why } = readPicks(rawPicks);
  const wanted = new Set<number>();
  for (const n of picks) {
    if (!Number.isInteger(n) || n < 1 || n > candidates.pulse.length) continue;
    wanted.add(n);
  }
  if (!wanted.size) {
    return { kind: 'error', message: 'no usable numbers in `picks` — every number must be one from the candidate page' };
  }
  if (wanted.size !== picks.length) {
    notes.push(`picks: ${picks.length} given, ${wanted.size} usable (the rest were duplicates or not on the page)`);
  }

  // The writer chooses; capacity never removes an explicitly chosen item.
  const perAuthor = new Map<string, number>();
  const chosen = new Map<number, 'taste' | 'bond' | 'lively' | undefined>();
  candidates.pulse.forEach((p, i) => {
    if (!wanted.has(candidateNumberAt(i))) return;
    const key = authorKey(p, i);
    const n = perAuthor.get(key) ?? 0;
    perAuthor.set(key, n + 1);
    chosen.set(i, why.get(candidateNumberAt(i)));
  });
  if (!chosen.size) {
    return { kind: 'error', message: 'nothing survived the picks — call popclaw_newspaper again with no picks and choose from the candidate page' };
  }

  // "Pick as many as you can write well; if the three rules do not fill it, top it up with
  // what was liveliest — too few, or empty, is no good either" (owner, 2026-08-28). There is
  // no target above this floor: a writer that chose twenty and wrote them properly has done
  // the job better than one that chose ninety and summed them up in a line each.
  //
  // Filling is never silent. Each added item is marked `lively`, which is the same field the
  // page's own ledger counts — so an issue that is mostly filling says so where he looks first.
  if (chosen.size < opts.floor) {
    const spare = candidates.pulse.filter((_, i) => !chosen.has(i));
    // Matched back by eventId, not by object identity: selectByHeat hands back **copies**
    // (it stamps `pickedFor` on the way out), so an identity lookup silently matches nothing
    // and the top-up quietly never happens.
    const liveliest = new Set(
      selectByHeat(spare, {
        target: opts.topUpTo,
        perAuthorMax: Number.POSITIVE_INFINITY,
        alreadyHeld: perAuthor,
      }).map((p) => p.eventId),
    );
    const addedNumbers: number[] = [];
    candidates.pulse.forEach((p, i) => {
      if (chosen.size >= opts.topUpTo || chosen.has(i) || !liveliest.has(p.eventId)) return;
      const key = authorKey(p, i);
      const n = perAuthor.get(key) ?? 0;
      perAuthor.set(key, n + 1);
      chosen.set(i, 'lively');
      addedNumbers.push(candidateNumberAt(i));
    });
    if (addedNumbers.length) {
      notes.push(`picks: ${addedNumbers.length} more added by what was liveliest — fewer than ${opts.floor} items reads as an empty paper; added original numbers: ${addedNumbers.join(', ')}`);
    }
    // An exhausted source window can still leave the paper under the editorial floor.
    if (chosen.size < opts.floor) {
      notes.push(
        `picks: ${chosen.size} items in the end, still under ${opts.floor} — no more available candidates remain in this window.`,
      );
    }
  }

  // One page-ordered pass at the end: the writer chose what belongs, the layout decides where.
  const kept: PulseItem[] = [];
  candidates.pulse.forEach((p, i) => {
    if (!chosen.has(i)) return;
    const reason = chosen.get(i);
    // The candidate page's [n] remains this item's identity, never its new array position.
    // Explicit picks and editorial top-ups keep the same original IDs.
    kept.push({ ...p, itemNumber: candidateNumberAt(i), ...(reason ? { pickedFor: reason } : {}) });
  });

  const issue: IssueData = {
    ...candidates,
    pulse: kept,
    // Every house the candidate set knew about keeps its stack, at zero if none of its
    // items were chosen — a subscribed house whose stack simply vanishes reads as the
    // house having dropped off (E4, and it is exactly what popclaw.world's quiet day
    // looked like on real hardware).
    byHouse: { ...Object.fromEntries(Object.keys(candidates.byHouse).map((k) => [k, 0])), ...houseCounts(kept) },
  };
  const publishToken = opts.mintToken();
  // Preserve all selected originals, IDs and public source evidence before serving any page.
  let retained = issue;
  if (candidates.publicMaterials) retained = retainPublicMaterialBasis(retained, candidates.publicMaterials.references);
  const coverage = publicCoverageText(candidates.publicCoverage ?? []);
  const text = buildNewspaperPrompt(retained, {
    contentRules: opts.contentRules, publishToken, leadMax: opts.leadMax,
    pickedCount: kept.length, overBudget: false, sessionKey: opts.sessionKey,
  });
  const document = coverage ? `${coverage}\n\n${text}` : text;
  opts.log?.(pageBudgetLogLine('material', pageBudgetDecision(opts.sessionKey), weightedChars(previewReading(publishToken, document, opts)), 0, kept.length));
  opts.validateMaterials?.(retained);
  putIssue(publishToken, retained, opts.manifestDir, opts.sessionKey, candidateToken);
  const payload = beginReading(publishToken, document, opts);
  return { kind: 'ready', payload, publishToken, notes };
}

/**
 * The fallback: an issue chosen by the plugin, for when the writer skipped the choosing step
 * and went straight to publishing off the candidate token.
 *
 * It is deliberately not a pretend judgement. What the owner cares about — his taste, the
 * people he knows — cannot be read off any field the plugin holds (on real hardware every
 * ranking signal it has reads zero, or reads true for everyone). So this ranks by the three
 * things that are actually measurable and says on the page that it did:
 *
 *  - **carries a picture** — someone spent effort on it.
 *  - **not a firehose** — the more one account posted that day, the less each of its items
 *    scores. Volume is not heat; on 2026-08-26 one account posted 153 of 479 items.
 *
 * The per-author ceiling still applies, so the loudest account cannot take the issue even if
 * every one of its posts outscored everything else.
 */
export function selectByHeat(
  pulse: readonly PulseItem[],
  opts: {
    target: number;
    perAuthorMax: number;
    /**
     * What each author already holds outside this pool. Without it the per-author cap counts
     * from zero, so on a day one account dominates, every "liveliest" item it picks belongs to
     * someone already at their limit and the caller drops the lot — the top-up runs, reports
     * a number, and lifts the issue nowhere near the floor.
     */
    alreadyHeld?: ReadonlyMap<string, number>;
  },
): PulseItem[] {
  const volume = new Map<string, number>();
  pulse.forEach((p, i) => {
    const k = authorKey(p, i);
    volume.set(k, (volume.get(k) ?? 0) + 1);
  });
  // ponytail: no "answered inside this window" term — the item does not carry what it is a
  // reply to, and plumbing that through gather is a bigger change than this fallback is
  // worth. It is the strongest heat signal available locally, so add it when the fallback
  // starts mattering (or when the follower data of #476 lands and this whole rung is redone).
  const score = (p: PulseItem, i: number): number =>
    p.replyCount * 2 +
    p.markCount * 2 +
    (p.media.length ? 3 : 0) +
    (p.newcomerDays !== undefined ? 1 : 0) +
    // The firehose tax: one item from someone who wrote once counts for more than one of
    // a hundred and fifty-three.
    -Math.min(4, Math.log2(Math.max(1, volume.get(authorKey(p, i)) ?? 1)));
  const ranked = pulse
    .map((p, i) => ({ p, i, s: score(p, i) }))
    .sort((a, b) => b.s - a.s || b.i - a.i);
  const perAuthor = new Map<string, number>(opts.alreadyHeld ?? []);
  const taken = new Set<number>();
  for (const { p, i } of ranked) {
    if (taken.size >= opts.target) break;
    const k = authorKey(p, i);
    const n = perAuthor.get(k) ?? 0;
    if (n >= opts.perAuthorMax) continue;
    perAuthor.set(k, n + 1);
    taken.add(i);
  }
  // Back into page order: what to carry is this function's business, where it goes is the
  // layout's.
  return pulse.filter((_, i) => taken.has(i)).map((p) => ({ ...p, pickedFor: 'lively' as const }));
}
