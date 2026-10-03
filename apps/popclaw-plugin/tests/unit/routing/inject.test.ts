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
    expect(injection?.prependContext).toContain('popclaw_publish_newspaper'); // 链条说完
    expect(injection?.prependContext).toContain('tell the owner it failed'); // 忠实尾巴随行
    // hits 只喂日志/trace，不回传宿主；trigger 是表内常量（隐私铁律，routing/trace.ts）。
    expect(injection?.hits).toEqual([{ tool: 'popclaw_newspaper', trigger: '报纸' }]);
  });

  it('injects only the cached L1 block for unrelated prompts', () => {
    const injection = buildInjection('帮我把这段代码重构一下');
    expect(injection?.appendSystemContext).toContain('popclaw tool routing');
    expect(injection?.prependContext).toBeUndefined();
    expect(injection?.hits).toBeUndefined();
  });

  // L1 的负例席位是本 ADR 的灵魂（§3）——直接回归 host-a 病理。
  it('L1 carries the failure demo', () => {
    const l1 = buildInjection('随便说点什么')?.appendSystemContext ?? '';
    expect(l1).toContain('超时');
    expect(l1).toContain('没出来');
  });

  it('assembles L1 once per process', () => {
    expect(buildInjection('a')?.appendSystemContext).toBe(buildInjection('b')?.appendSystemContext);
  });

  // 断电闸（§6）：一个环境变量全关，不改配置、不重装。
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

// 真机 2026-07-31（同一个坑第四次）：host-c 那台包对、`popclaw_recent_attachments`
// 注册上了（45→46）、语音 14:45 就在盘上，而 agent（kimi-k2.7）**一次都没调那个
// 工具**，直接从"这是 Feishu 收到的"推断出"拿不到本地路径"。前两级修法（给口子、
// 写描述）有效是因为那时"没有口子/不知道有"；这次口子有、描述也写了，它压根没打开
// 工具箱。所以这一级不再指望它想起来 —— 把路径摆进它这一轮的上下文。
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

  // 这两句是这一刀的全部要害：它上次的失败正是"声称拿不到"+"让主人另存"。
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
