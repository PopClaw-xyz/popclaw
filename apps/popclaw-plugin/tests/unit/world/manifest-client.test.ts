/**
 * ADR-0041: manifest-client unit tests, conditional GET and permissive parsing. Match GuideClient's
 * fault tolerance: every error returns unavailable, never throws.
 */
import { describe, it, expect } from 'vitest';
import { conditionalGet, fetchHouseManifest } from '../../../src/world/manifest-client.js';

const BASE = 'http://localhost:8080';

const MANIFEST = {
  manifest_version: 1,
  house: { name: 'popclaw.world', slug: 'world', description: '旅行世界' },
  official_ids: ['WORLD_OFFICIAL_1'],
  guide_url: 'https://popclaw.world/guide.md',
  core_primitives: { profile: true, follow: true, directed_delivery: false },
  event_kinds: [],
  intent_kinds: [],
};

function jsonFetch(status: number, body: unknown, etag?: string): typeof globalThis.fetch {
  return (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      ...(etag ? { headers: { etag } } : {}),
    })) as unknown as typeof globalThis.fetch;
}

describe('conditionalGet', () => {
  it('200 → ok，带 etag 与正文', async () => {
    const r = await conditionalGet(`${BASE}/x`, { fetch: jsonFetch(200, 'hello', '"e1"') });
    expect(r).toEqual({ status: 'ok', etag: '"e1"', text: 'hello' });
  });

  it('给了 etag → 请求带 If-None-Match；304 → not_modified', async () => {
    let sentInm: string | null = null;
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sentInm = new Headers(init?.headers).get('if-none-match');
      return new Response(null, { status: 304 });
    }) as unknown as typeof globalThis.fetch;
    const r = await conditionalGet(`${BASE}/x`, { etag: '"e1"', fetch: fetchFn });
    expect(sentInm).toBe('"e1"');
    expect(r).toEqual({ status: 'not_modified' });
  });

  it('500 / 404 → unavailable', async () => {
    expect(await conditionalGet(`${BASE}/x`, { fetch: jsonFetch(500, 'boom') })).toEqual({
      status: 'unavailable',
    });
    expect(await conditionalGet(`${BASE}/x`, { fetch: jsonFetch(404, '') })).toEqual({
      status: 'unavailable',
    });
  });

  it('fetch 抛（网络不通）→ unavailable，不抛', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    expect(await conditionalGet(`${BASE}/x`, { fetch: fetchFn })).toEqual({
      status: 'unavailable',
    });
  });
});

describe('fetchHouseManifest', () => {
  it('200 → 解出 house / official_ids / guide_url，URL 走 /v1/manifest', async () => {
    let requested = '';
    const fetchFn = (async (url: RequestInfo | URL) => {
      requested = String(url);
      return new Response(JSON.stringify(MANIFEST), { status: 200, headers: { etag: '"m1"' } });
    }) as unknown as typeof globalThis.fetch;
    const r = await fetchHouseManifest(`${BASE}/`, { fetch: fetchFn });
    expect(requested).toBe(`${BASE}/v1/manifest`);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.etag).toBe('"m1"');
    expect(r.manifest).toEqual({
      houseName: 'popclaw.world',
      houseSlug: 'world',
      officialIds: ['WORLD_OFFICIAL_1'],
      guideUrl: 'https://popclaw.world/guide.md',
    });
  });

  it('缺字段全部容忍（松耦合：未知字段忽略、缺字段给缺省）', async () => {
    const r = await fetchHouseManifest(BASE, { fetch: jsonFetch(200, { 未来字段: 1 }) });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest).toEqual({
      houseName: '',
      houseSlug: '',
      officialIds: [],
    });
  });

  it('official_ids 里的非字符串被剔掉', async () => {
    const r = await fetchHouseManifest(BASE, {
      fetch: jsonFetch(200, { official_ids: ['A', 42, null, 'B'] }),
    });
    expect(r.status === 'ok' && r.manifest.officialIds).toEqual(['A', 'B']);
  });

  it('坏 JSON → unavailable（不抛）', async () => {
    const r = await fetchHouseManifest(BASE, { fetch: jsonFetch(200, '{ not json') });
    expect(r).toEqual({ status: 'unavailable' });
  });

  it('304 直接透传', async () => {
    const fetchFn = (async () =>
      new Response(null, { status: 304 })) as unknown as typeof globalThis.fetch;
    expect(await fetchHouseManifest(BASE, { etag: '"m1"', fetch: fetchFn })).toEqual({
      status: 'not_modified',
    });
  });
});
