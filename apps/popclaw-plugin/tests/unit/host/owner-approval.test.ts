import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_DESCRIPTION_BUDGET, APPROVAL_DESCRIPTION_MAX_LINES, APPROVAL_TITLE_BUDGET,
  askOwnerApprovalBeforeDispatch, consumeOwnerApproval, isOwnerDirectOrigin,
  ownerApprovalAfterToolCall, ownerApprovalBeforeToolCall, ownerApprovalGranted, ownerApprovalRecorded,
  registerOwnerApprovalSubject, resetOwnerApprovals, setOwnerApprovalSurface,
  OWNER_ALLOWLIST_UNCONFIGURED, ownerApprovalOriginRefusal,
  type OwnerApprovalAskResult, type OwnerApprovalSubjectDescriptor,
} from '../../../src/host/owner-approval.js';
import type { OwnerApprovalRouteReaders } from '../../../src/host/owner-approval-route.js';

const TOOL = 'demo_tool';
/** One registrant, as simple as the contract allows: total canonicalize, pure describe. */
const descriptor: OwnerApprovalSubjectDescriptor = {
  canonicalize: params => JSON.stringify(params ?? null),
  describe: params => ({ kind: 'ask', title: 'Demo', description: [`do: ${JSON.stringify(params)}`] }),
};
const owner = { toolCallId: 'c1', requester: { channel: 'tui', senderId: 'me', senderIsOwner: true } };
/** An IM turn, which is admitted only on a route this seam can check. The
 *  seam never learns whose address `+8520` is, and does not need to. */
const imTurn = { agentId: 'main', sessionKey: 'agent:main:whatsapp:direct:1', channelId: '+8520',
  requester: { channel: 'whatsapp', senderId: '+8520', senderIsOwner: true } };
const route = (plugin: unknown, commands: unknown = { ownerAllowFrom: ['+8520'] }): OwnerApprovalRouteReaders => ({
  readActiveConfig: () => ({ commands, approvals: { plugin } }),
  resolveChannel: raw => (raw === 'whatsapp' ? 'whatsapp' : undefined),
});
const pinned = route({ enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: '+8520' }] });
const sessionMode = route({ enabled: true, mode: 'session', targets: [{ channel: 'whatsapp', to: '+8520' }] });
const strangerTarget = route({ enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: '+9999' }] });
const noOwnerList = route({ enabled: true, mode: 'targets', targets: [{ channel: 'whatsapp', to: '+8520' }] }, {});
const fire = (params: unknown, ctx: unknown = owner, callRef = 'c1') =>
  ownerApprovalBeforeToolCall({ toolName: TOOL, params, toolCallId: callRef },
    { ...(ctx as typeof owner), toolCallId: callRef });

beforeEach(() => { resetOwnerApprovals({ now: () => 1_789_000_000_000 }); });
afterEach(() => { resetOwnerApprovals(); });

describe('owner approval seam — registration', () => {
  it('reports an unregistered tool apart from every other refusal', () => {
    expect(consumeOwnerApproval('nobody', {}, 'c1')).toEqual({ decision: 'unavailable', reason: 'SUBJECT_NOT_REGISTERED' });
  });

  it('reports a host with no approval surface apart from an unsafe origin', async () => {
    registerOwnerApprovalSubject(TOOL, descriptor);
    expect(await fire({ a: 1 })).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'unavailable', reason: 'APPROVAL_SURFACE_ABSENT' });
    setOwnerApprovalSurface(true);
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'unavailable', reason: 'ORIGIN_NOT_OWNER_DIRECT' });
  });

  it('never asks for a tool that declared no subject', async () => {
    setOwnerApprovalSurface(true);
    expect(await ownerApprovalBeforeToolCall({ toolName: 'other', params: {}, toolCallId: 'c1' }, owner)).toBeUndefined();
  });
});

