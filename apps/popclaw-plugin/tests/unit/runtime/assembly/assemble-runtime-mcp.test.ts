import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HouseRuntime } from '../../../../src/runtime/house-lifecycle/house-runtime.js';
import { WorldRuntime } from '../../../../src/runtime/world-runtime.js';
import { ExecutionStoreCatalog } from '../../../../src/host/execution-store.js';
import { KnownFollowersStore } from '../../../../src/social-graph/followers-sync.js';
import { SqliteNotifier } from '../../../../src/notifier/sqlite-notifier.js';
import { LocalHostAdapter } from '../../../../src/host/local-host-adapter.js';
import { PopclawPaths } from '../../../../src/host/popclaw-paths.js';
import { assertStorageBootstrap, registerStorageRuntime } from '../../../../src/host/storage-maintenance.js';
import { assembleRuntime, type RuntimePorts } from '../../../../src/runtime/assembly/index.js';
import { buildMcpRuntime, mcpRuntimePorts, type McpPluginRuntime } from '../../../../src/host/mcp-runtime-ports.js';
import type { pinoHostLogger } from '../../../../src/runtime/logger.js';
import type { HouseStore } from '../../../../src/ingress/world-feed-store.js';
import type { HouseGate } from '../../../../src/runtime/house-lifecycle/manager.js';
import type { EventIngress } from '../../../../src/ingress/event-ingress.js';
import { patchPrototypes, probe, push } from '../../../helpers/root-assembly-probe.js';
import { deliverDmTwice, ownerNameAfterRename } from '../../../helpers/assembled-bag-probes.js';
import { ALL_STARTERS, startersCalledBy } from '../../../../src/runtime/resident-services.js';

/**
 * The MCP root's runtime assembly, driven through the PRODUCTION root path:
 * `buildMcpRuntime` (what `src/mcp.ts` `buildRuntime` calls, and nothing
 * else) → the real `mcpRuntimePorts` reading the real environment → the
 * shared `assembleRuntime`, on a temp data root with a real LocalHostAdapter,
 * offline (lore-house and canvas both point at an unroutable port; global
 * fetch refuses).
 *
 * These pin what the spawned-process characterization
 * (root-assembly-mcp.test.ts) cannot see: the bag's key set, drift rows #16,
 * #17, #18 and #25, the pull consumer, and the closure-only shutdown steps
 * (inline loop stops, owner-lane stop, and the ABSENCE of a reception stop).
 * They cannot run against the pre-move tree — `buildRuntime` was neither
 * exported nor importable (mcp.ts starts `main()` at module scope) — so every
 * expected value below is transcribed from src/mcp.ts @ 2f857931. That file is
 * byte-identical at 3a087be8 and at 1c73ae6b (the C0 revision this candidate
 * sits on); `git diff 2f857931 1c73ae6b -- apps/popclaw-plugin/src` is empty.
 *
 * Probes are pass-through recorders (tests/helpers/root-assembly-probe.ts).
 * Two collaborators are not run for real: `routeReplyPing` (recorded, the
 * item is synthetic) and relation reception's `stop` as the ROOT sees it
 * (recorded only — the test stops the real reception itself afterwards, so
 * its drain timer never outlives a test).
 */

const HOUSE = 'http://127.0.0.1:9';
const HOUSE_SLUG = '127-0-0-1-9';
const CONSUMER = 'mcp:assembly-direct-test';

const realReceptions = vi.hoisted(() => [] as Array<{ stop(): void }>);
/** This file's own injected faults (the shared probe's are the C0 files'). */
const fault = vi.hoisted(() => ({
  /** configureResources throws after doing its work: a failed boot AFTER reception opened. */
  configure: false,
  /** SqliteNotifier.bindConsumer throws: a failed boot BEFORE openHouseStores. */
  bindConsumer: false,
  /** Loading the plugin config sets POPCLAW_WORLD_STREAM=public-v1: after the ports were built, before HouseRuntime. */
  publicV1DuringBoot: false,
}));
const openedStores = vi.hoisted(() => [] as Array<{ db: { close(): void } }>);
/** Every execution catalog built, so the test-only rescue can close partitions a failed shutdown left open. */
const catalogs = vi.hoisted(() => [] as Array<{ close(): void }>);

