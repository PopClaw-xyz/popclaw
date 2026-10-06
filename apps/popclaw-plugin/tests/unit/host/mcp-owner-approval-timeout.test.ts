/**
 * The approval window, measured against the REAL SDK rather than a fake.
 *
 * What happened on Claude Code: the server's 120 s timeout fired and sent
 * `notifications/cancelled`, the host left its dialog open, the owner approved
 * at 146 s, and that approval vanished without a word. These tests pin the
 * three facts that make the fix correct — the SDK does cancel, a late answer
 * reaches `onerror` and nowhere else, and it never sends — plus what the owner
 * is told and the knob that sets the window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CancelledNotificationSchema, ElicitRequestSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import {
  OWNER_APPROVAL_WINDOW_MS, consumeOwnerApproval, registerOwnerApprovalSubject, resetOwnerApprovals,
  type OwnerApprovalSubjectDescriptor,
} from '../../../src/host/owner-approval.js';
import {
  OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT, OWNER_APPROVAL_TIMEOUT_BOUNDS,
  OWNER_APPROVAL_TIMEOUT_ENV, createMcpOwnerApproval, ownerApprovalTimeoutFromEnv,
} from '../../../src/host/mcp-owner-approval.js';
import { renderCopy } from '../../../src/lexicon/index.js';

const TOOL = 'demo_send';
const descriptor: OwnerApprovalSubjectDescriptor = {
  canonicalize: params => JSON.stringify(params ?? null),
  describe: () => ({ kind: 'ask', title: 'Send?', description: ['SECRET-LETTER-BODY'] }),
};

beforeEach(() => { resetOwnerApprovals(); registerOwnerApprovalSubject(TOOL, descriptor); });
afterEach(() => { resetOwnerApprovals(); });

/** A real Server and Client joined in memory. The client answers each dialog
 *  after `answerAfterMs`, with accept + confirm true: the owner saying yes. */
async function connected(answerAfterMs: number, elicitTimeoutMs: number) {
  const server = new Server({ name: 'popclaw-test', version: '0' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'claude-code', version: '0' }, { capabilities: { elicitation: { form: {} } } });
  const answered: number[] = [];
  const cancelled: unknown[] = [];
  client.setRequestHandler(ElicitRequestSchema, async () => {
    await new Promise(r => setTimeout(r, answerAfterMs));
    answered.push(Date.now());
    return { action: 'accept' as const, content: { confirm: true } };
  });
  client.setNotificationHandler(CancelledNotificationSchema, n => { cancelled.push(n.params); });
  const warn = vi.fn();
  const approvals = createMcpOwnerApproval({ server: { current: server }, logger: { warn }, elicitTimeoutMs });
  // Exactly the wiring `src/mcp.ts` does.
  server.onerror = (error) => approvals.noteProtocolError(error);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  let sends = 0;
  let outcome: ReturnType<typeof consumeOwnerApproval> | undefined;
  const call = (callRef: string, signal?: AbortSignal) => approvals.aroundDispatch(TOOL, { draft: 1 }, callRef, signal, async () => {
    outcome = consumeOwnerApproval(TOOL, { draft: 1 }, callRef);
    if (outcome.decision === 'approved') sends++;
    return outcome;
  });
  return {
    call, warn, answered, cancelled, approvals, sends: () => sends, outcome: () => outcome,
    close: async () => { await client.close(); await server.close(); },
  };
}

