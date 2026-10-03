/**
 * 待回（Pings）· 回我帖 — spec docs/superpowers/specs/2026-07-25-pings-replies-to-me-design.md
 * 刀① 地板（查得到） + 刀② 感知（入队 / 首回 / 未读）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { deriveSigil } from '../../../src/invite/sigil';
import { makeCache, bytesOf, item } from '../../helpers/world-feed-cache';
import type { WorldFeedCache } from '../../../src/ingress/world-feed-cache';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { runMigrations } from '../../../src/host/migrations';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier';
import { setOwnerLang } from '../../../src/lexicon/owner-language';
import {
  ReplyPingsStore,
  routeReplyPing,
  collectPings,
  renderPings,
  type PingMaterial,
} from '../../../src/pings/reply-pings';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

// S3 rollout slice 2: renderPings now renders in `ownerLang()` (S1
// process-wide singleton). Pin zh-CN so this file's pre-lexicon assertions
// stay byte-for-byte unchanged (same fix as status.test.ts / popclaw-feed.test.ts).
// The dedicated en-lane tests below pass `lang: 'en'` explicitly.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const OWNER = 'ownerPid';

function makeStores() {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return { db, pings: new ReplyPingsStore(db, () => 1000), notifier: new SqliteNotifier(db, () => 1000) };
}

/** A popclaw-native post/reply as it arrives on the world-feed stream. */
function wfi(over: Partial<popclaw.event.IWorldFeedItem>): popclaw.event.IWorldFeedItem {
  return item({ platform: 'popclaw', ...over });
}

function rec(cache: WorldFeedCache, over: Partial<popclaw.event.IWorldFeedItem>) {
  const i = wfi(over);
  cache.record(i, bytesOf(i), 1);
  return i;
}

// ---------------------------------------------------------------------------
// 刀① — WorldFeedCache.repliesToOwner
// ---------------------------------------------------------------------------

describe('WorldFeedCache.repliesToOwner', () => {
  it('counts replies to my post', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'other',
      textPreview: '接一句',
      replyToPostId: 'mine',
    });
    const got = cache.repliesToOwner(OWNER, 50);
    expect(got).toHaveLength(1);
    expect(got[0]!.reply.platformPostId).toBe('r1');
    expect(got[0]!.targetPreview).toBe('我的帖');
  });

  it('counts replies to MY REPLY (my 发言 = post + my replies)', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'theirs', authorPopclawId: 'other', textPreview: '别人的帖' });
    rec(cache, {
      platformPostId: 'myreply',
      authorPopclawId: OWNER,
      textPreview: '我的回复',
      replyToPostId: 'theirs',
    });
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'other',
      textPreview: '回我的回复',
      replyToPostId: 'myreply',
    });
    const got = cache.repliesToOwner(OWNER, 50);
    expect(got.map((g) => g.reply.platformPostId)).toEqual(['r1']);
  });

  it('does NOT count replies to someone else’s post', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'theirs', authorPopclawId: 'other', textPreview: '别人的帖' });
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'third',
      textPreview: '回别人',
      replyToPostId: 'theirs',
    });
    expect(cache.repliesToOwner(OWNER, 50)).toEqual([]);
  });

  it('does NOT count me replying to myself', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: OWNER,
      textPreview: '自己补一句',
      replyToPostId: 'mine',
    });
    expect(cache.repliesToOwner(OWNER, 50)).toEqual([]);
  });

  it('never filters on reply_to_author_popclaw_id (empty on live tail — spec §12)', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    // live tail: reply_to_author_popclaw_id 永远是空字符串
    rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'other',
      textPreview: '接一句',
      replyToPostId: 'mine',
      replyToAuthorPopclawId: '',
    });
    expect(cache.repliesToOwner(OWNER, 50)).toHaveLength(1);
  });

  it('newest first, so a cap never drops the freshest reply', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    for (const [id, ts] of [['old', 100], ['mid', 200], ['new', 300]] as const) {
      rec(cache, {
        platformPostId: id,
        authorPopclawId: 'other',
        replyToPostId: 'mine',
        platformPostCreatedAt: ts,
      });
    }
    expect(cache.repliesToOwner(OWNER, 2).map((g) => g.reply.platformPostId)).toEqual([
      'new',
      'mid',
    ]);
  });

  it('joins on the FULL primary key — a forged platform cannot hit my mirror row', async () => {
    const { cache } = await makeCache();
    // 主人在 X 上的镜像帖，id "111"
    rec(cache, {
      platform: 'x',
      platformPostId: '111',
      authorPopclawId: OWNER,
      textPreview: '我的 X 镜像帖',
    });
    // 别人在 tiktok 上一条同 id 的帖 + 一条回它的回复；回复者可以随便写 platform
    rec(cache, { platform: 'tiktok', platformPostId: '111', authorPopclawId: 'other' });
    rec(cache, {
      platform: 'popclaw',
      platformPostId: 'forged',
      authorPopclawId: 'attacker',
      replyToPlatform: 'tiktok',
      replyToPostId: '111',
    });
    expect(cache.repliesToOwner(OWNER, 50)).toEqual([]);
    // …而如实指向主人那条 X 镜像帖的回复照常命中
    rec(cache, {
      platform: 'popclaw',
      platformPostId: 'real',
      authorPopclawId: 'friend',
      replyToPlatform: 'x',
      replyToPostId: '111',
    });
    expect(cache.repliesToOwner(OWNER, 50).map((g) => g.reply.platformPostId)).toEqual(['real']);
  });
});

