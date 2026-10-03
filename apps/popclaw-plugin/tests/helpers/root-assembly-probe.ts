/**
 * Component-level probes for the root-assembly characterization tests
 * (tests/unit/runtime/root-assembly-*.test.ts).
 *
 * Probes record that a real component was reached (and with what), then call
 * the real implementation. What is NOT pass-through, and so what these tests
 * cannot speak to:
 * - Injected faults (`failReception`, `failHousesStop`, `failWorldsStop`). The
 *   stop faults reject/throw only AFTER the real stop has done its work, and
 *   `failReception` throws INSTEAD of opening reception. They prove how the
 *   root's control flow treats a rejection; they say nothing about the state a
 *   component that failed on its own would leave behind.
 * - Holds (`holdReception`, `holdHousesStop`): a barrier in front of the real
 *   call, so a test can act while the root sits on that exact await.
 *
 * The test files wire these into `vi.mock` factories; the state lives here so
 * both roots record into the same shape.
 */
import type { FollowerSyncDeps } from '../../src/social-graph/followers-sync.js';
import type { HostDb } from '../../src/host/host-db.js';
import type { HouseRuntime } from '../../src/runtime/house-lifecycle/house-runtime.js';

type ResourceConfig = Parameters<HouseRuntime['configureResources']>[0];

/** A gate in front of one real call: `reached` once the root is waiting on it, until `release()`. */
export interface Barrier {
  readonly reached: Promise<void>;
  release(): void;
  /** Called by the probe in place of the real call's start. */
  pass(): Promise<void>;
}

export function barrier(): Barrier {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(done => { arrive = done; });
  const released = new Promise<void>(done => { release = done; });
  return { reached, release, pass: async () => { arrive(); await released; } };
}

/** What the prompt-build hook handed the L2 delivery leg on one owner turn: is each L2 slot filled? */
export interface L2SlotRead {
  notifier: boolean;
  nameOf: boolean;
  proposals: boolean;
  pendingFollows: boolean;
}

export const probe = {
  /** Ordered component calls: `houses.stop`, `hostDb.close`, `release`, … */
  events: [] as string[],
  /** Throw from openRelationReception on the next boot. */
  failReception: false,
  /** Throw from HouseRuntime.stop (to observe per-step catch vs first-throw abort). */
  failHousesStop: false,
  /** Throw (synchronously) from WorldRuntime.stop, a bare shutdown step. */
  failWorldsStop: false,
  /** Hold the root in front of the real openRelationReception. */
  holdReception: undefined as Barrier | undefined,
  /** Hold the root in front of the real HouseRuntime.stop. */
  holdHousesStop: undefined as Barrier | undefined,
  /** Runs just before the forced boot failure is thrown. */
  beforeFail: undefined as (() => void) | undefined,
  /** Runs after every recorded event. */
  onEvent: undefined as ((label: string) => void) | undefined,
  followerSyncDeps: [] as FollowerSyncDeps[],
  announceDeps: [] as FollowerSyncDeps[],
  replyPingDeps: [] as Record<string, unknown>[],
  resourceConfigs: [] as ResourceConfig[],
  receptionDeps: [] as Array<{ notifyNewFollowers?: (news: never[]) => unknown }>,
  enqueued: [] as Array<{ level: string; kind: string; payload: Record<string, unknown> }>,
  socialLog: [] as Array<{ kind: string; actor?: { id?: string; name?: string } }>,
  l2Reads: [] as L2SlotRead[],
  /** Real resources the root opened, so a test whose shutdown/cleanup was aborted can hand them back. */
  hostDbs: [] as HostDb[],
  storeDbs: [] as Array<{ close(): void }>,
  executionStores: [] as Array<{ close(): void }>,
  receptionStops: [] as Array<() => void>,
  /** KnownFollowersStore.unannounced calls: relation reception's drain tick reads it every tick. */
  unannouncedReads: 0,
  reset(): void {
    probe.events.length = 0;
    probe.failReception = false;
    probe.failHousesStop = false;
    probe.failWorldsStop = false;
    probe.beforeFail = undefined;
    probe.onEvent = undefined;
    probe.followerSyncDeps.length = 0;
    probe.announceDeps.length = 0;
    probe.replyPingDeps.length = 0;
    probe.resourceConfigs.length = 0;
    probe.receptionDeps.length = 0;
    probe.enqueued.length = 0;
    probe.socialLog.length = 0;
    probe.l2Reads.length = 0;
    probe.holdReception = undefined;
    probe.holdHousesStop = undefined;
    probe.hostDbs.length = 0;
    probe.storeDbs.length = 0;
    probe.executionStores.length = 0;
    probe.receptionStops.length = 0;
    probe.unannouncedReads = 0;
  },
};

export const FORCED_BOOT_FAILURE = 'C0_FORCED_BOOT_FAILURE';

/** Record one event and let the test react to it synchronously. */
export function push(label: string): void {
  probe.events.push(label);
  probe.onEvent?.(label);
}

/** Replace `obj[name]` with a recorder that still calls the original. */
export function record<T extends object>(obj: T, name: keyof T & string, label: string): void {
  const original = obj[name] as unknown as (...args: unknown[]) => unknown;
  (obj as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
    push(label);
    return original.apply(this, args);
  };
}

/**
 * Same as `record` for a factory result that may be frozen: a frozen object
 * is replaced by a frozen copy (its methods are closures, not `this`-bound).
 */
export function recorded<T extends object>(obj: T, name: keyof T & string, label: string): T {
  if (!Object.isFrozen(obj)) { record(obj, name, label); return obj; }
  const original = obj[name] as unknown as (...args: unknown[]) => unknown;
  return Object.freeze({ ...obj, [name]: (...args: unknown[]) => { push(label); return original(...args); } }) as T;
}

/** Host DB seen by the storage registration: record its close. */
export function probeHostDb(db: HostDb, release: () => void): () => void {
  probe.hostDbs.push(db);
  record(db, 'close', 'hostDb.close');
  return () => { push('release'); release(); };
}

/** Patches prototypes once per file; returns a restore function. */
export function patchPrototypes(targets: Array<{
  proto: object; name: string; label: string; failWhen?: () => boolean; holdWhen?: () => Barrier | undefined;
}>): () => void {
  const restores: Array<() => void> = [];
  for (const { proto, name, label, failWhen, holdWhen } of targets) {
    const bag = proto as Record<string, unknown>;
    const original = bag[name] as (...args: unknown[]) => unknown;
    bag[name] = function (this: unknown, ...args: unknown[]) {
      push(label);
      // A held call is promise-returning by construction (only async steps are held).
      const hold = holdWhen?.();
      if (hold) return hold.pass().then(() => finish(this, args));
      return finish(this, args);
    };
    const finish = (self: unknown, args: unknown[]): unknown => {
      const result = original.apply(self, args);
      // The injected failure comes AFTER the real call has done its work, so
      // nothing it owns (timers, streams) is left running behind the test.
      // A promise-returning step rejects; a synchronous one throws.
      if (failWhen?.()) {
        const failure = new Error(`C0_${label}_FAILED`);
        if (result instanceof Promise) return result.then(() => { throw failure; });
        throw failure;
      }
      return result;
    };
    restores.push(() => { bag[name] = original; });
  }
  return () => restores.forEach(restore => restore());
}
