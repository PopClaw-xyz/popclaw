import { describe, it, expect, vi } from 'vitest';
import { scoreAgainstTaste, AXIS_WEIGHTS, type Scoreable } from '../../../src/recommend/score-against-taste';

const item = (over: Partial<Scoreable> = {}): Scoreable => ({
  platform: 'x', authorPopclawId: 'a', platformPostId: 'p',
  textPreview: 'sample', platformPostCreatedAt: 0, ...over,
});

describe('scoreAgainstTaste (batched)', () => {
  it('empty sources → all items get score 0 and pass through (no LLM call)', async () => {
    const items = [item({ platformPostId: '1' }), item({ platformPostId: '2' })];
    const llm = vi.fn().mockResolvedValue('[[0.5]]');
    const out = await scoreAgainstTaste(items, [], llm);
    expect(out).toHaveLength(2);
    expect(out[0]!.score).toBe(0);
    expect(out[1]!.score).toBe(0);
    expect(llm).not.toHaveBeenCalled();
  });

  it('empty items → no LLM call', async () => {
    const llm = vi.fn();
    const out = await scoreAgainstTaste([], [
      { path: 'core/public.md', weight: 1.0, content: '...' },
    ], llm);
    expect(out).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  it('single source → ONE LLM call returns N×1 matrix; score = weight × matchProb', async () => {
    const items = [item({ platformPostId: '1' }), item({ platformPostId: '2' })];
    // LLM returns a JSON N×1 matrix
    const llm = vi.fn().mockResolvedValue('[[0.8],[0.3]]');
    const out = await scoreAgainstTaste(items, [
      { path: 'core/public.md', weight: 1.0, content: '# Likes\n- AI' },
    ], llm);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(out[0]!.score).toBeCloseTo(0.8, 6);
    expect(out[1]!.score).toBeCloseTo(0.3, 6);
  });

  it('multi-source → weighted sum across sources, single LLM call', async () => {
    const items = [item()];
    const llm = vi.fn().mockResolvedValue('[[0.8, 0.4]]');
    const out = await scoreAgainstTaste(items, [
      { path: 'core/public.md',  weight: 1.0, content: '...' },
      { path: 'core/private.md', weight: 0.5, content: '...' },
    ], llm);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(out[0]!.score).toBeCloseTo(1.0 * 0.8 + 0.5 * 0.4, 6);
    expect(out[0]!.lineage).toEqual([
      { path: 'core/public.md',  contribution: 0.8 },
      { path: 'core/private.md', contribution: 0.2 },
    ]);
  });

  it('LLM throws → all items score 0, command does not crash', async () => {
    const items = [item({ platformPostId: '1' }), item({ platformPostId: '2' })];
    const llm = vi.fn().mockRejectedValue(new Error('llm down'));
    const out = await scoreAgainstTaste(items, [
      { path: 'core/public.md', weight: 1.0, content: '...' },
    ], llm);
    expect(out[0]!.score).toBe(0);
    expect(out[1]!.score).toBe(0);
  });

  it('LLM returns malformed JSON → all items score 0', async () => {
    const items = [item()];
    const llm = vi.fn().mockResolvedValue('not really json {][}');
    const out = await scoreAgainstTaste(items, [
      { path: 'core/public.md', weight: 1.0, content: '...' },
    ], llm);
    expect(out[0]!.score).toBe(0);
  });

  it('LLM wraps response in markdown fence → still parses', async () => {
    const items = [item({ platformPostId: '1' })];
    const llm = vi.fn().mockResolvedValue('```json\n[[0.6]]\n```');
    const out = await scoreAgainstTaste(items, [
      { path: 'core/public.md', weight: 1.0, content: '...' },
    ], llm);
    expect(out[0]!.score).toBeCloseTo(0.6, 6);
  });

  it('LLM returns flat array for single-source (forgot to nest) → tolerated', async () => {
    const items = [item({ platformPostId: '1' }), item({ platformPostId: '2' })];
    const llm = vi.fn().mockResolvedValue('[0.7, 0.2]');
    const out = await scoreAgainstTaste(items, [
      { path: 'core/public.md', weight: 1.0, content: '...' },
    ], llm);
    expect(out[0]!.score).toBeCloseTo(0.7, 6);
    expect(out[1]!.score).toBeCloseTo(0.2, 6);
  });

  it('clamps each matrix cell to [0, 1] (LLM may misbehave)', async () => {
    const items = [item()];
    const llm = vi.fn().mockResolvedValue('[[2.5]]');
    const out = await scoreAgainstTaste(items, [
      { path: 'core/public.md', weight: 1.0, content: '...' },
    ], llm);
    expect(out[0]!.score).toBeCloseTo(1.0, 6);
  });

  it('prompt includes per-source content + per-item textPreview + JSON output spec', async () => {
    const items = [item({ textPreview: 'specific item text' })];
    const llm = vi.fn().mockResolvedValue('[[0]]');
    await scoreAgainstTaste(items, [
      { path: 'core/public.md', weight: 1.0, content: 'TASTE-ABC' },
    ], llm);
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('TASTE-ABC');
    expect(prompt).toContain('specific item text');
    expect(prompt).toMatch(/JSON.*array/i);
  });

  describe('multi-axis scoring (Plan 11.2.3)', () => {
    it('LLM returns axis matrix [topic,depth,novelty,dislike]; final score is weighted blend', async () => {
      const items = [item()];
      // Single source, axes [topic=1, depth=1, novelty=0, dislike=0]
      // Final = max(0, 0.5*1 + 0.3*1 + 0.2*0 - 0.4*0) = 0.8
      const llm = vi.fn().mockResolvedValue('[[[1.0,1.0,0.0,0.0]]]');
      const out = await scoreAgainstTaste(items, [
        { path: 'core/public.md', weight: 1.0, content: '...' },
      ], llm);
      const expected = AXIS_WEIGHTS.topic * 1 + AXIS_WEIGHTS.depth * 1;
      expect(out[0]!.score).toBeCloseTo(expected, 6);
    });

    it('dislike axis subtracts; final is clamped at 0 (no negative scores)', async () => {
      const items = [item()];
      // axes [0,0,0,1] → 0 - 0.4 = clamp(0)
      const llm = vi.fn().mockResolvedValue('[[[0.0,0.0,0.0,1.0]]]');
      const out = await scoreAgainstTaste(items, [
        { path: 'core/public.md', weight: 1.0, content: '...' },
      ], llm);
      expect(out[0]!.score).toBe(0);
    });

    it('LineageEntry exposes axes for fresh-scored items (observability)', async () => {
      const items = [item()];
      const llm = vi.fn().mockResolvedValue('[[[0.5,0.3,0.2,0.1]]]');
      const out = await scoreAgainstTaste(items, [
        { path: 'core/public.md', weight: 1.0, content: '...' },
      ], llm);
      expect(out[0]!.lineage[0]!.axes).toEqual({ topic: 0.5, depth: 0.3, novelty: 0.2, dislike: 0.1 });
    });

    it('LEGACY: LLM still returns single-number per cell → that number IS the contribution (Plan 11.1 contract preserved)', async () => {
      const items = [item()];
      const llm = vi.fn().mockResolvedValue('[[0.6]]');
      const out = await scoreAgainstTaste(items, [
        { path: 'core/public.md', weight: 1.0, content: '...' },
      ], llm);
      // Legacy cells skip the axis blend — contribution equals the number directly.
      // (This preserves the Plan 11.1.2 contract for any model output that doesn't
      // follow the new multi-axis instruction.)
      expect(out[0]!.score).toBeCloseTo(0.6, 6);
      // Lineage axes is omitted for legacy cells (only set on the new axis path).
      expect(out[0]!.lineage[0]!.axes).toBeUndefined();
    });

    it('multi-source axis output: each cell is its own [t,d,n,dl] array', async () => {
      const items = [item()];
      // Two sources: src0 axes=[1,0,0,0], src1 axes=[0,1,0,0]
      const llm = vi.fn().mockResolvedValue('[[[1.0,0.0,0.0,0.0],[0.0,1.0,0.0,0.0]]]');
      const out = await scoreAgainstTaste(items, [
        { path: 'core/public.md', weight: 1.0, content: '...' },
        { path: 'core/private.md', weight: 0.5, content: '...' },
      ], llm);
      // src0 contribution = 1.0 * (0.5*1) = 0.5
      // src1 contribution = 0.5 * (0.3*1) = 0.15
      expect(out[0]!.score).toBeCloseTo(0.5 + 0.15, 6);
    });

    it('prompt instructs LLM to return per-cell axis array', async () => {
      const items = [item()];
      const llm = vi.fn().mockResolvedValue('[[[0,0,0,0]]]');
      await scoreAgainstTaste(items, [
        { path: 'core/public.md', weight: 1.0, content: '...' },
      ], llm);
      const prompt = llm.mock.calls[0]![0] as string;
      // The prompt should mention the four axes by name so the LLM can produce them.
      expect(prompt.toLowerCase()).toMatch(/topic/);
      expect(prompt.toLowerCase()).toMatch(/depth/);
      expect(prompt.toLowerCase()).toMatch(/novelty/);
      expect(prompt.toLowerCase()).toMatch(/dislike/);
    });
  });
});
