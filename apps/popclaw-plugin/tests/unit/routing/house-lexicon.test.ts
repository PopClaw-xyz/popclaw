import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { loadHouseLexicon } from '../../../src/routing/house-lexicon.js';

/** One root per test: the process cache keys by absolute path, so tests must not see each other's data. */
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

  // Gate ①: tool name outside the visible set → drop the entire entry.
  it('drops an entry whose tool is not a registered tool', () => {
    const { paths } = newHouse(
      'evil',
      guideWith('lexicon:\n  - tool: rm_rf_slash\n    say: 删库\n  - tool: popclaw_world_guide\n    say: 明信片\n'),
    );
    expect(loadHouseLexicon(paths).map((e) => e.tool)).toEqual(['popclaw_world_guide']);
  });

  // Gate ① continued (ADR-0044 §8): visible = registered − OPTIONAL_TOOLS. Hidden tools are also dropped.
  it('drops an entry pointing at an optional (hidden) tool', () => {
    const { paths } = newHouse(
      'sneaky',
      guideWith('lexicon:\n  - tool: popclaw_mark\n    say: 收藏这条\n'),
    );
    expect(loadHouseLexicon(paths)).toEqual([]);
  });

  // Gate ②: phrases need 2–24 characters and no regex metacharacters. Drop bad phrases while retaining good ones.
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

  // Gate ③: at most 12 entries per house.
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

  // One failed house affects only itself (the second house-handshake.ts invariant).
  it('keeps the good house when another house has junk frontmatter', () => {
    const { paths } = newHouse('broken', '---\nlexicon:\n  - tool:\n    say:\n  -- 什么鬼\n');
    writeFileSync(
      paths.houseGuideFile('good'),
      guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: 明信片\n'),
      'utf8',
    );
    expect(loadHouseLexicon(paths).map((e) => e.from)).toEqual(['good']);
  });

  // Lazy disk reads + mtime invalidation (ADR-0043 §4).
  it('caches per file and reloads when mtime moves', () => {
    const { paths, file } = newHouse(
      'world',
      guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: 明信片\n'),
    );
    const was = new Date(2020, 0, 1); // Whole seconds avoid submillisecond precision loss in utimes.
    utimesSync(file, was, was);
    expect(loadHouseLexicon(paths)[0]?.say).toEqual(['明信片']);

    // Changed content with unchanged mtime still uses cache, proving disk is not read on every call.
    writeFileSync(file, guideWith('lexicon:\n  - tool: popclaw_world_guide\n    say: 合影\n'), 'utf8');
    utimesSync(file, was, was);
    expect(loadHouseLexicon(paths)[0]?.say).toEqual(['明信片']);

    utimesSync(file, was, new Date(2030, 0, 1));
    expect(loadHouseLexicon(paths)[0]?.say).toEqual(['合影']);
  });
});
