import { makeNotificationsTool } from '../notifier/mcp-notice.js';
import { runtimeToolNoticeContext } from '../notifier/tool-notice.js';
import type { ToolsCtx } from './tools-context.js';
export function registerNotificationTools(ctx: ToolsCtx): void {
  if (ctx.deps.notificationTools === false) return;
  const context = async () => {
    const rt = await ctx.runtime();
    const notice = ctx.deps.getToolNoticeContext
      ? await ctx.deps.getToolNoticeContext()
      : runtimeToolNoticeContext(
          rt,
          `native:${rt.boot.popclawId}`,
          undefined,
          true,
        );
    if (!notice.active()) throw new Error('NOTIFICATIONS_INACTIVE');
    return { rt, notice };
  };
  ctx.api.registerTool({
    name: 'popclaw_notifications',
    label: 'Pending notifications',
    description:
      'Fetch pending notifications for this installation. A tool result does not authorize acknowledgement, message retrieval or resolution. Use explicit acknowledgement only after a confirmed handoff.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      const { rt, notice } = await context();
      return makeNotificationsTool(
        async () => rt.notifier,
        async () => rt.nameOf,
        async () => rt.proposalsStore,
        { id: notice.consumerId, store: async () => notice.store },
      ).execute('native_notifications', {});
    },
  });
  ctx.api.registerTool({
    name: 'popclaw_acknowledge_notifications',
    label: 'Acknowledge notifications',
    description:
      'Explicitly confirm handoff of notification IDs already offered to this installation. Never treats the owner as having read a message or resolved a request.',
    parameters: {
      type: 'object',
      properties: {
        notification_ids: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          maxItems: 100,
        },
      },
      required: ['notification_ids'],
    },
    execute: async (_id: string, args: unknown) => {
      const ids = (args as { notification_ids?: unknown })?.notification_ids;
      if (
        !Array.isArray(ids) ||
        ids.length > 100 ||
        ids.some((id) => !Number.isSafeInteger(id) || id < 1)
      )
        throw new Error('Invalid notification IDs');
      const { notice } = await context();
      return {
        type: 'text',
        text: JSON.stringify({
          acknowledged: notice.store.acknowledgeFor(notice.consumerId, ids),
        }),
      };
    },
  });
}
