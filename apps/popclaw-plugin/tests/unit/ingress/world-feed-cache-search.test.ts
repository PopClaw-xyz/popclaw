/**
 * Keyword search over the local WorldFeedCache.
 *
 * Powers `/popclaw search <keyword>` + the `popclaw_search_feed` tool:
 * find cached posts whose body-preview / handle / source-url contain ALL
 * of the query terms, newest-first, so the agent can summarise them and
 * hand over the original_url for deeper digging.
 */
import { describe, it, expect } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { matchesQuery, type CachedFeedItem } from '../../../src/ingress/world-feed-cache';
import { makeCache, bytesOf, item } from '../../helpers/world-feed-cache';

function cached(over: Partial<CachedFeedItem> = {}): CachedFeedItem {
  return {
    platform: 'x',
    platformPostId: 'pid',
    eventId: '',
    platformPostCreatedAt: 1_700_000_000,
    authorPopclawId: 'authorA',
    handle: 'someone',
    originalUrl: 'https://x.com/someone/status/pid',
    textPreview: 'hello world',
    ...over,
  };
}

const rec = (
  cache: Awaited<ReturnType<typeof makeCache>>['cache'],
  over: Partial<popclaw.event.IWorldFeedItem>,
) => {
  const it_ = item(over);
  cache.record(it_, bytesOf(it_));
};

describe('matchesQuery', () => {
  it('matches a term in the text preview (case-insensitive)', () => {
    expect(matchesQuery(cached({ textPreview: 'Big SpaceX launch today' }), 'spacex')).toBe(true);
  });

  it('matches a term in the handle ("elon" → handle "elonmusk")', () => {
    expect(matchesQuery(cached({ handle: 'elonmusk', textPreview: 'gm' }), 'elon')).toBe(true);
  });

  it('requires ALL whitespace-split terms to be present (AND)', () => {
    const both = cached({ handle: 'elonmusk', textPreview: 'Musk on Mars' });
    expect(matchesQuery(both, 'elon musk')).toBe(true);
    const oneMissing = cached({ handle: 'elonmusk', textPreview: 'gm' });
    expect(matchesQuery(oneMissing, 'elon spacex')).toBe(false);
  });

  it('returns false when nothing matches', () => {
    expect(matchesQuery(cached({ textPreview: 'cats and dogs', handle: 'petlover' }), 'spacex')).toBe(false);
  });

  it('returns false for an empty / whitespace-only query', () => {
    expect(matchesQuery(cached(), '')).toBe(false);
    expect(matchesQuery(cached(), '   ')).toBe(false);
  });
});

describe('WorldFeedCache.search', () => {
  it('returns matching items newest-first, sliced to n', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'a', handle: 'elonmusk', textPreview: 'SpaceX update', platformPostCreatedAt: 100 });
    rec(cache, { platformPostId: 'b', handle: 'natgeo', textPreview: 'about spacex rockets', platformPostCreatedAt: 300 });
    rec(cache, { platformPostId: 'c', handle: 'chef', textPreview: 'pasta recipe', platformPostCreatedAt: 200 });

    const hits = cache.search('spacex', 10);
    expect(hits.map((h) => h.platformPostId)).toEqual(['b', 'a']); // newest-first; 'c' excluded
  });

  it('respects the limit n', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'a', textPreview: 'spacex 1', platformPostCreatedAt: 100 });
    rec(cache, { platformPostId: 'b', textPreview: 'spacex 2', platformPostCreatedAt: 200 });
    expect(cache.search('spacex', 1).map((h) => h.platformPostId)).toEqual(['b']);
  });

  it('returns [] for an empty query', async () => {
    const { cache } = await makeCache();
    rec(cache, { platformPostId: 'a', textPreview: 'anything' });
    expect(cache.search('', 10)).toEqual([]);
  });
});
