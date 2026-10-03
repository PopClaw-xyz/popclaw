import { inspectPublicCarrier } from './public-stream-wire.js';
/**
 * WorldFeedCache — per-lore-house world-stream cache (P-005 / ADR-0024).
 *
 * One disposable SQLite table per connected lore-house (data/lorehouses/<host-slug>.db,
 * opened by `openWorldFeedStore`). Each row stores the raw `WorldFeedItem`
 * protobuf bytes in a `raw BLOB` plus projection columns mirroring the stable
 * `CachedFeedItem` shape.
 *
 *   - `record(item, bytes, receivedAt?)` → INSERT OR REPLACE (dedupe on
 *     (platform, platform_post_id), last-write-wins, NO eviction — fixes the
 *     old 1000-item global-ring bug where followed authors' history fell out).
 *     Wired as the `onItem` callback of WorldFeedStreamClient:
 *     `onItem: (item, bytes) => cache.record(item, bytes)`.
 *
 *   - `recent / byAuthor / byPlatform / search / lookup / findFullEventId /
 *     findByEventIdPrefix` → reads go entirely through the projection columns;
 *     the BLOB is never touched on the read hot path (recommend.recent() of
 *     hundreds = zero protobuf decode). BLOB is kept for re-verification /
 *     re-projection / future non-projected fields.
 *
 * Disposable: rebuildable from the server's stream, so the table is created
 * inline (CREATE TABLE IF NOT EXISTS), NOT via the migration framework — that
 * one is for the precious my-social-assets.db.
 */

import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import { readLastFrameAt, type LastFrame } from './house-silence.js';
import {
  envelopeKind, normalizeFeedItem, projectCachedRow, projectReadableRow,
  type CachedFeedItem, type ReadableFeedItem, type FeedCacheRow,
} from './feed-item-projection.js';

// Compatibility surface; feed decoding and row shapes have one authority.
export {
  decodeEnvelopeBody, houseBodyFields, envelopeKind, numberOrZero,
  type CachedFeedItem, type ReadableFeedItem, type MediaRef, type VerifiedRef,
} from './feed-item-projection.js';

export interface WorldFeedCacheOptions {
  /** Per-host SQLite handle (data/lorehouses/<slug>.db). Injected for testability. */
  readonly db: HostDb;
  /** received_at seam — returns wall-clock SECONDS (house convention). */
  readonly now?: () => number;
  /** Spec B slice②: log one debug line when an unrecognized kind (per the local proto) is received (one line is enough). */
  readonly debug?: (msg: string) => void;
}

/**
 * A Pings material row: a reply to something the owner said + a preview of
 * the original text of the thing being replied to.
 * "Something the owner said" = rows in world_feed where author_popclaw_id =
 * the owner — both posts and replies the owner made count (someone replying
 * to the owner's reply also counts as replying to the owner).
 */
export interface ReplyToOwner {
  reply: CachedFeedItem;
  /** platform_post_id of the thing being replied to. */
  targetPostId: string;
  /** Preview of the original text of the thing being replied to (lets the agent say "that post of yours from yesterday about X"). */
  targetPreview: string;
}

/**
 * Case-insensitive keyword match: true iff EVERY whitespace-split term of
 * `query` is a substring of the item's searchable text (textPreview +
 * handle + originalUrl). Empty/whitespace query → false.
 *
 * ponytail: substring, AND-of-terms. No stemming / ranking / synonyms until
 * search quality actually demands it.
 */
