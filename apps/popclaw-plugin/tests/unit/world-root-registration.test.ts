import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstReleaseView } from '../fixtures/world/first-release-view.js';
import { toMcpToolResult } from '../../src/tools/mcp-adapter.js';
import { WORLD_COMMAND_SCHEMAS } from '../../src/commands/popclaw-world.js';
import type { PublicDisplayResult } from '../../src/ingress/public-feed-display.js';
import { _observedPostIdsForTest } from '../../src/world/post-ref.js';
import { createOpenClawWorldExecution } from '../../src/host/openclaw-world-execution.js';

const seam = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock('../../src/runtime/once.js', async original => {
  const actual = await original<typeof import('../../src/runtime/once.js')>();
  return { ...actual, getOrCreatePerProcess: <T>(key: string, factory: () => T): T =>
    key === 'runtime' ? seam.runtime() as T : actual.getOrCreatePerProcess(key, factory) };
});
vi.mock('../../src/lexicon/owner-language.js', async original => ({
  ...await original<typeof import('../../src/lexicon/owner-language.js')>(),
  ownerLang: () => 'en', observeOwnerText: vi.fn(),
}));
import plugin from '../../src/index.js';

const roots: string[] = [];
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); })));
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); _observedPostIdsForTest.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

function register(hostContext: unknown = {agentId: 'main', getRuntimeConfig: () => ({})}) {
  const state = mkdtempSync(join(tmpdir(), 'world-root-register-')); roots.push(state);
  const tools: Array<{ name: string; parameters: unknown; execute(id: string, params: unknown): Promise<unknown> }> = [];
  type Tool = typeof tools[number];
  type Factory = (context: unknown) => Tool | Tool[] | null | undefined;
  const factoryNames: string[] = [];
  const api = {
    registrationMode: 'full', config: {}, pluginConfig: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    runtime: { state: { resolveStateDir: () => state }, system: { enqueueSystemEvent: vi.fn(), runHeartbeatOnce: vi.fn() } },
    registerTool: (registration: Tool | Factory | { contextVersion: 2; create: Factory }, options?: { name?: string; names?: string[] }) => {
      const isFactory = typeof registration === 'function' || 'contextVersion' in registration;
      const resolved = typeof registration === 'function' ? registration(hostContext)
        : 'contextVersion' in registration ? registration.create(hostContext) : registration;
      for (const tool of Array.isArray(resolved) ? resolved : resolved ? [resolved] : []) {
        if (isFactory) {
          if (options?.names) expect(options.names).toContain(tool.name);
          else expect(tool.name).toBe(options?.name);
          factoryNames.push(tool.name);
        }
        tools.push(tool);
      }
    },
    registerCommand: vi.fn(), registerService: vi.fn(), registerInteractiveHandler: vi.fn(), on: vi.fn(),
  };
  plugin.register!(api as unknown as Parameters<NonNullable<typeof plugin.register>>[0]);
  return { tools, state, factoryNames };
}

/** A host that never asked the owner about anything: the case every test in
 *  this file is about, and the one the policy lane must keep handling exactly
 *  as it did before the owner lane existed. */
const neverAsked = () => ({ asked: () => false });

