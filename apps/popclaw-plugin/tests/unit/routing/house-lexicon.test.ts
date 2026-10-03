import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { loadHouseLexicon } from '../../../src/routing/house-lexicon.js';

/** 每个用例一个 root：进程内缓存以绝对路径为 key，用例之间不许互相看见。 */
function newHouse(slug: string, guide: string): { paths: PopclawPaths; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'popclaw-house-lexicon-'));
  const paths = new PopclawPaths(root);
  mkdirSync(paths.lorehousesDir(), { recursive: true });
  const file = paths.houseGuideFile(slug);
  writeFileSync(file, guide, 'utf8');
  return { paths, file };
}

function guideWith(lexicon: string): string {
  return `---\nworld: 世界\nvoice: 我是一座坊\n${lexicon}---\n\n正文散文照旧。\n`;
}

describe('loadHouseLexicon (ADR-0043 §4)', () => {
  it('reads a house entry off the cached guide, tagged with its slug', () => {
    const { paths } = newHouse(
      'world-popclaw-me',
      guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: 明信片, 寄明信片, 合影, 它在干嘛\n'),
    );
    expect(loadHouseLexicon(paths)).toEqual([
      {
        tool: 'popclaw_world_guide',
        say: ['明信片', '寄明信片', '合影', '它在干嘛'],
        from: 'world-popclaw-me',
      },
    ]);
  });

  it('keeps parsing the rest of the frontmatter (streams/voice untouched)', () => {
    const { paths } = newHouse(
      'world',
      `---\nworld: 世界\nlexicon:\n  - tool: popclaw_world_guide\n    say: 明信片\nstreams:\n  - name: world\n    endpoint: /v1/stream\nfeedback:\n  popclaw_id: abc\n---\n正文\n`,
    );
    expect(loadHouseLexicon(paths)[0]?.tool).toBe('popclaw_world_guide');
  });

  // 闸①：工具名 ∉ 可见集 → 整条丢弃。
  it('drops an entry whose tool is not a registered tool', () => {
    const { paths } = newHouse(
      'evil',
      guideWith('lexicon:\n  - tool: rm_rf_slash\n    say: 删库\n  - tool: popclaw_world_guide\n    say: 明信片\n'),
    );
    expect(loadHouseLexicon(paths).map((e) => e.tool)).toEqual(['popclaw_world_guide']);
  });

  // 闸①续（ADR-0044 §8）：可见集 = 已注册 − OPTIONAL_TOOLS。隐身工具照样丢。
  it('drops an entry pointing at an optional (hidden) tool', () => {
    const { paths } = newHouse(
      'sneaky',
      guideWith('lexicon:\n  - tool: popclaw_mark\n    say: 收藏这条\n'),
    );
    expect(loadHouseLexicon(paths)).toEqual([]);
  });

  // 闸②：短语 2-24 字、禁正则元字符。坏短语丢自己，好短语留下。
  it('rejects regex metacharacters and 1-char phrases, keeps the good ones', () => {
    const { paths } = newHouse(
      'world',
      guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: .*, 卡, 明信片, (合影)\n'),
    );
    expect(loadHouseLexicon(paths)[0]?.say).toEqual(['明信片']);
  });

  it('drops an entry whose phrases are all rejected', () => {
    const { paths } = newHouse('world', guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: a\n'));
    expect(loadHouseLexicon(paths)).toEqual([]);
  });

  it('rejects a phrase longer than 24 chars', () => {
    const long = '寄'.repeat(25);
    const { paths } = newHouse(
      'world',
      guideWith(`lexicon:\n  - tool: popclaw_world_guide\n    say: ${long}, 明信片\n`),
    );
    expect(loadHouseLexicon(paths)[0]?.say).toEqual(['明信片']);
  });

  // 闸③：每坊 ≤12 条。
  it('truncates a house at 12 entries', () => {
    const items = Array.from(
      { length: 20 },
      (_, i) => `  - tool: popclaw_world_guide\n    say: 明信片${i}\n`,
    ).join('');
    const { paths } = newHouse('greedy', guideWith(`lexicon:\n${items}`));
    expect(loadHouseLexicon(paths)).toHaveLength(12);
  });

  it('returns nothing for a guide with no lexicon block, and for a missing dir', () => {
    const { paths } = newHouse('quiet', '---\nworld: 世界\n---\n正文\n');
    expect(loadHouseLexicon(paths)).toEqual([]);
    expect(loadHouseLexicon(new PopclawPaths(join(tmpdir(), 'popclaw-nope-does-not-exist')))).toEqual([]);
  });

  // 一坊挂了只丢它自己（house-handshake.ts 的第二条纪律）。
  it('keeps the good house when another house has junk frontmatter', () => {
    const { paths } = newHouse('broken', '---\nlexicon:\n  - tool:\n    say:\n  -- 什么鬼\n');
    writeFileSync(
      paths.houseGuideFile('good'),
      guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: 明信片\n'),
      'utf8',
    );
    expect(loadHouseLexicon(paths).map((e) => e.from)).toEqual(['good']);
  });

  // lazy 读盘 + mtime 失效（ADR-0043 §4）。
  it('caches per file and reloads when mtime moves', () => {
    const { paths, file } = newHouse(
      'world',
      guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: 明信片\n'),
    );
    const was = new Date(2020, 0, 1); // 整秒：绕开 utimes 的亚毫秒精度损失
    utimesSync(file, was, was);
    expect(loadHouseLexicon(paths)[0]?.say).toEqual(['明信片']);

    // 内容变了但 mtime 没动 → 照旧吃缓存（证明真的没每轮读盘）。
    writeFileSync(file, guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: 合影\n'), 'utf8');
    utimesSync(file, was, was);
    expect(loadHouseLexicon(paths)[0]?.say).toEqual(['明信片']);

    utimesSync(file, was, new Date(2030, 0, 1));
    expect(loadHouseLexicon(paths)[0]?.say).toEqual(['合影']);
  });
});
