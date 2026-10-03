import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_APPROVAL_DISPLAY_BUDGET,
  consumeOwnerApproval, ownerApprovalGranted, ownerApprovalRecorded, registerOwnerApprovalSubject,
  resetOwnerApprovals,
  type OwnerApprovalSubjectDescriptor,
} from '../../../src/host/owner-approval.js';
import {
  MCP_APPROVAL_DIALOG_BUDGET, buildApprovalDialog, createMcpOwnerApproval, mcpApprovalCallRef,
  type McpApprovalServerBox,
} from '../../../src/host/mcp-owner-approval.js';
import { MCP_DIALOG_BUDGET } from '../../../src/host/mcp-owner-authorization.js';
import { dispatchMcpCall } from '../../../src/tools/mcp-adapter.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { createWorldInvokeApprovalSubject } from '../../../src/world/world-approval-subject.js';

const TOOL = 'demo_tool';
const OTHER = 'unregistered_tool';
const descriptor: OwnerApprovalSubjectDescriptor = {
  canonicalize: params => JSON.stringify(params ?? null),
  describe: params => ({ kind: 'ask', title: 'Demo', description: [`do: ${JSON.stringify(params)}`] }),
};

/** A connected client that declares form elicitation and answers as told. */
function fakeClient(answer: unknown, options: { name?: string; form?: boolean } = {}) {
  const elicitInput = vi.fn(async (_form?: unknown, _options?: unknown) => {
    if (answer instanceof Error) throw answer;
    return answer as { action: string; content?: Record<string, unknown> };
  });
  const box: McpApprovalServerBox = {
    current: {
      elicitInput,
      getClientCapabilities: () => (options.form === false ? {} : { elicitation: { form: {} } }),
      getClientVersion: () => ({ name: options.name ?? 'claude-code', version: '2.1.278' }),
    } as unknown as NonNullable<McpApprovalServerBox['current']>,
  };
  return { box, elicitInput };
}
const accept = { action: 'accept', content: { confirm: true } };

beforeEach(() => {
  resetOwnerApprovals();
  registerOwnerApprovalSubject(TOOL, descriptor);
});
afterEach(() => { resetOwnerApprovals(); });

