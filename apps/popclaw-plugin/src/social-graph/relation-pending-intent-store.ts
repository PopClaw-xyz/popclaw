/**
 * The durable sink for a refused relation intent — the production
 * `recordPendingIntent` the producer's contract has demanded since
 * relation-producer.ts landed.
 *
 * The interface comment there is the why: an optional sink with a no-op
 * default is how "the owner asked and this end could not act" disappears, and
 * a refusal that leaves no trace reads as if the owner never asked. The
 * producer refuses plenty by design (no pin, house down, signing not ready) —
 * each of those is a real fact about the owner's world, not noise.
 *
 * This is an append-only journal (see migration 036): no upserts, no status
 * flips. Each row states one fact as of its moment — the owner asked, this
 * end could not act, here is why — and nothing here is ever withdrawn or
 * superseded by later events: a success at another house is a different fact,
 * and this row stays true about the refusal it recorded.
 */
import type { HostDb } from '../host/host-db.js';
import type { PendingRelationIntent } from './relation-producer.js';

export interface RelationPendingIntentRow {
  readonly id: number;
  readonly action: string;
  readonly followeePopclawId: string;
  readonly houseSlug: string | null;
  readonly reason: string;
  readonly detail: string | null;
  readonly at: number;
}

export class RelationPendingIntentStore {
  constructor(private readonly db: HostDb) {}

  /** The producer's required sink. Never throws on a healthy DB; a failure
   *  here is a fault worth surfacing, not a refusal to record. */
  append(intent: PendingRelationIntent): void {
    this.db.execute(
      `INSERT INTO relation_pending_intents
         (action, followee_popclaw_id, house_slug, reason, detail, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        intent.action,
        intent.followee,
        intent.houseSlug ?? null,
        intent.reason,
        intent.detail ?? null,
        intent.at,
      ],
    );
  }

  /** Newest-first, optionally scoped to one followee — the "why did my
   *  follow not happen" lookup. */
  list(opts: { readonly followee?: string; readonly limit?: number } = {}): RelationPendingIntentRow[] {
    const limit = opts.limit ?? 50;
    const rows = opts.followee
      ? this.db.queryAll<RelationPendingIntentRow & { followee_popclaw_id: string; house_slug: string | null }>(
          `SELECT id, action, followee_popclaw_id, house_slug, reason, detail, at
             FROM relation_pending_intents
            WHERE followee_popclaw_id = ?
            ORDER BY id DESC LIMIT ?`,
          [opts.followee, limit],
        )
      : this.db.queryAll<RelationPendingIntentRow & { followee_popclaw_id: string; house_slug: string | null }>(
          `SELECT id, action, followee_popclaw_id, house_slug, reason, detail, at
             FROM relation_pending_intents
            ORDER BY id DESC LIMIT ?`,
          [limit],
        );
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      followeePopclawId: r.followee_popclaw_id,
      houseSlug: r.house_slug,
      reason: r.reason,
      detail: r.detail,
      at: r.at,
    }));
  }
}
