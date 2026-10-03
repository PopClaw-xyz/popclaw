import { describe, it, expect, vi } from 'vitest';
import { WatchLoop } from '../../../src/watch/watch-loop';
import { WatchRegistry, defaultEntry } from '../../../src/watch/watch-registry';
import type { PlatformScraper, PlatformScraperRegistry, ScrapedPost } from '../../../src/scraper/platform-scraper';

function stubScraper(posts: ScrapedPost[]): PlatformScraper {
  return {
    fetchVerificationTargets: vi.fn(),
    scrapeTimeline: vi.fn().mockResolvedValue(posts),
  };
}

function xRegistry(scraper: PlatformScraper): PlatformScraperRegistry {
  return new Map([['x', scraper]]);
}

describe('WatchLoop', () => {
  it('picks due entries and emits a FeedPayload push per new post', async () => {
    const registry = new WatchRegistry();
    const now = 1000;
    registry.add('w1', 'TargetA', 'TargetA', 'x', defaultEntry(now - 1_000_000));
    registry.add('w2', 'TargetB', 'TargetB', 'x', defaultEntry(now + 10_000_000));

    const push = vi.fn();
    const scraper = stubScraper([
      { id: 'p1', text: 'hello', createdAt: new Date('2026-04-24T00:00:00Z'), originalUrl: 'https://x.com/TargetA/status/p1' },
    ]);

    const loop = new WatchLoop({
      registry,
      scraperRegistry: xRegistry(scraper),
      push,
      maxScanItems: 20,
    });
    await loop.tick(now);

    expect(scraper.scrapeTimeline).toHaveBeenCalledTimes(1);
    expect(scraper.scrapeTimeline).toHaveBeenCalledWith('TargetA', expect.any(Date), 20, '');
    expect(push).toHaveBeenCalledTimes(1);
    const feed = push.mock.calls[0]![0];
    expect(feed.platform).toBe('x');
    expect(feed.platformPostId).toBe('p1');
    expect(feed.authorPopclawId).toBe('TargetA');
    expect(feed.text).toBe('hello');
  });

  it('carries scraped media through to the push (mirror posts must not lose images)', async () => {
    const registry = new WatchRegistry();
    const now = 1000;
    registry.add('w1', 'TargetA', 'TargetA', 'x', defaultEntry(now - 1_000_000));

    const push = vi.fn();
    const scraper = stubScraper([
      {
        id: 'p9',
        text: '',
        createdAt: new Date('2026-07-31T00:00:00Z'),
        originalUrl: 'https://x.com/TargetA/status/p9',
        media: [
          { kind: 'image', url: 'https://pbs.twimg.com/media/abc.jpg', width: 2048, height: 1756 },
          { kind: 'video', url: 'https://pbs.twimg.com/media/thumb.jpg' },
        ],
      },
    ]);

    const loop = new WatchLoop({
      registry,
      scraperRegistry: xRegistry(scraper),
      push,
      maxScanItems: 20,
    });
    await loop.tick(now);

    expect(push).toHaveBeenCalledTimes(1);
    const feed = push.mock.calls[0]![0];
    expect(feed.media).toHaveLength(2);
    expect(feed.media[0]).toMatchObject({ kind: 'image', width: 2048 });
    expect(feed.media[1].kind).toBe('video');
  });

  it('miss tick increments consecutive_misses', async () => {
    const registry = new WatchRegistry();
    // Seed well before `nowMs` so the warm-tier nextPollAtMs (+5min) is already due at tick time.
    registry.add('w1', 'TargetA', 'TargetA', 'x', defaultEntry(-1_000_000));
    const push = vi.fn();
    const scraper = stubScraper([]);

    const loop = new WatchLoop({
      registry,
      scraperRegistry: xRegistry(scraper),
      push,
      maxScanItems: 20,
    });
    await loop.tick(1_000);

    const entry = registry.all().find((e) => e.watchId === 'w1')!;
    expect(entry.state.consecutiveMisses).toBe(1);
    expect(entry.state.consecutiveHits).toBe(0);
    expect(push).not.toHaveBeenCalled();
  });

  it('scraper failure on one slice does not block others', async () => {
    const registry = new WatchRegistry();
    registry.add('wA', 'TargetA', 'TargetA', 'x', defaultEntry(-1_000_000));
    registry.add('wB', 'TargetB', 'TargetB', 'x', defaultEntry(-1_000_000));

    const push = vi.fn();
    const scraper: PlatformScraper = {
      fetchVerificationTargets: vi.fn(),
      scrapeTimeline: vi.fn()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce([
          { id: 'pB', text: 'hi', createdAt: new Date('2026-04-24T00:00:00Z'), originalUrl: 'https://x.com/TargetB/status/pB' },
        ]),
    };

    const loop = new WatchLoop({
      registry,
      scraperRegistry: xRegistry(scraper),
      push,
      maxScanItems: 20,
    });
    await loop.tick(1_000);

    expect(push).toHaveBeenCalledTimes(1);
    const a = registry.all().find((e) => e.targetPopclawId === 'TargetA')!;
    expect(a.state.consecutiveMisses).toBe(1);
  });

  it('newest-created-at wins lastSeenCreatedAt after a multi-post tick', async () => {
    const registry = new WatchRegistry();
    registry.add('w1', 'TargetA', 'TargetA', 'x', defaultEntry(-1_000_000));

    const push = vi.fn();
    const scraper = stubScraper([
      { id: 'p_newer', text: 'newer', createdAt: new Date('2026-04-24T00:05:00Z'), originalUrl: 'https://x.com/TargetA/status/p_newer' },
      { id: 'p_older', text: 'older', createdAt: new Date('2026-04-24T00:01:00Z'), originalUrl: 'https://x.com/TargetA/status/p_older' },
    ]);
    const loop = new WatchLoop({
      registry, scraperRegistry: xRegistry(scraper), push,
      maxScanItems: 20,
    });
    await loop.tick(1_000);

    expect(push).toHaveBeenCalledTimes(2);
    const entry = registry.all()[0]!;
    expect(entry.state.lastSeenCreatedAt).toBe(Math.floor(new Date('2026-04-24T00:05:00Z').getTime() / 1000));
    expect(entry.state.consecutiveHits).toBe(1);
  });

  it('boundary echo (post at exactly lastSeenCreatedAt) counts as miss, not hit', async () => {
    // Regression: prior to fix, watch-loop counted any non-empty posts array
    // as hit; combined with scrapers' boundary-inclusive `>=` filter, this
    // re-counted the previously-seen post as new every tick, pinning the
    // entry in HOT (30s) tier indefinitely and burning API budget.
    //
    // Scraper bug aside, the loop should treat "no posts strictly newer than
    // lastSeenCreatedAt" as a miss even if the scraper hands back the
    // boundary post (defense-in-depth).
    const registry = new WatchRegistry();
    const lastSeenSecs = Math.floor(new Date('2026-04-24T00:00:00Z').getTime() / 1000);
    registry.add('w1', 'TargetA', 'TargetA', 'x', {
      consecutiveHits: 5,           // already in HOT
      consecutiveMisses: 0,
      lastSeenCreatedAt: lastSeenSecs, lastSeenPlatformPostId: '',
      nextPollAtMs: -1_000_000,     // already due
    });

    const push = vi.fn();
    const boundaryPost: ScrapedPost = {
      id: 'p_boundary',
      text: 'echo',
      createdAt: new Date(lastSeenSecs * 1000),    // exactly at boundary
      originalUrl: 'https://x.com/TargetA/status/p_boundary',
    };
    const scraper = stubScraper([boundaryPost]);

    const loop = new WatchLoop({
      registry,
      scraperRegistry: xRegistry(scraper),
      push,
      maxScanItems: 20,
    });
    await loop.tick(1_000);

    const entry = registry.all()[0]!;
    expect(entry.state.consecutiveMisses).toBe(1);
    expect(entry.state.consecutiveHits).toBe(0);
    expect(entry.state.lastSeenCreatedAt).toBe(lastSeenSecs);    // unchanged
    // The loop trusts the scraper for *what* to push (lore-house dedups by
    // post_id); the fix is hit/miss accounting, not push filtering. So
    // push may still be called for a boundary echo if the scraper hands
    // it back — we don't assert against that here.
  });

  it('hit only when newestSecs strictly greater than lastSeenCreatedAt', async () => {
    // Mixed batch: one boundary echo + one truly new. Post is new only by 1s,
    // but that's enough — the loop should hit, push only the new one, and
    // advance lastSeenCreatedAt.
    const registry = new WatchRegistry();
    const lastSeenSecs = Math.floor(new Date('2026-04-24T00:00:00Z').getTime() / 1000);
    registry.add('w1', 'TargetA', 'TargetA', 'x', {
      consecutiveHits: 0,
      consecutiveMisses: 0,
      lastSeenCreatedAt: lastSeenSecs, lastSeenPlatformPostId: '',
      nextPollAtMs: -1_000_000,
    });

    const push = vi.fn();
    const scraper = stubScraper([
      {
        id: 'p_boundary',
        text: 'echo',
        createdAt: new Date(lastSeenSecs * 1000),
        originalUrl: 'https://x.com/TargetA/status/p_boundary',
      },
      {
        id: 'p_new',
        text: 'fresh',
        createdAt: new Date((lastSeenSecs + 1) * 1000),
        originalUrl: 'https://x.com/TargetA/status/p_new',
      },
    ]);

    const loop = new WatchLoop({
      registry,
      scraperRegistry: xRegistry(scraper),
      push,
      maxScanItems: 20,
    });
    await loop.tick(1_000);

    const entry = registry.all()[0]!;
    expect(entry.state.consecutiveHits).toBe(1);
    expect(entry.state.consecutiveMisses).toBe(0);
    expect(entry.state.lastSeenCreatedAt).toBe(lastSeenSecs + 1);
    // Boundary post still pushed (loop trusts the scraper for *what* to push;
    // only the hit/miss accounting is hardened). Scraper-level filter test
    // covers dropping the echo at the source.
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('skips with warn when target.platform has no scraper in registry', async () => {
    const registry = new WatchRegistry();
    // Seed an 'x' entry that is already due (lastPollAtMs well in the past).
    registry.add('w1', 'TargetA', 'TargetA', 'x', defaultEntry(-1_000_000));

    const scraperRegistry: PlatformScraperRegistry = new Map(); // empty — no 'x' entry
    const push = vi.fn();
    const warns: string[] = [];

    const loop = new WatchLoop({
      registry,
      scraperRegistry,
      push,
      maxScanItems: 20,
      loggerInfo: () => {},
      loggerWarn: (m) => warns.push(m),
    });
    await loop.tick(1_000);

    expect(push).not.toHaveBeenCalled();
    expect(warns.some((w) => w.includes("no scraper for platform 'x'"))).toBe(true);
    expect(warns.some((w) => w.includes('TargetA'))).toBe(true);
  });

  it('budget guard tripped → short-circuits to miss without calling scraper (Plan 10.14)', async () => {
    const registry = new WatchRegistry();
    registry.add('w1', 'TargetA', 'TargetA', 'x', defaultEntry(-1_000_000));

    const push = vi.fn();
    const scraper = stubScraper([
      { id: 'p1', text: 'hi', createdAt: new Date('2026-04-24T00:00:00Z'), originalUrl: 'https://x.com/TargetA/status/p1' },
    ]);

    const loop = new WatchLoop({
      registry,
      scraperRegistry: xRegistry(scraper),
      push,
      maxScanItems: 20,
      budgetGuard: { isTripped: () => true },
    });
    await loop.tick(1_000);

    expect(scraper.scrapeTimeline).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    const entry = registry.all().find((e) => e.watchId === 'w1')!;
    expect(entry.state.consecutiveMisses).toBe(1);
    expect(entry.state.consecutiveHits).toBe(0);
  });

  it('budget guard not tripped → normal scrape path (Plan 10.14)', async () => {
    const registry = new WatchRegistry();
    registry.add('w1', 'TargetA', 'TargetA', 'x', defaultEntry(-1_000_000));

    const push = vi.fn();
    const scraper = stubScraper([
      { id: 'p1', text: 'hi', createdAt: new Date('2026-04-24T00:00:00Z'), originalUrl: 'https://x.com/TargetA/status/p1' },
    ]);

    const loop = new WatchLoop({
      registry,
      scraperRegistry: xRegistry(scraper),
      push,
      maxScanItems: 20,
      budgetGuard: { isTripped: () => false },
    });
    await loop.tick(1_000);

    expect(scraper.scrapeTimeline).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
  });
});
