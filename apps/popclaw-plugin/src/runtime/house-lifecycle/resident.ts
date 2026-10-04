/**
 * ADR-0051 S2b — the RESIDENT lifecycle owner binding.
 *
 * One process per data root owns the lifecycle coordinator (streams,
 * renewal, retry workers); the others (CLI one-shots, second hosts) write
 * lifecycle INTENT through the shared SQLite (the participation rows and
 * outbox ARE the IPC for control intent in this slice) and never open
 * stream sets of their own.
 *
 * The resident binding ties the coordinator to the OwnerLease:
 * - stream-set gates carry the CAPTURED OWNER EPOCH: a takeover in the
 *   durable row kills the old owner's captured gate IMMEDIATELY (its
 *   isActive() consults the row every call) — not at the next timer tick;
 * - losing ownership is RECOVERABLE, unlike a host stop: onLost suspends
 *   stream sets and quiesces the manager (old workers exit without
 *   settling, gates die), and onAcquired re-arms — the manager is never
 *   terminally stopped by an ownership change, so an ex-owner that regains
 *   ownership opens FRESH sets (review finding 5);
 * - onAcquired tears the old epoch down FIRST, then re-arms: manager
 *   resumeAfterOwnership drains the old generation's workers before
 *   rescanning the outbox, and the re-seed pass re-opens gates for
 *   still-valid durable rows — including rows another process created
 *   while this one was a reader (review finding 3);
 * - a refused (non-owner) open is never retained as a successful set: the
 *   acquisition pass drops all bindings before syncing, so the new owner's
 *   real open always happens (review finding 4).
 */

import {
  HouseLifecycleCoordinator,
  type PerHouseStreams,
  type StreamFactory,
  type PublicResourceFactory,
} from './coordinator.js';
import type { HouseGate, HouseLifecycleManager, OwnerAuthority } from './manager.js';
import { readParticipation } from './participation-store.js';
import { OwnerLease } from './owner-lease.js';

export interface ResidentLifecycleOptions {
  readonly manager: HouseLifecycleManager;
  /** Stream-set factory; called ONLY while this process owns the lease. */
  readonly streams: StreamFactory;
  /** Separate session-free subset; captures this same resident authority. */
  readonly publicStreams?: PublicResourceFactory;
  readonly seedConfiguredLegacy?: boolean;
  readonly token: string;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** Poll cadence for intent changes written by non-owner processes
   * (their login/logout land in the durable rows; the owner picks them
   * up here). Default 2s. */
  readonly intentPollMs?: number;
  /** Durable tuple or gate availability changed after sync; observation conveys no authority. */
  readonly onParticipationObserved?: (origin: string) => void;
}

export class ResidentLifecycle {
  readonly coordinator: HouseLifecycleCoordinator;
  private readonly lease: OwnerLease;
  private readonly log: (message: string) => void;
  private readonly intentPollMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private ready: Promise<void> = Promise.resolve();
  private stopped = false;
  private stopTask: Promise<void> | null = null;
  readonly authority: OwnerAuthority;
  private readonly origins: string[] = [];
  private readonly seedConfiguredLegacy: boolean;
  private readonly observedTuples = new Map<string, string | null>();
  private readonly onParticipationObserved: ((origin: string) => void) | undefined;

