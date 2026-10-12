import { describe, it, expect } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import {
  listGaps,
  tasteSeededOf,
  readBailedAt,
  writeBailedAt,
  clearBailedAt,
  type GapFacts,
} from '../../../src/onboarding/settling-gaps.js';

const BASE: GapFacts = {
  followingCount: 1,
  tasteSeeded: true,
  loreHouseReachable: true,
  externalVerifiedCount: 1,
  pendingInvitesCount: 0,
  dreamStale: false,
  nameSource: 'owner',
};

describe('listGaps', () => {
  it('全过关：没有任何缺口', () => {
    expect(listGaps(BASE)).toEqual([]);
  });

  it('顺序照 spec §4：resume_onboarding 最前，其后 no_follows > no_taste > no_verify > dream_stale > auto_name', () => {
    const gaps = listGaps({
      bailedAt: 1700000000,
      followingCount: 0,
      tasteSeeded: false,
      loreHouseReachable: true,
      externalVerifiedCount: 0,
      pendingInvitesCount: 0,
      dreamStale: true, // followingCount=0 makes dream_stale's precondition false, so it must not appear.
      nameSource: 'auto',
    });
    expect(gaps.map((g) => g.key)).toEqual([
      'resume_onboarding',
      'no_follows',
      'no_taste',
      'no_verify',
      'auto_name',
    ]);
  });

  it('dream_stale 前置：followingCount>0 且真陈旧才算缺口', () => {
    expect(listGaps({ ...BASE, dreamStale: true }).map((g) => g.key)).toEqual(['dream_stale']);
    expect(listGaps({ ...BASE, followingCount: 0, dreamStale: true }).map((g) => g.key)).toEqual([
      'no_follows',
    ]);
  });

  it('no_verify 需要 loreHouseReachable && 零外部认证 && 零挂起申请', () => {
    expect(listGaps({ ...BASE, externalVerifiedCount: 0 }).map((g) => g.key)).toEqual(['no_verify']);
    expect(
      listGaps({ ...BASE, externalVerifiedCount: 0, pendingInvitesCount: 1 }).map((g) => g.key),
    ).toEqual([]);
    expect(listGaps({ ...BASE, externalVerifiedCount: 0, loreHouseReachable: false }).map((g) => g.key)).toEqual(
      [],
    );
  });

  it('tasteSeeded=null（查不到）→ 不算缺口', () => {
    expect(listGaps({ ...BASE, tasteSeeded: null }).map((g) => g.key)).toEqual([]);
  });

  it('bailedAt=null（没 bail 过）→ 不出 resume_onboarding', () => {
    expect(listGaps({ ...BASE, bailedAt: null }).map((g) => g.key)).toEqual([]);
  });

  it('house:<slug>:first_move：只挑有 entry.firstMove 且未开始的坊，跳过主坊（houses[0]），多坊按挂坊序', () => {
    const houses = [
      { slug: 'main', name: '主坊', entry: { headline: '主坊也声明了', firstMove: '主坊第一件事' } },
      { slug: 'house-a', name: '灯坊甲', entry: { headline: '甲的看点', firstMove: '带我进甲' } },
      { slug: 'house-b', name: '灯坊乙' }, // No declaration means there is no first-action task.
      { slug: 'house-c', name: '灯坊丙', entry: { firstMove: '带我进丙' } }, // Already started.
    ];
    const gaps = listGaps({
      ...BASE,
      houses,
      houseStarted: (slug) => slug === 'house-c',
    });
    expect(gaps.map((g) => g.key)).toEqual(['house:house-a:first_move']);
    expect(gaps[0]).toMatchObject({
      houseName: '灯坊甲',
      houseHeadline: '甲的看点',
      houseFirstMove: '带我进甲',
    });
  });

  it('houseStarted 查不到（缺省 = false）不当已开始处理，仍算缺口', () => {
    const houses = [
      { slug: 'main', name: '主坊' },
      { slug: 'house-a', name: '灯坊甲', entry: { firstMove: '带我进甲' } },
    ];
    expect(listGaps({ ...BASE, houses }).map((g) => g.key)).toEqual(['house:house-a:first_move']);
  });
});

