/**
 * Current-turn direct draft preview delivery (additive fix, 2026-09-06).
 *
 * The confirmed defect: the draft tool result already carried the complete
 * preview, but the host Agent may answer the owner with only "full content
 * above" — never displaying the body, or silently dropping the identity
 * warnings. On OpenClaw 8.2 the tool factory's context can carry a delivery
 * capability bound to the CURRENT turn and the owner's route (the host
 * itself rejects it once expired). This requests a separate preview even
 * when the agent discards the tool result; actual display remains subject
 * to the host's delivery and text-normalization behavior.
 *
 * Truthfulness rules this module exists to enforce (they shape the API):
 *  - `delivery.send` resolves **void** and discards its own result. A normal
 *    resolution is only "the request completed" — NEVER evidence that the
 *    owner saw anything. Throws may equally have followed partial delivery.
 *    So the only three states worth recording are `unavailable` (no credible
 *    capability, nothing attempted), `failed` (the attempt threw), and
 *    `unknown` (the attempt completed — and that is ALL we know).
 *  - Exactly one attempt, no silent retry: a `failed` preview must not
 *    re-fire on its own; the agent-facing note tells the agent to show the
 *    draft itself instead.
 *  - The capability is read ONLY from the factory tool context. Tool
 *    arguments are model output — they can neither manufacture a capability
 *    nor override the trusted route (the draft tools never consult their
 *    params for anything delivery-related).
 *  - Never fall back to ownerPush / the global last channel / a reimplemented
 *    route dispatch: the 8.2 capability is the only channel this module
 *    touches. 7.1-2 hosts (route/owner/session context, no `delivery`) and
 *    the MCP bridge (factories resolved with `{}`) land on `unavailable`,
 *    and the tool result is byte-identical to the pre-fix fallback.
 *
 * AND THE ROUTE IS NOW ASKED ABOUT FIRST (ruling of 2026-09-21T20:09Z). A
 * capability the host bound to this turn says the push will arrive; it does
 * NOT say the turn is a chat the owner alone can read. The approve button
 * being in the owner's private chat never proved the full text before it was
 * also in that chat, because this module reads `ctx.delivery` while the
 * prompt is routed by `approvals.plugin` — two different destinations. So the
 * push now waits for the SAME decision the owner-approval seam makes about
 * this turn (`host/owner-approval.ts` `ownerApprovalOriginRefusal`), and a
 * turn that decision would refuse gets no preview and a named reason.
 */

import { ownerApprovalOriginRefusal, type OwnerApprovalOriginRefusal } from '../host/owner-approval.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { getOrCreatePerProcess, resetSingletonForTest } from '../runtime/once.js';

/**
 * What the host's factory tool-context can carry, structurally — the
 * reviewer-verified OpenClaw 8.2 shape. The plugin SDK's tool API is
 * structurally unknown to us (same stance as the newspaper tools'
 * `{ sessionKey?: string }`), so every field is optional and duck-typed;
 * `credibleOwnerDelivery` is the single place that judges it.
 */
export interface ToolCtxDeliverySurface {
  /** The current-turn channel capability. `send` resolving void is normal. */
  readonly delivery?: {
    send?: (payload: { text?: string; mediaUrl?: string }) => Promise<void>;
  };
  readonly sessionKey?: unknown;
  readonly sessionId?: unknown;
  readonly requesterSenderId?: unknown;
  readonly senderIsOwner?: unknown;
  /** The trusted route the host bound this capability to. */
  readonly deliveryContext?: {
    channel?: unknown;
    to?: unknown;
    accountId?: unknown;
    threadId?: unknown;
  };
}

export type PreviewDeliveryStatus = 'unavailable' | 'failed' | 'unknown';

/**
 * The turn is in a thread, and a thread is a part of the route the approval
 * decision cannot compare: `resolveOwnerApprovalRoute` refuses a target pinned
 * to a thread for exactly this reason (it is given no thread for the turn), so
 * handing it a threaded turn would get back an answer about the parent chat.
 * Refused rather than assumed harmless — and, unlike the leak it prevents, an
 * over-refusal says its own name in the tool result.
 *
 * Named apart from the seam's own refusals because it is a fact about THIS
 * caller's context, not about the host's routing.
 */