  constructor(opts: ResidentLifecycleOptions) {
    this.onParticipationObserved = opts.onParticipationObserved;
    this.log = opts.log ?? (() => {});
    this.intentPollMs = opts.intentPollMs ?? 2_000;
    this.managerRef = opts.manager;
    this.seedConfiguredLegacy = opts.seedConfiguredLegacy !== false;
    this.lease = new OwnerLease({
      db: opts.manager.db,
      token: opts.token,
      ttlMs: opts.ttlMs ?? 30_000,
      ...(opts.now ? { now: opts.now } : {}),
    });
    this.coordinator = new HouseLifecycleCoordinator({
      manager: opts.manager,
      streams: gateStreamsOnOwnership(this.lease, opts.streams, this.log),
      publicStreams: opts.publicStreams,
      log: this.log,
    });
    // Bind the durable owner authority INTO the manager: leave workers then
    // refuse to send or settle once the durable owner row names another
    // process (or a newer epoch) — a cross-process takeover is visible to
    // every control send and settle immediately, not at the next timer.
    this.authority = {
      captureEpoch: () => (!this.stopped && this.lease.isOwnerNow() ? this.lease.knownGeneration() : null),
      isEpochCurrent: (epoch) => !this.stopped && this.lease.isGenerationCurrent(epoch),
    };
    opts.manager.bindOwnerAuthority(this.authority);
  }

  /** The configured origins to seed — record before start(). */
  configureOrigins(origins: readonly string[]): void {
    this.origins.length = 0;
    this.origins.push(...origins);
  }

  /**
   * Start the resident binding: try to become the owner immediately, seed
   * legacy houses (the migration rule — no-ops on existing rows), start the
   * lease renewal/loss callbacks and the intent poll. A NON-owner start is
   * legal (this process stays a reader; sets only open if it later
   * acquires).
   */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    if (this.lease.tryAcquire()) {
      this.log('lifecycle owner acquired; syncing houses');
      this.restoreAndSync();
    }
    this.lease.start({
      onAcquired: () => {
        this.log('lifecycle ownership epoch entered; re-syncing houses');
        this.restoreAndSync();
      },
      onLost: () => {
        // Another process (or a new epoch) owns the lifecycle now:
        // RECOVERABLE teardown — suspend stream sets and quiesce the
        // manager (old workers exit without settling, captured gates die).
        // Durable rows keep desired; this is not a logout, and the manager
        // is NOT terminally stopped — a later acquisition re-arms.
        this.log('lifecycle ownership lost; quiescing (recoverable)');
        this.coordinator.suspendStreams();
        this.managerRef.quiesce();
      },
    });
    this.pollTimer = setInterval(() => {
      if (!this.lease.isOwnerNow()) return;
      this.syncAll();
    }, this.intentPollMs);
    this.pollTimer.unref?.();
  }

  whenReady(): Promise<void> { return this.ready; }

  /** Hint only: durable state supplies all permission. Poll/acquisition also
   * recover this transition if the committing writer exits before this call. */
  participationChanged(): void {
    if (!this.stopped && this.started && this.lease.isOwnerNow()) this.syncAll();
  }

  /** Stop the resident binding (host shutdown) — durable state untouched. */
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const drained = this.coordinator.stopHost();
    this.stopTask = drained;
    this.lease.release();
    return drained;
  }

  /** The bound manager (roots read status through the coordinator). */
  get manager(): HouseLifecycleManager {
    return this.managerRef;
  }

  /** Capture permission for notifications/egress as well as stream sets. */
  captureGate(origin: string): HouseGate {
    const gate = this.managerRef.gateFor(origin);
    const epoch = this.lease.isOwnerNow() ? this.lease.knownGeneration() : null;
    return { ...gate, isActive: () => gate.isActive() && epoch !== null && this.lease.isGenerationCurrent(epoch),
      inactiveReason: () => epoch === null || !this.lease.isGenerationCurrent(epoch) ? 'HOUSE_OWNER_INACTIVE' : gate.inactiveReason?.() ?? 'HOUSE_ACTION_STALE' };
  }

  private readonly managerRef!: HouseLifecycleManager;

  /**
   * The acquisition path (first owner, handover, or epoch rollover):
   * teardown of the old epoch FIRST, then re-arm, then restore gates and
   * open sets.
   */
  private restoreAndSync(): void {
    // (1) Old-epoch teardown: drop every binding (a refused placeholder
    // from our reader phase included — it must not suppress the real open)
    // and quiesce anything still live (idempotent on first acquisition).
    this.coordinator.suspendStreams();
    this.managerRef.quiesce();
    this.observedTuples.clear();
    // (2) Re-arm: fresh pause generation; drains the old workers before
    // rescanning the outbox. Async — the gate/seed pass below does not
    // depend on the drain completing.
    this.ready = this.managerRef.resumeAfterOwnership();
    // (3) Restore gates for still-valid durable rows (this process may have
    // been a reader when these rows were created) and open sets.
    this.coordinator.seedLegacyHouses(this.allOrigins());
    this.syncAll();
  }

  private allOrigins(): string[] {
    const seen = new Set<string>([...(this.seedConfiguredLegacy ? this.origins : []), ...this.coordinator.knownHouseOrigins()]);
    return [...seen];
  }

  private syncAll(): void {
    // Existing rows are never overwritten. This also restores a local gate
    // when another process committed a new session since our last poll.
    this.coordinator.seedLegacyHouses(this.allOrigins());
    for (const origin of this.allOrigins()) {
      try {
        const row = readParticipation(this.managerRef.db, origin);
        const tuple = row ? JSON.stringify([row.op_seq, row.session_id, row.desired, row.phase, this.managerRef.gateFor(origin).isActive()]) : null;
        if (this.observedTuples.get(origin) === tuple) continue;
        this.observedTuples.set(origin, tuple);
        this.onParticipationObserved?.(origin);
      } catch (error) { this.log(`participation observation failed: ${String(error)}`); }
    }
    void this.managerRef.renewDueSessions().catch(err => this.log(`session renewal failed: ${String(err)}`));
    void this.managerRef.resumeEnabledSessions().catch(err => this.log(`session recovery failed: ${String(err)}`));
    // Peer-process logout writes only the durable outbox. The resident owns
    // delivery; scanning here picks up new leaves without a host restart.
    void this.managerRef.resumePendingOperations().catch(err => this.log(`leave recovery failed: ${String(err)}`));
  }
}

