import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import { runPopclawRecommendCommand } from '../../../src/commands/popclaw-recommend.js';
import { defaultCadence } from '../../../src/cadence/cadence-loader.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

afterEach(() => setOwnerLang(undefined));
describe.each([
  ['zh-CN', '暂时没有达到推荐门槛的内容。稍后再来看看。'],
  ['en-US', 'No items meet your recommendation threshold yet. Check back later.'],
])('recommend empty state (%s)', (language, expected) => {
  it('uses owner language at the real command boundary without invoking either LLM', async () => {
    setOwnerLang(language, 'config');
    const llmScore = vi.fn(async () => '[]');
    const llmRender = vi.fn(async () => 'unexpected');
    const runtime = {
      worldFeedCache: { recent: () => [] }, tasteLoader: { enabledSources: async () => [] },
      cadenceLoader: { load: async () => defaultCadence() }, socialGraph: { followsIn: () => false },
    };
    const result = await runPopclawRecommendCommand({ positional: [], flags: {} }, {
      // Only these methods are consumed on the empty path; no real host is booted.
      cache: runtime.worldFeedCache, tasteLoader: runtime.tasteLoader as unknown as Parameters<typeof runPopclawRecommendCommand>[1]['tasteLoader'],
      cadenceLoader: runtime.cadenceLoader as Parameters<typeof runPopclawRecommendCommand>[1]['cadenceLoader'],
      socialGraph: runtime.socialGraph as unknown as Parameters<typeof runPopclawRecommendCommand>[1]['socialGraph'], llmScore, llmRender,
    });
    expect(result.text).toBe(expected);
    expect(llmScore).not.toHaveBeenCalled();
    expect(llmRender).not.toHaveBeenCalled();
    const collector = makeToolCollector();
    registerPopclawTools({ api: collector.api, runtime: (async () => runtime) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'] });
    const tool = collector.tools.find((t) => t.name === 'popclaw_show_recommend')!;
    expect(await tool.execute('empty-fixture', {})).toEqual({ type: 'text', text: expected });
  });
});
