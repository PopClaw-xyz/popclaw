/**
 * 规格 B 切片②：跨坊合并视图。
 * 三条不变量：来源坊标签 / event_id 跨坊去重 / 单坊配置逐条不变。
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { popclaw } from '@popclaw/contracts';
import { makeCache, bytesOf, item } from '../../helpers/world-feed-cache';
import { WorldFeedCatalog, type HouseFeed } from '../../../src/ingress/world-feed-catalog';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache';
import { LocalHostDb } from '../../../src/host/local-host-db';

async function house(
  slug: string,
  snapshot: popclaw.event.IWorldFeedItem[] | Error = [],
): Promise<HouseFeed & { cache: WorldFeedCache }> {
  const { cache } = await makeCache();
  return {
    slug,
    baseUrl: `https://${slug}`,
    cache,
    dbPath: ':memory:',
    snapshot: {
      fetchSnapshot: async () => {
        if (snapshot instanceof Error) throw snapshot;
        return snapshot;
      },
    },
  };
}

const rec = (h: { cache: WorldFeedCache }, over: Partial<popclaw.event.IWorldFeedItem>) => {
  const it = item(over);
  h.cache.record(it, bytesOf(it), 1);
};

describe('WorldFeedCatalog — 跨坊合并视图', () => {
  it('recent() 合并两坊、按时间排序、每条带来源坊 slug', async () => {
    const home = await house('popclaw-me');
    const world = await house('popclaw-world');
    rec(home, { platformPostId: 'h1', eventId: 'e-h1', platformPostCreatedAt: 100 });
    rec(world, { platformPostId: 'w1', eventId: 'e-w1', platformPostCreatedAt: 300 });
    rec(home, { platformPostId: 'h2', eventId: 'e-h2', platformPostCreatedAt: 200 });

    const got = new WorldFeedCatalog([home, world]).recent(10);
    expect(got.map((i) => i.platformPostId)).toEqual(['w1', 'h2', 'h1']);
    expect(got.map((i) => i.houseSlug)).toEqual(['popclaw-world', 'popclaw-me', 'popclaw-me']);
  });

  it('recent(n) 截断的是合并后的结果，不是每坊各 n 条', async () => {
    const a = await house('a');
    const b = await house('b');
    rec(a, { platformPostId: 'a1', eventId: 'ea1', platformPostCreatedAt: 10 });
    rec(b, { platformPostId: 'b1', eventId: 'eb1', platformPostCreatedAt: 20 });
    rec(b, { platformPostId: 'b2', eventId: 'eb2', platformPostCreatedAt: 30 });
    expect(new WorldFeedCatalog([a, b]).recent(2).map((i) => i.platformPostId)).toEqual(['b2', 'b1']);
  });

  it('同一 event_id 跨坊撞号 = 同一事件（中继）：留先见者，后见的坊记进 alsoInHouses', async () => {
    const home = await house('popclaw-me');
    const world = await house('popclaw-world');
    rec(home, { platformPostId: 'p', eventId: 'SAME', platformPostCreatedAt: 100 });
    rec(world, { platformPostId: 'p', eventId: 'SAME', platformPostCreatedAt: 100 });

    const got = new WorldFeedCatalog([home, world]).recent(10);
    expect(got).toHaveLength(1);
    expect(got[0]!.houseSlug).toBe('popclaw-me');
    expect(got[0]!.alsoInHouses).toEqual(['popclaw-world']);
  });

  it('没有 event_id 时退回 (platform, post_id) 去重；不同 event_id 不合并', async () => {
    const a = await house('a');
    const b = await house('b');
    rec(a, { platform: 'x', platformPostId: 'same', eventId: '', platformPostCreatedAt: 1 });
    rec(b, { platform: 'x', platformPostId: 'same', eventId: '', platformPostCreatedAt: 1 });
    rec(b, { platform: 'x', platformPostId: 'other', eventId: '', platformPostCreatedAt: 2 });
    expect(new WorldFeedCatalog([a, b]).recent(10).map((i) => i.platformPostId)).toEqual([
      'other', 'same',
    ]);
  });

  it('byAuthor / byPlatform / search 都合并且带来源坊', async () => {
    const a = await house('a');
    const b = await house('b');
    rec(a, { platformPostId: 'a1', eventId: 'ea1', authorPopclawId: 'A', textPreview: 'rust 好', platformPostCreatedAt: 1 });
    rec(b, { platformPostId: 'b1', eventId: 'eb1', authorPopclawId: 'A', textPreview: 'rust 更好', platformPostCreatedAt: 2 });
    rec(b, { platformPostId: 'b2', eventId: 'eb2', authorPopclawId: 'Z', platform: 'tiktok', platformPostCreatedAt: 3 });
    const cat = new WorldFeedCatalog([a, b]);
    expect(cat.byAuthor('A', 10).map((i) => i.platformPostId)).toEqual(['b1', 'a1']);
    expect(cat.byPlatform('x', 10).map((i) => i.houseSlug)).toEqual(['b', 'a']);
    expect(cat.search('rust', 10).map((i) => i.platformPostId)).toEqual(['b1', 'a1']);
  });

  it('authorIds() 是各坊的并集（认人的「我见过的人」）', async () => {
    const a = await house('a');
    const b = await house('b');
    rec(a, { platformPostId: 'a1', eventId: 'ea1', authorPopclawId: 'A' });
    rec(b, { platformPostId: 'b1', eventId: 'eb1', authorPopclawId: 'B' });
    rec(b, { platformPostId: 'b2', eventId: 'eb2', authorPopclawId: 'A' });
    expect(new WorldFeedCatalog([a, b]).authorIds().sort()).toEqual(['A', 'B']);
  });

  it('lookup() 按坊顺序取第一处命中并贴 slug；找不到 → null', async () => {
    const home = await house('popclaw-me');
    const world = await house('popclaw-world');
    rec(world, { platform: 'x', platformPostId: 'only-in-world', eventId: 'ew' });
    const cat = new WorldFeedCatalog([home, world]);
    expect(cat.lookup('x', 'only-in-world')?.houseSlug).toBe('popclaw-world');
    expect(cat.lookup('x', 'nope')).toBeNull();
  });

  it('repliesToOwner() 合并两坊的回音，回音带自己那座坊的 slug', async () => {
    const home = await house('popclaw-me');
    const world = await house('popclaw-world');
    // 各坊自成一条 帖→回 的链：回音一定落在被回内容所在的坊。
    rec(home, { platform: 'popclaw', platformPostId: 'mine-h', eventId: 'eh', authorPopclawId: 'ME' });
    rec(home, { platform: 'popclaw', platformPostId: 'r-h', eventId: 'erh', authorPopclawId: 'X', replyToPlatform: 'popclaw', replyToPostId: 'mine-h', platformPostCreatedAt: 10 });
    rec(world, { platform: 'popclaw', platformPostId: 'mine-w', eventId: 'ew', authorPopclawId: 'ME' });
    rec(world, { platform: 'popclaw', platformPostId: 'r-w', eventId: 'erw', authorPopclawId: 'Y', replyToPlatform: 'popclaw', replyToPostId: 'mine-w', platformPostCreatedAt: 20 });

    const got = new WorldFeedCatalog([home, world]).repliesToOwner('ME', 10);
    expect(got.map((r) => r.reply.platformPostId)).toEqual(['r-w', 'r-h']);
    expect(got.map((r) => r.reply.houseSlug)).toEqual(['popclaw-world', 'popclaw-me']);
  });

  it('findFullEventId：跨坊唯一才算唯一，两坊各有一条撞前缀 → ambiguous', async () => {
    const a = await house('a');
    const b = await house('b');
    const full = 'abc'.padEnd(64, '0');
    const other = 'abc'.padEnd(63, '0') + '1';
    rec(a, { platform: 'popclaw', platformPostId: full, eventId: full });
    const cat1 = new WorldFeedCatalog([a, b]);
    expect(cat1.findFullEventId('abc')).toEqual({ full, ambiguous: [] });

    rec(b, { platform: 'popclaw', platformPostId: other, eventId: other });
    const r = new WorldFeedCatalog([a, b]).findFullEventId('abc');
    expect(r.full).toBeNull();
    expect(r.ambiguous.sort()).toEqual([full, other].sort());
  });

  it('findByEventIdPrefix：命中坊贴 slug；跨坊两条不同 id → ambiguous', async () => {
    const a = await house('a');
    const b = await house('b');
    rec(a, { platformPostId: 'p1', eventId: 'dead01' });
    expect(new WorldFeedCatalog([a, b]).findByEventIdPrefix('dead')?.item?.houseSlug).toBe('a');
    rec(b, { platformPostId: 'p2', eventId: 'dead02' });
    const r = new WorldFeedCatalog([a, b]).findByEventIdPrefix('dead');
    expect(r.item).toBeNull();
    expect(r.ambiguous.sort()).toEqual(['dead01', 'dead02']);
  });

  it('单坊配置（数组长度 1）逐条与单个 cache 完全一致 —— 现网存量用户零变化', async () => {
    const only = await house('popclaw-me');
    rec(only, { platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 100, textPreview: 'a' });
    rec(only, { platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 300, textPreview: 'b' });
    rec(only, { platformPostId: 'p3', eventId: 'e3', platformPostCreatedAt: 200, textPreview: 'a b' });

    const direct = only.cache.recent(10);
    const viaCatalog = new WorldFeedCatalog([only]).recent(10);
    expect(viaCatalog.map((i) => i.platformPostId)).toEqual(direct.map((i) => i.platformPostId));
    // 唯一多出来的东西就是来源坊标签。
    expect(viaCatalog.every((i) => i.houseSlug === 'popclaw-me')).toBe(true);
    expect(viaCatalog.every((i) => i.alsoInHouses === undefined)).toBe(true);
    expect(new WorldFeedCatalog([only]).search('a', 10).map((i) => i.platformPostId))
      .toEqual(only.cache.search('a', 10).map((i) => i.platformPostId));
  });

  it('houses()/home()/forHouse() 保住配置顺序，[0] 是主坊', async () => {
    const home = await house('popclaw-me');
    const world = await house('popclaw-world');
    const cat = new WorldFeedCatalog([home, world]);
    expect(cat.houses().map((h) => h.slug)).toEqual(['popclaw-me', 'popclaw-world']);
    expect(cat.home().slug).toBe('popclaw-me');
    expect(cat.forHouse('popclaw-world')?.baseUrl).toBe('https://popclaw-world');
    expect(cat.forHouse('nope')).toBeUndefined();
  });

  it('空数组直接拒绝（没有坊 = 没有视图）', async () => {
    expect(() => new WorldFeedCatalog([])).toThrow(/at least one house/);
  });
});

describe('WorldFeedCatalog.fetchSnapshot — 各坊快照并发拉', () => {
  it('returns sorted, deduplicated snapshots without writing a protected cache', async () => {
    const root = mkdtempSync(join(tmpdir(), 'world-feed-readonly-'));
    const dbPath = join(root, 'legacy.db');
    const source = new LocalHostDb(dbPath);
    let readOnlyDb: LocalHostDb | undefined;
    try {
      const sourceCache = new WorldFeedCache({ db: source });
      await sourceCache.start();
      sourceCache.record(item({ platformPostId: 'history', eventId: 'history' }));
      sourceCache.recordInsertCursor('31');
      source.execute('CREATE TABLE world_stream(seq INTEGER PRIMARY KEY, task_done INTEGER)');
      source.execute('INSERT INTO world_stream VALUES(31,1)');
      source.close();

      readOnlyDb = new LocalHostDb(dbPath, { readOnly: true });
      const protectedCache = new WorldFeedCache({ db: readOnlyDb });
      const protectedRecord = vi.spyOn(protectedCache, 'record');
      const shared = item({ platformPostId: 'shared', eventId: 'shared', platformPostCreatedAt: 200 });
      const protectedHouse: HouseFeed = {
        slug: 'protected', baseUrl: 'https://protected.example', dbPath,
        cache: protectedCache, cacheReadOnly: true,
        snapshot: { fetchSnapshot: async () => [shared,
          item({ platformPostId: 'protected-new', eventId: 'protected-new', platformPostCreatedAt: 100 })] },
      };
      const writableHouse = await house('writable', [shared,
        item({ platformPostId: 'writable-new', eventId: 'writable-new', platformPostCreatedAt: 300 })]);
      const writableRecord = vi.spyOn(writableHouse.cache, 'record');
      const got = await new WorldFeedCatalog([protectedHouse, writableHouse]).fetchSnapshot({ limit: 10 });

      expect(got.map(i => i.platformPostId)).toEqual(['writable-new', 'shared', 'protected-new']);
      expect(protectedRecord).not.toHaveBeenCalled();
      expect(writableRecord).toHaveBeenCalledTimes(2);
      expect(writableHouse.cache.recent(10).map(i => i.platformPostId)).toEqual(['writable-new', 'shared']);
      expect(protectedCache.recent(10).map(i => i.platformPostId)).toEqual(['history']);
      expect(protectedCache.insertCursor()).toBe(31);
      expect(readOnlyDb.queryAll('SELECT seq,task_done FROM world_stream')).toEqual([{ seq: 31, task_done: 1 }]);
    } finally {
      readOnlyDb?.close();
      source.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('合并去重并把每条落进它自己那座坊的缓存（归属不串）', async () => {
    const home = await house('popclaw-me', [item({ platformPostId: 'h1', eventId: 'eh', platformPostCreatedAt: 100 })]);
    const world = await house('popclaw-world', [
      item({ platformPostId: 'w1', eventId: 'ew', platformPostCreatedAt: 300 }),
      item({ platformPostId: 'h1', eventId: 'eh', platformPostCreatedAt: 100 }), // 中继重复
    ]);
    const got = await new WorldFeedCatalog([home, world]).fetchSnapshot({ limit: 10 });
    expect(got.map((i) => i.platformPostId)).toEqual(['w1', 'h1']);
    expect(home.cache.recent(10).map((i) => i.platformPostId)).toEqual(['h1']);
    expect(world.cache.recent(10).map((i) => i.platformPostId)).toEqual(['w1', 'h1']);
  });

  it('一座坊拉不动只记一行告警，其余照给', async () => {
    const home = await house('popclaw-me', [item({ platformPostId: 'h1', eventId: 'eh' })]);
    const dead = await house('popclaw-world', new Error('ECONNREFUSED'));
    const warn = vi.fn();
    const got = await new WorldFeedCatalog([home, dead], { warn }).fetchSnapshot({ limit: 10 });
    expect(got.map((i) => i.platformPostId)).toEqual(['h1']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('popclaw-world');
  });

  it('authorFirstSeen() 取跨坊最早的那次（本机首见只有一个）', async () => {
    const home = await house('popclaw-me');
    const world = await house('popclaw-world');
    rec(home, { platformPostId: 'h1', eventId: 'e1', authorPopclawId: 'A', platformPostCreatedAt: 300 });
    rec(world, { platformPostId: 'w1', eventId: 'e2', authorPopclawId: 'A', platformPostCreatedAt: 100 });
    rec(world, { platformPostId: 'w2', eventId: 'e3', authorPopclawId: 'B', platformPostCreatedAt: 200 });
    const seen = new WorldFeedCatalog([home, world]).authorFirstSeen();
    expect(seen.get('A')).toBe(100);
    expect(seen.get('B')).toBe(200);
  });

  it('全部坊都挂了才抛（调用方仍看得见"feed 挂了"）', async () => {
    const a = await house('a', new Error('boom-a'));
    const b = await house('b', new Error('boom-b'));
    await expect(new WorldFeedCatalog([a, b]).fetchSnapshot({ limit: 10 })).rejects.toThrow('boom-a');
  });
});
