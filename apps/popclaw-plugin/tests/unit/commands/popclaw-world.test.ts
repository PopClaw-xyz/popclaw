import { describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { firstReleaseView } from '../../fixtures/world/first-release-view.js';
import type { WorldActionAuthority } from '../../../src/world/action-client.js';
import {
  captureWorldCommandInput, runWorldCapabilitiesCommand, runWorldInvokeCommand, runWorldActionStatusCommand,
  type WorldCommandContext,
} from '../../../src/commands/popclaw-world.js';

const origin = 'https://world.invalid', revision = 'a'.repeat(64), requestId = 'b'.repeat(64);
const identity = '11111111111111111111111111111111';
const now = '2026-09-08T00:00:00Z';
const input = () => ({ house: origin, kind: 'example.reply', params: { text: 'original' }, expected_capability_revision: revision });
const authority: WorldActionAuthority = { executionReference: {kind: 'owner_action' as const, reservationId: 'c'.repeat(64)}, expiresAt: 2000000000, check() {}, record() {} };
const caps = firstReleaseView(origin, identity, true);
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function context(overrides: Partial<WorldCommandContext> = {}) {
  const invoke = vi.fn(async () => ({ request_id: requestId, status: 'unknown' as const, code: 'ACTION_RESULT_UNKNOWN' }));
  const status = vi.fn(async () => ({ request_id: requestId, status: 'unknown' as const, code: 'ACTION_RESULT_UNKNOWN' }));
  const client = vi.fn(() => ({ invoke, status }));
  const readCapabilities = vi.fn(() => caps);
  const ctx: WorldCommandContext = { readCapabilities, client, now: () => now, ...overrides };
  return { ctx, client, invoke, status, readCapabilities };
}

describe('frozen world commands', () => {
  it('reports caught-up public raw reception separately from unsupported social effects', async () => {
    const observed = firstReleaseView(origin, identity);
    const f = context({ readCapabilities: () => observed, readPublicStatus: () => ({ mode: 'public-v1', support: 'supported', transport: 'active', detail: '',
      consumers: { cache: 'unsupported', notifications: 'unsupported', ranger: 'unsupported' },
      receive: { bindingId: 'binding', logIncarnation: 'log_1', phase: 'live', connected: true, caughtUp: true, publicAfter: '7', scopes: [],
        checkpointHighWater: '7', replayHighWater: '7', gapReason: null, errorCode: null } }) });
    const result = await runWorldCapabilitiesCommand(f.ctx, { house: origin });
    expect(result).toMatchObject({ context_complete: false, code: 'WORLD_LOCAL_UNSUPPORTED',
      blocks: { public_stream: { support: 'supported', ready: true }, actions: { support: 'unsupported', ready: false } },
      public_reception: { consumers: { cache: 'unsupported', notifications: 'unsupported', ranger: 'unsupported' } } });
    expect(observed.publicStream.support).toBe('unsupported');
    expect(f.client).not.toHaveBeenCalled();
  });
  it('keeps durable receipt, House result and unresolved local accounting separate', async () => {
    const f = context({ client: () => ({ invoke: async () => { throw new Error('UNEXPECTED_INVOKE'); },
      status: async () => ({ request_id: requestId, status: 'succeeded', code: 'OK', house_status: 'succeeded', receipt_durable: true,
        attachment_contract: { outcome: 'valid', reason: 'BASE_ONLY' },
        base_accounting: { state: 'pending', reason: 'ACTION_ACCOUNTING_HELD', executionReference: { kind: 'owner_action', reservationId: 'c'.repeat(64) } },
        attachments: [], installed_readiness: false }) }) });
    const result = await runWorldActionStatusCommand(f.ctx, { house: origin, request_id: requestId });
    expect(result).toMatchObject({ house_status: 'succeeded', receipt_durable: true, base_accounting: { state: 'pending' },
      attachment_contract: { outcome: 'valid' }, installed_readiness: false, attachments: [] });
  });
  it('points an unknown outcome at the original request and away from a second invoke', async () => {
    // W2: every confirmation mints a fresh nonce and a fresh job, so a second
    // invoke is a second business action and never an idempotent retry of this
    // one. The result has to say which tool actually answers "what happened".
    const f = context({ actionAuthority: () => authority });
    for (const result of [await runWorldActionStatusCommand(f.ctx, { house: origin, request_id: requestId }),
      await runWorldInvokeCommand(f.ctx, input())]) {
      expect(result).toMatchObject({ request_id: requestId, status: 'unknown', code: 'ACTION_RESULT_UNKNOWN' });
      const next = result.next_step as string;
      // The original request, by its full id, and the tool that reads it.
      expect(next).toContain(requestId);
      expect(next).toContain('query this same request with popclaw_world_action_status');
      // And the thing not to do, said as plainly as the ruling words it.
      expect(next).toContain('Do not call popclaw_world_invoke again unless the owner means to create a NEW action');
      expect(next).toContain('a second action that may duplicate this one, never a retry of it');
    }
    // A resolved outcome carries no such pointer: there is nothing to query.
    const settled = await runWorldActionStatusCommand(context({ client: () => ({ invoke: vi.fn(),
      status: async () => ({ request_id: requestId, status: 'succeeded' as const, code: 'OK' }) }) }).ctx,
    { house: origin, request_id: requestId });
    expect(settled).not.toHaveProperty('next_step');

    // `unknown` also covers "a result arrived that this client cannot read",
    // where the house may well have acted — so it does not say "the outcome is
    // unknown", which would understate it, while the advice is the same.
    const unreadable = await runWorldActionStatusCommand(context({ client: () => ({ invoke: vi.fn(),
      status: async () => ({ request_id: requestId, status: 'unknown' as const, code: 'ACTION_CONTEXT_UNSUPPORTED' }) }) }).ctx,
    { house: origin, request_id: requestId });
    const unreadableNext = unreadable.next_step as string;
    expect(unreadableNext).toContain(`request ${requestId} has a result this client cannot read (ACTION_CONTEXT_UNSUPPORTED)`);
    expect(unreadableNext).toContain('may already have happened');
    expect(unreadableNext).not.toContain('the outcome of request');
    expect(unreadableNext).toContain('query this same request with popclaw_world_action_status');
    expect(unreadableNext).toContain('Do not call popclaw_world_invoke again unless the owner means to create a NEW action');
  });
  it('reads real local capabilities without opening a client or inventing missing bindings', async () => {
    const f = context();
    const result = await runWorldCapabilitiesCommand(f.ctx, { house: origin });
    expect(result).toMatchObject({ house: { origin, house_key: identity, incarnation: 'inc_1' }, capability_revision: revision,
      context_complete: false, guide_bound: true, initial_public_scopes: ['sc_public'],
      intent_kinds: ['example.reply'], event_kinds: [],
      limits: { L_PARAMS_MAX_BYTES: 16384, L_JSON_MAX_DEPTH: 8 } });
    expect(f.client).not.toHaveBeenCalled();
    const missing = await runWorldCapabilitiesCommand(context({ readCapabilities: () => null }).ctx, { house: origin });
    expect(missing).toMatchObject({ house: { origin }, context_complete: false, guide_bound: false, code: 'CAPABILITY_CONTEXT_INCOMPLETE' });
    expect(missing.house).not.toHaveProperty('house_key');
    expect(missing).not.toHaveProperty('guide_unavailable');
  });

  it('rejects unsupported first-release invokes before authority or accounting', async () => {
    const actionAuthority = vi.fn(() => authority);
    const f = context({ readCapabilities: () => firstReleaseView(origin, identity), actionAuthority });
    await expect(runWorldInvokeCommand(f.ctx, input())).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
    expect(actionAuthority).not.toHaveBeenCalled();
    expect(f.client).not.toHaveBeenCalled();
  });

  it('rejects injected fields and an absent authority before accessing a client', async () => {
    const f = context();
    for (const field of ['authority', 'session_id', 'fence', 'valid_until', 'callId']) {
      await expect(runWorldInvokeCommand(f.ctx, { ...input(), [field]: 'forged' })).rejects.toThrow();
    }
    await expect(runWorldInvokeCommand(f.ctx, input())).rejects.toThrow('ACTION_AUTHORITY_REQUIRED');
    expect(f.client).not.toHaveBeenCalled();
  });

  it('snapshots input across async authorization and prevents authority callbacks rewriting it', async () => {
    const wait = deferred(), supplied = input();
    const authorize = vi.fn(async (captured) => { try { captured.params.text = 'callback rewrite'; } catch { /* frozen */ } await wait.promise; return authority; });
    const f = context({ actionAuthority: authorize });
    const running = runWorldInvokeCommand(f.ctx, supplied);
    supplied.params.text = 'caller rewrite'; supplied.kind = 'example.other';
    wait.resolve(); await running;
    expect(f.invoke).toHaveBeenCalledWith(input(), authority);
    expect(f.invoke).toHaveBeenCalledOnce();
  });

  it('rejects non-JSON argument values before invoking authorization', async () => {
    const actionAuthority = vi.fn(() => authority), f = context({ actionAuthority });
    const array = ['value']; Object.assign(array, { authority: 'not JSON' });
    for (const params of [{ value: undefined }, { value: 9007199254740992 }, { value: new Date() }, { value: array }]) {
      await expect(runWorldInvokeCommand(f.ctx, { ...input(), params })).rejects.toThrow();
    }
    expect(actionAuthority).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled();
  });

  it('preserves exact action/progress uint64 values and decoded zero defaults in status', async () => {
    const result = popclaw.world.ActionResult.fromObject({ status: 3, statusRevision: '18446744073709551615', requestId, code: 'OK' });
    const progress = popclaw.world.SubscriptionObservation.decode(popclaw.world.SubscriptionObservation.encode({
      observationRevision: '9007199254740993', publishedThrough: [{ scopeId: 'sc_public' }],
    }).finish());
    const status = vi.fn(async () => ({ request_id: requestId, status: 'succeeded' as const, code: 'OK', result, progress }));
    const f = context({ client: () => ({ invoke: vi.fn(), status }) });
    const rendered = await runWorldActionStatusCommand(f.ctx, { house: origin, request_id: requestId });
    expect(rendered).toMatchObject({ request_id: requestId, status: 'succeeded', code: 'OK',
      result: { status_revision: '18446744073709551615', committed_at: '1970-01-01T00:00:00Z' },
      progress: { observation_revision: '9007199254740993', high_water_seq: '0', published_through: [{ scope_id: 'sc_public', through_seq: '0' }] } });
    expect(status).toHaveBeenCalledWith(requestId);
    expect(f.readCapabilities).not.toHaveBeenCalled();
  });

});

describe('capabilities event selector validation (shared native/MCP/CLI input)', () => {
  const valid = () => ({ house: origin });
  const expectInvalid = (value: Record<string, unknown>) =>
    expect(() => captureWorldCommandInput('capabilities', value)).toThrow();
  it('accepts an event explanation read and a body-schema page read', () => {
    expect(captureWorldCommandInput('capabilities', {...valid(), event_kind: 'me.post'}))
      .toMatchObject({house: origin, event_kind: 'me.post'});
    expect(captureWorldCommandInput('capabilities', {...valid(), event_kind: 'world.notice', schema: 'body', schema_offset: 0}))
      .toMatchObject({event_kind: 'world.notice', schema: 'body', schema_offset: 0});
  });
  it('rejects conflicting or ambiguous event/action selectors instead of guessing', () => {
    expectInvalid({...valid(), kind: 'example.reply', event_kind: 'me.post'});
    expectInvalid({...valid(), event_kind: 'me.post', guide_offset: 0});
    expectInvalid({...valid(), event_kind: 'me.post', schema: 'params'});
    expectInvalid({...valid(), kind: 'example.reply', schema: 'body'});
    expectInvalid({...valid(), schema: 'body'});
    expectInvalid({...valid(), event_kind: 'NOT_A_KIND'});
  });
  it('serves the same event read through the shared command path with honest local state', async () => {
    const readAgentContext = vi.fn(() => ({status: 'unavailable' as const, code: 'WORLD_CONTEXT_READ_REQUIRED'}));
    const f = context({readAgentContext});
    const result = await runWorldCapabilitiesCommand(f.ctx, { house: origin, event_kind: 'me.post' });
    expect(result).toMatchObject({view: 'agent_context', selected_event: null,
      agent_context: {status: 'unavailable', code: 'WORLD_CONTEXT_READ_REQUIRED'}});
    expect(result).not.toHaveProperty('blocks');
    expect(readAgentContext).toHaveBeenCalledWith(expect.objectContaining({event_kind: 'me.post'}));
  });
});
