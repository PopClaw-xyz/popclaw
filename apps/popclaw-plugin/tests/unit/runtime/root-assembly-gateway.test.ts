import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPerProcess, getOrCreatePerProcess } from '../../../src/runtime/once.js';
import { NewspaperDispatchRegistry } from '../../../src/newspaper/dedicated-session.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { WorldRuntime } from '../../../src/runtime/world-runtime.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { checkInviteOnce, type InviteWatchDeps, type PendingInvitesStore } from '../../../src/invite/pending-invites.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';
import { KnownFollowersStore } from '../../../src/social-graph/followers-sync.js';
import { SocialLogWriter } from '../../../src/social-log/social-log.js';
import { makeBondContext } from '../../../src/bonds/bond-context.js';
import type { BondsStore } from '../../../src/bonds/bonds-store.js';
import { resetOwnerApprovals } from '../../../src/host/owner-approval.js';
import { barrier, FORCED_BOOT_FAILURE, patchPrototypes, probe, push, type L2SlotRead } from '../../helpers/root-assembly-probe.js';
import { ALL_STARTERS, RESIDENT_SERVICES } from '../../../src/runtime/resident-services.js';

/**
 * C0 characterization of the GATEWAY composition root (src/index.ts
 * `bootRuntime`), driven through the real entrance: `plugin.register` with a
 * fake OpenClaw api, then the `popclaw-runtime` service's start and the
 * `gateway_stop` hook, offline, on a temp data root.
 *
 * Everything here pins CURRENT behaviour ahead of the shared-assembly move
 * (refactor-assembly-design §5/§6 C0). A test that goes red after the move
 * means observable behaviour changed; a deliberate change updates the pin in
 * a named commit. Drift rows carry their number from the roots difference
 * table; they are evidence, not endorsements.
 *
 * Probes (tests/helpers/root-assembly-probe.ts) record calls on real
 * components and call through. Not pass-through, see that file's header:
 * injected faults (reception throws instead of opening; HouseRuntime.stop /
 * WorldRuntime.stop reject AFTER the real stop ran) and holds (a barrier in
 * front of a real await). A fault therefore pins the root's control flow on a
 * rejection, not the resource state after a natural component failure.
 * The network is off: global fetch throws, and lore-house and Canvas both point
 * at an unused loopback port.
 */

