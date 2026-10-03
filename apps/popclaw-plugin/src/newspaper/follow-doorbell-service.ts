/**
 * The follow doorbell's service core (doorbell spec §6.2–§6.4).
 *
 * Three halves, one file:
 *  - the pure decision logic (debounce, delivery window, list, L1 text, poll
 *    tiering, backoff) — exported and unit-tested on their own;
 *  - `createDoorbellService`, the tick loop that wires them to the injected
 *    pull client / pending store / notifier / owner channel;
 *  - `startFollowDoorbell`, the ONE thing every resident root starts: it
 *    assembles the pull client, the store and the house gate from the handful
 *    of objects a root has, and owns the self-rescheduling timer. It lives
 *    here, next to the decisions it paces, because a loop assembled inline in
 *    one root is a loop the other two roots do not have — which is exactly
 *    how this feature came to be absent on every MCP host with nothing on
 *    stderr to say so (both legs early-return honestly when there is no
 *    publisher, so silence was the only symptom).
 *
 * Time units — same split as pending-follow-store.ts, honored everywhere:
 *  - canvas timestamps and every debounce/window computation are unix
 *    MILLISECONDS (`clock()` speaks ms);
 *  - the store's `claimSurface` / `expireOlderThan` speak SECONDS; the two
 *    conversions happen here and nowhere else.
 *
 * The L1/L2 mutex (spec §6.4): this module OWNS the timer leg — it calls
 * `claimSurface()` (the atomic UPDATE) and only the winner `deliverNow`s.
 * The other leg (the owner speaking first) is the L2 handoff + the
 * before_prompt_build injection passenger; that side claims through the same
 * store method, which is what keeps the two mutually exclusive. This module
 * only ever ENQUEUES L2 rows — rendering/draining them is not its business.
 */
import type { FollowIntentRow } from '../social-graph/pending-follow-store.js';
import { PendingFollowStore } from '../social-graph/pending-follow-store.js';
import { FOLLOWABLE_TTL_MS, type FollowableAuthorRow } from './followable-authors.js';
import type { NotificationKind, NotificationLevel } from '../notifier/types.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { timeContext } from '../time/time-context.js';
import type { HostDb } from '../host/host-db.js';
import type { Signer } from '../identity/signer.js';
import { makeIntentPullClient } from '../canvas/intent-pull-client.js';
import { viewingSignal, type ViewingSignal } from '../canvas/viewing-signal.js';
import type { ActionGate } from '../runtime/house-lifecycle/action-context.js';
import { ActionInactiveError, assertActionActive, rethrowActionCancellation, withAction } from '../runtime/house-lifecycle/action-context.js';

// ---------------------------------------------------------------------------
// Debounce + delivery window (pure, ms)
// ---------------------------------------------------------------------------

/** First click of a batch must be this old before it surfaces — give a
 *  reading session time to accumulate its clicks into one interruption. */
export const DEBOUNCE_FIRST_MS = 20 * 60_000;

/** No new order for this long — the "session seems over" quiet window. */
export const DEBOUNCE_QUIET_MS = 10 * 60_000;

export type SurfaceDecision = { surface: boolean } | { surface: false; waitMs: number };

/**
 * The double condition: `now - firstTs >= 20min && now - lastAbsorbAt >= 10min`.
 * `lastAbsorbAt` 0 = nothing absorbed since boot, so only the first-click leg
 * can hold the batch back (a restart must not re-delay a stale batch).
 */
export function surfaceDecision(
  batch: { firstTs: number },
  lastAbsorbAt: number,
  now: number,
): SurfaceDecision {
  const waitFirst = DEBOUNCE_FIRST_MS - (now - batch.firstTs);
  const waitQuiet = DEBOUNCE_QUIET_MS - (now - lastAbsorbAt);
  const waitMs = Math.max(waitFirst, waitQuiet);
  if (waitMs > 0) return { surface: false, waitMs };
  return { surface: true };
}

/** 8:00–22:00 owner-local, half-open: 8 in, 22 out. */
export function inDeliveryWindow(h: number): boolean {
  return h >= 8 && h < 22;
}

// ---------------------------------------------------------------------------
// L1 text (pure; every word comes in via the strings bundle)
// ---------------------------------------------------------------------------

/** Copy templates for the numbered list. `{i}` `{name}` `{descriptor}`
 *  `{count}` are filled by this module's `fill`. */
