/**
 * Second half of the paper's choosing step: the writer read the candidate page and named
 * the numbers it wants, and this turns that answer into the issue.
 *
 * It never goes back to the feed. The candidate set was stored whole when the page was
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
import { weightedChars } from './gather-materials.js';
import { pageBudgetDecision, pageBudgetLogLine, pageBudgetNow } from './host-budget.js';
import { getIssue, putIssue } from './issue-store.js';
import { buildNewspaperPrompt } from './build-newspaper-prompt.js';
import { houseCounts, type IssueData, type PulseItem } from './issue.js';
import { authorKey, candidateNumberAt, isCandidateId } from './issue-identity.js';

export interface PickOptions {
  /** Where the candidate set was stored and where the issue goes. */
  manifestDir?: string;
  /** Mints the publish token the writing half will carry. */
  mintToken: () => string;
  contentRules: string;
  leadMax: number;
  /** The most any one person may hold in the issue. */
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

  // The cap, applied in page order so "which six" is decided the same way every time.
  const perAuthor = new Map<string, number>();
  const chosen = new Map<number, 'taste' | 'bond' | 'lively' | undefined>();
  let capped = 0;
  candidates.pulse.forEach((p, i) => {
    if (!wanted.has(candidateNumberAt(i))) return;
    const key = authorKey(p, i);
    const n = perAuthor.get(key) ?? 0;
    if (n >= opts.perAuthorMax) {
      capped += 1;
      return;
    }
    perAuthor.set(key, n + 1);
    chosen.set(i, why.get(candidateNumberAt(i)));
  });
  if (capped) {
    notes.push(`picks: ${capped} dropped — nobody holds more than ${opts.perAuthorMax} items in one issue`);
  }
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
        perAuthorMax: opts.perAuthorMax,
        alreadyHeld: perAuthor,
      }).map((p) => p.eventId),
    );
    let added = 0;
    candidates.pulse.forEach((p, i) => {
      if (chosen.size >= opts.topUpTo || chosen.has(i) || !liveliest.has(p.eventId)) return;
      const key = authorKey(p, i);
      const n = perAuthor.get(key) ?? 0;
      if (n >= opts.perAuthorMax) return;
      perAuthor.set(key, n + 1);
      chosen.set(i, 'lively');
      added += 1;
    });
    if (added) {
      notes.push(`picks: ${added} more added by what was liveliest — fewer than ${opts.floor} items reads as an empty paper`);
    }
    // "Topped up by 3" reads like the problem was handled. On a day one account wrote almost
    // everything, the per-author cap leaves nothing to top up *with*, and the issue stays far
    // under the floor — the owner should hear that from the issue, not deduce it.
    if (chosen.size < opts.floor) {
      notes.push(
        `picks: ${chosen.size} items in the end, still under ${opts.floor} — there was nothing left to add that does not break the ${opts.perAuthorMax}-per-person cap. Today's feed came from too few people.`,
      );
    }
  }

  // One page-ordered pass at the end: the writer chose what belongs, the layout decides where.
  const kept: PulseItem[] = [];
  candidates.pulse.forEach((p, i) => {
    if (!chosen.has(i)) return;
    const reason = chosen.get(i);
    // The candidate page's [n] remains this item's identity, never its new array position.
    // Stamp before the material-budget trim; top-ups and capped selections use the same IDs.
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
  // The material page has the same one-message ceiling the candidate page had, and a writer
  // that picks three hundred items would sail straight past it and get its material cut in
  // the middle. Trim the oldest until it fits, and say so.
  let over = false;
  const brief = (list: readonly PulseItem[]): string =>
    buildNewspaperPrompt({ ...issue, pulse: list }, {
      contentRules: opts.contentRules,
      publishToken,
      leadMax: opts.leadMax,
      pickedCount: kept.length,
      overBudget: over,
      sessionKey: opts.sessionKey,
    });
  let laidOut: readonly PulseItem[] = kept;
  let payload = brief(laidOut);
  const budget = pageBudgetNow(opts.sessionKey);
  while (weightedChars(payload) > budget && laidOut.length > 12) {
    laidOut = laidOut.slice(0, Math.max(12, Math.floor(laidOut.length * 0.8)));
    payload = brief(laidOut);
  }
  // The trim bottoms out at twelve rather than gut the page, so it can leave here still over
  // budget — the one case where the host cuts the middle out. The page must say so instead of
  // promising it is whole. Same fault, same fix as the candidate page.
  over = weightedChars(payload) > budget;
  payload = brief(laidOut);
  // Same trail as the candidate page, same wording: what this page was sized against and
  // what it came out weighing. Numbers and session keys only, never the material itself.
  opts.log?.(
    pageBudgetLogLine(
      'material',
      pageBudgetDecision(opts.sessionKey),
      weightedChars(payload),
      kept.length - laidOut.length,
      kept.length,
    ),
  );
  if (laidOut.length !== kept.length) {
    notes.push(`picks: ${kept.length - laidOut.length} dropped — the material for that many does not fit one hand-over`);
  }
  // The session stamp is the same-batch constraint's basis (2026-09-06 content-mismatch
  // P1): a tokenless publish may only bind an issue its own session — or its delegating
  // parent — was served, so the copy lands on the numbering it was written against.
  // The candidate stamp (2026-09-12): this issue records the candidate page it was
  // picked from, so a hand-in that carries the candidate id where the material page's
  // id belongs can be bound by ancestry instead of refused twice over.
  putIssue(publishToken, { ...issue, pulse: laidOut }, opts.manifestDir, opts.sessionKey, candidateToken);
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
