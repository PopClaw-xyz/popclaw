/**
 * The shared root assembly: what every entry point — `index.ts`, `mcp.ts`,
 * `main.ts` — calls so that relation frames reach the same trusted chain no
 * matter which host the plugin is running in. One root wiring itself and
 * skipping the others is exactly how a capability goes missing on a host.
 *
 * Two acts, kept as separate here as they are in `house-trust` and
 * `relation-wiring`:
 *
 * **Startup** (`openRelationAwareInbox`) is attach-only. For each configured
 * house it CONFIRMS the existing trust — never pins, never TOFUs — and
 * streams open only where a pin stands AND a live participation exists to
 * receive under. Leaving a house stops its reading — BOTH streams of it:
 * personal is the owner's mail AND their relations (requirements §7.1), and
 * "the relations stopped but the chat kept subscribing" is not having left.
 * An untrusted house has no stream either: a configured URL is not an
 * authorization, and nothing here manufactures one.
 *
 * **The explicit add** (`addHouseAndLogin`) is the one place trust is
 * established and a session begins, and it is ONE commit boundary: the pin
 * CAS, the participation-tuple recheck, the pin write and the first
 * participation bump all land together or not at all. The generation that
 * comes back is the one THIS commit wrote — the connection is built on it,
 * and if the world has already moved past it, there is no handle to have.
 */
import type { ConfiguredFirstPinAttempt } from '../runtime/house-lifecycle/configured-first-pin.js';
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import {
  housePositionAdvances,
  type EnqueueWork,
  type TrustedSource,
} from '../ingress/inbound-commit.js';
import type { Signer } from '../identity/signer.js';
import {
  openHouseInboxStreams,
  type HouseInboxStream,
} from '../messaging/inbox-stream-client.js';
import {
  commitEstablishAndActivate,
  beginHouseAdd,
  prepareHouseTrust,
} from '../world/house-trust.js';
import { DutyLease } from '../runtime/duty-lease.js';
import {
  createRelationWiring,
  type RelationSessionHandle,
  type RelationWiring,
} from './relation-wiring.js';
import { KnownFollowersStore, catchUpVerifiedFollowersIntoCache } from './followers-sync.js';
import { pinnedBinding } from '../world/house-binding-pin.js';
import { recoverRelationGap } from './relation-snapshot-recovery.js';
import type { ReadAuthority } from '../identity/read-authority.js';
import {
  createRelationHouseRegistry,
  type RelationHouseRegistry,
  type RelationReception,
} from './relation-house-registry.js';
export { handleStillTrusted, isLoopbackOrigin } from './relation-house-registry.js';

