import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearPerProcess, getOrCreatePerProcess } from '../../../src/runtime/once.js';
import { NewspaperDispatchRegistry } from '../../../src/newspaper/dedicated-session.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { WorldRuntime } from '../../../src/runtime/world-runtime.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { CadenceLoader } from '../../../src/cadence/cadence-loader.js';
import { SocialGraph } from '../../../src/social-graph/social-graph.js';
import { FollowEventStore } from '../../../src/social-graph/follow-event-store.js';
import { ScoreCache } from '../../../src/recommend/score-cache.js';
import { RuntimeOwnerNotifier } from '../../../src/notifier/owner-notifier.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ownerLangSource, ownerLangTag, setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { resetOwnerApprovals } from '../../../src/host/owner-approval.js';
import { patchPrototypes, probe, push, type Barrier } from '../../helpers/root-assembly-probe.js';
import { C3_FORCED_FAILURE, gate, gatedAsync, gatedSync } from '../../helpers/root-order-gate.js';

/**
 * C3 order pins for the GATEWAY composition root (src/index.ts `bootRuntime`),
 * written BEFORE the gateway root moves into the shared assembly. They pin the
 * orderings the C3 order ruling (refactor-assembly-c3-order-ruling-20260929)
 * says C3 must preserve or prove: the four L2 slots + memo at each boot
 * anchor (§2), owner language vs the hook (§3), the ScoreCache file snapshot
 * vs the reception await (§3), the social-graph follow backfill (§3), and the
 * gateway-only phase work at its anchors plus the failed-boot drain at each
 * of them (§4).
 *
 * Same entrance as C0 (root-assembly-gateway.test.ts): the real
 * `plugin.register` with a fake OpenClaw api, the `popclaw-runtime` service's
 * start, the `gateway_stop` hook; offline, temp data root. The prompt-build
 * hook is the REAL one; the owner-turn-context mock only records which L2
 * slots it handed the L2 leg (pass-through).
 *
 * Not pass-through (tests/helpers/root-order-gate.ts): holds are barriers in
 * FRONT of a real call; faults are thrown AFTER the real call returned. A
 * fault pins the root's control flow on a rejection at that point, not the
 * state after a natural component failure. Sync anchors (catalog, migrations,
 * orchestrator) fire the hook from inside the real call's wrapper, just before
 * the real call runs.
 */

