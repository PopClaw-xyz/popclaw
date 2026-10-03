import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  YoutubeDataApiScraper,
  YoutubeDataApiRequestError,
  YoutubeDataApiQuotaError,
  __clearChannelCache,
} from '../../../../src/scraper/commercial/youtube-data-api-scraper';
import type { CostEvent } from '../../../../src/scraper/commercial/apify-actor-scraper';

describe('YoutubeDataApiScraper', () => {
  beforeEach(() => __clearChannelCache());

  it.each([null, { items: {} }, { items: 'bad' }, { items: [null, 7, {}] }])('ignores malformed playlist response %j', async (payload) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ id: 'UC_X', contentDetails: { relatedPlaylists: { uploads: 'UU_X' } } }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload)));
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock, sleep: async () => {} });
    await expect(scraper.scrapeTimeline('@test', new Date(0), 10)).resolves.toEqual([]);
  });

  it.each([null, { items: {} }, { items: [null] }, { items: [{ id: 'UC_X', contentDetails: [] }] }])('ignores malformed channel response %j', async (payload) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(payload)));
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock, sleep: async () => {} });
    await expect(scraper.scrapeTimeline('@test', new Date(0), 10)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves handle then fetches playlistItems; caches channel lookup', async () => {
    const fetchMock = vi.fn()
      // 1. channels.list by forHandle=@mrbeast
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: 'UC_channel_001',
          contentDetails: { relatedPlaylists: { uploads: 'UU_uploads_001' } },
        }],
      })))
      // 2. playlistItems.list
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [
          { snippet: { title: 'Video 1', publishedAt: '2026-04-24T10:00:00Z', resourceId: { videoId: 'vid001' } } },
          { snippet: { title: 'Video 2 (old)', publishedAt: '2026-04-17T10:00:00Z', resourceId: { videoId: 'vid002' } } },
        ],
      })))
      // 3. second call, no resolve
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [
          { snippet: { title: 'Video 3', publishedAt: '2026-04-24T12:00:00Z', resourceId: { videoId: 'vid003' } } },
        ],
      })));

    const scraper = new YoutubeDataApiScraper({
      apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {},
    });

    const posts = await scraper.scrapeTimeline('@mrbeast', new Date('2026-04-20T00:00:00Z'), 20);
    expect(posts.map((p) => p.id)).toEqual(['vid001']);  // vid002 too old
    expect(posts[0]!.originalUrl).toBe('https://www.youtube.com/watch?v=vid001');
    expect(posts[0]!.text).toBe('Video 1');
    expect(posts[0]!.createdAt.toISOString()).toBe('2026-04-24T10:00:00.000Z');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Verify channels.list URL
    const url1 = fetchMock.mock.calls[0]![0] as string;
    expect(url1).toContain('/youtube/v3/channels');
    expect(url1).toContain('forHandle=%40mrbeast');  // @ gets URL-encoded
    expect(url1).toContain('part=contentDetails');
    expect(url1).toContain('key=K');

    // Verify playlistItems.list URL
    const url2 = fetchMock.mock.calls[1]![0] as string;
    expect(url2).toContain('/youtube/v3/playlistItems');
    expect(url2).toContain('playlistId=UU_uploads_001');
    expect(url2).toContain('maxResults=20');

    // Second call: skips resolve
    await scraper.scrapeTimeline('@mrbeast', new Date(0), 20);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('prepends @ when handle arrives without it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ id: 'UC_X', contentDetails: { relatedPlaylists: { uploads: 'UU_X' } } }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })));
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    await scraper.scrapeTimeline('mrbeast', new Date(0), 10);
    const url1 = fetchMock.mock.calls[0]![0] as string;
    expect(url1).toContain('forHandle=%40mrbeast');  // '@' was prepended then URL-encoded
  });

  it('returns empty when channels.list has no items (handle not found)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })));
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const posts = await scraper.scrapeTimeline('@nonexistent', new Date(0), 10);
    expect(posts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops malformed playlistItems (missing videoId or publishedAt)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ id: 'UC_X', contentDetails: { relatedPlaylists: { uploads: 'UU_X' } } }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [
          { snippet: { title: 'good', publishedAt: '2026-04-24T10:00:00Z', resourceId: { videoId: 'v1' } } },
          { snippet: { title: 'no videoId' } },
          { snippet: { title: 'no publishedAt', resourceId: { videoId: 'v2' } } },
        ],
      })));
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const posts = await scraper.scrapeTimeline('@good', new Date(0), 10);
    expect(posts.map((p) => p.id)).toEqual(['v1']);
  });

  it('fetchVerificationTargets returns empty with no HTTP call', async () => {
    const fetchMock = vi.fn();
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const targets = await scraper.fetchVerificationTargets('@anything');
    expect(targets.firstPost).toBeNull();
    expect(targets.selfReplies).toEqual([]);
    expect(targets.rawBytes.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws YoutubeDataApiQuotaError on 403 with quotaExceeded reason', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 403, errors: [{ reason: 'quotaExceeded' }], message: 'quota' },
    }), { status: 403 }));
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    await expect(scraper.scrapeTimeline('@h', new Date(0), 10)).rejects.toBeInstanceOf(YoutubeDataApiQuotaError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws YoutubeDataApiRequestError on 401 (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 }));
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    const err = await scraper.scrapeTimeline('@h', new Date(0), 10).catch((e) => e);
    expect(err).toBeInstanceOf(YoutubeDataApiRequestError);
    expect((err as YoutubeDataApiRequestError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 + 5xx per ladder, eventually succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rl', { status: 429 }))
      .mockResolvedValueOnce(new Response('oops', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ id: 'UC_X', contentDetails: { relatedPlaylists: { uploads: 'UU_X' } } }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [] })));
    const scraper = new YoutubeDataApiScraper({ apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} });
    await scraper.scrapeTimeline('@h', new Date(0), 10);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('invokes cost observer at $0 per call (free-tier)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ id: 'UC_X', contentDetails: { relatedPlaylists: { uploads: 'UU_X' } } }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ snippet: { title: 't', publishedAt: '2026-04-24T00:00:00Z', resourceId: { videoId: 'v' } } }],
      })));
    const events: CostEvent[] = [];
    const scraper = new YoutubeDataApiScraper({
      apiKey: 'K', fetch: fetchMock as unknown as typeof fetch, sleep: async () => {},
      onScrapeComplete: (e) => events.push(e),
    });
    await scraper.scrapeTimeline('@h', new Date(0), 10);
    expect(events).toHaveLength(2);
    expect(events[0]!.estimatedCostUsd).toBe(0);
    expect(events[0]!.providerName).toBe('youtube.data-api-v3');
    expect(events[0]!.platform).toBe('youtube');
    expect(typeof events[0]!.latencyMs).toBe('number');
  });
});