describe('owner approval seam — the origin guard', () => {
  beforeEach(() => { registerOwnerApprovalSubject(TOOL, descriptor); setOwnerApprovalSurface(true); });

  it('asks only on the surfaces the host gives no turn-source route', async () => {
    for (const channel of ['tui', 'webchat', 'WebChat', ' TUI ']) {
      expect(await isOwnerDirectOrigin({ requester: { channel, senderIsOwner: true } })).toBe(true);
    }
    for (const channel of ['telegram', 'discord', 'slack', 'whatsapp', '']) {
      expect(await isOwnerDirectOrigin({ requester: { channel, senderIsOwner: true } })).toBe(false);
    }
  });

  it('fails closed when the host cannot prove the requester is the owner', async () => {
    expect(await isOwnerDirectOrigin({ requester: { channel: 'tui' } })).toBe(false);
    expect(await isOwnerDirectOrigin({ requester: { channel: 'tui', senderIsOwner: false } })).toBe(false);
    expect(await isOwnerDirectOrigin({})).toBe(false);
    expect(await isOwnerDirectOrigin(undefined)).toBe(false);
  });

  it('runs before the descriptor, so an unsafe origin cannot reach it at all', async () => {
    let touched = 0;
    registerOwnerApprovalSubject(TOOL, {
      canonicalize: params => { touched++; return JSON.stringify(params); },
      describe: () => { touched++; return { kind: 'ask', title: 't', description: ['d'] }; },
    });
    expect(await fire({ a: 1 }, { requester: { channel: 'telegram', senderIsOwner: true } })).toBeUndefined();
    expect(touched).toBe(0);
  });

  it('names WHY an origin was refused instead of one code for every cause', async () => {
    expect(await ownerApprovalOriginRefusal(imTurn, pinned)).toBeNull();
    expect(await ownerApprovalOriginRefusal(imTurn, { ...pinned, readActiveConfig: () => null }))
      .toBe('OWNER_ROUTE_CONFIG_UNAVAILABLE');
    expect(await ownerApprovalOriginRefusal(imTurn, sessionMode)).toBe('OWNER_ROUTE_MODE_NOT_TARGETS');
    expect(await ownerApprovalOriginRefusal(imTurn, strangerTarget)).toBe('OWNER_ROUTE_TARGET_ADDRESS_NOT_THIS_TURN');
  });

  it('tells a missing owner allowlist apart from a sender who is simply not the owner', async () => {
    const notOwner = { ...imTurn, requester: { ...imTurn.requester, senderIsOwner: false } };
    // No list at all: the flag can never be true here, so it is a setup mistake.
    expect(await ownerApprovalOriginRefusal(notOwner, noOwnerList)).toBe(OWNER_ALLOWLIST_UNCONFIGURED);
    // A list exists: this is the guard working, and it says so.
    expect(await ownerApprovalOriginRefusal(notOwner, pinned)).toBe('ORIGIN_NOT_OWNER_DIRECT');
    // On webchat the scope producer can still fire, so no claim is made.
    expect(await ownerApprovalOriginRefusal({ requester: { channel: 'webchat' } }, noOwnerList))
      .toBe('ORIGIN_NOT_OWNER_DIRECT');
    // Both are refusals either way — naming them apart never admits anything.
    expect(await isOwnerDirectOrigin(notOwner, noOwnerList)).toBe(false);
  });

  it('admits an IM turn only when the runtime route pins delivery to the owner', async () => {
    expect(await isOwnerDirectOrigin(imTurn, pinned)).toBe(true);
    expect(await isOwnerDirectOrigin(imTurn, sessionMode)).toBe(false);
    expect(await isOwnerDirectOrigin(imTurn, strangerTarget)).toBe(false);
    // The route says where the prompt goes; it never says who asked.
    expect(await isOwnerDirectOrigin({ ...imTurn, requester: { ...imTurn.requester, senderIsOwner: false } }, pinned)).toBe(false);
  });

  it('refuses a mismatched route BEFORE any descriptor runs', async () => {
    let touched = 0;
    registerOwnerApprovalSubject(TOOL, {
      canonicalize: params => { touched++; return JSON.stringify(params); },
      describe: () => { touched++; return { kind: 'ask', title: 't', description: ['d'] }; },
    });
    expect(await ownerApprovalBeforeToolCall({ toolName: TOOL, params: { a: 1 }, toolCallId: 'c1' },
      { ...imTurn, toolCallId: 'c1' }, strangerTarget)).toBeUndefined();
    expect(touched).toBe(0);
    // ...and the same call on a pinned route does reach it and does ask.
    const asked = await ownerApprovalBeforeToolCall({ toolName: TOOL, params: { a: 1 }, toolCallId: 'c2' },
      { ...imTurn, toolCallId: 'c2' }, pinned);
    expect(asked?.requireApproval.description).toBe('d');
    expect(touched).toBeGreaterThan(0);
  });
});