export interface SummaryStrings {
  /** The count header (zh reads: today's paper brought {count} people to follow:). */
  readonly head: string;
  /** `{i}. {name}{descriptor}` — one numbered entry. */
  readonly entry: string;
  /** The descriptor's parenthetical note — its own parentheses, so a language
   *  can pick its own width; empty when the person has none. */
  readonly entryDescriptor: string;
  /** The "and N more" suffix; its template carries its own leading punctuation. */
  readonly moreSuffix: string;
}

/** The whole L1 vocabulary: the list plus the sentences around it. */
export interface DoorbellStrings extends SummaryStrings {
  /** Why following is worth it — carries its own leading dash. */
  readonly valueSentence: string;
  readonly replySyntax: string;
  /** Cap note, only when overflow > 0. */
  readonly overflowNote: string;
  /** Link-holder tail, only when overflow > 0 (overflow is the one signal
   *  that clicks other than the owner's may be in this batch). */
  readonly linkTail: string;
  /** The all-dropped micro notice. */
  readonly droppedMicro: string;
  /** Joiner for the micro notice's name list. */
  readonly nameSep: string;
  /**
   * Absorb-time copy, not L1 copy: the descriptor a followee gets when this
   * machine has no author row for them — the reader met them on someone
   * else's paper (owner ruling 2026-09-13). It rides this bundle because the
   * bundle is already the doorbell's one lexicon seam.
   */
  readonly foreignDescriptor: string;
}

/** renderCopy's placeholder semantics, minus the lookup — the templates
 *  arrive already resolved, this fills them at compose time. */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** A sigil is short enough to show whole; this keeps the doorbell line tight. */
const SHORT_SIGIL = 4;

/**
 * `name#sigil` -> `name #sig` (first 4 chars after the `#`); a sigil-less
 * name passes through as-is. The space before `#` is the doorbell's own
 * convention (spec §7 summary L1), not the house-wide `displayNamed` one —
 * this line is one long IM sentence, where the separator earns its keep.
 */
function entryName(displayName: string): string {
  const i = displayName.indexOf('#');
  if (i < 0) return displayName;
  const sigil = displayName.slice(i + 1, i + 1 + SHORT_SIGIL);
  const name = displayName.slice(0, i);
  return sigil ? `${name} #${sigil}` : name;
}

/** How many people a summary lists before switching to the "and N more" suffix. */
const LISTED = 5;

/**
 * The numbered body of the summary: ≤5 all listed, >5 the first 5 + count.
 * Entries join with one space each; the count suffix appends directly (its
 * template carries its own leading punctuation — a full-width comma in zh).
 */
export function summaryLines(
  pending: ReadonlyArray<{ display_name: string; descriptor: string | null }>,
  T: SummaryStrings,
): string {
  const listed = pending.slice(0, LISTED).map((x, i) =>
    fill(T.entry, {
      i: i + 1,
      name: entryName(x.display_name),
      descriptor: x.descriptor ? fill(T.entryDescriptor, { descriptor: x.descriptor }) : '',
    }),
  );
  let out = listed.join(' ');
  if (pending.length > LISTED) out += fill(T.moreSuffix, { count: pending.length - LISTED });
  return out;
}

/**
 * One of three shapes, or nothing:
 *  - pending > 0 → the full summary (value sentence + reply syntax, and the
 *    cap/link tails exactly when `overflow > 0`);
 *  - pending = 0, dropped > 0 → the all-dropped micro notice (display names
 *    verbatim, `name#sigil` as stored — no invented bare names);
 *  - both empty → null: nothing to interrupt the owner with.
 */
export function buildL1Text(
  pending: ReadonlyArray<{ display_name: string; descriptor: string | null }>,
  droppedUnreported: ReadonlyArray<{ display_name: string }>,
  overflow: number,
  T: DoorbellStrings,
): string | null {
  if (pending.length > 0) {
    let text = `${fill(T.head, { count: pending.length })}${summaryLines(pending, T)} ${T.valueSentence}${T.replySyntax}`;
    if (overflow > 0) text += ` ${fill(T.overflowNote, { count: overflow })} ${T.linkTail}`;
    return text;
  }
  if (droppedUnreported.length > 0) {
    return fill(T.droppedMicro, {
      count: droppedUnreported.length,
      names: droppedUnreported.map((d) => d.display_name).join(T.nameSep),
    });
  }
  return null;
}

