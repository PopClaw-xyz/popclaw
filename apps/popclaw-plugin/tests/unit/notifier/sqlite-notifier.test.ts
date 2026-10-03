import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import type { HostDb } from '../../../src/host/host-db.js';

// Resolve migrations dir relative to this test file so the suite works whether
// vitest runs from the package dir or the repo root (mirrors the convention in
// host-adapter.in-memory.ts:defaultMigrationsDir).
const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

describe('SqliteNotifier', () => {
  let db: HostDb;
  let notifier: SqliteNotifier;

  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    notifier = new SqliteNotifier(db, () => 1700000000);
  });

  it('enqueue + drain round-trip preserves all fields', () => {
    notifier.enqueue({
      level: 'L1',
      kind: 'dm',
      payload: { from: 'alice', text: 'hello' },
    });
    const drained = notifier.drain();
    expect(drained).toHaveLength(1);
    expect(drained[0]).toMatchObject({
      level: 'L1',
      kind: 'dm',
      payload: { from: 'alice', text: 'hello' },
      enqueuedAt: 1700000000,
    });
    expect(drained[0]?.id).toBeGreaterThan(0);
  });

  it('drain returns items in FIFO order (by enqueued_at then id)', () => {
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { n: 1 } });
    notifier.enqueue({ level: 'L2', kind: 'general_reply', payload: { n: 2 } });
    notifier.enqueue({ level: 'L3', kind: 'recommendation', payload: { n: 3 } });
    const drained = notifier.drain();
    expect(drained.map((d) => d.payload.n)).toEqual([1, 2, 3]);
  });

  it('drain(level) drains only that level — other levels stay pending', () => {
    // The L3-reporter landmine: a global drain() would mark L2/L3 delivered when
    // only L1 is being shipped. Scoped drain keeps each cadence independent.
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: { n: 1 } });
    notifier.enqueue({ level: 'L3', kind: 'recommendation', payload: { n: 3 } });
    const l1 = notifier.drain('L1');
    expect(l1.map((d) => d.payload.n)).toEqual([1]);
    expect(notifier.count('L3')).toBe(1); // untouched
    const l3 = notifier.drain('L3');
    expect(l3.map((d) => d.payload.n)).toEqual([3]);
    expect(notifier.count()).toBe(0);
  });

  it('drain marks items delivered — second drain returns empty', () => {
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: {} });
    notifier.drain();
    const second = notifier.drain();
    expect(second).toEqual([]);
  });

  it('count returns pending only (excludes delivered)', () => {
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: {} });
    notifier.enqueue({ level: 'L2', kind: 'general_reply', payload: {} });
    expect(notifier.count()).toBe(2);
    notifier.drain();
    expect(notifier.count()).toBe(0);
  });

  it('count(level) filters by level', () => {
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: {} });
    notifier.enqueue({ level: 'L2', kind: 'general_reply', payload: {} });
    notifier.enqueue({ level: 'L2', kind: 'taste_match', payload: {} });
    expect(notifier.count('L1')).toBe(1);
    expect(notifier.count('L2')).toBe(2);
    expect(notifier.count('L3')).toBe(0);
  });

  it('drain preserves audit row (delivered_at set, row not deleted)', () => {
    notifier.enqueue({ level: 'L1', kind: 'dm', payload: {} });
    notifier.drain();
    const allRows = db.queryAll<{ id: number; delivered_at: number | null }>(
      'SELECT id, delivered_at FROM notification_queue'
    );
    expect(allRows).toHaveLength(1);
    expect(allRows[0]?.delivered_at).toBe(1700000000);
  });

  it('rejects malformed level via CHECK constraint', () => {
    expect(() => {
      // bypassing TS by casting — test runtime guard
      notifier.enqueue({ level: 'L4' as any, kind: 'dm', payload: {} });
    }).toThrow();
  });
});
