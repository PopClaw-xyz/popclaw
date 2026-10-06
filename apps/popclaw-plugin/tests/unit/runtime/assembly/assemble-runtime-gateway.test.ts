import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPerProcess, getOrCreatePerProcess } from '../../../../src/runtime/once.js';
import { NewspaperDispatchRegistry } from '../../../../src/newspaper/dedicated-session.js';
import { HouseRuntime } from '../../../../src/runtime/house-lifecycle/house-runtime.js';
import { WorldRuntime } from '../../../../src/runtime/world-runtime.js';
import { ExecutionStoreCatalog } from '../../../../src/host/execution-store.js';
import { PopclawPaths } from '../../../../src/host/popclaw-paths.js';
import { createOpenClawHostAdapter } from '../../../../src/host/openclaw-host-adapter.js';
import { assertStorageBootstrap, registerStorageRuntime } from '../../../../src/host/storage-maintenance.js';
import { resetOwnerApprovals } from '../../../../src/host/owner-approval.js';
import { assembleRuntime } from '../../../../src/runtime/assembly/index.js';
import { GATEWAY_DRIFT_PINS, gatewayRuntimePorts, type GatewayRuntimePorts } from '../../../../src/host/openclaw-runtime-ports.js';
import type { HouseStore } from '../../../../src/ingress/world-feed-store.js';
import { barrier, patchPrototypes, probe } from '../../../helpers/root-assembly-probe.js';
import { deliverDmTwice, ownerNameAfterRename, type ProbedBag } from '../../../helpers/assembled-bag-probes.js';

/**
 * The gateway root's runtime assembly, driven through the PRODUCTION path:
 * the real `plugin.register` with a fake OpenClaw api → the `popclaw-runtime`
 * service → `bootRuntime` (src/index.ts) → the real `gatewayRuntimePorts`
 * (src/host/openclaw-runtime-ports.ts) → the shared `assembleRuntime`,
 * offline, on a temp state dir. The refusal cases build the same host the
 * root builds (createOpenClawHostAdapter) and vary one port.
 *
 * These pin what the C0 gateway characterization (root-assembly-gateway) and
 * the order pins (root-order-gateway) do not: the ports' own values, that
 * each L2 slot is handed the bag's own instance (the notifier as a per-turn
 * thunk), the push leg's three shared callers (first reply, DM onQueued,
 * invitation outcome), the one owner-target store, the follower poll built
 * for the host's service and reading the catalog's houses, and the guarded
 * shutdown's host steps and memo (ruling 2026-09-29 14:14 ②: a direct second
 * call returns at once, a rejected first call is not retried, the owner
 * approval reset sits between the bare world stop and reception's stop, and
 * a backup in flight is waited out before the execution stores close while
 * no new backup starts).
 *
 * Pass-through recorders only, except: `runDailyBackup` (a held promise, so a
 * backup is in flight on demand) and the probe's injected faults / holds
 * (tests/helpers/root-assembly-probe.ts header). These are controlled-order
 * characterizations, not reproductions of a natural host schedule.
 */

const HOUSE = 'http://127.0.0.1:59998';
const HOUSE_SLUG = '127-0-0-1-59998';
const OWNER_TURN = { trigger: 'user', sessionKey: 'agent:main:main' };

const captured = vi.hoisted(() => ({
  dmDeps: [] as Array<{ onQueued?: () => void }>,
  followerSyncInputs: [] as Array<{ houses: () => Array<{ slug: string; baseUrl: string }> }>,
  targetStores: [] as object[],
  l2: [] as Array<{ l2Notifier?: unknown; l2NameOf?: unknown; l2Proposals?: unknown; pendingFollowsForHook?: unknown }>,
  backups: [] as Array<() => void>,
  catalogs: [] as Array<{ close(): void }>,
  receptions: [] as Array<{ stop(): void }>,
  /** Relation reception's slug→origin lookup, as handed to announceVerifiedFollowers. */
  houseLookups: [] as Array<((slug: string) => string | undefined) | undefined>,
}));