/** The templates above, resolved from the lexicon for `lang`. */
export function doorbellStrings(lang: Lang): DoorbellStrings {
  return {
    head: renderCopy(lang, 'newspaper.doorbell.head'),
    entry: renderCopy(lang, 'newspaper.doorbell.entry'),
    entryDescriptor: renderCopy(lang, 'newspaper.doorbell.entryDescriptor'),
    moreSuffix: renderCopy(lang, 'newspaper.doorbell.moreSuffix'),
    valueSentence: renderCopy(lang, 'newspaper.doorbell.valueSentence'),
    replySyntax: renderCopy(lang, 'newspaper.doorbell.replySyntax'),
    overflowNote: renderCopy(lang, 'newspaper.doorbell.overflowNote'),
    linkTail: renderCopy(lang, 'newspaper.doorbell.linkTail'),
    droppedMicro: renderCopy(lang, 'newspaper.doorbell.droppedMicro'),
    nameSep: renderCopy(lang, 'newspaper.doorbell.nameSep'),
    foreignDescriptor: renderCopy(lang, 'newspaper.doorbell.foreignDescriptor'),
  };
}

// ---------------------------------------------------------------------------
// Poll tiering + backoff (pure, ms)
// ---------------------------------------------------------------------------

/** Fresh paper: the spec's 60–120s band, fixed at 90s. */
export const DOORBELL_HOT_TICK_MS = 90_000;
/** Paper still answerable but past the fresh window. */
export const DOORBELL_WARM_TICK_MS = 5 * 60_000;
/** Nothing answerable: the slow probe that notices the next publish. */
export const DOORBELL_SLOW_TICK_MS = 30 * 60_000;
/** How long after publish the hot tick applies. */
export const DOORBELL_HOT_WINDOW_MS = 2 * 60 * 60_000;

/**
 * How long a page-state answer keeps this root on the hot tick.
 *
 * Ten minutes, and the two bounds that pick it:
 *  - it must outlast `SAME_PAGE_MIN_INTERVAL_MS` (5min, canvas/sync-answer-
 *    client.ts), the brake on answering about the SAME page twice. A reader who
 *    keeps one paper open can only refresh this signal once per brake interval,
 *    so a window at or under five minutes would drop them out of the hot tier
 *    between two answers about the page they are still reading;
 *  - it must be far shorter than `DOORBELL_HOT_WINDOW_MS` (2h), because this
 *    signal is not "a paper of mine is fresh" but "a browser is open", and a
 *    browser that closed should stop costing a 90s poll within minutes. A ➕
 *    follows the viewing that prompted it by minutes, not hours.
 * Ten also sits inside the 20-minute first-click debounce, so a click arriving
 * at the end of the window still joins the batch its reading session started.
 */
export const DOORBELL_VIEWING_WINDOW_MS = 10 * 60_000;

/**
 * Tier of the next pull, per spec §6.2: no unexpired rows → slow probe; the
 * EARLIEST unexpired publish younger than 2h → hot; otherwise warm. The rows
 * passed in are the unexpired set (`expires_at > now`) — the caller's query
 * guarantees that, this function never re-checks it.
 */
export function pollIntervalMs(rows: ReadonlyArray<{ expires_at: number }>, nowMs: number): number {
  if (rows.length === 0) return DOORBELL_SLOW_TICK_MS;
  let earliest = Infinity;
  for (const r of rows) earliest = Math.min(earliest, r.expires_at);
  const age = nowMs - (earliest - FOLLOWABLE_TTL_MS); // expires_at is publish + 48h
  return age >= 0 && age < DOORBELL_HOT_WINDOW_MS ? DOORBELL_HOT_TICK_MS : DOORBELL_WARM_TICK_MS;
}

/**
 * The effective tier: the FASTER of the publish signal and the viewing signal.
 *
 * `pollIntervalMs` above answers "did THIS identity publish a paper", which is
 * the wrong question for a loop that pulls intents credited to the reader who
 * clicked (owner ruling 2026-09-13): the publisher polled every 90s for clicks
 * that would be addressed to somebody else, while the reader — who typically
 * never publishes — sat on the 30-minute probe. A page-state answer is this
 * process's evidence that the identity a ➕ would be credited to is reading a
 * paper right now, so it earns the hot tick on its own.
 *
 * Both signals still count: a publisher's own paper can be clicked by its owner,
 * so the publish tiers stay exactly as they were and this only ever shortens.
 * A `lastAnswerAtMs` in the future (a clock that stepped back) reads as viewing
 * rather than not — erring hot for at most one window is the cheap direction.
 */
