/**
 * S4-T4: GuideClient 单元测试 — GET /v1/guide.md 全文，失败容错为 null。
 */
import { describe, it, expect } from 'vitest';
import { GuideClient } from '../../../src/world/guide-client.js';

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
