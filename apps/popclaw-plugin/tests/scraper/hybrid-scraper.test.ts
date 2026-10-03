import { describe, it, expect, vi } from 'vitest';
import { HybridScraper } from '../../src/scraper/hybrid-scraper';
import { TokenBucket } from '../../src/scraper/token-bucket';
import type { PlatformScraper, VerificationTargets } from '../../src/scraper/platform-scraper';

function makeStub(targets: VerificationTargets | Error): PlatformScraper {
  const call = vi.fn().mockImplementation(() => {
    if (targets instanceof Error) return Promise.reject(targets);
    return Promise.resolve(targets);
  });
  return {
    fetchVerificationTargets: call,
    scrapeTimeline: vi.fn(),
  } as unknown as PlatformScraper;
}

const emptyTargets: VerificationTargets = {
  firstPost: null,
  selfReplies: [],
  rawBytes: new Uint8Array(0),
};

const goodTargets: VerificationTargets = {
  firstPost: { id: '1', text: 'hi 4d83f9', createdAt: new Date() },
  selfReplies: [],
  rawBytes: new Uint8Array([1, 2, 3]),
};

describe('HybridScraper', () => {
  // PR #183 lesson: a decorator that silently drops an argument is invisible
  // until the bill arrives. sinceId is what keeps a quiet poll cheap.
  it('forwards the sinceId cursor to primary AND to fallback', async () => {
    const primary = makeStub(goodTargets);
    (primary.scrapeTimeline as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('primary down'));
    const fallback = makeStub(goodTargets);
    (fallback.scrapeTimeline as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const hybrid = new HybridScraper({ primary, fallback });

    await hybrid.scrapeTimeline('example', new Date(0), 20, 'tweet-777');

    expect(primary.scrapeTimeline)
      .toHaveBeenCalledWith('example', expect.any(Date), 20, 'tweet-777');
    expect(fallback.scrapeTimeline)
      .toHaveBeenCalledWith('example', expect.any(Date), 20, 'tweet-777');
  });

  it('uses primary result when primary succeeds with non-empty data', async () => {
    const primary = makeStub(goodTargets);
    const fallback = makeStub(emptyTargets);
    const hybrid = new HybridScraper({ primary, fallback });

    const result = await hybrid.fetchVerificationTargets('blackfeather_ai');
    expect(result.firstPost?.id).toBe('1');
    expect(fallback.fetchVerificationTargets).not.toHaveBeenCalled();
  });

  it('falls back to secondary when primary throws', async () => {
    const primary = makeStub(new Error('playwright crashed'));
    const fallback = makeStub(goodTargets);
    const hybrid = new HybridScraper({ primary, fallback });

    const result = await hybrid.fetchVerificationTargets('blackfeather_ai');
    expect(result.firstPost?.id).toBe('1');
    expect(fallback.fetchVerificationTargets).toHaveBeenCalledOnce();
  });

  it('falls back when primary returns empty targets', async () => {
    const primary = makeStub(emptyTargets);
    const fallback = makeStub(goodTargets);
    const hybrid = new HybridScraper({ primary, fallback });

    const result = await hybrid.fetchVerificationTargets('blackfeather_ai');
    expect(result.firstPost?.id).toBe('1');
    expect(fallback.fetchVerificationTargets).toHaveBeenCalledOnce();
  });

  it('throws combined error when both fail', async () => {
    const primary = makeStub(new Error('playwright crashed'));
    const fallback = makeStub(new Error('no bearer token'));
    const hybrid = new HybridScraper({ primary, fallback });

    await expect(hybrid.fetchVerificationTargets('blackfeather_ai')).rejects.toThrow(
      /primary failed.*fallback failed/s,
    );
  });

  it('throws primary error when fallback is absent and primary threw', async () => {
    const primary = makeStub(new Error('playwright crashed'));
    const hybrid = new HybridScraper({ primary });

    await expect(hybrid.fetchVerificationTargets('blackfeather_ai')).rejects.toThrow(/playwright crashed/);
  });

  it('returns empty targets when primary empty and no fallback (fetch OK, sigil absent → REJECT, not ABSTAIN)', async () => {
    const primary = makeStub(emptyTargets);
    const hybrid = new HybridScraper({ primary });

    const result = await hybrid.fetchVerificationTargets('blackfeather_ai');
    expect(result).toEqual(emptyTargets);
    expect(primary.fetchVerificationTargets).toHaveBeenCalledOnce();
  });

  it('scrapeTimeline falls back on primary throw', async () => {
    const primary: PlatformScraper = {
      fetchVerificationTargets: vi.fn(),
      scrapeTimeline: vi.fn().mockRejectedValue(new Error('primary dead')),
    };
    const fallback: PlatformScraper = {
      fetchVerificationTargets: vi.fn(),
      scrapeTimeline: vi.fn().mockResolvedValue([
        { id: 'p1', text: 'hi', createdAt: new Date(), originalUrl: 'https://x.com/h/status/p1' },
      ]),
    };
    const hybrid = new HybridScraper({ primary, fallback });
    const posts = await hybrid.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(posts).toHaveLength(1);
    expect(primary.scrapeTimeline).toHaveBeenCalledOnce();
    expect(fallback.scrapeTimeline).toHaveBeenCalledOnce();
  });

  it('scrapeTimeline throws primary error when no fallback', async () => {
    const primary: PlatformScraper = {
      fetchVerificationTargets: vi.fn(),
      scrapeTimeline: vi.fn().mockRejectedValue(new Error('primary dead')),
    };
    const hybrid = new HybridScraper({ primary });
    await expect(hybrid.scrapeTimeline('blackfeather_ai', new Date(0), 10)).rejects.toThrow(/primary dead/);
  });

  it('takes a bucket token before calling primary (verification)', async () => {
    const primary = makeStub(goodTargets);
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 1 });
    const takeSpy = vi.spyOn(bucket, 'take');
    const hybrid = new HybridScraper({ primary, bucket });

    await hybrid.fetchVerificationTargets('blackfeather_ai');
    expect(takeSpy).toHaveBeenCalledOnce();
  });

  it('shares one bucket across primary and fallback (empty → fallback takes second token)', async () => {
    const primary = makeStub(emptyTargets);
    const fallback = makeStub(goodTargets);
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 1 });
    const takeSpy = vi.spyOn(bucket, 'take');
    const hybrid = new HybridScraper({ primary, fallback, bucket });

    await hybrid.fetchVerificationTargets('blackfeather_ai');
    expect(takeSpy).toHaveBeenCalledTimes(2);
  });

  it('scrapeTimeline also takes a bucket token', async () => {
    const primary: PlatformScraper = {
      fetchVerificationTargets: vi.fn(),
      scrapeTimeline: vi.fn().mockResolvedValue([]),
    };
    const bucket = new TokenBucket({ capacity: 10, refillPerSecond: 1 });
    const takeSpy = vi.spyOn(bucket, 'take');
    const hybrid = new HybridScraper({ primary, bucket });

    await hybrid.scrapeTimeline('blackfeather_ai', new Date(0), 10);
    expect(takeSpy).toHaveBeenCalledOnce();
  });
});