export function tierWithViewing(
  publishTierMs: number,
  lastAnswerAtMs: number | null,
  nowMs: number,
): number {
  if (lastAnswerAtMs === null) return publishTierMs;
  if (nowMs - lastAnswerAtMs >= DOORBELL_VIEWING_WINDOW_MS) return publishTierMs;
  return Math.min(publishTierMs, DOORBELL_HOT_TICK_MS);
}

/** Doubling backoff, capped at the slow tick. `consecutiveFailures` 0 = the
 *  base interval unchanged. */
export function backoffMs(baseMs: number, consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** consecutiveFailures, DOORBELL_SLOW_TICK_MS);
}

/** pending cap per absorb (spec §6.3). */
const DOORBELL_CAP = 20;

// ---------------------------------------------------------------------------
// The service shell
// ---------------------------------------------------------------------------

/** The `Notifier`/`SqliteNotifier` enqueue subset this module needs. */
export type DoorbellNotifier = {
  enqueue(item: { level: NotificationLevel; kind: NotificationKind; payload: Record<string, unknown> }): void;
};

export interface DoorbellDeps {
  readonly ownerPopclawId: string;
  /** Signed canvas pull (canvas/intent-pull-client). Throws = this module backs off. */
  readonly pull: (owner: string, afterMs: number) => Promise<FollowIntentRow[]>;
  readonly store: PendingFollowStore;
  /**
   * Does the owner already follow this person, in ANY house? Wire it to
   * `socialGraph.follows(id)` — the person-level union. NOT
   * `socialGraph.followsIn(id)`: house-scoped and, with no house argument,
   * false for everyone in a real install.
   */
  readonly followsIn: (popclawId: string) => boolean;
  /** Unexpired `followable_authors` rows at `nowMs` (the caller owns the SQL). */
  readonly readFollowableAuthors: (nowMs: number) => FollowableAuthorRow[];
  /**
   * When this process last answered a page-state question, or null. Read at the
   * top of every tick and used for pacing ONLY (see `tierWithViewing`) — it
   * never decides what is pulled, absorbed, claimed or notified. Absent = the
   * publish-derived tiers alone, which is what the pure-service tests want.
   */
  readonly lastViewingAnswerMs?: () => number | null;
  readonly notifier: DoorbellNotifier;
  /**
   * The L1 channel (RuntimeOwnerNotifier.deliverNow), on a root that HAS one.
   *
   * Absent = this root cannot interrupt the owner, and says so by never
   * claiming a batch (see `attemptSurface`). That is not the same as a channel
   * that failed: claiming spends the batch for every root on the data root,
   * and the L1 summary — the numbered list of names — is the only place those
   * names are ever said. An MCP host has no push leg at all (its owner is
   * reached by `popclaw_notifications` pulling the queue), so it absorbs, it
   * enqueues the L2 pointer, and it leaves the batch claimable by a root that
   * can actually deliver it.
   */
  readonly deliverNow?: (text: string) => Promise<boolean>;
  /** Unix ms. */
  readonly clock?: () => number;
  /** Owner-local hour of a ms timestamp (default: the one time-derivation place). */
  readonly localHour?: (nowMs: number) => number;
  /** Copy at delivery time (default: the live owner language). */
  readonly strings?: () => DoorbellStrings;
  readonly logger?: { info(m: string): void; warn(m: string): void };
}

/**
 * One author row set → the absorb-time author map. The same person in two
 * live issues yields one entry: the NEWER issue's, sorted so it overwrites —
 * the freshest paper is the context the owner just read.
 */
function authorsMapFrom(
  rows: ReadonlyArray<FollowableAuthorRow>,
): Map<string, { display_name: string; descriptor: string | null; issue_date: string }> {
  const out = new Map<string, { display_name: string; descriptor: string | null; issue_date: string }>();
  for (const r of [...rows].sort((a, b) =>
    a.issue_date === b.issue_date ? a.popclaw_id.localeCompare(b.popclaw_id) : a.issue_date < b.issue_date ? -1 : 1,
  )) {
    out.set(r.popclaw_id, { display_name: r.display_name, descriptor: r.descriptor, issue_date: r.issue_date });
  }
  return out;
}