const settle = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('an approval that arrives after the window closed', () => {
  it('sends nothing, is told why in words, and is logged once with no content', async () => {
    const h = await connected(150, 40);
    try {
      const result = await h.call('mcp_7');
      // The tool call has RETURNED — there is nothing left to attach a late answer to.
      expect(result).toEqual({ decision: 'timeout' });
      expect(h.sends()).toBe(0);
      // FACT 1: the SDK itself told the host to close the dialog.
      await settle(20);
      expect(h.cancelled).toHaveLength(1);
      // And the -32001 the owner saw on the wire is OURS: the SDK's own
      // RequestTimeout, stringified into that cancellation's reason.
      expect(h.cancelled[0]).toMatchObject({ reason: expect.stringContaining('MCP error -32001: Request timed out') });

      // The owner approves at 150 ms, 110 ms after the window closed.
      await settle(200);
      expect(h.answered).toHaveLength(1);
      // FACT 3: it never becomes a send, and it cannot be spent afterwards either.
      expect(h.sends()).toBe(0);
      expect(consumeOwnerApproval(TOOL, { draft: 1 }, 'mcp_7'))
        .toEqual({ decision: 'unavailable', reason: 'ALREADY_CONSUMED' });

      // FACT 2: it is seen — once, through the visible logger, content-free.
      expect(h.warn).toHaveBeenCalledTimes(1);
      const [context, message] = h.warn.mock.calls[0]!;
      expect(context).toEqual({ tool: TOOL, call_ref: 'mcp_7', reason: OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT });
      expect(JSON.stringify([context, message])).not.toMatch(/SECRET-LETTER-BODY|accept|confirm/);
    } finally { await h.close(); }
  });

  /**
   * THE SEND LANE HAS NO SECOND GATE. The world lane re-checks its grant before
   * pushing; a draft is sent on `approved` alone. So a host that ends the call
   * while the dialog is open must never be read as consent here, and must not
   * be remembered as a window we closed (that would misattribute a late answer).
   */
  it('a host abort while the dialog is open sends nothing and is not an abandoned window', async () => {
    const h = await connected(150, 2_000);
    try {
      const abort = new AbortController();
      setTimeout(() => abort.abort('host cancelled the tool call'), 30);
      expect(await h.call('mcp_30', abort.signal))
        .toEqual({ decision: 'unavailable', reason: 'OWNER_CONFIRMATION_INACTIVE' });
      expect(h.sends()).toBe(0);
      await settle(200);
      expect(h.answered).toHaveLength(1);
      expect(h.sends()).toBe(0);
      for (const [context] of h.warn.mock.calls) expect((context as { call_ref: unknown }).call_ref).not.toBe('mcp_30');
      // Nothing was remembered as abandoned: an orphaned answer now is unattributed.
      h.warn.mockClear();
      h.approvals.noteProtocolError(new Error('Received a response for an unknown message ID: {"jsonrpc":"2.0","id":0,"result":{"action":"accept"}}'));
      expect(h.warn.mock.calls[0]![0]).toEqual({ tool: null, call_ref: null, reason: OWNER_APPROVAL_ANSWERED_AFTER_TIMEOUT });
    } finally { await h.close(); }
  });

  it('within the window, accept with confirm === true sends exactly once', async () => {
    const h = await connected(5, 2_000);
    try {
      expect(await h.call('mcp_8')).toEqual({ decision: 'approved' });
      expect(h.sends()).toBe(1);
      expect(h.cancelled).toHaveLength(0);
      expect(h.warn).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });

  it('ignores every protocol error that is not a late dialog answer', () => {
    const warn = vi.fn();
    const approvals = createMcpOwnerApproval({ server: {}, logger: { warn } });
    approvals.noteProtocolError(new Error('Unknown message type: {}'));
    approvals.noteProtocolError(new Error('Received a response for an unknown message ID: {"jsonrpc":"2.0","id":3,"result":{}}'));
    approvals.noteProtocolError('not even an error');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('non-social approval failure reasons', () => {
  it.each([
    [{action: 'cancel'}, 'OWNER_CONFIRMATION_CANCELLED'],
    [new McpError(ErrorCode.InvalidParams, 'bad form'), 'OWNER_CONFIRMATION_ANSWER_INVALID'],
    [new McpError(ErrorCode.ConnectionClosed, 'closed'), 'OWNER_CONFIRMATION_FAILED'],
    [new Error('write EPIPE'), 'OWNER_CONFIRMATION_FAILED'],
    [{action: 'invalid'}, 'OWNER_CONFIRMATION_FAILED'],
  ])('preserves the precise backend reason without dispatching an effect', async (ending, reason) => {
    const elicitInput = vi.fn(async () => {if (ending instanceof Error) throw ending; return ending;});
    const server = {current: {elicitInput, getClientCapabilities: () => ({elicitation: {form: {}}})} as never};
    const backend = createMcpOwnerApproval({server});
    let sends = 0;
    await backend.aroundDispatch(TOOL, {draft: 1}, 'mcp_reason', undefined, async () => {
      const outcome = consumeOwnerApproval(TOOL, {draft: 1}, 'mcp_reason');
      expect(outcome).toEqual({decision: 'unavailable', reason});
      if (outcome.decision === 'approved') sends++;
    });
    expect(sends).toBe(0); expect(elicitInput).toHaveBeenCalledTimes(1);
  });
});

describe('what the world action says when its window closed first', () => {
  // Rides after `OWNER_CONFIRMATION_TIMEOUT:` (mcp-owner-authorization.ts).
  it.each([
    ['en', 'nothing was done', 'approving it now will not run the action'],
    ['zh-CN', '什么都没有执行', '现在点同意也不会执行这个动作'],
  ] as const)('says nothing ran and approving now will not run it (%s)', (lang, nothing, clause) => {
    const text = renderCopy(lang, 'world.action.approval.timedOut');
    expect(text).toContain(nothing);
    expect(text).toContain(clause);
  });
});

describe(OWNER_APPROVAL_TIMEOUT_ENV, () => {
  const read = (value: string | undefined) => {
    const warn = vi.fn();
    return { ms: ownerApprovalTimeoutFromEnv({ [OWNER_APPROVAL_TIMEOUT_ENV]: value }, { warn }), warn };
  };

  it('is the default, silently, when unset or blank', () => {
    for (const value of [undefined, '', '  ']) {
      const { ms, warn } = read(value);
      expect(ms).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    }
  });

  it('uses a valid value', () => {
    const { ms, warn } = read('420');
    expect(ms).toBe(420_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to the default, and says so, for anything that is not whole seconds', () => {
    for (const value of ['abc', '120s', '1e3', '-5', '12.5', '0x40']) {
      const { ms, warn } = read(value);
      expect(ms, value).toBeUndefined();
      expect(warn, value).toHaveBeenCalledTimes(1);
    }
  });

  it('clamps an out-of-range value to the nearer bound, and says so', () => {
    const { minSeconds, maxSeconds } = OWNER_APPROVAL_TIMEOUT_BOUNDS;
    // The floor IS the owner's six minutes: the knob can lengthen, never undercut.
    expect(minSeconds).toBe(360);
    expect(maxSeconds).toBe(600);
    for (const [value, expected] of [['0', minSeconds], ['120', minSeconds], ['359', minSeconds], ['601', maxSeconds], ['86400', maxSeconds]] as const) {
      const { ms, warn } = read(value);
      expect(ms, value).toBe(expected * 1000);
      expect(warn, value).toHaveBeenCalledTimes(1);
    }
    expect(read('360').ms).toBe(360_000);
    expect(read('600').ms).toBe(600_000);
  });

  /** The window our own timer actually gives the dialog, measured on fake
   *  time: still open one millisecond before `expectedMs`, closed at it. */
  async function assertWindow(elicitTimeoutMs: number | undefined, expectedMs: number, callRef: string) {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const box = { current: {
        elicitInput: vi.fn((_form: unknown, options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise((_resolve, reject) => { options.signal.addEventListener('abort', () => reject(options.signal.reason)); });
        }),
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        getClientVersion: () => ({ name: 'claude-code', version: '0' }),
      } as never };
      const approvals = createMcpOwnerApproval({ server: box, elicitTimeoutMs });
      const asking = approvals.beforeDispatch(TOOL, { draft: 1 }, callRef);
      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      expect(signal?.aborted, 'still open just before the window').toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted, 'closed at the window').toBe(true);
      await asking;
      expect(consumeOwnerApproval(TOOL, { draft: 1 }, callRef)).toEqual({ decision: 'timeout' });
    } finally { vi.useRealTimers(); }
  }

  it('is the window the dialog is actually given', async () => {
    await assertWindow(ownerApprovalTimeoutFromEnv({ [OWNER_APPROVAL_TIMEOUT_ENV]: '420' }), 420_000, 'mcp_9');
  });

  it('unset, the dialog gets the one shared window, which honours the six-minute floor', async () => {
    expect(OWNER_APPROVAL_WINDOW_MS).toBeGreaterThanOrEqual(360_000);
    // Below Claude Code's default stdio idle abort (1 800 000 ms) with margin.
    expect(OWNER_APPROVAL_TIMEOUT_BOUNDS.maxSeconds * 1000).toBeLessThanOrEqual(1_800_000 / 3);
    await assertWindow(ownerApprovalTimeoutFromEnv({}), OWNER_APPROVAL_WINDOW_MS, 'mcp_10');
  });
});
