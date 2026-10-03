import { describe, expect, it, vi } from 'vitest';
import Ajv from 'ajv';
import { captureWorldCommandInput, runWorldPrivateMessagesCommand, WORLD_COMMAND_SCHEMAS, type WorldCommandContext } from '../../../src/commands/popclaw-world.js';
import { parseWorldCliArgs, runWorldCliCommand } from '../../../src/commands/world-cli.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { makeToolCollector, toMcpToolResult } from '../../../src/tools/mcp-adapter.js';

const house = 'https://world.invalid', revision = 'a'.repeat(64);
const binding = { expected_capability_revision: revision, expected_session_id: 'session_1' };
function fixture(result: unknown = { status: 'ok', items: [], nextCursor: null }) {
  const readPrivateMessages = vi.fn(async () => result);
  const readCapabilities = vi.fn(), client = vi.fn(), actionAuthority = vi.fn();
  const ctx: WorldCommandContext = { readPrivateMessages, readCapabilities, client, actionAuthority };
  return { ctx, readPrivateMessages, effects: [readCapabilities, client, actionAuthority] };
}

describe('private message command boundaries', () => {
  it('uses the shared schema for first-page and bound subsequent reads', () => {
    const validate = new Ajv({ strict: false }).compile(WORLD_COMMAND_SCHEMAS.private_messages);
    for (const input of [{ house }, { house, limit: 100 }, { house, cursor: 'cursor', ...binding },
      { house, message_id: 'message_1', ...binding }, { house, state_ref: 'state/1', ...binding },
      { house, expected_session_id: '🙂'.repeat(256) }]) {
      expect(validate(input)).toBe(true);
      expect(captureWorldCommandInput('private_messages', input)).toEqual(input);
    }
  });

  it.each([
    { actor: 'forged' }, { actor_id: 'forged' }, { limit: 0 }, { limit: 101 }, { limit: 1.5 },
    { cursor: '' }, { cursor: 'x'.repeat(4097), ...binding }, { expected_session_id: '🙂'.repeat(257) },
    { expected_capability_revision: 'A'.repeat(64) }, { message_id: 'bad space', ...binding },
    { message_id: 'm' }, { state_ref: 's' }, { cursor: 'c' },
    { cursor: 'c', expected_session_id: 'session_1' }, { cursor: 'c', expected_capability_revision: revision },
    { message_id: 'm', state_ref: 's', ...binding }, { cursor: 'c', message_id: 'm', ...binding },
    { cursor: 'c', state_ref: 's', ...binding },
    { house: 'https://world.invalid/' }, { house: 'https://WORLD.invalid' }, { house: 'https://world.invalid:443' },
  ])('rejects invalid input without accessing runtime: %j', async extra => {
    const f = fixture();
    await expect(runWorldPrivateMessagesCommand(f.ctx, { house, ...extra })).rejects.toThrow();
    expect(f.readPrivateMessages).not.toHaveBeenCalled();
    f.effects.forEach(effect => expect(effect).not.toHaveBeenCalled());
  });

  it('enforces cursor bytes and returns an explicit limit for an oversized complete result', async () => {
    expect(() => captureWorldCommandInput('private_messages', { house, cursor: '🙂'.repeat(1025), ...binding })).toThrow();
    const exact = { text: 'x'.repeat(16384 - 11) };
    expect(new TextEncoder().encode(JSON.stringify(exact))).toHaveLength(16384);
    expect(await runWorldPrivateMessagesCommand(fixture(exact).ctx, { house })).toEqual(exact);
    const oversized = { status: 'ok', complete: true, body: '🙂'.repeat(4096) };
    const f = fixture(oversized), result = await runWorldPrivateMessagesCommand(f.ctx, { house });
    expect(result).toEqual({ status: 'unavailable', code: 'SIZE_LIMIT' });
    expect(result).not.toHaveProperty('complete');
    f.effects.forEach(effect => expect(effect).not.toHaveBeenCalled());
  });

  it('reports unavailable when the optional read implementation is absent', async () => {
    const f = fixture(); delete f.ctx.readPrivateMessages;
    expect(await runWorldPrivateMessagesCommand(f.ctx, { house })).toEqual({ status: 'unavailable', code: 'WORLD_LOCAL_UNSUPPORTED' });
    f.effects.forEach(effect => expect(effect).not.toHaveBeenCalled());
  });

  it('returns identical JSON through shared, native/MCP and CLI entry points without authority', async () => {
    const payload = { house: { origin: house }, actor_id: 'actor', capability_revision: revision, session_id: 'session_1',
      status: 'ok', items: [{ messageId: 'm', body: { text: 'hello' }, local: { consumerPending: true } }], nextCursor: null };
    const f = fixture(payload), input = { house, limit: 2, cursor: 'cursor', ...binding };
    const collector = makeToolCollector();
    registerPopclawTools({ api: collector.api, runtime: vi.fn(), getWorldCommandContext: async () => f.ctx });
    const native = await collector.tools.find(t => t.name === 'popclaw_world_private_messages')!.execute('not-authority', input);
    const mcp = toMcpToolResult(native);
    expect(mcp.structuredContent).toEqual(payload);
    expect(JSON.parse((mcp.content[0] as { text: string }).text)).toEqual(payload);
    const args = parseWorldCliArgs(['private-messages', house, '--limit=2', '--cursor', 'cursor',
      '--expected-capability-revision', revision, '--expected-session-id=session_1']);
    expect(args).toEqual({ command: 'private_messages', input });
    expect(await runWorldCliCommand(f.ctx, args)).toEqual(payload);
    expect(await runWorldPrivateMessagesCommand(f.ctx, input)).toEqual(payload);
    expect(f.readPrivateMessages).toHaveBeenCalledTimes(3);
    expect(f.readPrivateMessages).toHaveBeenLastCalledWith(input);
    f.effects.forEach(effect => expect(effect).not.toHaveBeenCalled());
  });

  it('validates tool input before lazy context and captures the bound input before awaits', async () => {
    let resolve!: () => void;
    const wait = new Promise<void>(done => { resolve = done; });
    const f = fixture(), getter = vi.fn(async () => { await wait; return f.ctx; });
    const collector = makeToolCollector();
    registerPopclawTools({ api: collector.api, runtime: vi.fn(), getWorldCommandContext: getter });
    const tool = collector.tools.find(t => t.name === 'popclaw_world_private_messages')!;
    await expect(tool.execute('id', { house, message_id: 'm' })).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    const input = { house, message_id: 'm', ...binding }, running = tool.execute('id', input);
    input.message_id = 'changed'; input.expected_session_id = 'changed'; resolve(); await running;
    expect(f.readPrivateMessages).toHaveBeenCalledWith({ house, message_id: 'm', ...binding });
  });

  it.each([['message-id', 'message_id'], ['state-ref', 'state_ref']])('routes bound CLI %s selectors', async (flag, field) => {
    const f = fixture();
    const args = parseWorldCliArgs(['private-messages', house, `--${flag}=selected`,
      '--expected-capability-revision', revision, '--expected-session-id', 'session_1']);
    await runWorldCliCommand(f.ctx, args);
    expect(f.readPrivateMessages).toHaveBeenCalledWith({ house, [field]: 'selected', ...binding });
    f.effects.forEach(effect => expect(effect).not.toHaveBeenCalled());
  });

  it.each([
    ['--actor', 'forged'], ['--limit', '0'], ['--limit', '101'], ['--limit', '1.5'], ['--limit', '01'],
    ['--message-id', 'm'], ['--state-ref', 's'], ['--cursor', 'cursor'], ['--limit=1', '--limit=2'],
  ])('rejects invalid CLI selectors: %j', (...flags) => {
    expect(() => parseWorldCliArgs(['private-messages', house, ...flags])).toThrow();
  });
});