vi.mock('../../../src/social-graph/relation-reception.js', async (orig) => {
  const real = await orig<typeof import('../../../src/social-graph/relation-reception.js')>();
  const { probe: p, push, FORCED_BOOT_FAILURE: failure } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, openRelationReception: async (deps: Parameters<typeof real.openRelationReception>[0]) => {
    if (p.holdReception) { push('reception.held'); await p.holdReception.pass(); }
    if (p.failReception) { p.beforeFail?.(); push('boot.fail'); throw new Error(failure); }
    p.receptionDeps.push(deps as never);
    const reception = await real.openRelationReception(deps);
    p.receptionStops.push(() => reception.stop());
    push('reception.open');
    return { ...reception, stop: () => { push('reception.stop'); reception.stop(); } };
  } };
});
vi.mock('../../../src/host/storage-maintenance.js', async (orig) => {
  const real = await orig<typeof import('../../../src/host/storage-maintenance.js')>();
  const { probeHostDb } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, registerStorageRuntime: (...args: Parameters<typeof real.registerStorageRuntime>) =>
    probeHostDb(args[0], real.registerStorageRuntime(...args)) };
});
vi.mock('../../../src/ingress/world-feed-store.js', async (orig) => {
  const real = await orig<typeof import('../../../src/ingress/world-feed-store.js')>();
  const { probe: p, record } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, openHouseStores: async (...args: Parameters<typeof real.openHouseStores>) => {
    const stores = await real.openHouseStores(...args);
    for (const store of stores) { p.storeDbs.push(store.db); record(store.db, 'close', `storeDb.close:${store.slug}`); }
    return stores;
  } };
});
vi.mock('../../../src/social-graph/follower-sync-service.js', async (orig) => {
  const real = await orig<typeof import('../../../src/social-graph/follower-sync-service.js')>();
  const { probe: p, push } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, createFollowerSync: (service: Parameters<typeof real.createFollowerSync>[0]) => {
    p.followerSyncDeps.push(service.deps);
    push('followerSync.construct');
    const sync = real.createFollowerSync(service);
    return { ...sync, start: () => { push('followerSync.start'); return sync.start(); },
      stop: () => { push('followerSync.stop'); sync.stop(); } };
  } };
});
vi.mock('../../../src/social-graph/default-house-pinning.js', async (orig) => {
  const real = await orig<typeof import('../../../src/social-graph/default-house-pinning.js')>();
  const { push } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, startDefaultHousePinning: (...args: Parameters<typeof real.startDefaultHousePinning>) => {
    push('pinning.start');
    const loop = real.startDefaultHousePinning(...args);
    return { ...loop, stop: () => { push('pinning.stop'); loop.stop(); } };
  } };
});
vi.mock('../../../src/newspaper/follow-doorbell-service.js', async (orig) => {
  const real = await orig<typeof import('../../../src/newspaper/follow-doorbell-service.js')>();
  const { push } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, startFollowDoorbell: (...args: Parameters<typeof real.startFollowDoorbell>) => {
    push('doorbell.start');
    const loop = real.startFollowDoorbell(...args);
    return { ...loop, stop: () => { push('doorbell.stop'); loop.stop(); } };
  } };
});
vi.mock('../../../src/canvas/sync-answer-client.js', async (orig) => {
  const real = await orig<typeof import('../../../src/canvas/sync-answer-client.js')>();
  const { push } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, startPageStateSync: (...args: Parameters<typeof real.startPageStateSync>) => {
    push('pageState.start');
    const loop = real.startPageStateSync(...args);
    return { ...loop, stop: () => { push('pageState.stop'); loop.stop(); } };
  } };
});
vi.mock('../../../src/host/execution-store.js', async (orig) => {
  const real = await orig<typeof import('../../../src/host/execution-store.js')>();
  const { probe: p } = await import('../../helpers/root-assembly-probe.js');
  // Same class, one line added: remember the instance so an aborted cleanup can close it.
  class ExecutionStoreCatalog extends real.ExecutionStoreCatalog {
    constructor(...args: ConstructorParameters<typeof real.ExecutionStoreCatalog>) { super(...args); p.executionStores.push(this); }
  }
  return { ...real, ExecutionStoreCatalog };
});
vi.mock('../../../src/notifier/owner-turn-context.js', async (orig) => {
  const real = await orig<typeof import('../../../src/notifier/owner-turn-context.js')>();
  const { probe: p } = await import('../../helpers/root-assembly-probe.js');
  // The L2 delivery leg receives the hook's four L2 slots as read at call time.
  return { ...real, deliverOwnerTurnL2: (deps: Parameters<typeof real.deliverOwnerTurnL2>[0]) => {
    p.l2Reads.push({ notifier: deps.l2Notifier !== undefined, nameOf: deps.l2NameOf !== undefined,
      proposals: deps.l2Proposals !== undefined, pendingFollows: deps.pendingFollowsForHook !== undefined });
    return real.deliverOwnerTurnL2(deps);
  } };
});
vi.mock('../../../src/social-graph/followers-sync.js', async (orig) => {
  const real = await orig<typeof import('../../../src/social-graph/followers-sync.js')>();
  const { probe: p } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, announceVerifiedFollowers: (...args: Parameters<typeof real.announceVerifiedFollowers>) => {
    p.announceDeps.push(args[0]);
    return real.announceVerifiedFollowers(...args);
  } };
});
vi.mock('../../../src/pings/reply-pings.js', async (orig) => {
  const real = await orig<typeof import('../../../src/pings/reply-pings.js')>();
  const { probe: p } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, routeReplyPing: (...args: Parameters<typeof real.routeReplyPing>) => {
    p.replyPingDeps.push(args[0] as unknown as Record<string, unknown>);
    return real.routeReplyPing(...args);
  } };
});
vi.mock('../../../src/runtime/dm-notification-policy.js', async (orig) => {
  const real = await orig<typeof import('../../../src/runtime/dm-notification-policy.js')>();
  const { recorded } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, makeDmNotificationPolicy: (...args: Parameters<typeof real.makeDmNotificationPolicy>) => {
    return recorded(real.makeDmNotificationPolicy(...args), 'recover', 'dm.recover');
  } };
});
vi.mock('../../../src/host/openclaw-owner-approval.js', async (orig) => {
  const real = await orig<typeof import('../../../src/host/openclaw-owner-approval.js')>();
  const { recorded } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, createWorldOwnerApproval: (...args: Parameters<typeof real.createWorldOwnerApproval>) =>
    recorded(real.createWorldOwnerApproval(...args), 'stop', 'worldOwnerApproval.stop') };
});
vi.mock('../../../src/host/openclaw-world-execution.js', async (orig) => {
  const real = await orig<typeof import('../../../src/host/openclaw-world-execution.js')>();
  const { recorded } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, createOpenClawWorldExecution: (...args: Parameters<typeof real.createOpenClawWorldExecution>) =>
    recorded(real.createOpenClawWorldExecution(...args), 'stop', 'native.stop') };
});

