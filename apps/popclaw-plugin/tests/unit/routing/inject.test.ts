import { afterEach, describe, expect, it } from 'vitest';
import { recentAttachmentNotice } from '../../../src/routing/inject.js';
import { buildInjection } from '../../../src/routing/inject.js';

afterEach(() => {
  delete process.env.POPCLAW_TOOL_ROUTING;
});

describe('buildInjection (ADR-0043 §1 L1+L2)', () => {
  it('routes 出一份报纸 to the newspaper tool as a signpost, chain and tail included', () => {
    const injection = buildInjection('出一份报纸');
    expect(injection?.prependContext).toContain('popclaw_newspaper');
    expect(injection?.prependContext).toContain('should most likely call');
    expect(injection?.prependContext).toContain('popclaw_publish_newspaper'); // The full chain is included.
    expect(injection?.prependContext).toContain('tell the owner it failed'); // The faithful-result tail accompanies it.
    // hits feed only logs/trace, never the host; trigger is a table constant (privacy invariant, routing/trace.ts).
    expect(injection?.hits).toEqual([{ tool: 'popclaw_newspaper', trigger: '报纸' }]);
  });

  it('injects only the cached L1 block for unrelated prompts', () => {
    const injection = buildInjection('帮我把这段代码重构一下');
    expect(injection?.appendSystemContext).toContain('popclaw tool routing');
    expect(injection?.prependContext).toBeUndefined();
    expect(injection?.hits).toBeUndefined();
  });

  // L1's negative example is central to this ADR (section 3): a direct regression for the host-a failure.
  it('L1 carries the failure demo', () => {
    const l1 = buildInjection('随便说点什么')?.appendSystemContext ?? '';
    expect(l1).toContain('超时');
    expect(l1).toContain('没出来');
  });

  it('assembles L1 once per process', () => {
    expect(buildInjection('a')?.appendSystemContext).toBe(buildInjection('b')?.appendSystemContext);
  });

  // Emergency off switch (section 6): one environment variable disables everything without config changes or reinstall.
  it('injects nothing when POPCLAW_TOOL_ROUTING=off', () => {
    process.env.POPCLAW_TOOL_ROUTING = 'off';
    expect(buildInjection('出一份报纸')).toBeUndefined();
  });

  it('carries house entries with their attribution', () => {
    const injection = buildInjection('帮我寄张明信片', {
      extra: [{ tool: 'popclaw_world_guide', say: ['明信片'], from: 'world' }],
    });
    expect(injection?.prependContext).toContain('world');
    expect(injection?.hits).toEqual([
      { tool: 'popclaw_world_guide', trigger: '明信片', from: 'world' },
    ]);
  });

  it('survives a junk prompt', () => {
    expect(buildInjection('')?.prependContext).toBeUndefined();
  });
});

// Real host-c, 2026-07-31, the fourth recurrence: the package was correct and `popclaw_recent_attachments`
// was registered (45 -> 46); voice media had been on disk since 14:45, but the agent (kimi-k2.7) never called
// the tool. It inferred from "received via Feishu" that no local path was available. The first two fixes (provide a capability
// and describe it) worked when the tool was missing or unknown; now both existed but the agent never opened the toolbox.
// This layer therefore does not rely on recall: put the paths directly into the current turn's context.
describe('recentAttachmentNotice — 把路径摆到模型眼前', () => {
  const now = 1_800_000_000_000;
  const f = (path: string, ageMin: number, size = 17_000) => ({
    path,
    size,
    mtimeMs: now - ageMin * 60_000,
  });

  it('没有新文件 → 一个字都不注（平时不污染每一轮）', () => {
    expect(recentAttachmentNotice([], now)).toBeUndefined();
  });

  it('给绝对路径 + 大小 + 多久之前，新的在前', () => {
    const out = recentAttachmentNotice([f('/in/voice.ogg', 2), f('/in/pic.jpg', 5)], now)!;
    expect(out).toContain('/in/voice.ogg');
    expect(out).toContain('16.6 KB');
    expect(out).toContain('2m ago');
    expect(out.indexOf('/in/voice.ogg')).toBeLessThan(out.indexOf('/in/pic.jpg'));
  });

  // These two sentences are the whole fix: the previous failure claimed paths were inaccessible and asked the owner to save separately.
  it('明写不许声称拿不到、不许让主人先另存', () => {
    const out = recentAttachmentNotice([f('/in/voice.ogg', 1)], now)!;
    expect(out).toContain('attachment_path');
    expect(out).toMatch(/cannot access/i);
    expect(out).toMatch(/save it somewhere first/i);
  });
});


it('routes the configured House entry through the actual injection surface with private-safe trace labels', () => {
  const result = buildInjection('进入 http://127.0.0.1:49200，阅读游戏说明', {knownHouseOrigins: ['http://127.0.0.1:49200']});
  expect(result?.prependContext).toContain('popclaw_house_login');
  expect(result?.hits).toEqual([{tool: 'popclaw_house_login', trigger: 'house-entry'}]);
  expect(JSON.stringify(result?.hits)).not.toContain('49200');
  process.env.POPCLAW_TOOL_ROUTING = 'off';
  expect(buildInjection('进入 http://127.0.0.1:49200，阅读游戏说明', {knownHouseOrigins: ['http://127.0.0.1:49200']})).toBeUndefined();
});
