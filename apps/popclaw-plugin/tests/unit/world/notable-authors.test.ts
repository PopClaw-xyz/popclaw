/**
 * T3: aggregateNotableAuthors 单元测试
 *
 * 核心展示逻辑：多平台缝合身份浮到最上。
 */
import { describe, it, expect } from 'vitest';
import { aggregateNotableAuthors } from '../../../src/world/notable-authors.js';
import type { AuthorSource } from '../../../src/world/notable-authors.js';
import { deriveSigil } from '../../../src/invite/sigil.js';

// ---------------------------------------------------------------------------
// Helper builders
// ---------------------------------------------------------------------------
function src(
  popclawId: string,
  platform: string,
  nickname?: string,
  postCount = 1,
): AuthorSource {
  return { popclawId, platform, nickname, postCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('aggregateNotableAuthors', () => {
  it('returns [] for empty input', () => {
    expect(aggregateNotableAuthors([])).toEqual([]);
  });

  it('mrbeast 4-platform author ranks first', () => {
    const inputs: AuthorSource[] = [
      src('mr', 'x', 'mrbeast', 5),
      src('mr', 'youtube', 'mrbeast', 10),
      src('mr', 'instagram', 'mrbeast', 3),
      src('mr', 'tiktok', 'mrbeast', 7),
      // another author with many posts but only 1 platform
      src('alix', 'instagram', 'alixearle', 30),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result[0]!.popclawId).toBe('mr');
    expect(result[0]!.platforms).toHaveLength(4);
    expect(result[0]!.platforms).toEqual(['instagram', 'tiktok', 'x', 'youtube']); // sorted
  });

  it('same breadth → ranked by postCount descending', () => {
    const inputs: AuthorSource[] = [
      src('low', 'x', 'low', 2),
      src('low', 'instagram', 'low', 1),
      src('high', 'x', 'high', 10),
      src('high', 'tiktok', 'high', 8),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result[0]!.popclawId).toBe('high');
    expect(result[0]!.postCount).toBe(18);
    expect(result[1]!.popclawId).toBe('low');
    expect(result[1]!.postCount).toBe(3);
  });

  it('same breadth and same postCount → ranked by nickname alphabetically', () => {
    const inputs: AuthorSource[] = [
      src('zzz', 'x', 'zzz', 5),
      src('zzz', 'youtube', 'zzz', 0),
      src('aaa', 'x', 'aaa', 3),
      src('aaa', 'instagram', 'aaa', 2),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result[0]!.nickname).toBe('aaa');
    expect(result[1]!.nickname).toBe('zzz');
  });

  it('cap truncates result list', () => {
    const inputs: AuthorSource[] = [
      src('a', 'x', 'alice', 1),
      src('b', 'x', 'bob', 2),
      src('c', 'x', 'carol', 3),
      src('d', 'x', 'dave', 4),
      src('e', 'x', 'eve', 5),
    ];
    const result = aggregateNotableAuthors(inputs, 3);
    expect(result).toHaveLength(3);
  });

  it('no cap → returns all authors', () => {
    const inputs: AuthorSource[] = [
      src('a', 'x', 'alice', 1),
      src('b', 'x', 'bob', 2),
      src('c', 'x', 'carol', 3),
    ];
    expect(aggregateNotableAuthors(inputs)).toHaveLength(3);
    expect(aggregateNotableAuthors(inputs, undefined)).toHaveLength(3);
  });

  // 这个 nickname 会原样排进主人看的世界速览 → 名号查无时报**印信**，
  // 不是 id 前缀（ADR-0032）。
  it('missing nickname falls back to the sigil', () => {
    const inputs: AuthorSource[] = [
      src('ABCDEFGHIJKLMNOP', 'x', undefined, 5),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result[0]!.nickname).toBe(`#${deriveSigil('ABCDEFGHIJKLMNOP')}`);
    expect(result[0]!.nickname).not.toContain('ABCDEFGH');
  });

  it('empty string nickname also falls back to the sigil', () => {
    const inputs: AuthorSource[] = [
      src('XYZXYZXY', 'instagram', '', 3),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result[0]!.nickname).toBe(`#${deriveSigil('XYZXYZXY')}`);
  });

  it('deduplicates platforms for the same author', () => {
    const inputs: AuthorSource[] = [
      src('dup', 'x', 'duper', 3),
      src('dup', 'x', 'duper', 2), // same platform again
      src('dup', 'instagram', 'duper', 1),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result).toHaveLength(1);
    expect(result[0]!.platforms).toEqual(['instagram', 'x']); // deduped + sorted
    expect(result[0]!.postCount).toBe(6);
  });

  it('accumulates postCount across multiple entries for same author', () => {
    const inputs: AuthorSource[] = [
      src('multi', 'x', 'multi', 5),
      src('multi', 'youtube', 'multi', 10),
      src('multi', 'instagram', 'multi', 3),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result[0]!.postCount).toBe(18);
  });

  it('uses nickname from first non-empty entry when entries have different values', () => {
    // First entry has no nickname, second has one — should use the one it finds
    const inputs: AuthorSource[] = [
      src('nx', 'x', undefined, 2),
      src('nx', 'instagram', 'nickX', 1),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result[0]!.nickname).toBe('nickX');
  });

  it('platforms are sorted alphabetically in output', () => {
    const inputs: AuthorSource[] = [
      src('pl', 'youtube', 'pl', 1),
      src('pl', 'x', 'pl', 1),
      src('pl', 'tiktok', 'pl', 1),
      src('pl', 'instagram', 'pl', 1),
    ];
    const result = aggregateNotableAuthors(inputs);
    expect(result[0]!.platforms).toEqual(['instagram', 'tiktok', 'x', 'youtube']);
  });

  it('full mrbeast/alixearle scenario — mrbeast 4-platform first, alixearle 3-platform second', () => {
    const inputs: AuthorSource[] = [
      // alixearle: 3 platforms (no X)
      src('alix', 'instagram', 'alixearle', 8),
      src('alix', 'tiktok', 'alixearle', 5),
      src('alix', 'youtube', 'alixearle', 2),
      // mrbeast: 4 platforms
      src('mr', 'x', 'mrbeast', 3),
      src('mr', 'youtube', 'MrBeast', 12),
      src('mr', 'tiktok', 'mrbeast', 6),
      src('mr', 'instagram', 'mrbeast', 4),
      // singleauthor: 1 platform, many posts
      src('single', 'x', 'prolific', 100),
    ];
    const result = aggregateNotableAuthors(inputs, 5);
    expect(result[0]!.popclawId).toBe('mr');
    expect(result[0]!.platforms).toHaveLength(4);
    expect(result[1]!.popclawId).toBe('alix');
    expect(result[1]!.platforms).toHaveLength(3);
    expect(result[2]!.popclawId).toBe('single');
    expect(result).toHaveLength(3);
  });
});
