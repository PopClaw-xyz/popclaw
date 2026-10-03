import type { NotificationLevel, NotificationKind, NotificationItem } from './types.js';

/** Root captures one house generation and owner epoch before claiming rows. */
export interface NotificationDeliveryScope {
  readonly key: string;
  isActive(): boolean;
}
export type CaptureNotificationDeliveryScope = (item: NotificationItem) => NotificationDeliveryScope | null;

/** A pre-send cancellation is not a channel failure or a delivery attempt. */
export class NotificationDeliveryInactiveError extends Error {
  constructor(cause?: unknown) {
    super('notification delivery is no longer authorized', { cause });
    this.name = 'NotificationDeliveryInactiveError';
  }
}

export interface NotificationDeliveryBatch {
  readonly items: readonly NotificationItem[];
  /** Synchronous, immediately before the actual host invocation after all awaits. */
  readonly authorizeSend?: () => void;
  /** Release only this batch's still-owned claims without changing attempt counts. */
  readonly cancel?: () => void;
}

/**
 * Notifier — abstract queue between popclaw subsystems and the owner.
 *
 * Per ADR-0012 + spec §10.5: MVP downgraded to inbox-on-next-interaction.
 * All levels enqueue; `drain()` is called on owner's next interaction
 * (typically O-3b's OnboardingOrchestrator + future Plan 12 message tools).
 *
 * Concrete impl in sqlite-notifier.ts is backed by the `notification_queue`
 * table (ADR-0013).
 */
export interface Notifier {
  /** Enqueue a notification for later delivery. */
  enqueue(args: {
    level: NotificationLevel;
    kind: NotificationKind;
    payload: Record<string, unknown>;
  }): void;

  /**
   * Pull pending items in FIFO order. Durable DMs are leased until channel
   * confirmation; legacy items are marked delivered. With `level`,
   * only that tier is drained (each cadence — L1 instant / L2 batch / L3 daily
   * — ships independently; an unscoped drain would mark all tiers delivered).
   */
  drain(level?: NotificationLevel): NotificationItem[];

  /** Scoped native delivery preserves captured authorization with each batch. */
  claimDelivery?(level?: NotificationLevel): NotificationDeliveryBatch[];

  /** Stop retrying exhausted non-DM rows; does not assert channel acceptance. */
  discardDelivery?(items: readonly NotificationItem[]): void;

  /** Confirm native channel acceptance of leased items; not a human read. */
  confirmDelivery?(items: readonly NotificationItem[]): void;

  /** Release this claim with a retry payload, only if it is still ours. */
  retryDelivery?(item: NotificationItem, payload: Record<string, unknown>): boolean;

  /** Count pending items (optionally filtered by level). */
  count(level?: NotificationLevel): number;
}