describe('world tools at the actual native plugin registration boundary', () => {
  it('registers each exact world schema without resolving runtime, writing state or fetching', () => {
    seam.runtime.mockImplementation(() => { throw new Error('UNEXPECTED_BOOTSTRAP'); });
    const fetch = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }); vi.stubGlobal('fetch', fetch);
    const { tools, state, factoryNames } = register();
    expect(factoryNames).toContain('popclaw_world_invoke');
    // The native route adapter now gives every ordinary world tool a trusted
    // factory context, while retaining the exact discoverable names/schemas.
    expect(factoryNames.filter(name => name.startsWith('popclaw_world_'))).toEqual([
      'popclaw_world_guide', 'popclaw_world_summary',
      ...Object.keys(WORLD_COMMAND_SCHEMAS).map(command => `popclaw_world_${command}`),
    ]);
    for (const [command, schema] of Object.entries(WORLD_COMMAND_SCHEMAS)) {
      const matching = tools.filter(tool => tool.name === `popclaw_world_${command}`);
      expect(matching).toHaveLength(1);
      expect(matching[0]!.parameters).toEqual(schema);
    }
    expect(seam.runtime).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(state)).toEqual([]);
  });

  it('rejects forged model authority before the root resolves command runtime', async () => {
    seam.runtime.mockImplementation(() => { throw new Error('UNEXPECTED_BOOTSTRAP'); });
    const { tools, state } = register();
    const tool = tools.find(candidate => candidate.name === 'popclaw_world_invoke');
    expect(tool).toBeDefined();
    await expect(tool!.execute('owner-looking-call-id', { house: 'https://world.invalid', kind: 'reading.annotate',
      params: { text: 'An annotation' }, expected_capability_revision: 'a'.repeat(64), authority: { owner: true } })).rejects.toThrow('WORLD_COMMAND_INPUT_INVALID');
    expect(seam.runtime).not.toHaveBeenCalled();
    expect(readdirSync(state)).toEqual([]);
  });

  it('keeps native mutation calls without a configured trusted policy out of action storage', async () => {
    const client = vi.fn(() => { throw new Error('UNEXPECTED_ACTION_STORAGE'); });
    const readCapabilities = vi.fn(() => null);
    const runCommand = vi.fn(async (work: () => Promise<unknown>) => work());
    const nativeCommandContext = vi.fn(() => { throw new Error('UNEXPECTED_NATIVE_PERMIT'); });
    const nativeWorldExecution = createOpenClawWorldExecution({actorId: '11111111111111111111111111111111', readActiveConfig: () => ({})});
    // No owner was asked about this call, so the root must fall through to the
    // policy lane — which is what this test is about. The runtime bag models
    // the real one: `worldOwnerApproval` is always present on a booted root,
    // so a fixture without it would only prove the root crashes.
    seam.runtime.mockResolvedValue({ houseRuntime: { runCommand }, nativeWorldExecution,
      worldOwnerApproval: neverAsked(), worldRuntime: { client, readCapabilities, nativeCommandContext } });
    const { tools, state } = register();
    const invoke = tools.find(tool => tool.name === 'popclaw_world_invoke')!;
    await expect(invoke.execute('owner-looking-call-id', { house: 'https://world.invalid', kind: 'reading.annotate',
      params: { text: 'An annotation' }, expected_capability_revision: 'a'.repeat(64) })).rejects.toThrow('NATIVE_POLICY_REQUIRED');
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(client).not.toHaveBeenCalled();
    // The real native policy gate rejects invoke before capability or storage access.
    expect(nativeCommandContext).not.toHaveBeenCalled(); expect(readCapabilities).not.toHaveBeenCalled();
    expect(readdirSync(state)).toEqual([]);
    nativeWorldExecution.stop();
  });

  it('rejects a missing factory context before issuing a permit or accessing action storage', async () => {
    const nativeCommandContext = vi.fn(), client = vi.fn(), readCapabilities = vi.fn();
    const nativeWorldExecution = createOpenClawWorldExecution({actorId: '11111111111111111111111111111111', readActiveConfig: () => ({})});
    seam.runtime.mockResolvedValue({ houseRuntime: {runCommand: async (work: () => Promise<unknown>) => work()}, nativeWorldExecution,
      worldOwnerApproval: neverAsked(), worldRuntime: {nativeCommandContext, client, readCapabilities} });
    const {tools, state} = register({});
    await expect(tools.find(tool => tool.name === 'popclaw_world_invoke')!.execute('host-call', {
      house: 'https://world.invalid', kind: 'reading.annotate', params: {}, expected_capability_revision: 'a'.repeat(64),
    })).rejects.toThrow('NATIVE_CONTEXT_REQUIRED');
    expect(nativeCommandContext).not.toHaveBeenCalled(); expect(client).not.toHaveBeenCalled();
    expect(readCapabilities).not.toHaveBeenCalled();
    expect(readdirSync(state)).toEqual([]);
    nativeWorldExecution.stop();
  });
  it('routes native private reads to the current runtime without action storage', async () => {
    const origin = 'https://world.invalid';
    const readPrivateMessages = vi.fn(async () => ({ status: 'ok', items: [], nextCursor: null }));
    const client = vi.fn(), readCapabilities = vi.fn();
    seam.runtime.mockResolvedValue({ houseRuntime: { runCommand: async (work: () => Promise<unknown>) => work() },
      worldRuntime: { readPrivateMessages, readCapabilities, client } });
    const { tools, state } = register();
    const response = await tools.find(tool => tool.name === 'popclaw_world_private_messages')!.execute('not-authority', { house: origin });
    expect(JSON.stringify(response)).toContain('nextCursor');
    expect(readPrivateMessages).toHaveBeenCalledWith({ house: origin });
    expect(client).not.toHaveBeenCalled(); expect(readCapabilities).not.toHaveBeenCalled();
    expect(readdirSync(state)).toEqual([]);
  });

  it.each(['🙂', '"\\\n'])('bounds the complete native private result near the byte limit for %j', async unit => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    const payload = (count: number) => ({ status: 'ok', complete: true, text: unit.repeat(count) });
    const wrapper = (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
    let count = 0;
    while (bytes(wrapper(payload(count + 1))) <= 16384) count++;
    const within = payload(count), beyond = payload(count + 1);
    expect(bytes(wrapper(within))).toBeLessThanOrEqual(16384);
    expect(bytes(wrapper(beyond))).toBeGreaterThan(16384);
    expect(bytes(beyond)).toBeLessThan(16384);
    const readPrivateMessages = vi.fn().mockResolvedValueOnce(within).mockResolvedValueOnce(beyond);
    const client = vi.fn(), readCapabilities = vi.fn();
    seam.runtime.mockResolvedValue({ houseRuntime: { runCommand: async (work: () => Promise<unknown>) => work() },
      worldRuntime: { readPrivateMessages, readCapabilities, client } });
    const { tools, state } = register();
    const tool = tools.find(candidate => candidate.name === 'popclaw_world_private_messages')!;
    const exact = await tool.execute('within', { house: 'https://world.invalid' });
    expect(exact).toEqual(wrapper(within));
    expect(bytes(exact)).toBeLessThanOrEqual(16384);
    expect(toMcpToolResult(exact)).toEqual(exact);
    const limited = await tool.execute('beyond', { house: 'https://world.invalid' });
    expect(limited).toEqual(wrapper({ status: 'unavailable', code: 'SIZE_LIMIT' }));
    expect(bytes(limited)).toBeLessThanOrEqual(16384);
    expect(toMcpToolResult(limited)).toEqual(limited);
    expect(client).not.toHaveBeenCalled(); expect(readCapabilities).not.toHaveBeenCalled();
    expect(readdirSync(state)).toEqual([]);
  });

  it('reports typed validity independently of local support through the actual native tool callback', async () => {
    const origin = 'https://world.invalid', readCapabilities = vi.fn(() => firstReleaseView(origin, '11111111111111111111111111111111'));
    const client = vi.fn();
    seam.runtime.mockResolvedValue({ houseRuntime: { runCommand: async (work: () => Promise<unknown>) => work() }, worldRuntime: { readCapabilities, client } });
    const { tools } = register();
    const response = await tools.find(tool => tool.name === 'popclaw_world_capabilities')!.execute('not-authority', { house: origin });
    expect(JSON.stringify(response)).toContain('WORLD_LOCAL_UNSUPPORTED');
    expect(JSON.stringify(response)).toContain('public_stream');
    expect(client).not.toHaveBeenCalled();
    expect(readCapabilities).toHaveBeenCalledWith(origin);
  });

  it('native show/search use the local port, resolve its authors and see later source observations without touching legacy sources or effects', async () => {
    const actor = '11111111111111111111111111111111', eventId = 'a'.repeat(64);
    const origin = 'https://local-public.invalid';
    let current: PublicDisplayResult = {
      items: [{ item: { platform: 'popclaw', platformPostId: eventId, eventId, authorPopclawId: actor,
        actorNickname: 'Local Alice', platformPostCreatedAt: 1_700_000_000, textPreview: 'Native root local evidence' },
        body: 'Native root local evidence', kind: 'post', relaySnapshot: false, mirrorSigner: false,
        source: { origin, slug: 'local-public', observedAt: 1_700_000_100, sequence: '1', logIncarnation: 'local-log' } }],
      sources: [{ origin, slug: 'local-public', capabilityRevision: 'b'.repeat(64), logIncarnation: 'local-log',
        history: false, incomplete: false, unavailable: false, truncated: false, observedAt: 1_700_000_100 }],
      truncated: false,
    };
    const read = vi.fn((query: { author?: string } = {}) => ({ ...current,
      items: current.items.filter(row => !query.author || row.item.authorPopclawId === query.author) }));
    const search = vi.fn(() => current);
    const legacy = vi.fn(() => { throw new Error('UNEXPECTED_LEGACY_SOURCE'); });
    const effects = vi.fn(() => { throw new Error('UNEXPECTED_DISPLAY_EFFECT'); });
    const runCommand = vi.fn(async (work: () => Promise<unknown>) => work());
    seam.runtime.mockResolvedValue({ publicFeedDisplay: { read, search }, houseRuntime: { runCommand },
      worldFeedClient: { fetchSnapshot: legacy }, worldFeedCache: { search: legacy },
      guideClient: { fetch: legacy }, summaryClient: { fetch: legacy },
      // `host` is no longer an effect. Since 4103ec80 (#582 — a gateway restart
      // in the same process adopted a CLOSED sqlite handle, found in Mira's
      // acceptance) every runtime access reads `runtime.host.db` to decide
      // whether the memo is stale. This test predates that fix by three days
      // and treated any host access as a display effect, so the guard's own
      // liveness check tripped its trap. An open handle is the shape it looks
      // for (isClosedRuntime: open !== false, closed !== true).
      get notifier() { return effects(); }, host: { db: { open: true } } });
    const fetch = vi.fn(() => { throw new Error('UNEXPECTED_NETWORK'); }); vi.stubGlobal('fetch', fetch);
    const { tools, state } = register();
    const show = tools.find(tool => tool.name === 'popclaw_show_feed')!;
    const find = tools.find(tool => tool.name === 'popclaw_search_feed')!;
    const displayed = await show.execute('local-show', { filter_by_author: 'Local Alice', limit: 3 });
    expect(JSON.stringify(displayed)).toContain('Native root local evidence');
    expect(JSON.stringify(displayed)).toContain(eventId);
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ author: actor, limit: 3 }));
    expect(JSON.stringify(await find.execute('local-search', { query: 'Native root', limit: 2 }))).toContain(eventId);
    expect(search).toHaveBeenCalledWith('Native root', 2);

    // The registered callbacks must consult the same live port on later calls;
    // they cannot freeze the first source set or substitute the old catalog.
    const laterId = 'c'.repeat(64), laterOrigin = 'https://later-public.invalid';
    current = { ...current,
      items: [{ ...current.items[0]!, item: { ...current.items[0]!.item, eventId: laterId, platformPostId: laterId },
        body: 'Later mounted source evidence', source: { ...current.items[0]!.source, origin: laterOrigin, slug: 'later-public' } }],
      sources: [{ ...current.sources[0]!, origin: laterOrigin, slug: 'later-public', history: true }],
    };
    for (const result of [await show.execute('history-show', {}), await find.execute('history-search', { query: 'Later mounted' })]) {
      const text = JSON.stringify(result);
      expect(text).toContain(laterId); expect(text).not.toContain(eventId);
      expect(text).toContain('Later mounted source evidence'); expect(text).toMatch(/history/i);
    }
    expect(legacy).not.toHaveBeenCalled(); expect(effects).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(4);
    expect(readdirSync(state)).toEqual([]);
  });

});
