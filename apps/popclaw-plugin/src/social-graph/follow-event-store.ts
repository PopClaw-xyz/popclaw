import type { HostDb } from '../host/host-db.js';
import type { DeclaredEvent, FollowType } from './state-projection.js';

interface Row {
  type: string; followee: string; follow_type: string;
  taste_subscribed: number; timestamp: number; signature: string;
  house_slug: string;
}

/** Append-only follow/revoke log in the social DB. Same interface as the old
 *  JSONL EventStore (append/readAll) so SocialGraph's projection is unchanged. */
export class FollowEventStore {
  constructor(private readonly db: HostDb) {}

  async append(ev: DeclaredEvent): Promise<void> {
    const taste = ev.type === 'FollowDeclared' && ev.tasteSubscribed ? 1 : 0;
    this.db.execute(
      `INSERT INTO follow_events (type, followee, follow_type, taste_subscribed, timestamp, signature, house_slug)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ev.type, ev.followee, ev.followType, taste, ev.timestamp, ev.signature, ev.houseSlug ?? ''],
    );
  }

  async readAll(): Promise<DeclaredEvent[]> { return this.readAllSync(); }

  revision(): number { return this.db.queryOne<{ n: number }>('SELECT COALESCE(MAX(id), 0) AS n FROM follow_events')?.n ?? 0; }

  readAllSync(): DeclaredEvent[] {
    const rows = this.db.queryAll<Row>(
      `SELECT type, followee, follow_type, taste_subscribed, timestamp, signature, house_slug
         FROM follow_events ORDER BY id ASC`,
    );
    return rows.map((r) => {
      const base = {
        followee: r.followee, followType: r.follow_type as FollowType,
        timestamp: r.timestamp, signature: r.signature,
        ...(r.house_slug ? { houseSlug: r.house_slug } : {}),
      };
      return r.type === 'FollowDeclared'
        ? { type: 'FollowDeclared', ...base, tasteSubscribed: r.taste_subscribed === 1 }
        : { type: 'FollowRevoked', ...base };
    });
  }

  /**
   * The house this follow was declared to originally (the most recent FollowDeclared).
   * An unfollow must go back to the same house — an empty string (a legacy row / untagged) → undefined = the home house.
   */
  declaredHouseOf(followee: string): string | undefined {
    const row = this.db.queryAll<{ house_slug: string }>(
      `SELECT house_slug FROM follow_events
        WHERE followee = ? AND type = 'FollowDeclared'
        ORDER BY id DESC LIMIT 1`,
      [followee],
    )[0];
    return row?.house_slug ? row.house_slug : undefined;
  }
}
