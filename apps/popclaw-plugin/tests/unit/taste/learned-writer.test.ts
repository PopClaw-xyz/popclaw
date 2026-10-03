/**
 * S4-T4 规格 5: learned writer — 速览反馈（展开/收藏/无感）追加进
 * <tasteRoot>/learned/picks.jsonl（与 TasteLoader 同根；ADR-0011 本地私域）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPick,
  readLearnedTaste,
  writeLearnedTaste,
  type LearnedPick,
} from '../../../src/taste/learned-writer.js';
import { appendCorePrivate } from '../../../src/taste/taste-writer.js';
import { TasteLoader } from '../../../src/taste/taste-loader.js';

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'popclaw-learned-'));
}

function pick(overrides: Partial<LearnedPick> = {}): LearnedPick {
  return {
    ts: 1700000000,
    eventId: 'a'.repeat(64),
    signal: 'expanded',
    summaryLine: '1. [mrbeast] Last to leave wins $100k · ▶️ · 10回应',
    ...overrides,
  };
}

describe('appendPick', () => {
  it('目录自建 + 追加一行 JSONL（形状 {ts,eventId,signal,summaryLine}）', async () => {
    const tasteRoot = await freshRoot();
    await appendPick({ tasteRoot }, pick());

    const file = join(tasteRoot, 'learned', 'picks.jsonl');
    const raw = await readFile(file, 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ts: 1700000000,
      eventId: 'a'.repeat(64),
      signal: 'expanded',
      summaryLine: '1. [mrbeast] Last to leave wins $100k · ▶️ · 10回应',
    });
  });

  it('多次调用是追加不是覆盖', async () => {
    const tasteRoot = await freshRoot();
    await appendPick({ tasteRoot }, pick({ signal: 'saved' }));
    await appendPick({ tasteRoot }, pick({ signal: 'meh', eventId: 'b'.repeat(64) }));

    const raw = await readFile(join(tasteRoot, 'learned', 'picks.jsonl'), 'utf-8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).signal).toBe('saved');
    expect(JSON.parse(lines[1]!).signal).toBe('meh');
  });

  it('summaryLine 含换行时仍是单行 JSONL（JSON 转义）', async () => {
    const tasteRoot = await freshRoot();
    await appendPick({ tasteRoot }, pick({ summaryLine: 'line1\nline2' }));
    const raw = await readFile(join(tasteRoot, 'learned', 'picks.jsonl'), 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  it('不触碰 taste 根其它文件', async () => {
    const tasteRoot = await freshRoot();
    await appendPick({ tasteRoot }, pick());
    await expect(stat(join(tasteRoot, 'manifest.json'))).rejects.toThrow();
  });
});

// learned/dreamed.md —— 做梦写回的建议层（spec 附录 A.3/A.4，第 3 步）
describe('learned taste (dreamed.md)', () => {
  it('round-trips tags/mute/正文，并按 P-002 形态分两半', async () => {
    const tasteRoot = await freshRoot();
    await writeLearnedTaste(
      { tasteRoot },
      { tags: ['航天', '开源治理'], mute: ['币圈喊单'], summary: '我关心实现细节。' },
    );

    const raw = await readFile(join(tasteRoot, 'learned', 'dreamed.md'), 'utf-8');
    expect(raw).toContain('tags: [航天, 开源治理]');
    expect(raw).toContain('mute: [币圈喊单]');

    expect(await readLearnedTaste({ tasteRoot })).toEqual({
      tags: ['航天', '开源治理'],
      mute: ['币圈喊单'],
      summary: '我关心实现细节。',
    });
  });

  it('文件不存在 → 全空（第一次做梦不该炸）', async () => {
    const tasteRoot = await freshRoot();
    expect(await readLearnedTaste({ tasteRoot })).toEqual({ tags: [], mute: [], summary: '' });
  });

  it('覆盖而非追加 —— 建议层交出的是当下最好的一版全貌', async () => {
    const tasteRoot = await freshRoot();
    await writeLearnedTaste({ tasteRoot }, { tags: ['a'], mute: [], summary: '旧' });
    await writeLearnedTaste({ tasteRoot }, { tags: ['b'], mute: [], summary: '新' });
    expect(await readLearnedTaste({ tasteRoot })).toEqual({ tags: ['b'], mute: [], summary: '新' });
  });

  it('登记进 manifest 时权重 0.5 —— 主权层永远压过建议层', async () => {
    const tasteRoot = await freshRoot();
    await appendCorePrivate({ tasteRoot }, '我关心航天');
    await writeLearnedTaste({ tasteRoot }, { tags: ['航天'], mute: [], summary: '' });
    const m = JSON.parse(await readFile(join(tasteRoot, 'manifest.json'), 'utf-8'));
    expect(m.sources['core/private.md']).toEqual({ weight: 1, enabled: true });
    expect(m.sources['learned/dreamed.md']).toEqual({ weight: 0.5, enabled: true });
  });

  it('TasteLoader 读到的是正文，frontmatter 不喂 LLM', async () => {
    const tasteRoot = await freshRoot();
    await writeLearnedTaste({ tasteRoot }, { tags: ['航天'], mute: [], summary: '正文在这里' });
    const sources = await new TasteLoader({ tasteDir: tasteRoot }).enabledSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.content.trim()).toBe('正文在这里');
    expect(sources[0]!.content).not.toContain('tags:');
  });
});

// 审查抓到的（ADR/A.4 主权层压过建议层）：主人把 learned 关掉是明确表态，
// 每晚做梦自动把它重新打开，就是拿建议层压主权层。
describe('learned taste — 尊重主人关掉它', () => {
  it('主人 enabled:false → 做梦写回不许偷偷打开', async () => {
    const tasteRoot = await freshRoot();
    await writeLearnedTaste({ tasteRoot }, { tags: ['a'], mute: [], summary: '' });
    const file = join(tasteRoot, 'manifest.json');
    const m = JSON.parse(await readFile(file, 'utf-8'));
    m.sources['learned/dreamed.md'].enabled = false; // 主人手动关掉
    await writeFile(file, JSON.stringify(m), 'utf-8');

    await writeLearnedTaste({ tasteRoot }, { tags: ['b'], mute: [], summary: '第二场梦' });

    const after = JSON.parse(await readFile(file, 'utf-8'));
    expect(after.sources['learned/dreamed.md'].enabled).toBe(false);
    // 文件本身照写不误 —— 关掉的是"用不用"，不是"记不记"。
    expect((await readLearnedTaste({ tasteRoot })).tags).toEqual(['b']);
  });

  it('主人自己写 core 则相反：他刚亲手添了一句，那就是要用它', async () => {
    const tasteRoot = await freshRoot();
    await appendCorePrivate({ tasteRoot }, '第一句');
    const file = join(tasteRoot, 'manifest.json');
    const m = JSON.parse(await readFile(file, 'utf-8'));
    m.sources['core/private.md'].enabled = false;
    await writeFile(file, JSON.stringify(m), 'utf-8');

    await appendCorePrivate({ tasteRoot }, '第二句');

    const after = JSON.parse(await readFile(file, 'utf-8'));
    expect(after.sources['core/private.md'].enabled).toBe(true);
  });
});
