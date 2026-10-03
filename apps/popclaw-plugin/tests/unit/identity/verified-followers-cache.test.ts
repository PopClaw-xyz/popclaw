import { describe, it, expect, vi } from 'vitest';
import { VerifiedFollowersCache } from '../../../src/identity/verified-followers-cache.js';

const OK = (profiles: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ profiles }),
});

describe('VerifiedFollowersCache', () => {
  it('零网络作答：没预取过就是「不知道」，绝不现场去问', () => {
    const cache = new VerifiedFollowersCache({ loreHouseUrl: 'http://lh', fetch: vi.fn(), now: () => 0 });
    expect(cache.getFresh('SOMEONE')).toBeUndefined();
  });

  it('取各外站认证里最大的那个粉丝数', async () => {
    const fetch = vi.fn(async () =>
      OK([
        { platform: 'github', follower_count: 800 },
        { platform: 'x', follower_count: 120_000 },
      ]),
    );
    const cache = new VerifiedFollowersCache({ loreHouseUrl: 'http://lh', fetch: fetch as never, now: () => 0 });
    await cache.refresh('BIGNAME');
    expect(cache.getFresh('BIGNAME')).toBe(120_000);
  });

  it('灯坊本坊关注数绝不与外站粉丝数相加（profiles.rs 明令）', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ house_follower_count: 999_999, profiles: [{ platform: 'x', follower_count: 5 }] }),
    }));
    const cache = new VerifiedFollowersCache({ loreHouseUrl: 'http://lh', fetch: fetch as never, now: () => 0 });
    await cache.refresh('SMALL');
    expect(cache.getFresh('SMALL')).toBe(5);
  });

  it('查无此人也记下来：陌生人反复来信不该反复打灯坊', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    const cache = new VerifiedFollowersCache({ loreHouseUrl: 'http://lh', fetch: fetch as never, now: () => 0 });
    await cache.refresh('NOBODY');
    await cache.refresh('NOBODY');
    expect(cache.getFresh('NOBODY')).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('灯坊不通不抛，也不写死缓存（下次还能再问）', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const cache = new VerifiedFollowersCache({ loreHouseUrl: 'http://lh', fetch: fetch as never, now: () => 0 });
    await expect(cache.refresh('X')).resolves.toBeUndefined();
    expect(cache.getFresh('X')).toBeUndefined();
  });

  it('过期就当没有：快照会变，七天前的分量说明不了今天', async () => {
    let t = 0;
    const fetch = vi.fn(async () => OK([{ platform: 'x', follower_count: 10 }]));
    const cache = new VerifiedFollowersCache({ loreHouseUrl: 'http://lh', fetch: fetch as never, now: () => t });
    await cache.refresh('P');
    expect(cache.getFresh('P')).toBe(10);
    t = 8 * 24 * 3600 * 1000;
    expect(cache.getFresh('P')).toBeUndefined();
  });
});