describe('the MCP backend asks before it dispatches', () => {
  /**
   * THE CONTRACT. On the OpenClaw native host the host suspends the call and
   * asks in the gap; on MCP nothing suspends it, so the root asks first and
   * dispatches after. Same event order, and the body still consumes
   * synchronously. The previous round called this unbuildable because
   * elicitation is async — but what has to be async is the ASKING.
   */
  it('runs the dialog to completion before the body starts', async () => {
    const order: string[] = [];
    const { box, elicitInput } = fakeClient(accept);
    elicitInput.mockImplementation(async () => {
      order.push('ask:start');
      await Promise.resolve();
      order.push('ask:end');
      return accept;
    });
    const approvals = createMcpOwnerApproval({ server: box });
    await approvals.aroundDispatch(TOOL, { a: 1 }, 'call-1', undefined, async () => {
      order.push('body');
      return 'done';
    });
    expect(order).toEqual(['ask:start', 'ask:end', 'body']);
  });

  it('lets an approved call consume inside its own body, and proceed', async () => {
    const { box } = fakeClient(accept);
    const approvals = createMcpOwnerApproval({ server: box });
    let outcome: unknown;
    const result = await approvals.aroundDispatch(TOOL, { a: 1 }, 'call-1', undefined, async () => {
      outcome = consumeOwnerApproval(TOOL, { a: 1 }, 'call-1');
      return 'sent';
    });
    expect(outcome).toEqual({ decision: 'approved' });
    expect(result).toBe('sent');
  });

  it('gives a denied call the refusal, and the body does nothing', async () => {
    const { box } = fakeClient({ action: 'decline' });
    const approvals = createMcpOwnerApproval({ server: box });
    let sent = false;
    await approvals.aroundDispatch(TOOL, { a: 1 }, 'call-1', undefined, async () => {
      if (consumeOwnerApproval(TOOL, { a: 1 }, 'call-1').decision === 'approved') sent = true;
    });
    expect(sent).toBe(false);
    // Spent: a denial cannot be re-asked into an approval.
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1'))
      .toEqual({ decision: 'unavailable', reason: 'ALREADY_CONSUMED' });
  });

  it('treats an accepted form with the box unchecked as a refusal', async () => {
    const { box } = fakeClient({ action: 'accept', content: { confirm: false } });
    const approvals = createMcpOwnerApproval({ server: box });
    await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1')).toEqual({ decision: 'denied' });
  });

  it('names a cancelled, failed or malformed dialog by what happened — never a timeout, never consent', async () => {
    for (const [name, answer, reason] of [
      ['cancelled', { action: 'cancel' }, 'OWNER_CONFIRMATION_CANCELLED'],
      ['failed', new Error('transport gone'), 'OWNER_CONFIRMATION_FAILED'],
      ['nonsense', { action: 'something-else' }, 'OWNER_CONFIRMATION_FAILED'],
    ] as const) {
      resetOwnerApprovals();
      registerOwnerApprovalSubject(TOOL, descriptor);
      const { box } = fakeClient(answer);
      const approvals = createMcpOwnerApproval({ server: box, logger: { warn: () => {} } });
      await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
      expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1'), name).toEqual({ decision: 'unavailable', reason });
    }
  });

  it('never asks about a tool with no registered subject, and dispatches it anyway', async () => {
    const { box, elicitInput } = fakeClient(accept);
    const approvals = createMcpOwnerApproval({ server: box });
    let ran = false;
    await approvals.aroundDispatch(OTHER, { a: 1 }, 'call-1', undefined, async () => { ran = true; });
    expect(ran).toBe(true);
    expect(elicitInput).not.toHaveBeenCalled();
    expect(ownerApprovalRecorded(OTHER, 'call-1')).toBe(false);
  });

  it('binds the answer to the exact parameters, as on every other host', async () => {
    const { box } = fakeClient(accept);
    const approvals = createMcpOwnerApproval({ server: box });
    await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(consumeOwnerApproval(TOOL, { a: 2 }, 'call-1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_CHANGED' });
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1')).toEqual({ decision: 'approved' });
  });

  it('binds the answer to one call, so a second call cannot spend it', async () => {
    const { box } = fakeClient(accept);
    const approvals = createMcpOwnerApproval({ server: box });
    await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-2'))
      .toEqual({ decision: 'unavailable', reason: 'CALL_MISMATCH' });
  });
});

