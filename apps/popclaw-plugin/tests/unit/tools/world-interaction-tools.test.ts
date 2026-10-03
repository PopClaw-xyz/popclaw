import { describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { makeToolCollector, toInputSchema, toMcpToolResult } from '../../../src/tools/mcp-adapter.js';
import { firstReleaseView } from '../../fixtures/world/first-release-view.js';
import type { WorldActionAuthority } from '../../../src/world/action-client.js';
import { WORLD_COMMAND_SCHEMAS, WORLD_COMMAND_HELP, type WorldCommandContext } from '../../../src/commands/popclaw-world.js';

const origin = 'https://world.invalid';
const identity = '11111111111111111111111111111111';
const authority: WorldActionAuthority = { executionReference: { kind: 'owner_action' as const, reservationId: 'c'.repeat(64) },
  expiresAt: 2000000000, check() {}, record() {} };
const names = ['popclaw_world_capabilities', 'popclaw_world_private_messages', 'popclaw_world_invoke', 'popclaw_world_action_status'];
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

describe('one lazy world tool registration', () => {
  it('binds only native invoke to actual factory context and preserves host call ID, signal and captured input', async () => {
    const hostContext = { agentId: 'main', getRuntimeConfig: () => ({}) };
    const collector = makeToolCollector(), wait = deferred(), controller = new AbortController();
    const shared = vi.fn(), readCapabilities = vi.fn(() => null), captured: unknown[] = [];
    const context: WorldCommandContext = { readCapabilities, client: () => { throw new Error('NO_CLIENT'); } };
    registerPopclawTools({
      api: { ...collector.api, registerTool: (tool, opts) => collector.api.registerTool(typeof tool === 'function' ? tool(hostContext) : tool, opts) },
      runtime: vi.fn(), getWorldCommandContext: shared, runCommand: async work => { await wait.promise; return work(); },
      bindNativeWorldInvoke: actualContext => {
        expect(actualContext).toBe(hostContext);
        return async (callId, input, signal, work) => { captured.push(callId, input, signal); return work(context); };
      },
    });
    const invoke = collector.tools.find(tool => tool.name === names[2])!.execute as (id: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
    const params = { house: origin, kind: 'train.join', params: {}, expected_capability_revision: 'a'.repeat(64) };
    const running = invoke('host-call', params, controller.signal);
    params.house = 'https://changed.invalid'; wait.resolve();
    await expect(running).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
    expect(captured).toEqual(['host-call', { ...params, house: origin }, controller.signal]);
    expect(readCapabilities).toHaveBeenCalledWith(origin); expect(shared).not.toHaveBeenCalled();
  });

  it('registers the four schemas only with a context getter, without runtime or network bootstrap', () => {
    const runtime = vi.fn(async () => { throw new Error('UNEXPECTED_RUNTIME'); });
    const getWorldCommandContext = vi.fn(async () => { throw new Error('UNEXPECTED_CONTEXT'); });
    const enabled = makeToolCollector(), disabled = makeToolCollector();
    const baseline = registerPopclawTools({ api: disabled.api, runtime });
    expect(registerPopclawTools({ api: enabled.api, runtime, getWorldCommandContext })).toBe(baseline + 4);
    expect(enabled.tools.filter(t => names.includes(t.name)).map(t => t.name)).toEqual(names);
    expect(disabled.tools.some(t => names.includes(t.name))).toBe(false);
    expect(getWorldCommandContext).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled();
    expect(WORLD_COMMAND_HELP).toContain('popclaw world action-status');
    const schemas = Object.values(WORLD_COMMAND_SCHEMAS);
    enabled.tools.filter(t => names.includes(t.name)).forEach((tool, index) => {
      expect(toInputSchema(tool.parameters)).toEqual(schemas[index]);
      expect(tool).not.toHaveProperty('captureParameters');
      const validate = new Ajv({ strict: false }).compile(toInputSchema(tool.parameters));
      expect(validate({ house: origin, authority: 'forged' })).toBe(false);
    });
  });

  it('captures before runCommand and lazy context awaits, and keeps structured MCP data intact', async () => {
    const commandWait = deferred(), contextWait = deferred();
    const readCapabilities = vi.fn(() => null);
    const ctx: WorldCommandContext = { readCapabilities, client: () => { throw new Error('NO_CLIENT'); } };
    const collector = makeToolCollector();
    const getWorldCommandContext = vi.fn(async () => { await contextWait.promise; return ctx; });
    registerPopclawTools({ api: collector.api, runtime: async () => { throw new Error('NO_RUNTIME'); },
      getWorldCommandContext, runCommand: async work => { await commandWait.promise; return work(); } });
    const params = { house: origin };
    const running = collector.tools.find(t => t.name === names[0])!.execute('not-an-authority', params);
    params.house = 'https://changed.invalid'; commandWait.resolve();
    await vi.waitFor(() => expect(getWorldCommandContext).toHaveBeenCalledOnce());
    params.house = 'https://changed-again.invalid'; contextWait.resolve();
    const response = toMcpToolResult(await running);
    expect(readCapabilities).toHaveBeenCalledWith(origin);
    expect(response.structuredContent).toMatchObject({ house: { origin }, code: 'CAPABILITY_CONTEXT_INCOMPLETE' });
    expect(JSON.parse((response.content[0] as {text: string}).text)).toEqual(response.structuredContent);
  });

  it('rejects invalid model parameters before resolving context or entering command work', async () => {
    const collector = makeToolCollector(), getter = vi.fn(), runCommand = vi.fn();
    registerPopclawTools({ api: collector.api, runtime: vi.fn(), getWorldCommandContext: getter, runCommand });
    await expect(collector.tools.find(t => t.name === names[2])!.execute('owner-looking-id', {
      house: origin, kind: 'example.reply', params: {}, expected_capability_revision: 'a'.repeat(64), authority: {},
    })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(runCommand).not.toHaveBeenCalled();
  });

  it('binds MCP invoke without a host context and preserves call ID, signal and captured input', async () => {
    const collector = makeToolCollector(), controller = new AbortController();
    const shared = vi.fn(), readCapabilities = vi.fn(() => null), captured: unknown[] = [];
    const context: WorldCommandContext = { readCapabilities, client: () => { throw new Error('NO_CLIENT'); } };
    const binderCalls: unknown[] = [];
    registerPopclawTools({
      api: collector.api, runtime: vi.fn(), getWorldCommandContext: shared,
      bindMcpWorldInvoke: (...args: unknown[]) => {
        binderCalls.push(args);
        return async (callId, input, signal, work) => { captured.push(callId, input, signal); return work(context); };
      },
    });
    const invoke = collector.tools.find(tool => tool.name === names[2])!.execute as (id: string, input: unknown, signal: AbortSignal) => Promise<unknown>;
    const params = { house: origin, kind: 'train.join', params: {}, expected_capability_revision: 'a'.repeat(64) };
    const running = invoke('mcp_42', params, controller.signal);
    params.house = 'https://changed.invalid';
    await expect(running).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
    expect(captured).toEqual(['mcp_42', { ...params, house: origin }, controller.signal]);
    // The binder is resolved once, at registration, with no host context at all:
    // the collector resolves the factory with `{}`, and that never reaches here.
    expect(binderCalls).toEqual([[]]);
    expect(readCapabilities).toHaveBeenCalledWith(origin);
    expect(shared).not.toHaveBeenCalled();
  });

  it('repeats the owner confirmation reference in what the tool returns, and only when a dialog was shown', async () => {
    // W2: the dialog shows a reference because no request id exists yet. The
    // receipt has to repeat it, or nobody can tie the two together.
    const view = { request_id: 'd'.repeat(64), status: 'unknown' as const, code: 'ACTION_RESULT_UNKNOWN' };
    const ctx: WorldCommandContext = { readCapabilities: () => firstReleaseView(origin, identity, true),
      client: () => ({ invoke: async () => view, status: async () => view }),
      actionAuthority: () => authority };
    const params = { house: origin, kind: 'example.reply', params: {}, expected_capability_revision: 'a'.repeat(64) };
    const mcp = makeToolCollector();
    registerPopclawTools({ api: mcp.api, runtime: vi.fn(), getWorldCommandContext: vi.fn(),
      bindMcpWorldInvoke: () => async (_callId, _input, _signal, work) => work(ctx, 'a1b2c3') });
    const shown = toMcpToolResult(await mcp.tools.find(t => t.name === names[2])!.execute('mcp_1', params));
    expect(shown.structuredContent).toMatchObject({ request_id: view.request_id, owner_confirmation_ref: 'a1b2c3' });
    // The native lane shows no dialog, so it has no reference to repeat and
    // must not invent one.
    const native = makeToolCollector();
    registerPopclawTools({ api: { ...native.api, registerTool: (tool, opts) => native.api.registerTool(typeof tool === 'function' ? tool({}) : tool, opts) },
      runtime: vi.fn(), getWorldCommandContext: vi.fn(),
      bindNativeWorldInvoke: () => async (_callId, _input, _signal, work) => work(ctx) });
    const silent = toMcpToolResult(await native.tools.find(t => t.name === names[2])!.execute('native_1', params));
    expect(silent.structuredContent).not.toHaveProperty('owner_confirmation_ref');
  });

  it('tells the model that invoking again is a new action and names the status tool instead', async () => {
    const collector = makeToolCollector();
    registerPopclawTools({ api: collector.api, runtime: vi.fn(), getWorldCommandContext: vi.fn() });
    const invoke = collector.tools.find(t => t.name === names[2])!.description!;
    expect(invoke).toContain('creates a NEW action; it is never an idempotent retry of an earlier call');
    expect(invoke).toContain('this release resends nothing across calls');
    expect(invoke).toContain('Do not retry automatically after a decline, a timeout or an unknown outcome');
    expect(invoke).toContain('call popclaw_world_action_status with its request_id');
    expect(invoke).toContain('a second action that may duplicate the first');
    const status = collector.tools.find(t => t.name === names[3])!.description!;
    expect(status).toContain('Never creates a new action');
    expect(status).toContain('when popclaw_world_invoke returned an unknown outcome');
  });

  // A general aid: this House-session store and the owner's DM inbox both say
  // "private messages" (ordinary inbox DMs never land here), so the description
  // must say plainly it is not the DM inbox and name the tool that is. The
  // 2026-09-25 incident was not this: it was a wrong-direction before_id cursor.
  it('says private_messages is not the owner DM inbox and points at popclaw_show_inbox', () => {
    const collector = makeToolCollector();
    registerPopclawTools({ api: collector.api, runtime: vi.fn(), getWorldCommandContext: vi.fn() });
    const pm = collector.tools.find(t => t.name === names[1])!.description!;
    expect(pm).toContain('NOT the owner\'s ordinary DM inbox');
    expect(pm).toContain('use popclaw_show_inbox');
  });

  it('keeps the plain shared-context path when no invoke binder is provided', async () => {
    const collector = makeToolCollector();
    const readCapabilities = vi.fn(() => null);
    const ctx: WorldCommandContext = { readCapabilities, client: () => { throw new Error('NO_CLIENT'); } };
    const getWorldCommandContext = vi.fn(async () => ctx);
    registerPopclawTools({ api: collector.api, runtime: vi.fn(), getWorldCommandContext });
    await expect(collector.tools.find(t => t.name === names[2])!.execute('plain', {
      house: origin, kind: 'train.join', params: {}, expected_capability_revision: 'a'.repeat(64),
    })).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
    expect(getWorldCommandContext).toHaveBeenCalledOnce();
  });
});
