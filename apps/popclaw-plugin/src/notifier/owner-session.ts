/**
 * OwnerSession — captures the owner's most-recent OpenClaw delivery target (from
 * the `/popclaw` command context) so background L1 notifications can reach the
 * exact channel the owner was last active on.
 *
 * Two parts, both captured at command time:
 *   - sessionKey:       stable host key (M0.2-confirmed; sessionId is ephemeral).
 *   - deliveryContext:  the routable address {channel, to, accountId?, threadId?}.
 *
 * Why both: `runtime.system.enqueueSystemEvent` queues a line for `sessionKey`,
 * but the heartbeat that surfaces it needs an explicit deliveryContext to ROUTE
 * to a visible channel (mirrors OpenClaw's own restart-sentinel / cron wakes).
 * Without it the line is queued but never rendered (the M1.4 live-test bug).
 *
 * ponytail: in-memory last-value. Persist across restart only if a later
 * milestone needs notifications to survive a host bounce.
 */

/** Routable delivery address derived from the command context. */
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
