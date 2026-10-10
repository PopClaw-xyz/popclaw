/**
 * Follower notifications (spec 2026-07-27, slices 2 and 3).
 *
 * Pin two invariants: the first run builds a baseline without notifying, so existing followers do
 * not cause a flood; the relative-value gate explicitly exempts followed_you because new followers
 * are necessarily outside the graph and would otherwise all be suppressed.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { runMigrations } from '../../../src/host/migrations';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier';
import {
  KnownFollowersStore,
  syncFollowers,
  syncFollowersOnce,
  renderFollowedYou,
  type FollowerSyncDeps,
} from '../../../src/social-graph/followers-sync';
import { grantingReadAuthorityFor } from '../../helpers/read-authority.js';
import { deriveSigil } from '../../../src/invite/sigil';
import { BOND_CONTEXT_PREFIX } from '../../../src/bonds/bond-context';
import { setOwnerLang } from '../../../src/lexicon/owner-language';

// S13 slice: renderFollowedYou now renders in `ownerLang()` (default en-US)
// instead of hardcoded zh — pin zh-CN so the existing assertions stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const ME = 'ownerId';
const HOUSE = { slug: 'popclaw.me', baseUrl: 'https://me.example' };
const WORLD = { slug: 'popclaw.world', baseUrl: 'https://world.example' };

/**
 * A follower list per baseUrl; unlisted houses return 500.
 */
function fakeFetch(byBaseUrl: Record<string, string[]>): typeof globalThis.fetch {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    const hit = Object.entries(byBaseUrl).find(([base]) => url.startsWith(base));
    if (!hit) return { ok: false, status: 500, json: async () => [] } as unknown as Response;
    return {
      ok: true,
      status: 200,
      json: async () => hit[1].map((popclaw_id) => ({ popclaw_id, taste_subscribed: false, since: 1 })),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
}

function harness(followers: Record<string, string[]>, over: Partial<FollowerSyncDeps> = {}) {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS);
  const notifier = new SqliteNotifier(db, () => 1000);
  // #221 removed the direct-push leg. The spy stays: it is the witness that
  // nothing re-attaches a second leg behind the L2 handoff's back.
  const deliver = vi.fn<(text: string) => Promise<boolean>>(async () => true);
  const logged: { kind: string; id?: string }[] = [];
  const deps: FollowerSyncDeps = {
    ownerPopclawId: ME,
    store: new KnownFollowersStore(db, () => 1000),
    notifier,
    socialGraph: { following: () => [] },   // The owner follows nobody, so a new follower is necessarily outside the graph.
    socialLog: { record: (e) => logged.push({ kind: e.kind, id: e.actor?.id }) },
    displayName: (id) => (id === 'fanA' ? '甲' : ''),
    fetch: fakeFetch(followers),
    ...over,
    // After the spread, because `Partial<FollowerSyncDeps>` makes every key
    // optional and an absent one would otherwise widen this to `undefined`.
    readAuthorityFor: over.readAuthorityFor ?? grantingReadAuthorityFor,
  };
  return { db, deps, notifier, deliver, logged };
}

