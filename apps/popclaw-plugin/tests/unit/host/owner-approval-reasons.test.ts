/**
 * EVERY NAMED REFUSAL HAS TO REACH SOMEBODY.
 *
 * The defect this file exists to keep closed was not bad naming. Refusals were
 * carefully distinguished inside the seam and then flattened to one
 * `ORIGIN_NOT_OWNER_DIRECT` before any caller could read them:
 * `ownerApprovalBeforeToolCall` returned a boolean and dropped the reason, and
 * the codes were not even members of `OwnerApprovalUnavailableReason`. A name
 * nobody can observe is a comment, however many of them there are.
 *
 * So this suite does two things a per-case test cannot:
 *
 *   1. The table below is typed `Record<OwnerApprovalUnavailableReason, …>`, so
 *      adding a reason to the vocabulary WITHOUT a scenario that produces it is
 *      a compile error, not a silent gap.
 *   2. Every scenario goes through the PRODUCTION entry points —
 *      `ownerApprovalBeforeToolCall` for the hook, `consumeOwnerApproval` for
 *      the tool body — and asserts the reason a tool body actually reads. A
 *      reason that the hook computes but nothing carries fails here.
 *
 * `consumeOwnerApproval`'s answer is what `openclaw-owner-approval.ts:150`
 * appends to `OWNER_APPROVAL_UNAVAILABLE`, which is the string a person sees in
 * the tool result. That is the "caller" in question.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  OWNER_APPROVAL_UNAVAILABLE_REASONS, consumeOwnerApproval, ownerApprovalBeforeToolCall,
  registerOwnerApprovalSubject, resetOwnerApprovals, setOwnerApprovalSurface,
  type OwnerApprovalOutcome, type OwnerApprovalSubjectDescriptor,
  type OwnerApprovalUnavailableReason,
} from '../../../src/host/owner-approval.js';
import type { OwnerApprovalRouteReaders } from '../../../src/host/owner-approval-route.js';
import { createMcpOwnerApproval } from '../../../src/host/mcp-owner-approval.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/** The MCP backend with a client whose dialog ends as told, then the real
 *  body-side consume. These three names come only from that backend. */
async function mcpDialogThenConsume(ending: unknown, signal?: AbortSignal): Promise<OwnerApprovalOutcome> {
  const approvals = createMcpOwnerApproval({ logger: { warn: () => {} }, server: { current: {
    elicitInput: async () => { if (ending instanceof Error) throw ending; return ending; },
    getClientCapabilities: () => ({ elicitation: { form: {} } }),
    getClientVersion: () => ({ name: 'claude-code', version: '0' }),
  } as never } });
  await approvals.beforeDispatch(TOOL, PARAMS, 'c1', signal);
  return consumeOwnerApproval(TOOL, PARAMS, 'c1');
}

const TOOL = 'demo_tool';
const PARAMS = { a: 1 };
const descriptor: OwnerApprovalSubjectDescriptor = {
  canonicalize: params => JSON.stringify(params ?? null),
  describe: params => ({ kind: 'ask', title: 'Demo', description: [`do: ${JSON.stringify(params)}`] }),
};
/** One IM turn, whose own destination is `+8520`. The seam never learns whose
 *  address that is; the whole check is that the route equals THIS turn. */
const turn = {
  agentId: 'main', sessionKey: 'agent:main:whatsapp:direct:1', channelId: '+8520',
  requester: { channel: 'whatsapp', accountId: undefined, senderId: '+8520', senderIsOwner: true },
};
const pinnedPlugin = { enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: '+8520' }] };
const readers = (cfg: unknown): OwnerApprovalRouteReaders => ({
  readActiveConfig: () => cfg,
  resolveChannel: raw => ({ whatsapp: 'whatsapp', webchat: 'webchat', telegram: 'telegram' } as Record<string, string>)[raw],
});
/** The pinned snapshot, with one part of it replaced per scenario. */
const config = (over: {
  plugin?: unknown; commands?: unknown; channels?: unknown;
} = {}) => ({
  commands: 'commands' in over ? over.commands : { ownerAllowFrom: ['+8520'] },
  approvals: { plugin: 'plugin' in over ? over.plugin : pinnedPlugin },
  ...over.channels ? { channels: over.channels } : {},
});

/** Drive the real hook, then the real body-side consume, and report what the
 *  body was told. Nothing here reads the guard directly. */
