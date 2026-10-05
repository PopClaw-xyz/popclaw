import type { SqliteNotifier } from './sqlite-notifier.js';
import type { NotificationItem } from './types.js';
import type { PluginRuntime } from '../runtime/plugin-runtime.js';
import { captureNotificationScopes } from '../runtime/house-lifecycle/notification-scope.js';
import { deriveSigil } from '../invite/sigil.js';
import { lexiconFor, renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export {
  NOTICE_COOLDOWN_SECONDS,
  NOTICE_REPEAT_SECONDS,
} from './tool-notice-result.js';
export interface ToolNoticeItem {
  notification_id: number;
  level: 'L1' | 'L2';
  kind: string;
  actor_sigil?: string;
  message_id?: number;
  target_post_id?: string;
}
export interface ToolNotice {
  version: 1;
  type: 'popclaw_notification_notice';
  counts: { L1: number; L2: number };
  items: ToolNoticeItem[];
  more: number;
  suggested_next: 'ask_owner';
}
import type { ToolNoticeOffer } from './tool-notice-result.js';
export type { ToolNoticeOffer } from './tool-notice-result.js';
export {
  canAppendToolNotice,
  decorateToolNotice,
} from './tool-notice-result.js';
export interface ToolNoticeContext {
  store: SqliteNotifier;
  consumerId: string;
  eligible: (item: NotificationItem) => boolean;
  active: () => boolean;
  nativePendingOnly?: boolean;
  lang?: Lang;
}

/** Local presentation bookkeeping only; never acknowledges or reads a message. */
export function offerToolNotice(context: ToolNoticeContext): ToolNoticeOffer {
  return context.store.offerNoticeFor(context, (items, counts) => {
    const data: ToolNotice = {
      version: 1,
      type: 'popclaw_notification_notice',
      counts,
      items: items.map(noticeItem),
      more: counts.L1 + counts.L2 - items.length,
      suggested_next: 'ask_owner',
    };
    const lang = context.lang ?? ownerLang();
    const parts = data.items.map((item) => {
      const who = item.actor_sigil
        ? `#${item.actor_sigil}`
        : renderCopy(lang, 'notify.tool.someone');
      const key =
        item.kind === 'dm'
          ? 'dm'
          : item.kind === 'followed_you'
            ? 'follow'
            : ['reply', 'vip_at_or_reply', 'general_reply'].includes(item.kind)
              ? 'reply'
              : 'other';
      return renderCopy(lang, `notify.tool.${key}`, {
        who,
        kind:
          lexiconFor(lang).terms.notificationKinds[
            item.kind as keyof ReturnType<
              typeof lexiconFor
            >['terms']['notificationKinds']
          ] ?? renderCopy(lang, 'notify.tool.update'),
      });
    });
    const line = [
      ...renderCopy(lang, 'notify.tool.line', {
        parts: parts.join(renderCopy(lang, 'notify.tool.sep')),
      }),
    ]
      .slice(0, 180)
      .join('');
    const text = line + '\n' + JSON.stringify(data);
    if (new TextEncoder().encode(text).length > 2048)
      throw new Error('NOTICE_TOO_LARGE');
    return text;
  });
}
function noticeItem(item: NotificationItem): ToolNoticeItem {
  const p = item.payload;
  const actor = p.fromPopclawId ?? p.followerPopclawId ?? p.popclawId;
  const result: ToolNoticeItem = {
    notification_id: item.id,
    level: item.level as 'L1' | 'L2',
    kind: item.kind,
  };
  if (typeof actor === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(actor))
    result.actor_sigil = deriveSigil(actor);
  if (
    item.kind === 'dm' &&
    Number.isSafeInteger(p.messageId) &&
    Number(p.messageId) > 0
  )
    result.message_id = Number(p.messageId);
  if (
    typeof p.targetPostId === 'string' &&
    /^[a-f0-9]{10,64}$/.test(p.targetPostId)
  )
    result.target_post_id = p.targetPostId;
  return result;
}

/** Capture authority once, then retain it across the presentation operation. */
export function runtimeToolNoticeContext(
  rt: Pick<PluginRuntime, 'notifier' | 'houseRuntime' | 'inboxStore'>,
  consumerId: string,
  signal?: AbortSignal,
  nativePendingOnly = false,
  deadlineMs = Infinity,
): ToolNoticeContext {
  const capture = captureNotificationScopes(rt.houseRuntime);
  const active = () =>
    !signal?.aborted &&
    Date.now() < deadlineMs &&
    rt.houseRuntime.storageAllows('notifications');
  return {
    store: rt.notifier as SqliteNotifier,
    consumerId,
    nativePendingOnly,
    active,
    eligible: (item) => {
      if (!active() || !capture(item)?.isActive()) return false;
      if (item.kind === 'dm' && typeof item.payload.messageId === 'number') {
        const message = rt.inboxStore.get(item.payload.messageId);
        return (
          !!message &&
          message.notificationState === 'queued' &&
          message.resolvedAtMs == null &&
          message.fromPopclawId === item.payload.fromPopclawId
        );
      }
      return true;
    },
  };
}
