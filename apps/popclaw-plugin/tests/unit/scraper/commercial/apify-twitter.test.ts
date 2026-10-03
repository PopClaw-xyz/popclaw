import { describe, it, expect, vi } from 'vitest';
import { apifyTwitter } from '../../../../src/scraper/commercial/apify-twitter';

/**
 * KAITO_TWEET_SHAPE mirrors the live shape probed from the
 * kaitoeasyapi actor (Apr 2026). Key quirks:
 *   - `createdAt` is Twitter RFC-2822 ("Fri Apr 24 02:30:17 +0000 2026"),
 *     not ISO-8601. JS `new Date(...)` parses it natively.
 *   - `type` distinguishes real tweets from placeholder mock_tweet/demo
 *     objects the actor emits when its backend has nothing.
 *   - Retweets are excluded server-side by `from:handle`, so no
 *     `isRetweet` field is needed.
 */
const KAITO_TWEET_SHAPE = (
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
  ...extra,
});

describe('apifyTwitter', () => {
  it('scrapeTimeline maps kaitoeasyapi tweet shape, drops mock placeholders, honours since filter', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        KAITO_TWEET_SHAPE('1001', 'Fri Apr 24 10:00:00 +0000 2026', 'recent'),
        { type: 'mock_tweet', id: -1, text: 'ignored placeholder' },
        KAITO_TWEET_SHAPE('1003', 'Mon Apr 20 00:00:00 +0000 2026', 'too old'),
      ])),
    );
    const scraper = apifyTwitter('tok-x', undefined, { fetch: fetchMock, sleep: async () => {} });
    const since = new Date('2026-04-23T00:00:00Z');
    const posts = await scraper.scrapeTimeline('blackfeather_ai', since, 100);

    expect(posts.map((p) => p.id)).toEqual(['1001']);
    expect(posts[0]!.originalUrl).toBe('https://x.com/blackfeather_ai/status/1001');
    expect(posts[0]!.text).toBe('recent');
    expect(posts[0]!.createdAt.toISOString()).toBe('2026-04-24T10:00:00.000Z');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('kaitoeasyapi~twitter-x-data-tweet-scraper-pay-per-result-cheapest');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ from: 'blackfeather_ai', maxItems: 100, queryType: 'Latest' });
  });

  it('drops the boundary post when its createdAt equals `since` exactly', async () => {
    // Regression: scrapers used `>= sinceMs` which re-returned the
    // last-seen post every tick. Combined with watch-loop's hit-detection
    // bug this pinned every handle in HOT tier (30s polling) and burned
    // ~14× the expected API quota. With strict `>`, the boundary post is
    // dropped; only strictly-newer posts pass through.
    const boundaryIso = '2026-04-24T00:00:00Z';
    // Twitter RFC-2822 form for the same instant.
    const boundaryRfc = 'Fri Apr 24 00:00:00 +0000 2026';
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        KAITO_TWEET_SHAPE('boundary', boundaryRfc, 'echo of last seen'),
        KAITO_TWEET_SHAPE('newer', 'Fri Apr 24 00:00:01 +0000 2026', '1s newer'),
      ])),
    );
    const scraper = apifyTwitter('tok-x', undefined, { fetch: fetchMock, sleep: async () => {} });
    const since = new Date(boundaryIso);
    const posts = await scraper.scrapeTimeline('blackfeather_ai', since, 100);

    expect(posts.map((p) => p.id)).toEqual(['newer']);
  });

  it('fetchVerificationTargets picks earliest real tweet as firstPost (ignores mock placeholders)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        KAITO_TWEET_SHAPE('newer', 'Tue Apr 22 00:00:00 +0000 2026', 'newer post'),
        { type: 'mock_tweet', id: -1, text: 'placeholder — should be skipped' },
        KAITO_TWEET_SHAPE('firstpost', 'Sun Apr 05 00:00:00 +0000 2026', 'hi 4d83f9'),
      ])),
    );
    const scraper = apifyTwitter('tok-x', undefined, { fetch: fetchMock, sleep: async () => {} });
    const targets = await scraper.fetchVerificationTargets('blackfeather_ai');

    expect(targets.firstPost?.id).toBe('firstpost');
    expect(targets.firstPost?.text).toContain('4d83f9');
  });

  it('fetchVerificationTargets walks self-replies (inReplyToUsername==handle) only', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        KAITO_TWEET_SHAPE('p1', 'Mon Apr 20 00:00:00 +0000 2026', 'first'),
        KAITO_TWEET_SHAPE('p2', 'Tue Apr 21 00:00:00 +0000 2026', 'self reply', {
          isReply: true,
          inReplyToUsername: 'blackfeather_ai',
          inReplyToId: 'p1',
        }),
        KAITO_TWEET_SHAPE('p3', 'Wed Apr 22 00:00:00 +0000 2026', 'reply to other', {
          isReply: true,
          inReplyToUsername: 'other',
          inReplyToId: '999',
        }),
      ])),
    );
    const scraper = apifyTwitter('tok-x', undefined, { fetch: fetchMock, sleep: async () => {} });
    const targets = await scraper.fetchVerificationTargets('blackfeather_ai');

    expect(targets.selfReplies).toHaveLength(1);
    expect(targets.selfReplies[0]!.id).toBe('p2');
    expect(targets.selfReplies[0]!.parentPostId).toBe('p1');
  });

  it('fetchVerificationTargets matches self-replies case-insensitively (X handles are case-insensitive)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        KAITO_TWEET_SHAPE('p2', 'Tue Apr 21 00:00:00 +0000 2026', 'self reply', {
          isReply: true,
          inReplyToUsername: 'blackfeather_ai',
          inReplyToId: 'p1',
        }),
      ])),
    );
    const scraper = apifyTwitter('tok-x', undefined, { fetch: fetchMock, sleep: async () => {} });
    const targets = await scraper.fetchVerificationTargets('Blackfeather_AI');

    expect(targets.selfReplies).toHaveLength(1);
    expect(targets.selfReplies[0]!.id).toBe('p2');
  });

  it('invokes cost observer with $0.25/1k rate', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        KAITO_TWEET_SHAPE('1', 'Fri Apr 24 00:00:00 +0000 2026', 'a'),
        KAITO_TWEET_SHAPE('2', 'Fri Apr 24 00:01:00 +0000 2026', 'b'),
        KAITO_TWEET_SHAPE('3', 'Fri Apr 24 00:02:00 +0000 2026', 'c'),
      ])),
    );
    const events: Array<{ resultsCount: number; estimatedCostUsd: number }> = [];
    const scraper = apifyTwitter(
      'tok-x',
      (e) => events.push({ resultsCount: e.resultsCount, estimatedCostUsd: e.estimatedCostUsd }),
      { fetch: fetchMock, sleep: async () => {} },
    );
    await scraper.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(events).toHaveLength(1);
    expect(events[0]!.resultsCount).toBe(3);
    expect(events[0]!.estimatedCostUsd).toBeCloseTo(0.00075, 10);
  });
});