vi.mock('../../../../src/social-graph/relation-reception.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/social-graph/relation-reception.js')>();
  const { probe: p, push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, openRelationReception: async (deps: Parameters<typeof real.openRelationReception>[0]) => {
    p.receptionDeps.push(deps as never);
    const reception = await real.openRelationReception(deps);
    captured.receptions.push(reception);
    push('reception.open');
    return { ...reception, stop: () => { push('reception.stop'); reception.stop(); } };
  } };
});
vi.mock('../../../../src/host/storage-maintenance.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/host/storage-maintenance.js')>();
  const { probeHostDb } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, registerStorageRuntime: (...args: Parameters<typeof real.registerStorageRuntime>) =>
    probeHostDb(args[0], real.registerStorageRuntime(...args)) };
});
vi.mock('../../../../src/host/execution-store.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/host/execution-store.js')>();
  class ExecutionStoreCatalog extends real.ExecutionStoreCatalog {
    constructor(...args: ConstructorParameters<typeof real.ExecutionStoreCatalog>) { super(...args); captured.catalogs.push(this); }
  }
  return { ...real, ExecutionStoreCatalog };
});
vi.mock('../../../../src/ingress/world-feed-store.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/ingress/world-feed-store.js')>();
  const { probe: p, record } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, openHouseStores: async (...args: Parameters<typeof real.openHouseStores>) => {
    const stores = await real.openHouseStores(...args);
    for (const store of stores) { p.storeDbs.push(store.db); record(store.db, 'close', `storeDb.close:${store.slug}`); }
    return stores;
  } };
});
vi.mock('../../../../src/host/openclaw-owner-approval.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/host/openclaw-owner-approval.js')>();
  const { recorded } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, createWorldOwnerApproval: (...args: Parameters<typeof real.createWorldOwnerApproval>) =>
    recorded(real.createWorldOwnerApproval(...args), 'stop', 'worldOwnerApproval.stop') };
});
vi.mock('../../../../src/host/openclaw-world-execution.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/host/openclaw-world-execution.js')>();
  const { recorded } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, createOpenClawWorldExecution: (...args: Parameters<typeof real.createOpenClawWorldExecution>) =>
    recorded(real.createOpenClawWorldExecution(...args), 'stop', 'native.stop') };
});
vi.mock('../../../../src/host/owner-approval.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/host/owner-approval.js')>();
  const { push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, resetOwnerApprovals: () => { push('resetOwnerApprovals'); real.resetOwnerApprovals(); } };
});
vi.mock('../../../../src/host/daily-backup.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/host/daily-backup.js')>();
  const { push } = await import('../../../helpers/root-assembly-probe.js');
  // A backup in flight until the test releases it.
  return { ...real, runDailyBackup: () => {
    push('backup.run');
    return new Promise<void>(done => captured.backups.push(() => { push('backup.done'); done(); }));
  } };
});
vi.mock('../../../../src/notifier/owner-notifier.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/notifier/owner-notifier.js')>();
  const { push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, notifyOwnerNow: (...args: Parameters<typeof real.notifyOwnerNow>) => {
    push('notifyOwnerNow');
    return real.notifyOwnerNow(...args);
  } };
});
vi.mock('../../../../src/notifier/owner-notify-target.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/notifier/owner-notify-target.js')>();
  class OwnerNotifyTargetStore extends real.OwnerNotifyTargetStore {
    constructor(...args: ConstructorParameters<typeof real.OwnerNotifyTargetStore>) { super(...args); captured.targetStores.push(this); }
  }
  return { ...real, OwnerNotifyTargetStore };
});
vi.mock('../../../../src/runtime/dm-notification-policy.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/runtime/dm-notification-policy.js')>();
  return { ...real, makeDmNotificationPolicy: (...args: Parameters<typeof real.makeDmNotificationPolicy>) => {
    captured.dmDeps.push(args[0] as never);
    return real.makeDmNotificationPolicy(...args);
  } };
});
vi.mock('../../../../src/social-graph/follower-sync-service.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/social-graph/follower-sync-service.js')>();
  const { push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, createFollowerSync: (service: Parameters<typeof real.createFollowerSync>[0]) => {
    captured.followerSyncInputs.push(service as never);
    push('followerSync.construct');
    const sync = real.createFollowerSync(service);
    return { ...sync, start: () => { push('followerSync.start'); return sync.start(); } };
  } };
});
vi.mock('../../../../src/social-graph/followers-sync.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/social-graph/followers-sync.js')>();
  return { ...real, announceVerifiedFollowers: (...args: Parameters<typeof real.announceVerifiedFollowers>) => {
    captured.houseLookups.push(args[2]);
    return real.announceVerifiedFollowers(...args);
  } };
});
vi.mock('../../../../src/notifier/owner-turn-context.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/notifier/owner-turn-context.js')>();
  return { ...real, deliverOwnerTurnL2: (deps: Parameters<typeof real.deliverOwnerTurnL2>[0]) => {
    captured.l2.push(deps as never);
    return real.deliverOwnerTurnL2(deps);
  } };
});

