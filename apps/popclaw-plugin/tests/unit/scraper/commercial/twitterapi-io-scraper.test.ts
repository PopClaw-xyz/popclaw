import { describe, it, expect, vi } from 'vitest';
import {
  TwitterApiIoScraper,
  TwitterApiIoRequestError,
  CREDIT_EXHAUSTED_MARKER,
} from '../../../../src/scraper/commercial/twitterapi-io-scraper';

const TWEET = (
  id: string,
  createdAt: string,
  text: string,
  extra: Record<string, unknown> = {},
) => ({
  type: 'tweet',
  id,
  url: `https://x.com/blackfeather_ai/status/${id}`,
  text,
  createdAt,
  author: { userName: 'blackfeather_ai', id: '42' },
  isReply: false,
  inReplyToUsername: null,
  inReplyToId: null,
  retweeted_tweet: null,
  quoted_tweet: null,
  ...extra,
});

function page(tweets: unknown[], hasNext = false, cursor = '') {
  return new Response(JSON.stringify({
    tweets,
    has_next_page: hasNext,
    next_cursor: cursor,
  }));
}

describe('TwitterApiIoScraper', () => {
  it('scrapeTimeline sends x-api-key header and query=from:handle + since: operator', async () => {
    // Tweet is 1s after `since` so the strict `>` boundary filter keeps it.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      page([TWEET('1', 'Fri Apr 24 00:00:01 +0000 2026', 'hi')]),
    );
    const s = new TwitterApiIoScraper({
      apiKey: 'k-abc',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const posts = await s.scrapeTimeline('blackfeather_ai', new Date('2026-04-24T00:00:00Z'), 10);
    expect(posts).toHaveLength(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/twitter/tweet/advanced_search');
    expect(url).toContain('query=from%3Ablackfeather_ai');
    expect(url).toContain('queryType=Latest');
    // twitterapi.io IGNORES the since_time URL param — the filter must live
    // inside the query string as a Twitter-native operator.
    expect(url).not.toContain('since_time');
    expect(decodeURIComponent(url)).toContain('since:2026-04-24');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k-abc');
    expect(init.method).toBe('GET');
  });

  it('scrapeTimeline embeds since_id operator when a post-id cursor is given', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      page([TWEET('99', 'Fri Apr 24 00:00:01 +0000 2026', 'hi')]),
    );
    const s = new TwitterApiIoScraper({
      apiKey: 'k-abc',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    await s.scrapeTimeline('example', new Date('2026-04-24T00:00:00Z'), 10, '1234567890');

    const [url] = fetchMock.mock.calls[0] as [string];
    const q = decodeURIComponent(url);
    // since_id is exact; it must win over the day-granularity `since:` fallback.
    expect(q).toContain('since_id:1234567890');
    expect(q).not.toContain('since:2026-04-24');
    expect(url).not.toContain('since_time');
  });

  it('scrapeTimeline emits no recency operator when there is no cursor at all', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      page([TWEET('1', 'Fri Apr 24 00:00:01 +0000 2026', 'hi')]),
    );
    const s = new TwitterApiIoScraper({
      apiKey: 'k-abc',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    await s.scrapeTimeline('example', new Date(0), 10);

    const q = decodeURIComponent((fetchMock.mock.calls[0] as [string])[0]);
    expect(q).toContain('from:example');
    expect(q).not.toContain('since_id:');
    expect(q).not.toContain('since:');
  });

  it('scrapeTimeline paginates via cursor until maxItems reached', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(
        Array.from({length: 20}, (_, i) => TWEET(`p1-${i}`, 'Fri Apr 24 00:00:00 +0000 2026', `t${i}`)),
        true,
        'cursor-page-2',
      ))
      .mockResolvedValueOnce(page(
        Array.from({length: 5}, (_, i) => TWEET(`p2-${i}`, 'Fri Apr 24 00:00:00 +0000 2026', `t${i}`)),
        false,
      ));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const posts = await s.scrapeTimeline('blackfeather_ai', new Date(0), 100);
    expect(posts).toHaveLength(25);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // second call must include cursor query param
    const url2 = fetchMock.mock.calls[1]![0] as string;
    expect(url2).toContain('cursor=cursor-page-2');
  });

  it('scrapeTimeline stops early when maxItems reached mid-page', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page(
      Array.from({length: 20}, (_, i) => TWEET(`p-${i}`, 'Fri Apr 24 00:00:00 +0000 2026', `t${i}`)),
      true,
      'unused-cursor',
    ));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const posts = await s.scrapeTimeline('blackfeather_ai', new Date(0), 5);
    expect(posts).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('scrapeTimeline drops non-tweet placeholders and malformed items', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([
      TWEET('real', 'Fri Apr 24 00:00:00 +0000 2026', 'real'),
      { type: 'mock_tweet', id: -1, text: 'placeholder' },
      { type: 'tweet' /* missing id/text/createdAt */ },
    ]));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const posts = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(posts.map((p) => p.id)).toEqual(['real']);
  });

  it('scrapeTimeline drops native retweets (retweeted_tweet !== null)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([
      TWEET('orig', 'Fri Apr 24 00:00:00 +0000 2026', 'original'),
      TWEET('rt', 'Fri Apr 24 01:00:00 +0000 2026', 'RT someone', { retweeted_tweet: {id: 'other'} }),
    ]));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const posts = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(posts.map((p) => p.id)).toEqual(['orig']);
  });

  it('fetchVerificationTargets picks earliest as firstPost', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([
      TWEET('newer', 'Tue Apr 22 00:00:00 +0000 2026', 'newer post'),
      TWEET('firstpost', 'Sun Apr 05 00:00:00 +0000 2026', 'hi 4d83f9'),
    ]));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const targets = await s.fetchVerificationTargets('blackfeather_ai');
    expect(targets.firstPost?.id).toBe('firstpost');
    expect(targets.firstPost?.text).toContain('4d83f9');
  });

  it('fetchVerificationTargets walks self-replies (inReplyToUsername === handle)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([
      TWEET('p1', 'Mon Apr 20 00:00:00 +0000 2026', 'first'),
      TWEET('p2', 'Tue Apr 21 00:00:00 +0000 2026', 'self reply', {
        isReply: true,
        inReplyToUsername: 'blackfeather_ai',
        inReplyToId: 'p1',
      }),
      TWEET('p3', 'Wed Apr 22 00:00:00 +0000 2026', 'reply to other', {
        isReply: true,
        inReplyToUsername: 'other',
        inReplyToId: '999',
      }),
    ]));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const targets = await s.fetchVerificationTargets('blackfeather_ai');
    expect(targets.selfReplies).toHaveLength(1);
    expect(targets.selfReplies[0]!.id).toBe('p2');
    expect(targets.selfReplies[0]!.parentPostId).toBe('p1');
  });

  it('fetchVerificationTargets matches self-replies case-insensitively (X handles are case-insensitive)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([
      TWEET('p2', 'Tue Apr 21 00:00:00 +0000 2026', 'self reply', {
        isReply: true,
        inReplyToUsername: 'blackfeather_ai',
        inReplyToId: 'p1',
      }),
    ]));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const targets = await s.fetchVerificationTargets('Blackfeather_AI');
    expect(targets.selfReplies).toHaveLength(1);
    expect(targets.selfReplies[0]!.id).toBe('p2');
  });

  it('fetchVerificationTargets forwards raw wire bytes to rawBytes', async () => {
    const body = JSON.stringify({ tweets: [TWEET('1', 'Fri Apr 24 00:00:00 +0000 2026', 'hi')], has_next_page: false, next_cursor: '' });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const targets = await s.fetchVerificationTargets('blackfeather_ai');
    expect(new TextDecoder().decode(targets.rawBytes)).toBe(body);
  });

  it('throws TwitterApiIoRequestError on 401 (no retry)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('nope', { status: 401 }));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const err = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10).catch((e) => e);
    expect(err).toBeInstanceOf(TwitterApiIoRequestError);
    expect((err as TwitterApiIoRequestError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // #180: a drained balance must not read like any other scrape failure.
  it('flags credit exhaustion on 401 and carries the body + marker in the message', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('{"status":"error","msg":"Credits is not enough to make this request"}', { status: 401 }),
    );
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const err = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10).catch((e) => e);
    expect((err as TwitterApiIoRequestError).creditExhausted).toBe(true);
    expect(String(err)).toContain(CREDIT_EXHAUSTED_MARKER);
    expect(String(err)).toContain('Credits is not enough');
  });

  it('does not flag an ordinary 401 (revoked key) as credit exhaustion', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('{"status":"error","msg":"invalid api key"}', { status: 401 }),
    );
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const err = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10).catch((e) => e);
    expect((err as TwitterApiIoRequestError).creditExhausted).toBe(false);
    expect(String(err)).not.toContain(CREDIT_EXHAUSTED_MARKER);
    expect(String(err)).toContain('invalid api key');
  });

  it('stops retrying when a retriable status carries a credit-exhausted body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"msg":"Credits is not enough"}', { status: 429 }),
    );
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const err = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10).catch((e) => e);
    expect((err as TwitterApiIoRequestError).creditExhausted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on 429/5xx per ladder, succeeds when eventually 200', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rl', { status: 429 }))
      .mockResolvedValueOnce(new Response('oops', { status: 503 }))
      .mockResolvedValueOnce(page([TWEET('1', 'Fri Apr 24 00:00:00 +0000 2026', 'ok')]));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const posts = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(posts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('invokes cost observer with $0.15/1k rate, resultsCount incl. empty-call minimum', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([
      TWEET('1', 'Fri Apr 24 00:00:00 +0000 2026', 'a'),
      TWEET('2', 'Fri Apr 24 00:01:00 +0000 2026', 'b'),
      TWEET('3', 'Fri Apr 24 00:02:00 +0000 2026', 'c'),
    ]));
    const events: Array<{ resultsCount: number; estimatedCostUsd: number; platform: string; providerName: string }> = [];
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      onScrapeComplete: (e) => events.push({
        resultsCount: e.resultsCount,
        estimatedCostUsd: e.estimatedCostUsd,
        platform: e.platform,
        providerName: e.providerName,
      }),
    });
    await s.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(events).toHaveLength(1);
    expect(events[0]!.resultsCount).toBe(3);
    expect(events[0]!.platform).toBe('x');
    expect(events[0]!.providerName).toBe('twitterapi.io');
    // 3 × $0.00015, but provider's floor is $0.00015 min per call, so 3 × 0.00015 = $0.00045
    expect(events[0]!.estimatedCostUsd).toBeCloseTo(0.00045, 10);
  });

  it('empty-response cost is $0.00015 (API charges per call even with 0 tweets)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([]));
    const events: Array<{ resultsCount: number; estimatedCostUsd: number }> = [];
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      onScrapeComplete: (e) => events.push({
        resultsCount: e.resultsCount,
        estimatedCostUsd: e.estimatedCostUsd,
      }),
    });
    await s.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(events[0]!.resultsCount).toBe(0);
    expect(events[0]!.estimatedCostUsd).toBeCloseTo(0.00015, 10);
  });

  it('emits one cost event per HTTP call during cursor pagination', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page(
        Array.from({length: 10}, (_, i) => TWEET(`p1-${i}`, 'Fri Apr 24 00:00:00 +0000 2026', `t${i}`)),
        true,
        'cursor-page-2',
      ))
      .mockResolvedValueOnce(page(
        Array.from({length: 7}, (_, i) => TWEET(`p2-${i}`, 'Fri Apr 24 00:01:00 +0000 2026', `t${i}`)),
        false,
      ));
    const events: Array<{ resultsCount: number }> = [];
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      onScrapeComplete: (e) => events.push({ resultsCount: e.resultsCount }),
    });
    await s.scrapeTimeline('blackfeather_ai', new Date(0), 100);
    expect(events).toHaveLength(2);
    expect(events[0]!.resultsCount).toBe(10);
    expect(events[1]!.resultsCount).toBe(7);
    expect(events[0]!.resultsCount + events[1]!.resultsCount).toBe(17);
  });

  it('cost event includes latency measurement', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(page([
      TWEET('1', 'Fri Apr 24 00:00:00 +0000 2026', 'hi'),
    ]));
    const events: Array<{ latencyMs: number }> = [];
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
      onScrapeComplete: (e) => events.push({ latencyMs: e.latencyMs }),
    });
    await s.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(events).toHaveLength(1);
    expect(typeof events[0]!.latencyMs).toBe('number');
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('scrapeTimeline stops paginating when all tweets on a page are older than since', async () => {
    // Server-side since_time is a hint, not a hard filter. After crossing our
    // watermark, subsequent pages will be all-older — stop to avoid infinite
    // pagination + runaway cost.
    const since = new Date('2026-04-23T12:00:00Z');
    const fetchMock = vi.fn()
      // Page 1: mix of recent + old (API ignores since_time and returns 20 DESC).
      .mockResolvedValueOnce(page([
        TWEET('recent', 'Fri Apr 24 00:00:00 +0000 2026', 'recent'),
      ], true, 'cursor-page-2'))
      // Page 2: all tweets older than since → mapped is empty, must break.
      .mockResolvedValueOnce(page([
        TWEET('old1', 'Tue Apr 22 10:00:00 +0000 2026', 'too old'),
        TWEET('old2', 'Mon Apr 21 10:00:00 +0000 2026', 'too old'),
      ], true, 'cursor-page-3'))
      // Page 3 should NEVER be fetched — if it is, the test fails by timeout.
      .mockRejectedValue(new Error('page 3 should not be fetched'));
    const s = new TwitterApiIoScraper({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const posts = await s.scrapeTimeline('blackfeather_ai', since, 100);
    expect(posts.map((p) => p.id)).toEqual(['recent']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // extendedEntities.media parsing — ported from popclaw-sim-persona's
  // mapMedia (2026-07-31); mirror posts used to lose all media.
  describe('media parsing', () => {
    it('maps photo/video/animated_gif to image/video/gif, photo carrying the large size', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(page([
        TWEET('m1', 'Fri Apr 24 00:00:00 +0000 2026', 'with pic', {
          extendedEntities: { media: [
            { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/a.jpg', sizes: { large: { w: 2048, h: 1536 } } },
          ]},
        }),
        TWEET('m2', 'Fri Apr 24 00:01:00 +0000 2026', 'video (thumbnail URL, no HLS)', {
          extendedEntities: { media: [
            { type: 'video', media_url_https: 'https://pbs.twimg.com/media/v_thumb.jpg' },
          ]},
        }),
        TWEET('m3', 'Fri Apr 24 00:02:00 +0000 2026', 'gif', {
          extendedEntities: { media: [
            { type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/media/g_thumb.jpg' },
          ]},
        }),
        TWEET('m4', 'Fri Apr 24 00:03:00 +0000 2026', 'text only'),
      ]));
      const s = new TwitterApiIoScraper({
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      const posts = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10);
      expect(posts[0]!.media).toEqual([
        { kind: 'image', url: 'https://pbs.twimg.com/media/a.jpg', width: 2048, height: 1536 },
      ]);
      expect(posts[1]!.media).toEqual([
        { kind: 'video', url: 'https://pbs.twimg.com/media/v_thumb.jpg' },
      ]);
      expect(posts[2]!.media).toEqual([
        { kind: 'gif', url: 'https://pbs.twimg.com/media/g_thumb.jpg' },
      ]);
      expect(posts[3]!.media).toBeUndefined(); // absent, not an empty array
    });

    it('drops media entries without media_url_https; falls back to the medium size', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(page([
        TWEET('m1', 'Fri Apr 24 00:00:00 +0000 2026', 'mixed', {
          extendedEntities: { media: [
            { type: 'photo' }, // no URL → dropped
            { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/b.jpg', sizes: { medium: { w: 1200, h: 675 } } },
          ]},
        }),
      ]));
      const s = new TwitterApiIoScraper({
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      const posts = await s.scrapeTimeline('blackfeather_ai', new Date(0), 10);
      expect(posts[0]!.media).toEqual([
        { kind: 'image', url: 'https://pbs.twimg.com/media/b.jpg', width: 1200, height: 675 },
      ]);
    });
  });

  // ADR-0034: by-id direct fetch — the one channel that sees low-follower/new
  // accounts the search index is blind to.
  describe('fetchPostById', () => {
    it('hits /twitter/tweets?tweet_ids= and maps author + text + raw bytes', async () => {
      const body = JSON.stringify({ tweets: [TWEET('999', 'Sat Jul 26 00:00:00 +0000 2026', 'blackfeather_ai#abcdef')] });
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(body));
      const s = new TwitterApiIoScraper({
        apiKey: 'k-abc',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      const r = await s.fetchPostById('999');

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toContain('/twitter/tweets?tweet_ids=999');
      expect((init.headers as Record<string, string>)['x-api-key']).toBe('k-abc');
      expect(r.post!.id).toBe('999');
      expect(r.post!.text).toBe('blackfeather_ai#abcdef');
      expect(r.authorHandle).toBe('blackfeather_ai');
      expect(r.accountId).toBe('42');
      expect(new TextDecoder().decode(r.rawBytes)).toBe(body);
    });

    it('refuses a native retweet (author = retweeter; RT-bait must not pass the author check)', async () => {
      const rt = TWEET('999', 'Sat Jul 26 00:00:00 +0000 2026', 'victim#abcdef', {
        author: { userName: 'victim', id: '7' },
        retweeted_tweet: { id: 'orig-1' },
      });
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ tweets: [rt] })));
      const s = new TwitterApiIoScraper({
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      const r = await s.fetchPostById('999');
      expect(r.post).toBeNull();
    });

    it('refuses non-tweet placeholders (type !== tweet)', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify({ tweets: [{ type: 'mock_tweet', id: '999', text: 'x#s', createdAt: 'Sat Jul 26 00:00:00 +0000 2026' }] })),
      );
      const s = new TwitterApiIoScraper({
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      const r = await s.fetchPostById('999');
      expect(r.post).toBeNull();
    });

    it('returns post=null (with raw bytes) when the tweet is gone', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ tweets: [] })));
      const s = new TwitterApiIoScraper({
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      const r = await s.fetchPostById('999');
      expect(r.post).toBeNull();
      expect(r.rawBytes.length).toBeGreaterThan(0);
    });

    it('emits one CostEvent per call', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ tweets: [TWEET('999', 'Sat Jul 26 00:00:00 +0000 2026', 'x')] })))
        .mockResolvedValueOnce(new Response(JSON.stringify({ tweets: [] })));
      const events: Array<{ resultsCount: number; estimatedCostUsd: number }> = [];
      const s = new TwitterApiIoScraper({
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: async () => {},
        onScrapeComplete: (e) => events.push({ resultsCount: e.resultsCount, estimatedCostUsd: e.estimatedCostUsd }),
      });
      await s.fetchPostById('999');
      await s.fetchPostById('998');
      expect(events).toHaveLength(2);
      expect(events[0]!.resultsCount).toBe(1);
      expect(events[1]!.resultsCount).toBe(0);
      expect(events[1]!.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('throws on a non-JSON body so the caller can fall back', async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response('<html>nope</html>'));
      const s = new TwitterApiIoScraper({
        apiKey: 'k',
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        sleep: async () => {},
      });
      await expect(s.fetchPostById('999')).rejects.toBeInstanceOf(TwitterApiIoRequestError);
    });
  });
});
