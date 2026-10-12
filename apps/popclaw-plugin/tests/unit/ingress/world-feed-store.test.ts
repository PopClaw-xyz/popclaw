import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorldFeedStore, openHouseStores } from '../../../src/ingress/world-feed-store';
import { WorldFeedCatalog } from '../../../src/ingress/world-feed-catalog';
import { PopclawPaths } from '../../../src/host/popclaw-paths';
import { bytesOf, item } from '../../helpers/world-feed-cache';

describe('openWorldFeedStore', () => {
  it('opens data/lorehouses/<slug>.db, creates the table, and records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wfs-'));
    const paths = new PopclawPaths(root);
    const { cache, dbPath, slug, baseUrl } = await openWorldFeedStore('https://popclaw.me', paths);
    expect(dbPath).toBe(join(root, 'data', 'lorehouses', 'popclaw-me.db'));
    // Slice 2: the source-house label comes from the slug derived here.
    expect(slug).toBe('popclaw-me');
    expect(baseUrl).toBe('https://popclaw.me');
    expect(existsSync(dbPath)).toBe(true);
    const it_ = item({ platformPostId: 'p1' });
    cache.record(it_, bytesOf(it_), 1);
    expect(cache.recent(10).map((i) => i.platformPostId)).toEqual(['p1']);
  });

  it('different lore-houses → different db files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wfs-'));
    const paths = new PopclawPaths(root);
    const a = await openWorldFeedStore('http://localhost:8080', paths);
    const b = await openWorldFeedStore('https://dayou.art', paths);
    expect(a.dbPath).toBe(join(root, 'data', 'lorehouses', 'localhost-8080.db'));
    expect(b.dbPath).toBe(join(root, 'data', 'lorehouses', 'dayou-art.db'));
  });
});

/**
 * PopclawPaths that throws only for one house's database path, simulating a house that cannot be
 * opened.
 */
function pathsFailingOn(root: string, badSlug: string): PopclawPaths {
  const paths = new PopclawPaths(root);
  const real = paths.lorehouseDb.bind(paths);
  paths.lorehouseDb = (slug: string) => {
    if (slug === badSlug) throw new Error('disk on fire');
    return real(slug);
  };
  return paths;
}

describe('openHouseStores — 主坊是硬依赖，副坊可降级', () => {
  const HOME = 'https://house.popclaw.me';
  const WORLD = 'https://house.popclaw.world';

  it('全部打得开：顺序 == 配置顺序，[0] 是主坊', async () => {
    const paths = new PopclawPaths(mkdtempSync(join(tmpdir(), 'wfs-')));
    const stores = await openHouseStores([HOME, WORLD], paths);
    expect(stores.map((s) => s.slug)).toEqual(['house-popclaw-me', 'house-popclaw-world']);
  });

  it('副坊打不开只掉那一座：其余照连，onError 记一行，home() 仍是配置 [0]', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wfs-'));
    const onError = vi.fn();
    const stores = await openHouseStores(
      [HOME, WORLD],
      pathsFailingOn(root, 'house-popclaw-world'),
      { onError },
    );
    expect(stores.map((s) => s.slug)).toEqual(['house-popclaw-me']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe(WORLD);
    // Pin the invariant: catalog.home() always equals the first configured house (basis for slice 3 write routing).
    const cat = new WorldFeedCatalog(
      stores.map((s) => ({ ...s, snapshot: { fetchSnapshot: async () => [] } })),
    );
    expect(cat.home().baseUrl).toBe(HOME);
  });

  it('主坊打不开直接抛 —— 绝不让副坊顶替成 [0]（home() 漂移 = 写侧发错坊）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wfs-'));
    await expect(
      openHouseStores([HOME, WORLD], pathsFailingOn(root, 'house-popclaw-me')),
    ).rejects.toThrow(/home lore-house/);
  });

  it('空数组直接拒绝', async () => {
    const paths = new PopclawPaths(mkdtempSync(join(tmpdir(), 'wfs-')));
    await expect(openHouseStores([], paths)).rejects.toThrow(/at least one URL/);
  });
});
