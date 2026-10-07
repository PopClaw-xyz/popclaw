import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { openWorldFeedStore, executionDbFor } from '../../../src/ingress/world-feed-store.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { WorldFeedCatalog } from '../../../src/ingress/world-feed-catalog.js';
import { runPopclawFeedCommand } from '../../../src/commands/popclaw-feed.js';
import { item } from '../../helpers/world-feed-cache.js';

async function scenario(mode: string, empty = false, publicV1 = false) {
  const root = mkdtempSync(join(tmpdir(), 'protected-snapshot-'));
  const paths = new PopclawPaths(root), slug = 'house-example-test';
  const legacyPath = paths.lorehouseDb(slug);
  const old = new LocalHostDb(legacyPath), oldCache = new WorldFeedCache({ db: old });
  await oldCache.start();
  oldCache.record(item({ platformPostId: 'history' }));
  oldCache.recordInsertCursor('31');
  if (mode.startsWith('mixed')) {
    old.execute('CREATE TABLE world_stream(seq INTEGER PRIMARY KEY, task_done INTEGER)');
    old.execute('INSERT INTO world_stream VALUES(31,1)');
  }
  if (mode === 'unknown') old.execute('CREATE TABLE unknown_history(id INTEGER PRIMARY KEY)');
  old.close();
  const before = readFileSync(legacyPath);
  if (mode === 'mixed-projection') {
    const db = new LocalHostDb(paths.worldFeedProjectionDb(slug));
    await new WorldFeedCache({ db }).start(); db.close();
  }
  const global = new LocalHostDb(join(root, 'global.db'));
  const stores = new ExecutionStoreCatalog({ db: global, paths, actorId: 'synthetic-actor' });
  const house = await openWorldFeedStore('https://house.example.test', paths, undefined, stores);
  try {
    const remote = vi.fn(async () => empty ? [] : [item({
      platform: 'popclaw', platformPostId: 'synthetic-new', textPreview: 'PopClaw integration test',
    })]);
    const record = vi.spyOn(house.cache, 'record');
    const catalog = new WorldFeedCatalog([{ ...house, snapshot: { fetchSnapshot: remote } }]);
    // Public-v1 display owns a distinct read path. This spy proves bypass,
    // not a successful public execution journal or a real stream.
    const read = vi.fn(() => ({ items: [], sources: [] }));
    const result = await runPopclawFeedCommand({ positional: [], flags: {} }, catalog,
      publicV1 ? { publicFeedDisplay: { read } as never } : {});
    expect(result.text).not.toContain('readonly database');
    expect(result.text).not.toContain('failed:');
    if (publicV1) {
      expect(read).toHaveBeenCalledOnce(); expect(remote).not.toHaveBeenCalled();
    } else {
      expect(remote).toHaveBeenCalledOnce();
      if (!empty) expect(result.text).toContain('PopClaw integration test');
    }
    if (mode === 'mixed' || mode === 'unknown') {
      expect(house.cacheReadOnly).toBe(true);
      expect(record).not.toHaveBeenCalled();
      expect(house.cache.recent(10).map(row => row.platformPostId)).toEqual(['history']);
      expect(house.cache.insertCursor()).toBe(31);
      expect(readFileSync(legacyPath)).toEqual(before);
    } else if (!empty && !publicV1) expect(record).toHaveBeenCalledOnce();
    if (mode !== 'cache-only') {
      expect(house.executionDb).toBeUndefined();
      expect(() => executionDbFor(house)).toThrow(/EXECUTION_MIGRATION_REQUIRED|EXECUTION_SCHEMA_UNKNOWN/);
      expect(global.queryAll('SELECT origin FROM execution_store_catalog_v1')).toEqual([]);
    }
  } finally {
    house.db.close(); stores.close(); global.close();
    rmSync(root, { recursive: true, force: true });
  }
}

describe('protected legacy store through the actual snapshot command', () => {
  it.each(['cache-only', 'mixed', 'unknown', 'mixed-projection'])('%s separates feed readability from execution readiness', async mode => {
    await scenario(mode);
  });
  it('keeps an empty snapshot harmless for a protected house', async () => scenario('mixed', true));
  it('does not route public-v1 display through the legacy snapshot writer', async () => scenario('mixed', false, true));
});