vi.mock('../../../../src/social-graph/relation-reception.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/social-graph/relation-reception.js')>();
  const { probe: p, push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, openRelationReception: async (deps: Parameters<typeof real.openRelationReception>[0]) => {
    p.receptionDeps.push(deps as never);
    const reception = await real.openRelationReception(deps);
    realReceptions.push(reception);
    push('reception.open');
    return { ...reception, stop: () => push('reception.stop') };
  } };
});
vi.mock('../../../../src/config/loader.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/config/loader.js')>();
  return { ...real, loadPluginConfig: (...args: Parameters<typeof real.loadPluginConfig>) => {
    if (fault.publicV1DuringBoot) process.env['POPCLAW_WORLD_STREAM'] = 'public-v1';
    return real.loadPluginConfig(...args);
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
    constructor(...args: ConstructorParameters<typeof real.ExecutionStoreCatalog>) { super(...args); catalogs.push(this); }
  }
  return { ...real, ExecutionStoreCatalog };
});
vi.mock('../../../../src/ingress/world-feed-store.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/ingress/world-feed-store.js')>();
  const { record } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, openHouseStores: async (...args: Parameters<typeof real.openHouseStores>) => {
    const stores = await real.openHouseStores(...args);
    for (const store of stores) record(store.db, 'close', `storeDb.close:${store.slug}`);
    openedStores.push(...stores);
    return stores;
  } };
});
vi.mock('../../../../src/social-graph/follower-sync-service.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/social-graph/follower-sync-service.js')>();
  const { probe: p, push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, createFollowerSync: (service: Parameters<typeof real.createFollowerSync>[0]) => {
    p.followerSyncDeps.push(service.deps);
    const sync = real.createFollowerSync(service);
    return { ...sync, start: () => { push('followerSync.start'); return sync.start(); },
      stop: () => { push('followerSync.stop'); sync.stop(); } };
  } };
});
vi.mock('../../../../src/social-graph/default-house-pinning.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/social-graph/default-house-pinning.js')>();
  const { push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, startDefaultHousePinning: (...args: Parameters<typeof real.startDefaultHousePinning>) => {
    push('housePinning.start');
    const loop = real.startDefaultHousePinning(...args);
    return { ...loop, stop: () => { push('housePinning.stop'); loop.stop(); } };
  } };
});
vi.mock('../../../../src/newspaper/follow-doorbell-service.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/newspaper/follow-doorbell-service.js')>();
  const { push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, startFollowDoorbell: (...args: Parameters<typeof real.startFollowDoorbell>) => {
    push('doorbell.start');
    const loop = real.startFollowDoorbell(...args);
    return { ...loop, stop: () => { push('doorbell.stop'); loop.stop(); } };
  } };
});
vi.mock('../../../../src/canvas/sync-answer-client.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/canvas/sync-answer-client.js')>();
  const { push } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, startPageStateSync: (...args: Parameters<typeof real.startPageStateSync>) => {
    push('pageState.start');
    const loop = real.startPageStateSync(...args);
    return { ...loop, stop: () => { push('pageState.stop'); loop.stop(); } };
  } };
});
vi.mock('../../../../src/social-graph/followers-sync.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/social-graph/followers-sync.js')>();
  const { probe: p } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, announceVerifiedFollowers: (...args: Parameters<typeof real.announceVerifiedFollowers>) => {
    p.announceDeps.push(args[0]);
    return real.announceVerifiedFollowers(...args);
  } };
});
vi.mock('../../../../src/pings/reply-pings.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/pings/reply-pings.js')>();
  const { probe: p } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, routeReplyPing: (deps: Parameters<typeof real.routeReplyPing>[0]) => {
    p.replyPingDeps.push(deps as unknown as Record<string, unknown>);
    return 'not-mine' as const;
  } };
});
vi.mock('../../../../src/runtime/dm-notification-policy.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/runtime/dm-notification-policy.js')>();
  const { recorded } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, makeDmNotificationPolicy: (...args: Parameters<typeof real.makeDmNotificationPolicy>) =>
    recorded(real.makeDmNotificationPolicy(...args), 'recover', 'dm.recover') };
});
vi.mock('../../../../src/host/mcp-owner-authorization.js', async (orig) => {
  const real = await orig<typeof import('../../../../src/host/mcp-owner-authorization.js')>();
  const { recorded } = await import('../../../helpers/root-assembly-probe.js');
  return { ...real, createMcpOwnerAuthorization: (...args: Parameters<typeof real.createMcpOwnerAuthorization>) =>
    recorded(real.createMcpOwnerAuthorization(...args), 'stop', 'ownerAuthorization.stop') };
});

