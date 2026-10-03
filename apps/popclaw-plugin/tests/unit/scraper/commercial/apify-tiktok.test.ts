import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  apifyTiktok,
  ScrapTikRequestError,
  ScrapTikQuotaError,
  __clearSecUidCache,
} from '../../../../src/scraper/commercial/apify-tiktok';

// Probed real data shapes from Apify's scraptik/tiktok-api actor.
const STEP1_RESPONSE = [
  {
    uid: '6614519312189947909',
    sec_uid: 'MS4wLjABAAAABKjQkOz_IIzXXzEAl_9LGsWhvK-gBnlczwRPXK8EmxAp6K3X0qiaP5_OEqmm0XwG',
    status_code: 0,
  },
];

function makeStep2Response(awemeList: object[]): object[] {
  return [{ aweme_list: awemeList, has_more: 1, max_cursor: 1775584698000 }];
}

function makeAweme(id: string, createTime: number, desc: string, shareUrl?: string) {
  return {
    aweme_id: id,
    desc,
    create_time: createTime,
    share_url: shareUrl ?? `https://www.tiktok.com/@mrbeast/video/${id}?_r=1`,
    author: { uid: '6614519312189947909', nickname: 'MrBeast' },
  };
}

describe('ScrapTikScraper / apifyTiktok', () => {
  beforeEach(() => {
    __clearSecUidCache();
  });

  it('scrapeTimeline resolves sec_uid first-time, fetches posts, caches sec_uid', async () => {
    const step1Body = JSON.stringify(STEP1_RESPONSE);
    const step2Body = JSON.stringify(
      makeStep2Response([
        makeAweme('A001', 1776272468, 'latest post'),
      ]),
    );
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      const body = callCount === 1 ? step1Body : step2Body;
      return Promise.resolve(new Response(body));
    });

    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });
    const posts = await scraper.scrapeTimeline('mrbeast', new Date(0), 20);

    // Two calls: step 1 (resolve) + step 2 (posts)
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Step 1 call shape
    const [url1, init1] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url1).toContain('scraptik~tiktok-api');
    expect(JSON.parse(init1.body as string)).toEqual({ usernameToId_username: 'mrbeast' });

    // Step 2 call shape
    const [url2, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url2).toContain('scraptik~tiktok-api');
    const body2 = JSON.parse(init2.body as string);
    expect(body2.userPosts_secUserId).toBe(STEP1_RESPONSE[0]!.sec_uid);
    expect(body2.userPosts_count).toBe(20);

    // Posts returned
    expect(posts).toHaveLength(1);
    expect(posts[0]!.id).toBe('A001');
    expect(posts[0]!.text).toBe('latest post');
    expect(posts[0]!.createdAt).toEqual(new Date(1776272468 * 1000));
    expect(posts[0]!.originalUrl).toBe('https://www.tiktok.com/@mrbeast/video/A001?_r=1');

    // After first call, cache should hold sec_uid — second call should be only 1 HTTP call
    const fetchMock2 = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(makeStep2Response([]))),
    );
    const scraper2 = apifyTiktok('tok-tt', undefined, { fetch: fetchMock2, sleep: async () => {} });
    await scraper2.scrapeTimeline('mrbeast', new Date(0), 5);
    // Cache is module-level, so scraper2 also only does 1 call
    expect(fetchMock2).toHaveBeenCalledTimes(1);
  });

  it('scrapeTimeline reuses cached sec_uid on second call for same handle', async () => {
    const step1Body = JSON.stringify(STEP1_RESPONSE);
    const step2Body = JSON.stringify(makeStep2Response([]));
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount++;
      const body = callCount === 1 ? step1Body : step2Body;
      return Promise.resolve(new Response(body));
    });

    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });

    // First call: 2 HTTP calls (resolve + fetch)
    await scraper.scrapeTimeline('mrbeast', new Date(0), 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Second call for same handle: only 1 HTTP call (cache hit)
    await scraper.scrapeTimeline('mrbeast', new Date(0), 10);
    expect(fetchMock).toHaveBeenCalledTimes(3);  // total 3 = 2 + 1
  });

  it('scrapeTimeline drops malformed awemes, honours since filter', async () => {
    const sinceTs = new Date('2026-04-23T00:00:00Z').getTime() / 1000;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(STEP1_RESPONSE)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeStep2Response([
          makeAweme('GOOD', sinceTs + 10000, 'after since'),
          makeAweme('OLD', sinceTs - 100, 'before since'),
          { aweme_id: 'NO_CREATE_TIME', desc: 'no timestamp' },   // malformed: missing create_time
          { create_time: sinceTs + 5000, desc: 'no id' },          // malformed: missing aweme_id
        ]))),
      );

    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });
    const posts = await scraper.scrapeTimeline('mrbeast', new Date(sinceTs * 1000), 20);

    // Only GOOD passes: OLD filtered by since, malformed filtered by type guard
    expect(posts.map((p) => p.id)).toEqual(['GOOD']);
  });

  it('scrapeTimeline returns [] when username resolve has no sec_uid', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([{ uid: '123', status_code: 1 }])),  // no sec_uid
    );
    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });
    const posts = await scraper.scrapeTimeline('unknownUser', new Date(0), 20);

    expect(posts).toEqual([]);
    // Only 1 call (step 1), no step 2
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ADR-0025 task 4.3: fetchVerificationTargets now resolves sec_uid (TikTok stable id)
  // as a by-product of the username lookup, so it makes one HTTP call.
  it('fetchVerificationTargets resolves sec_uid and returns it as accountId', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([{ sec_uid: 'MS4wLjABAAAA-test-sec-uid', uid: '123' }])),
    );
    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });
    const targets = await scraper.fetchVerificationTargets('mrbeast');

    expect(targets.firstPost).toBeNull();
    expect(targets.selfReplies).toEqual([]);
    expect(targets.rawBytes).toBeInstanceOf(Uint8Array);
    expect(targets.rawBytes).toHaveLength(0);
    // sec_uid is returned as accountId
    expect(targets.accountId).toBe('MS4wLjABAAAA-test-sec-uid');
    // one HTTP call for username-to-id resolution
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetchVerificationTargets returns undefined accountId when resolve fails', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network error'));
    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });
    const targets = await scraper.fetchVerificationTargets('mrbeast');

    expect(targets.firstPost).toBeNull();
    expect(targets.accountId).toBeUndefined();
  });

  it('fetchVerificationTargets uses cached sec_uid without extra HTTP call', async () => {
    // Prime the cache via scrapeTimeline
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ sec_uid: 'cached-sec-uid', uid: '456' }])))
      .mockResolvedValueOnce(new Response(JSON.stringify(makeStep2Response([]))));
    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });
    await scraper.scrapeTimeline('testuser', new Date(0), 5); // primes cache

    fetchMock.mockClear();
    const targets = await scraper.fetchVerificationTargets('testuser');

    // No additional HTTP call — sec_uid was cached
    expect(fetchMock).not.toHaveBeenCalled();
    expect(targets.accountId).toBe('cached-sec-uid');
  });

  it('invokes cost observer per HTTP call at $0.001 each', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(STEP1_RESPONSE)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(makeStep2Response([
          makeAweme('X1', Math.floor(Date.now() / 1000), 'fresh'),
        ]))),
      );

    const events: Array<{ providerName: string; platform: string; estimatedCostUsd: number; resultsCount: number }> = [];
    const scraper = apifyTiktok(
      'tok-tt',
      (e) => events.push({ providerName: e.providerName, platform: e.platform, estimatedCostUsd: e.estimatedCostUsd, resultsCount: e.resultsCount }),
      { fetch: fetchMock, sleep: async () => {} },
    );
    await scraper.scrapeTimeline('mrbeast', new Date(0), 10);

    // Two HTTP calls → two cost events
    expect(events).toHaveLength(2);
    expect(events[0]!.estimatedCostUsd).toBeCloseTo(0.001, 10);
    expect(events[0]!.resultsCount).toBe(0);  // PAY_PER_EVENT: cost per call, not per result
    expect(events[0]!.platform).toBe('tiktok');
    expect(events[0]!.providerName).toBe('apify.scraptik-tiktok-api');
    expect(events[1]!.estimatedCostUsd).toBeCloseTo(0.001, 10);
  });

  it('throws ScrapTikQuotaError on 402 (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('payment required', { status: 402 }),
    );
    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });

    await expect(scraper.scrapeTimeline('mrbeast', new Date(0), 10)).rejects.toThrow(ScrapTikQuotaError);
    expect(fetchMock).toHaveBeenCalledTimes(1);  // no retries
  });

  it('throws ScrapTikRequestError on 401 (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }),
    );
    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: async () => {} });

    await expect(scraper.scrapeTimeline('mrbeast', new Date(0), 10)).rejects.toThrow(ScrapTikRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);  // no retries
  });

  it('retries on 429 + 5xx per ladder', async () => {
    const sleepDelays: number[] = [];
    const sleepMock = vi.fn().mockImplementation((ms: number) => {
      sleepDelays.push(ms);
      return Promise.resolve();
    });

    // Fail with 429, 500, 503, then succeed on 4th attempt (step 1), then step 2 succeeds
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 429, statusText: 'Too Many Requests' }))
      .mockResolvedValueOnce(new Response('', { status: 500, statusText: 'Internal Server Error' }))
      .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(new Response(JSON.stringify(STEP1_RESPONSE)))  // step 1 succeeds on 4th try
      .mockResolvedValueOnce(new Response(JSON.stringify(makeStep2Response([]))));  // step 2

    const scraper = apifyTiktok('tok-tt', undefined, { fetch: fetchMock, sleep: sleepMock });
    await expect(scraper.scrapeTimeline('mrbeast', new Date(0), 10)).resolves.toBeDefined();

    // 4 attempts for step 1 (429, 500, 503, success) + 1 for step 2 = 5 total
    expect(fetchMock.mock.calls.length).toBe(5);
    // Retry delays: ladder is [0, 1000, 4000, 16000] → sleep called for each delay in ladder
    // (sleep is called before each attempt, including the first one at delay=0)
    expect(sleepDelays).toContain(1000);
    expect(sleepDelays).toContain(4000);
    expect(sleepDelays).toContain(16000);
  });
});
