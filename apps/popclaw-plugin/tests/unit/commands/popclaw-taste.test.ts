import { describe, expect, it } from 'vitest';
import { runPopclawTasteCommand, TASTE_HARVEST_PROMPT } from '../../../src/commands/popclaw-taste.js';

describe('runPopclawTasteCommand', () => {
  it('交给 agent —— popclaw 自己读不了也不该读主人的对话记忆', async () => {
    const out = await runPopclawTasteCommand();
    expect(out.continueAgent).toBe(true);
    expect(out.text).toContain('popclaw_write_taste');
  });
});

// 这段指令是这一刀的承重件：挖法错了拿不到东西，纪律松了会编出一份假口味，
// 而假口味比空口味更糟 —— 空的会被 status 提醒补上，编的会一直骗下去。
describe('TASTE_HARVEST_PROMPT', () => {
  it('指明三条挖法，且强调跨全部会话（只看当前会话是最容易犯的错）', () => {
    for (const t of ['memory_search', 'lcm_grep', 'memory_get', 'every session']) {
      expect(TASTE_HARVEST_PROMPT).toContain(t);
    }
  });

  it('索引没建时给出自救命令', () => {
    expect(TASTE_HARVEST_PROMPT).toContain('openclaw memory index --force');
  });

  it('禁止拿人设凑数，且 mute 没证据要留空', () => {
    expect(TASTE_HARVEST_PROMPT).toContain('USER.md');
    expect(TASTE_HARVEST_PROMPT).toContain('Better empty than guessed');
  });

  it('带成本闸 —— 实测一次收割约 59 万 token', () => {
    expect(TASTE_HARVEST_PROMPT).toMatch(/At most\s*8\s*searches/);
  });
});