describe('when the MCP root genuinely cannot ask', () => {
  it('reports APPROVAL_SURFACE_ABSENT only when there is no way to ask', async () => {
    // No client connected at all.
    const approvals = createMcpOwnerApproval({ server: {} });
    expect(approvals.canAsk()).toBe(false);
    await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1'))
      .toEqual({ decision: 'unavailable', reason: 'APPROVAL_SURFACE_ABSENT' });
  });

  it('reports it for a client that does not declare form elicitation', async () => {
    const { box, elicitInput } = fakeClient(accept, { form: false });
    const approvals = createMcpOwnerApproval({ server: box });
    expect(approvals.canAsk()).toBe(false);
    await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1'))
      .toEqual({ decision: 'unavailable', reason: 'APPROVAL_SURFACE_ABSENT' });
  });

  it('does NOT report it once a capable client is connected', async () => {
    const { box } = fakeClient(accept);
    const approvals = createMcpOwnerApproval({ server: box });
    expect(approvals.canAsk()).toBe(true);
    await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1')).toEqual({ decision: 'approved' });
  });

  it('stops asking, and says the surface is gone, after stop()', async () => {
    const { box, elicitInput } = fakeClient(accept);
    const approvals = createMcpOwnerApproval({ server: box });
    approvals.stop();
    expect(approvals.canAsk()).toBe(false);
    await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1'))
      .toEqual({ decision: 'unavailable', reason: 'APPROVAL_SURFACE_ABSENT' });
  });

  /**
   * ONE LAYOUT FOR EVERY MCP HOST, SO NOTHING IS REFUSED FOR BEING TALL.
   *
   * The folding host used to be given one input field per row and a prompt
   * too tall for five of them was refused, or the registrant's shorter
   * `folded` spelling was shown instead. Both are gone: the explanation is the
   * message on every host, a folding host may fold it, and the owner expands
   * it. So a six-row prompt is ASKED, with the primary rows, on Claude Code.
   */
  it('asks a folding host about a prompt taller than five rows, with the primary rows', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({
        kind: 'ask', title: 'Demo', description: ['a', 'b', 'c', 'd', 'e', 'f'],
        folded: { title: 'Demo, in short', description: ['a', 'the rest: read it above'] },
      }) });
    const { box, elicitInput } = fakeClient(accept, { name: 'claude-code' });
    const approvals = createMcpOwnerApproval({ server: box });

    await approvals.beforeDispatch(TOOL, {}, 'call-1');

    expect(elicitInput).toHaveBeenCalledOnce();
    const form = elicitInput.mock.calls[0]![0] as unknown as { message: string };
    expect(form.message).toBe('Demo\n\na\nb\nc\nd\ne\nf');
    expect(form.message).not.toContain('in short');
    expect(consumeOwnerApproval(TOOL, {}, 'call-1')).toEqual({ decision: 'approved' });
  });
});

/**
 * ONE REAL INPUT, AND THE EXPLANATION IN THE MESSAGE.
 *
 * An owner approving a long draft on Claude Code was shown five text boxes
 * titled (1)…(5), typed into the first, and found the form baffling. Those
 * boxes were the explanation, declared as `type: 'string'` fields; what was
 * typed into them was read by nothing. The explanation is now the message on
 * every MCP host, and the form holds the one thing the owner actually decides.
 *
 * The box is required and declared `default: false`. With that default, an
 * untouched Accept (Claude Code 2.1.283) or Enter (codex-cli 0.157.1) came
 * back `confirm: false` in the 2026-09-27 probes, which is a refusal here.
 */
