import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { SqliteWatchWatermarkStore } from '../../../src/watch/watch-watermark-store.js';
import { WatchRegistry, defaultEntry } from '../../../src/watch/watch-registry.js';

const MIGRATIONS_DIR = join(__dirname, '../../../migrations');
const base = new Date('2026-04-24T00:00:00Z').getTime();
const baseSecs = Math.floor(base / 1000);

function freshDb() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

describe('SqliteWatchWatermarkStore', () => {
  it('returns null before anything is saved', () => {
    expect(new SqliteWatchWatermarkStore(freshDb()).load('w1')).toBeNull();
  });

  it('round-trips and overwrites on the same watch id', () => {
    const store = new SqliteWatchWatermarkStore(freshDb());
    store.save('w1', {
      consecutiveHits: 1,
      consecutiveMisses: 0,
      lastSeenCreatedAt: 100,
      lastSeenPlatformPostId: 'p100',
    });
    store.save('w1', {
      consecutiveHits: 2,
      consecutiveMisses: 0,
      lastSeenCreatedAt: 200,
      lastSeenPlatformPostId: 'p200',
    });
    expect(store.load('w1')).toEqual({ lastSeenCreatedAt: 200, lastSeenPlatformPostId: 'p200' });
  });

  it('never throws when the table is missing — a broken watermark costs one page, not the watch', () => {
    const warnings: string[] = [];
    const store = new SqliteWatchWatermarkStore(new InMemoryHostDb(), (m) => warnings.push(m));
    expect(store.load('w1')).toBeNull();
    expect(() => store.save('w1', {
      consecutiveHits: 1,
      consecutiveMisses: 0,
      lastSeenCreatedAt: 1,
      lastSeenPlatformPostId: 'p1',
    })).not.toThrow();
    expect(warnings).toHaveLength(2);
  });
});

describe('WatchRegistry restart resume (#181)', () => {
  it('a restarted registry resumes on the exact post id, not the dispatched day cursor', () => {
    const db = freshDb();
    const before = new WatchRegistry(new SqliteWatchWatermarkStore(db));
    before.add('w1', 'T1', 'blackfeather_ai', 'x', defaultEntry(base, baseSecs));
    before.updateAfterPoll('w1', true, baseSecs + 60, base, 'post-42');

    // Restart: new registry, and the lore-house re-dispatches from last_post_at
    // (a timestamp — it has no post id to give us).
    const after = new WatchRegistry(new SqliteWatchWatermarkStore(db));
    after.add('w1', 'T1', 'blackfeather_ai', 'x', defaultEntry(base, baseSecs + 60));
    expect(after.all()[0]!.state.lastSeenPlatformPostId).toBe('post-42');
    expect(after.all()[0]!.state.lastSeenCreatedAt).toBe(baseSecs + 60);
  });

  it('a lore-house seed that is newer than our watermark wins', () => {
    const db = freshDb();
    const before = new WatchRegistry(new SqliteWatchWatermarkStore(db));
    before.add('w1', 'T1', 'blackfeather_ai', 'x', defaultEntry(base, baseSecs));
    before.updateAfterPoll('w1', true, baseSecs + 60, base, 'post-42');

    const after = new WatchRegistry(new SqliteWatchWatermarkStore(db));
    after.add('w1', 'T1', 'blackfeather_ai', 'x', defaultEntry(base, baseSecs + 5000));
    expect(after.all()[0]!.state.lastSeenCreatedAt).toBe(baseSecs + 5000);
    expect(after.all()[0]!.state.lastSeenPlatformPostId).toBe('');
  });

  it('a miss does not write a watermark', () => {
    const db = freshDb();
    const r = new WatchRegistry(new SqliteWatchWatermarkStore(db));
    r.add('w1', 'T1', 'blackfeather_ai', 'x', defaultEntry(base, baseSecs));
    r.updateAfterPoll('w1', false, 0, base);
    expect(db.queryAll('SELECT * FROM watch_watermarks')).toHaveLength(0);
  });

  it('no store = pure in-memory, unchanged behaviour', () => {
    const r = new WatchRegistry();
    r.add('w1', 'T1', 'blackfeather_ai', 'x', defaultEntry(base, baseSecs));
    r.updateAfterPoll('w1', true, baseSecs + 60, base, 'post-42');
    expect(r.all()[0]!.state.lastSeenPlatformPostId).toBe('post-42');
  });
});
