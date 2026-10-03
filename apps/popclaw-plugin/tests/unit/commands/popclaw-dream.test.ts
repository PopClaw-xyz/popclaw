import { describe, expect, it } from 'vitest';
import { runPopclawDreamCommand } from '../../../src/commands/popclaw-dream.js';

describe('runPopclawDreamCommand', () => {
  it('hands off to the agent — the plugin never dreams by itself', async () => {
    const out = await runPopclawDreamCommand();
    expect(out.continueAgent).toBe(true);
    expect(out.text).toContain('popclaw_dream');
    expect(out.text).toContain('popclaw_record_dream');
  });
});
