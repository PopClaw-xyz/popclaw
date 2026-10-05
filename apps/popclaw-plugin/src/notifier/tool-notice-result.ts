export const NOTICE_COOLDOWN_SECONDS = 60;
export const NOTICE_REPEAT_SECONDS = 1800;
export interface ToolNoticeOffer {
  pending: boolean;
  text?: string;
}

export function canAppendToolNotice(name: string, result: unknown): boolean {
  if (
    [
      'popclaw_notifications',
      'popclaw_acknowledge_notifications',
      'popclaw_show_pings',
    ].includes(name)
  )
    return false;
  if (!result || typeof result !== 'object') return false;
  const r = result as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    text?: string;
    content?: unknown[];
  };
  if (r.isError) return false;
  if (
    r.content?.some((block) => {
      const item = block as { type?: string; text?: string };
      if (item.type !== 'text' || !item.text) return false;
      try {
        return (
          JSON.parse(item.text.split('\n').slice(1).join('\n')).type ===
          'popclaw_notification_notice'
        );
      } catch {
        return false;
      }
    })
  )
    return false;
  let data = r.structuredContent;
  if (!data && typeof r.text === 'string') {
    try {
      data = JSON.parse(r.text);
    } catch {
      /* ordinary text */
    }
  }
  if (!data && Array.isArray(r.content)) {
    const first = r.content[0] as { type?: string; text?: string } | undefined;
    if (first?.type === 'text' && first.text) {
      try {
        data = JSON.parse(first.text);
      } catch {
        /* ordinary text */
      }
    }
  }
  return (
    !data?.error &&
    !data?.owner_action_required &&
    !['pending', 'approval_pending', 'error', 'failed', 'cancelled'].includes(
      String(data?.status ?? ''),
    )
  );
}

/** Canonical result in, additive result out. Failures cannot erase business data. */
export async function decorateToolNotice<T extends { content: unknown[] }>(
  name: string,
  result: T,
  offer: () => ToolNoticeOffer | Promise<ToolNoticeOffer>,
): Promise<T> {
  if (!canAppendToolNotice(name, result)) return result;
  try {
    const notice = await offer();
    return notice.text
      ? {
          ...result,
          content: [...result.content, { type: 'text', text: notice.text }],
        }
      : result;
  } catch {
    return result;
  }
}