describe('owner approval seam — the answer', () => {
  beforeEach(() => { registerOwnerApprovalSubject(TOOL, descriptor); setOwnerApprovalSurface(true); });

  it('offers allow-once and deny only, and never allow-always', async () => {
    const asked = (await fire({ a: 1 }))!.requireApproval;
    expect(asked.allowedDecisions).toEqual(['allow-once', 'deny']);
    expect(asked.severity).toBe('critical');
    expect(asked.description).toBe('do: {"a":1}');
  });

  it('approves once and only once', async () => {
    const asked = (await fire({ a: 1 }))!.requireApproval;
    asked.onResolution('allow-once');
    expect(ownerApprovalGranted(TOOL, 'c1')).toBe(true);
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'approved' });
    expect(ownerApprovalGranted(TOOL, 'c1')).toBe(false);
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'unavailable', reason: 'ALREADY_CONSUMED' });
  });

  it('separates a deny from a timeout, a cancellation and an unanswered prompt', async () => {
    for (const [decision, expected] of [['deny', 'denied'], ['timeout', 'timeout'], ['cancelled', 'timeout'],
      ['allow-always-but-not-offered', 'timeout']] as const) {
      const asked = (await fire({ a: decision }))!.requireApproval;
      asked.onResolution(decision);
      expect(consumeOwnerApproval(TOOL, { a: decision }, 'c1')).toEqual({ decision: expected });
    }
    const unanswered = await fire({ a: 'silence' });
    expect(unanswered).toBeTruthy();
    expect(consumeOwnerApproval(TOOL, { a: 'silence' }, 'c1')).toEqual({ decision: 'timeout' });
  });

  it('refuses parameters that changed after the owner answered, by its own name', async () => {
    const asked = (await fire({ a: 1 }))!.requireApproval;
    asked.onResolution('allow-once');
    expect(consumeOwnerApproval(TOOL, { a: 2 }, 'c1')).toEqual({ decision: 'unavailable', reason: 'SUBJECT_CHANGED' });
    // The untouched approval is still there for the bytes it was given to.
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'approved' });
  });
});

describe('owner approval seam — the answer belongs to one call', () => {
  beforeEach(() => { registerOwnerApprovalSubject(TOOL, descriptor); setOwnerApprovalSurface(true); });

  it('will not let a second call spend a grant given to the first', async () => {
    const asked = (await fire({ a: 1 }, owner, 'safe-call'))!.requireApproval;
    asked.onResolution('allow-once');
    // Byte-identical parameters, different call — exactly what a group turn or
    // a model-authored second call would look like.
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'other-call'))
      .toEqual({ decision: 'unavailable', reason: 'CALL_MISMATCH' });
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'safe-call')).toEqual({ decision: 'approved' });
  });

  it('refuses rather than matching on parameters when the host gave no call identity', async () => {
    const asked = (await fire({ a: 1 }, owner, 'safe-call'))!.requireApproval;
    asked.onResolution('allow-once');
    for (const missing of ['', '   ', undefined as unknown as string]) {
      expect(consumeOwnerApproval(TOOL, { a: 1 }, missing))
        .toEqual({ decision: 'unavailable', reason: 'CALL_IDENTITY_ABSENT' });
    }
  });

  it('does not ask at all when the host gave the hook no call identity', async () => {
    expect(await ownerApprovalBeforeToolCall({ toolName: TOOL, params: { a: 1 } },
      { requester: { channel: 'tui', senderIsOwner: true } })).toBeUndefined();
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(false);
  });

  it('tells "the owner was asked" from "this host never asks"', async () => {
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(false);
    const asked = (await fire({ a: 1 }))!.requireApproval;
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(true);
    asked.onResolution('deny');
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(true);
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'denied' });
    // Still recorded after the answer is spent, so a retry cannot read as
    // "never asked" and fall through to some other authorization.
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(true);
  });

  /**
   * A REFUSAL IS NOT "THE OWNER WAS ASKED", and answering otherwise was an
   * availability regression this seam introduced: a call whose prompt could
   * not be built was routed into the owner lane and failed there, instead of
   * falling through to a configured policy that would have served it a moment
   * before the seam existed. Nothing was widened by fixing it — the policy
   * lane still demands a real policy.
   *
   * The named refusal survives for whoever consumes directly; only the lane
   * question answers false.
   */
  it('does not claim the owner was asked when no prompt was ever built', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'refuse', reason: 'DEMO_REFUSED' }) });
    expect(await fire({})).toBeUndefined();
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(false);
    expect(ownerApprovalGranted(TOOL, 'c1')).toBe(false);
    // The diagnostic is still there for a caller that asks for it by name.
    expect(consumeOwnerApproval(TOOL, {}, 'c1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'DEMO_REFUSED' });
    // And a refusal is never marked as spent, so it cannot read as a replay.
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(false);
  });

  it('does not claim the owner was asked when the seam itself refused the prompt', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 't', description: ['a: one\nb: forged'] }) });
    expect(await fire({})).toBeUndefined();
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(false);
  });
});

