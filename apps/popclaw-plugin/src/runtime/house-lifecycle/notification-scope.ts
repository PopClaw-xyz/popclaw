/** House attribution and captured authority for automatic owner presentation. */
import type { Notifier, CaptureNotificationDeliveryScope } from '../../notifier/notifier.js';
import type { NotificationItem } from '../../notifier/types.js';
import type { HouseRuntime } from './house-runtime.js';
import { normalizeHouseOrigin } from './control-client.js';

type HouseScopes = Pick<HouseRuntime, 'commands' | 'captureGate' | 'originForSlug' | 'resident'> & Partial<Pick<HouseRuntime, 'storageAllows'>>;

export function notificationOrigin(item: NotificationItem, houses: Pick<HouseScopes, 'originForSlug'>): string | null {
  try {
    if (typeof item.payload.houseOrigin === 'string') return normalizeHouseOrigin(item.payload.houseOrigin);
    if (typeof item.payload.houseSlug === 'string') return houses.originForSlug(item.payload.houseSlug);
  } catch { /* An unknown house is retained for explicit history only. */ }
  return null;
}

export function isLocalNotification(item: NotificationItem): boolean {
  return !('houseOrigin' in item.payload) && !('houseSlug' in item.payload)
    && ['system_notice', 'onboarding_card', 'bond_proposal', 'bond_milestone'].includes(item.kind);
}

/** Capture before target resolution; a later login cannot revive this delivery. */
export function captureNotificationScopes(houses: HouseScopes): CaptureNotificationDeliveryScope {
  const gates = new Map(houses.commands.knownHouseOrigins().map(origin => [origin, houses.captureGate(origin)]));
  const epoch = houses.resident.authority.captureEpoch();
  const storageWasAllowed = houses.storageAllows?.('notifications') !== false;
  return item => {
    if (isLocalNotification(item)) {
      return {key: 'local-installation', isActive: () => storageWasAllowed && houses.storageAllows?.('notifications') !== false && epoch !== null && houses.resident.authority.isEpochCurrent(epoch)};
    }
    const origin = notificationOrigin(item, houses);
    const gate = origin ? gates.get(origin) : undefined;
    return gate ? {key: gate.origin, isActive: () => storageWasAllowed && houses.storageAllows?.('notifications') !== false && gate.isActive()} : null;
  };
}

/** Attribute at ingress, before shared queues lose the source connection. */
export function notifierForOrigin(notifier: Pick<Notifier, 'enqueue'>, origin: string): Pick<Notifier, 'enqueue'> {
  const houseOrigin = normalizeHouseOrigin(origin);
  return {enqueue: args => notifier.enqueue({...args, payload: {...args.payload, houseOrigin}})};
}