vi.mock('../../../src/runtime/plugin-bootstrap.js', async (orig) => {
  const real = await orig<typeof import('../../../src/runtime/plugin-bootstrap.js')>();
  const { gatedAsync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, bootstrapPlugin: (...args: Parameters<typeof real.bootstrapPlugin>) =>
    g('bootstrap', () => real.bootstrapPlugin(...args)) };
});
vi.mock('../../../src/runtime/ranger.js', async (orig) => {
  const real = await orig<typeof import('../../../src/runtime/ranger.js')>();
  const { gatedAsync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, buildScraperRegistry: (...args: Parameters<typeof real.buildScraperRegistry>) =>
    g('scraper', () => real.buildScraperRegistry(...args)) };
});
vi.mock('../../../src/ingress/world-feed-store.js', async (orig) => {
  const real = await orig<typeof import('../../../src/ingress/world-feed-store.js')>();
  const { probe: p, record } = await import('../../helpers/root-assembly-probe.js');
  const { gatedAsync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, openHouseStores: (...args: Parameters<typeof real.openHouseStores>) => g('openHouseStores', async () => {
    const stores = await real.openHouseStores(...args);
    for (const store of stores) { p.storeDbs.push(store.db); record(store.db, 'close', `storeDb.close:${store.slug}`); }
    return stores;
  }) };
});
vi.mock('../../../src/social-graph/relation-reception.js', async (orig) => {
  const real = await orig<typeof import('../../../src/social-graph/relation-reception.js')>();
  const { probe: p, push } = await import('../../helpers/root-assembly-probe.js');
  const { gatedAsync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, openRelationReception: (deps: Parameters<typeof real.openRelationReception>[0]) => g('reception', async () => {
    const reception = await real.openRelationReception(deps);
    p.receptionStops.push(() => reception.stop());
    push('reception.open');
    return { ...reception, stop: () => { push('reception.stop'); reception.stop(); } };
  }) };
});
vi.mock('../../../src/host/storage-maintenance.js', async (orig) => {
  const real = await orig<typeof import('../../../src/host/storage-maintenance.js')>();
  const { probeHostDb } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, registerStorageRuntime: (...args: Parameters<typeof real.registerStorageRuntime>) =>
    probeHostDb(args[0], real.registerStorageRuntime(...args)) };
});
vi.mock('../../../src/host/execution-store.js', async (orig) => {
  const real = await orig<typeof import('../../../src/host/execution-store.js')>();
  const { probe: p } = await import('../../helpers/root-assembly-probe.js');
  class ExecutionStoreCatalog extends real.ExecutionStoreCatalog {
    constructor(...args: ConstructorParameters<typeof real.ExecutionStoreCatalog>) { super(...args); p.executionStores.push(this); }
  }
  return { ...real, ExecutionStoreCatalog };
});
vi.mock('../../../src/notifier/owner-turn-context.js', async (orig) => {
  const real = await orig<typeof import('../../../src/notifier/owner-turn-context.js')>();
  const { probe: p } = await import('../../helpers/root-assembly-probe.js');
  return { ...real, deliverOwnerTurnL2: (deps: Parameters<typeof real.deliverOwnerTurnL2>[0]) => {
    p.l2Reads.push({ notifier: deps.l2Notifier !== undefined, nameOf: deps.l2NameOf !== undefined,
      proposals: deps.l2Proposals !== undefined, pendingFollows: deps.pendingFollowsForHook !== undefined });
    return real.deliverOwnerTurnL2(deps);
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
// Constructions the ruling names as anchors: recorded just before the real constructor runs.
vi.mock('../../../src/runtime/house-lifecycle/house-runtime.js', async (orig) => {
  const real = await orig<typeof import('../../../src/runtime/house-lifecycle/house-runtime.js')>();
  const { push } = await import('../../helpers/root-assembly-probe.js');
  class HouseRuntime extends real.HouseRuntime {
    constructor(...args: ConstructorParameters<typeof real.HouseRuntime>) { push('houses.construct'); super(...args); }
  }
  return { ...real, HouseRuntime };
});
vi.mock('../../../src/runtime/world-runtime.js', async (orig) => {
  const real = await orig<typeof import('../../../src/runtime/world-runtime.js')>();
  const { push } = await import('../../helpers/root-assembly-probe.js');
  class WorldRuntime extends real.WorldRuntime {
    constructor(...args: ConstructorParameters<typeof real.WorldRuntime>) { push('worlds.construct'); super(...args); }
  }
  return { ...real, WorldRuntime };
});
vi.mock('../../../src/ingress/world-feed-catalog.js', async (orig) => {
  const real = await orig<typeof import('../../../src/ingress/world-feed-catalog.js')>();
  const { push } = await import('../../helpers/root-assembly-probe.js');
  class WorldFeedCatalog extends real.WorldFeedCatalog {
    constructor(...args: ConstructorParameters<typeof real.WorldFeedCatalog>) { push('catalog.construct'); super(...args); }
  }
  return { ...real, WorldFeedCatalog };
});
vi.mock('../../../src/onboarding/orchestrator.js', async (orig) => {
  const real = await orig<typeof import('../../../src/onboarding/orchestrator.js')>();
  const { push } = await import('../../helpers/root-assembly-probe.js');
  class OnboardingOrchestrator extends real.OnboardingOrchestrator {
    constructor(...args: ConstructorParameters<typeof real.OnboardingOrchestrator>) { push('orchestrator.construct'); super(...args); }
  }
  return { ...real, OnboardingOrchestrator };
});
// Gateway-only phase work and one-shot writes: recorded, called through, faultable.
vi.mock('../../../src/host/sentinels.js', async (orig) => {
  const real = await orig<typeof import('../../../src/host/sentinels.js')>();
  const { gatedSync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, ensureSentinelReadmes: (...args: Parameters<typeof real.ensureSentinelReadmes>) =>
    g('sentinels', () => real.ensureSentinelReadmes(...args)) };
});
vi.mock('../../../src/runtime/last-build.js', async (orig) => {
  const real = await orig<typeof import('../../../src/runtime/last-build.js')>();
  const { gatedSync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real,
    recordBuildOnBoot: (...args: Parameters<typeof real.recordBuildOnBoot>) => g('build.record', () => real.recordBuildOnBoot(...args)),
    readLastBuild: (...args: Parameters<typeof real.readLastBuild>) => g('install.readLastBuild', () => real.readLastBuild(...args)),
  };
});
vi.mock('../../../src/host/integrity-process.js', async (orig) => {
  const real = await orig<typeof import('../../../src/host/integrity-process.js')>();
  const { gatedAsync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, runIntegrityChecksInProcess: (...args: Parameters<typeof real.runIntegrityChecksInProcess>) =>
    g('integrity.run', () => real.runIntegrityChecksInProcess(...args)) };
});
vi.mock('../../../src/bonds/backfill-follows.js', async (orig) => {
  const real = await orig<typeof import('../../../src/bonds/backfill-follows.js')>();
  const { gatedSync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, backfillFollows: (...args: Parameters<typeof real.backfillFollows>) =>
    g('backfill', () => real.backfillFollows(...args)) };
});
vi.mock('../../../src/marks/favorites-migration.js', async (orig) => {
  const real = await orig<typeof import('../../../src/marks/favorites-migration.js')>();
  const { gatedSync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, migrateFavoritesJsonl: (...args: Parameters<typeof real.migrateFavoritesJsonl>) =>
    g('favorites.migrate', () => real.migrateFavoritesJsonl(...args)) };
});
vi.mock('../../../src/visual/style-notes.js', async (orig) => {
  const real = await orig<typeof import('../../../src/visual/style-notes.js')>();
  const { gatedSync: g } = await import('../../helpers/root-order-gate.js');
  return { ...real, migrateStyleNotesToVault: (...args: Parameters<typeof real.migrateStyleNotesToVault>) =>
    g('style.migrate', () => real.migrateStyleNotesToVault(...args)) };
});

import plugin from '../../../src/index.js';

type Service = { id: string; start(ctx?: unknown): Promise<void>; stop?(ctx?: unknown): unknown };
type Hook = (event?: unknown, ctx?: unknown) => unknown;
type GatewayBag = Record<string, unknown> & { scoreCache: ScoreCache };

const HOUSE = 'http://127.0.0.1:59999';
const HOUSE_SLUG = '127-0-0-1-59999';
const OWNER_TURN = { trigger: 'user', sessionKey: 'agent:main:main' };
const MEMO_KEY = '__popclaw_singleton__runtime';
/** The reviewer probe's input (ruling §3): Chinese owner text. */
const CHINESE_TURN = '请帮我看看这个项目接下来应该怎样推进';

let restorePatches: () => void = () => {};
beforeAll(() => {
  const restoreProtos = patchPrototypes([
    { proto: HouseRuntime.prototype, name: 'start', label: 'houses.start' },
    { proto: HouseRuntime.prototype, name: 'stop', label: 'houses.stop' },
    { proto: WorldRuntime.prototype, name: 'stop', label: 'worlds.stop' },
    { proto: WorldRuntime.prototype, name: 'whenIdle', label: 'worlds.whenIdle' },
    { proto: ExecutionStoreCatalog.prototype, name: 'close', label: 'executionStores.close' },
  ]);
  const configure = HouseRuntime.prototype.configureResources;
  HouseRuntime.prototype.configureResources = function (this: HouseRuntime, config) {
    push('houses.configure');
    return configure.call(this, config);
  };
  const cadenceLoad = CadenceLoader.prototype.load;
  CadenceLoader.prototype.load = function (this: CadenceLoader, ...args) {
    return gatedAsync('cadence.load', () => cadenceLoad.apply(this, args));
  };
  const graphStart = SocialGraph.prototype.start;
  SocialGraph.prototype.start = function (this: SocialGraph) {
    return gatedAsync('socialGraph.start', () => graphStart.call(this));
  };
  const deliverNow = RuntimeOwnerNotifier.prototype.deliverNow;
  RuntimeOwnerNotifier.prototype.deliverNow = function (this: RuntimeOwnerNotifier, ...args) {
    return gatedAsync('ownerNotifier.deliverNow', () => deliverNow.apply(this, args));
  };
  const scoreLoad = ScoreCache.load.bind(ScoreCache);
  ScoreCache.load = (file: string) => gatedSync('scoreCache.load', () => scoreLoad(file));
  restorePatches = () => {
    restoreProtos();
    HouseRuntime.prototype.configureResources = configure;
    CadenceLoader.prototype.load = cadenceLoad;
    SocialGraph.prototype.start = graphStart;
    RuntimeOwnerNotifier.prototype.deliverNow = deliverNow;
    ScoreCache.load = scoreLoad;
  };
});
afterAll(() => restorePatches());

const roots: string[] = [];
afterEach(() => {
  // Release any hold a failing assertion left armed, so nothing stays parked.
  gate.holds.forEach(b => b.release());
  gate.reset();
  clearPerProcess('runtime');
  NewspaperDispatchRegistry.clear();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  probe.reset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setOwnerLang(undefined);
});

function newState(): string {
  const state = mkdtempSync(join(tmpdir(), 'popclaw-order-gw-'));
  roots.push(state);
  mkdirSync(join(state, 'popclaw', 'config'), { recursive: true });
  writeFileSync(join(state, 'popclaw', 'config', 'plugin.json'), JSON.stringify({ lore_houses: [HOUSE], canvas_base_url: HOUSE }));
  return state;
}

/** Paths the root will compute for this state dir (POPCLAW_DATA_ROOT is not set in these tests). */
const pathsOf = (state: string) => new PopclawPaths(join(state, 'popclaw'));

function registerAt(state: string, config: Record<string, unknown> = {}) {
  const services: Service[] = [];
  const hooks = new Map<string, Hook>();
  const logs: string[] = [];
  const log = (message: unknown) => { logs.push(String(message)); };
  const api = {
    registrationMode: 'full', config, pluginConfig: {},
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
  return {
    hooks, logs,
    start: () => services.find(s => s.id === 'popclaw-runtime')!.start(),
    stop: () => hooks.get('gateway_stop')!() as Promise<void>,
  };
}
type Root = ReturnType<typeof registerAt>;

const offline = () => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('UNEXPECTED_NETWORK'); }));

const bagOf = () => getOrCreatePerProcess<Promise<GatewayBag>>('runtime', () => {
  throw new Error('the popclaw-runtime service should have memoized the runtime');
});

/** One owner turn through the real prompt-build hook: which L2 slots it handed the L2 leg, and is the memo parked. */
function ownerTurn(root: Root, prompt = 'hi'): { filled: string[]; memo: boolean } | 'hook did not reach the L2 leg' {
  const before = probe.l2Reads.length;
  root.hooks.get('before_prompt_build')!({ prompt }, OWNER_TURN);
  const read = probe.l2Reads[before];
  if (!read) return 'hook did not reach the L2 leg';
  const filled = (['notifier', 'nameOf', 'pendingFollows', 'proposals'] as const).filter(slot => read[slot]);
  return { filled, memo: MEMO_KEY in globalThis };
}

/** Walk a boot through a list of armed holds in order, running `atHold` while the root sits on each. */
async function walk(labels: readonly string[], atHold: (label: string) => void, holds: Map<string, Barrier>): Promise<void> {
  for (const label of labels) {
    const held = holds.get(label)!;
    await held.reached;
    atHold(label);
    held.release();
  }
}

/** Hand back what a failed boot (or its injected fault) left open. */
async function rescue(): Promise<void> {
  resetOwnerApprovals();
  probe.receptionStops.splice(0).forEach(stop => stop());
  for (const db of probe.storeDbs.splice(0)) { try { db.close(); } catch { /* already closed */ } }
  for (const s of probe.executionStores.splice(0)) { try { s.close(); } catch { /* already closed */ } }
  for (const db of probe.hostDbs.splice(0)) { try { db.close(); } catch { /* already closed */ } }
}

const AWAITS = ['bootstrap', 'scraper', 'openHouseStores', 'cadence.load', 'socialGraph.start', 'reception'] as const;

describe('C3 pin 1 — the four L2 slots and the memo, as the real prompt-build hook sees them, at every boot anchor (ruling §2)', () => {
  it('exposes notifier between openHouseStores and the catalog, nameOf right after the catalog, pendingFollows+proposals before the migrations and the orchestrator, all before reception', async () => {
    offline();
    const root = registerAt(newState());
    const timeline: Array<{ at: string } & ({ filled: string[]; memo: boolean } | { read: string })> = [];
    const see = (at: string) => {
      const read = ownerTurn(root);
      timeline.push(typeof read === 'string' ? { at, read } : { at, ...read });
    };
    see('registered');
    const holds = new Map(AWAITS.map(label => [label as string, gate.hold(label)]));
    // Sync anchors: fired from inside the real call's wrapper, before the real call runs.
    const SYNC = new Set(['catalog.construct', 'favorites.migrate', 'style.migrate', 'orchestrator.construct']);
    probe.onEvent = label => { if (SYNC.has(label)) see(label); };
    const booting = root.start();
    await walk(AWAITS, see, holds);
    await booting;
    probe.onEvent = undefined;
    see('booted');
    await root.stop();
    see('stopped');
    const N = ['notifier', 'nameOf'];
    // Ruling 2026-09-29 14:14 ①: the name chain is built from the catalog and
    // exposed in the same synchronous segment, right after it. The hook fired
    // from inside the catalog constructor (a test-made re-entry point, not a
    // production-reachable boundary) therefore sees the notifier only; nameOf
    // is checked at the next real boundary, the cadence.load hold.
    const ALL = ['notifier', 'nameOf', 'pendingFollows', 'proposals'];
    const hookFailures = root.logs.filter(l => l.includes('routing hook failed'));
    expect({ timeline, hookFailures }).toEqual({
      timeline: [
      { at: 'registered', filled: [], memo: false },
      { at: 'bootstrap', filled: [], memo: true },
      { at: 'scraper', filled: [], memo: true },
      { at: 'openHouseStores', filled: [], memo: true },
      { at: 'catalog.construct', filled: ['notifier'], memo: true },
      { at: 'cadence.load', filled: N, memo: true },
      { at: 'socialGraph.start', filled: N, memo: true },
      { at: 'favorites.migrate', filled: ALL, memo: true },
      { at: 'style.migrate', filled: ALL, memo: true },
      { at: 'orchestrator.construct', filled: ALL, memo: true },
      { at: 'reception', filled: ALL, memo: true },
      { at: 'booted', filled: ALL, memo: true },
      // CURRENT BEHAVIOUR, not an endorsement: a normal shutdown does not
      // clear the four slots (only the failed-boot path does), so the next
      // owner turn calls the stale notifier thunk against the closed host DB
      // and the hook fails (non-fatal) before reaching the L2 leg.
      { at: 'stopped', read: 'hook did not reach the L2 leg' },
      ],
      hookFailures: ['popclaw[warn]: popclaw: routing hook failed (non-fatal): TypeError: The database connection is not open'],
    });
  }, 30_000);
});

describe('C3 pin 2 — owner language vs a hook firing during boot (ruling §3: cadence/lang before socialGraph.start)', () => {
  // The reviewer probe's fixture: no explicit cadence language, register
  // empty, speechLocale en-US, no environment locale, Chinese hook input.
  const boot = async (holdAt: 'cadence.load' | 'socialGraph.start' | undefined) => {
    for (const name of ['POPCLAW_LANG', 'OPENCLAW_LOCALE', 'LC_ALL', 'LC_MESSAGES', 'LANG']) vi.stubEnv(name, '');
    setOwnerLang(undefined);
    offline();
    const root = registerAt(newState(), { talk: { speechLocale: 'en-US' } });
    const held = holdAt ? gate.hold(holdAt) : undefined;
    const booting = root.start();
    let atHook: string | undefined;
    if (held && holdAt) {
      await walk([holdAt], () => {
        const read = ownerTurn(root, CHINESE_TURN);
        atHook = `${ownerLangTag()}/${ownerLangSource() ?? 'none'}${typeof read === 'string' ? ` (${read})` : ''}`;
      }, new Map([[holdAt, held]]));
    }
    await booting;
    const outcome = `${ownerLangTag()}/${ownerLangSource() ?? 'none'}`;
    await root.stop();
    return { atHook, outcome };
  };

  it('control: no hook during boot → en-US / config (speechLocale)', async () => {
    expect(await boot(undefined)).toEqual({ atHook: undefined, outcome: 'en-US/config' });
  }, 30_000);

  it('hook fires while the root sits on cadence.load (BEFORE the language signals) → zh-CN / guess, and speechLocale is not taken afterwards', async () => {
    expect(await boot('cadence.load')).toEqual({ atHook: 'zh-CN/guess', outcome: 'zh-CN/guess' });
  }, 30_000);

  it('hook fires while the root sits on socialGraph.start (AFTER the language signals) → en-US / config; the Chinese turn is observed but does not switch', async () => {
    expect(await boot('socialGraph.start')).toEqual({ atHook: 'en-US/config', outcome: 'en-US/config' });
  }, 30_000);
});

describe('C3 pin 3 — ScoreCache.load file snapshot vs the relation-reception await (ruling §3)', () => {
  it('the runtime holds the snapshot written while the root sat on socialGraph.start, not the one written while it sat on reception', async () => {
    offline();
    const state = newState();
    const file = pathsOf(state).scoreCacheFile();
    const write = (ids: string[]) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(Object.fromEntries(ids.map(id => [id, { tasteHash: 't', scores: [1] }]))));
    };
    write(['a']);
    const root = registerAt(state);
    const holds = new Map([['socialGraph.start', gate.hold('socialGraph.start')], ['reception', gate.hold('reception')]]);
    const booting = root.start();
    await walk(['socialGraph.start', 'reception'], label => write(label === 'reception' ? ['a', 'b', 'c'] : ['a', 'b']), holds);
    await booting;
    const bag = await bagOf();
    const size = bag.scoreCache.size();
    const order = probe.events.filter(e => ['socialGraph.start', 'scoreCache.load', 'reception'].includes(e));
    await root.stop();
    expect({ size, order }).toEqual({ size: 2, order: ['socialGraph.start', 'scoreCache.load', 'reception'] });
  }, 30_000);
});

