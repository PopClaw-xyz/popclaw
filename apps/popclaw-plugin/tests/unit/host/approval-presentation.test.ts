import {afterEach, expect, it, vi} from 'vitest';
import {NATIVE_APPROVAL_PROFILE, displayWidth, type ApprovalDialogProfile} from '../../../src/host/approval-presentation.js';
import {consumeOwnerApproval, registerOwnerApprovalSubject, resetOwnerApprovals} from '../../../src/host/owner-approval.js';
import {createMcpOwnerApproval, MCP_APPROVAL_PROFILE} from '../../../src/host/mcp-owner-approval.js';
afterEach(() => resetOwnerApprovals());
it('keeps shared display widths for non-social action prompts', () => {
  expect(displayWidth('中a')).toBe(3);
  expect(displayWidth('hello')).toBe(5);
});
it('numeric subject budgets cannot replace the host content and layout policy', async () => {
  let resolved: ApprovalDialogProfile | undefined;
  registerOwnerApprovalSubject('world-fixture', {
    canonicalize: () => 'fixed', displayBudget: NATIVE_APPROVAL_PROFILE.budget,
    describe(_params, profile) {resolved = profile; return {kind: 'ask', title: 'World action', description: ['Actual world effect']};},
  });
  const elicitInput = vi.fn(async () => ({action: 'accept', content: {confirm: true}}));
  const backend = createMcpOwnerApproval({server: {current: {elicitInput,
    getClientCapabilities: () => ({elicitation: {form: {}}})} as never}});
  const params = {profile: NATIVE_APPROVAL_PROFILE, budget: 999999};
  await backend.beforeDispatch('world-fixture', params, 'mcp-policy');
  expect(resolved?.budget).toBe(NATIVE_APPROVAL_PROFILE.budget);
  expect(resolved?.draftPresentation).toBe(MCP_APPROVAL_PROFILE.draftPresentation);
  expect(resolved?.layout).toBe(MCP_APPROVAL_PROFILE.layout);
  expect(elicitInput).toHaveBeenCalledTimes(1);
  expect(consumeOwnerApproval('world-fixture', params, 'mcp-policy')).toEqual({decision: 'approved'});
});
