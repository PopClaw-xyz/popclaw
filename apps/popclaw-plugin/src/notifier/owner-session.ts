/** The last trusted owner channel, captured from a command or SDK tool
 * invocation. The in-memory fallback complements the persisted first-channel
 * pin; it never changes an explicit notification target. */

/** Routable delivery address derived from trusted host context. */
export interface OwnerDeliveryContext {
  readonly channel?: string;
  readonly to?: string;
  readonly accountId?: string;
  readonly threadId?: string | number;
}

/** The owner's last-active delivery target. */
export interface OwnerTarget {
  readonly sessionKey: string;
  readonly deliveryContext?: OwnerDeliveryContext;
}

export class OwnerSession {
  private last: OwnerTarget | undefined;

  set(sessionKey: string | undefined, deliveryContext?: OwnerDeliveryContext): void {
    if (sessionKey) this.last = { sessionKey, deliveryContext };
  }

  get(): OwnerTarget | undefined {
    return this.last;
  }
}