describe('owner approval seam — what it will not show', () => {
  beforeEach(() => { setOwnerApprovalSurface(true); });

  it('refuses an over-budget description outright instead of truncating it', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 'ok', description: ['x'.repeat(APPROVAL_DESCRIPTION_BUDGET + 1)] }) });
    expect(await fire({})).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, {}, 'c1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PROMPT_TOO_LONG' });
  });

  it('refuses an over-budget title the same way', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 'x'.repeat(APPROVAL_TITLE_BUDGET + 1), description: ['ok'] }) });
    expect(await fire({})).toBeUndefined();
  });

  it('counts code points, so a CJK description at the budget still renders', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: '标题', description: ['杭'.repeat(APPROVAL_DESCRIPTION_BUDGET)] }) });
    expect(await fire({})).toBeTruthy();
  });

  it('joins the rows it was given, and only those rows', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 't', description: ['a: one', 'b: two'] }) });
    const asked = (await fire({}))!.requireApproval;
    expect(asked.description).toBe('a: one\nb: two');
    expect(asked.description.split('\n')).toHaveLength(2);
  });

  /**
   * THE HOLE THIS SHAPE EXISTS TO CLOSE. A registrant — and therefore any
   * model-supplied value a registrant renders — must not be able to turn one
   * row into two. Every line separator is in the invisible class and every ROW
   * is screened before the join, so the only way to make a second line is to
   * add an array element, which only registrant code can do.
   *
   * The previous check was `description.split('\n').some(...)`, which consumed
   * the newlines before testing and passed this input unchanged.
   */
  it('will not let a registrant make a second row out of one value', async () => {
    for (const separator of ['\n', '\r\n', '\r', '\u2028', '\u2029', '\u0085', '\v', '\f']) {
      registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
        describe: () => ({ kind: 'ask', title: 't', description: [`a: one${separator}b: forged`] }) });
      expect(await fire({}, owner, `sep-${separator.codePointAt(0)}`)).toBeUndefined();
      expect(consumeOwnerApproval(TOOL, {}, `sep-${separator.codePointAt(0)}`))
        .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PROMPT_UNPRINTABLE' });
    }
  });

  it('refuses a title carrying a line break, as it always did', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 't\nsecond', description: ['a: one'] }) });
    expect(await fire({})).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, {}, 'c1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PROMPT_UNPRINTABLE' });
  });

  it('shows nothing rather than an empty dialog', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 't', description: [] }) });
    expect(await fire({})).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, {}, 'c1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PROMPT_EMPTY' });
  });

  it('bounds the number of rows, not just their total length', async () => {
    const rows = (count: number) => Array.from({ length: count }, (_, i) => `r${i}`);
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 't', description: rows(APPROVAL_DESCRIPTION_MAX_LINES) }) });
    expect(await fire({}, owner, 'at-limit')).toBeTruthy();
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 't', description: rows(APPROVAL_DESCRIPTION_MAX_LINES + 1) }) });
    expect(await fire({}, owner, 'over-limit')).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, {}, 'over-limit'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PROMPT_TOO_MANY_LINES' });
  });

  it('counts the separators the join adds, not only the rows', async () => {
    // Two rows that each fit, whose join does not: the budget is measured on
    // the string the host will actually receive.
    const half = Math.floor(APPROVAL_DESCRIPTION_BUDGET / 2);
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 't', description: ['x'.repeat(half), 'y'.repeat(APPROVAL_DESCRIPTION_BUDGET - half)] }) });
    expect(await fire({}, owner, 'joined')).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, {}, 'joined'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PROMPT_TOO_LONG' });
  });

  it('refuses an invisible character rather than counting it', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 't', description: ['a: on​e'] }) });
    expect(await fire({})).toBeUndefined();
  });

  it('asks nothing when the descriptor refuses, and says which refusal it was', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'refuse', reason: 'DEMO_TOO_LONG' }) });
    expect(await fire({})).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, {}, 'c1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'DEMO_TOO_LONG' });
  });

  it('survives a registrant that throws in either half', async () => {
    registerOwnerApprovalSubject(TOOL, {
      canonicalize: () => { throw new Error('impure'); },
      describe: () => ({ kind: 'ask', title: 't', description: ['d'] }) });
    expect(await fire({})).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, {}, 'c1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'CANONICALIZE_FAILED' });
    registerOwnerApprovalSubject(TOOL, {
      canonicalize: () => 'k', describe: () => { throw new Error('impure'); } });
    expect(await fire({})).toBeUndefined();
    expect(consumeOwnerApproval(TOOL, {}, 'c1'))
      // The error's own class name is deliberately NOT here: a refusal name is
      // printed to the agent verbatim, and an exception class is exactly what
      // that frame promises never to carry.
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'DESCRIBE_THREW' });
  });
});

