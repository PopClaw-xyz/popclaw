import { isLocalInviteCall } from '../invite/local-invite-call.js';
/** Capture notification routing from the SDK's owner tool context, never args.
 * Registration and factory resolution remain free of runtime or storage IO. */
import type { OpenClawPluginToolContext } from 'openclaw/plugin-sdk/plugin-entry';
import type { OwnerNotifyTargetStore } from '../notifier/owner-notify-target.js';
import type { OwnerSession } from '../notifier/owner-session.js';
import type { RegisterToolsDeps } from '../tools/tools-context.js';

type NotifyRuntime = { ownerSession: OwnerSession; ownerNotifyTargetStore: OwnerNotifyTargetStore };
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function withOpenClawNotifyRoute(
  api: RegisterToolsDeps['api'], runtime: () => Promise<NotifyRuntime>, warn: (message: string) => void,
): RegisterToolsDeps['api'] {
  const capture = async (context: unknown, signal: unknown) => {
    const ctx = context as OpenClawPluginToolContext | null;
    const dc = ctx?.deliveryContext;
    if (ctx?.senderIsOwner !== true || !text(ctx.sessionKey) || !text(dc?.channel) || !text(dc?.to)
      || typeof ctx.assertInvocationCurrent !== 'function') return;
    const sessionKey = ctx.sessionKey;
    const deliveryContext = { channel: dc.channel, to: dc.to, accountId: dc.accountId, threadId: dc.threadId ?? undefined };
    const current = () => {
      if (signal instanceof AbortSignal) signal.throwIfAborted();
      ctx.assertInvocationCurrent!();
      const latest = ctx.deliveryContext;
      if (ctx.senderIsOwner !== true || ctx.sessionKey !== sessionKey
        || latest?.channel !== deliveryContext.channel || latest.to !== deliveryContext.to
        || latest.accountId !== deliveryContext.accountId || (latest.threadId ?? undefined) !== deliveryContext.threadId) {
        throw new Error('OWNER_NOTIFY_CONTEXT_STALE');
      }
    };
    current();
    const rt = await runtime();
    current();
    await rt.ownerNotifyTargetStore.captureIfUnset({ sessionKey, deliveryContext }, current);
    current();
    rt.ownerSession.set(sessionKey, deliveryContext);
  };
  const wrap = (tool: unknown, context: unknown): unknown => {
    const t = tool as { execute?: (...args: unknown[]) => unknown } | null;
    if (typeof t?.execute !== 'function') return tool;
    const execute = t.execute;
    return { ...t, execute: async (...args: unknown[]) => {
      if (isLocalInviteCall((t as {name?: string}).name ?? '', args[1])) {
        const posted = (args[1] as {posted?: unknown} | null)?.posted === true;
        const result = await execute.apply(t, args);
        const outcome = result as {isError?: boolean; owner_action_required?: boolean} | null;
        // Local preparation/preview must not boot. A successful ordinary Native
        // submission has already entered its guarded command; retain its route
        // for the existing verification-result notification path.
        if (posted && outcome && !outcome.isError && !outcome.owner_action_required) {
          await capture(context, args[2]).catch(error => warn(`popclaw: notify target capture failed: ${String(error)}`));
        }
        return result;
      }
      const captured = capture(context, args[2]).catch(error => {
        warn(`popclaw: notify target capture failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      // Invoke immediately so the original tool still snapshots its parameters
      // before any await; route persistence does not delay that boundary.
      try { return await execute.apply(t, args); }
      finally { await captured; }
    } };
  };
  return { ...api, registerTool: (tool: unknown, opts?: unknown) => {
    const descriptor = tool as { contextVersion?: number; create?: (ctx: unknown) => unknown } | null;
    const create = (ctx: unknown) => {
      const resolved = typeof tool === 'function' ? tool(ctx)
        : descriptor?.contextVersion === 2 && typeof descriptor.create === 'function' ? descriptor.create(ctx) : tool;
      return Array.isArray(resolved) ? resolved.map(t => wrap(t, ctx)) : wrap(resolved, ctx);
    };
    if (descriptor?.contextVersion === 2 && typeof descriptor.create === 'function') {
      api.registerTool({ ...descriptor, create }, opts);
    } else {
      // Plain objects need a factory to receive the same trusted route fields.
      // Retain their name hint so discovery does not lose the tool.
      const name = typeof tool === 'object' && tool !== null ? (tool as { name?: unknown }).name : undefined;
      const hints = opts as { name?: unknown; names?: unknown } | undefined;
      api.registerTool(create, typeof name === 'string' && hints?.name === undefined && hints?.names === undefined
        ? { ...(opts as object), name } : opts);
    }
  } };
}