export function matchesQuery(item: CachedFeedItem, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return false;
  const haystack = `${item.textPreview} ${item.handle} ${item.originalUrl}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/** Every display row includes its original evidence for current-profile validation. */
const WRITE_COLS =
  'platform, platform_post_id, event_id, platform_post_created_at, author_popclaw_id, ' +
  'handle, original_url, text_preview, reply_to_platform, reply_to_post_id, reply_to_author_popclaw_id';
const COLS = WRITE_COLS + ', raw';

/**
 * A bulk scan that must survive one bad row.
 *
 * `projectCachedRow` refuses a row whose retained bytes carry no public-envelope
 * evidence, which is right for the write path and for anything that resolves
 * an identity — but a reading path scans the whole cache in one go, and the
 * daily paper is not allowed to cost the owner an entire edition because one
 * cached row was written by a house that has since been downgraded. So the
 * reader skips the row, keeps the rest, and leaves exactly one line behind per
 * scan: how many were dropped and why the first one was dropped.
 */
function scanTolerantly<R, T>(
  rows: readonly R[],
  read: (row: R) => T,
  scan: string,
  debug?: (msg: string) => void,
): T[] {
  const out: T[] = [];
  let skipped = 0;
  let firstError = '';
  for (const row of rows) {
    try {
      out.push(read(row));
    } catch (error) {
      skipped += 1;
      if (!firstError) firstError = error instanceof Error ? error.message : String(error);
    }
  }
  reportSkipped(scan, skipped, 'row', firstError, debug);
  return out;
}

/**
 * The one line a tolerant scan leaves behind. `unit` is what the number counts —
 * a scan that resolves rows says `row`, one that resolves authors says `author`,
 * and neither is allowed to report the other's unit: a count whose noun is wrong
 * is a quiet lie about how much of the cache was actually unreadable.
 */
function reportSkipped(
  scan: string,
  skipped: number,
  unit: string,
  firstError: string,
  debug?: (msg: string) => void,
): void {
  if (skipped <= 0) return;
  const line = `world-feed: ${scan} skipped ${skipped} unreadable ${unit}(s); first error: ${firstError}`;
  if (debug) debug(line);
  // No debug seam wired (the CLI entry points open the cache without one) —
  // a silent skip is the one outcome that must not happen, so say it anyway.
  else console.warn(line);
}

/** Disposable-cache retention: drop rows received more than this long ago. The
 * world feed is ephemeral — a stream you catch, rebuildable from the server, not
 * a hoard — so aged rows are pruned rather than kept forever. */
const RETENTION_SECONDS = 365 * 24 * 60 * 60; // 1 year

/**
 * The read-side common surface — implemented by both a single house's
 * `WorldFeedCache` and the cross-house merged view `WorldFeedCatalog`. The
 * only reason this exists: `WorldFeedCache` has private fields (nominal
 * typing), so downstream code needs to be annotated with this interface, not
 * the class, if it's ever going to be swappable for the catalog. Consumers
 * should always type against `WorldFeedReader`.
 */
export interface WorldFeedReader {
  recent(n: number): CachedFeedItem[];
  recentForReading(n: number): ReadableFeedItem[];
  byAuthor(popclawId: string, n: number): CachedFeedItem[];
  byPlatform(platform: string, n: number): CachedFeedItem[];
  search(query: string, n: number): CachedFeedItem[];
  authorIds(): string[];
  /** For each author, the time (seconds) of the earliest item seen locally.
   *  The sole basis for the daily paper's "day N since first seen locally" —
   *  we only know when we first saw them locally, not their true join date,
   *  and neither the wording nor the field name is allowed to pretend otherwise. */
  authorFirstSeen(): Map<string, number>;
  lookup(platform: string, platformPostId: string): CachedFeedItem | null;
  repliesToOwner(ownerPopclawId: string, limit: number): ReplyToOwner[];
  findFullEventId(prefix: string): { full: string | null; ambiguous: string[] };
  findByEventIdPrefix(prefix: string): { item: CachedFeedItem | null; ambiguous: string[] };
}

export class WorldFeedCache implements WorldFeedReader {
  constructor(private readonly opts: WorldFeedCacheOptions) {}

  /** Idempotent: inline CREATE TABLE for the disposable cache (no _migrations). */
  async start(): Promise<void> {
    const db = this.opts.db;
    db.execute(`CREATE TABLE IF NOT EXISTS world_feed (
      platform TEXT NOT NULL, platform_post_id TEXT NOT NULL,
      event_id TEXT NOT NULL DEFAULT '', platform_post_created_at INTEGER NOT NULL DEFAULT 0,
      author_popclaw_id TEXT NOT NULL DEFAULT '', handle TEXT NOT NULL DEFAULT '',
      original_url TEXT NOT NULL DEFAULT '', text_preview TEXT NOT NULL DEFAULT '',
      reply_to_platform TEXT, reply_to_post_id TEXT, reply_to_author_popclaw_id TEXT,
      received_at INTEGER NOT NULL, raw BLOB NOT NULL,
      PRIMARY KEY (platform, platform_post_id))`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_wf_author ON world_feed(author_popclaw_id, platform_post_created_at DESC)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_wf_created ON world_feed(platform_post_created_at DESC)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_wf_platform ON world_feed(platform, platform_post_created_at DESC)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_wf_event ON world_feed(event_id)`);
    // Resume cursor: the house's `insert_seq`, off each SSE frame's `id:`.
    // Its own one-row table rather than a column on world_feed, so the
    // retention sweep below can drop rows without rewinding the cursor.
    db.execute(`CREATE TABLE IF NOT EXISTS world_feed_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)`);
    // ponytail: prune-on-open. Drop rows received >1y ago (received_at has no
    // index → full scan, but this runs once per host-db open, not on the write
    // path). A host never reopened keeps stale rows harmlessly; add a scheduled
    // sweep only if that ever matters.
    const now = this.opts.now?.() ?? Math.floor(Date.now() / 1000);
    db.execute(`DELETE FROM world_feed WHERE received_at < ?`, [now - RETENTION_SECONDS]);
  }

  /** Store the raw protobuf bytes (BLOB) + projection columns. INSERT OR REPLACE
   * dedupes on (platform, platform_post_id) — last write wins, no eviction.
   *
   * `bytes` is the original SSE frame (hot path — no re-encode). The snapshot
   * fallback (/popclaw feed pulls decoded items, no frame bytes) omits it →
   * re-encode here so the BLOB invariant (a row always has its protobuf) holds. */
  record(item: popclaw.event.IWorldFeedItem, bytes?: Uint8Array, receivedAt?: number): void {
    const raw = bytes ?? (popclaw.event.WorldFeedItem.encode(item).finish() as Uint8Array);
    inspectPublicCarrier(raw, 'projection');
    const retained = popclaw.event.WorldFeedItem.decode(raw);
    const norm = normalizeFeedItem(retained);
    if (!norm) return;
    // `now` seam returns SECONDS (house convention, cf. index.ts now() seams);
    // only the Date.now() fallback needs /1000.
    const ts = receivedAt ?? this.opts.now?.() ?? Math.floor(Date.now() / 1000);
    if (this.opts.debug) {
      // Unrecognized events are still stored without issue (the raw BLOB has the full original bytes) — just leave one trace line.
      const kind = envelopeKind(item.envelope as Uint8Array | undefined);
      if (kind.startsWith('unknown:')) {
        this.opts.debug(`world-feed: unknown kind ${kind} — ${norm.platform}/${norm.platformPostId} cached anyway`);
      }
    }
    this.opts.db.execute(
      `INSERT OR REPLACE INTO world_feed (${WRITE_COLS}, received_at, raw)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        norm.platform, norm.platformPostId, norm.eventId, norm.platformPostCreatedAt,
        norm.authorPopclawId, norm.handle, norm.originalUrl, norm.textPreview,
        norm.replyToPlatform ?? null, norm.replyToPostId ?? null, norm.replyToAuthorPopclawId ?? null,
        ts, Buffer.from(raw),
      ],
    );
  }

  /** No-op retained for callers that await it (was the async-flush stub). */
  async flush(): Promise<void> {}

  recent(n: number): CachedFeedItem[] {
    return this.opts.db
      .queryAll<FeedCacheRow>(`SELECT ${COLS} FROM world_feed ORDER BY platform_post_created_at DESC, platform_post_id LIMIT ?`, [n])
      .map(projectCachedRow);
  }

  /** Newest-first, decoded for reading (ADR-0029): full body + media + relay-index
   * fields. Decodes the raw BLOB per row — NOT the zero-decode hot path.
   *
   * Tolerant: a row that fails the public-envelope checks is dropped from the
   * result and counted (see `scanTolerantly`), never thrown — this is the
   * newspaper's and the digest's one scan over the cache. */
  recentForReading(n: number): ReadableFeedItem[] {
    const rows = this.opts.db.queryAll<FeedCacheRow>(
      `SELECT ${COLS} FROM world_feed ORDER BY platform_post_created_at DESC, platform_post_id LIMIT ?`,
      [n],
    );
    return scanTolerantly(rows, projectReadableRow, 'recentForReading', this.opts.debug);
  }

  byAuthor(popclawId: string, n: number): CachedFeedItem[] {
    return this.opts.db
      .queryAll<FeedCacheRow>(
        `SELECT ${COLS} FROM world_feed WHERE author_popclaw_id = ? ORDER BY platform_post_created_at DESC, platform_post_id LIMIT ?`,
        [popclawId, n],
      )
      .map(projectCachedRow);
  }

  /** The "people I've seen" source for identity resolution (ADR-0028 revision):
   *  dedupe of author ids that have shown up in the cache.
   *  There's no nickname column here, so it's only good for forward matching by sigil / full id. */
  authorIds(): string[] {
    return [...new Set(this.opts.db.queryAll<FeedCacheRow>(`SELECT ${COLS} FROM world_feed WHERE author_popclaw_id <> ''`)
      .map(projectCachedRow).map(row => row.authorPopclawId))];
  }

  /**
   * Newest `platform_post_created_at` in this house's cache (epoch seconds),
   * or null when the cache is empty. Index-only on idx_wf_created.
   *
   * This is the resume cursor for /world-feed/stream's `since` — see the
   * caller in index.ts for why it is sent with a lookback margin rather than
   * raw.
   */
  newestPostCreatedAt(): number | null {
    const row = this.opts.db.queryAll<{ t: number | null }>(
      `SELECT MAX(platform_post_created_at) AS t FROM world_feed`,
    )[0];
    return row?.t ?? null;
  }

  /**
   * When this house's newest frame LANDED (`received_at`), or null for a cache
   * that has never seen one (#588). Distinct from `newestPostCreatedAt()`
   * above, which is the resume cursor: that one asks "how far along this
   * house's timeline am I", this one asks "is this house still talking to me".
   * `null` = never a frame; `'unreadable'` = we could not tell.
   */
  lastFrameAt(): LastFrame {
    return readLastFrameAt(this.opts.db);
  }

  /**
   * Remember an SSE frame's `id:` — the house's monotonic `insert_seq`, which
   * is the resume cursor the next connection hands back as `after=`.
   *
   * Highest-wins: frames are not ordered across a reconnect (a backfill chunk
   * can land after live frames from the previous connection), and a cursor
   * that regressed would re-pull everything in between. Non-numeric or absent
   * ids (an older house that stamps no `id:`) are ignored rather than treated
   * as 0 — zeroing would ask for the house's whole table on the next boot.
   */
  recordInsertCursor(id: string | undefined | null): void {
    const seq = Number(id);
    if (!id || !Number.isFinite(seq) || seq <= 0) return;
    this.opts.db.execute(
      `INSERT INTO world_feed_cursor (id, seq) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET seq = excluded.seq WHERE excluded.seq > world_feed_cursor.seq`,
      [Math.floor(seq)],
    );
  }

  /** The persisted insert-order cursor, or null before the first stamped frame. */
  insertCursor(): number | null {
    const row = this.opts.db.queryOne<{ seq: number }>(
      `SELECT seq FROM world_feed_cursor WHERE id = 1`,
    );
    return row?.seq ?? null;
  }

  /** The earliest item seen locally for each author (seconds).
   *
   *  Author-ordered walk over idx_wf_author(author, created): each author's run
   *  arrives oldest-first, so the evidence check runs once per AUTHOR — on that
   *  author's earliest row — instead of once per row, and the rest of the run is
   *  never decoded at all. An author whose earliest row is unreadable falls
   *  through to its next one (dropping the author outright would silently cost
   *  it the paper's "first seen" line); an author with no readable row at all is
   *  absent, which downstream reads as "no first-seen information" — an honest gap.
   *
   *  This is why the scan is written out here rather than handed to
   *  `scanTolerantly`: that one counts unreadable ROWS, and this scan does not
   *  look at every row — a readable author's later rows are never decoded, while
   *  an unreadable author's are all tried. Counting rows would then report an
   *  author with nine bad rows as nine times the damage of an author with one,
   *  against a denominator the scan never read. So what is counted is what was
   *  actually lost: an AUTHOR with no readable row, once. */
  authorFirstSeen(): Map<string, number> {
    const rows = this.opts.db.queryAll<{ id: string; t: number; raw: Uint8Array }>(
      `SELECT author_popclaw_id AS id, platform_post_created_at AS t, raw FROM world_feed
        WHERE author_popclaw_id <> '' ORDER BY author_popclaw_id, platform_post_created_at`,
    );
    const result = new Map<string, number>();
    // Authors still without a readable row, and why the first row we tried failed.
    // An entry leaves the moment a later row of that author reads, so what is left
    // at the end is exactly the set that cost the paper its "first seen" line.
    const unresolved = new Map<string, string>();
    let firstError = '';
    for (const r of rows) {
      if (result.has(r.id)) continue; // this author's earliest readable row already won
      try {
        inspectPublicCarrier(r.raw, 'projection');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!unresolved.has(r.id)) unresolved.set(r.id, message);
        if (!firstError) firstError = message;
        continue;
      }
      unresolved.delete(r.id);
      result.set(r.id, r.t);
    }
    reportSkipped(
      'authorFirstSeen',
      unresolved.size,
      'author',
      [...unresolved.values()][0] ?? firstError,
      this.opts.debug,
    );
    return result;
  }

  byPlatform(platform: string, n: number): CachedFeedItem[] {
    return this.opts.db
      .queryAll<FeedCacheRow>(
        `SELECT ${COLS} FROM world_feed WHERE platform = ? ORDER BY platform_post_created_at DESC, platform_post_id LIMIT ?`,
        [platform, n],
      )
      .map(projectCachedRow);
  }

  /** Keyword search (body+handle+url), newest-first, sliced to n. Reuses
   * matchesQuery for identical behaviour. ponytail: full column scan (no BLOB),
   * upgrade to FTS5 if search latency ever shows up. */
  search(query: string, n: number): CachedFeedItem[] {
    if (query.trim().length === 0) return [];
    return this.opts.db
      .queryAll<FeedCacheRow>(`SELECT ${COLS} FROM world_feed ORDER BY platform_post_created_at DESC, platform_post_id`)
      .map(projectCachedRow)
      .filter((i) => matchesQuery(i, query))
      .slice(0, n);
  }

  /** O(1) lookup by `(platform, platformPostId)` — used by /popclaw-feedback to
   * resolve a post URL back into the cached item's handle + textPreview. */
  lookup(platform: string, platformPostId: string): CachedFeedItem | null {
    const row = this.opts.db.queryOne<FeedCacheRow>(
      `SELECT ${COLS} FROM world_feed WHERE platform = ? AND platform_post_id = ?`,
      [platform, platformPostId],
    );
    return row ? projectCachedRow(row) : null;
  }

  /**
   * Replies to my posts (cut ①): every reply, by anyone but the owner, to anything the owner
   * authored — self-join through `reply_to_post_id`.
   *
   * Deliberately NEVER filters on `reply_to_author_popclaw_id`: that column is
   * permanently '' on the live SSE tail (only the snapshot path JOINs it in —
   * spec §12), so filtering by it silently drops every real ping.
   *
   * Joins on the FULL primary key `(platform, platform_post_id)`. `reply_to_platform`
   * IS populated on the live tail (lore-house `build_world_feed_item` sets it for
   * every Reply, and the SSE stream uses that same builder) — dropping it would both
   * let a forged `{platform:'tiktok', post_id:<my X mirror id>}` reply masquerade as
   * a ping AND turn the lookup into a full table scan.
   *
   * ponytail: newest-first, capped at `limit` — the caller intersects with the
   * unread ledger and re-sorts by bond tier. A mailbox deeper than `limit` loses
   * its oldest tail (never its newest); add a cursor if that ever bites.
   */
  repliesToOwner(ownerPopclawId: string, limit: number): ReplyToOwner[] {
    const rows = this.opts.db.queryAll<FeedCacheRow & { target_post_id: string; target_preview: string; target_raw: Uint8Array }>(
      `SELECT ${COLS.split(', ').map((c) => `r.${c}`).join(', ')},
              t.platform_post_id AS target_post_id, t.text_preview AS target_preview, t.raw AS target_raw
       FROM world_feed r
       JOIN world_feed t
         ON t.platform_post_id = r.reply_to_post_id
        AND t.platform = COALESCE(NULLIF(r.reply_to_platform, ''), 'popclaw')
       WHERE r.reply_to_post_id IS NOT NULL AND r.reply_to_post_id <> ''
         AND t.author_popclaw_id = ?
         AND r.author_popclaw_id <> ?
       ORDER BY r.platform_post_created_at DESC, r.platform_post_id
       LIMIT ?`,
      [ownerPopclawId, ownerPopclawId, limit],
    );
    return rows.map((r) => {
      inspectPublicCarrier(r.target_raw, 'projection');
      return {
      reply: projectCachedRow(r),
      targetPostId: r.target_post_id,
      targetPreview: r.target_preview,
    }; });
  }

  /**
   * popclaw-post CLI polish: given a hex prefix of an event_id, find the unique
   * matching full event_id (limited to platform=popclaw items, whose 64-hex
   * platformPostId IS the popclaw event_id). Prefix must be ≥6 hex; caller
   * validates. ponytail: prefix is hex (no LIKE %/_ metachars) → no ESCAPE.
   */
  findFullEventId(prefix: string): { full: string | null; ambiguous: string[] } {
    const rows = this.opts.db.queryAll<{ platform_post_id: string; raw: Uint8Array }>(
      `SELECT platform_post_id, raw FROM world_feed
       WHERE platform = 'popclaw' AND length(platform_post_id) = 64 AND platform_post_id LIKE ? || '%'
       LIMIT 4`,
      [prefix],
    );
    const ids = rows.map((r) => { inspectPublicCarrier(r.raw, 'projection'); return r.platform_post_id; });
    if (ids.length === 1) return { full: ids[0]!, ambiguous: [] };
    return { full: null, ambiguous: ids.slice(0, 3) };
  }

  /**
   * ADR-0019 — match item.eventId (WorldFeedItem field 19) by hex prefix across
   * ALL platforms. ponytail: prefix is hex → no LIKE ESCAPE needed.
   */
  findByEventIdPrefix(prefix: string): { item: CachedFeedItem | null; ambiguous: string[] } {
    const rows = this.opts.db.queryAll<FeedCacheRow>(
      `SELECT ${COLS} FROM world_feed WHERE event_id <> '' AND event_id LIKE ? || '%' LIMIT 4`,
      [prefix],
    );
    rows.forEach(projectCachedRow);
    if (rows.length === 1) return { item: projectCachedRow(rows[0]!), ambiguous: [] };
    return { item: null, ambiguous: rows.slice(0, 3).map((r) => r.event_id) };
  }
}
