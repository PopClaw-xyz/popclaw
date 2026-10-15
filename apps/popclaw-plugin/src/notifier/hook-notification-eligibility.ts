/** Short-lived MCP hook snapshot. The tool still rechecks its captured runtime
 * authority, including in-memory revocation that another process cannot see. */
import type { HostDb } from '../host/host-db.js';
import type { NotificationItem } from './types.js';
import { isQueuedInboxNotification } from '../messaging/inbox-notification-state.js';
import { isLocalNotification, notificationOrigin } from '../runtime/house-lifecycle/notification-scope.js';
import { captureLegacyTrust } from '../runtime/house-lifecycle/legacy-trust.js';
import { houseBindingBlocked } from '../world/house-recovery-fence.js';

export function hookNotificationEligibility(db: HostDb, executionAllowed: boolean, nowSeconds = Math.floor(Date.now() / 1000)) {
  const houses = new Map<string, boolean>();
  const originForSlug = (slug: string) => {
    const row = db.queryOne<{ origin: string }>('SELECT origin FROM house_origin_bindings WHERE slug=?', [slug]);
    if (!row) throw new Error('UNKNOWN_NOTIFICATION_HOUSE');
    return row.origin;
  };
  return (item: NotificationItem): boolean => {
    if (isLocalNotification(item)) return true;
    const origin = notificationOrigin(item, { originForSlug });
    if (!origin || !executionAllowed) return false;
    if (!houses.has(origin)) {
      const row = db.queryOne<{ desired: string; phase: string; session_id: string; lease_expires_at: number }>(
        'SELECT desired, phase, session_id, lease_expires_at FROM house_participation WHERE house_origin=?', [origin]);
      houses.set(origin, !!row && row.desired === 'enabled' && row.phase === 'connected'
        && !houseBindingBlocked(db, origin)
        && (row.session_id ? row.lease_expires_at > nowSeconds : captureLegacyTrust(db, origin) !== undefined));
    }
    if (!houses.get(origin)) return false;
    return item.kind !== 'dm' || typeof item.payload.messageId !== 'number'
      || isQueuedInboxNotification(db, item.payload.messageId, item.payload.fromPopclawId);
  };
}
