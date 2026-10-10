/**
 * Storage half of one-time taste harvesting. The same two constraints as recordDream apply: reject
 * untagged prose that local matching cannot use, and read the saved content back verbatim so the
 * owner can challenge it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTasteFromMemory } from '../../../src/taste/write-taste.js';
import { readLearnedTaste, LEARNED_FROM_MEMORY, LEARNED_DREAMED } from '../../../src/taste/learned-writer.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S3 rollout slice 4: writeTasteFromMemory now renders in `ownerLang()` (S1
// process-wide singleton). Pin zh-CN so this file's pre-lexicon assertions
// stay byte-for-byte unchanged (same fix as status.test.ts / dream.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const root = () => mkdtemp(join(tmpdir(), 'popclaw-write-taste-'));

describe('writeTasteFromMemory', () => {
  it('没标签 → 拒收，且明说"没挖到就直说，别用人设凑数"', async () => {
    const tasteRoot = await root();
    const r = await writeTasteFromMemory({ tasteRoot }, { summary: '主人是个很棒的人' });
    expect(r.text).toContain('tags 是空的');
    expect(r.text).toContain('人设凑数');
  });

  it('写进 from-memory.md，不碰做梦那一路', async () => {
    const tasteRoot = await root();
    await writeTasteFromMemory({ tasteRoot }, {
      tags: ['红包合约', '识字游戏', '红包合约'], // Duplicate.
      mute: ['名人八卦'],
      summary: '依据：7/23 那次关于合约的对话',
    });
    expect(await readLearnedTaste({ tasteRoot }, LEARNED_FROM_MEMORY)).toEqual({
      tags: ['红包合约', '识字游戏'], // Deduplicate.
      mute: ['名人八卦'],
      summary: '依据：7/23 那次关于合约的对话',
    });
    // Leave the dream path unchanged; the two evidence sources do not overwrite each other.
    expect((await readLearnedTaste({ tasteRoot }, LEARNED_DREAMED)).tags).toEqual([]);
  });

  it('mute 空着时，回话里说清"没编"——空缺是诚实的', async () => {
    const tasteRoot = await root();
    const r = await writeTasteFromMemory({ tasteRoot }, { tags: ['a'] });
    expect(r.text).toContain('没挖到证据，没编');
  });

  it('把写了什么原样念回去 + 告诉主人怎么推翻', async () => {
    const tasteRoot = await root();
    const r = await writeTasteFromMemory({ tasteRoot }, { tags: ['终端工具链'], summary: '依据…' });
    expect(r.text).toContain('终端工具链');
    expect(r.text).toContain('依据…');
    expect(r.text).toContain('core');            // Sovereign layer outranks suggestions.
    expect(r.text).toContain(LEARNED_FROM_MEMORY);
  });

  it('登记进 manifest（权重 0.5，与做梦同为建议层）', async () => {
    const tasteRoot = await root();
    await writeTasteFromMemory({ tasteRoot }, { tags: ['a'] });
    const m = JSON.parse(await readFile(join(tasteRoot, 'manifest.json'), 'utf-8'));
    expect(m.sources[LEARNED_FROM_MEMORY]).toEqual({ weight: 0.5, enabled: true });
  });

  // S3 rollout slice 4 — en lane.
  it('renders in en when set', async () => {
    setOwnerLang('en', 'config');
    const tasteRoot = await root();
    const empty = await writeTasteFromMemory({ tasteRoot }, { summary: 'a summary with no tags' });
    expect(empty.text).toContain('tags is empty');

    const r = await writeTasteFromMemory({ tasteRoot }, { tags: ['rockets'], summary: 'evidence…' });
    expect(r.text).toContain('Saved →');
    expect(r.text).toContain('Likes: rockets');
    expect(r.text).toContain('core');
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });
});

// Real-device acceptance finding: different search terms retrieve different slices (one round found literacy games/Flutter,
// another Starship/social philosophy). Overwriting would make rerunning lose tags, a damaging loss of trust.
describe('writeTasteFromMemory — 合并而不是覆盖', () => {
  it('第二次收割不丢第一次的标签，新的排前面', async () => {
    const tasteRoot = await root();
    await writeTasteFromMemory({ tasteRoot }, { tags: ['识字游戏', 'Flutter'], mute: ['喊单'] });
    const r = await writeTasteFromMemory({ tasteRoot }, { tags: ['SpaceX 星舰', 'Flutter'] });

    const t = await readLearnedTaste({ tasteRoot }, LEARNED_FROM_MEMORY);
    expect(t.tags).toEqual(['SpaceX 星舰', 'Flutter', '识字游戏']); // New entries first, deduplicated, while old entries remain.
    expect(t.mute).toEqual(['喊单']);                              // Preserve old mute entries too.
    expect(r.text).toContain('本次新增：SpaceX 星舰');
  });

  it('第一次收割不说"合并"（没有上一次可合）', async () => {
    const tasteRoot = await root();
    const r = await writeTasteFromMemory({ tasteRoot }, { tags: ['a'] });
    expect(r.text).not.toContain('合并');
  });
});