async function askThenConsume(
  ctx: unknown = turn, cfg: unknown = config(), callRef = 'c1', params: unknown = PARAMS,
): Promise<OwnerApprovalOutcome> {
  await ownerApprovalBeforeToolCall(
    { toolName: TOOL, params, toolCallId: callRef },
    { ...(ctx as typeof turn), toolCallId: callRef },
    readers(cfg),
  );
  return consumeOwnerApproval(TOOL, params, callRef);
}
const notOwner = { ...turn, requester: { ...turn.requester, senderIsOwner: false } };

/**
 * One scenario per reason. EXHAUSTIVE BY TYPE: a new member of
 * `OwnerApprovalUnavailableReason` that nobody can produce will not compile.
 */
const scenarios: Record<OwnerApprovalUnavailableReason, () => Promise<OwnerApprovalOutcome>> = {
  // --- not about the route -------------------------------------------------
  SUBJECT_NOT_REGISTERED: async () => consumeOwnerApproval('nobody_declared_this', PARAMS, 'c1'),
  APPROVAL_SURFACE_ABSENT: async () => {
    setOwnerApprovalSurface(false);
    return askThenConsume();
  },
  CALL_IDENTITY_ABSENT: async () => consumeOwnerApproval(TOOL, PARAMS, '   '),
  SUBJECT_REFUSED: async () => {
    registerOwnerApprovalSubject(TOOL, { ...descriptor, canonicalize: () => null as unknown as string });
    return consumeOwnerApproval(TOOL, PARAMS, 'c1');
  },
  SUBJECT_CHANGED: async () => {
    // Asked about one set of bytes, then the body re-asks about another. The
    // record must still be live, so this one does NOT consume first.
    await ownerApprovalBeforeToolCall({ toolName: TOOL, params: PARAMS, toolCallId: 'c1' },
      { ...turn, toolCallId: 'c1' }, readers(config()));
    return consumeOwnerApproval(TOOL, { a: 2 }, 'c1');
  },
  // --- how an MCP dialog ended, when our window did not close --------------
  OWNER_CONFIRMATION_CANCELLED: async () => mcpDialogThenConsume({ action: 'cancel' }),
  OWNER_CONFIRMATION_ANSWER_INVALID: async () =>
    mcpDialogThenConsume(new McpError(ErrorCode.InvalidParams, 'content does not match requested schema')),
  OWNER_CONFIRMATION_FAILED: async () => mcpDialogThenConsume(new McpError(ErrorCode.ConnectionClosed, 'Connection closed')),
  // The host aborted the call; the SDK reports that as RequestTimeout, and our
  // own window never closed.
  OWNER_CONFIRMATION_INACTIVE: async () => {
    const aborted = new AbortController(); aborted.abort('host cancelled the tool call');
    return mcpDialogThenConsume(new McpError(ErrorCode.RequestTimeout, 'host cancelled the tool call'), aborted.signal);
  },
  ALREADY_CONSUMED: async () => {
    await askThenConsume(turn, config(), 'c1');
    return consumeOwnerApproval(TOOL, PARAMS, 'c1');
  },
  CALL_MISMATCH: async () => {
    // A live record for c1, and a SECOND call the hook was never run for — so
    // no origin refusal is on file for it and the dangerous case is what is
    // left to report.
    await ownerApprovalBeforeToolCall({ toolName: TOOL, params: PARAMS, toolCallId: 'c1' },
      { ...turn, toolCallId: 'c1' }, readers(config()));
    return consumeOwnerApproval(TOOL, PARAMS, 'c2');
  },
  // --- the host says this sender is not the owner --------------------------
  ORIGIN_NOT_OWNER_DIRECT: async () => askThenConsume(notOwner),
  OWNER_ALLOWLIST_UNCONFIGURED: async () => askThenConsume(notOwner, config({ commands: {} })),
  // --- the route is not this turn's ----------------------------------------
  OWNER_ROUTE_CONFIG_UNAVAILABLE: async () => askThenConsume(turn, null),
  OWNER_ROUTE_TURN_ADDRESS_ABSENT: async () => askThenConsume({ ...turn, channelId: '' }),
  OWNER_ROUTE_TURN_CHANNEL_NOT_DELIVERABLE: async () =>
    askThenConsume({ ...turn, requester: { ...turn.requester, channel: 'carrier-pigeon' } }),
  /** The host's own routing variable for this turn says somewhere else. Only
   *  reachable when the host projects it at all; absent falls back. */
  OWNER_ROUTE_TURN_TARGET_DIVERGED: async () =>
    askThenConsume({ ...turn, turnSourceTo: '+9999' }),
  OWNER_ROUTE_CHANNEL_CLAIMS_APPROVALS: async () =>
    askThenConsume(turn, config({ channels: { whatsapp: { execApprovals: {} } } })),
  OWNER_ROUTE_FORWARDING_DISABLED: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, enabled: false } })),
  OWNER_ROUTE_MODE_NOT_TARGETS: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, mode: 'session' } })),
  OWNER_ROUTE_FILTER_UNREADABLE: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, agentFilter: [7] } })),
  OWNER_ROUTE_FILTERS_EXCLUDE_CALL: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, agentFilter: ['somebody-else'] } })),
  OWNER_ROUTE_NO_TARGET: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, targets: [] } })),
  OWNER_ROUTE_TARGET_THREAD_PINNED: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, targets: [{ channel: 'whatsapp', to: '+8520', threadId: 't1' }] } })),
  OWNER_ROUTE_TARGET_CHANNEL_NOT_THIS_TURN: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, targets: [{ channel: 'telegram', to: '+8520' }] } })),
  OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, targets: [{ channel: 'whatsapp', to: '+9999' }] } })),
  /** Right channel, right address, a different account — the axis the refusal
   *  on a real instance could not be told apart from the address. */
  OWNER_ROUTE_TARGET_ACCOUNT_NOT_THIS_TURN: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, targets: [{ channel: 'whatsapp', to: '+8520', accountId: 'work' }] } })),
  OWNER_ROUTE_TARGET_NOT_DELIVERABLE: async () =>
    askThenConsume(turn, config({ plugin: { ...pinnedPlugin, targets: [{ channel: 'webchat', to: '+8520' }] } })),
};