describe('C3 pin 4 — social-graph follow backfill (real bonds write) position (ruling §3)', () => {
  it('writes the followed bond row after socialGraph.start resolved and before the reception await', async () => {
    offline();
    const root = registerAt(newState());
    const followee = 'c3-followee-carol';
    const holds = new Map((['cadence.load', 'socialGraph.start', 'reception'] as const).map(l => [l as string, gate.hold(l)]));
    const booting = root.start();
    const followed: Record<string, number | null> = {};
    const bondRow = () => probe.hostDbs[0]!.queryOne<{ followed: number }>('SELECT followed FROM bonds WHERE popclaw_id = ?', [followee])?.followed ?? null;
    await walk(['cadence.load', 'socialGraph.start', 'reception'], label => {
      // Test seeding, not root behaviour: one declared follow in the real
      // follow log before SocialGraph.start reads it.
      if (label === 'cadence.load') {
        void new FollowEventStore(probe.hostDbs[0]!).append({ type: 'FollowDeclared', followee, followType: 'PUBLIC',
          tasteSubscribed: false, timestamp: 1_700_000_000, signature: 'c3-seed', houseSlug: HOUSE_SLUG });
      }
      followed[label] = bondRow();
    }, holds);
    await booting;
    const order = probe.events.filter(e => ['socialGraph.start', 'scoreCache.load', 'backfill', 'favorites.migrate', 'reception'].includes(e));
    await root.stop();
    expect({ followed, order }).toEqual({
      followed: { 'cadence.load': null, 'socialGraph.start': null, reception: 1 },
      order: ['socialGraph.start', 'scoreCache.load', 'backfill', 'favorites.migrate', 'reception'],
    });
  }, 30_000);
});

