/**
 * /popclaw search <keyword> — find cached posts about a topic/person and
 * surface their body-preview + source link, so the agent (or the owner)
 * can read them now and follow original_url for deeper detail.
 */
import { describe, it, expect } from 'vitest';
import { runPopclawSearchCommand } from '../../../src/commands/popclaw-search';
import type { popclaw } from '@popclaw/contracts';
import { makeCache, bytesOf, item } from '../../helpers/world-feed-cache';
import type { WorldFeedCache } from '../../../src/ingress/world-feed-cache';

async function freshCache(items: popclaw.event.IWorldFeedItem[]): Promise<WorldFeedCache> {
  const { cache } = await makeCache();
  for (const it of items) cache.record(it, bytesOf(it));
  return cache;
}

describe('runPopclawSearchCommand', () => {
  it('lists matches with body preview AND the source link', async () => {
    const cache = await freshCache([
      item({
        platformPostId: 'a',
        handle: 'spacex',
        textPreview: 'Starship test flight scheduled',
        originalUrl: 'https://x.com/spacex/status/a',
      }),
    ]);
    const { text } = await runPopclawSearchCommand({ positional: ['starship'], flags: {} }, cache);
    expect(text).toContain('Starship test flight scheduled'); // body preview, served now
    expect(text).toContain('https://x.com/spacex/status/a');  // source link, for deeper digging
    expect(text).toContain('starship');                       // echoes the query
  });

  it('asks for a keyword when none is given', async () => {
    const cache = await freshCache([]);
    const { text } = await runPopclawSearchCommand({ positional: [], flags: {} }, cache);
    expect(text.toLowerCase()).toContain('keyword');
  });

  it('reports no matches gracefully (echoes the query)', async () => {
    const cache = await freshCache([item({ textPreview: 'cats and dogs', handle: 'petlover' })]);
    const { text } = await runPopclawSearchCommand({ positional: ['spacex'], flags: {} }, cache);
    expect(text).toContain('spacex');
    expect(text.toLowerCase()).toContain('no match');
  });
});

it('public search uses the narrow reader and reports local-empty without the legacy cache', async () => {
  const calls: unknown[] = [];
  const display = { search: (...args: unknown[]) => { calls.push(args); return { items: [], sources: [], truncated: false }; } };
  const { text } = await runPopclawSearchCommand({ positional: ['signed', 'topic'], flags: { limit: '4' } },
    { search: () => { throw new Error('legacy cache accessed'); } } as never, display as never);
  expect(calls).toEqual([['signed topic', 4]]); expect(text).toContain('signed topic');
  expect(text).not.toContain('/popclaw scrape'); expect(text).not.toContain('no matches in the cached feed');
});
