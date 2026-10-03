/**
 * 规格 B 切片③的路由表逐行判据（docs/superpowers/specs/2026-07-26-multi-house-client-design.md）。
 *
 *   原创 Post / 红包 / invite / 注册          → 主坊
 *   Reply / Quote / Mark（含 revoke）        → 被回/被标内容的来源坊
 *   DM（切片④）                              → 那人最近一封来信的坊；无来信 → 主坊
 *   FollowDeclared                           → followee 的发现坊
 *   FollowRevoked                            → 当初 declare 的同一坊
 *   Profile 名片                             → 广播所有坊
 *
 * 每行都配一条"标签不可考 → 主坊"的兜底，外加末尾的单坊回归。
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MultiHouseEgress, type HouseEgress } from '../../../src/egress/multi-house-egress.js';
import { runPopclawPostCommand } from '../../../src/commands/popclaw-post.js';
import { runPopclawReplyCommand } from '../../../src/commands/popclaw-reply.js';
import { runPopclawMarkCommand, runPopclawUnmarkCommand } from '../../../src/commands/popclaw-mark.js';
import { runPopclawNameCommand } from '../../../src/commands/popclaw-name.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { MarkService } from '../../../src/marks/mark-service.js';
import { MarksStore } from '../../../src/marks/marks-store.js';
import { SocialGraph } from '../../../src/social-graph/social-graph.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { makeTestSigner } from '../../helpers/test-signer.js';
import type { CachedFeedItem } from '../../../src/ingress/world-feed-cache.js';
import type { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { fakeRelationProducer } from '../../helpers/fake-relation-producer.js';

// Relation writes now require the ordered producer to be installed; a
// stub declares that dependency. These cases still assert the CURRENT
// write behaviour — the bridge that hands the write to the producer is
// the next unit, and these assertions change with it.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOME = 'popclaw-me';
const WORLD = 'popclaw-world';
const EVENT_ID = 'a'.repeat(64);

// No network: namecard checks see a conformant, absent card for this identity.
const cleanProfileFetch = vi.fn(async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  return new Response(JSON.stringify({
    popclaw_id: decodeURIComponent(new URL(url).pathname.slice('/v1/profile/'.length)),
    sigil: 'abc234', profiles: [], house_follower_count: 0,
    house_post_count: 0, house_reply_received_count: 0,
  }), { status: 200 });
});

/** 记账式多坊 egress：谁收到了几条。 */
function egressOver(...slugs: string[]) {
  const counts = new Map<string, number>(slugs.map((s) => [s, 0]));
  const houses: HouseEgress[] = slugs.map((slug) => ({
    slug,
    origin: `https://${slug}.invalid`,
    egress: {
      push: async () => {
        counts.set(slug, counts.get(slug)! + 1);
        return { status: 200, eventId: EVENT_ID };
      },
    },
  }));
  return {
    egress: new MultiHouseEgress(houses, { debug: vi.fn(), warn: vi.fn() }),
    at: (slug: string) => counts.get(slug)!,
    all: () => Object.fromEntries(counts),
  };
}

function item(over: Partial<CachedFeedItem> = {}): CachedFeedItem {
  return {
    platform: 'x',
    platformPostId: '1234567890',
    eventId: EVENT_ID,
    platformPostCreatedAt: 1_700_000_000,
    authorPopclawId: 'AUTH123',
    handle: 'someone',
    originalUrl: 'https://x.com/someone/status/1234567890',
    textPreview: 'a post from the second house',
    ...over,
  };
}

/** cache 桩：lookup / findFullEventId / findByEventIdPrefix 都答同一条 item。 */
function cacheOf(found: CachedFeedItem | null) {
  return {
    lookup: () => found,
    findFullEventId: () => (found ? { full: found.eventId, ambiguous: [] } : { full: null, ambiguous: [] }),
    findByEventIdPrefix: () => ({ item: found, ambiguous: [] }),
    byAuthor: () => (found ? [found] : []),
  } as unknown as WorldFeedCache;
}

function marksStore(): MarksStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  return new MarksStore(db);
}

const tasteRoot = (): { tasteRoot: string } => ({ tasteRoot: mkdtempSync(join(tmpdir(), 'route-taste-')) });

