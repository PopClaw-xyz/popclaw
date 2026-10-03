/**
 * S4-T4 规格 4: 梯度冷启动排序 — 单 matrix prompt（cost 纪律），
 * LLM 失败/坏输出 → 原热度序，绝不抛。
 */
import { describe, it, expect, vi } from 'vitest';
import { rankBySummaryTaste, buildSummaryRankPrompt } from '../../../src/world/summary-ranker.js';
import type { HotPost } from '../../../src/world/world-summary-client.js';

function post(id: string, preview: string): HotPost {
  return {
    event_id: id,
    author: 'AAAA1111',
    platform: 'x',
    body_preview: preview,
    reply_count: 1,
    quote_count: 0,
    created_at_ms: 1_718_000_000_000,
  };
}

const POSTS = [post('e1', 'AI 论文速读'), post('e2', '街头摄影心得'), post('e3', '加密货币行情')];
const CORE = '爱看 AI 论文，周末扫街摄影';

describe('rankBySummaryTaste', () => {
  it('单次 LLM 调用 + 全部条目进同一个 prompt（matrix，cost 纪律）', async () => {
    let prompt = '';
    const llm = {
      complete: vi.fn(async (p: string) => {
        prompt = p;
        return '{"order":[2,1,3]}';
      }),
    };
    await rankBySummaryTaste(llm, CORE, POSTS);
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(prompt).toContain('AI 论文速读');
    expect(prompt).toContain('街头摄影心得');
    expect(prompt).toContain('加密货币行情');
    expect(prompt).toContain(CORE);
  });

  it('按 LLM 返回序重排（1-based 序号）', async () => {
    const llm = { complete: async () => '{"order":[3,1,2]}' };
    const ranked = await rankBySummaryTaste(llm, CORE, POSTS);
    expect(ranked.map((p) => p.event_id)).toEqual(['e3', 'e1', 'e2']);
  });

  it('容忍 markdown fence 包裹', async () => {
    const llm = { complete: async () => '```json\n{"order":[2,3,1]}\n```' };
    const ranked = await rankBySummaryTaste(llm, CORE, POSTS);
    expect(ranked.map((p) => p.event_id)).toEqual(['e2', 'e3', 'e1']);
  });

  it('缺序号 → 漏掉的按原序补尾；越界/重复序号忽略', async () => {
    const llm = { complete: async () => '{"order":[2,2,99,0]}' };
    const ranked = await rankBySummaryTaste(llm, CORE, POSTS);
    expect(ranked.map((p) => p.event_id)).toEqual(['e2', 'e1', 'e3']);
  });

  it('LLM 抛 → 原序不抛', async () => {
    const llm = { complete: async () => { throw new Error('LLM down'); } };
    const ranked = await rankBySummaryTaste(llm, CORE, POSTS);
    expect(ranked.map((p) => p.event_id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('坏 JSON → 原序', async () => {
    const llm = { complete: async () => 'not json at all' };
    const ranked = await rankBySummaryTaste(llm, CORE, POSTS);
    expect(ranked.map((p) => p.event_id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('llm=null → 原序，零调用', async () => {
    const ranked = await rankBySummaryTaste(null, CORE, POSTS);
    expect(ranked.map((p) => p.event_id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('coreText 空白 → 原序，LLM 零调用', async () => {
    const llm = { complete: vi.fn(async () => '{"order":[3,2,1]}') };
    const ranked = await rankBySummaryTaste(llm, '   ', POSTS);
    expect(ranked.map((p) => p.event_id)).toEqual(['e1', 'e2', 'e3']);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('≤1 条 → 原序，LLM 零调用', async () => {
    const llm = { complete: vi.fn(async () => '{"order":[1]}') };
    const one = [post('only', 'solo')];
    expect(await rankBySummaryTaste(llm, CORE, one)).toEqual(one);
    expect(await rankBySummaryTaste(llm, CORE, [])).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('不修改入参数组', async () => {
    const llm = { complete: async () => '{"order":[3,1,2]}' };
    const input = [...POSTS];
    await rankBySummaryTaste(llm, CORE, input);
    expect(input.map((p) => p.event_id)).toEqual(['e1', 'e2', 'e3']);
  });
});

describe('buildSummaryRankPrompt', () => {
  it('prompt 含编号清单与 JSON 输出契约', () => {
    const prompt = buildSummaryRankPrompt(CORE, POSTS);
    expect(prompt).toContain('1.');
    expect(prompt).toContain('3.');
    expect(prompt).toMatch(/order/);
  });
});
