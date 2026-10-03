import type { HostDb } from '../host/host-db.js';
import { NotificationDeliveryInactiveError, type Notifier, type CaptureNotificationDeliveryScope, type NotificationDeliveryBatch, type NotificationDeliveryScope } from './notifier.js';
import type { NotificationLevel, NotificationKind, NotificationItem } from './types.js';

interface QueueRow {
  id: number;
  level: NotificationLevel;
  kind: NotificationKind;
  payload_json: string;
  enqueued_at: number;
  source_message_id?: number | null;
}

/**
 * Notifier impl backed by the `notification_queue` table.
 *
 * drain() claims durable DMs transactionally and marks legacy rows delivered.
 * An expired native claim is recoverable by another process. Channel acceptance
 * is confirmed separately; lost acknowledgements can cause an external duplicate.
 *
 * `nowSeconds` is injected for deterministic tests; production passes
 * `() => Math.floor(Date.now() / 1000)`.
 */
export const DM_DELIVERY_LEASE_SECONDS = 300;

export class SqliteNotifier implements Notifier {
  constructor(
    private readonly db: HostDb,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  enqueue(args: {
    level: NotificationLevel;
    kind: NotificationKind;
    payload: Record<string, unknown>;
  }): void {
    this.db.execute(
      `INSERT INTO notification_queue (level, kind, payload_json, enqueued_at, source_message_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_message_id) WHERE source_message_id IS NOT NULL DO UPDATE SET delivered_at = NULL, payload_json = excluded.payload_json WHERE notification_queue.delivery_lease_token IS NULL`,
      [args.level, args.kind, JSON.stringify(args.payload), this.nowSeconds(), args.kind === 'dm' && typeof args.payload.messageId === 'number' ? args.payload.messageId : null],
    );
  }

  drain(level?: NotificationLevel): NotificationItem[] {
    return this.drainReady(level, false);
  }

  /** Gateway polling is scoped to durable DMs, never legacy L1/L2 delivery. */
  dmDeliveryView(): Notifier {
    return {
      enqueue: (args) => this.enqueue(args),
      count: () => this.db.queryOne<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notification_queue WHERE delivered_at IS NULL AND level = 'L1'
         AND source_message_id IS NOT NULL AND COALESCE(json_extract(payload_json, '$.retryAfter'), 0) <= ?
         AND (delivery_lease_until IS NULL OR delivery_lease_until <= ?)`,
        [this.nowSeconds(), this.nowSeconds()],
      )?.n ?? 0,
      drain: () => this.drainReady('L1', true),
      confirmDelivery: (items) => this.confirmDelivery(items),
      retryDelivery: (item, payload) => this.retryDelivery(item, payload),
    };
  }

  /** Automatic local presentation filters before consuming; explicit history
   * remains available through the unfiltered per-consumer peek/ack methods. */
  presentationView(eligible: (item: NotificationItem) => boolean): Notifier {
    return {
      enqueue: args => this.enqueue(args),
      count: level => {
        const rows = this.db.queryAll<QueueRow>(
          'SELECT id, level, kind, payload_json, enqueued_at FROM notification_queue WHERE delivered_at IS NULL' + (level ? ' AND level = ?' : ''),
          level ? [level] : [],
        );
        return rows.filter(row => eligible(this.toItem(row))).length;
      },
      drain: level => this.drainReady(level, false, eligible),
      confirmDelivery: items => this.confirmDelivery(items),
      retryDelivery: (item, payload) => this.retryDelivery(item, payload),
    };
  }

  /** Native L1 presentation only. Explicit MCP history still uses peekFor.
   * Rows are admitted before any claim, and guards survive all delivery awaits.
   * drain() deliberately rejects: flattening batches would discard their guards. */
  deliveryView(capture: CaptureNotificationDeliveryScope, options: { dmOnly?: boolean } = {}): Notifier {
    const levelOf = (level?: NotificationLevel) => options.dmOnly ? 'L1' : level ?? 'L1';
    return {
      enqueue: args => this.enqueue(args),
      count: level => this.db.transaction(tx => this.readyRows(tx, levelOf(level), !!options.dmOnly)
        .filter(row => capture(this.toItem(row))?.isActive()).length),
      drain: () => { throw new Error('Scoped native delivery requires claimDelivery'); },
      claimDelivery: level => this.claimScoped(capture, levelOf(level), !!options.dmOnly),
      confirmDelivery: items => this.confirmDelivery(items),
      discardDelivery: items => this.discardDelivery(items),
      retryDelivery: (item, payload) => this.retryDelivery(item, payload),
    };
  }

  private readyRows(tx: HostDb, level: NotificationLevel | undefined, dmOnly: boolean): QueueRow[] {
    const now = this.nowSeconds();
    const filter = (level ? ' AND level = ?' : '') + (dmOnly ? ' AND source_message_id IS NOT NULL' : '') +
      " AND (source_message_id IS NULL OR COALESCE(json_extract(payload_json, '$.retryAfter'), 0) <= ?)" +
      ' AND (delivery_lease_until IS NULL OR delivery_lease_until <= ?)';
    return tx.queryAll<QueueRow>(
      'SELECT id, level, kind, payload_json, enqueued_at, source_message_id FROM notification_queue ' +
      'WHERE delivered_at IS NULL' + filter + ' ORDER BY enqueued_at, id',
      level ? [level, now, now] : [now, now],
    );
  }

  private claimScoped(capture: CaptureNotificationDeliveryScope, level: NotificationLevel, dmOnly: boolean): NotificationDeliveryBatch[] {
    return this.db.transaction(tx => {
      const selected: Array<{ item: NotificationItem; scope: NotificationDeliveryScope }> = [];
      for (const row of this.readyRows(tx, level, dmOnly)) {
        const item = this.toItem(row);
        const scope = capture(item);
        if (scope?.isActive()) selected.push({ item, scope });
      }
      const groups = new Map<string, typeof selected>();
      const until = this.nowSeconds() + DM_DELIVERY_LEASE_SECONDS;
      for (const { item, scope } of selected) {
        if (!scope.isActive()) continue;
        const token = globalThis.crypto.randomUUID();
        tx.execute('UPDATE notification_queue SET delivery_lease_token = ?, delivery_lease_until = ? WHERE id = ?', [token, until, item.id]);
        const group = groups.get(scope.key) ?? [];
        group.push({ item: { ...item, deliveryLeaseToken: token }, scope });
        groups.set(scope.key, group);
      }
      return [...groups.values()].map(group => {
        const items = group.map(entry => entry.item);
        return {
          items,
          authorizeSend: () => {
            try {
              this.db.transaction(current => {
                const now = this.nowSeconds();
                for (const { item, scope } of group) {
                  if (!scope.isActive() || !current.queryOne(
                    `SELECT id FROM notification_queue WHERE id = ? AND delivered_at IS NULL
                     AND delivery_lease_token = ? AND delivery_lease_until > ?`,
                    [item.id, item.deliveryLeaseToken!, now],
                  )) throw new NotificationDeliveryInactiveError();
                }
              });
            } catch (error) {
              if (error instanceof NotificationDeliveryInactiveError) throw error;
              // An unreadable authority/claim cannot authorize a host invocation.
              throw new NotificationDeliveryInactiveError(error);
            }
          },
          cancel: () => this.releaseClaims(items),
        };
      });
    });
  }

  private releaseClaims(items: readonly NotificationItem[]): void {
    this.db.transaction(tx => {
      for (const item of items) tx.execute(
        `UPDATE notification_queue SET delivery_lease_token = NULL, delivery_lease_until = NULL
         WHERE id = ? AND delivered_at IS NULL AND delivery_lease_token = ?`,
        [item.id, item.deliveryLeaseToken!],
      );
    });
  }

  private drainReady(level: NotificationLevel | undefined, dmOnly: boolean, eligible?: (item: NotificationItem) => boolean): NotificationItem[] {
    return this.db.transaction((tx) => {
      const now = this.nowSeconds();
      const rows = this.readyRows(tx, level, dmOnly).filter(row => !eligible || eligible(this.toItem(row)));
      return rows.map((row) => {
        if (row.source_message_id != null) {
          const token = globalThis.crypto.randomUUID();
          tx.execute('UPDATE notification_queue SET delivery_lease_token = ?, delivery_lease_until = ? WHERE id = ?', [token, now + DM_DELIVERY_LEASE_SECONDS, row.id]);
          return { ...this.toItem(row), deliveryLeaseToken: token };
        }
        tx.execute('UPDATE notification_queue SET delivered_at = ? WHERE id = ?', [now, row.id]);
        return this.toItem(row);
      });
    });
  }

  confirmDelivery(items: readonly NotificationItem[]): void {
    this.finishClaims(items);
  }

  discardDelivery(items: readonly NotificationItem[]): void {
    this.finishClaims(items);
  }

  private finishClaims(items: readonly NotificationItem[]): void {
    this.db.transaction((tx) => {
      for (const item of items) {
        if (!item.deliveryLeaseToken) continue;
        tx.execute(`UPDATE notification_queue SET delivered_at = ?, delivery_lease_token = NULL, delivery_lease_until = NULL
          WHERE id = ? AND delivered_at IS NULL AND delivery_lease_token = ?`, [this.nowSeconds(), item.id, item.deliveryLeaseToken]);
      }
    });
  }

  retryDelivery(item: NotificationItem, payload: Record<string, unknown>): boolean {
    if (!item.deliveryLeaseToken) return false;
    return this.db.execute(`UPDATE notification_queue SET payload_json = ?, delivery_lease_token = NULL, delivery_lease_until = NULL
      WHERE id = ? AND delivered_at IS NULL AND delivery_lease_token = ?`, [JSON.stringify(payload), item.id, item.deliveryLeaseToken]).changes === 1;
  }

  count(level?: NotificationLevel): number {
    const sql = level
      ? 'SELECT COUNT(*) AS n FROM notification_queue WHERE delivered_at IS NULL AND level = ?'
      : 'SELECT COUNT(*) AS n FROM notification_queue WHERE delivered_at IS NULL';
    const params = level ? [level] : [];
    const row = this.db.queryOne<{ n: number }>(sql, params);
    return row?.n ?? 0;
  }

  /** Explicit consumer binding; a read never acknowledges delivery. */
  bindConsumer(consumerId: string): void {
    if (!consumerId.trim()) throw new Error('A notification consumer ID is required');
    this.db.transaction((tx) => {
      const inserted = tx.execute('INSERT OR IGNORE INTO notification_consumers (consumer_id, start_after_id) SELECT ?, COALESCE(MAX(id), 0) FROM notification_queue', [consumerId]);
      if (inserted.changes) tx.execute(
        'INSERT OR IGNORE INTO notification_receipts (consumer_id, notification_id, offered_at) SELECT ?, id, 0 FROM notification_queue WHERE delivered_at IS NULL',
        [consumerId],
      );
    });
  }

  peekFor(consumerId: string, level?: NotificationLevel, limit = 50): NotificationItem[] {
    this.bindConsumer(consumerId);
    return this.db.transaction((tx) => {
      const rows = tx.queryAll<QueueRow>(
        `SELECT q.id, q.level, q.kind, q.payload_json, q.enqueued_at
         FROM notification_queue q LEFT JOIN notification_receipts r
         ON r.notification_id = q.id AND r.consumer_id = ?
         WHERE r.acknowledged_at IS NULL AND q.level IN ('L1','L2')
         AND (r.notification_id IS NOT NULL OR q.id > (SELECT start_after_id FROM notification_consumers WHERE consumer_id = ?))` +
         (level ? ' AND q.level = ?' : '') + ' ORDER BY q.enqueued_at, q.id LIMIT ?',
        level ? [consumerId, consumerId, level, limit] : [consumerId, consumerId, limit],
      );
      for (const row of rows) tx.execute(
        `INSERT INTO notification_receipts (consumer_id, notification_id, offered_at) VALUES (?, ?, ?)
         ON CONFLICT(consumer_id, notification_id) DO UPDATE SET offered_at = CASE WHEN offered_at = 0 THEN excluded.offered_at ELSE offered_at END`,
        [consumerId, row.id, this.nowSeconds()],
      );
      return rows.map(this.toItem);
    });
  }

  countFor(consumerId: string, level?: NotificationLevel, eligible?: (item: NotificationItem) => boolean): number {
    const from = `FROM notification_queue q LEFT JOIN notification_receipts r
       ON r.notification_id = q.id AND r.consumer_id = ? WHERE q.level IN ('L1','L2') AND r.acknowledged_at IS NULL
       AND (r.notification_id IS NOT NULL OR q.id > (SELECT start_after_id FROM notification_consumers WHERE consumer_id = ?))` + (level ? ' AND q.level = ?' : '');
    const params = level ? [consumerId, consumerId, level] : [consumerId, consumerId];
    if (eligible) return this.db.queryAll<QueueRow>(
      'SELECT q.id, q.level, q.kind, q.payload_json, q.enqueued_at ' + from, params,
    ).filter(row => eligible(this.toItem(row))).length;
    return this.db.queryOne<{ n: number }>('SELECT COUNT(*) AS n ' + from, params)?.n ?? 0;
  }

  acknowledgeFor(consumerId: string, ids: readonly number[]): number[] {
    return this.db.transaction((tx) => {
      const acknowledged: number[] = [];
      for (const id of ids) {
        if (tx.execute(
          'UPDATE notification_receipts SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE consumer_id = ? AND notification_id = ? AND offered_at > 0',
          [this.nowSeconds(), consumerId, id],
        ).changes) acknowledged.push(id);
      }
      return acknowledged;
    });
  }

  private toItem(row: QueueRow): NotificationItem {
    return {
      id: row.id,
      level: row.level,
      kind: row.kind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      enqueuedAt: row.enqueued_at,
    };
  }
}