describe('路由表 · 原创 Post → 主坊', () => {
  it('root post 落主坊', async () => {
    const e = egressOver(HOME, WORLD);
    const out = await runPopclawPostCommand(
      { positional: ['今天天气不错'], flags: {} },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather', cache: cacheOf(null), webBaseUrl: 'http://localhost:3000' },
    );
    expect(out.text).toContain('posted');
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 0 });
  });
});

describe('路由表 · Reply / Quote → 被回内容的来源坊', () => {
  it('/popclaw post --reply 落被回那条的坊', async () => {
    const e = egressOver(HOME, WORLD);
    await runPopclawPostCommand(
      { positional: ['接一句'], flags: { reply: EVENT_ID } },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather', cache: cacheOf(item({ houseSlug: WORLD })), webBaseUrl: 'http://localhost:3000' },
    );
    expect(e.all()).toEqual({ [HOME]: 0, [WORLD]: 1 });
  });

  it('/popclaw post --quote 落被引那条的坊', async () => {
    const e = egressOver(HOME, WORLD);
    await runPopclawPostCommand(
      { positional: ['值得一看'], flags: { quote: EVENT_ID } },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather', cache: cacheOf(item({ houseSlug: WORLD })), webBaseUrl: 'http://localhost:3000' },
    );
    expect(e.all()).toEqual({ [HOME]: 0, [WORLD]: 1 });
  });

  it('被回那条没有来源坊标签 → 主坊', async () => {
    const e = egressOver(HOME, WORLD);
    await runPopclawPostCommand(
      { positional: ['接一句'], flags: { reply: EVENT_ID } },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather', cache: cacheOf(item()), webBaseUrl: 'http://localhost:3000' },
    );
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 0 });
  });

  it('/popclaw reply 落被回内容的坊', async () => {
    const e = egressOver(HOME, WORLD);
    await runPopclawReplyCommand(
      { positional: ['1234567890', 'good', 'point'] },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, cache: cacheOf(item({ houseSlug: WORLD })), nickname: 'BlackFeather' },
    );
    expect(e.all()).toEqual({ [HOME]: 0, [WORLD]: 1 });
  });

  it('/popclaw reply 无标签 → 主坊', async () => {
    const e = egressOver(HOME, WORLD);
    await runPopclawReplyCommand(
      { positional: ['1234567890', 'good', 'point'] },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, cache: cacheOf(item()), nickname: 'BlackFeather' },
    );
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 0 });
  });
});

describe('路由表 · Mark（含 revoke）→ 被标内容的来源坊', () => {
  function markDeps(found: CachedFeedItem, e: ReturnType<typeof egressOver>) {
    const store = marksStore();
    const markService = new MarkService({
      store, signer: makeTestSigner('BlackFeather'), egress: e.egress,
      nickname: 'BlackFeather', taste: tasteRoot(),
    });
    return { store, deps: { cache: cacheOf(found), markService, store } };
  }

  it('mark 落被标那条的坊（服务端 403 防线才不误伤）', async () => {
    const e = egressOver(HOME, WORLD);
    const { deps } = markDeps(item({ houseSlug: WORLD }), e);
    const out = await runPopclawMarkCommand({ positional: [EVENT_ID] }, deps);
    expect(out.text).toContain('marked');
    expect(e.all()).toEqual({ [HOME]: 0, [WORLD]: 1 });
  });

  it('unmark 回同一座坊（本地 marks 表不记坊 → 回缓存问）', async () => {
    const e = egressOver(HOME, WORLD);
    const { deps } = markDeps(item({ houseSlug: WORLD }), e);
    await runPopclawMarkCommand({ positional: [EVENT_ID] }, deps);
    await runPopclawUnmarkCommand({ positional: [EVENT_ID] }, deps);
    expect(e.all()).toEqual({ [HOME]: 0, [WORLD]: 2 });
  });

  it('被标内容不在缓存 / 无标签 → 主坊', async () => {
    const e = egressOver(HOME, WORLD);
    const { deps } = markDeps(item(), e);
    await runPopclawMarkCommand({ positional: [EVENT_ID] }, deps);
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 0 });
  });
});

