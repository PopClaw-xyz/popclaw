import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { findBonds } from '../../../src/bonds/find-bonds.js';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

function fresh(): BondsStore {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS_DIR);
  return new BondsStore(db, () => 1000);
}

describe('findBonds', () => {
  it('empty bond book → no LLM call, friendly text', async () => {
    const llm = vi.fn();
    const out = await findBonds({ bondsStore: fresh(), llmComplete: llm }, '我的生意伙伴');
    expect(llm).not.toHaveBeenCalled();
    // S2 scope call: the prompt/fallback copy is LLM-facing, so it is plain
    // English regardless of ownerLang() (see find-bonds.ts doc comment).
    expect(out).toContain('bond book');
  });

  it('ONE LLM call; prompt carries query + candidate tags/description/dynamics; returns its text', async () => {
    const s = fresh();
    s.setTier('A', 'friend', 'manual');
    s.setKnowledge('A', { remarkName: '阿青', description: '天使投资人', tags: ['investor'] });
    s.addDynamic('A', { ts: 100, summary: '投了一家 AI 公司', isMilestone: false });
    const llm = vi.fn().mockResolvedValue('你的生意伙伴：阿青（投资人）最近投了一家 AI 公司。');
    const out = await findBonds({ bondsStore: s, llmComplete: llm }, '我的投资人最近动态');
    expect(llm).toHaveBeenCalledTimes(1);
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain('我的投资人最近动态');
    expect(prompt).toContain('阿青');
    expect(prompt).toContain('investor');
    expect(prompt).toContain('投了一家 AI 公司');
    expect(out).toContain('阿青');
  });

  it('falls back to list() when FTS yields too few candidates', async () => {
    const s = fresh();
    // 5 people, none whose indexed text matches the (CJK) query → FTS thin → fallback
    for (const id of ['A', 'B', 'C', 'D', 'E']) {
      s.setTier(id, 'friend', 'manual');
      s.setKnowledge(id, { description: 'engineer', tags: ['eng'] });
    }
    const llm = vi.fn().mockResolvedValue('summary');
    await findBonds({ bondsStore: s, llmComplete: llm }, '谁是我的合伙人');
    const prompt = llm.mock.calls[0]![0] as string;
    // fallback pool includes all 5 friends
    for (const id of ['A', 'B', 'C', 'D', 'E']) expect(prompt).toContain(id.slice(0, 10));
  });

  // 认人（ADR-0028 修订）：列人输出补机器字段——LLM 手上得有完整 popclaw_id，
  // 后续对这个人动作（私信/关注）才不用再猜。
  it('prompt carries each person FULL popclaw_id', async () => {
    const s = fresh();
    const longId = 'ALICE' + 'x'.repeat(30);
    s.setTier(longId, 'friend', 'manual');
    s.setKnowledge(longId, { remarkName: '阿丽', description: '投资人', tags: ['investor'] });
    const llm = vi.fn().mockResolvedValue('ok');
    await findBonds({ bondsStore: s, llmComplete: llm }, '我的投资人');
    const prompt = llm.mock.calls[0]![0] as string;
    expect(prompt).toContain(longId);
  });

  it('LLM throw propagates (caller handles)', async () => {
    const s = fresh();
    s.setTier('A', 'friend', 'manual');
    s.setKnowledge('A', { description: 'x', tags: ['t'] });
    const llm = vi.fn().mockRejectedValue(new Error('llm down'));
    await expect(findBonds({ bondsStore: s, llmComplete: llm }, 'q')).rejects.toThrow('llm down');
  });
});