describe('the dialog every MCP host is given', () => {
  const prompt = { title: 'Demo', description: 'a: one\nb: two', lines: ['a: one', 'b: two'], timeoutMs: 1000 };
  const CLIENTS = ['claude-code', 'codex-mcp-client', 'some-unrecognised-host'];

  afterEach(() => { setOwnerLang(undefined); });

  it.each(CLIENTS)('asks %s with exactly one property: the confirmation, unticked by default', async (name) => {
    const { box, elicitInput } = fakeClient(accept, { name });
    await createMcpOwnerApproval({ server: box }).beforeDispatch(TOOL, { a: 1 }, 'call-1');

    const form = elicitInput.mock.calls[0]![0] as unknown as {
      message: string; requestedSchema: { properties: Record<string, Record<string, unknown>>; required: string[] } };
    expect(Object.keys(form.requestedSchema.properties)).toEqual(['confirm']);
    expect(Object.keys(form.requestedSchema.properties).some(key => /^row\d+$/.test(key))).toBe(false);
    const confirm = form.requestedSchema.properties['confirm']!;
    expect(confirm['type']).toBe('boolean');
    // No server-side pre-approval: the box starts unticked, never ticked.
    expect(confirm['default']).toBe(false);
    expect(JSON.stringify(form.requestedSchema)).not.toMatch(/"default":\s*true/);
    expect(form.requestedSchema.required).toEqual(['confirm']);
    // And the explanation the fields used to carry is in the message.
    expect(form.message).toBe('Demo\n\ndo: {"a":1}');
  });

  it('puts the title and every row in the message, in order', () => {
    const dialog = buildApprovalDialog(prompt);
    expect(dialog.message).toBe('Demo\n\na: one\nb: two');
    expect(Object.keys(dialog.requestedSchema.properties)).toEqual(['confirm']);
  });

  it.each(['en', 'zh-CN'] as const)('labels the confirmation from the lexicon, in %s', (lang) => {
    setOwnerLang(lang, 'config');
    const confirm = (buildApprovalDialog(prompt).requestedSchema.properties as Record<string, { title?: string; description?: string }>)['confirm']!;
    expect(confirm.title).toBe(renderCopy(lang, 'ownerApproval.confirm.title'));
    expect(confirm.description).toBe(renderCopy(lang, 'ownerApproval.confirm.description'));
  });

  it('uses the label a registrant supplies for its own action instead of the generic one', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 'Demo', description: ['a'], confirmLabel: 'Do the demo thing' }) });
    const { box, elicitInput } = fakeClient(accept);
    await createMcpOwnerApproval({ server: box }).beforeDispatch(TOOL, {}, 'call-1');
    const form = elicitInput.mock.calls[0]![0] as unknown as { requestedSchema: { properties: Record<string, { title?: string }> } };
    expect(form.requestedSchema.properties['confirm']!.title).toBe('Do the demo thing');
    expect(consumeOwnerApproval(TOOL, {}, 'call-1')).toEqual({ decision: 'approved' });
  });

  it('refuses a registrant label that paints nothing, like any other prompt text', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: () => 'k',
      describe: () => ({ kind: 'ask', title: 'Demo', description: ['a'], confirmLabel: 'Send‮' }) });
    const { box, elicitInput } = fakeClient(accept);
    await createMcpOwnerApproval({ server: box }).beforeDispatch(TOOL, {}, 'call-1');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(consumeOwnerApproval(TOOL, {}, 'call-1')).toEqual({
      decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PROMPT_UNPRINTABLE' });
  });

  /** Consent is `accept` AND `confirm === true`; everything else sends nothing. */
  it.each([
    { label: 'accept, confirm true', answer: { action: 'accept', content: { confirm: true } }, sent: true, decision: 'approved' },
    { label: 'accept, confirm false', answer: { action: 'accept', content: { confirm: false } }, sent: false, decision: 'denied' },
    { label: 'accept, confirm missing', answer: { action: 'accept', content: {} }, sent: false, decision: 'denied' },
    { label: 'accept, no content', answer: { action: 'accept' }, sent: false, decision: 'denied' },
    { label: 'accept, confirm "true" as a string', answer: { action: 'accept', content: { confirm: 'true' } }, sent: false, decision: 'denied' },
    { label: 'decline, even with confirm true', answer: { action: 'decline', content: { confirm: true } }, sent: false, decision: 'denied' },
    { label: 'cancel, even with confirm true', answer: { action: 'cancel', content: { confirm: true } }, sent: false,
      outcome: { decision: 'unavailable', reason: 'OWNER_CONFIRMATION_CANCELLED' } },
  ])('$label → sent: $sent', async ({ answer, sent, decision, outcome: expected }) => {
    const { box } = fakeClient(answer, { name: 'claude-code' });
    const approvals = createMcpOwnerApproval({ server: box });
    let didSend = false;
    let outcome: unknown;
    await approvals.aroundDispatch(TOOL, { a: 1 }, 'call-1', undefined, async () => {
      outcome = consumeOwnerApproval(TOOL, { a: 1 }, 'call-1');
      if ((outcome as { decision: string }).decision === 'approved') didSend = true;
    });
    expect(didSend).toBe(sent);
    expect(outcome).toEqual(expected ?? { decision });
  });

  it('binds the same canonical subject, once, whatever the layout', async () => {
    registerOwnerApprovalSubject(TOOL, { canonicalize: params => `bound:${JSON.stringify(params)}`,
      describe: () => ({ kind: 'ask', title: 'Demo', description: ['a', 'b', 'c', 'd', 'e', 'f'] }) });
    const { box } = fakeClient(accept, { name: 'claude-code' });
    await createMcpOwnerApproval({ server: box }).beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(consumeOwnerApproval(TOOL, { a: 2 }, 'call-1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_CHANGED' });
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1')).toEqual({ decision: 'approved' });
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1'))
      .toEqual({ decision: 'unavailable', reason: 'ALREADY_CONSUMED' });
  });
});