describe('owner approval — every named reason reaches a caller', () => {
  beforeEach(() => {
    resetOwnerApprovals({ now: () => 1_789_000_000_000 });
    registerOwnerApprovalSubject(TOOL, descriptor);
    setOwnerApprovalSurface(true);
  });

  it('has a scenario for every reason in the vocabulary, and no scenario for anything else', () => {
    expect(Object.keys(scenarios).sort()).toEqual([...OWNER_APPROVAL_UNAVAILABLE_REASONS].sort());
  });

  for (const reason of OWNER_APPROVAL_UNAVAILABLE_REASONS) {
    it(`answers a tool body with ${reason}, not with a shared code`, async () => {
      const outcome = await scenarios[reason]();
      expect(outcome).toMatchObject({ decision: 'unavailable', reason });
    });
  }

  it('gives every reason its OWN answer — no two scenarios collapse onto one code', async () => {
    const seen = new Map<string, string>();
    for (const reason of OWNER_APPROVAL_UNAVAILABLE_REASONS) {
      resetOwnerApprovals({ now: () => 1_789_000_000_000 });
      registerOwnerApprovalSubject(TOOL, descriptor);
      setOwnerApprovalSurface(true);
      const outcome = await scenarios[reason]();
      const answered = outcome.decision === 'unavailable' ? outcome.reason : outcome.decision;
      expect(seen.has(answered), `${reason} answered ${answered}, already used by ${seen.get(answered)}`).toBe(false);
      seen.set(answered, reason);
    }
    expect(seen.size).toBe(OWNER_APPROVAL_UNAVAILABLE_REASONS.length);
  });

  it('never admits a call by naming its refusal: the hook still returns nothing', async () => {
    for (const ctx of [notOwner, { ...turn, channelId: '' }]) {
      expect(await ownerApprovalBeforeToolCall(
        { toolName: TOOL, params: PARAMS, toolCallId: 'c9' },
        { ...(ctx as typeof turn), toolCallId: 'c9' }, readers(config()),
      )).toBeUndefined();
    }
  });

  it('keeps a refused call OUT of the owner lane, so its old authorization survives', async () => {
    const { ownerApprovalRecorded } = await import('../../../src/host/owner-approval.js');
    await askThenConsume(turn, config({ plugin: { ...pinnedPlugin, targets: [{ channel: 'whatsapp', to: '+9999' }] } }));
    // The reason was carried; "the owner was asked" is still false.
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(false);
  });
});
