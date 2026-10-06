/**
 * Script one owner decision through the REAL seam.
 *
 * Nothing here stands in for `owner-approval.ts`: it drives the seam's own
 * `ownerApprovalBeforeToolCall` — which runs the registrant's `canonicalize`
 * and `describe` — and then answers the request the same way the host's
 * `onResolution` does. So a test that "approves" a draft has exercised the
 * subject comparison end to end, and a test that changes the draft afterwards
 * gets the seam's real `SUBJECT_CHANGED` rather than a stub's idea of it.
 */
import {
  ownerApprovalBeforeToolCall,
  setOwnerApprovalSurface,
} from '../../src/host/owner-approval.js';

/** What the seam accepts as the owner's own direct turn. */
export function ownerDirectContext(callRef: string): {
  toolCallId: string;
  requester: { channel: string; senderId: string; senderIsOwner: boolean };
} {
  return {
    toolCallId: callRef,
    requester: { channel: 'tui', senderId: 'owner-fixture', senderIsOwner: true },
  };
}

/** What the host may come back with, plus `timeout` for "nobody answered". */
export type ScriptedDecision = 'allow-once' | 'deny' | 'timeout';

/**
 * Ask, then answer. Returns whether the seam actually built a prompt — a
 * descriptor that refused never reaches the owner, and a test that expects a
 * refusal asserts on this rather than on the tool's wording alone.
 */
export async function scriptOwnerDecision(
  toolName: string,
  params: unknown,
  callRef: string,
  decision: ScriptedDecision,
): Promise<'asked' | 'never-asked'> {
  setOwnerApprovalSurface(true);
  const request = await ownerApprovalBeforeToolCall(
    { toolName, params, toolCallId: callRef },
    ownerDirectContext(callRef),
  );
  if (!request) return 'never-asked';
  // A timeout is the host never calling `onResolution` at all.
  if (decision !== 'timeout') request.requireApproval.onResolution(decision);
  return 'asked';
}

/** The owner read the prompt and said yes. */
export const scriptOwnerApproval = (toolName: string, params: unknown, callRef: string): Promise<'asked' | 'never-asked'> =>
  scriptOwnerDecision(toolName, params, callRef, 'allow-once');

/** Fresh per call: an approval is bound to ONE call identity, and reusing a
 *  spent one would be answered `ALREADY_CONSUMED` rather than approved. */
let calls = 0;
export const nextCallRef = (prefix = 'call'): string => `${prefix}-${++calls}`;

/** The fixture represents ordinary chat confirmation before invoking the
 * tool. It is not a server-observed proof of human content consent. */
export async function sendDraftConfirmed(
  execute: (callId: string, params: unknown) => Promise<{ text: string }>,
  draftId: string,
): Promise<{ text: string }> {
  const callRef = nextCallRef('send-draft');
  return execute(callRef, { draft_id: draftId });
}
