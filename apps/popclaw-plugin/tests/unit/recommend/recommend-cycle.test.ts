import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRecommendCycle } from '../../../src/recommend/recommend-cycle';
import { defaultCadence } from '../../../src/cadence/cadence-loader';
import { ScoreCache } from '../../../src/recommend/score-cache';

const cacheItem = (over: Record<string, unknown> = {}) => ({
  platform: 'x', authorPopclawId: 'a', platformPostId: 'p1',
  platformPostCreatedAt: 100, originalUrl: 'u', textPreview: 'hello', handle: 'h',
  ...over,
});

// Plan 11.1.2: scoring is batched. The mock `llmScore` returns a JSON N×M
// matrix string (one row per item, one column per source).

describe('runRecommendCycle', () => {
  it('pulls items from cache, scores (one batched LLM call), applies social-graph boost, renders', async () => {
    const cache = { recent: vi.fn().mockReturnValue([cacheItem({ platformPostId: '1' })]) };
    const taste = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1.0, content: '...' }]) };
    const cad = defaultCadence();
    const sg = {
      followsIn: (id: string) => id === 'a',
    };
    const llmScore = vi.fn().mockResolvedValue('[[0.5]]');
    const llmRender = vi.fn().mockResolvedValue('• picked');

    const out = await runRecommendCycle({ cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore, llmRender });

    expect(out.digest).toBe('• picked');
    expect(out.top).toHaveLength(1);
    expect(out.top[0]!.item.platformPostId).toBe('1');
    expect(cache.recent).toHaveBeenCalled();
    expect(llmScore).toHaveBeenCalledTimes(1);     // batched
    expect(llmRender).toHaveBeenCalledTimes(1);
  });

  it('respects cadence.filtering.minScore (drops below-threshold)', async () => {
    const cache = { recent: vi.fn().mockReturnValue([
      cacheItem({ platformPostId: 'zzdrop', authorPopclawId: 'unknown' }),
      cacheItem({ platformPostId: 'zzkeep', authorPopclawId: 'unknown' }),
    ])};
    const taste = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1.0, content: '...' }]) };
    const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, minScore: 0.5 } };
    const sg = { followsIn: () => false };
    // First item scored 0.2 (drops below 0.5 threshold), second 0.7 (kept).
    const llmScore = vi.fn().mockResolvedValue('[[0.2],[0.7]]');
    const llmRender = vi.fn().mockResolvedValue('out');

    await runRecommendCycle({ cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore, llmRender });

    const sentToRender = (llmRender.mock.calls[0]![0] as string);
    expect(sentToRender).toContain('zzkeep');
    expect(sentToRender).not.toContain('zzdrop');
  });

  it('applies social-graph boost: items from a public-followed author get +0.1', async () => {
    const cache = { recent: vi.fn().mockReturnValue([
      cacheItem({ platformPostId: '1', authorPopclawId: 'followed' }),
      cacheItem({ platformPostId: '2', authorPopclawId: 'unknown' }),
    ])};
    const taste = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1.0, content: '...' }]) };
    const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, minScore: 0.0 } };
    const sg = {
      followsIn: (id: string) => id === 'followed',
    };
    // Both items same raw score; followed-author gets +0.1 boost so it sorts first.
    const llmScore = vi.fn().mockResolvedValue('[[0.3],[0.3]]');
    const llmRender = vi.fn().mockResolvedValue('out');

    await runRecommendCycle({ cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore, llmRender });

    const sent = llmRender.mock.calls[0]![0] as string;
    const aFollowed = sent.indexOf('followed');
    const aUnknown = sent.indexOf('unknown');
    expect(aFollowed).toBeGreaterThan(-1);
    expect(aUnknown).toBeGreaterThan(-1);
    expect(aFollowed).toBeLessThan(aUnknown);
  });

  // ADR-0037「内容注意力看坊」：同一个作者，我只在 me 坊关注了他 —— 他在 world
  // 坊的帖子不该蹭到关注加权。
  it('关注加权按坊：只加在我在那座坊关注了他的条目上', async () => {
    const cache = { recent: vi.fn().mockReturnValue([
      cacheItem({ platformPostId: 'inworld', authorPopclawId: 'dual', houseSlug: 'world' }),
      cacheItem({ platformPostId: 'inme', authorPopclawId: 'dual', houseSlug: 'me' }),
    ])};
    const taste = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1.0, content: '...' }]) };
    const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, minScore: 0.0 } };
    const sg = { followsIn: (id: string, house?: string) => id === 'dual' && house === 'me' };
    const llmScore = vi.fn().mockResolvedValue('[[0.3],[0.3]]');
    const llmRender = vi.fn().mockResolvedValue('out');

    await runRecommendCycle({ cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore, llmRender });

    const sent = llmRender.mock.calls[0]![0] as string;
    expect(sent.indexOf('inme')).toBeLessThan(sent.indexOf('inworld'));
  });

  it('caps a single author to the per-author quota (diversity boost)', async () => {
    // Cache has 8 items from author A and 2 from B (oldest last).
    // Pool is small so the un-capped behavior would feed all 8 A's to the LLM,
    // crowding out B. With the diversity quota the LLM sees a mix.
    const items = [
      ...Array.from({ length: 8 }, (_, i) => cacheItem({ platformPostId: `a${i}`, authorPopclawId: 'A', platformPostCreatedAt: 1000 - i })),
      ...Array.from({ length: 2 }, (_, i) => cacheItem({ platformPostId: `b${i}`, authorPopclawId: 'B', platformPostCreatedAt: 100 - i })),
    ];
    const cache = { recent: vi.fn().mockImplementation((n: number) => items.slice(0, n)) };
    const taste = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1.0, content: '...' }]) };
    // poolSize = max*5; with maxItemsPerDigest=2 → poolSize=10. Without quota
    // the LLM would see 8 A + 2 B. With quota = 3, it should see at most 3 A.
    const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, maxItemsPerDigest: 2, minScore: 0.0 } };
    const sg = { followsIn: () => false };
    const llmScore = vi.fn().mockResolvedValue(JSON.stringify(items.map(() => [0.5])));
    const llmRender = vi.fn().mockResolvedValue('out');

    await runRecommendCycle({ cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore, llmRender });

    // Inspect the prompt that scoreAgainstTaste built — the per-item lines.
    const scoringPrompt = llmScore.mock.calls[0]![0] as string;
    const aLines = (scoringPrompt.match(/author=A/g) ?? []).length;
    const bLines = (scoringPrompt.match(/author=B/g) ?? []).length;
    expect(aLines).toBeLessThanOrEqual(3);   // quota
    expect(bLines).toBe(2);                   // both B's still get through
  });

  describe('with ScoreCache (cost optimization)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'sc-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('FIRST cycle scores all items via LLM and writes them to the cache', async () => {
      const items = [
        cacheItem({ platformPostId: '1' }),
        cacheItem({ platformPostId: '2' }),
      ];
      const cache = { recent: vi.fn().mockReturnValue(items) };
      const taste = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1.0, content: 'AI' }]) };
      const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, minScore: 0.0 } };
      const sg = { followsIn: () => false };
      const llmScore = vi.fn().mockResolvedValue('[[0.5],[0.3]]');
      const llmRender = vi.fn().mockResolvedValue('out');
      const sc = ScoreCache.load(join(dir, 'score-cache.json'));

      await runRecommendCycle({
        cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore, llmRender, scoreCache: sc,
      });

      expect(llmScore).toHaveBeenCalledTimes(1);
      expect(sc.size()).toBe(2);
    });

    it('SECOND cycle skips LLM scoring entirely when items + taste are unchanged', async () => {
      const items = [
        cacheItem({ platformPostId: '1' }),
        cacheItem({ platformPostId: '2' }),
      ];
      const cache = { recent: vi.fn().mockReturnValue(items) };
      const sources = [{ path: 'core/public.md', weight: 1.0, content: 'AI' }];
      const taste = { enabledSources: vi.fn().mockResolvedValue(sources) };
      const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, minScore: 0.0 } };
      const sg = { followsIn: () => false };
      const llmScore1 = vi.fn().mockResolvedValue('[[0.5],[0.3]]');
      const llmRender = vi.fn().mockResolvedValue('out');
      const sc = ScoreCache.load(join(dir, 'score-cache.json'));

      // First cycle — populates cache.
      await runRecommendCycle({
        cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore: llmScore1, llmRender, scoreCache: sc,
      });
      expect(llmScore1).toHaveBeenCalledTimes(1);

      // Second cycle — same items, same taste. Should NOT call llmScore again.
      const llmScore2 = vi.fn();
      const sc2 = ScoreCache.load(join(dir, 'score-cache.json'));
      await runRecommendCycle({
        cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore: llmScore2, llmRender, scoreCache: sc2,
      });
      expect(llmScore2).not.toHaveBeenCalled();
    });

    it('SECOND cycle scores only newly-arrived items (one new + one cached)', async () => {
      const sources = [{ path: 'core/public.md', weight: 1.0, content: 'AI' }];
      const taste = { enabledSources: vi.fn().mockResolvedValue(sources) };
      const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, minScore: 0.0 } };
      const sg = { followsIn: () => false };
      const llmRender = vi.fn().mockResolvedValue('out');
      const sc1 = ScoreCache.load(join(dir, 'score-cache.json'));

      // Cycle 1: cache one item.
      const cache1 = { recent: vi.fn().mockReturnValue([cacheItem({ platformPostId: 'old' })]) };
      const llmScore1 = vi.fn().mockResolvedValue('[[0.5]]');
      await runRecommendCycle({
        cache: cache1, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore: llmScore1, llmRender, scoreCache: sc1,
      });

      // Cycle 2: same old item + one new. Only the new one should hit the LLM.
      const cache2 = { recent: vi.fn().mockReturnValue([
        cacheItem({ platformPostId: 'old', textPreview: 'CACHED-OLD-TEXT' }),
        cacheItem({ platformPostId: 'new', textPreview: 'FRESH-NEW-TEXT' }),
      ])};
      const llmScore2 = vi.fn().mockResolvedValue('[[0.7]]');     // 1 row → only 1 item scored
      const sc2 = ScoreCache.load(join(dir, 'score-cache.json'));
      await runRecommendCycle({
        cache: cache2, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore: llmScore2, llmRender, scoreCache: sc2,
      });

      expect(llmScore2).toHaveBeenCalledTimes(1);
      // The scoring prompt must contain ONLY the new item, not the cached one.
      const prompt = llmScore2.mock.calls[0]![0] as string;
      expect(prompt).toContain('FRESH-NEW-TEXT');
      expect(prompt).not.toContain('CACHED-OLD-TEXT');
    });

    it('taste change → all cached entries invalidate, full rescore', async () => {
      const items = [cacheItem({ platformPostId: '1' })];
      const cache = { recent: vi.fn().mockReturnValue(items) };
      const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, minScore: 0.0 } };
      const sg = { followsIn: () => false };
      const llmRender = vi.fn().mockResolvedValue('out');

      // Cycle 1 — taste = "v1"
      const taste1 = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1, content: 'v1' }]) };
      const llmScore1 = vi.fn().mockResolvedValue('[[0.5]]');
      const sc1 = ScoreCache.load(join(dir, 'score-cache.json'));
      await runRecommendCycle({ cache, tasteLoader: taste1, cadence: cad, socialGraph: sg, llmScore: llmScore1, llmRender, scoreCache: sc1 });

      // Cycle 2 — taste edited to "v2"; same items but cache is now stale.
      const taste2 = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1, content: 'v2' }]) };
      const llmScore2 = vi.fn().mockResolvedValue('[[0.6]]');
      const sc2 = ScoreCache.load(join(dir, 'score-cache.json'));
      await runRecommendCycle({ cache, tasteLoader: taste2, cadence: cad, socialGraph: sg, llmScore: llmScore2, llmRender, scoreCache: sc2 });
      expect(llmScore2).toHaveBeenCalledTimes(1); // re-scored, not skipped
    });
  });

  it('returns the empty-state digest when nothing scores above minScore', async () => {
    const cache = { recent: vi.fn().mockReturnValue([cacheItem({ platformPostId: '1' })]) };
    const taste = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1.0, content: '...' }]) };
    const cad = { ...defaultCadence(), filtering: { ...defaultCadence().filtering, minScore: 0.99 } };
    const sg = { followsIn: () => false };
    const llmScore = vi.fn().mockResolvedValue('[[0.1]]');
    const llmRender = vi.fn();

    const out = await runRecommendCycle({ cache, tasteLoader: taste, cadence: cad, socialGraph: sg, llmScore, llmRender });
    expect(out.digest).toBe('No items meet your recommendation threshold yet. Check back later.');
    expect(llmRender).not.toHaveBeenCalled();
  });
});