/**
 * Wrap the stream factory so a set only opens while THIS process owns the
 * lease AND the durable owner epoch still matches. The gate handed to the
 * factory carries the epoch: its isActive() re-reads the owner row on every
 * call, so a takeover kills the captured gate IMMEDIATELY (review finding
 * 2) — never at the next timer tick.
 */
function gateStreamsOnOwnership(
  lease: OwnerLease,
  factory: StreamFactory,
  log: (message: string) => void,
): StreamFactory {
  return {
    open: (gate: HouseGate): PerHouseStreams => {
      if (!lease.isOwnerNow()) {
        // A non-owner process must never hold stream sets. This REFUSAL is
        // not a set: the caller (coordinator) may cache it briefly, but the
        // acquisition pass (suspendStreams) drops every binding before
        // re-syncing, so it can never suppress the real open (finding 4).
        log(`stream open refused (not lifecycle owner): ${gate.origin}`);
        return { stop: () => undefined };
      }
      const openedEpoch = lease.knownGeneration();
      const epochGate: HouseGate = {
        origin: gate.origin,
        generation: gate.generation,
        signal: gate.signal,
        isActive: () =>
          gate.isActive() && (openedEpoch === null || lease.isGenerationCurrent(openedEpoch)),
      };
      const inner = factory.open(epochGate);
      return {
        refresh: () => {
          // A peer can take over before our lease timer notices. Fence the
          // callback against the captured durable epoch on every sync pass.
          if (epochGate.isActive()) inner.refresh?.();
        },
        status: () => epochGate.isActive()
          ? inner.status?.() ?? { world: 'inactive', inbox: 'inactive' }
          : { world: 'inactive', inbox: 'inactive' },
        stop: () => {
          if (openedEpoch !== null && !lease.isGenerationCurrent(openedEpoch)) {
            // A stale set stopping after a takeover — close our own sockets;
            // the new owner runs its own teardown for its own sets.
            log(`stale stream set stopping post-takeover: ${gate.origin}`);
          }
          return inner.stop();
        },
      };
    },
  };
}

export type { HouseGate };
