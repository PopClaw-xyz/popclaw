import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCorePrivate } from '../../../src/taste/taste-writer';
import { TasteLoader } from '../../../src/taste/taste-loader';

/** Create a temp dataRoot and return both dataRoot and tasteRoot paths. */
function makeTempDataRoot(): { dataRoot: string; tasteRoot: string } {
  const dataRoot = mkdtempSync(join(tmpdir(), 'taste-writer-'));
  const tasteRoot = join(dataRoot, 'taste');
  return { dataRoot, tasteRoot };
}

describe('appendCorePrivate', () => {
  it('creates core/private.md when it does not exist', async () => {
    const { tasteRoot } = makeTempDataRoot();
    await appendCorePrivate({ tasteRoot }, '喜欢猫猫和代码');
    const content = await readFile(join(tasteRoot, 'core/private.md'), 'utf-8');
    expect(content).toContain('喜欢猫猫和代码');
  });

  it('appends to existing content with blank-line separator (does not overwrite)', async () => {
    const { tasteRoot } = makeTempDataRoot();
    mkdirSync(join(tasteRoot, 'core'), { recursive: true });
    writeFileSync(join(tasteRoot, 'core/private.md'), '# 旧内容\n- 原有兴趣\n');

    await appendCorePrivate({ tasteRoot }, '# 新内容\n- 新的兴趣');

    const content = await readFile(join(tasteRoot, 'core/private.md'), 'utf-8');
    expect(content).toContain('旧内容');
    expect(content).toContain('新内容');
    // blank line separator between existing and appended content
    expect(content).toMatch(/原有兴趣\n\n.*新的兴趣/s);
  });

  it('is a no-op for blank / whitespace-only input', async () => {
    const { tasteRoot } = makeTempDataRoot();
    await appendCorePrivate({ tasteRoot }, '   \n  ');
    // file should not have been created
    await expect(readFile(join(tasteRoot, 'core/private.md'), 'utf-8')).rejects.toThrow();
  });

  it('creates manifest.json when it does not exist', async () => {
    const { tasteRoot } = makeTempDataRoot();
    await appendCorePrivate({ tasteRoot }, '测试');
    const raw = await readFile(join(tasteRoot, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(raw) as { sources: Record<string, { weight: number; enabled: boolean }> };
    expect(manifest.sources['core/private.md']).toMatchObject({ enabled: true });
  });

  it('only updates the target entry in an existing manifest, leaving other sources intact', async () => {
    const { tasteRoot } = makeTempDataRoot();
    mkdirSync(tasteRoot, { recursive: true });
    const existingManifest = {
      schemaVersion: 1,
      sources: {
        'core/public.md': { weight: 1.0, enabled: true },
        'core/private.md': { weight: 0.5, enabled: false },
      },
    };
    writeFileSync(join(tasteRoot, 'manifest.json'), JSON.stringify(existingManifest, null, 2));

    await appendCorePrivate({ tasteRoot }, '兴趣追加');

    const raw = await readFile(join(tasteRoot, 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(raw) as typeof existingManifest;
    // Target entry is now enabled
    expect(manifest.sources['core/private.md']).toMatchObject({ enabled: true });
    // Other entry is preserved unchanged
    expect(manifest.sources['core/public.md']).toMatchObject({ weight: 1.0, enabled: true });
  });

  it('after writing, TasteLoader can read the content back (closed loop)', async () => {
    const { tasteRoot } = makeTempDataRoot();
    await appendCorePrivate({ tasteRoot }, '# 测试兴趣\n- 分布式系统\n- 密码学');

    const loader = new TasteLoader({ tasteDir: tasteRoot });
    const sources = await loader.enabledSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.path).toBe('core/private.md');
    expect(sources[0]!.content).toContain('分布式系统');
    // loader.enabledSources() only returns enabled entries by definition
  });
});

// ---------------------------------------------------------------------------
// P-002 形态（spec 附录 A.3）：frontmatter 给机器、正文给人
// ---------------------------------------------------------------------------

describe('appendCorePrivate — P-002 frontmatter 形态', () => {
  it('新建文件带上 frontmatter 骨架（tags/mute 空数组，内容留给做梦填）', async () => {
    const { tasteRoot } = makeTempDataRoot();
    await appendCorePrivate({ tasteRoot }, '我关心航天工程的实现细节');

    const md = await readFile(join(tasteRoot, 'core/private.md'), 'utf-8');
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toMatch(/^---\ntags: \[\]\nmute: \[\]\n---\n/);
    // 正文照实存主人原话，不自作聪明抽标签
    expect(md).toContain('我关心航天工程的实现细节');
  });

  it('已有的无 frontmatter 旧文件：补上骨架，正文一个字不丢', async () => {
    const { tasteRoot } = makeTempDataRoot();
    mkdirSync(join(tasteRoot, 'core'), { recursive: true });
    writeFileSync(join(tasteRoot, 'core/private.md'), '主人早先写的老正文\n');

    await appendCorePrivate({ tasteRoot }, '新的一句自述');

    const md = await readFile(join(tasteRoot, 'core/private.md'), 'utf-8');
    expect(md.startsWith('---\n')).toBe(true);
    expect(md).toContain('主人早先写的老正文');
    expect(md).toMatch(/老正文\n\n新的一句自述/);
  });

  it('已有 frontmatter：原样保留（合并而非替换），只往正文尾巴追加', async () => {
    const { tasteRoot } = makeTempDataRoot();
    mkdirSync(join(tasteRoot, 'core'), { recursive: true });
    writeFileSync(
      join(tasteRoot, 'core/private.md'),
      '---\ntags: [航天, 开源治理]\nmute: [币圈喊单]\n---\n\n主人的老自述\n',
    );

    await appendCorePrivate({ tasteRoot }, '再补一句');

    const md = await readFile(join(tasteRoot, 'core/private.md'), 'utf-8');
    // frontmatter 不被 tags: [] 冲掉
    expect(md).toContain('tags: [航天, 开源治理]');
    expect(md).toContain('mute: [币圈喊单]');
    expect(md).not.toContain('tags: []');
    // 只有一份 frontmatter，没有重复围栏
    expect(md.match(/^---$/gm)).toHaveLength(2);
    expect(md).toMatch(/主人的老自述\n\n再补一句/);
  });

  it('TasteLoader 读带 frontmatter 的文件不崩，content 给出正文（不含围栏）', async () => {
    const { tasteRoot } = makeTempDataRoot();
    await appendCorePrivate({ tasteRoot }, '我关心分布式系统');

    const loader = new TasteLoader({ tasteDir: tasteRoot });
    const sources = await loader.enabledSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.content).toContain('我关心分布式系统');
    expect(sources[0]!.content).not.toContain('---');
    expect(sources[0]!.content).not.toContain('mute:');
  });
});