/**
 * THE ID MUST BE THE SAME STRING ON BOTH SIDES.
 *
 * The wrapper asks under one call identity and the tool body consumes under
 * another that `dispatchMcpCall` derives. If they ever disagree, every
 * approval on MCP fails to be found and the tool can never send — and the
 * failure is silent, because both halves look correct on their own. The
 * fallback makes this a live hazard rather than a theoretical one: an id the
 * sanitiser rejects becomes `Date.now()`, which is a DIFFERENT value each time
 * it is computed.
 */
describe('the call identity the wrapper and the body agree on', () => {
  it('matches what dispatchMcpCall hands the tool body, for every id shape', async () => {
    // The fixture has to cross every boundary where the two rules could
    // disagree: the sanitiser's character class, its LENGTH bound (120 — an id
    // of exactly 120 passes both a correct and a wrongly-widened rule, so it
    // proves nothing on its own), and the unsanitary ids that take the
    // timestamp fallback.
    for (const requestId of ['7', 7, 'abc-123', 'a.b:c_d', '', undefined,
      'x'.repeat(119), 'x'.repeat(120), 'x'.repeat(121), 'x'.repeat(150),
      'has space', 'has/slash', 'has#hash', '\u676d\u5dde']) {
      const callRef = mcpApprovalCallRef({ requestId });
      // The root passes the derived id on, exactly as `src/mcp.ts` does.
      const passed = callRef.slice('mcp_'.length);
      let seen: string | undefined;
      await dispatchMcpCall({ execute: async (id: string) => { seen = id; return null; } },
        {}, { requestId: passed });
      expect(seen, `requestId ${String(requestId)}`).toBe(callRef);
    }
  });

  it('never produces an id the world dialog would reject as malformed', () => {
    for (const requestId of ['has space', 'has/slash', 'has#hash', '']) {
      expect(mcpApprovalCallRef({ requestId })).toMatch(/^mcp_[A-Za-z0-9_.:-]{1,120}$/);
    }
  });
});

/**
 * RESTATED IS A DECISION; DRIFTED IS AN ACCIDENT.
 *
 * This module's dialog budget is a hand copy of the Claude Code 2.1.278
 * measurements recorded in `mcp-owner-authorization.ts`. Copying rather than
 * importing is deliberate — the two dialogs may legitimately diverge, and a
 * shared constant would hide the day they stop meaning the same thing. What
 * that argument does not buy is silence when one side is edited and the other
 * is not: that looks like a deliberate divergence and reads like nothing at
 * all. Divergence now has to be written down HERE, in this test, before it can
 * ship.
 */
describe('the two MCP dialog budgets', () => {
  it('still agree, number for number, with the measurement they were copied from', () => {
    expect(MCP_APPROVAL_DIALOG_BUDGET).toEqual(MCP_DIALOG_BUDGET);
    // Named, so a drift report says WHICH number moved rather than "objects differ".
    expect(MCP_APPROVAL_DIALOG_BUDGET.fieldDescriptionColumns).toBe(MCP_DIALOG_BUDGET.fieldDescriptionColumns);
    expect(MCP_APPROVAL_DIALOG_BUDGET.summaryLineColumns).toBe(MCP_DIALOG_BUDGET.summaryLineColumns);
    expect(MCP_APPROVAL_DIALOG_BUDGET.maxFields).toBe(MCP_DIALOG_BUDGET.maxFields);
  });
});