describe('HybridScraper.fetchPostById (ADR-0034)', () => {
  const fetched = { post: { id: '9', text: 'x#s', createdAt: new Date() }, rawBytes: new Uint8Array([9]) };

  it('delegates to primary when primary implements it', async () => {
    const primary = makeStub(goodTargets);
    (primary as { fetchPostById?: unknown }).fetchPostById = vi.fn().mockResolvedValue(fetched);
    const fallback = makeStub(goodTargets);
    const hybrid = new HybridScraper({ primary, fallback });
    const r = await hybrid.fetchPostById('9');
    expect(r.post?.id).toBe('9');
  });

  it('delegates to fallback when only fallback implements it', async () => {
    const primary = makeStub(goodTargets);
    const fallback = makeStub(goodTargets);
    (fallback as { fetchPostById?: unknown }).fetchPostById = vi.fn().mockResolvedValue(fetched);
    const hybrid = new HybridScraper({ primary, fallback });
    const r = await hybrid.fetchPostById('9');
    expect(r.post?.id).toBe('9');
  });

  it('throws when neither delegate implements it', async () => {
    const hybrid = new HybridScraper({ primary: makeStub(goodTargets), fallback: makeStub(goodTargets) });
    await expect(hybrid.fetchPostById('9')).rejects.toThrow('no delegate implements fetchPostById');
  });
});
