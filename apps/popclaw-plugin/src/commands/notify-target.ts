/**
 * /popclaw notify-here  — pin the current channel as the proactive-notification
 *                         target (run it from your preferred IM, e.g. Discord).
 * /popclaw notify-off    — clear the pin.
 *
 * The local browser/TUI has a `channel` but no `to` (recipient address), so it
 * can't receive proactive pushes — notify-here refuses those and asks the owner
 * to pin a real IM instead.
 */
import type { OwnerNotifyTargetStore } from '../notifier/owner-notify-target.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface NotifyHereAddress {
  sessionKey?: string;
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}

export async function runNotifyHereCommand(
  addr: NotifyHereAddress,
  store: OwnerNotifyTargetStore,
): Promise<{ text: string }> {
  if (!addr.channel || !addr.to) {
    return { text: renderCopy(ownerLang(), 'notifyTarget.noAddress') };
  }
  // source: 'owner' — an explicit pin always wins over, and replaces, whatever
  // the zero-config auto-capture (captureIfUnset) put there.
  await store.set({
    sessionKey: addr.sessionKey,
    deliveryContext: { channel: addr.channel, to: addr.to, accountId: addr.accountId, threadId: addr.threadId },
    source: 'owner',
  });
  return { text: renderCopy(ownerLang(), 'notifyTarget.pinned', { channel: addr.channel }) };
}

export async function runNotifyOffCommand(store: OwnerNotifyTargetStore): Promise<{ text: string }> {
  await store.clear();
  return { text: renderCopy(ownerLang(), 'notifyTarget.off') };
}