/**
 * THE LOOKUP IS PER REQUEST, AND THAT IS LOAD-BEARING.
 *
 * `subjects.get(toolName)` runs when a call arrives, not when the wrapper is
 * installed. Two composition roots install this wrapper at different points
 * relative to tool registration, and a peer team's tool registers its own
 * subject; capturing the descriptor at install time would work in whichever
 * order happened to be tested and silently drop every registrant that arrived
 * afterwards. Pinned here so nobody "optimises" the lookup into a capture.
 */
describe('when the seam looks a subject up', () => {
  it('finds a subject registered after the wrapper was already installed', async () => {
    resetOwnerApprovals();
    const backend = createMcpOwnerApproval({ server: fakeClient(accept).box });
    const late = 'registered_afterwards';
    // Installed first, with an EMPTY registry: nothing to capture even if it tried.
    expect(await backend.aroundDispatch(late, { a: 1 }, 'late-1', undefined, async () => 'ran')).toBe('ran');
    expect(consumeOwnerApproval(late, { a: 1 }, 'late-1'))
      .toEqual({ decision: 'unavailable', reason: 'SUBJECT_NOT_REGISTERED' });

    registerOwnerApprovalSubject(late, descriptor);
    // Consumed INSIDE the body, which is the contract: an approval that
    // outlives its own call is a defect the seam now reports (see below).
    let outcome: unknown;
    expect(await backend.aroundDispatch(late, { a: 1 }, 'late-2', undefined, async () => {
      outcome = consumeOwnerApproval(late, { a: 1 }, 'late-2');
      return 'ran';
    })).toBe('ran');
    expect(outcome).toEqual({ decision: 'approved' });
  });
});

/**
 * A GRANT NOBODY SPENT IS A DEFECT, AND IT IS NOW LOUD.
 *
 * Not registering the world subject on this root fixes the case that shipped;
 * it does not fix the CLASS. The trap returns the moment someone registers a
 * subject whose body does not call `consumeOwnerApproval`: the owner is asked,
 * an answer is taken, and then it decides nothing — the exact failure that
 * just happened, and it happened in total silence.
 *
 * So the seam checks after the body returns. It does NOT refuse then — too
 * late, and refusing after execution would change what the seam does rather
 * than what it says — it reports the tool by name and drops the record, so no
 * live grant outlives the call it was given for.
 */
