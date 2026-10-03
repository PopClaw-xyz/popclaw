import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEXICON, matchLexicon, renderL1, renderL2Hit } from '../../../src/routing/lexicon.js';
import { OPTIONAL_TOOLS } from '../../../src/tools/register-tools.js';

// The manifest is the canonical tool set: register-tools.test.ts already fails the
// moment registerTool() and contracts.tools drift apart, in either direction. So
// reading it here is equivalent to reading the registry, without importing it.
const MANIFEST = resolve(dirname(fileURLToPath(import.meta.url)), '../../../openclaw.plugin.json');
const REGISTERED: string[] = JSON.parse(readFileSync(MANIFEST, 'utf-8')).contracts.tools;

const CORE = LEXICON.filter((e) => e.core);

describe('LEXICON data shape (ADR-0043 §2)', () => {
  // ADR-0035: never throw in register(); a typo'd tool name must fail here, not
  // at install/list/inspect time.
  //
  // ADR-0044 §8: "registered" is not enough — optional tools are in the manifest
  // too but stay out of the model's tool table unless the session's toolsAllow
  // names them. A routing entry pointing at one would teach the model to call a
  // tool it cannot see, which is exactly the fabrication ADR-0043 exists to kill.
  it('every entry points at a tool the model can actually see', () => {
    for (const entry of LEXICON) {
      expect(REGISTERED, `unknown tool: ${entry.tool}`).toContain(entry.tool);
      expect(OPTIONAL_TOOLS, `hidden tool: ${entry.tool}`).not.toContain(entry.tool);
    }
  });

  it('keeps core entries at 8 or fewer, each with a demo', () => {
    expect(CORE.length).toBeLessThanOrEqual(8);
    for (const entry of CORE) expect(entry.demo, entry.tool).toBeTruthy();
  });

  // Phrases are eaten as plain substrings — house-supplied entries (slice 4) ride
  // the same rule, so no regex metacharacters and nothing shorter than 2 chars.
  it('phrases are plain substrings, 2 chars or more', () => {
    for (const entry of LEXICON) {
      expect(entry.say.length, entry.tool).toBeGreaterThan(0);
      for (const phrase of entry.say) {
        expect(phrase.length, `${entry.tool}: ${phrase}`).toBeGreaterThanOrEqual(2);
        expect(phrase, `${entry.tool}: ${phrase}`).not.toMatch(/[\\^$.*+?()[\]{}|]/);
      }
    }
  });
});

