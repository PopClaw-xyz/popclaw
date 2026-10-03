/**
 * DegradationDetector — wraps a PlatformScraper, tracks consecutive empty
 * results, throws ProviderDegradedError to trigger HybridScraper failover.
 *
 * Motivated by Plan 10.13.1 follow-up: TwitterAPI.io's search endpoints
 * went silently degraded (HTTP 200 + empty tweets array) on 2026-04-27.
 * Without the detector, we'd just see a quiet feed; with it, we trip after
 * N empties and Apify takes over within seconds.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DegradationDetector,
  ProviderDegradedError,
} from '../../../../src/scraper/commercial/degradation-detector';
import type { PlatformScraper, ScrapedPost, VerificationTargets } from '../../../../src/scraper/platform-scraper';

function postsAt(times: string[]): ScrapedPost[] {
  return times.map((t, i) => ({
    id: `id-${i}`,
    text: `t-${i}`,
    createdAt: new Date(t),
    originalUrl: `https://example.com/${i}`,
  }));
}

function emptyTargets(): VerificationTargets {
  return { firstPost: null, selfReplies: [], rawBytes: new Uint8Array(0) };
}

function nonEmptyTargets(): VerificationTargets {
  return {
    firstPost: { id: 'p1', text: 'hi', createdAt: new Date(0) },
    selfReplies: [],
    rawBytes: new Uint8Array(0),
  };
}

function stubInner(): PlatformScraper & {
  scrapeTimeline: ReturnType<typeof vi.fn>;
  fetchVerificationTargets: ReturnType<typeof vi.fn>;
} {
  return {
    scrapeTimeline: vi.fn(),
    fetchVerificationTargets: vi.fn(),
  };
}

describe('DegradationDetector', () => {
  it('does NOT count an empty cursored poll as a degradation signal', async () => {
    // since_id makes "nothing new" the expected success case for a quiet
    // handle. Before this guard, 5 quiet polls tripped a 30-min failover.
    const inner = {
      scrapeTimeline: vi.fn().mockResolvedValue([]),
      fetchVerificationTargets: vi.fn(),
    } as unknown as PlatformScraper;
    const d = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1000,
    });

    for (let i = 0; i < 6; i++) {
      await expect(d.scrapeTimeline('quiet', new Date(0), 20, 'tweet-1')).resolves.toEqual([]);
    }
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(6);
  });

  it('still counts an empty UNcursored poll as a degradation signal', async () => {
    const inner = {
      scrapeTimeline: vi.fn().mockResolvedValue([]),
      fetchVerificationTargets: vi.fn(),
    } as unknown as PlatformScraper;
    const d = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1000,
    });

    await d.scrapeTimeline('h', new Date(0), 20);
    await d.scrapeTimeline('h', new Date(0), 20);
    await expect(d.scrapeTimeline('h', new Date(0), 20)).rejects.toThrow(/degraded/i);
  });

  it('forwards the sinceId cursor to the inner scraper', async () => {
    const inner = {
      scrapeTimeline: vi.fn().mockResolvedValue([{ id: 'a' }]),
      fetchVerificationTargets: vi.fn(),
    } as unknown as PlatformScraper;
    const d = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1000,
    });

    await d.scrapeTimeline('example', new Date(0), 20, 'tweet-777');

    expect(inner.scrapeTimeline)
      .toHaveBeenCalledWith('example', expect.any(Date), 20, 'tweet-777');
  });

  it('passes through non-empty result without tripping', async () => {
    const inner = stubInner();
    inner.scrapeTimeline.mockResolvedValue(postsAt(['2026-04-24T00:00:00Z']));
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1_800_000,
    });
    const out = await det.scrapeTimeline('h', new Date(0), 10);
    expect(out).toHaveLength(1);
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(1);
  });

  it('returns [] for first N-1 consecutive empties without tripping', async () => {
    const inner = stubInner();
    inner.scrapeTimeline.mockResolvedValue([]);
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1_800_000,
    });

    expect(await det.scrapeTimeline('a', new Date(0), 10)).toEqual([]);
    expect(await det.scrapeTimeline('b', new Date(0), 10)).toEqual([]);
    // Two empties in a row but threshold is 3; still pass-through.
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(2);
  });

  it('throws ProviderDegradedError on the Nth consecutive empty', async () => {
    const inner = stubInner();
    inner.scrapeTimeline.mockResolvedValue([]);
    const logger = { warn: vi.fn(), info: vi.fn() };
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1_800_000,
      logger,
    });

    await det.scrapeTimeline('a', new Date(0), 10);
    await det.scrapeTimeline('b', new Date(0), 10);
    // Third empty in a row trips. The trip throws (so HybridScraper falls back),
    // but the inner call IS made (we observed the empty before deciding to trip).
    await expect(det.scrapeTimeline('c', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('while degraded, short-circuits without calling inner', async () => {
    const inner = stubInner();
    inner.scrapeTimeline.mockResolvedValue([]);
    const now = 1_000_000;
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 2,
      recoveryMs: 1_800_000,
      now: () => now,
    });
    // Trip
    await det.scrapeTimeline('a', new Date(0), 10);
    await expect(det.scrapeTimeline('b', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(2);

    // Subsequent calls within recovery window: no inner call
    await expect(det.scrapeTimeline('c', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);
    await expect(det.scrapeTimeline('d', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(2);
  });

  it('after recoveryMs elapses, retries inner once', async () => {
    const inner = stubInner();
    inner.scrapeTimeline.mockResolvedValue(postsAt(['2026-04-24T00:00:00Z']));
    let now = 1_000_000;
    const logger = { warn: vi.fn(), info: vi.fn() };
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 1,    // trip immediately on first empty
      recoveryMs: 30 * 60_000,
      now: () => now,
      logger,
    });

    // First call: empty → trip
    inner.scrapeTimeline.mockResolvedValueOnce([]);
    await expect(det.scrapeTimeline('a', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(1);

    // Within window: short-circuits, inner not called
    now += 5 * 60_000;
    await expect(det.scrapeTimeline('b', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(1);

    // After window: retries inner; non-empty → recovers
    now += 30 * 60_000 + 1;
    const out = await det.scrapeTimeline('c', new Date(0), 10);
    expect(out).toHaveLength(1);
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(2);
    expect(logger.info.mock.calls.some((c) => String(c[1] ?? c[0]).includes('recovered'))).toBe(true);
  });

  it('non-empty result clears the consecutive-empty counter', async () => {
    const inner = stubInner();
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1_800_000,
    });

    inner.scrapeTimeline.mockResolvedValueOnce([]);
    await det.scrapeTimeline('a', new Date(0), 10);
    inner.scrapeTimeline.mockResolvedValueOnce([]);
    await det.scrapeTimeline('b', new Date(0), 10);
    // Healthy hit: counter reset
    inner.scrapeTimeline.mockResolvedValueOnce(postsAt(['2026-04-24T00:00:00Z']));
    await det.scrapeTimeline('c', new Date(0), 10);

    // Now another two empties — would have tripped (3 consecutive) without the reset above
    inner.scrapeTimeline.mockResolvedValueOnce([]);
    inner.scrapeTimeline.mockResolvedValueOnce([]);
    expect(await det.scrapeTimeline('d', new Date(0), 10)).toEqual([]);
    expect(await det.scrapeTimeline('e', new Date(0), 10)).toEqual([]);   // no throw
  });

  it('inner throw is propagated unchanged (HybridScraper still falls back)', async () => {
    const inner = stubInner();
    const boom = new Error('network oops');
    inner.scrapeTimeline.mockRejectedValueOnce(boom);
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1_800_000,
    });
    await expect(det.scrapeTimeline('a', new Date(0), 10)).rejects.toBe(boom);
  });

  it('fetchVerificationTargets: empty (firstPost null + no selfReplies) counts as empty', async () => {
    const inner = stubInner();
    inner.fetchVerificationTargets.mockResolvedValue(emptyTargets());
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 2,
      recoveryMs: 1_800_000,
    });

    await det.fetchVerificationTargets('a');
    await expect(det.fetchVerificationTargets('b')).rejects.toBeInstanceOf(ProviderDegradedError);
  });

  it('fetchVerificationTargets: non-empty (has firstPost) clears the counter', async () => {
    const inner = stubInner();
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 2,
      recoveryMs: 1_800_000,
    });

    inner.fetchVerificationTargets.mockResolvedValueOnce(emptyTargets());
    await det.fetchVerificationTargets('a');
    inner.fetchVerificationTargets.mockResolvedValueOnce(nonEmptyTargets());
    await det.fetchVerificationTargets('b');
    // Counter reset; another empty alone shouldn't trip.
    inner.fetchVerificationTargets.mockResolvedValueOnce(emptyTargets());
    expect(await det.fetchVerificationTargets('c')).toEqual(emptyTargets());
  });

  it('a cursored non-empty hit resets the empty counter (#415 re-arm)', async () => {
    // Before #415: `if (!sinceId) observeEmpty(...)` skipped observation for
    // cursored calls entirely — including non-empty ones — so a healthy
    // cursored hit could never reset consecutiveEmpties.
    const inner = stubInner();
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1_800_000,
    });

    // Two unfiltered empties (no sinceId, since<=0).
    inner.scrapeTimeline.mockResolvedValueOnce([]);
    await det.scrapeTimeline('a', new Date(0), 10);
    inner.scrapeTimeline.mockResolvedValueOnce([]);
    await det.scrapeTimeline('b', new Date(0), 10);

    // A cursored HIT must reset the counter.
    inner.scrapeTimeline.mockResolvedValueOnce(postsAt(['2026-04-24T00:00:00Z']));
    await det.scrapeTimeline('c', new Date(0), 10, 'tweet-1');

    // Two more unfiltered empties: would trip (3 consecutive) if the reset above hadn't happened.
    inner.scrapeTimeline.mockResolvedValueOnce([]);
    inner.scrapeTimeline.mockResolvedValueOnce([]);
    expect(await det.scrapeTimeline('d', new Date(0), 10)).toEqual([]);
    expect(await det.scrapeTimeline('e', new Date(0), 10)).toEqual([]); // no throw
  });

  it('after a trip, a later cursored hit re-arms the breaker for a fresh outage (#415)', async () => {
    // Before #415: a cursored non-empty result after recovery never cleared
    // `degradedUntilMs`, so `justTripped()`'s "already tripped earlier" guard
    // stayed permanently true and a genuine second outage could never trip
    // the breaker again (HybridScraper silently keeps rerouting to Apify).
    const inner = stubInner();
    let now = 1_000_000;
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 2,
      recoveryMs: 1_800_000,
      now: () => now,
    });

    // Trip via two unfiltered empties.
    inner.scrapeTimeline.mockResolvedValue([]);
    await det.scrapeTimeline('a', new Date(0), 10);
    await expect(det.scrapeTimeline('b', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);

    // Recovery window elapses; the one retry is a cursored call that hits.
    now += 1_800_000 + 1;
    inner.scrapeTimeline.mockResolvedValueOnce(postsAt(['2026-04-24T00:00:00Z']));
    const out = await det.scrapeTimeline('c', new Date(0), 10, 'tweet-99');
    expect(out).toHaveLength(1);

    // Breaker is disarmed: a FRESH outage (two more unfiltered empties) can trip again.
    inner.scrapeTimeline.mockResolvedValue([]);
    await det.scrapeTimeline('d', new Date(0), 10);
    await expect(det.scrapeTimeline('e', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);
  });

  it('day-granularity recency (no sinceId, but since>0) empty poll is not a degradation signal (#415)', async () => {
    // Mirrors twitterapi-io-scraper.ts:318-323: sinceId === '' but since > 0
    // still applies a `since:<date>` operator, making "nothing new today"
    // the expected success case — same reasoning as the exact sinceId guard.
    const inner = stubInner();
    inner.scrapeTimeline.mockResolvedValue([]);
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 2,
      recoveryMs: 1_800_000,
    });

    const since = new Date('2026-04-24T00:00:00Z'); // getTime() > 0
    for (let i = 0; i < 5; i++) {
      await expect(det.scrapeTimeline('quiet', since, 20)).resolves.toEqual([]);
    }
    expect(inner.scrapeTimeline).toHaveBeenCalledTimes(5);
  });

  it('counter is shared across scrapeTimeline + fetchVerificationTargets', async () => {
    // Outage affects both endpoints, so empties from either should accumulate
    // toward the same threshold.
    const inner = stubInner();
    inner.scrapeTimeline.mockResolvedValue([]);
    inner.fetchVerificationTargets.mockResolvedValue(emptyTargets());
    const det = new DegradationDetector({
      inner,
      providerName: 'twitterapi.io',
      consecutiveEmptyThreshold: 3,
      recoveryMs: 1_800_000,
    });

    await det.scrapeTimeline('a', new Date(0), 10);
    await det.fetchVerificationTargets('b');
    await expect(det.scrapeTimeline('c', new Date(0), 10)).rejects.toBeInstanceOf(ProviderDegradedError);
  });
});

describe('DegradationDetector.fetchPostById forwarding (ADR-0034)', () => {
  it('forwards to inner when inner implements it, even while degraded', async () => {
    const inner = stubInner();
    (inner as { fetchPostById?: unknown }).fetchPostById = vi
      .fn()
      .mockResolvedValue({ post: { id: '1', text: 't', createdAt: new Date() }, rawBytes: new Uint8Array(0) });
    inner.fetchVerificationTargets.mockResolvedValue(emptyTargets());
    const d = new DegradationDetector({
      inner,
      providerName: 'p',
      consecutiveEmptyThreshold: 1,
      recoveryMs: 60_000,
    });
    // Trip the breaker via the search path...
    await expect(d.fetchVerificationTargets('h')).rejects.toThrow(ProviderDegradedError);
    // ...by-id must still go through: direct-lookup endpoints survive search degradation.
    const r = await d.fetchPostById!('1');
    expect(r.post?.id).toBe('1');
  });

  it('stays undefined when inner lacks it (proof path skipped, not broken)', () => {
    const d = new DegradationDetector({
      inner: stubInner(),
      providerName: 'p',
      consecutiveEmptyThreshold: 1,
      recoveryMs: 60_000,
    });
    expect(d.fetchPostById).toBeUndefined();
  });
});
