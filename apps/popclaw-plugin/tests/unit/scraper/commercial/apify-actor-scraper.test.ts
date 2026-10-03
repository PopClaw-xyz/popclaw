import { describe, it, expect, vi } from 'vitest';
import {
  ApifyActorScraper,
  ApifyRequestError,
  ApifyQuotaError,
} from '../../../../src/scraper/commercial/apify-actor-scraper';
import type { VerificationTargets } from '../../../../src/scraper/platform-scraper';

interface TestActorItem {
  id: string;
  text: string;
  createdAt: string;
  url: string;
}

function makeScraper(opts: Partial<ConstructorParameters<typeof ApifyActorScraper>[0]> = {}, fetchMock?: ReturnType<typeof vi.fn>) {
  return new ApifyActorScraper({
    token: 'tok-abc',
    actorSlug: 'test-owner/test-actor',
    platform: 'x',
    costPerResultUsd: 0.0004,
    buildTimelineInput: (handle, _since, maxItems) => ({ handle, maxItems }),
    parseTimelineOutput: (items) =>
      (items as TestActorItem[]).map((t) => ({
        id: t.id,
        text: t.text,
        createdAt: new Date(t.createdAt),
        originalUrl: t.url,
      })),
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    sleep: async () => {},
    ...opts,
  });
}

describe('ApifyActorScraper', () => {
  it('POSTs to run-sync-get-dataset-items with Bearer token and owner~actor path', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: '1', text: 'hi', createdAt: '2026-04-24T00:00:00Z', url: 'https://x.com/h/status/1' },
      ])),
    );
    const scraper = makeScraper({}, fetchMock);
    const posts = await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10);

    expect(posts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v2/acts/test-owner~test-actor/run-sync-get-dataset-items');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok-abc');
    expect(headers['content-type']).toBe('application/json');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ handle: 'blackfeather_ai', maxItems: 10 });
  });

  it('cost observer is invoked with correct cost math', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: '1', text: 'a', createdAt: '2026-04-24T00:00:00Z', url: 'https://x.com/h/status/1' },
        { id: '2', text: 'b', createdAt: '2026-04-24T00:01:00Z', url: 'https://x.com/h/status/2' },
      ])),
    );
    const events: Array<{ resultsCount: number; estimatedCostUsd: number; providerName: string; platform: string; latencyMs: number }> = [];
    const scraper = makeScraper({
      onScrapeComplete: (e) => events.push({
        resultsCount: e.resultsCount,
        estimatedCostUsd: e.estimatedCostUsd,
        providerName: e.providerName,
        platform: e.platform,
        latencyMs: e.latencyMs,
      }),
    }, fetchMock);
    await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10);

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.resultsCount).toBe(2);
    expect(e.estimatedCostUsd).toBeCloseTo(0.0008, 10);
    expect(e.providerName).toBe('apify.test-owner-test-actor');
    expect(e.platform).toBe('x');
    expect(typeof e.latencyMs).toBe('number');
    expect(e.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('adds the flat per-run cost on top of the per-result cost', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: '1', text: 'a', createdAt: '2026-04-24T00:00:00Z', url: 'https://x.com/h/status/1' },
        { id: '2', text: 'b', createdAt: '2026-04-24T00:01:00Z', url: 'https://x.com/h/status/2' },
      ])),
    );
    const costs: number[] = [];
    const scraper = makeScraper({ costPerRunUsd: 0.007, onScrapeComplete: (e) => costs.push(e.estimatedCostUsd) }, fetchMock);
    await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(costs).toHaveLength(1);
    expect(costs[0]).toBeCloseTo(2 * 0.0004 + 0.007, 10);
  });

  it('throws ApifyQuotaError on HTTP 402 (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('quota exceeded', { status: 402 }),
    );
    const scraper = makeScraper({}, fetchMock);
    await expect(scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10))
      .rejects.toBeInstanceOf(ApifyQuotaError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApifyRequestError on HTTP 401 (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('unauthorised', { status: 401 }),
    );
    const scraper = makeScraper({}, fetchMock);
    const err = await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10).catch((e) => e);
    expect(err).toBeInstanceOf(ApifyRequestError);
    expect((err as ApifyRequestError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ApifyRequestError on HTTP 404 (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('actor not found', { status: 404 }),
    );
    const scraper = makeScraper({}, fetchMock);
    const err = await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10).catch((e) => e);
    expect(err).toBeInstanceOf(ApifyRequestError);
    expect((err as ApifyRequestError).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 up to 4 attempts then gives up', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('rate limit', { status: 429 }),
    );
    const scraper = makeScraper({}, fetchMock);
    await expect(scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10))
      .rejects.toBeInstanceOf(ApifyRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('retries on 5xx and succeeds when eventually 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('server oops', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: '1', text: 'hi', createdAt: '2026-04-24T00:00:00Z', url: 'https://x.com/h/status/1' },
      ])));
    const scraper = makeScraper({}, fetchMock);
    const posts = await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(posts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries on fetch throw (network) and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response(JSON.stringify([])));
    const scraper = makeScraper({}, fetchMock);
    const posts = await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(posts).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('suppresses observer throw without aborting scrape', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: '1', text: 'hi', createdAt: '2026-04-24T00:00:00Z', url: 'https://x.com/h/status/1' },
      ])),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scraper = makeScraper({
      onScrapeComplete: () => { throw new Error('observer exploded'); },
    }, fetchMock);
    // Scrape should still succeed.
    const posts = await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(posts).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fetchVerificationTargets calls parseVerificationOutput when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        { id: '1', text: 'firstpost', createdAt: '2026-04-20T00:00:00Z', url: 'https://x.com/h/status/1' },
      ])),
    );
    const fakeTargets: VerificationTargets = {
      firstPost: { id: '1', text: 'firstpost', createdAt: new Date('2026-04-20T00:00:00Z') },
      selfReplies: [],
      rawBytes: new Uint8Array(0),
    };
    const scraper = makeScraper({
      buildVerificationInput: (handle) => ({ handle, max: 100 }),
      parseVerificationOutput: () => fakeTargets,
    }, fetchMock);
    const targets = await scraper.fetchVerificationTargets('blackfeather_ai');
    expect(targets).toEqual(fakeTargets);
  });

  it('fetchVerificationTargets forwards raw wire bytes to parseVerificationOutput', async () => {
    const bodyContent = JSON.stringify([
      { id: '1', text: 'firstpost', createdAt: '2026-04-20T00:00:00Z', url: 'https://x.com/h/status/1' },
    ]);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(bodyContent));
    let capturedRawBytes: Uint8Array | undefined;
    const scraper = makeScraper({
      buildVerificationInput: (handle) => ({ handle }),
      parseVerificationOutput: (items, _handle, rawBytes) => {
        capturedRawBytes = rawBytes;
        return { firstPost: null, selfReplies: [], rawBytes };
      },
    }, fetchMock);
    await scraper.fetchVerificationTargets('blackfeather_ai');

    const expectedBytes = new TextEncoder().encode(bodyContent);
    expect(capturedRawBytes).toBeDefined();
    expect(capturedRawBytes).toEqual(expectedBytes);
  });

  it('fetchVerificationTargets returns empty when no parseVerificationOutput provided', async () => {
    const fetchMock = vi.fn();  // should NOT be called
    const scraper = makeScraper({}, fetchMock);
    const targets = await scraper.fetchVerificationTargets('blackfeather_ai');
    expect(targets).toEqual({
      firstPost: null,
      selfReplies: [],
      rawBytes: new Uint8Array(0),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