export interface DoorbellService {
  /**
   * One pull→absorb→(maybe)surface pass. Resolves to the next tick's delay in
   * ms (tier, or tier-backed-off after failures) and NEVER throws — a
   * background poll has nobody to throw to.
   */
  tick(): Promise<number>;
  /**
   * Was the delay the last `tick` returned a failure backoff rather than a
   * plain tier? The starter asks because a backed-off sleep is the one sleep a
   * viewing answer must NOT shorten: the canvas leg is failing, and an open
   * browser is no evidence against that.
   */
  backingOff(): boolean;
}

export function createDoorbellService(deps: DoorbellDeps): DoorbellService {
  const clock = deps.clock ?? Date.now;
  const localHour =
    deps.localHour ?? ((nowMs: number) => Number(timeContext(Math.floor(nowMs / 1000)).hm.slice(0, 2)));
  const strings = deps.strings ?? (() => doorbellStrings(ownerLang()));
  const logger = deps.logger;

  // In-memory pull cursor (ms): the canvas speaks ms and survives no restart
  // — after a reboot the first pull is a full one, absorb re-validates it.
  let lastSeenMs = 0;
  // Debounce quiet anchor; 0 = nothing absorbed yet this process.
  let lastAbsorbAtMs = 0;
  let consecutiveFailures = 0;
  // Overflow owed to the owner across ticks until the batch it belongs to
  // surfaces. In memory on purpose: it is a presentation debt, not a fact
  // worth a column; a restart loses at worst a tail note on a rare event.
  let unreportedOverflow = 0;

  const sweep = (nowMs: number): void => {
    assertActionActive();
    deps.store.expireOlderThan(Math.floor(nowMs / 1000) - Math.floor(FOLLOWABLE_TTL_MS / 1000));
  };

  /** Claim-then-deliver; cancellation returns to the owning tick. */
  const attemptSurface = async (nowMs: number): Promise<void> => {
    assertActionActive();
    // No push channel on this root: hold WITHOUT claiming, exactly as the
    // out-of-window branch below does. The claim is what spends a batch, and
    // it is shared — a root that cannot say the names must not be the one to
    // mark them said.
    const deliverNow = deps.deliverNow;
    if (!deliverNow) return;
    const firstTs = deps.store.unreportedFirstTs();
    if (firstTs === null) return;
    if (!surfaceDecision({ firstTs }, lastAbsorbAtMs, nowMs).surface) return;
    // Out of window: hold WITHOUT claiming, so the batch stays claimable by
    // the other leg (and by the morning's first in-window tick).
    if (!inDeliveryWindow(localHour(nowMs))) return;
    const pending = deps.store.listPending();
    const dropped = deps.store.hasDroppedUnreported();
    const text = buildL1Text(pending, dropped, unreportedOverflow, strings());
    if (!text) return;
    assertActionActive();
    if (deps.store.claimSurface(Math.floor(nowMs / 1000)) <= 0) return; // the other leg won
    unreportedOverflow = 0;
    try {
      assertActionActive();
      // A started host delivery remains owned until its real promise settles.
      const ok = await deliverNow(text);
      assertActionActive();
      if (ok) logger?.info(`popclaw: doorbell L1 delivered (pending=${pending.length} dropped=${dropped.length})`);
      // Not ok: the batch is claimed, so this L1 is spent — the injection
      // pointer (the "N still pending — ask for the list" line) is the
      // designed fallback, not a requeue.
    } catch (err) {
      rethrowActionCancellation(err);
      logger?.warn(`popclaw: doorbell L1 delivery failed (injection pointer is the fallback): ${String(err)}`);
    }
  };

  const lastViewingAnswerMs = deps.lastViewingAnswerMs ?? (() => null);

  return {
    backingOff: () => consecutiveFailures > 0,
    async tick(): Promise<number> {
      // The whole body is inside the try: the never-throw contract covers the
      // tier read itself (a social-db hiccup backs off like a pull failure —
      // the L2/injection passenger leans on this same promise).
      let baseMs = DOORBELL_SLOW_TICK_MS; // fallback tier when the read fails first
      let absorbedThisTick = false;
      try {
        assertActionActive();
        const nowMs = clock();
        const rows = deps.readFollowableAuthors(nowMs);
        // The tier follows whoever RECEIVES intents, which is the reader, not
        // the publisher — our own author set is only one of the two signals now.
        baseMs = tierWithViewing(pollIntervalMs(rows, nowMs), lastViewingAnswerMs(), nowMs);
        // Every tier pulls (owner ruling 2026-09-13). Intents are credited to
        // the READER who clicked, so a machine whose own paper expired — or
        // that never published one — still has its owner's clicks waiting on
        // other people's papers. Our own author set no longer gates the pull;
        // it only paces the loop (a fresh paper of ours is the one moment
        // clicks arrive in bursts) and supplies richer display material.
        assertActionActive();
        const intents = await deps.pull(deps.ownerPopclawId, lastSeenMs);
        assertActionActive();
        consecutiveFailures = 0;
        // The cursor advances over EVERY row, refused ones included, or a
        // single unfollowable intent would be re-pulled for ever.
        for (const it of intents) lastSeenMs = Math.max(lastSeenMs, it.latest_ts);
        // Nobody follows themselves. The renderer no longer offers the
        // publisher a chip for their own byline, but a page is a file that
        // outlives the build that wrote it and the intake is credited by the
        // canvas, not by us — so the door refuses it too. Not
        // `dropped_followed`: that status means "already a friend of yours",
        // and reporting yourself under it would put the owner's own name in
        // the "already in your follows" notice.
        const followable = intents.filter((it) => it.followee_popclaw_id !== deps.ownerPopclawId);
        if (followable.length > 0) {
          assertActionActive();
          const report = deps.store.absorb(followable, {
            authors: authorsMapFrom(rows),
            followsIn: deps.followsIn,
            cap: DOORBELL_CAP,
            foreignDescriptor: strings().foreignDescriptor,
          });
          if (report.overflow > 0) unreportedOverflow += report.overflow;
          // Any validated click refreshes the quiet clock — a re-click from
          // an already-followed person is as much "the session is still
          // going" as a fresh pending one.
          if (report.absorbed > 0 || report.droppedFollowed.length > 0) {
            lastAbsorbAtMs = nowMs;
            absorbedThisTick = true;
          }
        }
        sweep(nowMs);
        // After the sweep, so a batch that just aged out never announces —
        // and count is the live pending total, not the batch's size, so two
        // enqueues never read as two disjoint groups of people.
        if (absorbedThisTick) {
          const pendingNow = deps.store.listPending().length;
          if (pendingNow > 0) {
            assertActionActive();
            deps.notifier.enqueue({
              level: 'L2',
              kind: 'follow_intent',
              payload: { count: pendingNow },
            });
          }
        }
        await attemptSurface(nowMs);
        assertActionActive();
        return backoffMs(baseMs, consecutiveFailures);
      } catch (err) {
        // Cancellation is neither a failed canvas poll nor permission to
        // retry. Preserve cursor/backoff and the never-throw tick contract.
        if (err instanceof ActionInactiveError) return baseMs;
        try { assertActionActive(); } catch { return baseMs; }
        consecutiveFailures += 1;
        logger?.warn(`popclaw: follow doorbell tick failed (backing off): ${String(err)}`);
        return backoffMs(baseMs, consecutiveFailures);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The starter — the one call every resident root makes
// ---------------------------------------------------------------------------

/**
 * What a root has to hand. Everything else — the pull client, the pending
 * store, the author query, the house gate, the timer — is assembled HERE,
 * because all of it belongs to the doorbell and to nothing else. A root that
 * assembled its own would be a root that can forget one.
 */
export interface FollowDoorbellDeps {
  /** The social DB: the pending rows and the followable-author set live on it. */
  readonly db: HostDb;
  readonly ownerPopclawId: string;
  /**
   * `canvas_base_url`. Absent = no publisher, so there is nothing to pull
   * FROM: follow intents only exist because someone clicked a chip on a
   * published page. The loop then never starts and says so once.
   */
  readonly canvasBaseUrl?: string | null;
  readonly signer: Signer;
  /**
   * Does the owner already follow this person, in ANY house?
   * `socialGraph.follows(id)` — the person-level union, never `followsIn`.
   */
  readonly followsIn: (popclawId: string) => boolean;
  /**
   * House-attributed (`notifierForOrigin`), not the bare queue: an L2 with no
   * house on it is not eligible for delivery anywhere and would be counted by
   * nobody — the same silence this whole fix is about.
   */
  readonly notifier: DoorbellNotifier;
  /** The owner push channel, on a root that has one. See `DoorbellDeps.deliverNow`. */
  readonly deliverNow?: (text: string) => Promise<boolean>;
  /** The root's command lane, so a tick takes part in shutdown like every other house call. */
  readonly runCommand: <T>(work: () => Promise<T>) => Promise<T>;
  /** One owner per tick, captured before the first await. */
  readonly captureGate: (origin: string) => ActionGate;
  /** Which house's gate this leg runs under (`boot.loreHouseUrl`). */
  readonly houseOrigin: string;
  /** Permission-free durable-lane hint; existing poll/acquisition supply it. */
  readonly observeParticipation?: (changed: () => void) => () => void;
  /**
   * The pending-follow store, when the root already holds one. The gateway
   * does: its L2 injection passenger must claim through the SAME instance the
   * timer leg claims through — that shared row is the entire L1/L2 mutex.
   * Omitted = one is opened on `db`, which is what a root with no second leg
   * wants.
   */
  readonly store?: PendingFollowStore;
  /**
   * The in-process "a browser of mine is open" signal the page-state sync loop
   * feeds (canvas/viewing-signal.ts). Defaults to the one per-process instance,
   * which is what every root wants and why no root passes it.
   */
  readonly viewing?: ViewingSignal;
  readonly logger?: { info(m: string): void; warn(m: string): void };
  /** Test seams; the roots use the real client and the real clock. */
  readonly pull?: DoorbellDeps['pull'];
  readonly clock?: () => number;
  readonly localHour?: (nowMs: number) => number;
}

export interface FollowDoorbellLoop {
  /** Stop the loop. Safe before, during and after the first tick. */
  readonly stop: () => void;
  /** One finite bootstrap rescan; never reuses an old action or grants a gate. */
  readonly firstTrustChanged: () => void;
  /**
   * Resolves when the first tick has settled. Never rejects. The roots ignore
   * it deliberately — tools must answer before any canvas has replied — and
   * tests await it instead of racing a timer.
   */
  readonly firstTick: Promise<void>;
}

/**
 * A tick now, then one every tier (90s hot / 5min warm / 30min slow, backed
 * off on failure) until `stop`.
 *
 * The tier is read at the top of each tick, so a sleep already scheduled would
 * outlive the event that should shorten it — which for a reader on the 30-minute
 * probe meant half an hour between their ➕ and the pending row. Hence the one
 * event that pre-empts a sleep: a page-state answer (canvas/viewing-signal.ts)
 * brings the pending timer forward to the hot tick, never to zero, and never
 * over a failure backoff or a logged-out house.
 *
 * The cursor is in memory and starts at 0, so a restart re-pulls the full
 * history and absorb re-validates it (spec §5.2: the pull is idempotent up to
 * ±60s replay).
 */
export function startFollowDoorbell(deps: FollowDoorbellDeps): FollowDoorbellLoop {
  const logger = deps.logger;
  const canvasBaseUrl = deps.canvasBaseUrl;
  if (!canvasBaseUrl) {
    logger?.info('popclaw: follow doorbell not started — no publisher configured');
    return { stop: () => {}, firstTrustChanged: () => {}, firstTick: Promise.resolve() };
  }
  logger?.info('popclaw: follow doorbell started');
  const clock = deps.clock ?? Date.now;
  const viewing = deps.viewing ?? viewingSignal;
  const service = createDoorbellService({
    ownerPopclawId: deps.ownerPopclawId,
    lastViewingAnswerMs: () => viewing.lastAnswerAtMs(),
    // `pull` is a detached object method with no `this` — safe to hand over as-is.
    pull: deps.pull ?? makeIntentPullClient({ baseUrl: canvasBaseUrl, signer: deps.signer }).pull,
    store: deps.store ?? new PendingFollowStore(deps.db),
    followsIn: deps.followsIn,
    readFollowableAuthors: (nowMs) =>
      deps.db.queryAll<FollowableAuthorRow>(
        'SELECT issue_date, popclaw_id, display_name, descriptor, expires_at FROM followable_authors WHERE expires_at > ?',
        [nowMs],
      ),
    notifier: deps.notifier,
    ...(deps.deliverNow ? { deliverNow: deps.deliverNow } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.localHour ? { localHour: deps.localHour } : {}),
    ...(logger ? { logger } : {}),
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  // `stop()` can land while a tick is mid-flight (its timer already fired) —
  // clearing the timer alone would not stop that tick from scheduling the
  // NEXT one. The flag is the authoritative off-switch, so no zombie loop
  // keeps polling (and prodding a closed DB) after the root has stopped.
  let stopped = false;
  // When `timer` is due to fire. Meaningless while `timer` is null.
  let dueAtMs = 0;
  // May the pending sleep be shortened by a viewing answer? False while a tick
  // is in flight (that tick reads the signal itself when it picks its own next
  // delay), and false whenever the sleep was decided by something a browser
  // being open says nothing about: a failure backoff, or a house the owner
  // logged out of.
  let shortenable = false;
  let running = false;
  let startupSatisfied = false;
  let tickSatisfied = false;
  let firstTrustWake = false;
  let firstTrustWakeUsed = false;

  const schedule = (delayMs: number): void => {
    dueAtMs = clock() + delayMs;
    timer = setTimeout(() => void loop(), delayMs);
    // Never worth keeping a process alive for (ADR-0035's discipline).
    timer.unref?.();
  };

  const oneTick = (): Promise<number> =>
    deps.runCommand(async () => {
      const gate = deps.captureGate(deps.houseOrigin);
      // A house the owner logged out of is not an error and not a reason to
      // spin: the SLOW tier is the answer, never 0 — a zero delay here is an
      // unref'd setTimeout storm with nothing on the wire to show for it.
      if (!gate.isActive()) return DOORBELL_SLOW_TICK_MS;
      const delayMs = await withAction(gate, () => service.tick());
      shortenable = !service.backingOff();
      tickSatisfied = gate.isActive() && !service.backingOff();
      return delayMs;
    });

  const loop = async (): Promise<void> => {
    running = true; tickSatisfied = false;
    let delayMs = DOORBELL_SLOW_TICK_MS;
    shortenable = false; // a tick in flight owns the next delay; nothing may pre-empt it
    try {
      delayMs = await oneTick();
    } catch (err) {
      // Non-fatal by contract: a background poll has nobody to throw to.
      shortenable = false;
      logger?.warn(`popclaw: follow doorbell tick failed (non-fatal): ${String(err)}`);
    }
    running = false;
    startupSatisfied ||= tickSatisfied;
    if (stopped) return;
    // The abandoned operation stays abandoned. A single independent boot
    // pass may capture the new durable lane; ordinary failure backoff wins.
    const wake = firstTrustWake && !startupSatisfied && !service.backingOff();
    firstTrustWake = false;
    schedule(wake ? 0 : delayMs);
  };

  /**
   * A browser of ours just had a page-state question answered, so a ➕ may be
   * minutes away — bring the pending pull forward to the hot tick instead of
   * waiting out the remaining 25-odd minutes of a slow sleep.
   *
   * It cannot spin. It never schedules 0 (the hot tick is the floor, so the
   * shortest possible gap between two pulls stays 90s); it returns untouched
   * when the pending sleep is already that short, so a burst of answers costs
   * one reschedule at most; and it clears before it sets, so exactly one timer
   * is ever in flight.
   */
  const onViewingAnswer = (): void => {
    if (stopped || timer === null || !shortenable) return;
    if (dueAtMs - clock() <= DOORBELL_HOT_TICK_MS) return;
    clearTimeout(timer);
    timer = null;
    schedule(DOORBELL_HOT_TICK_MS);
  };
  const unsubscribeViewing = viewing.onAnswer(onViewingAnswer);
  const firstTrustChanged = (): void => {
    if (stopped || firstTrustWakeUsed || startupSatisfied || service.backingOff()) return;
    // Notification has no permission. Current owner/logout/storage/trust are
    // checked here and again by the independent tick before its first await.
    try { if (!deps.captureGate(deps.houseOrigin).isActive()) return; }
    catch { return; }
    firstTrustWakeUsed = true;
    if (running) { firstTrustWake = true; return; }
    if (timer) clearTimeout(timer);
    timer = null;
    schedule(0); // event-triggered once, never an inactive-gate retry loop
  };
  const unsubscribeParticipation = deps.observeParticipation?.(firstTrustChanged);

  return {
    stop: () => {
      stopped = true;
      unsubscribeViewing();
      unsubscribeParticipation?.();
      if (timer) clearTimeout(timer);
      timer = null;
    },
    // Deliberately started, never awaited: startup must not wait on a network
    // round trip, and the first intent can only exist once somebody has read a
    // page anyway.
    firstTrustChanged,
    firstTick: loop(),
  };
}