type ResourceConfig = Parameters<HouseRuntime['configureResources']>[0];

let restorePrototypes: () => void = () => {};
beforeAll(() => {
  restorePrototypes = patchPrototypes([
    { proto: HouseRuntime.prototype, name: 'start', label: 'houses.start' },
    { proto: HouseRuntime.prototype, name: 'stop', label: 'houses.stop', failWhen: () => probe.failHousesStop },
    { proto: WorldRuntime.prototype, name: 'stop', label: 'worlds.stop', failWhen: () => probe.failWorldsStop },
    { proto: WorldRuntime.prototype, name: 'whenIdle', label: 'worlds.whenIdle' },
    { proto: ExecutionStoreCatalog.prototype, name: 'close', label: 'executionStores.close' },
  ]);
  const configure = HouseRuntime.prototype.configureResources;
  HouseRuntime.prototype.configureResources = function (this: HouseRuntime, config) {
    probe.resourceConfigs.push(config);
    push('houses.configure');
    configure.call(this, config);
    if (fault.configure) { push('boot.fail'); throw new Error('C2_FORCED_BOOT_FAILURE'); }
  };
  const bindConsumer = SqliteNotifier.prototype.bindConsumer;
  SqliteNotifier.prototype.bindConsumer = function (this: SqliteNotifier, consumerId) {
    if (fault.bindConsumer) { push('boot.fail'); throw new Error('C2_EARLY_BOOT_FAILURE'); }
    return bindConsumer.call(this, consumerId);
  };
  restorePrototypes = ((restore) => () => {
    restore(); HouseRuntime.prototype.configureResources = configure; SqliteNotifier.prototype.bindConsumer = bindConsumer;
  })(restorePrototypes);
});
afterAll(() => restorePrototypes());

const roots: string[] = [];
const built: McpPluginRuntime[] = [];
let logLines: Array<{ level: string; msg: string }> = [];

