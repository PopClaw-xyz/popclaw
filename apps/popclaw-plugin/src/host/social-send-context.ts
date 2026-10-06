/** Ordinary social sends use the host's current invocation after conversational
 * manuscript confirmation. Identity is not proof that a manuscript was read. */
import { withActionInvocation } from '../runtime/house-lifecycle/action-context.js';

export type SocialSendHost = 'native' | 'local-stdio' | 'hosted';
/** Connection identity, not a human-chat session or proof of content consent.
 * Supplied dynamically by trusted root assembly inside the actual invocation.
 * Hosted must retain its own async authentication and outbound effect admission. */
export interface HostedSocialInvocation {
  readonly scope: string;
  readonly purpose: 'prepare' | 'chat-send';
  assertCurrent(): void;
}
export type HostedSocialContext = () => HostedSocialInvocation | null;
type HostedContext = {getHostedSocialInvocation?: HostedSocialContext};
function hosted(context: unknown): HostedSocialInvocation | null {
  const getter = (context as HostedContext | null)?.getHostedSocialInvocation;
  return typeof getter === 'function' ? getter() : null;
}
export type SocialDraftBinding = Readonly<{host: 'local-stdio'}> | Readonly<{host: 'hosted'; scope: string}> | Readonly<{
  host: 'native'; agentId: string; sessionId: string; sessionKey: string; senderId: string | null;
}>;
type NativeContext = {agentId?: unknown; sessionId?: unknown; sessionKey?: unknown;
  requesterSenderId?: unknown; senderIsOwner?: unknown; assertInvocationCurrent?: unknown};
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Store only stable identity. Never park the drafting turn's expiring guard. */
export function socialDraftBinding(host: SocialSendHost | undefined, context: unknown): SocialDraftBinding | null {
  if (host === 'local-stdio') return Object.freeze({host: 'local-stdio'});
  if (host === 'hosted') {
    const ctx = hosted(context);
    return ctx && text(ctx.scope) ? Object.freeze({host: 'hosted', scope: ctx.scope}) : null;
  }
  const ctx = context as NativeContext | null;
  if (ctx?.senderIsOwner !== true || !text(ctx.agentId) || !text(ctx.sessionId) || !text(ctx.sessionKey)) return null;
  return Object.freeze({host: 'native', agentId: ctx.agentId, sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey, senderId: text(ctx.requesterSenderId) ? ctx.requesterSenderId : null});
}
export function sameSocialDraftBinding(a: SocialDraftBinding | null | undefined, b: SocialDraftBinding | null): boolean {
  if (!a || !b || a.host !== b.host) return false;
  if (a.host === 'local-stdio' && b.host === 'local-stdio') return true;
  if (a.host === 'hosted' && b.host === 'hosted') return a.scope === b.scope;
  return a.host === 'native' && b.host === 'native' && a.agentId === b.agentId
    && a.sessionId === b.sessionId && a.sessionKey === b.sessionKey && a.senderId === b.senderId;
}

/** Selected only by trusted root assembly, never by tool arguments. */
export function socialSendAssertion(host: SocialSendHost | undefined, context: unknown, signal?: AbortSignal): (() => void) | null {
  if (host === 'local-stdio') return () => signal?.throwIfAborted();
  if (host === 'hosted') {
    const invocation = hosted(context);
    if (!invocation || !text(invocation.scope) || invocation.purpose !== 'chat-send' || typeof invocation.assertCurrent !== 'function') return null;
    return () => { signal?.throwIfAborted(); invocation.assertCurrent(); };
  }
  const ctx = context as NativeContext | null;
  if (!socialDraftBinding(host, context) || typeof ctx?.assertInvocationCurrent !== 'function') return null;
  return () => {
    signal?.throwIfAborted();
    // Re-read the live owner bit, including host-verified owner continuations.
    if (ctx.senderIsOwner !== true) throw new Error('SOCIAL_SEND_OWNER_REQUIRED');
    (ctx.assertInvocationCurrent as () => void)();
  };
}

/** Keep the current send assertion through asynchronous preparation and egress.
 * captureActionContext retains House generations, but never this turn assertion. */
export function withSocialSendInvocation<T>(assertCurrent: () => void, work: () => T): T {
  assertCurrent();
  return withActionInvocation(assertCurrent, work);
}

/** v2 is a native SDK contract. Local stdio is an explicitly different root. */
export function socialToolFactory(host: SocialSendHost | undefined, create: (ctx: unknown) => unknown, getHostedSocialInvocation?: HostedSocialContext): unknown {
  if (host === 'hosted') return () => create({getHostedSocialInvocation});
  return host === 'local-stdio' ? create : {contextVersion: 2, create};
}