describe('已知粉丝集 + diff 补漏', () => {
  it('首次运行只建基线不通知（存量粉丝不当新粉刷屏）', async () => {
    const { deps, notifier, deliver } = harness({ [HOUSE.baseUrl]: ['fanA', 'fanB'] });

    const n = await syncFollowers(deps, [HOUSE]);

    expect(n).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(notifier.count('L2')).toBe(0);
    // The baseline was still built, allowing the next round to identify newcomers.
    expect(deps.store.list(HOUSE.slug).sort()).toEqual(['fanA', 'fanB']);
    expect(deps.store.hasBaseline(HOUSE.slug)).toBe(true);
  });

  it('第二轮的新增者才是新粉 → L2 followed_you + 一条带坊标签的消息', async () => {
    const followers: Record<string, string[]> = { [HOUSE.baseUrl]: ['fanA'] };
    const { deps, notifier, deliver, logged } = harness(followers);
    await syncFollowers(deps, [HOUSE]);           // Baseline.

    followers[HOUSE.baseUrl] = ['fanA', 'fanNew'];
    const n = await syncFollowers(deps, [HOUSE]);

    expect(n).toBe(1);
    const items = notifier.drain('L2');
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe('followed_you');
    expect(items[0]!.payload).toMatchObject({ followerPopclawId: 'fanNew', houseSlug: 'popclaw.me' });
    // #221: the sync no longer pushes. It never cleared the row it had just
    // delivered, so a second leg would have made every new follower arrive
    // twice — once pushed here, once relayed on the owner's next turn. The
    // queue row above IS the delivery now; the L2 handoff leg carries it.
    expect(deliver).not.toHaveBeenCalled();
    // social-log also records this passive event.
    expect(logged).toContainEqual({ kind: 'followed_you', id: 'fanNew' });
  });

  it('闸对 followed_you 显式豁免：新粉圈外照样通知', async () => {
    const followers: Record<string, string[]> = { [HOUSE.baseUrl]: [] };
    // socialGraph.following() is always empty, so the new follower is outside the union of bond book and follows.
    const { deps, notifier } = harness(followers);
    await syncFollowers(deps, [HOUSE]);

    followers[HOUSE.baseUrl] = ['totalStranger'];
    await syncFollowers(deps, [HOUSE]);

    expect(notifier.count('L2')).toBe(1);
  });

  it('取关静默：只更新本地集，不通知', async () => {
    const followers: Record<string, string[]> = { [HOUSE.baseUrl]: ['fanA', 'fanB'] };
    const { deps, notifier, deliver } = harness(followers);
    await syncFollowers(deps, [HOUSE]);

    followers[HOUSE.baseUrl] = ['fanA'];
    const n = await syncFollowers(deps, [HOUSE]);

    expect(n).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(notifier.count('L2')).toBe(0);
    expect(deps.store.list(HOUSE.slug)).toEqual(['fanA']);
  });

  it('拉不动的坊不清空本地集、不误报（网络故障 ≠ 全员取关）', async () => {
    const followers: Record<string, string[]> = { [HOUSE.baseUrl]: ['fanA'] };
    const { deps } = harness(followers);
    await syncFollowers(deps, [HOUSE]);

    delete followers[HOUSE.baseUrl];             // House returns 500.
    await expect(syncFollowersOnce(deps, HOUSE)).rejects.toThrow();
    expect(deps.store.list(HOUSE.slug)).toEqual(['fanA']);
  });

  it('某坊失联不拖垮其他坊', async () => {
    const followers: Record<string, string[]> = { [WORLD.baseUrl]: [] };
    const { deps } = harness(followers);
    await syncFollowers(deps, [HOUSE, WORLD]);   // me house returns 500; world house builds its baseline.

    followers[WORLD.baseUrl] = ['fanA'];
    const n = await syncFollowers(deps, [HOUSE, WORLD]);
    expect(n).toBe(1);
  });

  // If the nickname is unavailable, fall back to the sigil, not an ID prefix. Two strangers both rendered as @unknownP
  // are indistinguishable to the owner, while sigils distinguish them naturally.
  it('多坊按坊分组渲染，名号查不到只报印信', () => {
    const { deps } = harness({});
    const text = renderFollowedYou(deps, [
      { houseSlug: 'popclaw.me', followerId: 'fanA' },
      { houseSlug: 'popclaw.world', followerId: 'unknownPerson999' },
      { houseSlug: 'popclaw.me', followerId: 'unknownPerson888' },
    ]);
    expect(text).toBe(
      `💗 popclaw.me：甲#${deriveSigil('fanA')}、#${deriveSigil('unknownPerson888')} 关注了你（2 人）\n` +
      `💗 popclaw.world：#${deriveSigil('unknownPerson999')} 关注了你`,
    );
    expect(text).not.toContain('unknownP');
  });

  // Bond context (2026-07-29): if an acquaintance follows back, tell the owner who it is. Most new followers
  // are strangers; fabricating a context line for them creates noise every 30 minutes.
  it('新粉在交情本里有内容 → 各带一行「他在你的交情本里：…」', () => {
    const { deps } = harness(
      {},
      { bondContext: (id) => (id === 'fanA' ? '　 ↳ 好友 · 3 天前他给你来过信' : '') },
    );
    const text = renderFollowedYou(deps, [
      { houseSlug: 'popclaw.me', followerId: 'fanA' },
      { houseSlug: 'popclaw.me', followerId: 'unknownPerson888' },
    ]);
    expect(text).toBe(
      `💗 popclaw.me：甲#${deriveSigil('fanA')}、#${deriveSigil('unknownPerson888')} 关注了你（2 人）\n` +
        `${BOND_CONTEXT_PREFIX}甲#${deriveSigil('fanA')} 在你的交情本里：好友 · 3 天前他给你来过信`,
    );
  });

  it('陌生新粉不带尾行（整行不出，不是空行）', () => {
    const { deps } = harness({}, { bondContext: () => '' });
    const text = renderFollowedYou(deps, [{ houseSlug: 'popclaw.me', followerId: 'unknownX' }]);
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toContain('↳');
  });

  it('没接 bondContext 时渲染逐字不变（存量行为）', () => {
    const { deps } = harness({});
    const text = renderFollowedYou(deps, [{ houseSlug: 'popclaw.me', followerId: 'fanA' }]);
    expect(text).toBe(`💗 popclaw.me：甲#${deriveSigil('fanA')} 关注了你`);
  });

  it('bondLine 烘进 followed_you 的 payload（MCP 那一侧读队列时同样要有）', async () => {
    const followers: Record<string, string[]> = { [HOUSE.baseUrl]: [] };
    const { deps, notifier } = harness(followers, {
      bondContext: (id) => (id === 'fanA' ? '　 ↳ 好友' : ''),
    });
    await syncFollowers(deps, [HOUSE]); // First run builds the baseline.
    followers[HOUSE.baseUrl] = ['fanA', 'strangerB'];
    await syncFollowers(deps, [HOUSE]);
    const queued = notifier.drain('L2');
    const known = queued.find((i) => i.payload['followerPopclawId'] === 'fanA');
    const stranger = queued.find((i) => i.payload['followerPopclawId'] === 'strangerB');
    expect(known?.payload['bondLine']).toBe('　 ↳ 好友');
    expect(stranger?.payload).not.toHaveProperty('bondLine');
  });
});
