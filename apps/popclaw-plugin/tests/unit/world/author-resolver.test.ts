/**
 * S4.1-T2: resolveAuthor maps names/handles to popclaw_id candidates.
 *
 * Priority is exact, then prefix, then substring (case-insensitive and whitespace-normalized). Ties
 * use platform breadth, reusing aggregateNotableAuthors ordering rather than introducing separate
 * aggregation logic.
 */
import { describe, it, expect } from 'vitest';
import { resolveAuthor } from '../../../src/world/author-resolver.js';
import type { AuthorSource } from '../../../src/world/notable-authors.js';

function src(popclawId: string, platform: string, nickname?: string): AuthorSource {
  return { popclawId, platform, nickname };
}

const ELON = 'ElonPopclawId1111111111111111111';

/**
 * Standard source set: one person on multiple platforms plus distractors.
 */
const SOURCES: AuthorSource[] = [
  src(ELON, 'x', 'Elon Musk'),
  src(ELON, 'youtube', 'Elon Musk'),
  src('alix', 'instagram', 'alixearle'),
  src('mr', 'youtube', 'mrbeast'),
];

describe('resolveAuthor 归一化（大小写 + 空白不敏感）', () => {
  it("'Elon Musk' / 'elonmusk' / 'ELON' 命中同一人", () => {
    for (const q of ['Elon Musk', 'elonmusk', 'ELON']) {
      const hits = resolveAuthor(q, SOURCES);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.popclawId).toBe(ELON);
    }
  });

  it('同一 popclaw_id 跨平台聚合为单个候选（platforms 合并）', () => {
    const hits = resolveAuthor('elonmusk', SOURCES);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.platforms).toEqual(['x', 'youtube']);
    expect(hits[0]!.nickname).toBe('Elon Musk');
  });

  it('CJK 昵称匹配（精确 + 子串）', () => {
    const cjk = [src('bl', 'popclaw', '白鹭'), ...SOURCES];
    expect(resolveAuthor('白鹭', cjk)[0]!.popclawId).toBe('bl');
    expect(resolveAuthor('鹭', cjk)[0]!.popclawId).toBe('bl');
  });
});

describe('resolveAuthor 优先级：精确 > 前缀 > 子串', () => {
  // musk: exact match on single-platform musk, prefix match on three-platform muskrat, substring match on four-platform Elon Musk.
  const TIERED: AuthorSource[] = [
    src(ELON, 'x', 'Elon Musk'),
    src(ELON, 'youtube', 'Elon Musk'),
    src(ELON, 'instagram', 'Elon Musk'),
    src(ELON, 'tiktok', 'Elon Musk'),
    src('rat', 'x', 'muskrat'),
    src('rat', 'youtube', 'muskrat'),
    src('rat', 'instagram', 'muskrat'),
    src('solo', 'x', 'musk'),
  ];

  it('精确命中排最前，哪怕平台广度低于前缀/子串命中', () => {
    const hits = resolveAuthor('musk', TIERED);
    expect(hits.map((h) => h.popclawId)).toEqual(['solo', 'rat', ELON]);
  });

  it('前缀命中排在子串命中之前', () => {
    const hits = resolveAuthor('mus', TIERED);
    // No exact match: muskrat (three platforms) and musk (one) are prefixes ordered by platform breadth; Elon Musk is a substring match.
    expect(hits.map((h) => h.popclawId)).toEqual(['rat', 'solo', ELON]);
  });
});

describe('resolveAuthor 同级保序（平台广度 desc）', () => {
  it('子串多命中按 aggregateNotableAuthors 的序返回', () => {
    const multi: AuthorSource[] = [
      src('b1', 'x', 'beta cat'),
      src('a1', 'x', 'alpha cat'),
      src('a1', 'youtube', 'alpha cat'),
    ];
    const hits = resolveAuthor('cat', multi);
    expect(hits.map((h) => h.popclawId)).toEqual(['a1', 'b1']);
  });
});

describe('resolveAuthor 边界', () => {
  it('空 query → []', () => {
    expect(resolveAuthor('', SOURCES)).toEqual([]);
  });

  it('纯空白 query → []', () => {
    expect(resolveAuthor('   ', SOURCES)).toEqual([]);
  });

  it('零命中 → []', () => {
    expect(resolveAuthor('nonexistent', SOURCES)).toEqual([]);
  });

  it('空 sources → []', () => {
    expect(resolveAuthor('elon', [])).toEqual([]);
  });
});
