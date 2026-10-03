import { describe, it, expect, beforeAll } from 'vitest';
import { makeCache, bytesOf, item } from '../../helpers/world-feed-cache';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { readLastFrameAt, houseSilenceText, houseSilenceOf } from '../../../src/ingress/house-silence';
import { WorldFeedCatalog, type HouseFeed } from '../../../src/ingress/world-feed-catalog';
import { setOwnerLang } from '../../../src/lexicon/owner-language';

// #588: a house outage and a quiet world look identical to the agent. The
// only fact that separates them is "when did this house last deliver a
// frame", and that fact lives in the per-house cache's received_at column.

describe('readLastFrameAt', () => {
  it('is null on an empty cache — never 0, which would read as 1970', async () => {
    const { db } = await makeCache();
    expect(readLastFrameAt(db)).toBeNull();
  });

  it('is the newest received_at, not the newest post time', async () => {
    const { cache, db } = await makeCache();
    // An old post that arrived late is still the most recent FRAME.
    const a = item({ platformPostId: 'a', platformPostCreatedAt: 900 });
    cache.record(a, bytesOf(a), 1_700_000_100);
    const b = item({ platformPostId: 'b', platformPostCreatedAt: 100 });
    cache.record(b, bytesOf(b), 1_700_000_500);
    expect(readLastFrameAt(db)).toBe(1_700_000_500);
  });

  it("a database we cannot query says so — 'unreadable', never a false 'never'", () => {
    // A healthy house whose cache is locked or missing its table must not be
    // reported as one that has never spoken; that is the exact false alarm
    // this feature exists to prevent.
    const db = new LocalHostDb(':memory:');
    expect(readLastFrameAt(db)).toBe('unreadable');
  });
});

describe('houseSilenceText', () => {
  beforeAll(() => setOwnerLang('en', 'config'));

  it('names the house and when its last frame landed', () => {
    const text = houseSilenceText(
      [{ slug: 'popclaw-me', lastFrameAt: 1_700_000_000 }],
      { nowSec: 1_700_086_400, tz: 'UTC', lang: 'en' },
    );
    expect(text).toContain('popclaw-me');
    expect(text).toContain('2023-11-14');
    expect(text).toContain('1d ago');
  });

  it('says never for a house that has never delivered a frame', () => {
    const text = houseSilenceText(
      [{ slug: 'house-popclaw-world', lastFrameAt: null }],
      { nowSec: 1_700_086_400, tz: 'UTC', lang: 'en' },
    );
    expect(text).toContain('house-popclaw-world');
    expect(text.toLowerCase()).toContain('never');
  });

  it('an unreadable cache reads as unreadable, not as never', () => {
    const text = houseSilenceText(
      [{ slug: 'popclaw-me', lastFrameAt: 'unreadable' }],
      { nowSec: 1_700_086_400, tz: 'UTC', lang: 'en' },
    );
    expect(text).toContain('popclaw-me');
    expect(text).toMatch(/could not read/i);
    expect(text.toLowerCase()).not.toContain('never received');
  });

  it('is empty when there is nothing to say — the caller appends it blind', () => {
    expect(houseSilenceText([], { nowSec: 1_700_086_400, tz: 'UTC', lang: 'en' })).toBe('');
  });

  it('lists every mounted house, one line each', () => {
    const text = houseSilenceText(
      [
        { slug: 'popclaw-me', lastFrameAt: 1_700_000_000 },
        { slug: 'house-popclaw-world', lastFrameAt: null },
      ],
      { nowSec: 1_700_086_400, tz: 'UTC', lang: 'en' },
    );
    expect(text).toContain('popclaw-me');
    expect(text).toContain('house-popclaw-world');
  });

  it('renders in zh-CN too', () => {
    const text = houseSilenceText(
      [{ slug: 'popclaw-me', lastFrameAt: null }],
      { nowSec: 1_700_086_400, tz: 'UTC', lang: 'zh-CN' },
    );
    expect(text).toContain('popclaw-me');
    expect(text).not.toContain('world.silence');
  });
});

// `houseSilenceOf` reads `rt.worldFeedCache.houseSilence()` behind a cast, from
// `ingress/` — outside the reach of tests/unit/runtime-contract.test.ts, which
// only scans `src/tools/`. So a rename on either side would silently turn the
// outage line off and nothing would fail. This pins the duck type against the
// real class the gateway actually puts in that slot.
describe('houseSilenceOf — the duck type the tools read through', () => {
  it('a real WorldFeedCatalog satisfies it, and reports one entry per house', async () => {
    const houses: HouseFeed[] = [];
    for (const slug of ['popclaw-me', 'house-popclaw-world']) {
      const { cache } = await makeCache();
      houses.push({
        slug,
        baseUrl: `https://${slug}`,
        cache,
        dbPath: ':memory:',
        snapshot: { fetchSnapshot: async () => [] },
      });
    }
    const it_ = item({ platformPostId: 'p1' });
    houses[0]!.cache.record(it_, bytesOf(it_), 1_700_000_500);

    const got = houseSilenceOf({ worldFeedCache: new WorldFeedCatalog(houses) });

    expect(got).toEqual([
      { slug: 'popclaw-me', lastFrameAt: 1_700_000_500 },
      { slug: 'house-popclaw-world', lastFrameAt: null },
    ]);
  });

  it('a runtime bag without the slot degrades to saying nothing', () => {
    expect(houseSilenceOf({})).toEqual([]);
    expect(houseSilenceOf(undefined)).toEqual([]);
  });
});