/**
 * A TYPE IS A COMPILE-TIME ARGUMENT, AND COMPILE TIME DOES NOT RUN.
 *
 * `allow-always` is absent from the decisions the prompt offers and absent
 * from the answer type a backend may return. Neither fact reaches production:
 * `onResolution` takes a bare string from the host, an embedded broker answers
 * through that same callback with no identity chain behind it, and a second
 * backend is one careless line from passing its own answer through. The seam
 * used to read `allow-always` as consent, which is the single widening it
 * refuses to offer — a standing "always allow" decided by something other than
 * the person in front of this dialog.
 */
describe('owner approval seam — consent is exactly allow-once, at runtime', () => {
  beforeEach(() => { registerOwnerApprovalSubject(TOOL, descriptor); setOwnerApprovalSurface(true); });

  it('treats an allow-always resolution as a deny, never as consent', async () => {
    const shown = (await fire({ a: 1 }))!.requireApproval;
    shown.onResolution('allow-always');
    expect(ownerApprovalGranted(TOOL, 'c1')).toBe(false);
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'denied' });
  });

  it('treats an allow-always answer from an MCP backend as a deny too', async () => {
    await askOwnerApprovalBeforeDispatch(TOOL, { a: 1 }, 'c1',
      async () => 'allow-always' as unknown as OwnerApprovalAskResult);
    expect(ownerApprovalGranted(TOOL, 'c1')).toBe(false);
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'denied' });
  });

  it('still accepts the one decision that is consent, and still refuses the rest', async () => {
    for (const [decision, outcome] of [['allow-once', { decision: 'approved' }], ['deny', { decision: 'denied' }],
      ['allow_once', { decision: 'timeout' }], ['ALLOW-ONCE', { decision: 'timeout' }],
      ['approve', { decision: 'timeout' }], ['timeout', { decision: 'timeout' }]] as const) {
      const callRef = `decision-${decision}`;
      const shown = (await fire({ a: 1 }, owner, callRef))!.requireApproval;
      shown.onResolution(decision);
      expect(consumeOwnerApproval(TOOL, { a: 1 }, callRef), decision).toEqual(outcome);
    }
  });
});

/**
 * THE GUARD AFTER THE BODY, ON THE HOST THAT WAS SAID NOT TO HAVE ONE.
 *
 * The MCP root has reported a granted-but-unconsumed approval since the round
 * that introduced `discardUnconsumedOwnerApproval`; the native host was
 * recorded as having "no after-dispatch moment" and so was left silent. That
 * was wrong: `after_tool_call` is on the same typed `api.on` table the seam
 * already uses (`PluginHookName`, `plugin-entry-Cc00OvUf.d.ts:7107`), and its
 * event carries `toolCallId` (`plugin-entry-Cc00OvUf.d.ts:7587`). So the guard
 * is symmetric now, and it answers exactly one question — was a grant taken
 * and never consumed.
 *
 * REPORT ONLY — and not because nobody is listening. The typed runner DOES
 * await each handler (`hook-runner-global-BhDCl4qm.mjs:783-797`); what makes
 * this safe is that it CATCHES, not that it ignores. A throw goes to
 * `handleHookError` (`:700-707`), which for a fail-open hook logs and returns.
 * Nothing here refuses, retries or touches the tool's result. The point is
 * that the failure can no longer be invisible, not that there is a new gate.
 */