describe('C3 pin 5 — gateway-only phase work at its anchors (ruling §4)', () => {
  const PHASE = [
    'bootstrap', 'sentinels', 'build.record', 'houses.construct', 'worlds.construct', 'scraper', 'openHouseStores',
    'catalog.construct', 'cadence.load', 'socialGraph.start', 'scoreCache.load',
    'install.readLastBuild', 'ownerNotifier.deliverNow', 'integrity.run',
    'backfill', 'favorites.migrate', 'style.migrate', 'orchestrator.construct',
    'reception', 'reception.open', 'houses.configure', 'houses.start',
  ];

  it('sentinel + build record before houses/worlds, scraper after; install notice and integrity check start after socialGraph/scoreCache and before the migrations; the boot does not wait for the install delivery', async () => {
    offline();
    const state = newState();
    const paths = pathsOf(state);
    // An older recorded build (the dev test build never writes one itself), so
    // the install notice reaches ownerNotifier.deliverNow; a legacy favorites file for the migration.
    mkdirSync(dirname(paths.lastBuildFile()), { recursive: true });
    writeFileSync(paths.lastBuildFile(), JSON.stringify({ build: '0.0.1 2026-01-01 00:00+00 c3older', recordedAt: '2026-01-01T00:00:00.000Z' }));
    const favorites = join(paths.data(), 'favorites.jsonl');
    writeFileSync(favorites, `${JSON.stringify({ event_id: 'c3-fav', summary_line: 'x', ts: 1 })}\n`);
    const root = registerAt(state);
    const holds = new Map([['scraper', gate.hold('scraper')], ['socialGraph.start', gate.hold('socialGraph.start')],
      ['reception', gate.hold('reception')]]);
    const delivery = gate.hold('ownerNotifier.deliverNow');
    const disk: Record<string, { sentinel: boolean; favorites: boolean }> = {};
    const booting = root.start();
    const look = (label: string) => {
      disk[label] = { sentinel: existsSync(join(paths.rootDir(), 'README-DO-NOT-TOUCH.md')), favorites: existsSync(favorites) };
    };
    await walk(['scraper', 'socialGraph.start'], look, holds);
    // The install delivery is reached (and held) between socialGraph.start and
    // reception. The boot must move on to reception and finish while it is
    // still held. The timer only turns a would-be hang into a named failure;
    // the passing path never waits on it.
    await delivery.reached;
    const stall = (then: string) => new Promise<string>(done => {
      setTimeout(() => done(`boot stalled on the install delivery (${then})`), 5_000).unref();
    });
    const reachedReception = await Promise.race([holds.get('reception')!.reached.then(() => 'reached'), stall('before reception')]);
    if (reachedReception === 'reached') { look('reception'); holds.get('reception')!.release(); }
    const boot = reachedReception === 'reached'
      ? await Promise.race([booting.then(() => 'booted'), stall('after reception')])
      : reachedReception;
    delivery.release();
    holds.get('reception')!.release();
    await booting;
    const order = probe.events.filter(e => PHASE.includes(e));
    await root.stop();
    expect({ boot, disk, order }).toEqual({
      boot: 'booted',
      disk: {
        scraper: { sentinel: true, favorites: true },
        'socialGraph.start': { sentinel: true, favorites: true },
        reception: { sentinel: true, favorites: false },
      },
      order: PHASE,
    });
  }, 30_000);

  // The failed-boot drain at each anchor: what the root had registered for
  // cleanup when the fault fired. Faults are thrown AFTER the real call.
  const W = ['worldOwnerApproval.stop', 'native.stop', 'worlds.stop', 'houses.stop', 'worlds.whenIdle'];
  const TAIL = ['executionStores.close', 'release', 'hostDb.close'];
  const STORES = [`storeDb.close:${HOUSE_SLUG}`];
  const FAILS: Array<[string, 'fails' | 'swallowed', string[]]> = [
    ['bootstrap', 'fails', ['release', 'hostDb.close']],
    ['sentinels', 'swallowed', []],
    // Before houses/worlds exist: no house or world stop in the drain.
    ['build.record', 'fails', TAIL],
    // After houses/worlds: the full world+house drain.
    ['scraper', 'fails', [...W, ...TAIL]],
    // The stores openHouseStores just opened are not yet registered for close.
    ['openHouseStores', 'fails', [...W, ...TAIL]],
    ['cadence.load', 'swallowed', []],
    ['socialGraph.start', 'fails', [...W, ...STORES, ...TAIL]],
    ['scoreCache.load', 'fails', [...W, ...STORES, ...TAIL]],
    ['install.readLastBuild', 'swallowed', []],
    ['integrity.run', 'swallowed', []],
    ['backfill', 'swallowed', []],
    ['favorites.migrate', 'swallowed', []],
    ['style.migrate', 'swallowed', []],
    ['reception', 'fails', [...W, ...STORES, ...TAIL]],
  ];

  it.each(FAILS)('fault at %s → boot %s; failed-boot drain = %j', async (label, outcome, drain) => {
    offline();
    const root = registerAt(newState());
    gate.fail(label);
    const result = await root.start().then(() => 'booted', (e: unknown) => e as Error);
    const failed = result instanceof Error;
    const cleanup = probe.events.slice(probe.events.indexOf(`fault:${label}`) + 1);
    const after = { slots: ownerTurn(root), memo: MEMO_KEY in globalThis };
    if (failed) await rescue(); else await root.stop();
    if (label === 'integrity.run') {
      expect(root.logs).toContainEqual(expect.stringContaining(`integrity check failed (non-fatal): Error: ${C3_FORCED_FAILURE}`));
    }
    expect({
      faultFired: probe.events.includes(`fault:${label}`),
      outcome: failed ? 'fails' : 'swallowed',
      ...(failed ? { message: result.message, cleanup, after } : {}),
    }).toEqual({
      faultFired: true,
      outcome,
      ...(outcome === 'fails' ? {
        message: C3_FORCED_FAILURE, cleanup: drain, after: { slots: { filled: [], memo: false }, memo: false },
      } : {}),
    });
  }, 30_000);
});