export const PREVIEW_ROUTE_TURN_THREADED = 'PREVIEW_ROUTE_TURN_THREADED';
/** Why no preview was pushed, when something was there to push it through. */
export type PreviewDeliveryRefusal = OwnerApprovalOriginRefusal | typeof PREVIEW_ROUTE_TURN_THREADED;

/** What a draft tool learns about its one direct-preview attempt. */
export interface PreviewDeliveryOutcome {
  readonly status: PreviewDeliveryStatus;
  /** Present only on `failed`: the thrown error's message, for the agent note. */
  readonly error?: string;
  /** Present only on `unavailable`, and only when a credible capability WAS
   *  there and the route decision refused it. Absent on the hosts that simply
   *  have no capability (7.1-2, the MCP bridge), which keep the silent
   *  pre-fix result shape. */
  readonly reason?: PreviewDeliveryRefusal;
}

/** The in-process counters (per-process via globalThis, same pattern as the draft store — module reloads share it). */
interface DraftPreviewStats {
  unavailable: number;
  failed: number;
  unknown: number;
  /** The subset of `unavailable` a route decision refused — told apart from
   *  "this host has no capability at all", which is not a refusal. */
  routeRefused: number;
  lastStatus: PreviewDeliveryStatus | null;
  lastError: string | null;
  lastReason: PreviewDeliveryRefusal | null;
}

const statsStore = (): DraftPreviewStats =>
  getOrCreatePerProcess('draft-preview-stats', () => ({
    unavailable: 0,
    failed: 0,
    unknown: 0,
    routeRefused: 0,
    lastStatus: null,
    lastError: null,
    lastReason: null,
  }));

/** Read-only view for diagnostics; never decides anything. */
export function draftPreviewStats(): Readonly<DraftPreviewStats> {
  return statsStore();
}

// Exported for test teardown only. DO NOT use from production code.
export const _draftPreviewStatsForTest = {
  reset: (): void => resetSingletonForTest('draft-preview-stats'),
};

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/**
 * Is this factory context a credible owner / current-conversation turn?
 *
 * "Credible" = the host itself vouches for every axis we cannot check:
 * the sender IS the owner, a session identifies the turn, a requester
 * identifies who spoke, and the route names a real destination. Missing any
 * one of those, dispatching user content would be a guess — the one thing
 * this fix must never do (non-owner, missing route/session/sender/capability
 * all land here and never dispatch).
 */
function credibleOwnerDelivery(
  toolCtx: unknown,
): ((payload: { text?: string; mediaUrl?: string }) => Promise<void>) | null {
  if (typeof toolCtx !== 'object' || toolCtx === null) return null;
  const ctx = toolCtx as ToolCtxDeliverySurface;
  const hasSession = nonEmptyString(ctx.sessionKey) || nonEmptyString(ctx.sessionId);
  const route = ctx.deliveryContext;
  const hasRoute =
    typeof route === 'object' &&
    route !== null &&
    nonEmptyString(route.channel) &&
    nonEmptyString(route.to);
  if (ctx.senderIsOwner !== true) return null;
  if (!hasSession) return null;
  if (!nonEmptyString(ctx.requesterSenderId)) return null;
  if (!hasRoute) return null;
  const send = ctx.delivery?.send;
  return typeof send === 'function' ? send : null;
}

