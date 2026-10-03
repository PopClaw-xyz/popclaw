/**
 * favorites.jsonl → marks 迁移（favorites-migration.ts）单测。
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { MarksStore } from '../../../src/marks/marks-store.js';
import { migrateFavoritesJsonl } from '../../../src/marks/favorites-migration.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

function freshStore(): MarksStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new MarksStore(db);
}

const E1 = 'a'.repeat(64);
const E2 = 'b'.repeat(64);

describe('migrateFavoritesJsonl', () => {
  it('无文件 → 返回 0，不抛', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'popclaw-fav-migrate-'));
    const store = freshStore();
    expect(migrateFavoritesJsonl(join(dir, 'favorites.jsonl'), store)).toBe(0);
  });

  it('3行（含1坏行）→ 迁2条 + 文件改名 .migrated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'popclaw-fav-migrate-'));
    const lines = [
      JSON.stringify({ ts: 1700000001, event_id: E1, summary_line: '1. [mrbeast] Last to leave wins' }),
      'NOT_JSON_AT_ALL{{{',
      JSON.stringify({ ts: 1700000002, event_id: E2, summary_line: '2. [alixearle] Morning routine' }),
    ].join('\n');
    const file = join(dir, 'favorites.jsonl');
    await writeFile(file, lines, 'utf-8');

    const store = freshStore();
    const count = migrateFavoritesJsonl(join(dir, 'favorites.jsonl'), store);

    expect(count).toBe(2);
    // 原文件已消失，改名为 .migrated
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file + '.migrated')).toBe(true);
    // marks 表含两条
    expect(store.has(E1)).toBe(true);
    expect(store.has(E2)).toBe(true);
    // 字段映射正确
    const rows = store.listActive(10);
    const r1 = rows.find((r) => r.eventId === E1)!;
    expect(r1).toBeDefined();
    expect(r1.platform).toBe('popclaw');
    expect(r1.markedAt).toBe(1700000001);
    expect(r1.summaryLine).toContain('Last to leave wins');
  });

  it('再跑（.migrated 存在，原文件不在）→ 返回 0（幂等）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'popclaw-fav-migrate-'));
    // 只放 .migrated，无原文件
    await writeFile(
      join(dir, 'favorites.jsonl.migrated'),
      JSON.stringify({ ts: 1, event_id: E1, summary_line: 'old' }) + '\n',
    );
    const store = freshStore();
    expect(migrateFavoritesJsonl(join(dir, 'favorites.jsonl'), store)).toBe(0);
  });

  it('marks 表已有同 event_id 的不覆盖', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'popclaw-fav-migrate-'));
    const file = join(dir, 'favorites.jsonl');
    await writeFile(
      file,
      JSON.stringify({ ts: 999, event_id: E1, summary_line: 'old summary' }) + '\n',
    );
    const store = freshStore();
    // 预先插入同 event_id
    store.upsert({
      eventId: E1, platform: 'x', platformPostId: E1,
      authorPopclawId: 'pid', handle: 'handle', summaryLine: 'existing',
      bodySnapshot: 'existing', sourceUrl: '', markedAt: 1234,
    });

    const count = migrateFavoritesJsonl(join(dir, 'favorites.jsonl'), store);

    expect(count).toBe(0); // 不覆盖
    // 原行未被覆盖
    const rows = store.listActive(10);
    const r = rows.find((r) => r.eventId === E1)!;
    expect(r.summaryLine).toBe('existing');
    expect(r.platform).toBe('x');
    // 文件还是被重命名
    expect(existsSync(file)).toBe(false);
    expect(existsSync(file + '.migrated')).toBe(true);
  });
});
