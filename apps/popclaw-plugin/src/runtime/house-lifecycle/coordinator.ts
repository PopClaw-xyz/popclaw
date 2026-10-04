/**
 * ADR-0051 S2b — the per-house coordinator (shared by ALL entry roots).
 *
 * One process per data root owns house participation I/O. The coordinator
 * binds the HouseLifecycleManager's per-house gates to the per-house stream
 * set (public world stream + inbox stream) so that:
 * - a house whose gate is not active NEVER gets streams opened (login first,
 *   verified ack, gate, THEN streams — the work order's ordering);
 * - logoutHouse closes the gate and the coordinator tears that house's
 *   streams down immediately (local quiesce before any remote ack);
 * - a disabled house's late callback cannot revive anything: re-opening only
 *   happens through an explicit new login (the gate generation moved on);
 * - legacy houses (no control plane) keep their static-connect behavior —
 *   seeded enabled+connected without a session (compat matrix, ADR-0051 §4).
 *
 * The three roots (index/main/mcp) construct this ONCE with their own I/O
 * factories; nobody re-implements lifecycle wiring.
 */

import { normalizeHouseOrigin } from './control-client.js';
import type { HouseGate, HouseLifecycleManager, HouseStatus, LoginAuthority } from './manager.js';

/** A per-house stream set (world + inbox). stop() must be idempotent and must
 * cover in-flight handlers, not just the transport close. */
export interface PerHouseStreams {
  stop(): void | Promise<void>;
  /** Lightweight check on the existing lifecycle sync cadence. Any async work
   * remains owned by this set and must be joined by stop(); do not add timers. */
  refresh?(): void;
  /** Transport state, not merely permission to open a connection. */
  status?(): HouseStatus['streams'];
}

/** Opens one house's stream set. Called only while the captured gate is
 * active; the factory MUST consult gate.signal/gate.isActive() around every
 * await and before every outbound write (review invariants). */
export interface StreamFactory {
  open(gate: HouseGate): PerHouseStreams;
}

/** A session-free capture issued by the resident composition, never a HouseGate. */
export interface PublicResourceSelection {
  readonly key: string;
  open(): Pick<PerHouseStreams, 'stop' | 'refresh'>;
}
export interface PublicResourceFactory {
  capture(origin: string): PublicResourceSelection | null;
}

export interface HouseLifecycleCoordinatorOptions {
  manager: HouseLifecycleManager;
  streams: StreamFactory;
  publicStreams?: PublicResourceFactory;
  log?: (message: string) => void;
}

interface HouseBinding {
  origin: string;
  streams: PerHouseStreams | null;
  /** The generation the current streams belong to; a new generation means
   * the old set must be replaced even if a stale isActive read said yes. */
  generation: number;
}
interface PublicBinding {
  target: PublicResourceSelection | null;
  key: string | null;
  resource: ReturnType<PublicResourceSelection['open']> | null;
  draining: Promise<void> | null;
  failed: boolean;
}

export class HouseLifecycleCoordinator {
  private readonly managerRef: HouseLifecycleManager;
  private readonly factory: StreamFactory;
  private readonly log: (message: string) => void;
  private readonly bindings = new Map<string, HouseBinding>();
  private stopped = false;
  private readonly stopping = new Set<Promise<void>>();
  private readonly houseStopping = new Map<string, Set<Promise<void>>>();
  private readonly houseStopFailures = new Set<string>();
  private teardownDepth = 0;
  private readonly publicFactory?: PublicResourceFactory;
  private readonly publicBindings = new Map<string, PublicBinding>();
  private readonly publicLogoutFences = new Map<string, object>();
  private publicSuspending = false;