/**
 * Would the owner-approval seam let this turn's prompt be built at all?
 *
 * THE SAME DECISION, NOT A SECOND ONE. `ownerApprovalOriginRefusal` is the
 * seam's own guard, and it answers both of the ways in: an owner-direct origin
 * (`webchat` / `tui`), or any other channel whose runtime-effective approval
 * routing is pinned to this very turn. Reimplementing either half here would
 * be two guards to keep in agreement, and the one that drifted would be the
 * one carrying the private body.
 *
 * THE QUERY IS BUILT FROM WHAT THIS CONTEXT ACTUALLY CARRIES — the trusted
 * `deliveryContext` route, never a tool parameter. It is NOT the same set of
 * values `owner-approval.ts` assembles from the hook context, and saying so
 * would be a claim this module cannot make: three of that query's fields have
 * no exact counterpart here.
 *
 *  - `to`: ours is `deliveryContext.to`, the address the capability will
 *    actually deliver to (`messageTo`,
 *    `openclaw/dist/openclaw-tools-Bo9W_tg_.mjs:1760-1765`,
 *    `agent-tools-DXxcrXNI.mjs:509`). The hook's is `currentChannelId`
 *    (`:759`), and its `turnSourceTo` is `currentMessagingTarget ??
 *    currentChannelId` (`:734`). On a channel whose threading adapter
 *    transforms the id these can diverge
 *    (`run-fallback-policy-CSwpHNkS.mjs:36-45`,
 *    `run-executor.runtime-DoxH_JIo.mjs:444-464`), so the two surfaces can be
 *    asking about slightly different strings.
 *    WHY THAT COSTS INERTNESS AND NOT EXPOSURE: admission requires EVERY
 *    configured approval target to equal the address we passed
 *    (`owner-approval-route.ts:463`, and it returns on the first that does
 *    not). So the value that had to match the owner's pinned chat is the
 *    delivery address itself — the one the push will use. A divergence makes
 *    the comparison fail and the preview is refused by name; it cannot admit
 *    a push to an address nobody compared.
 *  - `agentId`: the seam passes the host's own; absent is a value the resolver
 *    already handles — it asks the host's filter predicate with
 *    `fallbackAgentIdFromSessionKey`, which is what the forwarder itself does.
 *    A configured agent filter this cannot satisfy therefore refuses the
 *    preview while the approval is still asked for; that direction is safe,
 *    and it says so by name instead of going quiet.
 *  - `turnSourceTo`: the host's second projection of the destination, which
 *    this context does not carry at all. Left ABSENT rather than filled in
 *    with our own `to`: the resolver's only use for it is to refuse when the
 *    two projections DISAGREE (`OWNER_ROUTE_TURN_TARGET_DIVERGED`), so handing
 *    it a copy of the value it is meant to cross-check would turn that check
 *    into a tautology and claim agreement nobody observed. Absent is the case
 *    the resolver documents as strictly-extra-narrowing-when-present, so
 *    omitting it costs accuracy and admits nothing new.
 *
 * ASYNC ONLY BECAUSE THE SEAM'S GUARD IS. `ownerApprovalOriginRefusal` loads
 * the host package on use (`host/owner-approval-route.ts`), so it hands back a
 * promise; WHEN the decision is made has not moved. The `await` at the call
 * site is not bookkeeping — an un-awaited promise is truthy, and this value is
 * read as "refused", so dropping it would silently refuse every route.
 */
async function previewRouteRefusal(toolCtx: unknown): Promise<PreviewDeliveryRefusal | null> {
  const ctx = toolCtx as ToolCtxDeliverySurface;
  const route = ctx.deliveryContext ?? {};
  if (nonEmptyString(route.threadId)) return PREVIEW_ROUTE_TURN_THREADED;
  return ownerApprovalOriginRefusal({
    ...nonEmptyString(ctx.sessionKey) ? { sessionKey: ctx.sessionKey } : {},
    ...nonEmptyString(route.to) ? { channelId: route.to } : {},
    requester: {
      ...nonEmptyString(route.channel) ? { channel: route.channel } : {},
      ...nonEmptyString(route.accountId) ? { accountId: route.accountId } : {},
      senderIsOwner: ctx.senderIsOwner === true,
    },
  });
}

/**
 * Push ONE immutable preview through the host's current-turn capability.
 * Exactly one attempt; the draft's fate is never tied to the outcome — the
 * caller already parked the draft, and the tool result always carries the
 * full preview as the compatibility fallback.
 */
export async function deliverDraftPreview(
  toolCtx: unknown,
  preview: string,
): Promise<PreviewDeliveryOutcome> {
  const send = credibleOwnerDelivery(toolCtx);
  if (!send) {
    const s = statsStore();
    s.unavailable++;
    s.lastStatus = 'unavailable';
    s.lastError = null;
    s.lastReason = null;
    return { status: 'unavailable' };
  }
  // AFTER the capability check, so a host that has no capability at all keeps
  // its silent `unavailable` and the byte-identical pre-fix result: an MCP
  // root has no chat of its own to be wrong about.
  const refusal = await previewRouteRefusal(toolCtx);
  if (refusal) {
    const s = statsStore();
    s.unavailable++;
    s.routeRefused++;
    s.lastStatus = 'unavailable';
    s.lastError = null;
    s.lastReason = refusal;
    return { status: 'unavailable', reason: refusal };
  }
  const s = statsStore();
  s.lastReason = null;
  try {
    // Text only: a local attachment path is never laundered into `mediaUrl`.
    await send({ text: preview });
    // Void resolution = the request completed. Nothing more is known — not
    // even a "suppressed" status the host may have returned underneath.
    s.unknown++;
    s.lastStatus = 'unknown';
    s.lastError = null;
    return { status: 'unknown' };
  } catch (err) {
    // A throw may still have followed partial delivery — never word this as
    // "nothing went out".
    s.failed++;
    s.lastStatus = 'failed';
    s.lastError = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error: s.lastError };
  }
}

