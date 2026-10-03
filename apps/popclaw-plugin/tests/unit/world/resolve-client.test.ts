import { describe, it, expect, vi } from 'vitest';
import { ResolveClient } from '../../../src/world/resolve-client';

function fakeFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

describe('ResolveClient', () => {
  it('maps wire snake_case → camelCase candidates', async () => {
    const fetch = fakeFetch(200, {
      candidates: [
        {
          popclaw_id: 'ID',
          nickname: '苍梧居士',
          sigil: '4f68bd',
          profiles: [{ platform: 'x', handle: 'cangwu', follower_count: 123 }],
        },
      ],
    });
    const c = new ResolveClient({ baseUrl: 'http://h', fetch: fetch as unknown as typeof globalThis.fetch });
    const out = await c.resolve({ sigil: '4f68bd' });
    expect(out).toEqual([
      {
        popclawId: 'ID',
        nickname: '苍梧居士',
        sigil: '4f68bd',
        profiles: [{ platform: 'x', handle: 'cangwu', followerCount: 123 }],
      },
    ]);
    expect(fetch).toHaveBeenCalledWith('http://h/v1/resolve?sigil=4f68bd', {
      signal: expect.any(AbortSignal),
    });
  });

  it('returns null on non-2xx (unreachable / error)', async () => {
    const fetch = fakeFetch(503, {});
    const c = new ResolveClient({ baseUrl: 'http://h', fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await c.resolve({ name: 'x' })).toBeNull();
  });

  it('empty candidates → [] (not null) — 查无此人 is a real answer', async () => {
    const fetch = fakeFetch(200, { candidates: [] });
    const c = new ResolveClient({ baseUrl: 'http://h', fetch: fetch as unknown as typeof globalThis.fetch });
    expect(await c.resolve({ name: 'nobody' })).toEqual([]);
  });
});