describe('when a body never consumes the approval it was given', () => {
  it('names the tool at error level and leaves no live grant behind', async () => {
    const errors: Array<{ context: unknown; message: string }> = [];
    const approvals = createMcpOwnerApproval({ server: fakeClient(accept).box,
      logger: { warn: () => {}, error: (context, message) => errors.push({ context, message }) } });
    // A body that dispatches happily and consumes nothing — a silent success
    // before this check existed.
    expect(await approvals.aroundDispatch(TOOL, { a: 1 }, 'call-9', undefined, async () => 'ran')).toBe('ran');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain(TOOL);
    expect(errors[0]!.context).toMatchObject({ tool: TOOL, call_ref: 'call-9' });
    expect(ownerApprovalGranted(TOOL, 'call-9')).toBe(false);
    // Spent rather than merely forgotten: a late reader is told it is a
    // replay, not that nobody was ever asked.
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-9'))
      .toEqual({ decision: 'unavailable', reason: 'ALREADY_CONSUMED' });
  });

  it('says nothing when the body consumed, and nothing when there was no consent to spend', async () => {
    const errors: string[] = [];
    const logger = { warn: () => {}, error: (_context: unknown, message: string) => errors.push(message) };
    const approved = createMcpOwnerApproval({ server: fakeClient(accept).box, logger });
    await approved.aroundDispatch(TOOL, { a: 1 }, 'call-10', undefined, async () => {
      expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-10')).toEqual({ decision: 'approved' });
    });
    const denied = createMcpOwnerApproval({ server: fakeClient({ action: 'decline' }).box, logger });
    await denied.aroundDispatch(TOOL, { a: 1 }, 'call-11', undefined, async () => 'ran');
    expect(errors).toEqual([]);
  });

  /**
   * THE REPORT MAY NOT BECOME THE ANSWER.
   *
   * `reportDefect` runs from a `finally`, and a `finally` that throws replaces
   * whatever the block was going to produce. So a host logger that threw
   * turned this guard — whose entire promise is that it changes nothing but
   * visibility — into the tool's result: a successful call would have
   * rejected with the logger's error, and a failed one would have lost its own
   * error and reported the logger's instead.
   */
  it('cannot turn a throwing host logger into the tool\'s result', async () => {
    const throwing = {
      warn: (): void => { throw new Error('WARN_THREW'); },
      error: (): void => { throw new Error('LOGGER_THREW'); },
    };
    const approvals = createMcpOwnerApproval({ server: fakeClient(accept).box, logger: throwing });
    expect(await approvals.aroundDispatch(TOOL, { a: 1 }, 'call-13', undefined, async () => 'ran')).toBe('ran');
    // The report was lost; the drop was not.
    expect(ownerApprovalGranted(TOOL, 'call-13')).toBe(false);
    // And a failing body keeps its OWN error rather than the logger's.
    await expect(approvals.aroundDispatch(TOOL, { a: 1 }, 'call-14', undefined, async () => {
      throw new Error('BODY_FAILED');
    })).rejects.toThrow('BODY_FAILED');
  });

  it('still reports, and still drops, when the body throws', async () => {
    const errors: string[] = [];
    const approvals = createMcpOwnerApproval({ server: fakeClient(accept).box,
      logger: { warn: () => {}, error: (_context: unknown, message: string) => errors.push(message) } });
    await expect(approvals.aroundDispatch(TOOL, { a: 1 }, 'call-12', undefined, async () => {
      throw new Error('BODY_FAILED');
    })).rejects.toThrow('BODY_FAILED');
    expect(errors).toHaveLength(1);
    expect(ownerApprovalGranted(TOOL, 'call-12')).toBe(false);
  });
});

/**
 * THE REGISTRANT'S LINE UNDER THE ONE INPUT IS DROPPED, NEVER REFUSED. It is a
 * pointer, not the subject: when it cannot be shown, the generic line is, and
 * the owner is still asked.
 */
describe('the line under the confirmation', () => {
  const withLine = (line: string): OwnerApprovalSubjectDescriptor => ({
    ...descriptor, describe: params => ({ ...(descriptor.describe(params) as object), confirmDescription: line }) as never,
  });
  async function shownUnder(line: string) {
    resetOwnerApprovals();
    registerOwnerApprovalSubject(TOOL, withLine(line));
    const { box, elicitInput } = fakeClient(accept);
    await createMcpOwnerApproval({ server: box }).beforeDispatch(TOOL, { a: 1 }, 'call-1');
    const form = elicitInput.mock.calls[0]?.[0] as { requestedSchema: { properties: { confirm: { description: string } } } } | undefined;
    return { asked: elicitInput.mock.calls.length, shown: form?.requestedSchema.properties.confirm.description,
      outcome: consumeOwnerApproval(TOOL, { a: 1 }, 'call-1') };
  }
  const generic = () => renderCopy('en', 'ownerApproval.confirm.description');

  it('falls back to the generic line when the registrant line is 81 columns wide', async () => {
    setOwnerLang('en', 'config');
    // The control: exactly 80 columns is shown as given.
    expect((await shownUnder('x'.repeat(80))).shown).toBe('x'.repeat(80));
    const r = await shownUnder('x'.repeat(81));
    expect(r.shown).toBe(generic());
    expect(r.asked).toBe(1);
    expect(r.outcome).toEqual({ decision: 'approved' });
  });

  it.each([
    ['a line break', 'Full draft d-1 is above\nsecond line'],
    ['a zero-width space', 'Full draft d-1​is above'],
  ])('drops a registered line containing %s, and still asks', async (_name, line) => {
    setOwnerLang('en', 'config');
    const r = await shownUnder(line);
    expect(r.shown).toBe(generic());
    expect(r.asked).toBe(1);
    expect(r.outcome).toEqual({ decision: 'approved' });
  });
});

