/**
 * Persistence for the watch registry's per-slice cursor (#181).
 *
 * The registry itself stays in memory — this is the one bit of it worth
 * surviving a restart: the exact `since_id` the scraper needs to ask for
 * "newer than this post" instead of "posted on or after this day", which is
 * the difference between a $0.00015 empty call and a $0.003 billed page per
 * target per restart.
 *
 * Every method swallows its own errors: a ranger that can't read its
 * watermark should re-scan one page, not fail to watch.
 */

import type { HostDb } from '../host/host-db.js';
import type { EntryState } from './watch-registry.js';

export interface WatchWatermarkStore {
  /** Saved cursor for this watch, or null if never saved / unreadable. */
  load(watchId: string): Pick<EntryState, 'lastSeenCreatedAt' | 'lastSeenPlatformPostId'> | null;
  save(watchId: string, state: EntryState): void;
}

interface Row {
  last_seen_created_at: number;
  last_seen_platform_post_id: string;
}

export class SqliteWatchWatermarkStore implements WatchWatermarkStore {
  constructor(
    private readonly db: HostDb,
    private readonly loggerWarn?: (msg: string) => void,
  ) {}

  load(watchId: string): Pick<EntryState, 'lastSeenCreatedAt' | 'lastSeenPlatformPostId'> | null {
    try {
      const row = this.db.queryOne<Row>(
        'SELECT last_seen_created_at, last_seen_platform_post_id FROM watch_watermarks WHERE watch_id = ?',
        [watchId],
      );
      if (!row) return null;
      return {
        lastSeenCreatedAt: Number(row.last_seen_created_at) || 0,
        lastSeenPlatformPostId: row.last_seen_platform_post_id ?? '',
      };
    } catch (err) {
      this.loggerWarn?.(`watch-watermark: load(${watchId}) failed: ${String(err)}`);
      return null;
    }
  }

  save(watchId: string, state: EntryState): void {
    try {
      this.db.execute(
        'INSERT INTO watch_watermarks (watch_id, last_seen_created_at, last_seen_platform_post_id) '
        + 'VALUES (?, ?, ?) ON CONFLICT(watch_id) DO UPDATE SET '
        + 'last_seen_created_at = excluded.last_seen_created_at, '
        + 'last_seen_platform_post_id = excluded.last_seen_platform_post_id',
        [watchId, state.lastSeenCreatedAt, state.lastSeenPlatformPostId],
      );
    } catch (err) {
      this.loggerWarn?.(`watch-watermark: save(${watchId}) failed: ${String(err)}`);
    }
  }
}
