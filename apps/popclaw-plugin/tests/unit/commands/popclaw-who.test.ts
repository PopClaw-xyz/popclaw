import { describe, expect, it, vi } from 'vitest';
import { runPopclawWhoCommand } from '../../../src/commands/popclaw-who.js';

describe('runPopclawWhoCommand', () => {
  it('joins positional into the query and returns findBonds text', async () => {
    const findBonds = vi.fn().mockResolvedValue('你的生意伙伴：阿青…');
    const out = await runPopclawWhoCommand({ positional: ['我的', '生意伙伴'] }, { findBonds });
    expect(findBonds).toHaveBeenCalledWith('我的 生意伙伴');
    expect(out.text).toContain('阿青');
  });

  it('empty query → usage hint, no findBonds call', async () => {
    const findBonds = vi.fn();
    const out = await runPopclawWhoCommand({ positional: [] }, { findBonds });
    expect(findBonds).not.toHaveBeenCalled();
    expect(out.text).toMatch(/用法|who/);
  });

  it('findBonds throw → friendly error', async () => {
    const findBonds = vi.fn().mockRejectedValue(new Error('llm down'));
    const out = await runPopclawWhoCommand({ positional: ['x'] }, { findBonds });
    expect(out.text).toContain('failed');
  });
});
