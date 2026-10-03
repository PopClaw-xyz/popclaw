import { describe, it, expect, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { item } from '../../helpers/world-feed-cache';
import { WorldFeedClient } from '../../../src/ingress/world-feed-client';

function encodeSnap(items: popclaw.event.IWorldFeedItem[]): ArrayBuffer {
  const bytes = popclaw.event.WorldFeedSnapshot.encode({ items }).finish();
  // Copy into a fresh ArrayBuffer so TS is happy with BodyInit (no SharedArrayBuffer ambiguity).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}

describe('WorldFeedClient', () => {
  it('GETs /world-feed and decodes protobuf response', async () => {
    const snap = encodeSnap([
      { platform: 'x', platformPostId: 'p1', platformPostCreatedAt: 1700000000, authorPopclawId: 'A', handle: 'elonmusk', originalUrl: 'https://x.com/elonmusk/status/p1', textPreview: 'hello' },
      { platform: 'youtube', platformPostId: 'v1', platformPostCreatedAt: 1700000100, authorPopclawId: 'B', handle: 'MrBeast', originalUrl: 'https://www.youtube.com/watch?v=v1', textPreview: 'video title' },
    ].map(value => item(value)));
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(snap, { headers: { 'content-type': 'application/x-protobuf' } }));
    const client = new WorldFeedClient({ baseUrl: 'http://localhost:8080', fetch: fetchMock as unknown as typeof globalThis.fetch });
    const items = await client.fetchSnapshot({ limit: 20 });
    expect(items).toHaveLength(2);
    expect(items[0]!.platform).toBe('x');
    expect(items[0]!.handle).toBe('elonmusk');
    expect(items[1]!.platform).toBe('youtube');
    expect(items[1]!.originalUrl).toBe('https://www.youtube.com/watch?v=v1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8080/world-feed?limit=20');
    const headers = init.headers as Record<string, string>;
    expect(headers['accept']).toBe('application/x-protobuf');
  });

  it('rejects a snapshot item with no original envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(encodeSnap([item({ envelope: undefined })])));
    const client = new WorldFeedClient({ baseUrl: 'http://localhost:8080', fetch: fetchMock as unknown as typeof globalThis.fetch });
    await expect(client.fetchSnapshot({})).rejects.toThrow();
  });

  it('builds URL without query string when no params', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(encodeSnap([])));
    const client = new WorldFeedClient({ baseUrl: 'http://localhost:8080', fetch: fetchMock as unknown as typeof globalThis.fetch });
    await client.fetchSnapshot({});
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('http://localhost:8080/world-feed');
  });

  it('combines limit + author + platform filters correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(encodeSnap([])));
    const client = new WorldFeedClient({ baseUrl: 'http://localhost:8080', fetch: fetchMock as unknown as typeof globalThis.fetch });
    await client.fetchSnapshot({ limit: 50, author: 'HafHw...', platform: 'x' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('limit=50');
    expect(url).toContain('author=HafHw...');
    expect(url).toContain('platform=x');
  });

  it('URL-encodes author with special chars', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(encodeSnap([])));
    const client = new WorldFeedClient({ baseUrl: 'http://localhost:8080', fetch: fetchMock as unknown as typeof globalThis.fetch });
    await client.fetchSnapshot({ author: 'a+b/c=' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('author=a%2Bb%2Fc%3D');
  });

  it('retains the typed HTTP status without echoing the remote body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('boom', { status: 500 }));
    const client = new WorldFeedClient({ baseUrl: 'http://localhost:8080', fetch: fetchMock as unknown as typeof globalThis.fetch });
    await expect(client.fetchSnapshot({}))
      .rejects.toMatchObject({failure:{code:'HOUSE_REMOTE_HTTP',status:500,origin:'http://localhost:8080'}});
  });

  it('throws if response body is not a valid WorldFeedSnapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff])));
    const client = new WorldFeedClient({ baseUrl: 'http://localhost:8080', fetch: fetchMock as unknown as typeof globalThis.fetch });
    await expect(client.fetchSnapshot({})).rejects.toThrow();
  });

  it('handles empty snapshot (0 items)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(encodeSnap([])));
    const client = new WorldFeedClient({ baseUrl: 'http://localhost:8080', fetch: fetchMock as unknown as typeof globalThis.fetch });
    const items = await client.fetchSnapshot({});
    expect(items).toEqual([]);
  });
});
