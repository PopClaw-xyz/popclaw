/**
 * S1: the two tool-side entry points of the owner-language chain —
 *   - `owner_language` on `popclaw_onboarding_continue` (the agent's passive
 *     observation; lane 2, loses to explicit config)
 *   - `popclaw_update_cadence` (the owner said so out loud; lane 1, always wins
 *     — and per decision 7 this tool IS the language switch, there is no
 *     `/popclaw language` command)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import {
  observeOwnerText,
  ownerLangTag,
  ownerLangSource,
  setOwnerLang,
  useOwnerLangFile,
} from '../../../src/lexicon/owner-language.js';
import { ownerTz, setOwnerTz } from '../../../src/time/time-context.js';

afterEach(() => {
  setOwnerLang(undefined);
  setOwnerTz(undefined);
});

function buildFakeApi() {
  const tools: Array<{
    name: string;
    description: string;
    execute: (callId: string, params: unknown) => Promise<{ type: string; text: string }>;
  }> = [];
  const api = {
    registerTool: (tool: { name?: string; execute?: unknown }) => {
      if (tool?.name && typeof tool.execute === 'function') tools.push(tool as typeof tools[number]);
    },
    logger: { info: vi.fn() },
  } as Parameters<typeof registerPopclawTools>[0]['api'];
  return { api, tools };
}

/** Register the tools over a throwaway data root; returns the tools + that root. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lang-'));
  const paths = new PopclawPaths(root);
  const { api, tools } = buildFakeApi();
  registerPopclawTools({
    api,
    runtime: (async () => ({ paths })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    getOrchestrator: (async () => ({
      handleAdvance: async () => ({ text: 'ok' }),
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['getOrchestrator'],
  });
  const find = (name: string) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return t;
  };
  return { find, paths };
}

function readCadence(paths: PopclawPaths): { delivery?: Record<string, unknown> } {
  return JSON.parse(readFileSync(join(paths.cadenceDir(), 'cadence.json'), 'utf-8'));
}

describe('owner_language on popclaw_onboarding_continue', () => {
  it('registers the observed language and persists it — to data/, never to cadence.json', async () => {
    const { find, paths } = setup();
    useOwnerLangFile(paths.ownerLanguageFile());
    await find('popclaw_onboarding_continue').execute('c1', { answer: 'x', owner_language: 'zh-CN' });

    expect(ownerLangTag()).toBe('zh-CN');
    expect(ownerLangSource()).toBe('agent');
    expect(JSON.parse(readFileSync(paths.ownerLanguageFile(), 'utf-8'))).toEqual({ tag: 'zh-CN' });
    // An observation in cadence.json would come back as an explicit setting
    // next boot and lock the owner out of ever switching language again.
    expect(() => readCadence(paths)).toThrow();
  });

  it('never overrides an explicitly configured language, and writes nothing', async () => {
    const { find, paths } = setup();
    setOwnerLang('en-US', 'config');

    await find('popclaw_onboarding_continue').execute('c1', { answer: 'x', owner_language: 'zh-CN' });

    expect(ownerLangTag()).toBe('en-US');
    expect(() => readCadence(paths)).toThrow(); // no cadence.json was created
  });

  it('ignores an absent or blank tag', async () => {
    const { find } = setup();
    await find('popclaw_onboarding_continue').execute('c1', { answer: 'x' });
    await find('popclaw_onboarding_continue').execute('c2', { answer: 'x', owner_language: '  ' });
    expect(ownerLangSource()).toBeUndefined();
  });
});

describe('owner_language on the dream tools', () => {
  it('takes the agent\'s nightly reading, and lets a later observation replace it', async () => {
    const { find } = setup();
    // The dream tools fail on this stub runtime — the language must land anyway.
    await find('popclaw_dream').execute('c1', { owner_language: 'ja-JP' });
    expect(ownerLangTag()).toBe('ja-JP');
    expect(ownerLangSource()).toBe('agent');

    await find('popclaw_record_dream').execute('c2', { dream_token: 't', owner_language: 'zh-CN' });
    expect(ownerLangTag()).toBe('zh-CN');

    // Not a latch: tomorrow's turns can move it again.
    observeOwnerText('good morning, show me what happened in the world overnight');
    expect(ownerLangTag()).toBe('en-US');
  });

  it('never overrides an explicit configuration', async () => {
    const { find } = setup();
    setOwnerLang('en-US', 'config');
    await find('popclaw_dream').execute('c1', { owner_language: 'zh-CN' });
    expect(ownerLangTag()).toBe('en-US');
  });
});

describe('popclaw_update_cadence', () => {
  it('writes both fields and takes effect immediately', async () => {
    const { find, paths } = setup();
    const r = await find('popclaw_update_cadence').execute('c1', {
      primary_language: 'ja-JP',
      timezone: 'Asia/Tokyo',
    });

    expect(r.text).toContain('ja-JP');
    expect(r.text).toContain('Asia/Tokyo');
    expect(ownerLangTag()).toBe('ja-JP');
    expect(ownerTz()).toBe('Asia/Tokyo');
    expect(readCadence(paths).delivery).toEqual({ primaryLanguage: 'ja-JP', timezone: 'Asia/Tokyo' });
  });

  it('merges into an existing cadence.json without eating unknown fields', async () => {
    const { find, paths } = setup();
    mkdirSync(paths.cadenceDir(), { recursive: true });
    writeFileSync(
      join(paths.cadenceDir(), 'cadence.json'),
      JSON.stringify({ schemaVersion: 1, delivery: { tone: 'terse', futureKnob: 7 }, mine: 'keep' }),
    );

    await find('popclaw_update_cadence').execute('c1', { primary_language: 'zh-CN' });

    const raw = readCadence(paths) as Record<string, unknown> & { delivery: Record<string, unknown> };
    expect(raw.delivery.primaryLanguage).toBe('zh-CN');
    expect(raw.delivery.tone).toBe('terse');
    expect(raw.delivery.futureKnob).toBe(7);
    expect(raw.mine).toBe('keep');
  });

  it('beats a language the agent had merely observed', async () => {
    const { find } = setup();
    setOwnerLang('zh-CN', 'agent');
    await find('popclaw_update_cadence').execute('c1', { primary_language: 'en-US' });
    expect(ownerLangTag()).toBe('en-US');
    expect(ownerLangSource()).toBe('config');
  });

  it('rejects a bogus timezone instead of persisting it', async () => {
    const { find, paths } = setup();
    const r = await find('popclaw_update_cadence').execute('c1', { timezone: 'Mars/Olympus' });
    expect(r.text).toContain('not an IANA timezone');
    expect(() => readCadence(paths)).toThrow();
  });

  it('says so when given nothing to change', async () => {
    const { find } = setup();
    const r = await find('popclaw_update_cadence').execute('c1', {});
    expect(r.text).toContain('Nothing to change');
  });

  it('carries the one-line description ADR-0044 §4 asks of this tier', () => {
    const { find } = setup();
    expect(find('popclaw_update_cadence').description.split('\n')).toHaveLength(1);
  });
});
