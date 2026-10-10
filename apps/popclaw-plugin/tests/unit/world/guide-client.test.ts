/**
 * S4-T4: GuideClient unit tests fetch the complete GET /v1/guide.md body and tolerate failure by
 * returning null.
 */
import { describe, it, expect } from 'vitest';
import { GuideClient } from '../../../src/world/guide-client.js';
import { ActionInactiveError } from '../../../src/runtime/house-lifecycle/action-context.js';

const BASE = 'http://localhost:8080';
const GUIDE_TEXT = '---\nworld: popclaw.me\n---\n\n# 欢迎\n';

function textFetch(status: number, body: string): typeof globalThis.fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'text/markdown' },
    })) as unknown as typeof globalThis.fetch;
}

describe('GuideClient', () => {
  it.each(['http', 'network', 'local', 'body-network'] as const)('typed guide result preserves %s classification while nullable reads stay null', async kind => {
    const client = new GuideClient({ baseUrl: BASE, fetch: async () => {
      if (kind === 'local') throw new ActionInactiveError('HOUSE_TRUST_REVOKED', BASE);
      if (kind === 'network') throw new TypeError('synthetic network');
      if (kind === 'body-network') return new Response(new ReadableStream({ start(c) { c.error(new TypeError('synthetic body error')); } }));
      return new Response('hidden response body', { status: 404 });
    } });
    const code = kind === 'local' ? 'HOUSE_TRUST_REVOKED' : kind === 'http' ? 'HOUSE_REMOTE_HTTP' : 'HOUSE_REMOTE_NETWORK';
    expect(await client.fetchGuideResult()).toMatchObject({ ok: false, failure: { code, origin: BASE } });
    expect(await client.fetchGuideText()).toBeNull();
  });

  it('200 → 返回全文', async () => {
    let requested = '';
    const fetchFn = (async (url: RequestInfo | URL) => {
      requested = String(url);
      return new Response(GUIDE_TEXT, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new GuideClient({ baseUrl: BASE, fetch: fetchFn });
    const text = await client.fetchGuideText();
    expect(text).toBe(GUIDE_TEXT);
    expect(requested).toBe(`${BASE}/v1/guide.md`);
  });

  it('baseUrl 末尾斜杠被归一化', async () => {
    let requested = '';
    const fetchFn = (async (url: RequestInfo | URL) => {
      requested = String(url);
      return new Response(GUIDE_TEXT, { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const client = new GuideClient({ baseUrl: `${BASE}/`, fetch: fetchFn });
    await client.fetchGuideText();
    expect(requested).toBe(`${BASE}/v1/guide.md`);
  });

  it('500 → null（不抛）', async () => {
    const client = new GuideClient({ baseUrl: BASE, fetch: textFetch(500, 'boom') });
    expect(await client.fetchGuideText()).toBeNull();
  });

  it('404 → null（不抛）', async () => {
    const client = new GuideClient({ baseUrl: BASE, fetch: textFetch(404, '') });
    expect(await client.fetchGuideText()).toBeNull();
  });

  it('fetch 抛（网络不通）→ null', async () => {
    const fetchFn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    const client = new GuideClient({ baseUrl: BASE, fetch: fetchFn });
    expect(await client.fetchGuideText()).toBeNull();
  });
});