/**
 * The honest Agent-facing note appended to the draft tool RESULT (never to
 * the direct preview itself — technical status jargon stays out of what the
 * owner reads directly). Empty on a plain `unavailable`: nothing was
 * attempted and nothing was refused, and the pre-fix result shape is the
 * compatibility fallback old hosts keep.
 *
 * A REFUSED ROUTE IS NOT THAT SILENCE. Something was there to push through and
 * this module chose not to, so the agent is told which chat it may not use and
 * where the full text really is — through the lexicon, because the sentence
 * ends up in front of the owner whichever language they read in.
 */
export function previewDeliveryNote(outcome: PreviewDeliveryOutcome): string {
  switch (outcome.status) {
    case 'unavailable':
      if (outcome.reason === 'OWNER_ROUTE_FORWARDING_DISABLED') {
        return renderCopy(ownerLang(), 'draft.preview.forwardingDisabled', { reason: outcome.reason });
      }
      return outcome.reason === undefined ? ''
        : renderCopy(ownerLang(), 'draft.preview.notTheOwnerApprovalChat', { reason: outcome.reason });
    case 'unknown':
      return (
        'Direct preview delivery status: unknown. The current-turn preview request completed, ' +
        'but the host supplied no delivery receipt. It may have suppressed or changed the preview. ' +
        'Do not claim the complete draft was displayed or that the owner saw it, and never ' +
        'answer with just "full content above". The owner\'s explicit confirmation before ' +
        'popclaw_send_draft is still required.'
      );
    case 'failed':
      return (
        `Direct preview delivery: the attempt to push this draft straight into the owner's current ` +
        `chat failed (${outcome.error ?? 'unknown error'}). A failure may still have followed partial ` +
        'delivery, so whether the owner saw anything is unknown — show the draft above to the owner ' +
        'word for word yourself. The owner\'s explicit confirmation before popclaw_send_draft is still required.'
      );
    default:
      return '';
  }
}

/**
 * The hard instruction shared by every tool that mints a draft (real hardware,
 * 2026-07-29: the owner said "just send the picture," and the agent made up its
 * own caption text and called send without ever reading the draft back).
 *
 * This used to be the ONLY thing standing between a draft and a real outbound
 * message: instruction-level, not a gate. It did not hold — the model drafted
 * and confirmed its own draft, and a letter went out (2026-09-21). Since then
 * `popclaw_send_draft` goes through the owner-approval seam, which asks the
 * owner about the draft's immutable snapshot before the tool body runs.
 *
 * The wording stays, and gains one line, because the gate does not do this
 * part: the owner should already know what is coming when the host asks them,
 * and the agent must not narrate a send that has not happened.
 *
 * It lives here rather than in write-tools.ts because the feedback tool mints
 * drafts too (2026-09-21): one wording, so the doors cannot drift apart.
 */
export const CONFIRM_DISCIPLINE =
  'Show the draft above to the owner word for word; ' +
  'only after the owner has explicitly said to send it, hand the draft_id above to popclaw_send_draft; never call it before that confirmation. ' +
  'Never shorten or omit the body. If the channel cannot show the complete draft, do not send it; explain the limitation and arrange a complete preview first. ' +
  'popclaw_send_draft does not send by itself — the host asks the owner to approve this exact draft first — so never tell the owner it was sent until that tool says it was.';

/** preview + confirmation discipline + (when attempted) the honest delivery note. */
export function draftResultText(preview: string, outcome: PreviewDeliveryOutcome): string {
  const note = previewDeliveryNote(outcome);
  return preview + '\n' + CONFIRM_DISCIPLINE + (note ? `\n\n${note}` : '');
}