/**
 * A registrant's first-screen spelling goes through the seam's screen like the
 * primary, and an unshowable one is DROPPED: the dialog shows the primary
 * title and rows, and the prompt is still asked, never refused.
 */
describe('the first-screen spelling is screened, and dropped rather than refused', () => {
  const firstScreenOf = (firstScreen: { title: string; description: string[] }): OwnerApprovalSubjectDescriptor => ({
    canonicalize: params => JSON.stringify(params ?? null),
    describe: () => ({ kind: 'ask', title: 'Demo', description: ['do: it'], firstScreen }),
  });
  async function messageFor(d: OwnerApprovalSubjectDescriptor): Promise<string> {
    registerOwnerApprovalSubject(TOOL, d);
    const { box, elicitInput } = fakeClient(accept);
    await createMcpOwnerApproval({ server: box }).beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(elicitInput).toHaveBeenCalledTimes(1);
    // Asked, and answered: nothing refused the prompt.
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1')).toEqual({ decision: 'approved' });
    return (elicitInput.mock.calls[0]![0] as { message: string }).message;
  }

  it('shows a showable one', async () => {
    expect(await messageFor(firstScreenOf({ title: 'Lead', description: ['under it'] }))).toBe('Lead\n\nunder it');
  });

  it.each([
    { label: 'a row carrying a line break', firstScreen: { title: 'Lead', description: ['forged\nrow'] } },
    { label: 'an over-budget title', firstScreen: { title: 'x'.repeat(100), description: ['under it'] } },
  ])('falls back to the primary for $label', async ({ firstScreen }) => {
    expect(await messageFor(firstScreenOf(firstScreen))).toBe('Demo\n\ndo: it');
  });
});

describe('a subject that brings its own display budget', () => {
  /**
   * The world dialog is registered on the native root only (`mcp.ts`). It is
   * bounded by the seam's screen at 496 code points, not by its own
   * composition, so if it were ever registered on an MCP root it must keep
   * that budget rather than silently inherit the MCP full-text one.
   */
  it('the world subject pins the native budget', () => {
    expect(createWorldInvokeApprovalSubject(() => null).displayBudget).toBe(NATIVE_APPROVAL_DISPLAY_BUDGET);
  });

  it('keeps its own budget on the MCP backend: an over-native prompt is refused, not asked', async () => {
    resetOwnerApprovals();
    registerOwnerApprovalSubject(TOOL, {
      ...descriptor,
      displayBudget: NATIVE_APPROVAL_DISPLAY_BUDGET,
      describe: () => ({ kind: 'ask', title: 'Demo', description: ['x'.repeat(600)] }),
    });
    const { box, elicitInput } = fakeClient(accept);
    const approvals = createMcpOwnerApproval({ server: box });
    await approvals.beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(elicitInput).not.toHaveBeenCalled();
    expect(consumeOwnerApproval(TOOL, { a: 1 }, 'call-1')).toEqual({
      decision: 'unavailable', reason: 'SUBJECT_REFUSED', detail: 'APPROVAL_PROMPT_TOO_LONG' });
  });

  it('and without one, the same prompt takes the MCP backend budget and is asked', async () => {
    resetOwnerApprovals();
    registerOwnerApprovalSubject(TOOL, {
      ...descriptor, describe: () => ({ kind: 'ask', title: 'Demo', description: ['x'.repeat(600)] }),
    });
    const { box, elicitInput } = fakeClient(accept);
    await createMcpOwnerApproval({ server: box }).beforeDispatch(TOOL, { a: 1 }, 'call-1');
    expect(elicitInput).toHaveBeenCalledTimes(1);
  });
});
