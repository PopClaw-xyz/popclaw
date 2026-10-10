import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { peekPerProcess } from '../../../src/runtime/once.js';
import {
  askOwnerApprovalBeforeDispatch, consumeOwnerApproval, ownerApprovalBeforeToolCall,
  ownerApprovalGranted, ownerApprovalRecorded, registerOwnerApprovalSubject,
  resetOwnerApprovals, setOwnerApprovalSurface,
} from '../../../src/host/owner-approval.js';
import { createMcpOwnerApproval, mcpApprovalCallRef, type McpApprovalServerBox } from '../../../src/host/mcp-owner-approval.js';
import { dispatchMcpCall } from '../../../src/tools/mcp-adapter.js';

const TOOL = 'lifecycle_demo';
const accept = { action: 'accept', content: { confirm: true } };
let now = 1000;
const descriptor = {
  canonicalize: (params: unknown) => JSON.stringify(params),
  describe: () => ({ kind: 'ask' as const, title: 'Local fixture', description: ['No real operation'] }),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function backend(answer: () => Promise<unknown> = async () => accept) {
  const current = {
    elicitInput: vi.fn(answer),
    getClientCapabilities: () => ({ elicitation: { form: {} } }),
    getClientVersion: () => ({ name: 'claude-code', version: '2.1.278' }),
  } as unknown as NonNullable<McpApprovalServerBox['current']>;
  return createMcpOwnerApproval({ server: { current }, elicitTimeoutMs: 60_000, logger: { warn() {}, error() {} } });
}
function ledger() {
  return peekPerProcess<{
    records: Map<string, unknown>; consumed: Map<string, unknown>; originRefusals: Map<string, unknown>;
    mcpLiveCalls?: Map<string, unknown>;
  }>('owner-approval-call-ledger-v1')!;
}
function liveSize() { return ledger().mcpLiveCalls?.size ?? 0; }
beforeEach(() => {
  now = 1000;
  resetOwnerApprovals({ now: () => now });
  registerOwnerApprovalSubject(TOOL, descriptor);
});
afterEach(() => { vi.restoreAllMocks(); resetOwnerApprovals(); });

describe('MCP invocation identity', () => {
  it.each(['bad/id', undefined, 'duplicate'])('allocates independently of frozen clock and wire id %s', async requestId => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const refs = Array.from({ length: 100 }, () => mcpApprovalCallRef({ requestId }));
    expect(new Set(refs).size).toBe(100);
    for (const ref of refs) {
      expect(ref).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
      let bodyRef = '';
      await dispatchMcpCall({ execute: async id => { bodyRef = id; } }, {}, { requestId }, ref);
      expect(bodyRef).toBe(ref);
    }
  });
  it('pins the actual root to one allocation and an explicit unchanged ref', () => {
    const root = readFileSync(new URL('../../../src/mcp.ts', import.meta.url), 'utf8');
    expect(root.match(/const callRef = approvals\.callRef\(extra\)/g)).toHaveLength(1);
    expect(root).toMatch(/dispatchMcpCall\(tool, req\.params\.arguments, extra, callRef\)/);
    expect(root).not.toContain("callRef.slice('mcp_'.length)");
  });
  it('cannot spend an approval on a denied invocation with identical parameters', async () => {
    const a = mcpApprovalCallRef({ requestId: 'duplicate' });
    const b = mcpApprovalCallRef({ requestId: 'duplicate' });
    const approvedBody = deferred<void>();
    const entered = deferred<void>();
    const approved = backend().aroundDispatch(TOOL, {}, a, undefined, async () => {
      entered.resolve(); await approvedBody.promise;
      return consumeOwnerApproval(TOOL, {}, a);
    });
    await entered.promise;
    try {
      const denied = await backend(async () => ({ action: 'decline' })).aroundDispatch(TOOL, {}, b, undefined,
        async () => consumeOwnerApproval(TOOL, {}, b));
      expect(denied).toEqual({ decision: 'denied' });
    } finally { approvedBody.resolve(); }
    expect(await approved).toEqual({ decision: 'approved' });
  });
});