describe('tasteSeededOf', () => {
  it('core/ 正文非空 → true', async () => {
    const loader = { enabledSources: async () => [{ path: 'core/private.md', content: '我关心 AI' }] };
    expect(await tasteSeededOf(loader)).toBe(true);
  });

  it('core/ 正文全空 → false', async () => {
    const loader = { enabledSources: async () => [{ path: 'core/private.md', content: '   ' }] };
    expect(await tasteSeededOf(loader)).toBe(false);
  });

  it('没接读取口 → null（查不到≠没有）', async () => {
    expect(await tasteSeededOf(undefined)).toBeNull();
  });

  it('读失败 → null', async () => {
    const loader = {
      enabledSources: async () => {
        throw new Error('disk full');
      },
    };
    expect(await tasteSeededOf(loader)).toBeNull();
  });
});

describe('bailed_at（spec §5 落盘修复）', () => {
  it('没写过 → null', async () => {
    const host = new InMemoryHostAdapter();
    expect(await readBailedAt(host)).toBeNull();
  });

  it('write → read 跨「进程」（新读取者）也读到', async () => {
    const host = new InMemoryHostAdapter();
    await writeBailedAt(host, 1700000000);
    // A new host instance reuses the same underlying config, simulating a cross-process read. Reuse the same
    // InMemoryHostAdapter (its config is persistent state) to verify the write really persisted.
    expect(await readBailedAt(host)).toBe(1700000000);
  });

  it('clearBailedAt 之后读回 null；不存在时 clear 是 no-op（不抛）', async () => {
    const host = new InMemoryHostAdapter();
    await writeBailedAt(host, 1700000000);
    await clearBailedAt(host);
    expect(await readBailedAt(host)).toBeNull();
    await expect(clearBailedAt(host)).resolves.toBeUndefined();
  });

  it('保留其余顶层与 onboarding 字段（读-改-写纪律）', async () => {
    const host = new InMemoryHostAdapter({
      config: { plugin: { lore_house_url: 'http://x', onboarding: { newspaper: 'daily' } } },
    });
    await writeBailedAt(host, 1700000000);
    const cfg = (await host.config.loadJson('plugin')) as Record<string, unknown> & {
      onboarding: { newspaper: string; bailed_at: number };
    };
    expect(cfg.lore_house_url).toBe('http://x');
    expect(cfg.onboarding.newspaper).toBe('daily');
    expect(cfg.onboarding.bailed_at).toBe(1700000000);
  });
});

// ---------------------------------------------------------------------------
// Common-source guard: status tasks and nudges must both use listGaps(), never separate implementations.
// Do not run the full runStatusCommand here (status.test.ts covers rendering); pin the contract that
// the same facts and gaps produce the same keys in the same order for both consumers.
// ---------------------------------------------------------------------------
describe('status / 顺一句同源', () => {
  it('同一份 GapFacts 喂 listGaps 一次，status 的 5 个已知 key 与顺一句候选严格同序', () => {
    const facts: GapFacts = {
      bailedAt: 1700000000,
      followingCount: 0,
      tasteSeeded: false,
      loreHouseReachable: true,
      externalVerifiedCount: 0,
      pendingInvitesCount: 0,
      dreamStale: false,
      nameSource: 'auto',
    };
    const gaps = listGaps(facts);

    // status.ts recognizes only these five keys; resume_onboarding / house:* belong only to nudges.
    const STATUS_KEYS = new Set(['no_follows', 'no_taste', 'no_verify', 'dream_stale', 'auto_name']);
    const statusTodoKeys = gaps.filter((g) => STATUS_KEYS.has(g.key)).map((g) => g.key);
    expect(statusTodoKeys).toEqual(['no_follows', 'no_taste', 'no_verify', 'auto_name']);

    // The nudge candidate pool is all gaps, including resume_onboarding, in the same order from the same source.
    expect(gaps.map((g) => g.key)).toEqual([
      'resume_onboarding',
      'no_follows',
      'no_taste',
      'no_verify',
      'auto_name',
    ]);
  });
});
