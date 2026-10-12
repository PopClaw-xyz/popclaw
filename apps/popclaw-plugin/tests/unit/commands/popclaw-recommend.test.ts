import { describe, it, expect, vi, beforeAll } from 'vitest';
import { runPopclawRecommendCommand } from '../../../src/commands/popclaw-recommend';
import { setOwnerLang } from '../../../src/lexicon/owner-language';

// S3 rollout slice 2: the --visual retired notice now renders in
// `ownerLang()` (S1 process-wide singleton). Pin zh-CN so this file's
// pre-lexicon assertion stays byte-for-byte unchanged.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const cadenceLoader = { load: vi.fn().mockResolvedValue({
  schemaVersion: 1,
  delivery: { primaryLanguage: 'en-US', summaryStyle: 'bullets', tone: 'casual',
              channels: ['openclaw'], includeSourceLinks: true,
              includeLineage: true },
  filtering: { minScore: 0.0, maxItemsPerDigest: 5 },
  promptOverrides: '',
}) };
const cache = { recent: vi.fn().mockReturnValue([{
  platform: 'x', authorPopclawId: 'a', platformPostId: '1',
  textPreview: 'hi', platformPostCreatedAt: 0, originalUrl: 'u', handle: 'h',
}]) };
const taste = { enabledSources: vi.fn().mockResolvedValue([{ path: 'core/public.md', weight: 1.0, content: '...' }]) };
const sg = { followsIn: () => false };

describe('runPopclawRecommendCommand', () => {
  it('returns the rendered digest from runRecommendCycle', async () => {
    const out = await runPopclawRecommendCommand(
      { positional: [], flags: {} },
      {
        cache: cache as any, tasteLoader: taste as any,
        cadenceLoader: cadenceLoader as any, socialGraph: sg as any,
        llmScore: vi.fn().mockResolvedValue('[[0.7]]'),
        llmRender: vi.fn().mockResolvedValue('• picked'),
      },
    );
    expect(out.text).toContain('• picked');
    expect(out.text).not.toContain('--visual'); // retired nudge is gone (#137)
  });

  it('returns a friendly error message on internal throw', async () => {
    const out = await runPopclawRecommendCommand(
      { positional: [], flags: {} },
      {
        cache: cache as any,
        tasteLoader: { enabledSources: vi.fn().mockRejectedValue(new Error('boom')) } as any,
        cadenceLoader: cadenceLoader as any, socialGraph: sg as any,
        llmScore: vi.fn(), llmRender: vi.fn(),
      },
    );
    // Ledger #010: once errors use the lexicon, this zh-CN-pinned file must receive Chinese copy.
    expect(out.text).toContain('没跑成');
    expect(out.text).toContain('boom');
  });

  it('--feedback records a style note and acks, without scoring', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { readStyleNotes } = await import('../../../src/visual/style-notes');
    const styleFile = join(mkdtempSync(join(tmpdir(), 'vd-rec-')), 'canvas-style.md');
    const score = vi.fn();
    const out = await runPopclawRecommendCommand(
      { positional: [], flags: { feedback: '配色淡一点' } },
      {
        cache: cache as any, tasteLoader: taste as any, cadenceLoader: cadenceLoader as any,
        socialGraph: sg as any, llmScore: score, llmRender: vi.fn(),
        styleFile, now: () => 0,
      },
    );
    expect(out.text).toContain('已记下');
    expect(score).not.toHaveBeenCalled();
    expect(readStyleNotes(styleFile)).toContain('配色淡一点');
  });

  it('--visual is retired (#137): runs the text digest unchanged, with a one-line notice', async () => {
    const llmRender = vi.fn().mockResolvedValue('• picked');
    const out = await runPopclawRecommendCommand(
      { positional: [], flags: { visual: '' } },
      {
        cache: cache as any, tasteLoader: taste as any, cadenceLoader: cadenceLoader as any,
        socialGraph: sg as any,
        llmScore: vi.fn().mockResolvedValue('[[0.7]]'), llmRender,
      },
    );
    expect(llmRender).toHaveBeenCalled(); // normal text render, not skipped
    expect(out.text).toContain('• picked');
    const lines = out.text.split('\n');
    expect(lines[0]).toContain('已退役'); // one notice line prepended
    expect(lines[0]).toContain('newspaper'); // pointing at the new home
  });

  // S3 rollout slice 2 — en lane for the --visual retired notice.
  it('--visual retired notice: en lane', async () => {
    setOwnerLang('en', 'config');
    const llmRender = vi.fn().mockResolvedValue('• picked');
    const out = await runPopclawRecommendCommand(
      { positional: [], flags: { visual: '' } },
      {
        cache, tasteLoader: taste, cadenceLoader, socialGraph: sg,
        llmScore: vi.fn().mockResolvedValue('[[0.7]]'), llmRender,
      } as unknown as Parameters<typeof runPopclawRecommendCommand>[1],
    );
    expect(out.text.split('\n')[0]).toContain('retired');
    expect(out.text.split('\n')[0]).toContain('newspaper');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });
});
