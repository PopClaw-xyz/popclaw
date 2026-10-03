import { describe, it, expect, vi } from 'vitest';
import { apifyInstagram } from '../../../../src/scraper/commercial/apify-instagram';

// sones/instagram-posts-scraper-lowcost output shape
// - code: shortcode e.g. "DXg_ZGfHKmT"
// - post_url: full URL
// - caption: { pk: string, text: string } | null  (NOT a plain string!)
// - taken_at: Unix seconds (integer)
// - id: compound "postId_userId" — ignored, we use `code`
const IG = (
  code: string,
  takenAt: number,
  captionText: string,
  extra: Record<string, unknown> = {},
) => ({
  id: `${code}_42`,        // compound id — we ignore this and use `code`
  code,
  post_url: `https://www.instagram.com/p/${code}/`,
  caption: captionText === '' ? null : { pk: '0', text: captionText },
  taken_at: takenAt,       // Unix seconds
  media_type: 1,
  user: { username: 'natgeo' },
  ...extra,
});

describe('apifyInstagram (sones/instagram-posts-scraper-lowcost)', () => {
  it('scrapeTimeline maps sones IG shape, honours since filter', async () => {
    // 2026-04-24T10:00:00Z  → Unix 1777024800  (recent — should pass filter)
    // 2026-04-20T00:00:00Z  → Unix 1776643200  (too old — should be filtered out)
    const recentAt = 1777024800;
    const tooOldAt = 1776643200;

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        IG('DXg_ZGfHKmT', recentAt, 'recent caption'),
        IG('OLDxxxxyyy', tooOldAt, 'too old caption'),
      ])),
    );

    const scraper = apifyInstagram('tok-ig', undefined, { fetch: fetchMock, sleep: async () => {} });
    const since = new Date('2026-04-23T00:00:00Z');
    const posts = await scraper.scrapeTimeline('natgeo', since, 50);

    // Only the recent post passes the since filter
    expect(posts.map((p) => p.id)).toEqual(['DXg_ZGfHKmT']);
    expect(posts[0]!.originalUrl).toBe('https://www.instagram.com/p/DXg_ZGfHKmT/');
    expect(posts[0]!.text).toBe('recent caption');
    expect(posts[0]!.createdAt.getTime()).toBe(recentAt * 1000);

    // Verify the HTTP call used the sones actor and correct input shape
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('sones~instagram-posts-scraper-lowcost');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      usernames: ['natgeo'],
      postsPerProfile: 50,
    });
  });

  it('fetchVerificationTargets returns empty (no HTTP call made)', async () => {
    const fetchMock = vi.fn();
    const scraper = apifyInstagram('tok-ig', undefined, { fetch: fetchMock, sleep: async () => {} });
    const targets = await scraper.fetchVerificationTargets('natgeo');
    expect(targets.firstPost).toBeNull();
    expect(targets.selfReplies).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('invokes cost observer with per-result rate plus flat per-run cost', async () => {
    // 2 items × $0.0002 + $0.007 flat per run (Apify bill 2026-09-02: $0.011/run @ 20 results)
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        IG('AAA111', 1777024800, 'first'),
        IG('BBB222', 1777024860, 'second'),
      ])),
    );

    const events: Array<{ resultsCount: number; estimatedCostUsd: number; platform: string }> = [];
    const scraper = apifyInstagram(
      'tok-ig',
      (e) => events.push({ resultsCount: e.resultsCount, estimatedCostUsd: e.estimatedCostUsd, platform: e.platform }),
      { fetch: fetchMock, sleep: async () => {} },
    );

    await scraper.scrapeTimeline('natgeo', new Date(0), 10);

    expect(events).toHaveLength(1);
    expect(events[0]!.resultsCount).toBe(2);
    expect(events[0]!.estimatedCostUsd).toBeCloseTo(0.0074, 10);
    expect(events[0]!.platform).toBe('instagram');
  });

  it('handles empty caption object or null caption gracefully', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify([
        // caption: null  → text should be ''
        IG('NULL_CAP', 1777024800, ''),
        // caption: { pk, text: '' } → text should be ''
        {
          id: 'EMPTY_CAP_42',
          code: 'EMPTY_CAP',
          post_url: 'https://www.instagram.com/p/EMPTY_CAP/',
          caption: { pk: '0', text: '' },
          taken_at: 1777024900,
          media_type: 1,
          user: { username: 'natgeo' },
        },
      ])),
    );

    const scraper = apifyInstagram('tok-ig', undefined, { fetch: fetchMock, sleep: async () => {} });
    const posts = await scraper.scrapeTimeline('natgeo', new Date(0), 10);

    expect(posts).toHaveLength(2);
    expect(posts[0]!.id).toBe('NULL_CAP');
    expect(posts[0]!.text).toBe('');
    expect(posts[1]!.id).toBe('EMPTY_CAP');
    expect(posts[1]!.text).toBe('');
  });
});