beforeEach(() => {
  probe.reset();
  Object.assign(fault, { configure: false, bindConsumer: false, publicV1DuringBoot: false });
  logLines = [];
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('OFFLINE'); }));
  vi.stubEnv('POPCLAW_MCP_ENABLE_RANGER', '');
  vi.stubEnv('POPCLAW_WORLD_STREAM', '');
  vi.stubEnv('POPCLAW_CANVAS_BASE_URL', HOUSE);
});
afterEach(async () => {
  await rescue();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Handle = { queryOne(sql: string): unknown; close(): void };
const live = (db: Handle): boolean => { try { db.queryOne('SELECT 1 AS live'); return true; } catch { return false; } };
const partitionsOf = (catalog: object): Handle[] =>
  [...(catalog as { opened: Map<string, { db: Handle }> }).opened.values()].map(partition => partition.db);
const partitionDbs = (): Handle[] => catalogs.flatMap(partitionsOf);

/**
 * Test-only rescue, run after a test's assertions (and always from afterEach):
 * stop the work first (runtimes still in `built`, the real receptions), then
 * close what a failed shutdown or boot left open — house stores, execution
 * partitions through their catalog (which needs the host DB), then the host
 * DBs. Every step is idempotent for resources the root already closed; the
 * temp directories are deleted only after this.
 */
async function rescue(): Promise<void> {
  probe.failHousesStop = false;
  probe.failWorldsStop = false;
  for (const rt of built.splice(0)) await rt.shutdown().catch(() => {});
  for (const reception of realReceptions.splice(0)) reception.stop();
  for (const store of openedStores.splice(0)) store.db.close();
  for (const catalog of catalogs.splice(0)) {
    try { catalog.close(); } catch { for (const db of partitionsOf(catalog)) db.close(); }
  }
  for (const db of probe.hostDbs) db.close();
}

function logger(): ReturnType<typeof pinoHostLogger> {
  const at = (level: string) => (obj: unknown, msg?: string) => { logLines.push({ level, msg: msg ?? String(obj) }); };
  return { info: at('info'), warn: at('warn'), error: at('error'), debug: at('debug') } as unknown as ReturnType<typeof pinoHostLogger>;
}

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-assembly-c2-'));
  roots.push(root);
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(join(root, 'config', 'plugin.json'), JSON.stringify({ lore_houses: [HOUSE], canvas_base_url: HOUSE }));
  vi.stubEnv('POPCLAW_DATA_ROOT', root);
  return root;
}

/** Exactly what src/mcp.ts `buildRuntime` passes, bar the logger and the consumer thunk. */
async function boot(closing: AbortSignal = new AbortController().signal): Promise<McpPluginRuntime> {
  const rt = await buildMcpRuntime({ logger: logger(), closing, serverBox: {}, approvalWindowMs: undefined,
    dataRoot: dataRoot(), consumerId: () => CONSUMER });
  built.push(rt);
  return rt;
}

async function stop(rt: McpPluginRuntime): Promise<string[]> {
  built.splice(built.indexOf(rt), 1);
  const from = probe.events.length;
  await rt.shutdown();
  return probe.events.slice(from);
}

const config = (): ResourceConfig => {
  expect(probe.resourceConfigs).toHaveLength(1);
  return probe.resourceConfigs[0]!;
};

describe('the MCP bag, as the production root path builds it', () => {
  it('carries exactly the keys src/mcp.ts @ 2f857931 returned (no publicFeedDisplay unless public-v1)', async () => {
    const rt = await boot();
    expect(Object.keys(rt).sort()).toEqual([
      'boot', 'bondsStore', 'cadenceLoader', 'egress', 'guideClient', 'host', 'houseRuntime', 'houseStarted', 'houses',
      'inboxStore', 'initiator', 'inviteWatch', 'knownFollowers', 'llmComplete', 'markService', 'marksStore', 'nameOf',
      'notifier', 'onboardingState', 'orchestrator', 'ownerNotifyTargetStore', 'paths', 'pendingFollows', 'pendingInvites',
      'proposalsStore', 'replyPings', 'scoreCache', 'shutdown', 'socialGraph', 'socialLog', 'summaryClient', 'tasteLoader',
      'uploadCanvas', 'worldFeedCache', 'worldFeedClient', 'worldOwnerAuthorization', 'worldRuntime',
    ].sort());
    expect(Object.keys(rt)).toHaveLength(37);
    expect(rt.worldFeedClient).toBe(rt.worldFeedCache);
  });

  it('the world-stream env is read DURING boot, where the root read it — not when the ports were built', async () => {
    // Unset when mcpRuntimePorts runs; set while bootstrapPlugin loads the
    // config, i.e. before HouseRuntime is constructed and the bag returned.
    fault.publicV1DuringBoot = true;
    const rt = await boot();
    expect((rt.houseRuntime as unknown as { opts: { publicV1Mode?: boolean } }).opts.publicV1Mode).toBe(true);
    expect(Object.keys(rt)).toContain('publicFeedDisplay');
  });

  it('POPCLAW_WORLD_STREAM=public-v1 is read by the root and adds publicFeedDisplay', async () => {
    vi.stubEnv('POPCLAW_WORLD_STREAM', 'public-v1');
    const rt = await boot();
    expect(Object.keys(rt)).toContain('publicFeedDisplay');
  });
});

/**
 * C4: these replace source-text pins (runtime-contract "the owner name stays
 * live", dm-handler-parity's feeds.ts handoff and envelope regexes,
 * resident-services' AST row for this root) with what the assembled MCP
 * runtime does. The gateway file runs the same probes.
 */
describe('behaviour the source-text guards used to pin (C4)', () => {
  it('a rename after the boot reaches every surface that signs or shows the owner name', async () => {
    const rt = await boot();
    const { before, profileUrl, ...names } = await ownerNameAfterRename(rt, 'C4Renamed');
    expect(before).toMatch(/^ranger-/);
    expect(names).toEqual({ boot: 'C4Renamed', inviteRequest: 'C4Renamed', markSigner: 'C4Renamed', onboardingCanvas: 'C4Renamed' });
    expect(profileUrl).toContain('/C4Renamed/');
  });

  it('a DM through the root\'s inbox hook is stored with its signed envelope and logged once as dm_received, a replay neither', async () => {
    const rt = await boot();
    const { envelope, stored, dmReceived } = await deliverDmTwice(rt, config(), { slug: HOUSE_SLUG, baseUrl: HOUSE });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.envelopeBytes).toEqual(envelope);
    expect(stored[0]).toMatchObject({ body: 'c4 hello', houseSlug: HOUSE_SLUG, senderNickname: 'C4Peer' });
    expect(dmReceived).toHaveLength(1);
    expect(dmReceived[0]).toMatchObject({ kind: 'dm_received', text: 'c4 hello', house_slug: HOUSE_SLUG });
  });

  it('starts exactly the resident starters RESIDENT_SERVICES assigns the MCP root, each once', async () => {
    // The probe label of every starter the table knows (this file's mocks record all of them).
    const label: Record<string, string> = {
      startDefaultHousePinning: 'housePinning.start', createFollowerSync: 'followerSync.start',
      startFollowDoorbell: 'doorbell.start', startPageStateSync: 'pageState.start',
    };
    expect(ALL_STARTERS.map(s => label[s.export])).not.toContain(undefined);
    await boot();
    const started = probe.events.filter(e => Object.values(label).includes(e));
    expect(started.sort()).toEqual(startersCalledBy('mcp').map(s => label[s.export]!).sort());
  });
});

