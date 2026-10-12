import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CancelledNotificationSchema, ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpConfirmationLifecycle } from '../../../src/host/mcp-confirmation-lifecycle.js';
import { createMcpOwnerApproval } from '../../../src/host/mcp-owner-approval.js';
import { createMcpOwnerAuthorization, type OwnerGrant } from '../../../src/host/mcp-owner-authorization.js';
import { consumeOwnerApproval, ownerApprovalGranted, registerOwnerApprovalSubject, resetOwnerApprovals } from '../../../src/host/owner-approval.js';

const TOOL = 'shared_lifecycle_fixture';
const input = { house: 'http://127.0.0.1:48180', kind: 'test.note', params: { text: 'Fixture world action' },
  expected_capability_revision: 'b'.repeat(64) };
const accept = { action: 'accept' as const, content: { confirm: true } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  resetOwnerApprovals();
  registerOwnerApprovalSubject(TOOL, { canonicalize: p => JSON.stringify(p),
    describe: p => ({ kind: 'ask', title: `General ${JSON.stringify(p)}`, description: ['Fixture only'] }) });
});
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); resetOwnerApprovals(); });

async function connected() {
  const server = new Server({ name: 'lifecycle-test', version: '0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'local-fixture', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  const forms: Array<{ message: string; answer: ReturnType<typeof deferred<ElicitResult>> }> = [];
  const cancelled: unknown[] = [];
  client.setRequestHandler(ElicitRequestSchema, req => {
    const answer = deferred<ElicitResult>(); forms.push({ message: req.params.message, answer }); return answer.promise;
  });
  client.setNotificationHandler(CancelledNotificationSchema, req => { cancelled.push(req.params); });
  const warn = vi.fn();
  const lifecycle = createMcpConfirmationLifecycle({ server: { current: server }, logger: { warn } });
  const general = createMcpOwnerApproval({ server: { current: server }, lifecycle, elicitTimeoutMs: 2_000 });
  const world = createMcpOwnerAuthorization({ actorId: '1'.repeat(32), server: { current: server }, lifecycle,
    duplicates: { unresolved: () => [] }, elicitTimeoutMs: 2_000 });
  server.onerror = error => lifecycle.noteProtocolError(error);
  server.onclose = () => lifecycle.stop();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  cleanups.push(async () => { lifecycle.stop(); for (const form of forms) form.answer.resolve(accept); await client.close(); await server.close(); });
  let generalWrites = 0, worldWrites = 0;
  const generalCall = (ref: string, signal?: AbortSignal, backend = general) => backend.aroundDispatch(TOOL, { ref }, ref, signal, async () => {
    const result = consumeOwnerApproval(TOOL, { ref }, ref);
    if (result.decision === 'approved') generalWrites++;
    return result;
  });
  const worldCall = (ref: string, signal?: AbortSignal) => world.withInvocation(ref, input, signal, async ask => {
    const grant = await ask.authorize(input); grant.assertCurrent(); worldWrites++; return grant;
  });
  return { server, lifecycle, general, world, forms, cancelled, warn, generalCall, worldCall,
    writes: () => ({ general: generalWrites, world: worldWrites }) };
}

describe('one MCP confirmation lifetime owner', () => {
  it('wires the actual root and runtime World lane to the same owner', () => {
    const root = readFileSync(new URL('../../../src/mcp.ts', import.meta.url), 'utf8');
    const ports = readFileSync(new URL('../../../src/host/mcp-runtime-ports.ts', import.meta.url), 'utf8');
    expect(root.match(/createMcpConfirmationLifecycle\(/g)).toHaveLength(1);
    expect(root).toContain('lifecycle: confirmations');
    expect(root).toContain('approvalWindowMs, confirmations)');
    expect(root).toMatch(/const stop = \(\) => \{\s+confirmations\.stop\(\);\s+void lifecycle\.stop\(\)/);
    expect(root).toContain('server.onerror = error => confirmations.noteProtocolError(error)');
    expect(root).toContain('server.onclose = () => confirmations.stop()');
    expect(ports).toContain('lifecycle: input.confirmationLifecycle');
    expect(ports).toContain('confirmationLifecycle: input.confirmationLifecycle');
  });

  it('cancels one pending call while another general call and the World lane remain safe', async () => {
    const h = await connected(), abort = new AbortController();
    const one = h.generalCall('cancel-one', abort.signal), two = h.generalCall('keep-two'), world = h.worldCall('keep-world');
    await vi.waitFor(() => expect(h.forms).toHaveLength(3));
    abort.abort();
    expect(await one).toEqual({ decision: 'unavailable', reason: 'OWNER_CONFIRMATION_INACTIVE' });
    expect(h.writes()).toEqual({ general: 0, world: 0 });
    for (const form of h.forms.filter(f => !f.message.includes('cancel-one'))) form.answer.resolve(accept);
    expect(await two).toEqual({ decision: 'approved' });expect((await world).jobId).toMatch(/^mcp-owner:/);
    await vi.waitFor(() => expect(h.cancelled).toHaveLength(1));
    h.forms.find(f => f.message.includes('cancel-one'))!.answer.resolve(accept);
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(1));
    expect(h.writes()).toEqual({ general: 1, world: 1 });
    expect(consumeOwnerApproval(TOOL, { ref: 'cancel-one' }, 'cancel-one')).toMatchObject({ reason: 'ALREADY_CONSUMED' });
  });

  it('ending the shared owner drains pending requests in both domains and late answers grant nothing', async () => {
    const h = await connected();
    const general = h.generalCall('end-general');
    const world = h.worldCall('end-world').catch(error => String(error));
    await vi.waitFor(() => expect(h.forms).toHaveLength(2));
    h.lifecycle.stop();
    expect(await general).toEqual({ decision: 'unavailable', reason: 'OWNER_CONFIRMATION_INACTIVE' });
    expect(await world).toContain('OWNER_CONFIRMATION_INACTIVE');
    await vi.waitFor(() => expect(h.cancelled).toHaveLength(2));
    for (const form of h.forms) form.answer.resolve(accept);
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledTimes(2));
    expect(h.writes()).toEqual({ general: 0, world: 0 });
    expect(h.general.canAsk()).toBe(false);expect(() => h.world.assertActive()).toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
    for (const [context] of h.warn.mock.calls) expect(context).toMatchObject({ tool: null, call_ref: null });
  });

  it('transport end drains both domains through the root close callback', async () => {
    const h = await connected();
    const general = h.generalCall('transport-general');
    const world = h.worldCall('transport-world').catch(error => String(error));
    await vi.waitFor(() => expect(h.forms).toHaveLength(2));
    await h.server.close();
    expect((await general).decision).not.toBe('approved');expect(await world).not.toMatch(/^mcp-owner:/);
    expect(h.writes()).toEqual({ general: 0, world: 0 });
    expect(h.general.canAsk()).toBe(false);expect(() => h.world.assertActive()).toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
  });

  it('stopping one adapter cancels only its lane, including all of its concurrent general requests', async () => {
    const h = await connected();
    const one = h.generalCall('lane-one'), two = h.generalCall('lane-two'), world = h.worldCall('other-lane');
    await vi.waitFor(() => expect(h.forms).toHaveLength(3));h.general.stop();
    expect((await one).decision).not.toBe('approved');expect((await two).decision).not.toBe('approved');
    h.forms.find(f => f.message.includes('PopClaw: confirm world action'))!.answer.resolve(accept);
    await world;expect(h.writes()).toEqual({ general: 0, world: 1 });
    await vi.waitFor(() => expect(h.cancelled).toHaveLength(2));
  });

  it.each(['root', 'lane', 'call'] as const)('an accepted general answer cannot be consumed after %s cancellation while its body is held', async ending => {
    const h = await connected(), entered = deferred<void>(), finish = deferred<void>(), abort = new AbortController();
    let writes = 0;
    const pending = h.general.aroundDispatch(TOOL, {}, 'held-general', abort.signal, async () => {
      entered.resolve();await finish.promise;
      const result = consumeOwnerApproval(TOOL, {}, 'held-general');
      if (result.decision === 'approved') writes++;
      return result;
    });
    await vi.waitFor(() => expect(h.forms).toHaveLength(1));h.forms[0]!.answer.resolve(accept);await entered.promise;
    if (ending === 'root') h.lifecycle.stop();
    else if (ending === 'lane') h.general.stop();
    else abort.abort();
    expect(ownerApprovalGranted(TOOL, 'held-general')).toBe(false);
    finish.resolve();
    expect(await pending).toEqual({ decision: 'unavailable', reason: 'OWNER_CONFIRMATION_INACTIVE' });
    expect(writes).toBe(0);expect(h.cancelled).toHaveLength(0);
  });

  it('keeps a granted World lease current only within its callback and does not cancel an already answered form', async () => {
    const h = await connected(), entered = deferred<void>(), finish = deferred<void>();
    let held!: OwnerGrant;
    const running = h.world.withInvocation('held-grant', input, undefined, async ask => {
      held = await ask.authorize(input);held.assertCurrent();entered.resolve();await finish.promise;
    });
    await vi.waitFor(() => expect(h.forms).toHaveLength(1));h.forms[0]!.answer.resolve(accept);await entered.promise;
    h.lifecycle.stop();expect(() => held.assertCurrent()).toThrow('OWNER_CONFIRMATION_INACTIVE');
    finish.resolve();await running;expect(h.cancelled).toHaveLength(0);
  });

  it('ends World preparation during duplicate IO before any form or grant', async () => {
    const h = await connected(), lookup = deferred<readonly string[]>(), entered = deferred<void>();
    const world = createMcpOwnerAuthorization({ actorId: '1'.repeat(32), server: { current: h.server }, lifecycle: h.lifecycle,
      duplicates: { unresolved: () => { entered.resolve();return lookup.promise; } } });
    const pending = world.withInvocation('preparing', input, undefined, ask => ask.authorize(input)).catch(error => String(error));
    await entered.promise;h.lifecycle.stop();expect(await pending).toContain('OWNER_CONFIRMATION_INACTIVE');
    lookup.resolve([]);expect(h.forms).toHaveLength(0);
  });

  it('keeps malformed action policy distinct between adapters', async () => {
    const current = { getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: async () => ({ action: 'invalid' }) } as never;
    const lifecycle = createMcpConfirmationLifecycle({ server: { current } });
    const general = createMcpOwnerApproval({ server: { current }, lifecycle });
    const world = createMcpOwnerAuthorization({ actorId: '1'.repeat(32), server: { current }, lifecycle, duplicates: { unresolved: () => [] } });
    await general.aroundDispatch(TOOL, {}, 'malformed-general', undefined, async () => {
      expect(consumeOwnerApproval(TOOL, {}, 'malformed-general')).toMatchObject({ reason: 'OWNER_CONFIRMATION_FAILED' });
    });
    await expect(world.withInvocation('malformed-world', input, undefined, ask => ask.authorize(input)))
      .rejects.toThrow('OWNER_CONFIRMATION_DECLINED');
    lifecycle.stop();
  });
});
