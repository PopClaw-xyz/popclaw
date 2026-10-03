import { afterEach, describe, it, expect, vi } from 'vitest';
import { renderDigest } from '../../../src/recommend/render-digest';
import { defaultCadence } from '../../../src/cadence/cadence-loader';
import { setOwnerLang } from '../../../src/lexicon/owner-language';
import type { ScoredItem } from '../../../src/recommend/score-against-taste';

const scoredItem = (over: Partial<ScoredItem['item']> = {}): ScoredItem => ({
  item: {
    platform: 'x', authorPopclawId: 'a', platformPostId: '1',
    textPreview: 'hello world', platformPostCreatedAt: 1700000000,
    ...over,
  },
  score: 0.7,
  lineage: [{ path: 'core/public.md', contribution: 0.7 }],
});

describe('renderDigest', () => {
  afterEach(() => setOwnerLang(undefined));

  it('builds a prompt that includes the owner language, items, and lineage', async () => {
    // The language comes from the register, not from `cadence.delivery`: an
    // explicit cadence reaches the register at boot, and an owner who never
    // configured one used to get the default `en-US` handed to the LLM.
    setOwnerLang('zh-CN', 'config');
    const llm = vi.fn().mockResolvedValue('• 推送1\n• 推送2');
    const out = await renderDigest([scoredItem()], defaultCadence(), llm);

    expect(out).toBe('• 推送1\n• 推送2');
    const promptArg = llm.mock.calls[0]![0] as string;
    expect(promptArg).toContain('zh-CN');
    expect(promptArg).toContain('hello world');
    expect(promptArg).toContain('core/public.md');   // lineage cite
  });

  it('ignores cadence.delivery.primaryLanguage — the register is the only read port', async () => {
    // A stale/default cadence value must not out-talk the live register.
    const cad = { ...defaultCadence(), delivery: { ...defaultCadence().delivery, primaryLanguage: 'en-US' } };
    setOwnerLang('zh-CN', 'guess');
    const llm = vi.fn().mockResolvedValue('out');
    await renderDigest([scoredItem()], cad, llm);
    const promptArg = llm.mock.calls[0]![0] as string;
    expect(promptArg).toContain('Speak to the owner in zh-CN');
    expect(promptArg).not.toContain('en-US');
  });

  it('omits lineage when cadence.delivery.includeLineage is false', async () => {
    const cad = { ...defaultCadence(), delivery: { ...defaultCadence().delivery, includeLineage: false } };
    const llm = vi.fn().mockResolvedValue('out');
    await renderDigest([scoredItem()], cad, llm);
    const promptArg = llm.mock.calls[0]![0] as string;
    expect(promptArg).not.toContain('core/public.md');
  });

  it('appends prompt-overrides.md text to the system prompt', async () => {
    const cad = { ...defaultCadence(), promptOverrides: 'Be terse like a telegram operator.' };
    const llm = vi.fn().mockResolvedValue('out');
    await renderDigest([scoredItem()], cad, llm);
    const promptArg = llm.mock.calls[0]![0] as string;
    expect(promptArg).toContain('Be terse like a telegram operator.');
  });

  it('returns a friendly empty-state when given zero scored items', async () => {
    const llm = vi.fn();
    const out = await renderDigest([], defaultCadence(), llm);
    expect(out).toBe('No items meet your recommendation threshold yet. Check back later.');
    expect(llm).not.toHaveBeenCalled();
  });

  it('passes the human-readable handle to the LLM (so digest cites @karpathy not @<popclawId>)', async () => {
    const llm = vi.fn().mockResolvedValue('out');
    const item = scoredItem({ handle: 'karpathy', authorPopclawId: 'FAKE_abc123xyz' });
    await renderDigest([item], defaultCadence(), llm);
    const promptArg = llm.mock.calls[0]![0] as string;
    expect(promptArg).toContain('handle=karpathy');
    // Prompt should explicitly steer the LLM to use handle, not popclawId, in author attribution.
    expect(promptArg.toLowerCase()).toMatch(/use the handle|@karpathy|by handle/);
  });
});