describe('pull delivery (rows 9/10)', () => {
  it('binds the notifier to the root consumer, and only to it; nothing proactive is wired', async () => {
    const rt = await boot();
    expect(rt.host.db.queryAll<{ consumer_id: string }>('SELECT consumer_id FROM notification_consumers')
      .map(r => r.consumer_id)).toEqual([CONSUMER]);
    // Pull: the invitation leg has no owner push, and the bag no push-only slots.
    expect(rt.drainNotifications).toBeUndefined();
    expect(rt.notifyBacklog).toBeUndefined();
    expect(() => rt.inviteWatch.notifyOwner()).not.toThrow();
  });
});

describe('drift rows pinned as the MCP root runs them today', () => {
  it('#16: poll and reception share ONE deps object with no displayName, no bondContext, and its own known-followers store', async () => {
    const rt = await boot();
    expect(probe.followerSyncDeps).toHaveLength(1);
    const deps = probe.followerSyncDeps[0]!;
    // Reception's announce leg hands the same object on.
    await probe.receptionDeps[0]!.notifyNewFollowers!([]);
    expect(probe.announceDeps).toEqual([deps]);
    expect('displayName' in deps).toBe(false);
    expect('bondContext' in deps).toBe(false);
    expect(typeof deps.bondOf).toBe('function');
    expect(deps.verifiedFollowers).toBeDefined();
    expect(deps.store).toBeInstanceOf(KnownFollowersStore);
    expect(deps.store).not.toBe(rt.knownFollowers);
    expect(deps.notifier).toBe(rt.notifier);
    // Row 30: this root logs the relation chain's warnings as info.
    deps.logger!.warn('c2-relation-warning');
    expect(logLines.filter(l => l.msg.includes('c2-relation-warning'))).toEqual([{ level: 'info', msg: 'popclaw: c2-relation-warning' }]);
  });

  it('#17: a reply lands with the house-attributed notifier and no bondContext', async () => {
    const rt = await boot();
    const house = { slug: HOUSE_SLUG, baseUrl: HOUSE, cache: {} } as unknown as HouseStore;
    config().onContent!(house, { id: 'synthetic' } as never);
    expect(probe.replyPingDeps).toHaveLength(1);
    const deps = probe.replyPingDeps[0]!;
    expect('bondContext' in deps).toBe(false);
    expect(deps['ownerPopclawId']).toBe(rt.boot.popclawId);
    expect(deps['pings']).toBe(rt.replyPings);
    (deps['notifier'] as { enqueue(a: unknown): void }).enqueue({ level: 'L1', kind: 'reply', payload: { probe: 'reply' } });
    expect(payloads(rt).find(p => p['probe'] === 'reply')).toEqual({ probe: 'reply', houseOrigin: HOUSE });
  });

  it('#18: the invitation outcome notifier is the bare queue — a notice enqueued through it carries no houseOrigin', async () => {
    const rt = await boot();
    expect(rt.inviteWatch.notifier).toBe(rt.notifier);
    rt.inviteWatch.notifier.enqueue({ level: 'L1', kind: 'ranger_verify_done', payload: { probe: 'invite' } });
    expect(payloads(rt).find(p => p['probe'] === 'invite')).toEqual({ probe: 'invite' });
  });

  it('#24: configureResources gets no refreshMs (the resource-set default applies)', async () => {
    await boot();
    expect('refreshMs' in config()).toBe(false);
  });

  it('#25: no Ranger by default; POPCLAW_MCP_ENABLE_RANGER=true builds one per house, without invite-notify wiring', async () => {
    const closed = new AbortController(); closed.abort();
    await boot(closed.signal);
    expect('createRanger' in config()).toBe(false);
    expect(logLines.map(l => l.msg)).toContain('popclaw: mode=citizen (consumer-only)');

    probe.resourceConfigs.length = 0;
    vi.stubEnv('POPCLAW_MCP_ENABLE_RANGER', 'true');
    await boot(closed.signal);
    expect(logLines.map(l => l.msg)).toContain('popclaw: mode=ranger — house lifecycle owns task resources');
    const gate = { origin: HOUSE, generation: 1, signal: new AbortController().signal, isActive: () => true } as unknown as HouseGate;
    const ranger = config().createRanger!({ slug: HOUSE_SLUG, baseUrl: HOUSE } as HouseStore, gate, {} as EventIngress);
    const deps = (ranger as unknown as { deps: Record<string, unknown> }).deps;
    expect(deps['houseOrigin']).toBe(HOUSE);
    expect('inviteNotify' in deps).toBe(false);
  });
});