import plugin from '../../../../src/index.js';

type Service = { id: string; start(ctx?: unknown): Promise<void>; stop?(ctx?: unknown): unknown };
type Hook = (event?: unknown, ctx?: unknown) => unknown;
type Bag = Record<string, unknown> & {
  shutdown(): Promise<void>;
  nameOf: unknown; proposalsStore: unknown; pendingFollows: unknown; ownerNotifyTargetStore: unknown;
  followerSync: unknown; worldFeedCache: { houses(): Array<{ slug: string; baseUrl: string }> };
  boot: { popclawId: string };
  inviteWatch: { notifyOwner(): void };
  retryDmNotifications(): Promise<void>;
  houseRuntime: HouseRuntime; worldRuntime: WorldRuntime;
};

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
    return configure.call(this, config);
  };
  const restore = restorePrototypes;
  restorePrototypes = () => { restore(); HouseRuntime.prototype.configureResources = configure; };
});
afterAll(() => restorePrototypes());

const roots: string[] = [];
const booted: Bag[] = [];
const intervals: Array<ReturnType<typeof setInterval>> = [];
afterEach(async () => {
  // Test-only rescue: whatever a test left in flight or open.
  captured.backups.splice(0).forEach(release => release());
  probe.failHousesStop = false;
  probe.failWorldsStop = false;
  probe.holdHousesStop = undefined;
  resetOwnerApprovals();
  captured.receptions.splice(0).forEach(r => r.stop());
  // A shutdown aborted on a bare step never stopped the houses: their command
  // bus would keep pumping against the DB closed below.
  for (const bag of booted.splice(0)) {
    await bag.houseRuntime.stop().catch(() => {});
    await bag.worldRuntime.whenIdle();
  }
  for (const db of probe.storeDbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  for (const c of captured.catalogs.splice(0)) { try { c.close(); } catch { /* closed */ } }
  for (const db of probe.hostDbs.splice(0)) { try { db.close(); } catch { /* closed */ } }
  intervals.splice(0).forEach(clearInterval);
  vi.restoreAllMocks();
  clearPerProcess('runtime');
  NewspaperDispatchRegistry.clear();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  probe.reset();
  Object.assign(captured, { dmDeps: [], followerSyncInputs: [], targetStores: [], l2: [], houseLookups: [] });
  vi.unstubAllGlobals();
});

function newState(): string {
  const state = mkdtempSync(join(tmpdir(), 'popclaw-assembly-c3-'));
  roots.push(state);
  mkdirSync(join(state, 'popclaw', 'config'), { recursive: true });
  writeFileSync(join(state, 'popclaw', 'config', 'plugin.json'), JSON.stringify({ lore_houses: [HOUSE], canvas_base_url: HOUSE }));
  return state;
}

function fakeApi(state: string, logs: string[], services: Service[], hooks: Map<string, Hook>, onLog?: (line: string) => void) {
  const log = (message: unknown) => { logs.push(String(message)); onLog?.(String(message)); };
  return {
    registrationMode: 'full', config: { talk: { speechLocale: 'en-US' } }, pluginConfig: {},
    logger: { debug: log, info: log, warn: log, error: log },
    runtime: {
      state: { resolveStateDir: () => state },
      system: { enqueueSystemEvent: vi.fn(), runHeartbeatOnce: vi.fn() },
    },
    registerCommand: vi.fn(), registerTool: vi.fn(), registerInteractiveHandler: vi.fn(),
    registerService: (service: Service) => services.push(service),
    on: (name: string, hook: Hook) => hooks.set(name, hook),
  };
}

/** The production root: register, start its runtime service, read the memoized bag. */
async function boot(onLog?: (line: string, hooks: Map<string, Hook>) => void) {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK'); }));
  const state = newState();
  const services: Service[] = [];
  const hooks = new Map<string, Hook>();
  const logs: string[] = [];
  plugin.register!(fakeApi(state, logs, services, hooks, onLog && (line => onLog(line, hooks))) as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  const service = (id: string) => services.find(s => s.id === id)!;
  await service('popclaw-runtime').start();
  const bag = await getOrCreatePerProcess<Promise<Bag>>('runtime', () => { throw new Error('runtime not memoized'); });
  booted.push(bag);
  return { bag, logs, hooks, service, state };
}

/** The ports and host exactly as src/index.ts `bootRuntime` builds them, for tests that must vary one port. */
function gatewayRoot(events: string[]) {
  const state = newState();
  const logs: string[] = [];
  const api = fakeApi(state, logs, [], new Map()) as unknown as Parameters<typeof gatewayRuntimePorts>[0]['api'];
  const storagePaths = new PopclawPaths(PopclawPaths.resolveRoot(process.env, state));
  assertStorageBootstrap(storagePaths);
  let releaseStorage!: () => void;
  const host = createOpenClawHostAdapter(api, db => (releaseStorage = registerStorageRuntime(db, storagePaths)));
  const ports = gatewayRuntimePorts({ api, host, build: 'c3-test', storagePaths, releaseStorage: () => releaseStorage(),
    llmComplete: async () => '', favoritesFile: paths => join(paths.data(), 'favorites.jsonl'),
    root: {
      l2: { notifier: () => {}, nameOf: () => {}, pendingFollows: () => {}, proposals: () => {}, clear: () => events.push('l2.clear') },
      markStorageShuttingDown: () => {}, snapshotStorageBackups: () => [],
    } });
  return { host, ports };
}

const ownerTurn = (hooks: Map<string, Hook>) => { hooks.get('before_prompt_build')!({ prompt: 'hi' }, OWNER_TURN); return captured.l2.at(-1)!; };

describe('the gateway ports themselves', () => {
  it('select push delivery with a leg, host-service loops, the guarded host steps, and the gateway drift values', () => {
    const { ports } = gatewayRoot([]);
    expect(ports.delivery.kind).toBe('push');
    expect(ports.delivery.kind === 'push' && typeof ports.delivery.open).toBe('function');
    expect(ports.lifecycle.loops).toBe('host-services');
    expect(Object.keys(ports.lifecycle.guardedShutdown!).sort()).toEqual(['markStorageShuttingDown', 'resetOwnerApprovals', 'snapshotStorageBackups']);
    expect(Object.keys(ports.lifecycle).sort()).toEqual(['afterShutdown', 'announceInstall', 'beforeFailedBootCleanup',
      'checkIntegrity', 'expose', 'guardedShutdown', 'loops', 'migrateLegacyFiles', 'recordBootMarkers', 'reportScrapers']);
    expect(ports.drift).toBe(GATEWAY_DRIFT_PINS);
    expect(ports.drift).toEqual({
      followerDisplayNameAbsent: false, followerBondContextAbsent: false, followerStoreOwnInstance: false,
      replyPingBondContextAbsent: false, inviteNotifierUnattributed: false, rangerInviteNotifyAbsent: false,
      refreshMs: 6 * 60 * 60 * 1000, recoveryIgnoresClosing: true, ownerLangSignalsLate: false, shutdown: 'guarded',
      ownerCadenceBeforeSocialGraph: true, scoreCacheLoadedBeforeReception: true, followBackfillLate: true,
      worldStreamReadBeforeHouseStores: true, followerPollHousesFromCatalog: true, receptionHouseLookupFromCatalog: true,
    });
    // `worldStreamReadBeforeHouseStores` is pinned by value only: no test
    // observes the read point (the env does not change mid-boot here). The
    // read point is kept per ruling 2026-09-29 14:14 (G32), which asks for no
    // further evidence — this assertion is its only guard.
    expect(ports.ranger.decide()).toBe(true);
    expect(ports.platform.speechLocale?.()).toBe('en-US');
    // The bootReport / replyPing lanes exist only on this root.
    expect(typeof ports.log.bootReport).toBe('function');
    expect(typeof ports.log.replyPing).toBe('function');
    probe.hostDbs.length = 0; // the host DB was never opened here
  });
});

describe('the gateway bag, as the production root path builds it', () => {
  it('carries exactly the 44 keys the gateway root returned; the follower poll is built, not started; one owner-target store', async () => {
    const { bag } = await boot();
    expect(Object.keys(bag).sort()).toEqual([
      'bondsStore', 'boot', 'cadenceLoader', 'drainNotifications', 'egress', 'followerSync', 'guideClient',
      'host', 'houseRuntime', 'houseStarted', 'houses', 'inboxStore', 'initiator', 'inviteWatch', 'knownFollowers',
      'llmComplete', 'markService', 'marksStore', 'nameOf', 'nativeWorldExecution', 'notifier', 'notifyBacklog',
      'onboardingState', 'orchestrator', 'ownerNotifier', 'ownerNotifyTargetStore', 'ownerSession', 'paths',
      'pendingFollows', 'pendingInvites', 'proposalsStore', 'replyPings', 'retryDmNotifications', 'scoreCache',
      'shutdown', 'socialGraph', 'socialLog', 'summaryClient', 'tasteLoader', 'uploadCanvas', 'worldFeedCache',
      'worldFeedClient', 'worldOwnerApproval', 'worldRuntime',
    ]);
    expect(Object.keys(bag)).toHaveLength(44);
    expect(probe.events.filter(e => e.startsWith('followerSync.'))).toEqual(['followerSync.construct']);
    expect(bag.followerSync).toBeDefined();
    // G65: the push leg's target resolver and the bag share ONE store instance.
    expect(captured.targetStores).toHaveLength(1);
    expect(bag.ownerNotifyTargetStore).toBe(captured.targetStores[0]);
    await bag.shutdown();
  }, 30_000);

  it('the follower poll lists the catalog\'s houses (followerPollHousesFromCatalog), and reception maps slugs through the catalog (receptionHouseLookupFromCatalog)', async () => {
    const { bag } = await boot();
    // Make the two sources differ: a house mounted in the catalog only, not
    // in the house-store list (in a plain boot the two lists are equal, so
    // they could not tell the pins apart).
    const catalog = bag.worldFeedCache as unknown as { houses(): Array<Record<string, unknown>>; mount(feed: unknown): void };
    catalog.mount({ ...catalog.houses()[0], slug: 'c3-catalog-only', baseUrl: 'http://127.0.0.1:59997' });
    expect(captured.followerSyncInputs).toHaveLength(1);
    expect(captured.followerSyncInputs[0]!.houses()).toEqual([
      { slug: HOUSE_SLUG, baseUrl: HOUSE }, { slug: 'c3-catalog-only', baseUrl: 'http://127.0.0.1:59997' },
    ]);
    // Reception's announce leg hands its slug→origin lookup on; ask it.
    await probe.receptionDeps[0]!.notifyNewFollowers!([]);
    expect(captured.houseLookups).toHaveLength(1);
    const lookup = captured.houseLookups[0]!;
    expect([lookup('c3-catalog-only'), lookup(HOUSE_SLUG), lookup('nowhere')]).toEqual(['http://127.0.0.1:59997', HOUSE, undefined]);
    await bag.shutdown();
  }, 30_000);

  it('the name chain is handed out before the first host log call after the catalog (ruling 14:14 ①)', async () => {
    // The real prompt-build hook, fired from inside the first "cache
    // subscribed" log line: the host call that follows the catalog. A
    // controlled re-entry point, like the order pins' sync anchors.
    let seen: { notifier: boolean; nameOf: boolean } | undefined;
    const { bag } = await boot((line, hooks) => {
      if (seen || !line.includes('world-feed cache subscribed')) return;
      const deps = ownerTurn(hooks);
      seen = { notifier: deps.l2Notifier !== undefined, nameOf: deps.l2NameOf !== undefined };
    });
    expect(seen).toEqual({ notifier: true, nameOf: true });
    await bag.shutdown();
  }, 30_000);

  it('hands each L2 slot the bag\'s own instance; the notifier slot is a thunk evaluated per owner turn', async () => {
    const { bag, hooks } = await boot();
    const first = ownerTurn(hooks);
    const second = ownerTurn(hooks);
    expect(first.l2NameOf).toBe(bag.nameOf);
    expect(first.l2Proposals).toBe(bag.proposalsStore);
    expect(first.pendingFollowsForHook).toBe(bag.pendingFollows);
    expect(first.l2Notifier).toBeDefined();
    // A fresh presentation view per turn, not a view captured at boot.
    expect(second.l2Notifier).not.toBe(first.l2Notifier);
    expect(second.l2NameOf).toBe(first.l2NameOf);
    await bag.shutdown();
  }, 30_000);
});

/** C4: the same behaviour probes the MCP file runs, on the gateway's production path. */
describe('behaviour the source-text guards used to pin (C4)', () => {
  it('a rename after the boot reaches every surface that signs or shows the owner name', async () => {
    const { bag } = await boot();
    const { before, profileUrl, ...names } = await ownerNameAfterRename(bag as unknown as ProbedBag, 'C4Renamed');
    expect(before).toMatch(/^ranger-/);
    expect(names).toEqual({ boot: 'C4Renamed', inviteRequest: 'C4Renamed', markSigner: 'C4Renamed', onboardingCanvas: 'C4Renamed' });
    expect(profileUrl).toContain('/C4Renamed/');
    await bag.shutdown();
  }, 30_000);

  it('a DM through the root\'s inbox hook is stored with its signed envelope and logged once as dm_received, a replay neither', async () => {
    const { bag } = await boot();
    expect(probe.resourceConfigs).toHaveLength(1);
    const { envelope, stored, dmReceived } = await deliverDmTwice(bag as unknown as ProbedBag, probe.resourceConfigs[0]!,
      { slug: HOUSE_SLUG, baseUrl: HOUSE });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.envelopeBytes).toEqual(envelope);
    expect(stored[0]).toMatchObject({ body: 'c4 hello', houseSlug: HOUSE_SLUG, senderNickname: 'C4Peer' });
    expect(dmReceived).toHaveLength(1);
    expect(dmReceived[0]).toMatchObject({ kind: 'dm_received', text: 'c4 hello', house_slug: HOUSE_SLUG });
    await bag.shutdown();
  }, 30_000);
});

describe('the push leg and its three shared callers', () => {
  it('a FIRST reply to the owner\'s post is logged and pushed; a queued DM and an invitation outcome push too', async () => {
    const { bag, logs } = await boot();
    const pushes = () => probe.events.filter(e => e === 'notifyOwnerNow').length;
    const before = pushes();
    const house = { slug: HOUSE_SLUG, baseUrl: HOUSE, cache: {
      lookup: (platform: string, id: string) => (platform === 'popclaw' && id === 'c3-my-post'
        ? { authorPopclawId: bag.boot.popclawId, eventId: 'c3-my-post-event', textPreview: 'my post' } : null),
    } } as unknown as HouseStore;
    probe.resourceConfigs[0]!.onContent!(house, { eventId: 'c3-reply-1', authorPopclawId: 'c3-replier', actorNickname: 'R',
      textPreview: 'hi', replyToPostId: 'c3-my-post', platformPostCreatedAt: Math.floor(Date.now() / 1000) } as never);
    expect(logs).toContain(`popclaw: reply-ping first [${HOUSE_SLUG}]`);
    await vi.waitFor(() => expect(pushes()).toBe(before + 1));
    // DM policy: the same leg as its onQueued.
    expect(captured.dmDeps).toHaveLength(1);
    expect(typeof captured.dmDeps[0]!.onQueued).toBe('function');
    captured.dmDeps[0]!.onQueued!();
    await vi.waitFor(() => expect(pushes()).toBe(before + 2));
    // Invitation outcome.
    bag.inviteWatch.notifyOwner();
    await vi.waitFor(() => expect(pushes()).toBe(before + 3));
    // And the retry slot the durable-delivery service calls.
    await bag.retryDmNotifications();
    expect(pushes()).toBe(before + 4);
    await bag.shutdown();
  }, 30_000);
});

describe('the guarded shutdown\'s memo and host steps (ruling 14:14 ②)', () => {
  it('a direct second call returns at once while the first is still running, and runs nothing again', async () => {
    const { bag } = await boot();
    probe.events.length = 0;
    const held = barrier();
    probe.holdHousesStop = held;
    const firstCall = bag.shutdown();
    await held.reached;
    const second = await Promise.race([bag.shutdown().then(() => 'returned'), new Promise(done => setTimeout(() => done('waited'), 1_000))]);
    const whileHeld = [...probe.events];
    held.release();
    await firstCall;
    expect({ second, whileHeld, all: probe.events }).toEqual({
      second: 'returned',
      whileHeld: ['worldOwnerApproval.stop', 'native.stop', 'worlds.stop', 'resetOwnerApprovals', 'reception.stop', 'houses.stop'],
      all: ['worldOwnerApproval.stop', 'native.stop', 'worlds.stop', 'resetOwnerApprovals', 'reception.stop', 'houses.stop',
        'worlds.whenIdle', `storeDb.close:${HOUSE_SLUG}`, 'executionStores.close', 'release', 'hostDb.close'],
    });
  }, 30_000);

  it('after a first call rejected on a bare step, a second call resolves and retries nothing', async () => {
    const { bag } = await boot();
    probe.events.length = 0;
    probe.failWorldsStop = true;
    const first = await bag.shutdown().then(() => 'resolved', (e: unknown) => (e as Error).message);
    const afterFirst = [...probe.events];
    const second = await bag.shutdown().then(() => 'resolved', (e: unknown) => (e as Error).message);
    expect({ first, afterFirst, second, again: probe.events.slice(afterFirst.length) }).toEqual({
      first: 'C0_worlds.stop_FAILED',
      // The reset is after the world stop, so a throw there never reaches it.
      afterFirst: ['worldOwnerApproval.stop', 'native.stop', 'worlds.stop'],
      second: 'resolved',
      again: [],
    });
  }, 30_000);

  it('through the real daily-backup service: a backup in flight is waited out before the execution stores close, and no new backup starts once shutting down', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { bag, service } = await boot();
    const realTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: (...args: any[]) => void, ms?: number, ...args: any[]) =>
      realTimeout(fn, ms === 30_000 ? 0 : ms, ...args)) as typeof setTimeout);
    // One backup pass in flight (runDailyBackup is held).
    void service('popclaw-daily-backup').start();
    await vi.waitFor(() => expect(probe.events).toContain('backup.run'));
    probe.events.length = 0;
    const stopping = bag.shutdown();
    await vi.waitFor(() => expect(probe.events).toContain(`storeDb.close:${HOUSE_SLUG}`));
    // Still waiting on the backup: nothing after the store closes has run.
    await new Promise(done => setTimeout(done, 50));
    const whileBackupRuns = [...probe.events];
    // A second pass now finds the storage shutting down and starts nothing.
    await service('popclaw-daily-backup').start();
    const secondPassRan = probe.events.filter(e => e === 'backup.run').length;
    captured.backups.splice(0).forEach(release => release());
    await stopping;
    for (const result of setIntervalSpy.mock.results) intervals.push(result.value as ReturnType<typeof setInterval>);
    await service('popclaw-daily-backup').stop?.();
    expect({ whileBackupRuns, secondPassRan, tail: probe.events.slice(whileBackupRuns.length) }).toEqual({
      whileBackupRuns: ['worldOwnerApproval.stop', 'native.stop', 'worlds.stop', 'resetOwnerApprovals', 'reception.stop',
        'houses.stop', 'worlds.whenIdle', `storeDb.close:${HOUSE_SLUG}`],
      secondPassRan: 0,
      tail: ['backup.done', 'executionStores.close', 'release', 'hostDb.close'],
    });
  }, 30_000);
});