describe('matchLexicon', () => {
  // The two real incidents (ADR-0043 §8): host-a 2026-07-29, host-b 2026-07-30.
  it.each(['出一份报纸', '今天江湖有什么', '来份晨报'])('routes %s to the newspaper', (prompt) => {
    expect(matchLexicon(prompt)[0]?.tool).toBe('popclaw_newspaper');
  });

  it.each(['画一个我的近况卡片', '画张图'])('routes %s to canvas', (prompt) => {
    expect(matchLexicon(prompt)[0]?.tool).toBe('popclaw_canvas');
  });

  // host-b 2026-07-30 19:29: asked "他有什么新动态啊" about host-a minutes after host-a
  // posted. The read path was fine — the house serves that post live — but nothing
  // routed the question to a tool, so the model answered from its own memory and
  // reported "no new posts today". Absence asserted without looking is fabrication.
  it.each(['他有什么新动态啊', 'host-a最新帖是什么', '他最近在忙什么'])(
    'routes %s to author_latest',
    (prompt) => {
      expect(matchLexicon(prompt)[0]?.tool).toBe('popclaw_author_latest');
    },
  );

  // Ruling L (follow-doorbell, 2026-08-31) + owner rulings 2026-09-01 /
  // 2026-09-13: the reader pass is not a newspaper feature — it makes a
  // BROWSER the reader's own for any page shared with them — so the phrase
  // the page prints is the generic 「配对 XXXX」. The paper-specific 登录报纸
  // and the first cut's coined 认报 both stay as aliases, so pages already in
  // the wild keep routing. A weak host describing its way to a call misses
  // all three without a table entry; this entry is ADR-0043's named
  // mitigation for exactly that.
  it.each([
    '配对 811121',
    '配对一下这个浏览器',
    'pair 811121',
    '登录报纸 令牌 811121',
    '登录报纸 811121',
    '登录报纸',
    '认报 3m8v',
    '跟我的 PopClaw 说认报',
    '认报',
  ])('routes %s to pair_browser', (prompt) => {
    expect(matchLexicon(prompt)[0]?.tool).toBe('popclaw_pair_browser');
  });

  // A newcomer asking for a house's recent content in plain words, in
  // either language, must route to the feed (see comment on the entry).
  it.each([
    'show me the recent content of my lore-house',
    'what are the latest posts here',
    '看看灯坊最近的内容',
    '最近有什么帖子',
  ])('routes %s to show_feed', (prompt) => {
    expect(matchLexicon(prompt)[0]?.tool).toBe('popclaw_show_feed');
  });

  // A general aid: a question about a letter someone sent the owner should
  // signpost the inbox. (The 2026-09-25 incident itself was a wrong-direction
  // before_id cursor inside popclaw_show_inbox, covered in register-tools.)
  it.each([
    '找一下 EngA 22:57 给我发的消息',
    '刚才那封是谁发的',
    'EngA 给我发的私信说了什么',
    '看看私信',
    '有新消息吗',
    'show me the DM from EngA',
    'show me what EngA sent me',
  ])('routes %s to show_inbox', (prompt) => {
    expect(matchLexicon(prompt)[0]?.tool).toBe('popclaw_show_inbox');
  });

  // The inbox phrases are read-shaped on purpose: asking to SEND a DM must
  // not be signposted to the inbox reader.
  it.each([
    '给 EngA 发条私信',
    '帮我给他发个消息',
    '这条帖子是谁发的',
    '把我刚才发的消息撤回',
    '我发的私信他收到了吗',
    'send the message from my draft',
  ])('does not route %s to show_inbox', (prompt) => {
    expect(matchLexicon(prompt).map((e) => e.tool)).not.toContain('popclaw_show_inbox');
  });

  it('returns nothing for unrelated prompts', () => {
    expect(matchLexicon('帮我把这段代码重构一下')).toEqual([]);
  });

  it('returns at most 2 entries, longest match first', () => {
    const hits = matchLexicon('画张图，再出一份报纸，顺便看看交情本');
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('prefers the longer phrase when two entries match', () => {
    const extra = [
      { tool: 'popclaw_world_guide', say: ['明信片'], from: 'world' },
      { tool: 'popclaw_world_summary', say: ['寄张明信片'], from: 'world' },
    ];
    expect(matchLexicon('帮我寄张明信片', extra)[0]?.tool).toBe('popclaw_world_summary');
  });

  it('is pure: extra entries do not leak into the next call', () => {
    matchLexicon('明信片', [{ tool: 'popclaw_world_guide', say: ['明信片'], from: 'world' }]);
    expect(matchLexicon('明信片')).toEqual([]);
  });
});

describe('renderL1 (ADR-0043 §3)', () => {
  const l1 = renderL1();
  const actions = l1
    .split('\n')
    .filter((line) => line.includes('→ You: '))
    .map((line) => line.split('→ You: ')[1]!);

  it('shows at most 8 demo groups, one of them a failure demo', () => {
    expect(actions.length).toBeLessThanOrEqual(8);
    const negative = actions.filter((a) => a.startsWith('「'));
    expect(negative).toHaveLength(1);
    expect(negative[0]).toMatch(/超时|失败/);
  });

  // Demo lint: the demo block must never itself teach fabrication — assistant
  // actions are tool calls only, and no example carries a link.
  it('assistant actions are tool calls, and no demo contains a link', () => {
    const positive = actions.filter((a) => !a.startsWith('「'));
    expect(positive).toHaveLength(CORE.length);
    for (const action of positive) expect(action).toMatch(/^call popclaw_\w+/);
    expect(l1).not.toMatch(/https?:\/\//);
  });

  it('carries the faithfulness tail and no soften-the-failure wording', () => {
    expect(l1).toContain('tell the owner it failed');
    expect(l1).not.toMatch(/best you can|do your best/i);
    expect(l1).not.toMatch(/roughly|approximate/i);
  });
});

describe('renderL2Hit (ADR-0043 §3)', () => {
  const newspaper = LEXICON.find((e) => e.tool === 'popclaw_newspaper')!;

  it('is a signpost, not a steering wheel', () => {
    const text = renderL2Hit(newspaper);
    expect(text).toContain('should most likely call');
    expect(text).toContain('popclaw_newspaper');
    expect(text).not.toMatch(/\bmust\b/i);
    expect(text).not.toMatch(/\balways call\b/i);
  });

  it('spells out the follow-up chain', () => {
    expect(renderL2Hit(newspaper)).toContain('popclaw_publish_newspaper');
  });

  it('carries the faithfulness tail and no soften-the-failure wording', () => {
    const text = renderL2Hit(newspaper);
    expect(text).toContain('tell the owner it failed');
    expect(text).not.toMatch(/best you can|do your best/i);
  });

  // ADR-0041 §5: a house-supplied entry must say which house it came from.
  it('attributes house entries to their house', () => {
    const text = renderL2Hit({ tool: 'popclaw_world_guide', say: ['明信片'], from: 'world' });
    expect(text).toContain('world');
    expect(text).toContain('明信片');
    expect(text).toContain('tell the owner it failed');
  });
});
