import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPopclawBriefCommand } from '../../../src/commands/popclaw-brief';
import { readStyleNotes } from '../../../src/visual/style-notes';
import { setOwnerLang } from '../../../src/lexicon/owner-language';

// S13 slice: handleStyleFeedback's ack text now renders in `ownerLang()`
// (default en-US) instead of hardcoded zh — pin zh-CN so the assertion below
// stays meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

function styleFileIn(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'canvas-style.md');
}

describe('runPopclawBriefCommand (retired into newspaper, #137)', () => {
  it('--feedback still records the style note and acks, without agent handoff', async () => {
    const styleFile = styleFileIn('brief-fb-');
    const r = await runPopclawBriefCommand(
      { positional: [], flags: { feedback: '多用饼图' } },
      { styleFile, now: () => 0 },
    );
    expect(r.text).toContain('已记下');
    expect(r.continueAgent).toBeUndefined();
    expect(readStyleNotes(styleFile)).toContain('多用饼图');
  });

  it('plain brief forwards to the newspaper flow with a one-line notice prepended', async () => {
    const r = await runPopclawBriefCommand(
      { positional: [], flags: {} },
      { styleFile: styleFileIn('brief-alias-') },
    );
    // Same handoff as /popclaw newspaper: render happens in the agent's turn.
    expect(r.continueAgent).toBe(true);
    const lines = r.text.split('\n');
    // The one-line notice rides an agent directive: it must instruct the agent
    // to relay the retirement AND name the replacement command, so it works
    // whether the agent relays it or the owner reads it raw.
    // LLM-facing, so English is the one source (S12 / decision doc section 4).
    expect(lines[0]).toContain('tell the owner');
    expect(lines[0]).toContain('merged into the paper');
    expect(lines[0]).toContain('/popclaw newspaper');
    // The newspaper directive follows the single notice line.
    expect(lines.slice(1).join('\n')).toMatch(/popclaw_newspaper/);
  });

  it('forwards the [hours] positional to the newspaper window', async () => {
    const r = await runPopclawBriefCommand(
      { positional: ['8'], flags: {} },
      { styleFile: styleFileIn('brief-hours-') },
    );
    expect(r.continueAgent).toBe(true);
    expect(r.text).toContain('the last 8 hours');
  });

  it('the old visual render path is gone from src entirely (#137 regression pin)', () => {
    // brief/recommend --visual rode the plugin-side completion subsystem,
    // which fails on subscription/OAuth hosts. Nothing in src may reference
    // renderVisualCanvas / buildVisualPrompt again.
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '../../../src');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts')) {
          const body = readFileSync(p, 'utf-8');
          if (body.includes('renderVisualCanvas') || body.includes('buildVisualPrompt')) hits.push(p);
        }
      }
    };
    walk(srcDir);
    expect(hits).toEqual([]);
  });
});
