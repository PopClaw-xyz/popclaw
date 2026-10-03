/**
 * `popclaw_show_namecard` argument handling at the tool boundary.
 *
 * A host that calls the tool with `{}` — or with the parameter under a name it
 * guessed (`popclaw_id` / `name` / `id`) — used to reach `input.trim()` on
 * `undefined`, and because this tool registers without the `withTail` wrapper
 * the raw `TypeError` went straight into the tool result. An exception string
 * is not an answer: it tells the agent nothing it can act on and tells the
 * owner nothing at all.
 */
import { describe, it, expect, vi } from 'vitest';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';

type FakeTool = {
  name: string;
  description?: string;
  execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
};

function namecardTool(): FakeTool {
  const tools: FakeTool[] = [];
  const api = {
    registerTool: (tool: unknown) => {
      const resolved = typeof tool === 'function' ? (tool as (ctx: unknown) => unknown)({}) : tool;
      const t = resolved as FakeTool;
      if (t?.name && typeof t.execute === 'function') tools.push(t);
    },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  const runtime = vi.fn(async () => ({
    boot: { loreHouseUrl: 'http://lh.example', webBaseUrl: 'https://popclaw.me', popclawId: '', nickname: '' },
  })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'];
  registerPopclawTools({ api, runtime });
  const found = tools.find((t) => t.name === 'popclaw_show_namecard');
  if (!found) throw new Error('tool not found: popclaw_show_namecard');
  return found;
}

/** Nothing that only a thrown JS error would produce may appear in tool output. */
function expectNoExceptionText(text: string): void {
  expect(text).not.toMatch(/TypeError|Cannot read|undefined/);
}

describe('popclaw_show_namecard argument handling', () => {
  it('answers `{}` with the lexicon line instead of a raw JS error', async () => {
    const out = await namecardTool().execute('c1', {});
    expect(out.text).toBe(renderCopy(ownerLang(), 'person.mustSayWho'));
    expectNoExceptionText(out.text);
  });

  it('answers a missing argument object the same way', async () => {
    for (const params of [undefined, null, 'elon', 42]) {
      const out = await namecardTool().execute('c1', params);
      expect(out.text).toBe(renderCopy(ownerLang(), 'person.mustSayWho'));
      expectNoExceptionText(out.text);
    }
  });

  it('answers a non-string / blank `person` the same way', async () => {
    for (const params of [{ person: 42 }, { person: '' }, { person: '   ' }, { person: null }]) {
      const out = await namecardTool().execute('c1', params);
      expect(out.text).toBe(renderCopy(ownerLang(), 'person.mustSayWho'));
      expectNoExceptionText(out.text);
    }
  });

  // The three names hosts actually guessed when they did not send `person`.
  it('accepts popclaw_id / name / id as aliases for person', async () => {
    for (const key of ['popclaw_id', 'name', 'id']) {
      const out = await namecardTool().execute('c1', { [key]: 'nobody-by-that-name' });
      // Resolution ran on the aliased value: the miss names it back.
      expect(out.text).toContain('nobody-by-that-name');
      expect(out.text).not.toBe(renderCopy(ownerLang(), 'person.mustSayWho'));
      expectNoExceptionText(out.text);
    }
  });

  // Control group for the assertion above: with `person` present, an alias
  // carrying something else must not win.
  it('prefers person over an alias', async () => {
    const out = await namecardTool().execute('c1', { person: 'the-one-asked-for', id: 'the-other-one' });
    expect(out.text).toContain('the-one-asked-for');
    expect(out.text).not.toContain('the-other-one');
  });
});