import plugin from '../../../src/index.js';

type Service = { id: string; start(ctx?: unknown): Promise<void>; stop?(ctx?: unknown): unknown };
type Hook = (event?: unknown, ctx?: unknown) => unknown;
type GatewayBag = Record<string, unknown> & {
  shutdown(): Promise<void>;
  pendingInvites: PendingInvitesStore;
  inviteWatch: InviteWatchDeps;
  bondsStore: BondsStore;
  boot: { popclawId: string };
};

const HOUSE = 'http://127.0.0.1:59999';
const HOUSE_SLUG = '127-0-0-1-59999';
const OWNER_TURN = { trigger: 'user', sessionKey: 'agent:main:main' };
/** Where getOrCreatePerProcess parks the runtime memo (src/runtime/once.ts). */
const MEMO_KEY = '__popclaw_singleton__runtime';

let restorePrototypes: () => void = () => {};
beforeAll(() => {
  restorePrototypes = patchPrototypes([
    { proto: HouseRuntime.prototype, name: 'start', label: 'houses.start' },
    { proto: HouseRuntime.prototype, name: 'stop', label: 'houses.stop',
      failWhen: () => probe.failHousesStop, holdWhen: () => probe.holdHousesStop },
    { proto: WorldRuntime.prototype, name: 'stop', label: 'worlds.stop', failWhen: () => probe.failWorldsStop },
    { proto: WorldRuntime.prototype, name: 'whenIdle', label: 'worlds.whenIdle' },
    { proto: ExecutionStoreCatalog.prototype, name: 'close', label: 'executionStores.close' },
  ]);
  const configure = HouseRuntime.prototype.configureResources;
  HouseRuntime.prototype.configureResources = function (this: HouseRuntime, config) {
    probe.resourceConfigs.push(config);
    push('houses.configure');
    return configure.call(this, config);
  };
  const unannounced = KnownFollowersStore.prototype.unannounced;
  KnownFollowersStore.prototype.unannounced = function (this: KnownFollowersStore, ...args) {
    probe.unannouncedReads += 1;
    return unannounced.apply(this, args);
  };
  const recordSocial = SocialLogWriter.prototype.record;
  SocialLogWriter.prototype.record = function (this: SocialLogWriter, entry) {
    probe.socialLog.push(entry as never);
    return recordSocial.call(this, entry);
  };
  const enqueue = SqliteNotifier.prototype.enqueue;
  SqliteNotifier.prototype.enqueue = function (this: SqliteNotifier, args) {
    probe.enqueued.push(args as never);
    return enqueue.call(this, args);
  };
  const restoreFirst = restorePrototypes;
  restorePrototypes = () => {
    restoreFirst();
    HouseRuntime.prototype.configureResources = configure;
    SqliteNotifier.prototype.enqueue = enqueue;
    KnownFollowersStore.prototype.unannounced = unannounced;
    SocialLogWriter.prototype.record = recordSocial;
  };
});
afterAll(() => restorePrototypes());

const roots: string[] = [];
afterEach(() => {
  clearPerProcess('runtime');
  NewspaperDispatchRegistry.clear();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  probe.reset();
  vi.unstubAllGlobals();
});

function newState(): string {
  const state = mkdtempSync(join(tmpdir(), 'popclaw-assembly-gw-'));
  roots.push(state);
  mkdirSync(join(state, 'popclaw', 'config'), { recursive: true });
  // Canvas pinned too: the doorbell and page-state loops would otherwise pick
  // POPCLAW_CANVAS_BASE_URL or the public default.
  writeFileSync(join(state, 'popclaw', 'config', 'plugin.json'), JSON.stringify({ lore_houses: [HOUSE], canvas_base_url: HOUSE }));
  return state;
}

