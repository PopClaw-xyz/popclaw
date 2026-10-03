import { describe, it, expect } from 'vitest';
import { bytesOf, item } from '../../helpers/world-feed-cache';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache';
import { LocalHostDb } from '../../../src/host/local-host-db';
import type { HostDb } from '../../../src/host/host-db';

/**
 * The newspaper reads the whole cache in one scan. A single row whose retained
 * bytes no longer carry public-envelope evidence must cost the owner that row,
 * never the whole edition — so the reading paths skip and count, while the
 * write and verification paths keep refusing outright.
 */
async function cacheWithOneBadRow(goodRows: number): Promise<{
  cache: WorldFeedCache; db: HostDb; logs: string[]; good: string[];
}> {
  const logs: string[] = [];
  const db = new LocalHostDb(':memory:');
  const cache = new WorldFeedCache({ db, debug: (m) => logs.push(m) });
  await cache.start();
  const good: string[] = [];
  for (let i = 0; i < goodRows; i += 1) {
    const id = `good-${i}`;
    const it = item({ platformPostId: id, authorPopclawId: 'authorGood', platformPostCreatedAt: 2_000 + i });
    cache.record(it, bytesOf(it), 1);
    good.push(id);
  }
  // A row that passed the gate when it was written but whose retained bytes
  // lost their envelope since (a downgraded house, a rewritten cache file).
  const bad = item({ platformPostId: 'bad-row', authorPopclawId: 'authorBad', platformPostCreatedAt: 1_000 });
  cache.record(bad, bytesOf(bad), 1);
  db.execute('UPDATE world_feed SET raw=? WHERE platform_post_id=?', [
    Buffer.from(bytesOf({ ...bad, envelope: undefined })), 'bad-row',
  ]);
  return { cache, db, logs, good };
}

describe('WorldFeedCache reading paths tolerate an unreadable row', () => {
  it('recentForReading returns the good rows and counts the skip in one log line', async () => {
    const { cache, logs, good } = await cacheWithOneBadRow(3);
    const items = cache.recentForReading(100);
    expect(items.map((i) => i.platformPostId).sort()).toEqual([...good].sort());
    const skipLines = logs.filter((l) => l.includes('skipped'));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain('recentForReading');
    expect(skipLines[0]).toContain('1');
    expect(skipLines[0]).toContain('PUBLIC_ENVELOPE_EVIDENCE_REQUIRED');
  });

  it('recentForReading logs once per scan, not once per bad row', async () => {
    const { cache, db, logs } = await cacheWithOneBadRow(2);
    const second = item({ platformPostId: 'bad-row-2', authorPopclawId: 'authorBad', platformPostCreatedAt: 900 });
    cache.record(second, bytesOf(second), 1);
    db.execute('UPDATE world_feed SET raw=? WHERE platform_post_id=?', [
      Buffer.from(bytesOf({ ...second, envelope: undefined })), 'bad-row-2',
    ]);
    expect(cache.recentForReading(100)).toHaveLength(2);
    const skipLines = logs.filter((l) => l.includes('skipped'));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain('2');
  });

  it('authorFirstSeen ignores the unreadable row', async () => {
    const { cache } = await cacheWithOneBadRow(3);
    const seen = cache.authorFirstSeen();
    expect(seen.get('authorGood')).toBe(2_000);
    expect(seen.has('authorBad')).toBe(false);
  });

  it('authorFirstSeen falls through to an author’s next readable row', async () => {
    const { cache, db } = await cacheWithOneBadRow(0);
    const later = item({ platformPostId: 'later', authorPopclawId: 'authorBad', platformPostCreatedAt: 5_000 });
    cache.record(later, bytesOf(later), 1);
    const earliest = item({ platformPostId: 'earliest', authorPopclawId: 'authorBad', platformPostCreatedAt: 500 });
    cache.record(earliest, bytesOf(earliest), 1);
    db.execute('UPDATE world_feed SET raw=? WHERE platform_post_id=?', [
      Buffer.from(bytesOf({ ...earliest, envelope: undefined })), 'earliest',
    ]);
    // 500 is unreadable, 1_000 is the seeded bad row, 5_000 is the good one.
    expect(cache.authorFirstSeen().get('authorBad')).toBe(5_000);
  });

  it('authorFirstSeen counts a lost AUTHOR once, however many unreadable rows it has', async () => {
    // The scan resolves authors, not rows: a readable author's later rows are never
    // decoded, so counting rows would bill an author with three bad rows three times
    // against a denominator the scan never read.
    const { cache, db, logs } = await cacheWithOneBadRow(1);
    for (const id of ['bad-row-2', 'bad-row-3']) {
      const extra = item({ platformPostId: id, authorPopclawId: 'authorBad', platformPostCreatedAt: 900 });
      cache.record(extra, bytesOf(extra), 1);
      db.execute('UPDATE world_feed SET raw=? WHERE platform_post_id=?', [
        Buffer.from(bytesOf({ ...extra, envelope: undefined })), id,
      ]);
    }
    expect(cache.authorFirstSeen().has('authorBad')).toBe(false);
    const skipLines = logs.filter((l) => l.includes('skipped') && l.includes('authorFirstSeen'));
    expect(skipLines).toHaveLength(1);
    expect(skipLines[0]).toContain('1 unreadable author(s)');
  });

  it('authorFirstSeen says nothing about an author a later row rescued', async () => {
    const { cache, logs } = await cacheWithOneBadRow(0);
    const later = item({ platformPostId: 'later', authorPopclawId: 'authorBad', platformPostCreatedAt: 5_000 });
    cache.record(later, bytesOf(later), 1);
    expect(cache.authorFirstSeen().get('authorBad')).toBe(5_000);
    expect(logs.filter((l) => l.includes('authorFirstSeen'))).toEqual([]);
  });

  it('a clean cache logs nothing and reads everything', async () => {
    const logs: string[] = [];
    const db = new LocalHostDb(':memory:');
    const cache = new WorldFeedCache({ db, debug: (m) => logs.push(m) });
    await cache.start();
    const it = item({ platformPostId: 'p1', platformPostCreatedAt: 42 });
    cache.record(it, bytesOf(it), 1);
    expect(cache.recentForReading(10)).toHaveLength(1);
    expect(cache.authorFirstSeen().get('authorA')).toBe(42);
    expect(logs.filter((l) => l.includes('skipped'))).toEqual([]);
  });

  it('the write and verification paths still refuse the same bytes', async () => {
    const { cache, db } = await cacheWithOneBadRow(1);
    const missing = item({ envelope: undefined, platformPostId: 'never-stored' });
    expect(() => cache.record(missing, bytesOf(missing))).toThrow();
    const hex = 'abc123' + '0'.repeat(58);
    const prefixed = item({ platform: 'popclaw', platformPostId: hex, eventId: hex });
    cache.record(prefixed, bytesOf(prefixed), 1);
    db.execute('UPDATE world_feed SET raw=? WHERE platform_post_id=?', [
      Buffer.from(bytesOf({ ...prefixed, envelope: undefined })), hex,
    ]);
    expect(() => cache.findFullEventId('abc123')).toThrow();
    expect(() => cache.findByEventIdPrefix('abc123')).toThrow();
  });
});
