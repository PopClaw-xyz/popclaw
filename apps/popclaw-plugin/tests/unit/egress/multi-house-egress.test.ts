import { describe, it, expect, vi } from 'vitest';
import { MultiHouseEgress, type HouseEgress } from '../../../src/egress/multi-house-egress.js';
import { pushRouted, broadcastAll, type PushResult } from '../../../src/egress/event-egress.js';

const bytes = new Uint8Array([1, 2, 3]);

function house(slug: string, impl?: () => Promise<PushResult>): HouseEgress & { push: ReturnType<typeof vi.fn> } {
  const push = vi.fn(impl ?? (async () => ({ status: 200 })));
  return { slug, egress: { push }, push } as never;
}

describe('MultiHouseEgress', () => {
  it('push() 默认落主坊（[0]），副坊一个字节都不收', async () => {
    const home = house('popclaw-me');
    const world = house('popclaw-world');
    const e = new MultiHouseEgress([home, world]);
    await e.push(bytes);
    expect(home.push).toHaveBeenCalledTimes(1);
    expect(world.push).not.toHaveBeenCalled();
  });

  it('pushTo(已知 slug) 落那座坊', async () => {
    const home = house('popclaw-me');
    const world = house('popclaw-world');
    const e = new MultiHouseEgress([home, world]);
    await e.pushTo('popclaw-world', bytes);
    expect(world.push).toHaveBeenCalledTimes(1);
    expect(home.push).not.toHaveBeenCalled();
  });

  it('pushTo(undefined) 落主坊 + 一行 debug', async () => {
    const home = house('popclaw-me');
    const world = house('popclaw-world');
    const debug = vi.fn();
    const e = new MultiHouseEgress([home, world], { debug });
    await e.pushTo(undefined, bytes);
    expect(home.push).toHaveBeenCalledTimes(1);
    expect(world.push).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown targets without sending to home', async () => {
    const home = house('popclaw-me');
    const e = new MultiHouseEgress([home]);
    await expect(e.pushTo('some-other-house', bytes)).rejects.toThrow('INVALID_HOUSE');
    await expect(e.pushTo('', bytes)).rejects.toThrow('INVALID_HOUSE');
    expect(home.push).not.toHaveBeenCalled();
  });

  it('disabled home is never replaced by another house, including broadcast receipts', async () => {
    const home = { ...house('home'), isEnabled: () => false };
    const other = house('other');
    const e = new MultiHouseEgress([home, other]);
    await expect(e.push(bytes)).rejects.toThrow('HOUSE_DISABLED');
    await expect(e.pushTo('home', bytes)).rejects.toThrow('HOUSE_DISABLED');
    await expect(e.broadcast(bytes)).rejects.toThrow('HOUSE_DISABLED');
    expect(home.push).not.toHaveBeenCalled();
    expect(other.push).toHaveBeenCalledTimes(1);
  });

  it('broadcast reports disabled houses without sending and keeps configured receipt order', async () => {
    let enabled = true;
    const home = house('home');
    const other = { ...house('other'), isEnabled: () => enabled };
    const e = new MultiHouseEgress([home, other]);
    enabled = false;
    const receipts = await e.broadcastEach(bytes);
    expect(receipts.map(r => r.slug)).toEqual(['home', 'other']);
    expect(receipts[0]!.result?.status).toBe(200);
    expect(String(receipts[1]!.error)).toContain('HOUSE_DISABLED');
    expect(other.push).not.toHaveBeenCalled();
  });

  it('broadcast() 每坊各推一次，回执取主坊那份', async () => {
    const home = house('popclaw-me', async () => ({ status: 200, eventId: 'home-evt' }));
    const world = house('popclaw-world', async () => ({ status: 200, eventId: 'world-evt' }));
    const e = new MultiHouseEgress([home, world]);
    const r = await e.broadcast(bytes);
    expect(home.push).toHaveBeenCalledTimes(1);
    expect(world.push).toHaveBeenCalledTimes(1);
    expect(r.eventId).toBe('home-evt');
  });

  it('broadcast() 副坊失败只记告警，主坊回执照常返回（副坊 best-effort）', async () => {
    const home = house('popclaw-me');
    const world = house('popclaw-world', async () => { throw new Error('ECONNREFUSED'); });
    const warn = vi.fn();
    const e = new MultiHouseEgress([home, world], { warn });
    const r = await e.broadcast(bytes);
    expect(r.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('popclaw-world');
  });

  it('broadcast() 主坊挂了 → 抛主坊的错，哪怕副坊成功（主坊是身份锚地）', async () => {
    const home = house('popclaw-me', async () => { throw new Error('home-down'); });
    const world = house('popclaw-world', async () => ({ status: 202, eventId: 'w' }));
    const e = new MultiHouseEgress([home, world], { warn: vi.fn() });
    await expect(e.broadcast(bytes)).rejects.toThrow('home-down');
    // Still push to secondary houses: best effort must not skip them when the primary house is down.
    expect(world.push).toHaveBeenCalledTimes(1);
  });

  it('broadcast() 副坊非 2xx 记告警但不失败', async () => {
    const home = house('popclaw-me');
    const world = house('popclaw-world', async () => ({ status: 409 }));
    const warn = vi.fn();
    const e = new MultiHouseEgress([home, world], { warn });
    const r = await e.broadcast(bytes);
    expect(r.status).toBe(200);
    expect(warn.mock.calls[0]![0]).toContain('409');
  });

  it('single-house sends only to known or implicit home', async () => {
    const only = house('localhost-8080');
    const e = new MultiHouseEgress([only]);
    await e.push(bytes);
    await e.pushTo('localhost-8080', bytes);
    await e.pushTo(undefined, bytes);
    await e.broadcast(bytes);
    expect(only.push).toHaveBeenCalledTimes(4);
  });

  it('fromUrls 按 host-slug 派生 slug，[0] 是主坊', () => {
    const e = MultiHouseEgress.fromUrls(['https://popclaw.me', 'https://popclaw.world']);
    expect(e.slugs()).toEqual(['popclaw-me', 'popclaw-world']);
    expect(e.home.slug).toBe('popclaw-me');
  });

  it('零座坊直接抛（配置校验早就拦住了，这是最后一道）', () => {
    expect(() => new MultiHouseEgress([])).toThrow(/at least one/);
  });
});

describe('pushRouted / broadcastAll 对单坊实现的兼容', () => {
  it('实现没有 pushTo/broadcast（ServerPushEgress 形状）→ 退回 push', async () => {
    const push = vi.fn(async () => ({ status: 200 }));
    await pushRouted({ push }, 'popclaw-world', bytes);
    await broadcastAll({ push }, bytes);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('实现有 pushTo/broadcast → 用它们', async () => {
    const push = vi.fn(async () => ({ status: 200 }));
    const pushTo = vi.fn(async () => ({ status: 200 }));
    const broadcast = vi.fn(async () => ({ status: 200 }));
    await pushRouted({ push, pushTo }, 'popclaw-world', bytes);
    await broadcastAll({ push, broadcast }, bytes);
    expect(pushTo).toHaveBeenCalledWith('popclaw-world', bytes);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