// ---------------------------------------------------------------------------
// 刀② — 入队路由 / 首回 / 幂等
// ---------------------------------------------------------------------------

/** helpers/world-feed-cache 的默认发帖时间；把"现在"钉在同一刻 = 回复是新鲜的。 */
const NOW = 1_700_000_000;

describe('routeReplyPing', () => {
  async function setup(now: () => number = () => NOW) {
    const { cache } = await makeCache();
    const s = makeStores();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    const deps = { ownerPopclawId: OWNER, cache, pings: s.pings, notifier: s.notifier, now };
    return { cache, deps, ...s };
  }

  it('first reply → L1, later replies → L2', async () => {
    const { cache, deps, notifier } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    const b = rec(cache, { platformPostId: 'r2', authorPopclawId: 'b', replyToPostId: 'mine' });
    expect(routeReplyPing(deps, a)).toBe('first');
    expect(routeReplyPing(deps, b)).toBe('more');
    expect(notifier.count('L1')).toBe(1);
    expect(notifier.count('L2')).toBe(1);
  });

  it('same reply delivered twice does not enqueue twice (idempotent)', async () => {
    const { cache, deps, notifier } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    expect(routeReplyPing(deps, a)).toBe('first');
    expect(routeReplyPing(deps, a)).toBe('duplicate');
    expect(notifier.count()).toBe(1);
  });

  it('首回 is judged once per 发言 — a redelivered first reply never re-fires L1', async () => {
    const { cache, deps, notifier } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    const b = rec(cache, { platformPostId: 'r2', authorPopclawId: 'b', replyToPostId: 'mine' });
    routeReplyPing(deps, a);
    routeReplyPing(deps, b);
    routeReplyPing(deps, a); // SSE 重连回补
    routeReplyPing(deps, b);
    expect(notifier.count('L1')).toBe(1);
    expect(notifier.count('L2')).toBe(1);
  });

  it('ignores replies to other people and self-replies', async () => {
    const { cache, deps, notifier } = await setup();
    rec(cache, { platformPostId: 'theirs', authorPopclawId: 'other' });
    const toOther = rec(cache, {
      platformPostId: 'r9',
      authorPopclawId: 'a',
      replyToPostId: 'theirs',
    });
    const mine = rec(cache, {
      platformPostId: 'r8',
      authorPopclawId: OWNER,
      replyToPostId: 'mine',
    });
    const plainPost = rec(cache, { platformPostId: 'p1', authorPopclawId: 'a' });
    expect(routeReplyPing(deps, toOther)).toBe('not-mine');
    expect(routeReplyPing(deps, mine)).toBe('self');
    expect(routeReplyPing(deps, plainPost)).toBe('not-mine');
    expect(notifier.count()).toBe(0);
  });

  // 交情上下文尾行（2026-07-29）：与 fromName 同款，入队时烘进 payload。
  it('bondContext 有话说 → 烘进 payload.bondLine；没话说不带这个 key', async () => {
    const { cache, deps, notifier } = await setup();
    const withCtx = {
      ...deps,
      bondContext: (id: string) => (id === 'laozhang' ? '　 ↳ 好友 · 昨天他给你来过信' : ''),
    };
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'laozhang', replyToPostId: 'mine' });
    const b = rec(cache, { platformPostId: 'r2', authorPopclawId: 'stranger', replyToPostId: 'mine' });
    routeReplyPing(withCtx, a);
    routeReplyPing(withCtx, b);
    expect(notifier.drain('L1')[0]!.payload['bondLine']).toBe('　 ↳ 好友 · 昨天他给你来过信');
    expect(notifier.drain('L2')[0]!.payload).not.toHaveProperty('bondLine');
  });

  it('a stale reply (SSE backfill) still queues, but never at L1', async () => {
    // 首装/重装：limit 5000 的窗口回补，历史上每条回复都是"首回"。
    const { cache, deps, notifier } = await setup(() => NOW + 3600);
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    expect(routeReplyPing(deps, a)).toBe('first-stale');
    expect(notifier.count('L1')).toBe(0);
    expect(notifier.count('L2')).toBe(1);
  });

  it('a reply inside the freshness window still wakes at L1', async () => {
    const { cache, deps, notifier } = await setup(() => NOW + 60);
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    expect(routeReplyPing(deps, a)).toBe('first');
    expect(notifier.count('L1')).toBe(1);
  });

  it('my own self-reply does not burn 首回 — the next person still counts as first', async () => {
    const { cache, deps, notifier, pings } = await setup();
    const selfie = rec(cache, {
      platformPostId: 'r0',
      authorPopclawId: OWNER,
      replyToPostId: 'mine',
    });
    expect(routeReplyPing(deps, selfie)).toBe('self');
    const laoZhang = rec(cache, {
      platformPostId: 'r1',
      authorPopclawId: 'laozhang',
      replyToPostId: 'mine',
    });
    expect(routeReplyPing(deps, laoZhang)).toBe('first');
    expect(notifier.count('L1')).toBe(1);
    expect(pings.unreadCount()).toBe(1); // 自嘲那条不进待回
  });

  it('unread survives until popclaw_show_pings takes the batch (agent 不取则未读不清)', async () => {
    const { cache, deps, pings } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    routeReplyPing(deps, a);
    expect(pings.unreadCount()).toBe(1);
    // agent 看到尾巴却没取 → 未读保留
    expect(pings.unreadCount()).toBe(1);
    expect(pings.markRead(pings.listUnread(10))).toBe(1);
    expect(pings.unreadCount()).toBe(0);
  });

  it('the L1 drain (DM path) does not clear ping unread state', async () => {
    const { cache, deps, pings, notifier } = await setup();
    const a = rec(cache, { platformPostId: 'r1', authorPopclawId: 'a', replyToPostId: 'mine' });
    routeReplyPing(deps, a);
    notifier.drain('L1');
    expect(pings.unreadCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 素材 + 分档渲染（照抄 popclaw_author_latest 一具两档）
// ---------------------------------------------------------------------------

describe('collectPings / renderPings', () => {
  /** cache + 账本 + 已路由的 N 条回复，全部未读。 */
  async function seeded(n: number, over: (i: number) => Partial<popclaw.event.IWorldFeedItem> = () => ({})) {
    const { cache } = await makeCache();
    const s = makeStores();
    rec(cache, { platformPostId: 'mine', authorPopclawId: OWNER, textPreview: '我的帖' });
    const deps = { ownerPopclawId: OWNER, cache, pings: s.pings, notifier: s.notifier, now: () => NOW };
    for (let i = 0; i < n; i++) {
      const r = rec(cache, {
        platformPostId: `r${i}`,
        authorPopclawId: `p${i}`,
        handle: `人${i}`,
        textPreview: `正文${i}`,
        platformPostCreatedAt: NOW + i,
        replyToPostId: 'mine',
        ...over(i),
      });
      routeReplyPing(deps, r);
    }
    return { cache, ...s };
  }

  it('tags every ping with the replier bond tier, unknown → stranger', async () => {
    const { cache, pings } = await seeded(2, (i) => ({
      authorPopclawId: i === 0 ? 'friendPid' : 'nobody',
    }));
    const got = collectPings({
      cache,
      pings,
      ownerPopclawId: OWNER,
      bondOf: (id) => (id === 'friendPid' ? { tier: 'close' as const, remarkName: '' } : null),
    });
    // bond tier 降序 → 时间降序（最新优先）
    expect(got.map((p) => p.replierPopclawId)).toEqual(['friendPid', 'nobody']);
    expect(got[0]!.tier).toBe('close');
    expect(got[1]!.tier).toBe('stranger');
  });

  // renderPings 直接渲染 replierName，所以
  // 无别名、无 handle 的回帖者此前会把裸 id 前缀烤进名字。同一条纪律：上屏
  // 一律「名号#印信」，连不出名字就只报「#印信」。
  it('no alias and no handle → the name falls back to #sigil, never a bare id prefix', async () => {
    const { cache, pings } = await seeded(1, () => ({ authorPopclawId: 'ghostPid', handle: '' }));
    const got = collectPings({ cache, pings, ownerPopclawId: OWNER, bondOf: () => null });
    expect(got).toHaveLength(1);
    expect(got[0]!.replierName).toBe(`#${deriveSigil('ghostPid')}`);
    const rendered = renderPings(got);
    expect(rendered.text).not.toContain('ghostPid'.slice(0, 10));
  });

  it('only unread replies become material; read ones drop out', async () => {
    const { cache, pings } = await seeded(3);
    const all = collectPings({ cache, pings, ownerPopclawId: OWNER, bondOf: () => null });
    expect(all).toHaveLength(3);
    pings.markRead(renderPings(all).shown.map((p) => p.eventId));
    expect(collectPings({ cache, pings, ownerPopclawId: OWNER, bondOf: () => null })).toEqual([]);
  });

  it('a truncated batch keeps the un-shown tail unread (the newest is never lost)', async () => {
    const { cache, pings } = await seeded(130);
    const items = collectPings({ cache, pings, ownerPopclawId: OWNER, bondOf: () => null });
    expect(items).toHaveLength(130);
    const { shown } = renderPings(items);
    expect(shown).toHaveLength(20);
    // 最新的那条必须在被呈现的 20 条里（同档内时间降序）
    expect(shown[0]!.eventId).toBe(items[0]!.eventId);
    expect(pings.markRead(shown.map((p) => p.eventId))).toBe(20);
    expect(pings.unreadCount()).toBe(110); // 剩下的下次继续提示，不是永远消失
  });

  it('≤5 renders full text; >5 switches to the compact timeline', () => {
    const mk = (n: number): PingMaterial[] =>
      Array.from({ length: n }, (_, i) => ({
        eventId: `e${i}`,
        replierPopclawId: `p${i}`,
        replierName: `人${i}`,
        tier: 'stranger' as const,
        body: `第 ${i} 条回复正文`,
        createdAt: 1_700_000_000 + i,
        targetPostId: 'mine',
        targetPreview: '我的帖',
        webUrl: '',
      }));
    const full = renderPings(mk(5));
    const compact = renderPings(mk(6));
    expect(full.text).toContain('回你的：');
    expect(full.shown).toHaveLength(5);
    expect(compact.text).not.toContain('回你的：');
    expect(compact.text).toContain('6 条');
    expect(compact.shown).toHaveLength(6);
  });

  // S3 rollout slice 2 — en lane, same fixtures as the zh-CN case above.
  it('≤5 renders full text; >5 switches to the compact timeline (en lane)', () => {
    const mk = (n: number): PingMaterial[] =>
      Array.from({ length: n }, (_, i) => ({
        eventId: `e${i}`,
        replierPopclawId: `p${i}`,
        replierName: `person${i}`,
        tier: 'stranger' as const,
        body: `reply body ${i}`,
        createdAt: 1_700_000_000 + i,
        targetPostId: 'mine',
        targetPreview: 'my post',
        webUrl: '',
      }));
    const full = renderPings(mk(5), 'en');
    const compact = renderPings(mk(6), 'en');
    expect(full.text).toContain('Replying to yours:');
    expect(full.shown).toHaveLength(5);
    expect(compact.text).not.toContain('Replying to yours:');
    expect(compact.text).toContain('Pending replies (6');
    expect(compact.shown).toHaveLength(6);
  });

  it('>100 shows the first 20 plus an aggregate count', () => {
    const many: PingMaterial[] = Array.from({ length: 130 }, (_, i) => ({
      eventId: `e${i}`,
      replierPopclawId: `p${i}`,
      replierName: `人${i}`,
      tier: 'stranger' as const,
      body: `正文${i}`,
      createdAt: 1_700_000_000 + i,
      targetPostId: 'mine',
      targetPreview: '我的帖',
      webUrl: '',
    }));
    const { text, shown } = renderPings(many);
    expect(text).toContain('人0');
    expect(text).toContain('人19');
    expect(text).not.toContain('人20');
    expect(text).toContain('另有 110 人回复');
    expect(shown).toHaveLength(20);
  });

  // S3 rollout slice 2 — en lane, same fixture as the zh-CN case above.
  it('>100 shows the first 20 plus an aggregate count (en lane)', () => {
    const many: PingMaterial[] = Array.from({ length: 130 }, (_, i) => ({
      eventId: `e${i}`,
      replierPopclawId: `p${i}`,
      replierName: `person${i}`,
      tier: 'stranger' as const,
      body: `body ${i}`,
      createdAt: 1_700_000_000 + i,
      targetPostId: 'mine',
      targetPreview: 'my post',
      webUrl: '',
    }));
    const { text, shown } = renderPings(many, 'en');
    expect(text).toContain('person0');
    expect(text).toContain('person19');
    expect(text).not.toContain('person20');
    expect(text).toContain('110 more people are still waiting');
    expect(shown).toHaveLength(20);
  });

  it('empty → an honest no-pings line', () => {
    expect(renderPings([]).text).toContain('没有');
    expect(renderPings([]).shown).toEqual([]);
  });

  // S3 rollout slice 2 — en lane.
  it('empty → an honest no-pings line (en lane)', () => {
    expect(renderPings([], 'en').text).toContain("Nobody's waiting");
    expect(renderPings([], 'en').shown).toEqual([]);
  });
});