it('returns from backup service start before any backup and cancels the delayed boot pass on stop', async () => {
  const {bag, service} = await boot();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const started = await Promise.race([service('popclaw-daily-backup').start().then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
  expect(started).toBe(true);
  expect(probe.events).not.toContain('backup.run');
  expect(timers.mock.calls.some(([, ms]) => ms === 30_000)).toBe(true);
  await service('popclaw-daily-backup').stop?.();
  await bag.shutdown();
});

describe('port combinations the assembly refuses, like a failed boot', () => {
  it('guarded shutdown without its host steps: the host\'s cleanup step first, then release and host DB — nothing built', async () => {
    const events = probe.events;
    const { host, ports } = gatewayRoot(events);
    const without: GatewayRuntimePorts = { ...ports, lifecycle: { ...ports.lifecycle, guardedShutdown: undefined } };
    await expect(assembleRuntime(host, without, new AbortController().signal))
      .rejects.toThrow('RUNTIME_ASSEMBLY_UNWIRED: drift.shutdown (guarded without its host steps)');
    expect(events).toEqual(['l2.clear', 'release', 'hostDb.close']);
  });

  it('push delivery without a leg is refused the same way', async () => {
    const events = probe.events;
    const { host, ports } = gatewayRoot(events);
    const noLeg = { ...ports, delivery: { kind: 'push' as const } };
    await expect(assembleRuntime(host, noLeg, new AbortController().signal))
      .rejects.toThrow('RUNTIME_ASSEMBLY_UNWIRED: delivery.kind (push without a leg)');
    expect(events).toEqual(['l2.clear', 'release', 'hostDb.close']);
  });
});