/** Everything the roots already build today, plus the relation chain. */
export interface RelationHostDeps {
  readonly db: HostDb;
  readonly recipientPopclawId: string;
  readonly signer: Signer;
  /**
   * How reads at one house prove who is asking (`houseReadAuthority`).
   *
   * Required, and required to be a function of the origin: every house
   * answers this question for itself, and a root that forgot to supply it
   * would otherwise fall back to reading as nobody — which is the exact
   * failure the contract's refusals exist to make loud.
   */
  readonly readAuthorityFor: (origin: string) => ReadAuthority;
  readonly now?: () => number;
  /** Injection point for tests and roots with their own transport policy. */
  readonly fetch?: typeof globalThis.fetch;
  readonly otherConsumers?: readonly EnqueueWork[];
  readonly onRefused?: (reason: string) => void;
  readonly log?: { readonly info?: (msg: string) => void; readonly warn?: (msg: string) => void };
  /** The DM consumer, exactly as each root builds it — unchanged. */
  readonly onMessage: (
    dm: popclaw.event.IDirectMessage,
    houseSlug: string,
    envelopeBytes: Uint8Array,
    senderNickname: string,
  ) => void;
  /**
   * The C-BIZ consumer (makeInboxOnMessageCommitting's return): when a root
   * supplies BOTH, the drain routes the business write through the queue's
   * commit executor — inbox row + notification hand-over + settle in ONE
   * transaction. Supplying only onMessage keeps the legacy write path.
   */
  readonly onMessageCommitting?: (
    dm: popclaw.event.IDirectMessage,
    houseSlug: string,
    envelopeBytes: Uint8Array,
    senderNickname: string,
    commit: (fn: (tx: HostDb) => unknown) => { committed: boolean; value?: unknown },
  ) => { delivered: boolean; reason?: string };
  readonly onError?: (houseSlug: string, err: unknown) => void;
  /** Injection point for tests (a fake EventSource ctor). */
  readonly eventSourceCtor?: Parameters<typeof openHouseInboxStreams>[1]['eventSourceCtor'];
  /** Test injection for the stream client's own reconnect delay; production
   *  leaves it at the client's jittered default. */
  readonly streamReconnectDelayMs?: number;
  /**
   * The roots' notify pipeline (their notifyNewFollowers from
   * followers-sync): verified additions from the bridge ride the same
   * gate/L2/social-log path the poll's additions always did. Absent = the
   * bridge still updates the cache but notifies nobody (tests, embedded
   * callers).
   */
  readonly notifyNewFollowers?: (news: readonly { houseSlug: string; followerId: string }[]) => Promise<number> | void;
  /**
   * Start the streams as they are opened (default). A root with its own
   * once-per-process subscription guard (index.ts, P-006 §3) passes false and
   * starts them itself inside that guard.
   */
  readonly startStreams?: boolean;
  /**
   * Bring streams and drain schedule up on open (default). A root whose
   * lifetime is governed by a duty lease (mcp.ts) passes false and calls
   * start()/stop() on lease acquire/lose instead — the reception chain then
   * lives and dies with the lease, never alongside it.
   */
  readonly autostart?: boolean;
  /**
   * Run a bounded drain on this interval (and once at startup), advancing
   * relation projections and the queued DM work for THIS process's live
   * sessions. This is the production schedule: frames committed by the
   * boundary are business-processed here, not by hand. Default 2000ms;
   * 0 disables (tests and single-shot callers).
   */
  readonly drainIntervalMs?: number;
  /**
   * Recovery trigger for the DM notification ledger (the roots'
   * dmPolicy.recover): called on the drain schedule, because the queue's
   * own dedup means a replayed frame no longer re-triggers a policy retry —
   * the schedule is what gives pending notifications their second chance.
   */
  readonly recoverDmLedger?: () => void;
  /**
   * The relation producer's resend sweep (the roots' `socialGraph
   * .resendPendingRelations`): called on the drain schedule, AFTER the DM
   * ledger recovery, with a per-sweep validity check that pins the badge's
   * current run token — a sweep that spans a lease transition loses its
   * authority after every await, and a late ACK never closes a todo for a
   * dead round. Returning a Promise is fine; it is tracked and its failure
   * logged, never left floating.
   */
  readonly resendRelations?: (stillValid: () => boolean) => void | Promise<unknown>;
  /**
   * The duty badge that governs this chain. When present, the chain lives
   * and dies with the badge (started on acquire, stopped on lose) INSTEAD of
   * autostarting — and every root passes the SAME single-row badge, so the
   * gateway, the CLI daemon and every MCP process on one data root elect ONE
   * consumer between them. Absent (tests, embedded callers) autostart rules.
   */
  readonly dutyLease?: DutyLease;
  /**
   * The serial of the connection currently open for a house, when the
   * personal transport is owned elsewhere (HouseResourceSet, which is how
   * every resident root runs). Absent means this assembly opened its own
   * streams and reads the serial off them.
   *
   * It exists because a cursor reset arriving on a connection that has since
   * been REPLACED is a stale connection's word, and only whoever owns the
   * transport can tell that. Getting `undefined` from a supplied one is not
   * the same as having no supplier: it means the house has no live
   * connection, and a reset for it is stale by definition.
   */
  readonly currentConnectionSerialOf?: (houseSlug: string) => number | undefined;
}