describe('boot and shutdown sequences (rows 7, 26, 28)', () => {
  it('opens reception before configuring resources, then starts houses and the four inline loops', async () => {
    await boot();
    // Synchronously, in this order, before the build resolves.
    const order = probe.events.filter(e => /^(reception\.open|houses\.(configure|start)|\w+\.start)$/.test(e));
    expect(order).toEqual(['reception.open', 'houses.configure', 'houses.start',
      'housePinning.start', 'followerSync.start', 'doorbell.start', 'pageState.start']);
  });

  it('M13: a normal boot submits DM recovery, and the DM policy\'s own recover() actually runs after houses started', async () => {
    // Observed on the real policy's recover (not on the house bus, which the
    // loops use too), so only the recovery submission itself can satisfy it.
    await boot();
    await vi.waitFor(() => expect(probe.events).toContain('dm.recover'));
    expect(probe.events.filter(e => e === 'dm.recover')).toHaveLength(1);
    expect(probe.events.indexOf('dm.recover')).toBeGreaterThan(probe.events.indexOf('houses.start'));
  });

  it('normal shutdown: loops, owner lane, worlds, houses, idle, store DB, execution stores, release, host DB — and reception is never stopped', async () => {
    const rt = await boot();
    const sequence = await stop(rt);
    expect(sequence.filter(e => e !== 'dm.recover')).toEqual([
      'housePinning.stop', 'followerSync.stop', 'doorbell.stop', 'pageState.stop',
      'ownerAuthorization.stop', 'worlds.stop', 'houses.stop', 'worlds.whenIdle',
      `storeDb.close:${HOUSE_SLUG}`, 'executionStores.close', 'release', 'hostDb.close',
    ]);
    expect(probe.events).not.toContain('reception.stop');
    // Memoized: a second call is the same task and runs nothing again.
    const again = probe.events.length;
    await rt.shutdown();
    expect(probe.events.length).toBe(again);
  });

  it('the first throwing step aborts the rest: no DB closed, storage not released', async () => {
    const rt = await boot();
    probe.failHousesStop = true;
    const from = probe.events.length;
    built.splice(built.indexOf(rt), 1);
    await expect(rt.shutdown()).rejects.toThrow('C0_houses.stop_FAILED');
    expect(probe.events.slice(from).filter(e => e !== 'dm.recover')).toEqual([
      'housePinning.stop', 'followerSync.stop', 'doorbell.stop', 'pageState.stop',
      'ownerAuthorization.stop', 'worlds.stop', 'houses.stop',
    ]);
    // Row 28 leaves the stores open. Proof the rescue is needed, and that it works.
    const partitions = partitionDbs();
    expect(partitions.filter(live)).toHaveLength(1);
    await rescue();
    for (const db of [...partitions, ...probe.hostDbs]) expect(() => db.queryOne('SELECT 1')).toThrow(/not open/);
  });

  it('closing already fired: houses not started, no DM recovery, none of the four loops; shutdown still closes everything', async () => {
    const closed = new AbortController(); closed.abort();
    const rt = await boot(closed.signal);
    expect(probe.events.filter(e => /\.start$|^dm\.recover$/.test(e))).toEqual([]);
    expect(await stop(rt)).toEqual([
      'ownerAuthorization.stop', 'worlds.stop', 'houses.stop', 'worlds.whenIdle',
      `storeDb.close:${HOUSE_SLUG}`, 'executionStores.close', 'release', 'hostDb.close',
    ]);
  });
});