describe('路由表 · Follow → 发现坊；Revoke → 同一坊', () => {
  function graph(e: ReturnType<typeof egressOver>, houseOf?: (id: string) => string | undefined) {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const sg = new SocialGraph({
      relationProducer: fakeRelationProducer({ db, ...(houseOf ? { houseOf } : {}),
        egressPush: async (bytes, slug) => { await e.egress.pushTo(slug, bytes); } }).producer,
      db,
      signer: makeTestSigner('BlackFeather'),
      egressPush: async (bytes, slug) => { await e.egress.pushTo(slug, bytes); },
      ...(houseOf ? { houseOf } : {}),
    });
    return { db, sg };
  }

  it('FollowDeclared 落发现他的那座坊，并把坊记进 follow_events', async () => {
    const e = egressOver(HOME, WORLD);
    const { db, sg } = graph(e, () => WORLD);
    await sg.start();
    await sg.declareFollow('BBB');
    expect(e.all()).toEqual({ [HOME]: 0, [WORLD]: 1 });
    const rows = db.queryAll<{ house_slug: string }>('SELECT house_slug FROM follow_events ORDER BY id');
    expect(rows[0]!.house_slug).toBe(WORLD);
  });

  it('FollowRevoked 回当初 declare 的坊 —— 即便他现在只在主坊露面', async () => {
    const e = egressOver(HOME, WORLD);
    let discovered: string | undefined = WORLD;
    const { db, sg } = graph(e, () => discovered);
    await sg.start();
    await sg.declareFollow('BBB');
    discovered = HOME; // 缓存变了：他后来在主坊也发过帖
    await sg.revokeFollow('BBB');
    expect(e.all()).toEqual({ [HOME]: 0, [WORLD]: 2 });
    const rows = db.queryAll<{ type: string; house_slug: string }>('SELECT type, house_slug FROM follow_events ORDER BY id');
    expect(rows.map((r) => r.house_slug)).toEqual([WORLD, WORLD]);
  });

  it('来源不可考（houseOf 不注入 / 返回 undefined）→ 主坊，house_slug 存空串', async () => {
    const e = egressOver(HOME, WORLD);
    const { db, sg } = graph(e);
    await sg.start();
    await sg.declareFollow('BBB');
    await sg.revokeFollow('BBB');
    expect(e.all()).toEqual({ [HOME]: 2, [WORLD]: 0 });
    const rows = db.queryAll<{ house_slug: string }>('SELECT house_slug FROM follow_events ORDER BY id');
    expect(rows.map((r) => r.house_slug)).toEqual(['', '']);
  });

  it('存量旧行（house_slug 空）取关 → 主坊，不炸', async () => {
    const e = egressOver(HOME, WORLD);
    const { db, sg } = graph(e, () => WORLD);
    // 手写一条"迁移前"的 declare（不带坊）。
    db.execute(
      `INSERT INTO follow_events (type, followee, follow_type, taste_subscribed, timestamp, signature)
       VALUES ('FollowDeclared', 'OLD', 'PUBLIC', 0, 1, '')`,
    );
    await sg.start();
    await sg.revokeFollow('OLD');
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 0 });
  });
});

