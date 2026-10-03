/**
 * The local snapshot store for marks (ADR-0019).
 * A snapshot, not a pointer: marking freezes the body/author/source-link at that instant, so
 * cache eviction doesn't affect already-marked content.
 * The local store only holds active marks; unmarking deletes the row. The server-side marks
 * table is the complete ledger.
 */
import type { HostDb } from '../host/host-db.js';

export interface MarkRow {
  eventId: string;
  platform: string;
  platformPostId: string;
  authorPopclawId: string;
  handle: string;
  summaryLine: string;
  bodySnapshot: string;
  sourceUrl: string;
  markedAt: number; // unix seconds
}

/** Typed snake_case shape returned by SQLite for the marks table. */
interface MarkDbRow {
  event_id: string;
  platform: string;
  platform_post_id: string;
  author_popclaw_id: string;
  handle: string;
  summary_line: string;
  body_snapshot: string;
  source_url: string;
  marked_at: number;
}

export class MarksStore {
  constructor(private readonly db: HostDb) {}

  upsert(row: MarkRow): void {
    this.db.execute(
      `INSERT INTO marks (event_id, platform, platform_post_id, author_popclaw_id,
                          handle, summary_line, body_snapshot, source_url, marked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET
         platform = excluded.platform, platform_post_id = excluded.platform_post_id,
         author_popclaw_id = excluded.author_popclaw_id, handle = excluded.handle,
         summary_line = excluded.summary_line, body_snapshot = excluded.body_snapshot,
         source_url = excluded.source_url, marked_at = excluded.marked_at`,
      [row.eventId, row.platform, row.platformPostId, row.authorPopclawId,
       row.handle, row.summaryLine, row.bodySnapshot, row.sourceUrl, row.markedAt],
    );
  }

  delete(eventId: string): void {
    this.db.execute('DELETE FROM marks WHERE event_id = ?', [eventId]);
  }

  has(eventId: string): boolean {
    return this.db.queryOne<{ c: number }>(
      'SELECT 1 AS c FROM marks WHERE event_id = ?', [eventId],
    ) !== null;
  }

  listActive(limit: number): MarkRow[] {
    return this.db
      .queryAll<MarkDbRow>(
        'SELECT event_id, platform, platform_post_id, author_popclaw_id, handle,' +
        ' summary_line, body_snapshot, source_url, marked_at' +
        ' FROM marks ORDER BY marked_at DESC LIMIT ?',
        [limit],
      )
      .map((r) => ({
        eventId: r.event_id,
        platform: r.platform,
        platformPostId: r.platform_post_id,
        authorPopclawId: r.author_popclaw_id,
        handle: r.handle,
        summaryLine: r.summary_line,
        bodySnapshot: r.body_snapshot,
        sourceUrl: r.source_url,
        markedAt: r.marked_at,
      }));
  }
}