export interface OpenedRelationHost {
  readonly wiring: RelationWiring;
  /** One stream per house that had both a standing pin and a live session. */
  readonly streams: readonly HouseInboxStream[];
  /** The houses that got no stream, and the honest reason each. */
  readonly skipped: readonly { readonly origin: string; readonly reason: string }[];
  /** The live handle behind a stream's house, for roots that route more into it. */
  handleFor(slug: string): RelationSessionHandle | undefined;
  /**
   * handleFor, plus the trust truth of NOW: the cached handle AND its
   * pin binding (origin→key/incarnation, unblocked) AND the live
   * participation at the captured generation. The gate for starting
   * anything — a world reader, a restore — that must not run on a
   * handle the world has since invalidated.
   */
  trustedHandleFor(slug: string): RelationSessionHandle | undefined;
  /**
   * The owner is leaving this house, right now, mid-connection: end the
   * participation (which fences every session of it) and stop this house's
   * stream — no reconnect, no further reads, either event type. Other houses
   * are untouched; a later explicit add or login starts fresh.
   */
  leave(houseSlug: string): void;
  /**
   * Told when a house's session ends FROM ELSEWHERE — the tick noticed a
   * departed participation and stopped that house's personal stream. The
   * roots register here to stop the SAME house's world reader: one leave,
   * both streams, whoever noticed first.
   */
  onHouseDeparted(cb: (houseSlug: string) => void): void;
  /** Stop the drain schedule and every stream this host opened. */
  stop(): void;
  /** Join the already-started drain work; stop() fences new work first. */
  whenIdle(): Promise<void>;
  /**
   * Begin (or resume) after an autostart:false open: start every stream and
   * the drain schedule. Idempotent.
   */
  start(): void;
  /**
   * Bring one house into the chain WITHOUT opening a transport for it, for a
   * root whose personal stream is owned by `HouseResourceSet`. Same
   * confirmation the constructor's own attach runs, same refusal reasons —
   * the only difference is that nothing here connects.
   *
   * Call it before that house's stream starts reading. An unattached house
   * has no handle, so `resumePosition` cannot offer a cursor and every frame
   * is refused for want of a session to commit under.
   */
  attach(origin: string, houseSlug: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /**
   * The three reception callbacks, for a root that owns the transport. They
   * are exactly what this assembly hands its own streams — supplying them to
   * `configureResources` is what makes one personal connection per house
   * serve both mail and relations.
   */
  readonly reception: RelationReception;
}

/**
 * The DM hand-over the relation drain calls, one queued frame at a time.
 *
 * What this replaced silently did nothing. It called the root's `onMessage`
 * without returning its result and without touching the commit executor, so
 * the queue saw `undefined`: not a promise, so the synchronous-processor guard
 * could not fire, and nothing committed, so the row came back as "no business
 * hand-over". The row was never settled, its claim expired after a minute, it
 * was re-claimed, and `attempts` never grew — the same DM ran through the
 * consumer again every minute, for ever. Only the inbox store's duplicate gate
 * kept the owner from being told about it each time.
 *
 * The hand-over has to be a durable receipt, not a call. So:
 *
 *  - No adapter wired is a wiring fault, and it says so. Falling back to the
 *    plain consumer is the downgrade that produced the loop — a DM handed to
 *    something that cannot report whether it landed is a DM nobody can account
 *    for.
 *  - A refusal is surfaced, not discarded. The drain turns a throw into the
 *    failure settle, which records the reason and backs off, instead of
 *    leaving the row to be retried identically for ever.
 *  - A promise is refused by name. `=> { delivered }` does not stop an async
 *    function being passed, and its "receipt" would be a pending promise the
 *    queue reads as an object.
 */
export function makeDmHandover(deps: {
  readonly slugOf: (houseKey: string) => string;
  readonly nicknameOf: (envelopeBytes: Uint8Array) => string;
  readonly handover?: RelationHostDeps['onMessageCommitting'];
}): (
  envelopeBytes: Uint8Array,
  source: TrustedSource,
  commit: (fn: (tx: HostDb) => unknown) => { committed: boolean; value?: unknown },
) => void {
  return (envelopeBytes, source, commit) => {
    const env = popclaw.event.EventEnvelope.decode(envelopeBytes);
    if (!env.directMessage) return; // not a DM; not this consumer's mail
    if (deps.handover === undefined) {
      throw new Error(
        'DM_HANDOVER_NOT_WIRED: a DM reached the relation drain with no committing consumer; ' +
          'wire makeInboxOnMessageCommitting rather than the plain onMessage, which cannot ' +
          'report whether the message was durably received',
      );
    }
    const verdict = deps.handover(
      env.directMessage, deps.slugOf(source.houseKey), envelopeBytes, deps.nicknameOf(envelopeBytes), commit,
    ) as { delivered: boolean; reason?: string } | Promise<unknown>;
    if (typeof (verdict as { then?: unknown } | null)?.then === 'function') {
      void Promise.resolve(verdict).catch(() => undefined);
      throw new Error(
        'DM_HANDOVER_MUST_BE_SYNCHRONOUS: the committing consumer returned a promise, so its ' +
          'commit authority expired before the work ran; do the durable receive inside commit() ' +
          'and the slow half after it returns',
      );
    }
    const settled = verdict as { delivered: boolean; reason?: string };
    if (!settled.delivered) {
      throw new Error(`DM_HANDOVER_REFUSED: ${settled.reason ?? 'the consumer gave no reason'}`);
    }
  };
}

/**
 * Attach to every house this root is configured for, opening streams only
 * where trust stands and the owner is live. Writes nothing except through
 * the streams' own frame commits; the DM side is passed through untouched.
 */
export async function openRelationAwareInbox(
  deps: RelationHostDeps,
  urls: readonly string[],
): Promise<OpenedRelationHost> {
  // Wiring captures these callbacks but does not execute them during
  // construction. Reception owns attribution before any attach/drain runs.
  const nicknameOf = (envelopeBytes: Uint8Array): string => {
    try {
      return (popclaw.event.EventEnvelope.decode(envelopeBytes).actor?.nickname ?? '').trim();
    } catch {
      return '';
    }
  };
  // One snapshot-recovery sweep at a time per host (the drain tick retries).
  const pendingDrain = new Set<Promise<unknown>>();
  const trackDrain = (task: Promise<unknown>): void => {
    pendingDrain.add(task);
    // Both handlers consume this observer's result; finally() would create an
    // unobserved rejected promise when a callback itself failed.
    void task.then(() => pendingDrain.delete(task), () => pendingDrain.delete(task));
  };
  let recoveryInFlight = false;
  let resendInFlight = false;
  /** One announce pass at a time; see the leg itself for why the row cannot fence it. */
  let announceInFlight = false;
  /**
   * The last thing said about each gap, keyed `houseKey\0incarnation`.
   *
   * A sweep that cannot finish leaves the gap open and the tick retries it
   * every couple of seconds, forever. Saying so every time is not visibility:
   * it is a line nobody reads. Saying it ONCE is not enough either -- a house
   * that stops refusing the credential and starts refusing the question is a
   * different problem with a different fix. So: on change.
   *
   * Process-local on purpose. A restart says it again, which is right: a
   * fresh process has told this owner nothing yet.
   */
  const lastRecoveryComplaint = new Map<string, string>();
  // The read-model bridge: a VERIFIED
  // follow/unfollow whose followee is the owner updates the owner-facing
  // follower caches immediately — one row at a time, in the apply
  // transaction, with no reconcile semantics and no notification (the
  // existing silence/L2 policies stay untouched).
  const followers = new KnownFollowersStore(deps.db);
  const wiring = createRelationWiring({
    relationReadBridge: {
      recipientPopclawId: deps.recipientPopclawId,
      onOwnerDirectedEdge: (edge) => {
        const slug = houses.slugForHouseKey(edge.houseKey);
        if (slug === undefined) return; // no stream ever attached: no slug to scope the cache row
        if (edge.following) {
          // Learned, durably, with `announced_at` left NULL. Nothing is queued
          // in memory and nothing is announced from inside this transaction:
          // whichever process won the drain may not be the one that can tell
          // the owner anything, and on one data root that is a race. The sweep
          // below runs wherever the notifier lives and picks the row up from
          // the table.
          //
          // Witnessed: this client took delivery of the signed original that
          // declares the follow. That is what lets the sweep introduce them
          // without first waiting for a poll pass to write a baseline — the
          // baseline answers "was this person already here before we looked",
          // and we were looking.
          //
          followers.noteVerifiedFollow(slug, edge.follower, { witnessed: true });
        } else {
          followers.noteVerifiedUnfollow(slug, edge.follower);
        }
      },
    },
    db: deps.db,
    recipientPopclawId: deps.recipientPopclawId,
    now: deps.now,
    // The transport ordering, which the commit boundary cannot know and will
    // not guess: absent, it makes no comparison at all, so any frame — a
    // refused one included — can write a position BEHIND the one we already
    // hold and send the next reconnect back over ground the live session has
    // already read. Every stream this chain consumes is a house's personal
    // stream, whose positions are that house's `<log_generation>.<seq>`.
    advances: housePositionAdvances,
    // The root's DM business code becomes the SLOW half of the boundary: it
    // runs on drain, outside any transaction, one queued frame at a time.
    processDm: makeDmHandover({
      slugOf: (houseKey) => houses.slugForHouseKey(houseKey) ?? houseKey,
      nicknameOf,
      ...(deps.onMessageCommitting ? { handover: deps.onMessageCommitting } : {}),
    }),
    ...(deps.otherConsumers ? { otherConsumers: deps.otherConsumers } : {}),
    ...(deps.onRefused ? { onRefused: deps.onRefused } : {}),
  });

  const departedListeners: Array<(houseSlug: string) => void> = [];
  const houses: RelationHouseRegistry = createRelationHouseRegistry({
    db: deps.db,
    wiring,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    ...(deps.currentConnectionSerialOf ? { currentConnectionSerialOf: deps.currentConnectionSerialOf } : {}),
    ownedConnectionSerialOf: (slug) => streams.find((s) => s.slug === slug)?.client.currentConnectionSerial(),
    onDeparture(slug, kind) {
      for (const s of streams) if (s.slug === slug) s.client.stop();
      if (kind === 'observed') {
        deps.log?.info?.(`popclaw: session at ${slug} ended elsewhere (or its trust moved) — stopped reading`);
      }
      for (const cb of [...departedListeners]) {
        cb(slug);
        // Observed departure aborts the maintenance round synchronously;
        // explicit leave historically completes its captured listener list.
        if (kind === 'observed' && houses.isStopped()) return;
      }
    },
  });
  for (const url of urls) await houses.confirmConfigured(url);
  const attachedUrls = houses.configured.filter((a) => a.reason === undefined).map((a) => a.origin);
  // This assembly's OWN transport, for callers that have no resource set to
  // own one. A root that does (every resident root) passes the three
  // registry callbacks to `configureResources` instead and opens nothing here.
  const streams = attachedUrls.length
    ? openHouseInboxStreams(attachedUrls, {
      recipientPopclawId: deps.recipientPopclawId,
      readAuthorityFor: deps.readAuthorityFor,
      onMessage: deps.onMessage,
      ...(deps.onError ? { onError: deps.onError } : {}),
      onFrame: houses.reception.onFrame,
      resumeFrom: houses.reception.resumePosition,
      onCursorReset: houses.reception.onCursorReset,
      ...(deps.eventSourceCtor ? { eventSourceCtor: deps.eventSourceCtor } : {}),
      ...(deps.streamReconnectDelayMs !== undefined ? { reconnectDelayMs: deps.streamReconnectDelayMs } : {}),
      // DM frames ride the same boundary as relation frames; the root's DM
      // consumer still receives them, on the drain instead of the wire.
      routeDmFramesToOnFrame: true,
    })
    : [];
  for (const stream of streams) houses.bindConfiguredStream(stream.baseUrl, stream.slug);
  // The production drain schedule: the boundary commits frames, THIS timer
  // turns them into business state — relation projections and the queued DM
  // work — for this process's live sessions. Bounded per tick; a tick with
  // nothing live is a no-op. Unref'd like every root timer: never the reason
  // the process stays open.
  const drainLimit = 20;
  // Final termination, not pause: once stop() has run, no badge transition
  // and no start() may bring this host back — a same-round acquire in the
  // announce loop must find a closed door, not a live one.
  const drainTick = (): void => {
    if (houses.isStopped()) return;
    if (!houses.maintain()) return; // a departure callback can stop the entire host
    wiring.drain(drainLimit);
    deps.recoverDmLedger?.();
    // The relation resend sweep rides the SAME clock — no timer of its own.
    // Its round is pinned per sweep: the badge's current run token at the
    // start, so a loss/release/reacquire mid-sweep (or this host's stop)
    // invalidates the sweep's authority after every await, and a late ACK
    // cannot close a todo on a dead round's behalf.
    // One sweep at a time. The tick fires every couple of seconds and does
    // not await the sweep, so without this a slow round overlaps the next
    // one: both read the same unsent originals, both push them, and both
    // race to mark them sent. The house absorbs the duplicate bytes, but the
    // bookkeeping is ours to keep straight.
    if (deps.resendRelations !== undefined && !resendInFlight) {
      const token = deps.dutyLease?.runToken();
      // No lease CONFIGURED is the compat case (valid while not disposed).
      // A configured lease with no current token — not held, started before
      // acquiring, or released mid-tick — REFUSES: no token is not the same
      // thing as no badge.
      const stillValid = (): boolean =>
        !houses.isStopped() && (deps.dutyLease === undefined || (token !== undefined && token.valid()));
      const sweep = deps.resendRelations(stillValid);
      if (sweep instanceof Promise) {
        resendInFlight = true;
        trackDrain(sweep
          .catch((err) => {
            deps.log?.warn?.(`popclaw: relation resend sweep failed — ${String(err)}`);
          })
          .finally(() => {
            resendInFlight = false;
          }));
      }
    }
    // Announce what has been learned and not yet decided about — by ANY
    // process on this data root, not only by this one. Reading it from the
    // table instead of from memory is what makes that true, and it is also
    // why a frame applied in a transaction that later rolled back cannot
    // leave a phantom announcement: the row is the only record.
    //
    // A follow this client witnessed arriving is swept straight away; one
    // merely read off a follower list still waits for that house's baseline.
    //
    // The known cost of that (migration 043): a database that is fresh while
    // the identity is not — a machine move, a restored vault without its data
    // root — reads a cold personal stream that replays this owner's whole
    // relation history, witnesses every one of those declarations, and
    // introduces people the owner has had all along. It is an L2 batch, never
    // an interrupt, and it is a one-off per data root. Weighed against every
    // new install's first follower being held in silence for up to a poll
    // interval, that is the trade this makes on purpose.
    //
    // ONE pass at a time, like the two sweeps either side of it. This leg is
    // not instant: it awaits an external standing lookup per follower before
    // anything is marked, and the tick does not await the pass. A lookup
    // slower than the couple of seconds between ticks therefore left the SAME
    // still-unannounced row visible to the next tick, which read it from the
    // table and announced it again — two notices about one person, from the
    // one path whose whole contract is exactly once. The row is the record,
    // but it is written at the END of the pass, so the row alone cannot fence
    // a pass that is still running.
    if (deps.notifyNewFollowers !== undefined && !announceInFlight) {
      const batch = followers.unannounced(drainLimit);
      if (batch.length > 0) {
        announceInFlight = true;
        trackDrain(Promise.resolve(deps.notifyNewFollowers(batch))
          .catch((err) => {
            deps.log?.warn?.(`popclaw: verified-follower notification failed — ${String(err)}`);
          })
          // Released however the pass ended. A flag a failure could leave set
          // would be a silence nothing recovers from — the opposite failure,
          // and the worse one.
          .finally(() => { announceInFlight = false; }));
      }
    }
    // Snapshot recovery: ONE open gap per tick, at its house's trusted
    // handle, bounded — the tick is the scheduler, the sweep fetches the
    // house's signed originals and hands each to the ordinary commit
    // boundary. Nothing here deletes; only a COMPLETE checkpoint closes a
    // gap and adopts the watermark.
    if (!recoveryInFlight) {
      const open = deps.db.queryAll<{ house_key: string; incarnation: string }>(
        'SELECT house_key, incarnation FROM relation_stream_gaps',
      );
      // A debt we complained about can be settled by someone else: several
      // roots share one data root, and whichever one completes a checkpoint
      // closes the gap for all of them. Closure is decided by the TABLE, not
      // by who finished the sweep -- reporting only this process's own sweeps
      // left the last word about a closed gap reading "still open", with no
      // later sweep to correct it.
      if (lastRecoveryComplaint.size > 0) {
        const live = new Set(open.map((g) => `${g.house_key}\0${g.incarnation}`));
        for (const key of [...lastRecoveryComplaint.keys()]) {
          if (live.has(key)) continue;
          lastRecoveryComplaint.delete(key);
          deps.log?.info?.(`popclaw: relation gap closed for ${key.split('\0')[0]!.slice(0, 8)}…`);
        }
      }
      for (const gap of open) {
        const target = houses.recoveryTarget(gap.house_key, gap.incarnation);
        if (target === undefined) continue;
        const { origin, handle: handleOfGap } = target;
        recoveryInFlight = true;
        // The sweep's round, pinned at its start: a badge transition or a
        // stop mid-sweep completes nothing.
        const recoveryToken = deps.dutyLease?.runToken();
        const sweepValid = (): boolean =>
          !houses.isStopped() && (deps.dutyLease === undefined || (recoveryToken !== undefined && recoveryToken.valid()));
        // The sweep only runs under a handle that just passed
        // handleStillTrusted — a pin exists here; if the impossible happens
        // and it does not, refuse the sweep rather than guess an identity.
        const expectedPin = pinnedBinding(deps.db, origin);
        if (expectedPin === undefined) continue;
        trackDrain(recoverRelationGap({
          db: deps.db,
          readAuth: deps.readAuthorityFor(origin),
          fetch: deps.fetch ?? globalThis.fetch,
          origin,
          handle: handleOfGap,
          houseKey: gap.house_key,
          incarnation: gap.incarnation,
          // The sweep's original authority: the
          // completion compares the participation generation and the pinned
          // key identity against what held when the sweep set out.
          expected: {
            ownerGeneration: handleOfGap.source.ownerGeneration,
            houseKeyOfPin: expectedPin.houseKey,
            incarnationOfPin: expectedPin.incarnation,
          },
          stillValid: sweepValid,
          ...(deps.log ? { log: deps.log } : {}),
          ...(deps.now ? { now: deps.now } : {}),
        })
          .then((outcome) => {
            // The returned value IS the failure report: this function does
            // not throw, so the `.catch` below only ever sees a defect. A
            // discarded outcome meant a gap that could never close retried in
            // total silence -- the projection missing edges while every
            // surface looked healthy, and `deps.log` threaded in here and
            // never called from inside the sweep.
            //
            // Success is not announced here. The next tick sees the row gone
            // and says so once, by the same rule, whoever closed it.
            if (outcome.recovered) return;
            const key = `${gap.house_key}\0${gap.incarnation}`;
            if (lastRecoveryComplaint.get(key) === outcome.reason) return;
            lastRecoveryComplaint.set(key, outcome.reason);
            deps.log?.warn?.(
              `popclaw: relation gap for ${gap.house_key.slice(0, 8)}… still open — ${outcome.reason}`,
            );
          })
          .catch((err) => {
            deps.log?.warn?.(`popclaw: relation snapshot recovery failed — ${String(err)}`);
          })
          .finally(() => {
            recoveryInFlight = false;
          }));
        break; // one per tick
      }
    }
  };
  let drainTimer: ReturnType<typeof setInterval> | null = null;
  const autostart = deps.autostart !== false;
  const leaseListener = deps.dutyLease !== undefined
    ? {
        onAcquired: () => startHost(),
        onLost: () => { if (drainTimer !== null) { clearInterval(drainTimer); drainTimer = null; } for (const s of streams) s.client.stop(); },
      }
    : undefined;
  if (leaseListener !== undefined && deps.dutyLease !== undefined) {
    // Governed by the badge, and the badge has ONE owner per root whose job
    // is to run the heartbeat and try: this assembly only LISTENS, so an
    // initial direct tryAcquire cannot eat a transition another workload
    // was owed. Free-badge acquisition is the owner's first tryAcquire.
    deps.dutyLease.addTransitionListener(leaseListener);
    if (deps.dutyLease.isHeld()) startHost();
  } else if (autostart) startHost();
  function startHost(): void {
    if (houses.isStopped()) return;
    // Bounded catch-up: adjudicated edges whose cache
    // rows predate the bridge (internal DBs that ran the 031-era stack) get
    // their cache rows — reads only the already-judged projection, inserts
    // only missing rows, notifies nobody.
    if (houses.hasHouseAliases()) {
      catchUpVerifiedFollowersIntoCache(deps.db, deps.recipientPopclawId, (k) => houses.slugForHouseKey(k), followers);
    }
    if ((deps.drainIntervalMs ?? 2_000) > 0) {
      drainTick();
      if (houses.isStopped()) return; // the initial tick's callbacks may have stopped us
      if (drainTimer === null) {
        drainTimer = setInterval(drainTick, deps.drainIntervalMs ?? 2_000);
        drainTimer.unref?.();
      }
    }
    // Only the streams whose handle is still live: a restart after a leave
    // must not resurrect a detached connection (its house has no standing,
    // and the tick no longer watches it). Fresh attachments are
    // added by a new attach, not by this loop.
    if (deps.startStreams !== false) {
      for (const s of streams) {
        if (houses.handleFor(s.slug) !== undefined) s.client.start();
      }
    }
  }

  return {
    wiring,
    streams,
    skipped: houses.configured
      .filter((a): a is { origin: string; reason: string } => a.reason !== undefined)
      .map((a) => ({ origin: a.origin, reason: a.reason! })),
    handleFor: houses.handleFor,
    trustedHandleFor: houses.trustedHandleFor,
    leave: houses.leave,
    onHouseDeparted(cb) {
      departedListeners.push(cb);
    },
    stop() {
      houses.stop();
      if (drainTimer !== null) {
        clearInterval(drainTimer);
        drainTimer = null;
      }
      for (const s of streams) s.client.stop();
      // Final, not paused: a disposed host must not be revived by a later
      // badge transition.
      if (leaseListener !== undefined) deps.dutyLease?.removeTransitionListener(leaseListener);
      departedListeners.length = 0;
    },
    async whenIdle() {
      while (pendingDrain.size) await Promise.allSettled([...pendingDrain]);
    },
    start: startHost,
    attach: houses.attach,
    reception: houses.reception,
  };
}

export type AddHouseResult =
  | {
      readonly ok: true;
      readonly binding: { readonly houseKey: string; readonly incarnation: string };
      readonly handle: RelationSessionHandle;
    }
  | { readonly ok: false; readonly refusal: string };

/**
 * The owner's explicit act: trust this house and start receiving as a live
 * session, or do neither. One commit boundary covers the pin CAS, the
 * participation recheck, the pin write and the first activation; the handle
 * is built on the generation that commit wrote, and if another login has
 * already moved past it the caller is told so instead of being handed a
 * connection that borrows someone else's session.
 */
export async function addHouseAndLogin(
  deps: Pick<RelationHostDeps, 'db' | 'now' | 'fetch'>,
  wiring: RelationWiring,
  origin: string,
  opts: { readonly configuredHouseKey?: string; readonly allowInsecureOrigin?: boolean; readonly firstPin?: ConfiguredFirstPinAttempt } = {},
): Promise<AddHouseResult> {
  // One data root end to end: a generation activated on one db must never
  // become a handle on another. The caller is a root assembling one host —
  // mixing two roots' databases here is a wiring bug, and it is refused
  // rather than trusted.
  if (wiring.db !== deps.db) {
    return { ok: false as const, refusal: 'HOUSE_WIRING_MISMATCH' };
  }
  const attempt = beginHouseAdd(deps.db, origin);
  const prepared = await prepareHouseTrust(deps.db, origin, {
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(opts.configuredHouseKey !== undefined ? { configuredHouseKey: opts.configuredHouseKey } : {}),
    ...(opts.allowInsecureOrigin ? { allowInsecureOrigin: true } : {}),
    attempt,
  });
  if (!prepared.ok) return { ok: false as const, refusal: prepared.refusal };
  const activated = commitEstablishAndActivate(deps.db, prepared.prepared, {
    ...(opts.firstPin ? { firstPin: opts.firstPin } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!activated.ok) return { ok: false as const, refusal: activated.refusal };
  const handle = wiring.handleAt(
    { houseKey: activated.binding.houseKey, incarnation: activated.binding.incarnation },
    activated.ownerGeneration,
  );
  if (handle === undefined) {
    // The activation committed and was superseded before its connection
    // stood up. Nobody may borrow the newer session's standing.
    return { ok: false as const, refusal: 'HOUSE_OWNER_MOVED_ON' };
  }
  return {
    ok: true as const,
    binding: { houseKey: activated.binding.houseKey, incarnation: activated.binding.incarnation },
    handle,
  };
}
