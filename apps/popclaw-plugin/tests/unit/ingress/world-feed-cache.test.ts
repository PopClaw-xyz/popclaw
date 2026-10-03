import { describe, it, expect } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { makeCache, bytesOf, item } from '../../helpers/world-feed-cache';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache';
import { LocalHostDb } from '../../../src/host/local-host-db';

const rec = (
  cache: WorldFeedCache,
  over: Partial<popclaw.event.IWorldFeedItem>,
  receivedAt = 1,
) => {
  const it_ = item(over);
  cache.record(it_, bytesOf(it_), receivedAt);
};

describe('WorldFeedCache (SQLite per-host store)', () => {
  it('record() inserts and recent() returns it', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'p1', textPreview: 'one', platformPostCreatedAt: 100 });
    expect(cache.recent(10).map((i) => i.platformPostId)).toEqual(['p1']);
  });

  it('rejects a missing original without storing or exposing the preview', async () => {
    const { cache, db } = await makeCache();
    const missing = item({ envelope: undefined, textPreview: 'untrusted preview' });
    expect(() => cache.record(missing, bytesOf(missing))).toThrow();
    expect(db.queryAll('SELECT * FROM world_feed')).toEqual([]);
    expect(cache.recentForReading(10)).toEqual([]);
  });

  it.each(['full', 'ambiguous'] as const)('rejects unsafe retained raw before returning %s prefix results', async (result) => {
    const { cache, db } = await makeCache();
    const first = item({ platform: 'popclaw', platformPostId: 'abc123' + '0'.repeat(58), eventId: 'abc123' + '0'.repeat(58) });
    cache.record(first);
    if (result === 'ambiguous') rec(cache, { platform: 'popclaw', platformPostId: 'abc123' + '1'.repeat(58), eventId: 'abc123' + '1'.repeat(58) });
    const privateEnvelope = popclaw.event.EventEnvelope.encode({ directMessage: { body: 'private' }, target: { scope: 1 } }).finish();
    db.execute('UPDATE world_feed SET raw=? WHERE platform_post_id=?', [bytesOf({ ...first, envelope: privateEnvelope }), first.platformPostId!]);
    expect(() => cache.findFullEventId('abc123')).toThrow();
    expect(() => cache.findByEventIdPrefix('abc123')).toThrow();
  });

  it('newestPostCreatedAt() is null on an empty cache and the max otherwise', async () => {
    // This is the /world-feed/stream resume cursor: null must mean "fresh
    // install, send no since" — never 0, which would read as "since 1970".
    const { cache } = await makeCache();
    expect(cache.newestPostCreatedAt()).toBeNull();
    rec(cache, { platformPostId: 'a', platformPostCreatedAt: 300 });
    rec(cache, { platformPostId: 'b', platformPostCreatedAt: 100 });
    expect(cache.newestPostCreatedAt()).toBe(300);
  });

  it('recent(n) newest-first by created_at, capped at n', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'a', platformPostCreatedAt: 100 });
    rec(cache, { platformPostId: 'b', platformPostCreatedAt: 300 });
    rec(cache, { platformPostId: 'c', platformPostCreatedAt: 200 });
    expect(cache.recent(2).map((i) => i.platformPostId)).toEqual(['b', 'c']);
  });

  it('byAuthor filters and orders newest-first', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'a1', authorPopclawId: 'A', platformPostCreatedAt: 100 });
    rec(cache, { platformPostId: 'b1', authorPopclawId: 'B', platformPostCreatedAt: 200 });
    rec(cache, { platformPostId: 'a2', authorPopclawId: 'A', platformPostCreatedAt: 300 });
    expect(cache.byAuthor('A', 10).map((i) => i.platformPostId)).toEqual(['a2', 'a1']);
    expect(cache.byAuthor('Z', 10)).toEqual([]);
  });

  it('byPlatform filters across authors', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: '1', platform: 'x', platformPostCreatedAt: 1 });
    rec(cache, { platformPostId: '2', platform: 'youtube', platformPostCreatedAt: 2 });
    rec(cache, { platformPostId: '3', platform: 'x', platformPostCreatedAt: 3 });
    expect(cache.byPlatform('x', 10).map((i) => i.platformPostId)).toEqual(['3', '1']);
  });

  it('dedupes by (platform, platformPostId) — last write wins, no global eviction', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'p1', platformPostCreatedAt: 100, textPreview: 'first' });
    rec(cache, { platformPostId: 'p1', platformPostCreatedAt: 100, textPreview: 'updated' });
    const r = cache.recent(10);
    expect(r).toHaveLength(1);
    expect(r[0]!.textPreview).toBe('updated');
  });

  it('same id on different platforms are distinct rows', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'shared', platform: 'x', platformPostCreatedAt: 100 });
    rec(cache, { platformPostId: 'shared', platform: 'youtube', platformPostCreatedAt: 200 });
    expect(cache.recent(10)).toHaveLength(2);
  });

  it('no in-memory ring: 5000 records all queryable (fixes global-eviction bug)', async () => {
    const { cache } = await makeCache();
    for (let i = 0; i < 5000; i++) {
      rec(cache, { platformPostId: `p${i}`, authorPopclawId: 'A', platformPostCreatedAt: i });
    }
    expect(cache.byAuthor('A', 10000)).toHaveLength(5000);
  });

  it('start() prunes rows received >1 year ago (disposable-cache retention)', async () => {
    const NOW = 1_000_000_000; // fixed wall-clock seconds
    const YEAR = 365 * 24 * 60 * 60;
    const db = new LocalHostDb(':memory:');
    const cache = new WorldFeedCache({ db, now: () => NOW });
    await cache.start();

    // received_at drives retention (age in OUR cache, not the post's age).
    cache.record(item({ platformPostId: 'fresh' }), undefined, NOW - 1);
    cache.record(item({ platformPostId: 'edge-kept' }), undefined, NOW - YEAR); // == cutoff → kept
    cache.record(item({ platformPostId: 'stale' }), undefined, NOW - YEAR - 1); // < cutoff → pruned
    cache.record(item({ platformPostId: 'ancient' }), undefined, NOW - 5 * YEAR);
    expect(cache.recent(100)).toHaveLength(4); // prune only runs on open

    await cache.start(); // re-open → prune-on-open

    expect(cache.recent(100).map((i) => i.platformPostId).sort()).toEqual(['edge-kept', 'fresh']);
  });

  it('persists raw protobuf bytes in BLOB (round-trip == original item)', async () => {
    const { cache, db } = await makeCache();
    const original = item({ platformPostId: 'blob1', textPreview: 'verify me', platformPostCreatedAt: 42 });
    cache.record(original, bytesOf(original), 7);
    const row = db.queryOne<{ raw: Uint8Array; received_at: number }>(
      `SELECT raw, received_at FROM world_feed WHERE platform=? AND platform_post_id=?`,
      ['x', 'blob1'],
    );
    expect(row!.received_at).toBe(7);
    const decoded = popclaw.event.WorldFeedItem.decode(new Uint8Array(row!.raw));
    expect(decoded.textPreview).toBe('verify me');
    expect(decoded.platformPostId).toBe('blob1');
  });

  it('originalUrl falls back to origin.url (WorldFeedItem.original_url is a dead server field)', async () => {
    const { cache } = await makeCache();
    rec(cache, {
      platformPostId: 'm1',
      originalUrl: '', // server always sends '' here
      origin: { platform: 'x', postId: 'm1', url: 'https://x.com/MrBeast/status/m1' },
    });
    expect(cache.recent(1)[0]!.originalUrl).toBe('https://x.com/MrBeast/status/m1');
  });

  it('originalUrl keeps the explicit field when present (legacy rows)', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'm2', originalUrl: 'https://x.com/a/status/m2' });
    expect(cache.recent(1)[0]!.originalUrl).toBe('https://x.com/a/status/m2');
  });

  it('lookup hits by (platform, postId), misses return null', async () => {
    const { cache } = await makeCache();
    rec(cache, { platform: 'x', platformPostId: 'pid-eid', eventId: 'e'.repeat(64) });
    expect(cache.lookup('x', 'pid-eid')!.eventId).toBe('e'.repeat(64));
    expect(cache.lookup('x', 'nope')).toBeNull();
  });

  it('reply_to_* round-trip — only set when replyToPostId present', async () => {
    const { cache } = await makeCache();
    rec(cache, {
      platformPostId: 'rp',
      replyToPostId: 'orig',
      replyToPlatform: 'x',
      replyToAuthorPopclawId: 'OP',
    });
    rec(cache, { platformPostId: 'plain' });
    const reply = cache.lookup('x', 'rp')!;
    expect(reply.replyToPostId).toBe('orig');
    expect(cache.lookup('x', 'plain')!.replyToPostId).toBeUndefined();
  });

  it('findFullEventId — popclaw 64-hex platformPostId prefix', async () => {
    const { cache } = await makeCache();
    const eid = 'abc123' + '0'.repeat(58);
    rec(cache, { platform: 'popclaw', platformPostId: eid });
    rec(cache, { platform: 'popclaw', platformPostId: 'def456' + '0'.repeat(58) });
    expect(cache.findFullEventId('abc123')).toEqual({ full: eid, ambiguous: [] });
    expect(cache.findFullEventId('zzzzzz')).toEqual({ full: null, ambiguous: [] });
  });

  it('findByEventIdPrefix — eventId prefix across platforms', async () => {
    const { cache } = await makeCache();
    const eid = 'abc1230000' + '0'.repeat(54);
    rec(cache, { platform: 'x', platformPostId: 'p1', eventId: eid });
    const r = cache.findByEventIdPrefix('abc123');
    expect(r.item!.eventId).toBe(eid);
    expect(r.ambiguous).toEqual([]);
  });

  it('eventId defaults to "" when item carries none', async () => {
    const { cache } = await makeCache();
    rec(cache, { platform: 'x', platformPostId: 'noeid' });
    expect(cache.lookup('x', 'noeid')!.eventId).toBe('');
  });

  it('record() without bytes re-encodes the item into the BLOB (snapshot fallback)', async () => {
    const { cache, db } = await makeCache();
    const snap = item({ platformPostId: 'snap1', textPreview: 'from snapshot', eventId: 'f'.repeat(64) });
    cache.record(snap); // no bytes — the /popclaw feed snapshot path
    const row = db.queryOne<{ raw: Uint8Array }>(
      `SELECT raw FROM world_feed WHERE platform=? AND platform_post_id=?`,
      ['x', 'snap1'],
    );
    const decoded = popclaw.event.WorldFeedItem.decode(new Uint8Array(row!.raw));
    expect(decoded.textPreview).toBe('from snapshot');
    expect(decoded.eventId).toBe('f'.repeat(64));
    expect(cache.lookup('x', 'snap1')!.textPreview).toBe('from snapshot');
  });

  it('recentForReading decodes the full original body + media from the relayed envelope', async () => {
    const { cache } = await makeCache();
    const longBody = 'x'.repeat(500);
    const envelope = popclaw.event.EventEnvelope.encode({
      actor: { popclawId: 'A', nickname: 'Alice' },
      timestamp: 100,
      post: { blocks: [{ content: longBody }], media: [{ kind: 1, url: 'https://i.ytimg.com/vi/abc/hq.jpg' }] },
    }).finish();
    rec(cache, {
      platformPostId: 'p1', platform: 'popclaw', platformPostCreatedAt: 100,
      textPreview: longBody.slice(0, 280), envelope,
    });
    const r = cache.recentForReading(10);
    expect(r[0]!.body).toBe(longBody);        // full, not the 280 preview
    expect(r[0]!.media).toEqual([{ kind: 'video', url: 'https://i.ytimg.com/vi/abc/hq.jpg' }]);
  });

  it('recentForReading falls back to textPreview when the public original has empty text', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'p2', textPreview: 'legacy preview', platformPostCreatedAt: 50 });
    expect(cache.recentForReading(10)[0]!.body).toBe('legacy preview');
  });

  it('recentForReading surfaces markCount from the outer WorldFeedItem', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'm1', platformPostCreatedAt: 5, markCount: 7 });
    expect(cache.recentForReading(10)[0]!.markCount).toBe(7);
  });

  it('received_at takes the injected now() seam as SECONDS (no extra /1000)', async () => {
    const db = new LocalHostDb(':memory:');
    const cache = new WorldFeedCache({ db, now: () => 1_700_000_000 }); // house convention: seconds
    await cache.start();
    const it_ = item({ platformPostId: 'tsx' });
    cache.record(it_, bytesOf(it_)); // no explicit receivedAt → falls back to now seam
    const row = db.queryOne<{ received_at: number }>(
      `SELECT received_at FROM world_feed WHERE platform_post_id=?`,
      ['tsx'],
    );
    expect(row!.received_at).toBe(1_700_000_000);
  });

  it('authorFirstSeen(): 每个作者本机最早的一条（报纸 P5 新人标的依据）', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'a1', authorPopclawId: 'A', platformPostCreatedAt: 300 });
    rec(cache, { platformPostId: 'a2', authorPopclawId: 'A', platformPostCreatedAt: 100 });
    rec(cache, { platformPostId: 'b1', authorPopclawId: 'B', platformPostCreatedAt: 200 });
    rec(cache, { platformPostId: 'x1', authorPopclawId: '', platformPostCreatedAt: 50 });
    const seen = cache.authorFirstSeen();
    expect(seen.get('A')).toBe(100);
    expect(seen.get('B')).toBe(200);
    expect(seen.has('')).toBe(false); // 无署名不是一个人
  });
});

