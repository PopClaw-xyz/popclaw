import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPopclawNewspaperCommand } from '../../../src/commands/popclaw-newspaper.js';
import { readStyleNotes } from '../../../src/visual/style-notes';
import { setOwnerLang } from '../../../src/lexicon/owner-language';

// S13 slice: handleStyleFeedback's ack text now renders in `ownerLang()`
// (default en-US) instead of hardcoded zh — pin zh-CN so that assertion
// stays meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

describe('runPopclawNewspaperCommand', () => {
  it('hands off to the agent (continueAgent) with a render directive', async () => {
    const r = await runPopclawNewspaperCommand({ positional: [] });
    expect(r.continueAgent).toBe(true);
    // LLM-facing handoff, so English is the one source (S12).
    expect(r.text).toMatch(/popclaw_newspaper/);
    expect(r.text).toContain('today');
  });

  it('includes an owner-specified window hint', async () => {
    const r = await runPopclawNewspaperCommand({ positional: ['8'] });
    expect(r.text).toContain('the last 8 hours');
  });

  it('uses the current structured-copy flow, preserving batch references and workshop receipts', async () => {
    const r = await runPopclawNewspaperCommand({ positional: [] });
    expect(r.text).toContain('edit');
    expect(r.text).toContain('basis');
    expect(r.text).toContain('batch');
    expect(r.text).toContain('finished');
    expect(r.text).toContain('verbatim');
    expect(r.text).not.toContain('full-page HTML');
  });

  it('--feedback records a style note and acks, without agent handoff (#137)', async () => {
    const styleFile = join(mkdtempSync(join(tmpdir(), 'np-fb-')), 'canvas-style.md');
    const r = await runPopclawNewspaperCommand(
      { positional: [], flags: { feedback: '字体大点' } },
      { styleFile, now: () => 0 },
    );
    expect(r.text).toContain('已记下');
    expect(r.continueAgent).toBeUndefined();
    expect(readStyleNotes(styleFile)).toContain('字体大点');
  });
});
