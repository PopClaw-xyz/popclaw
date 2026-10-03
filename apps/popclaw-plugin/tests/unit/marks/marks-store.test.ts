import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { MarksStore } from '../../../src/marks/marks-store.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

function freshStore(): MarksStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new MarksStore(db);
}

describe('MarksStore', () => {
  it('upsert is idempotent on event_id', () => {
    const s = freshStore();
    const row = {
      eventId: 'a'.repeat(64), platform: 'x', platformPostId: '123',
      authorPopclawId: 'AUTH', handle: 'h', summaryLine: 'sum',
      bodySnapshot: 'body', sourceUrl: 'https://x.com/...', markedAt: 100,
    };
    s.upsert(row);
    s.upsert({ ...row, markedAt: 200 });
    expect(s.listActive(10)).toHaveLength(1);
    expect(s.listActive(10)[0]!.markedAt).toBe(200);
  });

  it('delete removes the row; deleting absent id is a no-op', () => {
    const s = freshStore();
    expect(() => s.delete('f'.repeat(64))).not.toThrow();
    const row = {
      eventId: 'b'.repeat(64), platform: 'x', platformPostId: '456',
      authorPopclawId: '', handle: '', summaryLine: '', bodySnapshot: '',
      sourceUrl: '', markedAt: 1,
    };
    s.upsert(row);
    expect(s.listActive(10)).toHaveLength(1);
    s.delete(row.eventId);
    expect(s.listActive(10)).toHaveLength(0);
  });

  it('listActive returns newest-first, limited', () => {
    const s = freshStore();
    for (let i = 0; i < 5; i++) {
      s.upsert({
        eventId: String(i).repeat(64).slice(0, 64), platform: 'popclaw',
        platformPostId: 'p' + i, authorPopclawId: '', handle: '',
        summaryLine: 's' + i, bodySnapshot: '', sourceUrl: '', markedAt: i,
      });
    }
    const top = s.listActive(2);
    expect(top.map((r) => r.markedAt)).toEqual([4, 3]);
  });

  it('has(eventId) reflects current state', () => {
    const s = freshStore();
    const eventId = 'a'.repeat(64);
    expect(s.has(eventId)).toBe(false);
    s.upsert({
      eventId, platform: 'x', platformPostId: '1',
      authorPopclawId: '', handle: '', summaryLine: '',
      bodySnapshot: '', sourceUrl: '', markedAt: 1,
    });
    expect(s.has(eventId)).toBe(true);
    s.delete(eventId);
    expect(s.has(eventId)).toBe(false);
  });
});