describe('insert-order resume cursor', () => {
  it('an untouched cache has no cursor', async () => {
    const { cache } = await makeCache();
    expect(cache.insertCursor()).toBeNull();
  });

  it('remembers the highest id it has been handed', async () => {
    const { cache } = await makeCache();
    cache.recordInsertCursor('10');
    cache.recordInsertCursor('42');
    expect(cache.insertCursor()).toBe(42);
  });

  it('never moves backwards', async () => {
    // Frames are not guaranteed ordered across a reconnect (a backfill chunk
    // can arrive after live frames from the previous connection). A cursor
    // that regressed would re-pull everything in between on the next boot.
    const { cache } = await makeCache();
    cache.recordInsertCursor('42');
    cache.recordInsertCursor('7');
    expect(cache.insertCursor()).toBe(42);
  });

  it('ignores frames with no id (old house) rather than zeroing the cursor', async () => {
    const { cache } = await makeCache();
    cache.recordInsertCursor('42');
    cache.recordInsertCursor('');
    cache.recordInsertCursor(undefined);
    cache.recordInsertCursor('not-a-number');
    expect(cache.insertCursor()).toBe(42);
  });

  it('survives a reopen of the same database file', async () => {
    // The cursor is the whole point across restarts — an in-memory one would
    // leave every boot resuming from the timestamp fallback.
    const db = new LocalHostDb(':memory:');
    const cache = new WorldFeedCache({ db });
    await cache.start();
    cache.recordInsertCursor('99');
    const reopened = new WorldFeedCache({ db });
    await reopened.start();
    expect(reopened.insertCursor()).toBe(99);
  });
});