describe('failed boot (row 29)', () => {
  it('a boot failing after reception opened drains the owner lane, worlds and houses, closes in reverse, releases, closes the host DB, rethrows', async () => {
    fault.configure = true;
    await expect(boot()).rejects.toThrow('C2_FORCED_BOOT_FAILURE');
    const after = probe.events.slice(probe.events.indexOf('boot.fail') + 1);
    expect(after).toEqual([
      'ownerAuthorization.stop', 'worlds.stop', 'houses.stop', 'worlds.whenIdle',
      `storeDb.close:${HOUSE_SLUG}`, 'executionStores.close', 'release', 'hostDb.close',
    ]);
    // Row 29 as it stands: the reception opened during the failed boot is not stopped by the root.
    expect(probe.events).not.toContain('reception.stop');
  });

  it('a cleanup that throws too becomes STORAGE_BOOT_CLEANUP_FAILED carrying both errors, and stops cleaning at that step', async () => {
    fault.configure = true;
    probe.failHousesStop = true;
    const failure = await boot().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('STORAGE_BOOT_CLEANUP_FAILED');
    expect((failure as AggregateError).errors.map(e => (e as Error).message)).toEqual(['C2_FORCED_BOOT_FAILURE', 'C0_houses.stop_FAILED']);
    expect(probe.events.slice(probe.events.indexOf('boot.fail') + 1)).toEqual(['ownerAuthorization.stop', 'worlds.stop', 'houses.stop']);
    // Cleanup stopped at houses.stop, so the host DB and a partition stay open. Test-only rescue:
    const handles = [...probe.hostDbs, ...partitionDbs()];
    expect(probe.hostDbs.filter(live)).toHaveLength(1);
    expect(partitionDbs().filter(live)).toHaveLength(1);
    await rescue();
    for (const db of handles) expect(() => db.queryOne('SELECT 1')).toThrow(/not open/);
  });
});