describe('owner approval seam — the native after-dispatch guard', () => {
  beforeEach(() => { registerOwnerApprovalSubject(TOOL, descriptor); setOwnerApprovalSurface(true); });

  it('names the tool when a grant was never consumed, and the call still reads as asked', async () => {
    const asked = (await fire({ a: 1 }))!.requireApproval;
    asked.onResolution('allow-once');
    const reports: string[] = [];
    ownerApprovalAfterToolCall({ toolName: TOOL, toolCallId: 'c1' }, { toolCallId: 'c1' }, m => reports.push(m));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain(TOOL);
    // No live grant outlives the call it was given for.
    expect(ownerApprovalGranted(TOOL, 'c1')).toBe(false);
    /*
     * THE HALF THAT ONLY BECOMES REAL ON THIS HOST. `consumed.add(key)` inside
     * `discardUnconsumedOwnerApproval` is what makes a dropped grant stay
     * "the owner was asked": on the native root `asked()` IS
     * `ownerApprovalRecorded` (`openclaw-owner-approval.ts`), and a call that
     * stopped reading as asked would fall through to whatever configured
     * policy would have served it — the seam handing back a lane it had
     * already taken over. On MCP the same line only decides which name a late
     * reader is given, which is why removing it could look harmless.
     */
    expect(ownerApprovalRecorded(TOOL, 'c1')).toBe(true);
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1'))
      .toEqual({ decision: 'unavailable', reason: 'ALREADY_CONSUMED' });
  });

  it('says nothing when the body consumed, and nothing when there was no consent to spend', async () => {
    const reports: string[] = [];
    const report = (message: string): void => { reports.push(message); };
    const approved = (await fire({ a: 1 }, owner, 'spent'))!.requireApproval;
    approved.onResolution('allow-once');
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'spent')).toEqual({ decision: 'approved' });
    ownerApprovalAfterToolCall({ toolName: TOOL, toolCallId: 'spent' }, { toolCallId: 'spent' }, report);
    const denied = (await fire({ a: 1 }, owner, 'denied'))!.requireApproval;
    denied.onResolution('deny');
    ownerApprovalAfterToolCall({ toolName: TOOL, toolCallId: 'denied' }, { toolCallId: 'denied' }, report);
    // A call nobody was ever asked about is not a defect either.
    ownerApprovalAfterToolCall({ toolName: TOOL, toolCallId: 'never-asked' }, { toolCallId: 'never-asked' }, report);
    expect(reports).toEqual([]);
  });

  /**
   * NO CALL ID, NO ATTRIBUTION. `toolCallId` is optional on this event, and a
   * grant blamed on the wrong call is worse than a grant nobody reported:
   * the error line would name a registrant that did consume. So the guard
   * says it could not attribute anything and drops nothing — it never falls
   * back to matching on the tool name, the parameters, or the only record
   * that happens to be live.
   */
  it('refuses to attribute a grant when the host gave the hook no call id', async () => {
    const asked = (await fire({ a: 1 }))!.requireApproval;
    asked.onResolution('allow-once');
    const reports: string[] = [];
    ownerApprovalAfterToolCall({ toolName: TOOL }, {}, m => reports.push(m));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain('could not be attributed');
    // Untouched: the grant is still exactly where it was, and still spendable.
    expect(ownerApprovalGranted(TOOL, 'c1')).toBe(true);
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'c1')).toEqual({ decision: 'approved' });
  });

  /** Every other tool on this host fires this hook too. A guard that spoke
   *  about tools it declares no subject for would bury its own one report. */
  it('stays silent for a tool that declared no subject', () => {
    const reports: string[] = [];
    ownerApprovalAfterToolCall({ toolName: 'other', toolCallId: 'c1' }, { toolCallId: 'c1' }, m => reports.push(m));
    ownerApprovalAfterToolCall({ toolName: 'other' }, {}, m => reports.push(m));
    expect(reports).toEqual([]);
  });

  /** A host logger that throws must not become a thrown hook: this guard's
   *  whole promise is that it changes nothing but visibility. */
  it('cannot turn a throwing host logger into a thrown hook', async () => {
    const asked = (await fire({ a: 1 }))!.requireApproval;
    asked.onResolution('allow-once');
    expect(() => ownerApprovalAfterToolCall({ toolName: TOOL, toolCallId: 'c1' }, { toolCallId: 'c1' },
      () => { throw new Error('LOGGER_THREW'); })).not.toThrow();
    // The report was lost; the guard was not.
    expect(ownerApprovalGranted(TOOL, 'c1')).toBe(false);
  });
});