describe('路由表 · DM → 来信那座坊（切片④）', () => {
  const RECIPIENT = '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM'; // Scout fixture

  function inbox(rows: Array<{ from: string; ts: number; house: string }>) {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const store = new InboxStore(db);
    for (const r of rows) {
      store.record({ ts: r.ts, fromPopclawId: r.from, toPopclawId: 'me', body: `b${r.ts}`, receivedAtMs: r.ts, houseSlug: r.house });
    }
    return store;
  }

  it('回信落他来信的那座坊', async () => {
    const e = egressOver(HOME, WORLD);
    const store = inbox([{ from: RECIPIENT, ts: 1, house: WORLD }]);
    const out = await runPopclawMessageCommand(
      { positional: [RECIPIENT, 'hey'] },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather', houseOfRecipient: (id) => store.houseOf(id) },
    );
    expect(out.text).toContain('sent DM');
    expect(e.all()).toEqual({ [HOME]: 0, [WORLD]: 1 });
  });

  it('全新会话（本地无来信记录）→ 主坊（跨坊主动开聊是二期）', async () => {
    const e = egressOver(HOME, WORLD);
    const store = inbox([]);
    await runPopclawMessageCommand(
      { positional: [RECIPIENT, 'hey'] },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather', houseOfRecipient: (id) => store.houseOf(id) },
    );
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 0 });
  });

  it('存量旧行（house_slug 空串）→ 主坊', async () => {
    const e = egressOver(HOME, WORLD);
    const store = inbox([{ from: RECIPIENT, ts: 1, house: '' }]);
    await runPopclawMessageCommand(
      { positional: [RECIPIENT, 'hey'] },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather', houseOfRecipient: (id) => store.houseOf(id) },
    );
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 0 });
  });

  it('houseOfRecipient 不注入（老调用点）→ 主坊，行为不变', async () => {
    const e = egressOver(HOME, WORLD);
    await runPopclawMessageCommand(
      { positional: [RECIPIENT, 'hey'] },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather' },
    );
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 0 });
  });

  it('收件人校验问的是目标坊，不是主坊', async () => {
    const e = egressOver(HOME, WORLD);
    const store = inbox([{ from: RECIPIENT, ts: 1, house: WORLD }]);
    const verifyRecipient = vi.fn(async () => ({ status: 'verified' as const, nickname: 'Scout', sigil: 's' }));
    await runPopclawMessageCommand(
      { positional: [RECIPIENT, 'hey'] },
      { signer: makeTestSigner('BlackFeather'), egress: e.egress, nickname: 'BlackFeather', verifyRecipient, houseOfRecipient: (id) => store.houseOf(id) },
    );
    expect(verifyRecipient).toHaveBeenCalledWith(RECIPIENT, WORLD);
  });
});

describe('路由表 · Profile 名片 → 广播所有坊', () => {
  it('/popclaw name 每坊各推一次', async () => {
    const e = egressOver(HOME, WORLD);
    const host = new InMemoryHostAdapter();
    const out = await runPopclawNameCommand(
      { nickname: '青鸾' },
      {
        host,
        signer: makeTestSigner('BlackFeather'),
        egress: e.egress,
        popclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
        clock: { now: () => new Date('2026-07-26T00:00:00Z') },
        houseOrigins: [],
        fetch: cleanProfileFetch,
      },
    );
    expect(out.text).toContain('青鸾');
    expect(e.all()).toEqual({ [HOME]: 1, [WORLD]: 1 });
    expect(cleanProfileFetch.mock.calls.map(([input]) => new URL(String(input)).origin))
      .toEqual([`https://${HOME}.invalid`, `https://${WORLD}.invalid`]);
  });
});

describe('single-house routing for explicitly known targets', () => {
  it('post / reply / mark / follow / 名片 全部落同一坊', async () => {
    const e = egressOver(HOME);
    const signer = makeTestSigner('BlackFeather');

    await runPopclawPostCommand(
      { positional: ['原创'], flags: {} },
      { signer, egress: e.egress, nickname: 'BlackFeather', cache: cacheOf(null), webBaseUrl: 'http://localhost:3000' },
    );
    // Known home targets retain single-house behavior; unknown targets reject.
    await runPopclawReplyCommand(
      { positional: ['1234567890', 'hi'] },
      { signer, egress: e.egress, cache: cacheOf(item({ houseSlug: HOME })), nickname: 'BlackFeather' },
    );
    const store = marksStore();
    const markService = new MarkService({ store, signer, egress: e.egress, nickname: 'BlackFeather', taste: tasteRoot() });
    await runPopclawMarkCommand({ positional: [EVENT_ID] }, { cache: cacheOf(item({ houseSlug: HOME })), markService });

    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const sg = new SocialGraph({
      relationProducer: fakeRelationProducer({ db, houseOf: () => HOME,
        egressPush: async (bytes, slug) => { await e.egress.pushTo(slug, bytes); } }).producer,
      db, signer,
      egressPush: async (bytes, slug) => { await e.egress.pushTo(slug, bytes); },
      houseOf: () => HOME,
    });
    await sg.start();
    await sg.declareFollow('BBB');

    await runPopclawNameCommand(
      { nickname: '青鸾' },
      { host: new InMemoryHostAdapter(), signer, egress: e.egress, popclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM', clock: { now: () => new Date('2026-07-26T00:00:00Z') }, houseOrigins: [], fetch: cleanProfileFetch },
    );

    expect(e.at(HOME)).toBe(5);
  });
});