describe('MCP live-call leases', () => {
  it('keeps 65 pending dialogs through reads, new prepare, origin refusal and TTL sweep', async () => {
    const replies: ReturnType<typeof deferred<unknown>>[] = [];
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < 65; i++) {
      const reply = deferred<unknown>(), ready = deferred<void>();
      replies.push(reply);
      calls.push(backend(async () => { ready.resolve(); return reply.promise; }).aroundDispatch(
        TOOL, {}, `pending-${i}`, undefined, async () => consumeOwnerApproval(TOOL, {}, `pending-${i}`)));
      await ready.promise;
    }
    try {
      for (let i = 0; i < 100; i++) expect(ownerApprovalRecorded(TOOL, 'pending-0')).toBe(true);
      now += 900_001;
      await ownerApprovalBeforeToolCall({ toolName: TOOL, params: {}, toolCallId: 'unsafe' },
        { requester: { channel: 'tui', senderIsOwner: false }, toolCallId: 'unsafe' });
      await backend().aroundDispatch(TOOL, {}, 'new-prepare', undefined,
        async () => consumeOwnerApproval(TOOL, {}, 'new-prepare'));
      expect(liveSize()).toBe(65);
      for (let i = 0; i < 65; i++) expect(ownerApprovalRecorded(TOOL, `pending-${i}`)).toBe(true);
    } finally { replies.forEach(reply => reply.resolve(accept)); }
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 65 }, () => ({ decision: 'approved' })));
    expect(liveSize()).toBe(0);
    expect(ledger().records.size).toBe(0);
    expect(ledger().consumed.size).toBeLessThanOrEqual(64);
  });
  it.each(['grant', 'consumed'])('protects an answered %s until the body settles, not just until ask returns', async stage => {
    const entered = deferred<void>(), finish = deferred<void>();
    const call = backend().aroundDispatch(TOOL, {}, 'paused-body', undefined, async () => {
      if (stage === 'consumed') expect(consumeOwnerApproval(TOOL, {}, 'paused-body')).toEqual({ decision: 'approved' });
      entered.resolve(); await finish.promise;
      return consumeOwnerApproval(TOOL, {}, 'paused-body');
    });
    await entered.promise;
    try {
      now += 900_001;
      for (let i = 0; i < 70; i++) await backend().aroundDispatch(TOOL, {}, `later-${i}`, undefined,
        async () => consumeOwnerApproval(TOOL, {}, `later-${i}`));
      expect(ownerApprovalGranted(TOOL, 'paused-body')).toBe(stage === 'grant');
      expect(ownerApprovalRecorded(TOOL, 'paused-body')).toBe(true);
      expect(liveSize()).toBe(1);
    } finally { finish.resolve(); }
    expect(await call).toEqual(stage === 'grant' ? { decision: 'approved' }
      : { decision: 'unavailable', reason: 'ALREADY_CONSUMED' });
    expect(liveSize()).toBe(0);
  });
  it.each(['allow', 'deny', 'refused', 'body-throw', 'before-throw', 'ask-error', 'consume', 'unconsumed', 'unregistered'])(
    'releases and bounds finished records on %s', async ending => {
      if (ending === 'refused') registerOwnerApprovalSubject(TOOL, { ...descriptor,
        describe: () => ({ kind: 'refuse' as const, reason: 'SYNTHETIC_REFUSAL' }) });
      const approvals = backend(async () => {
        if (ending === 'ask-error') throw new Error('synthetic ask failed');
        return ending === 'deny' ? { action: 'decline' } : accept;
      });
      if (ending === 'before-throw') vi.spyOn(approvals, 'beforeDispatch').mockRejectedValue(new Error('synthetic'));
      for (let i = 0; i < 75; i++) {
        const ref = `${ending}-${i}`;
        const tool = ending === 'unregistered' ? 'unregistered_fixture' : TOOL;
        const call = approvals.aroundDispatch(tool, {}, ref, undefined, async () => {
          expect(liveSize()).toBe(1);
          if (ending === 'body-throw') throw new Error('synthetic');
          if (ending === 'consume') expect(consumeOwnerApproval(TOOL, {}, ref)).toEqual({ decision: 'approved' });
        });
        if (ending.endsWith('throw')) await expect(call).rejects.toThrow('synthetic');
        else await call;
        expect(liveSize()).toBe(0);
        expect(ledger().records.size).toBe(0);
        expect(ledger().originRefusals.size).toBe(0);
        expect(ledger().consumed.size).toBeLessThanOrEqual(64);
        expect(ownerApprovalGranted(TOOL, ref)).toBe(false);
      }
      expect(ledger().consumed.size).toBe(['before-throw', 'refused', 'unregistered'].includes(ending) ? 0 : 64);
    });
  it('does not let a reset call\'s old finally clear its replacement lease or grant', async () => {
    const first = deferred<void>(), second = deferred<void>();
    const firstEntered = deferred<void>(), secondEntered = deferred<void>();
    const approvals = backend();
    const old = approvals.aroundDispatch(TOOL, {}, 'reused-after-reset', undefined, async () => {
      firstEntered.resolve(); await first.promise;
    });
    await firstEntered.promise;
    resetOwnerApprovals({ now: () => now }); registerOwnerApprovalSubject(TOOL, descriptor);
    const replacement = approvals.aroundDispatch(TOOL, {}, 'reused-after-reset', undefined, async () => {
      secondEntered.resolve(); await second.promise;
      return consumeOwnerApproval(TOOL, {}, 'reused-after-reset');
    });
    await secondEntered.promise;
    try {
      first.resolve(); await old;
      expect(liveSize()).toBe(1);
      expect(ownerApprovalGranted(TOOL, 'reused-after-reset')).toBe(true);
    } finally { second.resolve(); }
    expect(await replacement).toEqual({ decision: 'approved' });
    expect(liveSize()).toBe(0);
  });
  it('cannot resurrect a reset request when its asynchronous description returns', async () => {
    const entered = deferred<void>(), description = deferred<ReturnType<typeof descriptor.describe>>();
    let descriptions = 0, oldAsks = 0;
    const slow = { ...descriptor, describe: async () => {
      if (++descriptions === 1) { entered.resolve(); return description.promise; }
      return descriptor.describe();
    } };
    registerOwnerApprovalSubject(TOOL, slow);
    const old = backend(async () => { oldAsks++; return accept; }).aroundDispatch(TOOL, {}, 'reset-during-describe', undefined,
      async () => consumeOwnerApproval(TOOL, {}, 'reset-during-describe'));
    await entered.promise;
    resetOwnerApprovals({ now: () => now });
    // Re-register the same object deliberately: descriptor equality alone
    // cannot distinguish the old call from a request admitted after reset.
    registerOwnerApprovalSubject(TOOL, slow);
    await backend().aroundDispatch(TOOL, {}, 'after-description-reset', undefined,
      async () => consumeOwnerApproval(TOOL, {}, 'after-description-reset'));
    description.resolve(descriptor.describe());
    expect((await old).decision).not.toBe('approved');
    expect(oldAsks).toBe(0);
    expect(ownerApprovalRecorded(TOOL, 'reset-during-describe')).toBe(false);
    expect(ledger().records.size).toBe(0);
    expect(liveSize()).toBe(0);
  });
  it('preserves native/unleased expiry and the existing pre-insert capacity cleanup', async () => {
    setOwnerApprovalSurface(true);
    await askOwnerApprovalBeforeDispatch(TOOL, {}, 'native-expired', async () => 'allow-once');
    now += 900_001;
    await askOwnerApprovalBeforeDispatch(TOOL, {}, 'native-next', async () => 'deny');
    expect(ownerApprovalRecorded(TOOL, 'native-expired')).toBe(false);
    for (let i = 0; i < 65; i++) await askOwnerApprovalBeforeDispatch(TOOL, {}, `native-${i}`, async () => 'deny');
    expect(ledger().records.size).toBe(64);
    expect(ownerApprovalRecorded(TOOL, 'native-0')).toBe(false);
    expect(ownerApprovalRecorded(TOOL, 'native-64')).toBe(true);
  });
});