  constructor(opts: HouseLifecycleCoordinatorOptions) {
    this.managerRef = opts.manager;
    this.factory = opts.streams;
    this.publicFactory = opts.publicStreams;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Boot-time seeding (ADR-0051 migration rule): every configured house that
   * the new command has never touched keeps its static-connect behavior.
   * Existing rows (disabled by logout, or enabled by login) are never
   * overwritten — a logout survives restarts and config re-reads.
   */
  seedLegacyHouses(origins: readonly string[]): void {
    for (const originInput of origins) {
      const origin = normalizeHouseOrigin(originInput);
      if (this.managerRef.seedLegacyHouse(origin)) {
        this.log(`legacy house seeded (static connect lane): ${origin}`);
      }
      this.syncHouse(origin);
    }
  }

  /**
   * Bring one house's stream set in line with its gate: open while active
   * (and generation-fresh), closed while not. Re-opening after a
   * logout→login cycle happens ONLY through an explicit lifecycle call —
   * never from a stream callback.
   */
  syncHouse(origin: string): void {
    if (this.stopped || this.teardownDepth > 0) return;
    this.syncPublic(origin);
    const gate = this.managerRef.gateFor(origin);
    const binding = this.bindings.get(origin) ?? { origin, streams: null, generation: -1 };
    if (gate.isActive()) {
      if (!binding.streams || binding.generation !== gate.generation) {
        // A previous set from an older generation (or none) — replace it.
        this.stopBinding(binding);
        binding.streams = this.factory.open(gate);
        binding.generation = gate.generation;
        this.bindings.set(origin, binding);
        // Local aborts (logout/stopHost in THIS process) tear the set down
        // without waiting for the next explicit sync.
        gate.signal.addEventListener(
          'abort',
          () => {
            this.syncHouse(origin);
          },
          { once: true },
        );
        this.log(`streams opened (generation ${gate.generation}): ${origin}`);
      }
      // Reuse the resident's intent poll for resource-local change detection.
      // Refresh never replaces a set and cannot revive an inactive generation.
      if (gate.isActive()) {
        try {
          binding.streams?.refresh?.();
        } catch (err) {
          this.log(`stream refresh failed (${origin}): ${String(err)}`);
        }
      }
    } else if (binding.streams) {
      this.stopBinding(binding);
      binding.generation = -1;
      this.bindings.set(origin, binding);
      this.log(`streams closed: ${origin}`);
    }
  }

  /** Explicit login: manager first, streams second (never the reverse). */
  async loginHouse(input: string, authority?: LoginAuthority): ReturnType<HouseLifecycleManager['loginHouse']> {
    const origin = normalizeHouseOrigin(input);
    const logoutFence = this.publicLogoutFences.get(origin);
    const result = await this.managerRef.loginHouse(input, authority);
    // An older login cannot clear a logout issued while discovery was pending,
    // including when that logout failed to persist the disabled intent.
    if (this.publicLogoutFences.get(origin) === logoutFence) this.publicLogoutFences.delete(origin);
    this.syncHouse(origin);
    return result;
  }

  /** Explicit logout: manager quiesce (gate + leave outbox) first, streams
   * torn down immediately — before any remote ack is waited on. */
  async logoutHouse(input: string): ReturnType<HouseLifecycleManager['logoutHouse']> {
    const origin = normalizeHouseOrigin(input);
    // Fence even if the local logout transaction fails. Only explicit login
    // may release this process-local fence; reentrant callbacks cannot reopen.
    this.publicLogoutFences.set(origin, {});
    this.syncPublic(origin);
    const result = await this.managerRef.logoutHouse(input);
    this.syncHouse(origin);
    return result;
  }

  /** Strict per-House drain for recovery. A teardown failure must keep the
   * durable recovery fence held; it is never logged as successful cutover. */
  async quiesceHouse(origin: string): Promise<void> {
    this.publicLogoutFences.set(origin, {});
    const binding = this.bindings.get(origin);
    const streams = binding?.streams;
    if (binding) { binding.streams = null; binding.generation = -1; }
    const quiet = this.managerRef.quiesceHouse(origin);
    this.syncPublic(origin);
    await quiet;
    try { await streams?.stop(); }
    catch (error) { this.houseStopFailures.add(origin); throw error; }
    while (this.houseStopping.get(origin)?.size) await Promise.allSettled([...this.houseStopping.get(origin)!]);
    if (this.houseStopFailures.has(origin)) throw new Error('HOUSE_RECOVERY_TEARDOWN_FAILED');
    const publicBinding = this.publicBindings.get(origin);
    await publicBinding?.draining;
    if (publicBinding?.failed) throw new Error('HOUSE_RECOVERY_PUBLIC_TEARDOWN_FAILED');
  }

  /** The manager this coordinator binds (roots call through for status). */
  get manager(): HouseLifecycleManager {
    return this.managerRef;
  }

  /** House status via the bound manager (shared read path). */
  async getHouseStatus(input: string): Promise<HouseStatus> {
    const status = await this.managerRef.getHouseStatus(input);
    const streams = status.gateActive && !this.stopped
      ? this.bindings.get(status.origin)?.streams?.status?.()
      : undefined;
    return { ...status, streams: streams ?? { world: 'inactive', inbox: 'inactive' } };
  }

  /** Every known house origin, in stable order. */
  knownHouseOrigins(): string[] {
    const rows = this.managerRef.db.queryAll<{ house_origin: string }>(
      'SELECT house_origin FROM house_participation ORDER BY house_origin',
    );
    return rows.map((r) => r.house_origin);
  }

  /**
   * RECOVERABLE teardown (ownership loss): stop and drop every stream-set
   * binding WITHOUT the terminal manager.stopHost — the manager stays
   * usable and a later syncHouse (after re-acquisition) opens fresh sets.
   * A refused (non-owner) placeholder binding is dropped here too, so it
   * can never suppress the new owner's real open.
   */
  suspendStreams(): void {
    if (this.stopped) return;
    this.suspendPublic();
    for (const [, binding] of this.bindings) {
      this.stopBinding(binding);
    }
    this.bindings.clear();
  }

  /** Host shutdown: stop stream sets, keep desired (NOT a logout). */
  stopHost(): Promise<void> {
    this.stopped = true;
    this.suspendPublic();
    this.managerRef.stopHost();
    for (const [, binding] of this.bindings) {
      this.stopBinding(binding);
    }
    this.bindings.clear();
    return this.waitForQuiet();
  }

  /** Roots await this before closing shared databases. Includes sets already
   * dropped by logout or ownership loss, whose handlers may still be draining. */
  async waitForQuiet(): Promise<void> {
    await this.managerRef.waitForQuiet();
    while (this.stopping.size) await Promise.allSettled([...this.stopping]);
  }

  private syncPublic(origin: string): void {
    if (!this.publicFactory) return;
    const binding = this.publicBindings.get(origin) ?? { target: null, key: null, resource: null, draining: null, failed: false };
    this.publicBindings.set(origin, binding);
    binding.target = this.stopped || this.publicSuspending || this.publicLogoutFences.has(origin) ? null : this.publicFactory.capture(origin);
    this.advancePublic(origin, binding);
  }

  private advancePublic(origin: string, binding: PublicBinding): void {
    if (binding.draining || binding.failed) return;
    if (binding.resource && binding.key === binding.target?.key) {
      binding.resource.refresh?.();
      return;
    }
    const old = binding.resource;
    if (old) {
      binding.resource = null;
      binding.key = null;
      // Publish the join before stop: stop may synchronously reenter sync.
      let resolve!: () => void, reject!: (error: unknown) => void;
      const joined = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      const task = joined.then(() => {
        binding.draining = null;
        if (!this.stopped) this.advancePublic(origin, binding);
      }, error => {
        binding.failed = true; binding.draining = null;
        this.log(`public teardown failed (${origin}): ${String(error)}`);
      }).finally(() => { this.stopping.delete(task); });
      binding.draining = task;
      this.stopping.add(task);
      try { Promise.resolve(old.stop()).then(resolve, reject); } catch (error) { reject(error); }
      return;
    }
    if (!this.stopped && binding.target) {
      const selected = binding.target;
      try { binding.resource = selected.open(); binding.key = selected.key; }
      catch (error) { this.log(`public startup failed (${origin}): ${String(error)}`); }
    }
  }

  private suspendPublic(): void {
    this.publicSuspending = true;
    try {
      for (const [origin, binding] of this.publicBindings) {
        binding.target = null;
        this.advancePublic(origin, binding);
      }
    } finally { this.publicSuspending = false; }
  }

  private stopBinding(binding: HouseBinding): void {
    const streams = binding.streams;
    binding.streams = null; // Detach before callbacks can re-enter syncHouse.
    if (!streams) return;
    this.teardownDepth++;
    try {
      const result = streams.stop();
      if (!result) return;
      const task = Promise.resolve(result).catch(err => {
        this.houseStopFailures.add(binding.origin);
        this.log(`stream teardown failed (${binding.origin}): ${String(err)}`);
      }).finally(() => { this.stopping.delete(task); this.houseStopping.get(binding.origin)?.delete(task); });
      this.stopping.add(task);
      const tasks = this.houseStopping.get(binding.origin) ?? new Set<Promise<void>>();
      tasks.add(task); this.houseStopping.set(binding.origin,tasks);
    } catch (err) {
      this.houseStopFailures.add(binding.origin);
      this.log(`stream teardown failed (${binding.origin}): ${String(err)}`);
    } finally {
      this.teardownDepth--;
    }
  }
}

export type { HouseGate };