describe('failed boot before the house stores open, and the host\'s cleanup step', () => {
  it('fails after houses/worlds but before openHouseStores: only the execution stores are closed, then release and host DB', async () => {
    fault.bindConsumer = true;
    await expect(boot()).rejects.toThrow('C2_EARLY_BOOT_FAILURE');
    expect(probe.events.slice(probe.events.indexOf('boot.fail') + 1)).toEqual([
      'ownerAuthorization.stop', 'worlds.stop', 'houses.stop', 'worlds.whenIdle',
      'executionStores.close', 'release', 'hostDb.close',
    ]);
    expect(probe.events.some(e => e.startsWith('storeDb.'))).toBe(false);
    expect(probe.events).not.toContain('reception.open');
  });

  it('lifecycle.beforeFailedBootCleanup runs first, before the drain', async () => {
    fault.bindConsumer = true;
    const { host, ports } = localRoot();
    const withHook: RuntimePorts<object> = { ...ports, lifecycle: { ...ports.lifecycle, beforeFailedBootCleanup: () => push('beforeFailedBootCleanup') } };
    await expect(assembleRuntime(host, withHook, new AbortController().signal)).rejects.toThrow('C2_EARLY_BOOT_FAILURE');
    expect(probe.events.slice(probe.events.indexOf('boot.fail') + 1)).toEqual([
      'beforeFailedBootCleanup', 'ownerAuthorization.stop', 'worlds.stop', 'houses.stop', 'worlds.whenIdle',
      'executionStores.close', 'release', 'hostDb.close',
    ]);
  });

  it('a throwing beforeFailedBootCleanup is a cleanup failure: STORAGE_BOOT_CLEANUP_FAILED with both errors, nothing else cleaned', async () => {
    fault.bindConsumer = true;
    const { host, ports } = localRoot();
    const withHook: RuntimePorts<object> = { ...ports, lifecycle: { ...ports.lifecycle,
      beforeFailedBootCleanup: () => { push('beforeFailedBootCleanup'); throw new Error('C2_HOOK_FAILED'); } } };
    const failure = await assembleRuntime(host, withHook, new AbortController().signal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe('STORAGE_BOOT_CLEANUP_FAILED');
    expect((failure as AggregateError).errors.map(e => (e as Error).message)).toEqual(['C2_EARLY_BOOT_FAILURE', 'C2_HOOK_FAILED']);
    expect(probe.events.slice(probe.events.indexOf('boot.fail') + 1)).toEqual(['beforeFailedBootCleanup']);
    // The root kept its participation, by design; afterEach's rescue closes the host DB.
  });
});

describe('the production MCP ports themselves', () => {
  it('select pull delivery, inline loops and the MCP drift values', () => {
    const ports = mcpRuntimePorts({ logger: logger(), dataRoot: '/tmp/x', storagePaths: {} as never, releaseStorage: () => {},
      serverBox: {}, approvalWindowMs: undefined, consumerId: () => CONSUMER });
    expect(ports.delivery.kind).toBe('pull');
    expect(ports.delivery.kind === 'pull' && ports.delivery.consumerId()).toBe(CONSUMER);
    expect(ports.lifecycle).toEqual({ loops: 'inline' });
    expect(ports.drift).toEqual({
      followerDisplayNameAbsent: true, followerBondContextAbsent: true, followerStoreOwnInstance: true,
      replyPingBondContextAbsent: true, inviteNotifierUnattributed: true, rangerInviteNotifyAbsent: true,
      refreshMs: undefined, recoveryIgnoresClosing: false, ownerLangSignalsLate: true, shutdown: 'first-error-aborts',
    });
    expect(ports.platform.defaultStateDir()).toBe('./.data');
    expect('speechLocale' in ports.platform).toBe(false);
  });

  it('a port value the assembly does not assemble yet is refused like a failed boot: storage released, host DB closed', async () => {
    const { host, ports } = localRoot();
    const pushDelivery: RuntimePorts<object> = { ...ports, delivery: { kind: 'push' } };
    await expect(assembleRuntime(host, pushDelivery, new AbortController().signal)).rejects.toThrow('RUNTIME_ASSEMBLY_UNWIRED: delivery.kind');
    // Nothing was built (no identity, no execution stores); what the root's
    // host already held is handed back.
    expect(probe.events).toEqual(['release', 'hostDb.close']);
  });
});

function payloads(rt: McpPluginRuntime): Array<Record<string, unknown>> {
  return rt.host.db.queryAll<{ payload_json: string }>('SELECT payload_json FROM notification_queue ORDER BY id')
    .map(r => JSON.parse(r.payload_json) as Record<string, unknown>);
}

/** The host and ports exactly as buildMcpRuntime builds them, for tests that must vary one port. */
function localRoot(): { host: LocalHostAdapter; ports: RuntimePorts<object> } {
  const root = dataRoot();
  const storagePaths = new PopclawPaths(root);
  assertStorageBootstrap(storagePaths);
  let releaseStorage!: () => void;
  const host = new LocalHostAdapter({ dataRoot: root, logger: logger(),
    beforeDbInitialize: db => (releaseStorage = registerStorageRuntime(db, storagePaths)) });
  const ports = mcpRuntimePorts({ logger: logger(), dataRoot: root, storagePaths, releaseStorage: () => releaseStorage(),
    serverBox: {}, approvalWindowMs: undefined, consumerId: () => CONSUMER });
  return { host, ports };
}