function registerAt(state: string) {
  const services: Service[] = [];
  const hooks = new Map<string, Hook>();
  const logs: string[] = [];
  const log = (message: unknown) => { logs.push(String(message)); };
  const api = {
    registrationMode: 'full', config: {}, pluginConfig: {},
    logger: { debug: log, info: log, warn: log, error: log },
    runtime: {
      state: { resolveStateDir: () => state },
      system: { enqueueSystemEvent: vi.fn(), runHeartbeatOnce: vi.fn() },
    },
    registerCommand: vi.fn(), registerTool: vi.fn(), registerInteractiveHandler: vi.fn(),
    registerService: (service: Service) => services.push(service),
    on: (name: string, hook: Hook) => hooks.set(name, hook),
  };
  plugin.register!(api as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  const svc = (id: string) => services.find(s => s.id === id)!;
  return {
    hooks, logs, service: svc,
    start: () => svc('popclaw-runtime').start(),
    stop: () => hooks.get('gateway_stop')!() as Promise<void>,
  };
}

const offline = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK'); }));

async function boot() {
  offline();
  const root = registerAt(newState());
  await root.start();
  const bag = await getOrCreatePerProcess<Promise<GatewayBag>>('runtime', () => {
    throw new Error('the popclaw-runtime service should have memoized the runtime');
  });
  return { root, bag };
}

const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

/**
 * Hand back everything a root left open when its own shutdown or cleanup was
 * aborted: approvals, relation reception (its drain timer), houses, worlds,
 * house-store DBs, execution stores, the host DB. `root.stop()` cannot do it
 * again: the lazy runtime memoizes its rejected stop.
 */
async function rescue(bag?: GatewayBag): Promise<void> {
  probe.failWorldsStop = false;
  probe.failHousesStop = false;
  resetOwnerApprovals();
  probe.receptionStops.splice(0).forEach(stop => stop());
  if (bag) {
    await (bag['houseRuntime'] as HouseRuntime).stop();
    await (bag['worldRuntime'] as WorldRuntime).whenIdle();
  }
  probe.storeDbs.splice(0).forEach(db => db.close());
  probe.executionStores.splice(0).forEach(stores => stores.close());
  probe.hostDbs.splice(0).forEach(db => db.close());
}

/** One owner turn through the real prompt-build hook; what it handed the L2 leg. */
function ownerTurn(root: ReturnType<typeof registerAt>): L2SlotRead | 'hook did not reach the L2 leg' {
  const before = probe.l2Reads.length;
  root.hooks.get('before_prompt_build')!({ prompt: 'hi' }, OWNER_TURN);
  return probe.l2Reads[before] ?? 'hook did not reach the L2 leg';
}
const ALL_SLOTS: L2SlotRead = { notifier: true, nameOf: true, proposals: true, pendingFollows: true };
const NO_SLOTS: L2SlotRead = { notifier: false, nameOf: false, proposals: false, pendingFollows: false };

describe('gateway root — runtime bag shape', () => {
  it('resolves runtime() to exactly this key set', async () => {
    const { root, bag } = await boot();
    const keys = Object.keys(bag).sort();
    await root.stop();
    expect(keys).toEqual([
      'bondsStore', 'boot', 'cadenceLoader', 'drainNotifications', 'egress', 'followerSync', 'guideClient',
      'host', 'houseRuntime', 'houseStarted', 'houses', 'inboxStore', 'initiator', 'inviteWatch', 'knownFollowers',
      'llmComplete', 'markService', 'marksStore', 'nameOf', 'nativeWorldExecution', 'notifier', 'notifyBacklog',
      'onboardingState', 'orchestrator', 'ownerNotifier', 'ownerNotifyTargetStore', 'ownerSession', 'paths',
      'pendingFollows', 'pendingInvites', 'proposalsStore', 'replyPings', 'retryDmNotifications', 'scoreCache',
      'shutdown', 'socialGraph', 'socialLog', 'summaryClient', 'tasteLoader', 'uploadCanvas', 'worldFeedCache',
      'worldFeedClient', 'worldOwnerApproval', 'worldRuntime',
    ]);
  }, 30_000);
});

describe('gateway root — boot order', () => {
  it('relation reception is open before resources are configured and before houses start', async () => {
    const { root } = await boot();
    const order = probe.events.filter(e => ['reception.open', 'houses.configure', 'houses.start'].includes(e));
    await root.stop();
    expect(order).toEqual(['reception.open', 'houses.configure', 'houses.start']);
  }, 30_000);
});

describe("gateway root — shutdown sequence ('guarded')", () => {
  it('stops worlds, relation reception and houses before closing any database, then releases storage and closes the host DB', async () => {
    const { root } = await boot();
    probe.events.length = 0;
    await root.stop();
    expect(probe.events).toEqual([
      'worldOwnerApproval.stop', 'native.stop', 'worlds.stop',
      'reception.stop',
      'houses.stop', 'worlds.whenIdle',
      `storeDb.close:${HOUSE_SLUG}`,
      'executionStores.close',
      'release',
      'hostDb.close',
    ]);
    expect(root.logs.filter(l => l.includes('shutdown complete'))).toHaveLength(1);
  }, 30_000);

  it('a failing step is caught and later steps still run, but storage is NOT released', async () => {
    const { root } = await boot();
    probe.events.length = 0;
    probe.failHousesStop = true;
    await root.stop();
    expect({
      events: probe.events,
      failure: root.logs.filter(l => l.includes('shutdown house lifecycle failed')).length,
      completed: root.logs.filter(l => l.includes('shutdown complete')).length,
    }).toEqual({
      events: [
        'worldOwnerApproval.stop', 'native.stop', 'worlds.stop',
        'reception.stop',
        'houses.stop', 'worlds.whenIdle',
        `storeDb.close:${HOUSE_SLUG}`,
        'executionStores.close',
        // no 'release': a step failed
        'hostDb.close',
      ],
      failure: 1,
      completed: 1,
    });
  }, 30_000);

  it('a throw in a BARE step (worlds.stop) propagates: gateway_stop rejects and nothing after it runs', async () => {
    const { root, bag } = await boot();
    probe.events.length = 0;
    probe.failWorldsStop = true;
    const error = await root.stop().then(() => undefined, (e: unknown) => e);
    const events = [...probe.events];
    const memo = MEMO_KEY in globalThis;
    const completed = root.logs.filter(l => l.includes('shutdown complete')).length;
    // Relation reception was left running by the aborted shutdown: its drain
    // tick has been reading the host DB.
    const drainReadsWhileLeftRunning = probe.unannouncedReads;
    await rescue(bag);
    // Past a drain tick (2 s): nothing the aborted shutdown left behind still
    // runs. A surviving tick would read the closed host DB, which the worker
    // reports as an uncaught "database connection is not open".
    const readsAfterRescue = probe.unannouncedReads;
    await sleep(2_600);
    expect({
      message: (error as Error).message,
      events,
      memo,
      completed,
      drainWasRunning: drainReadsWhileLeftRunning > 0,
      drainReadsAfterRescue: probe.unannouncedReads - readsAfterRescue,
    }).toEqual({
      message: 'C0_worlds.stop_FAILED',
      events: ['worldOwnerApproval.stop', 'native.stop', 'worlds.stop'],
      memo: true,
      completed: 0,
      drainWasRunning: true,
      drainReadsAfterRescue: 0,
    });
  }, 30_000);

  it('clears the runtime memo on shutdown', async () => {
    const { root } = await boot();
    await root.stop();
    const after = getOrCreatePerProcess('runtime', () => 'absent');
    expect(after).toBe('absent');
  }, 30_000);
});

describe('gateway root — failed-boot cleanup (row 29)', () => {
  // The four L2 slots are read by the prompt-build hook on an owner turn; the
  // owner-turn-context mock records, per slot, whether the hook handed the L2
  // leg a value. (Mid-boot no house scope is active, so no notice could be
  // SHOWN; whether each slot is filled is the observable.)
  it('after the L2 slots are exposed: clears all four slots and the memo BEFORE the drain awaits; nothing is closed while the drain is held; then reverse close, release, host DB, rethrow', async () => {
    offline();
    const root = registerAt(newState());
    const drainHeld = barrier();
    let beforeFailure: { slots: unknown; memo: boolean } | undefined;
    let atDrainEntry: { slots: unknown; memo: boolean } | undefined;
    probe.failReception = true;
    probe.beforeFail = () => {
      beforeFailure = { slots: ownerTurn(root), memo: MEMO_KEY in globalThis };
      probe.holdHousesStop = drainHeld;
      // The drain's FIRST synchronous call, read at the recorder's entry —
      // before the real worldOwnerApproval.stop runs.
      probe.onEvent = (label) => {
        if (label === 'worldOwnerApproval.stop' && !atDrainEntry) atDrainEntry = { slots: ownerTurn(root), memo: MEMO_KEY in globalThis };
      };
    };
    const failing = root.start().then(() => undefined, (e: unknown) => e);
    // The drain's first await (houses.stop) is reached and held.
    await drainHeld.reached;
    const cleanupSoFar = probe.events.slice(probe.events.indexOf('boot.fail') + 1);
    const whileDrainHeld = { slots: ownerTurn(root), memo: MEMO_KEY in globalThis, cleanupSoFar };
    drainHeld.release();
    const error = await failing;
    expect({
      message: (error as Error).message,
      beforeFailure,
      atDrainEntry,
      whileDrainHeld,
      cleanup: probe.events.slice(probe.events.indexOf('boot.fail') + 1),
      memoAfter: MEMO_KEY in globalThis,
      hookFailures: root.logs.filter(l => l.includes('routing hook failed')),
    }).toEqual({
      message: FORCED_BOOT_FAILURE,
      // Control: while the boot was alive every slot was filled and the memo parked.
      beforeFailure: { slots: ALL_SLOTS, memo: true },
      // At the drain's first synchronous stop: the slots and the memo were
      // already cleared, synchronously, before the drain began.
      atDrainEntry: { slots: NO_SLOTS, memo: false },
      // Held on the drain's first await: all four slots and the memo are
      // already gone, and no database has been closed yet.
      whileDrainHeld: {
        slots: NO_SLOTS,
        memo: false,
        cleanupSoFar: ['worldOwnerApproval.stop', 'native.stop', 'worlds.stop', 'houses.stop'],
      },
      cleanup: [
        'worldOwnerApproval.stop', 'native.stop', 'worlds.stop', 'houses.stop', 'worlds.whenIdle',
        `storeDb.close:${HOUSE_SLUG}`,
        'executionStores.close',
        'release',
        'hostDb.close',
      ],
      memoAfter: false,
      hookFailures: [],
    });
  }, 30_000);

  it('a cleanup that itself fails: rejects with STORAGE_BOOT_CLEANUP_FAILED carrying both errors; nothing is closed, storage is NOT released, the host DB stays open; slots and memo are still cleared', async () => {
    offline();
    const root = registerAt(newState());
    probe.failReception = true;
    probe.beforeFail = () => { probe.failHousesStop = true; };
    const error = await root.start().then(() => undefined, (e: unknown) => e);
    const cleanup = probe.events.slice(probe.events.indexOf('boot.fail') + 1);
    const after = { slots: ownerTurn(root), memo: MEMO_KEY in globalThis };
    await rescue();
    expect({
      aggregate: error instanceof AggregateError,
      message: (error as Error).message,
      errors: ((error as AggregateError).errors ?? []).map((e: Error) => e.message),
      cleanup,
      after,
    }).toEqual({
      aggregate: true,
      message: 'STORAGE_BOOT_CLEANUP_FAILED',
      errors: [FORCED_BOOT_FAILURE, 'C0_houses.stop_FAILED'],
      // The drain stopped at the failing await: no whenIdle, no close, no release.
      cleanup: ['worldOwnerApproval.stop', 'native.stop', 'worlds.stop', 'houses.stop'],
      after: { slots: NO_SLOTS, memo: false },
    });
  }, 30_000);
});

describe('gateway root — drift rows pinned as current behaviour', () => {
  it('#16 follower-sync deps carry displayName and bondContext; poll and relation reception share one deps object; a real follower is announced with the bond line and logged under the bond-book name', async () => {
    const { root, bag } = await boot();
    const deps = probe.followerSyncDeps[0]!;
    const follower = 'c0-follower-alice';
    bag.bondsStore.setTier(follower, 'friend', 'manual');
    bag.bondsStore.setNickname(follower, 'Alice C0');
    // The same line the root's own bondContext must produce from this bond row.
    const expectedBondLine = makeBondContext({ bond: id => bag.bondsStore.get(id) })(follower);
    await probe.receptionDeps[0]!.notifyNewFollowers!([{ houseSlug: HOUSE_SLUG, followerId: follower }] as never);
    const announced = probe.announceDeps[0];
    const queued = probe.enqueued.filter(r => r.kind === 'followed_you').map(r => r.payload);
    const logged = probe.socialLog.filter(e => e.kind === 'followed_you').map(e => e.actor);
    await root.stop();
    expect({
      keys: Object.keys(deps).sort(),
      sameObject: announced === deps,
      expectedBondLineIsNonEmpty: expectedBondLine.length > 0,
      queued,
      logged,
    }).toEqual({
      keys: ['bondContext', 'bondOf', 'displayName', 'fetch', 'logger', 'notifier', 'ownerPopclawId',
        'readAuthorityFor', 'socialGraph', 'socialLog', 'store', 'verifiedFollowers'],
      sameObject: true,
      expectedBondLineIsNonEmpty: true,
      // bondContext consumed: the queued notice carries the bond line.
      queued: [{ followerPopclawId: follower, houseSlug: HOUSE_SLUG, bondLine: expectedBondLine }],
      // displayName consumed: the social log names the follower from the bond book.
      logged: [{ id: follower, name: 'Alice C0' }],
    });
  }, 30_000);

  it('#17 reply-ping routing is handed a bondContext: a reply to my post is queued with the replier\'s bond line', async () => {
    const { root, bag } = await boot();
    const config = probe.resourceConfigs[0]!;
    const me = bag.boot.popclawId;
    const replier = 'c0-replier-bob';
    bag.bondsStore.setTier(replier, 'friend', 'manual');
    const expectedBondLine = makeBondContext({ bond: id => bag.bondsStore.get(id) })(replier);
    // A controlled feed: the house cache knows one post, mine.
    const house = { slug: HOUSE_SLUG, baseUrl: HOUSE, cache: {
      lookup: (platform: string, id: string) => (platform === 'popclaw' && id === 'c0-my-post'
        ? { authorPopclawId: me, eventId: 'c0-my-post-event', textPreview: 'my post' } : null),
    } } as unknown as HouseStore;
    // Old enough to be past the freshness window: an L2, and no first-reply owner ping.
    config.onContent!(house, { eventId: 'c0-reply-1', authorPopclawId: replier, actorNickname: 'Bob',
      textPreview: 'nice', replyToPostId: 'c0-my-post', platformPostCreatedAt: 1_000 } as never);
    const queued = probe.enqueued.filter(r => r.kind === 'reply').map(r => ({ level: r.level, ...r.payload }));
    await root.stop();
    expect({
      keys: Object.keys(probe.replyPingDeps[0]!).sort(),
      expectedBondLineIsNonEmpty: expectedBondLine.length > 0,
      queued,
    }).toEqual({
      keys: ['bondContext', 'cache', 'notifier', 'ownerPopclawId', 'pings', 'socialLog'],
      expectedBondLineIsNonEmpty: true,
      queued: [{
        level: 'L2', replyEventId: 'c0-reply-1', fromPopclawId: replier, fromName: 'Bob', body: 'nice',
        targetPostId: 'c0-my-post', targetPreview: 'my post', bondLine: expectedBondLine, houseOrigin: HOUSE,
      }],
    });
  }, 30_000);

  it('#18 invite outcomes are enqueued attributed to the lore-house origin', async () => {
    const { root, bag } = await boot();
    bag.pendingInvites.add({ taskId: 'task-ok', platform: 'x', handle: 'alice' });
    bag.pendingInvites.add({ taskId: 'task-no', platform: 'x', handle: 'bob' });
    const answer = (body: object) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    await checkInviteOnce({ ...bag.inviteWatch, fetch: answer({ state: 'APPROVED', platform: 'x', handle: 'alice' }) }, 'task-ok');
    await checkInviteOnce({ ...bag.inviteWatch, fetch: answer({ state: 'REJECTED', reject_count: 2 }) }, 'task-no');
    await root.stop();
    const rows = probe.enqueued.filter(r => r.kind.startsWith('ranger_verify_'))
      .map(r => ({ kind: r.kind, houseOrigin: r.payload['houseOrigin'] }));
    expect(rows).toEqual([
      { kind: 'ranger_verify_done', houseOrigin: HOUSE },
      { kind: 'ranger_verify_fail', houseOrigin: HOUSE },
    ]);
  }, 30_000);

  it('#24 handshake refresh interval is 6 h', async () => {
    const { root } = await boot();
    const refreshMs = probe.resourceConfigs[0]!.refreshMs;
    await root.stop();
    expect(refreshMs).toBe(6 * 60 * 60 * 1000);
  }, 30_000);

  it('#7 closing fired before the builder\'s first microtask: houses are not started, but DM recovery is still scheduled', async () => {
    // start() then stop() in the same tick: the lazy runtime aborts before its
    // builder has run at all (createLazyRuntime defers build to a microtask).
    offline();
    const root = registerAt(newState());
    const booting = root.start();
    const stopping = root.stop();
    await booting.catch(() => undefined);
    await stopping;
    const booted = probe.events.slice(0, probe.events.indexOf('worldOwnerApproval.stop'));
    expect({
      configured: probe.resourceConfigs.length,
      housesStarted: booted.includes('houses.start'),
      recoveryScheduled: probe.events.includes('dm.recover'),
    }).toEqual({ configured: 1, housesStarted: false, recoveryScheduled: true });
  }, 30_000);

  it('#7 closing fired mid-boot (root held on its openRelationReception await): the build is not cancelled, houses are not started, DM recovery is still scheduled, then the normal shutdown runs', async () => {
    offline();
    const root = registerAt(newState());
    const held = barrier();
    probe.holdReception = held;
    const booting = root.start().then(() => 'booted', (e: unknown) => (e as Error).message);
    await held.reached;
    const stopping = root.stop();
    held.release();
    await stopping;
    const boot = await booting;
    const booted = probe.events.slice(0, probe.events.indexOf('worldOwnerApproval.stop'));
    expect({
      boot,
      heldBeforeConfigure: booted.indexOf('reception.held') < booted.indexOf('houses.configure'),
      booted: booted.filter(e => ['reception.open', 'houses.configure', 'houses.start', 'dm.recover'].includes(e)),
      shutdown: probe.events.slice(probe.events.indexOf('worldOwnerApproval.stop')),
    }).toEqual({
      boot: 'booted',
      heldBeforeConfigure: true,
      booted: ['reception.open', 'houses.configure', 'dm.recover'],
      shutdown: [
        'worldOwnerApproval.stop', 'native.stop', 'worlds.stop', 'reception.stop', 'houses.stop', 'worlds.whenIdle',
        `storeDb.close:${HOUSE_SLUG}`, 'executionStores.close', 'release', 'hostDb.close',
      ],
    });
  }, 30_000);
});

describe('gateway root — resident services (ruling §3.4)', () => {
  const RESIDENT = ['popclaw-follower-sync', 'popclaw-default-house-pinning', 'popclaw-follow-doorbell', 'popclaw-page-state-sync'];
  const LEGS = /^(followerSync|pinning|doorbell|pageState)\./;

  it('follower sync is constructed by the boot and started by its service; pinning, doorbell and page-state are constructed and started by their services; each service.stop stops its own leg and gateway_stop stops none', async () => {
    const { root } = await boot();
    const atBoot = probe.events.filter(e => LEGS.test(e));
    const constructedBeforeHousesStart = probe.events.indexOf('followerSync.construct') < probe.events.indexOf('houses.start');
    const started: string[][] = [];
    for (const id of RESIDENT) {
      const from = probe.events.length;
      await root.service(id).start();
      started.push(probe.events.slice(from).filter(e => LEGS.test(e)));
    }
    const stopped: string[][] = [];
    for (const id of RESIDENT) {
      const from = probe.events.length;
      await root.service(id).stop?.();
      stopped.push(probe.events.slice(from).filter(e => LEGS.test(e)));
    }
    const from = probe.events.length;
    await root.stop();
    expect({
      atBoot, constructedBeforeHousesStart, started, stopped,
      byGatewayStop: probe.events.slice(from).filter(e => LEGS.test(e)),
    }).toEqual({
      atBoot: ['followerSync.construct'],
      constructedBeforeHousesStart: true,
      started: [['followerSync.start'], ['pinning.start'], ['doorbell.start'], ['pageState.start']],
      stopped: [['followerSync.stop'], ['pinning.stop'], ['doorbell.stop'], ['pageState.stop']],
      byGatewayStop: [],
    });
  }, 30_000);

  // C4: replaces resident-services' AST row for 'gateway'. Every service the
  // table gives the gateway a starter for starts exactly that starter's leg;
  // the boot itself starts none (the test above: atBoot is construct only).
  it('each gateway service with a starter in RESIDENT_SERVICES starts exactly that starter, as the table says', async () => {
    const label: Record<string, string> = {
      startDefaultHousePinning: 'pinning.start', createFollowerSync: 'followerSync.start',
      startFollowDoorbell: 'doorbell.start', startPageStateSync: 'pageState.start',
    };
    expect(ALL_STARTERS.map(s => label[s.export])).not.toContain(undefined);
    const rows = RESIDENT_SERVICES.filter(s => s.roots.gateway === true && s.starter !== null);
    expect(rows.length).toBeGreaterThan(0);
    const { root } = await boot();
    const starts = new Set(Object.values(label));
    const started: Record<string, string[]> = {};
    const expected: Record<string, string[]> = {};
    for (const row of rows) {
      const from = probe.events.length;
      await root.service(row.id).start();
      started[row.id] = probe.events.slice(from).filter(e => starts.has(e));
      expected[row.id] = [label[row.starter!.export]!];
    }
    expect(started).toEqual(expected);
    for (const row of rows) await root.service(row.id).stop?.();
    await root.stop();
  }, 30_000);
});
