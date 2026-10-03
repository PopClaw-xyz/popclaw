/**
 * The butler (zhike, the monastery officer who receives and announces callers)
 * — the one place "who is this person" is decided. ADR-0046.
 *
 * Why it exists (real device, 2026-07-31): the same rule was known by one surface
 * and not another. `newspaper/gather-materials.ts` states plainly that a blocked
 * or rejected person must never appear in the paper; the notification gate
 * (`notifier/relative-value.ts`) only ever asked "am I following them" and never
 * looked at tier — so **someone the owner followed and later blocked still got an
 * L1 push straight to their phone**. Counting them up: seven surfaces, five
 * hand-rolled private rulesets, two with no notion at all. That is not "one
 * surface missed a rule"; the criteria were scattered.
 *
 * ## This returns FACTS, not conclusions
 *
 * The verdict is a facts card plus reason codes. Deliberately not:
 *  - **a boolean** — surfaces genuinely differ (the paper is a retrospective and
 *    wants everyone except blocked; a notification interrupts and wants only the
 *    close ones). One boolean forces a `purpose` switch that grows forever.
 *  - **a score** — forbidden. Memory `social-weight-principles-deferred` (settled
 *    2026-06-14): a private judgement of someone's weight is a *qualitative label,
 *    never a numeric score*; follower/verification counts are only inputs to such a
 *    label. The unconsumed `minScore: 0.4` sitting in cadence is the cautionary tale.
 *  - **rendered text** — that is a god object. Wording belongs to the lexicon and
 *    to each surface, which is why `why` is codes rather than prose.
 *
 * **The scale is not invented here.** `bond-tier.ts` already has the seven-tier
 * total order and `tierRank`; the newspaper's own filter was already comparing
 * against it. What was missing was never a scale — it was a door to go ask.
 *
 * ## Four properties (read before changing this file)
 *
 * 1. **Pure, no network, no LLM.** Local materialised state only. Not a compromise:
 *    receiving is an SSE callback, outside any agent turn, and the plugin holds no
 *    static API key, so a completion always fails (constitutional memory
 *    `popclaw-llm-render-uses-host-model-in-agent-turn`). Nor is anything needed at
 *    call time — tier is written by the owner and by dreaming, `followed` is the
 *    owner's own act. Receiving does not *make* a judgement; it *applies* one the
 *    dreamer already made.
 * 2. **Only unforgeable signals.** The letter's content never enters. The moment it
 *    does, the butler becomes an attack surface: if importance could raise standing,
 *    a spammer learns to write "URGENT" on day one.
 * 3. **Every judgement carries reason codes.** The owner asking "why wasn't I told"
 *    must get an answer, and the codes double as audit material.
 * 4. **Read-only, never writes back.** Writers (dreaming, owner commands, interaction
 *    recording) stay separate from the reader, or dreaming calls the butler and the
 *    butler steers dreaming — a cycle.
 *
 * ## Thresholds live at the surfaces, not here
 *
 * Each surface sets its own line on these facts. What is unified is the *facts*, not
 * the *threshold* — accidental divergence dies because the facts are computed once;
 * legitimate difference survives inside each surface's own cut point.
 */
import { tierRank, type BondTier } from '../bonds/bond-tier.js';

/** The local tables the butler reads. Absent source = honestly absent fact, never a guess. */
export interface VerdictSources {
  /** Bond-book lookup. Not found = not in the book at all. */
  bondOf?: (popclawId: string) => { tier: BondTier } | null | undefined;
  isFollowed?: (popclawId: string) => boolean;
  /** House official — mounting a house is the owner consenting to hear from it (ADR-0041). */
  isHouseOfficial?: (popclawId: string) => boolean;
  /**
   * External standing, from whatever was cached earlier — the receptionist
   * never goes to the network to find out (ADR-0046: zero round trips is its
   * first property). `undefined` = nobody has looked yet, which is a different
   * fact from "looked and found nothing" and is reported as absent, not 0.
   */
  verifiedFollowersOf?: (popclawId: string) => number | undefined;
}

/**
 * Reason codes, not prose: the butler states facts, surfaces do the talking.
 * Render them through the lexicon where a human will read them.
 */
export type VerdictReason =
  | 'blocked'
  | 'verifiedVip'
  | 'inBondBook'
  | 'notInBondBook'
  | 'followed'
  | 'houseOfficial';

/**
 * One person's facts. All discrete, no score.
 *
 * An absent `tier` means "not in the bond book" — do not substitute `'stranger'`.
 * "The book records them as a stranger" and "the book has never heard of them" are
 * different facts, and only the first means the owner has met them.
 */
export interface PersonVerdict {
  readonly popclawId: string;
  readonly tier?: BondTier;
  /** `rank < stranger`, i.e. blocked or rejected: the owner does not want to see them. */
  readonly blocked: boolean;
  readonly followed: boolean;
  readonly houseOfficial: boolean;
  /** External follower snapshot, when one was cached. Absent = unknown, never 0-as-unknown. */
  readonly verifiedFollowerCount?: number;
  readonly why: readonly VerdictReason[];
}

/**
 * Look up one person's facts. **Never throws** — any table that misbehaves (runtime
 * not up, sqlite hiccup) leaves that one field honestly absent rather than taking
 * down the receive loop. Absent evidence resolves conservatively (not blocked, not
 * followed): both of those should only ever be lit by a definite local fact.
 */
export function personVerdict(popclawId: string, sources: VerdictSources): PersonVerdict {
  const safe = <T>(f: (() => T) | undefined): T | undefined => {
    try {
      return f?.();
    } catch {
      return undefined;
    }
  };

  const tier = safe(() => sources.bondOf?.(popclawId))?.tier;
  const blocked = tier !== undefined && tierRank(tier) < tierRank('stranger');
  const followed = safe(() => sources.isFollowed?.(popclawId)) === true;
  const houseOfficial = safe(() => sources.isHouseOfficial?.(popclawId)) === true;
  const verifiedFollowerCount = safe(() => sources.verifiedFollowersOf?.(popclawId));

  const why: VerdictReason[] = [blocked ? 'blocked' : tier ? 'inBondBook' : 'notInBondBook'];
  if (followed) why.push('followed');
  if (houseOfficial) why.push('houseOfficial');
  // A fact, not a verdict: the butler says how much standing it found, and the
  // surfaces decide what counts as enough. The threshold lives in `cadence`
  // where the owner can move it (ADR-0046 — thresholds belong to the surfaces).
  if ((verifiedFollowerCount ?? 0) > 0) why.push('verifiedVip');

  return {
    popclawId,
    ...(tier ? { tier } : {}),
    blocked,
    followed,
    houseOfficial,
    ...(verifiedFollowerCount === undefined ? {} : { verifiedFollowerCount }),
    why,
  };
}
