import { ActionInactiveError, assertActionActive, withAction } from './house-lifecycle/action-context.js';
import type { HouseGate } from './house-lifecycle/manager.js';
import type { InboxStore, StoredInboxItem } from '../messaging/inbox-store.js';
import type { Notifier } from '../notifier/notifier.js';
import { passesRelativeValueGate, type GraphLike } from '../notifier/relative-value.js';

export interface DmNotificationPolicyDeps {
  readonly inbox: InboxStore;
  readonly notifier: Notifier;
  readonly graph: GraphLike;
  readonly verdictOf: (id: string, houseSlug?: string) => { blocked: boolean; verifiedFollowerCount?: number };
  readonly isOfficial?: (id: string, houseSlug: string) => boolean;
  /** Captures the original house generation before any asynchronous lookup. */
  readonly gateForHouse?: (slug: string) => Pick<HouseGate, 'isActive' | 'signal'>;
  readonly vipThreshold: number;
  readonly refresh?: (id: string, houseSlug?: string) => Promise<void>;
  readonly nameOf: (id: string, nickname?: string) => string;
  readonly bondContext?: (id: string, beforeTs: number) => string;
  /** Presentation only. It never owns the notification decision. */
  readonly onQueued?: () => void;
  readonly warn?: (message: string) => void;
}

/** One ADR-0012 gate for every host. The inbox is its durable retry journal. */
export function makeDmNotificationPolicy(deps: DmNotificationPolicyDeps) {
  const inFlight = new Map<number, Promise<void>>();
  async function evaluate(item: StoredInboxItem): Promise<void> {
    const gate = deps.gateForHouse?.(item.houseSlug ?? '');
    return withAction(gate, async () => {
      if (deps.inbox.get(item.id)?.notificationState !== 'pending') return;
      const from = item.fromPopclawId;
      let verdict = deps.verdictOf(from, item.houseSlug);
      const passes = () => passesRelativeValueGate('dm', from, deps.graph, deps.isOfficial ? id => deps.isOfficial!(id, item.houseSlug ?? '') : undefined, verdict, deps.vipThreshold);
      if (!passes() && !verdict.blocked && deps.vipThreshold > 0 && verdict.verifiedFollowerCount == null) {
        await deps.refresh?.(from, item.houseSlug);
        assertActionActive(gate);
        // Owner may block/unfollow while the profile request is in flight.
        verdict = deps.verdictOf(from, item.houseSlug);
        if (!passes() && !verdict.blocked && verdict.verifiedFollowerCount == null) return;
      }
      assertActionActive(gate);
      if (!passes()) {
        deps.inbox.settleNotification(item.id, 'silent');
        return;
      }
      const bondLine = deps.bondContext?.(from, item.ts);
      assertActionActive(gate);
      const queued = deps.inbox.settleNotification(item.id, 'queued', () => deps.notifier.enqueue({
        level: 'L1', kind: 'dm', payload: {
          messageId: item.id, fromPopclawId: from,
          fromName: deps.nameOf(from, item.senderNickname), body: item.body, ts: item.ts,
          ...(item.eventId ? { eventId: item.eventId } : {}),
          ...(item.houseSlug ? { houseSlug: item.houseSlug } : {}),
          ...(item.mediaPath ? { mediaPath: item.mediaPath } : {}),
          ...(bondLine ? { bondLine } : {}),
          ...(verdict.verifiedFollowerCount ? { verifiedFollowerCount: verdict.verifiedFollowerCount } : {}),
        },
      }));
      if (queued) deps.onQueued?.();
    });
  }
  function handle(item: StoredInboxItem): Promise<void> {
    const running = inFlight.get(item.id);
    if (running) return running;
    const task = evaluate(item).catch((err) => {
      if (err instanceof ActionInactiveError) return;
      deps.warn?.(`popclaw: DM policy pending for message ${item.id}: ${String(err)}`);
    }).finally(() => { inFlight.delete(item.id); });
    inFlight.set(item.id, task);
    return task;
  }
  return {
    handle,
    async recover(): Promise<void> {
      // Sequential recovery bounds outstanding profile requests after a long outage.
      let afterId = 0;
      for (;;) {
        const page = deps.inbox.pendingPolicy(afterId);
        if (!page.length) break;
        for (const item of page) { await handle(item); afterId = item.id; }
      }
    },
  };
}
