/**
 * The shared issue-identity rules on their own. What each entrance does with
 * them (and where the picks path deliberately differs) is pinned through the
 * real entrances in issue-identity-baseline.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorKey,
  candidateNumberAt,
  cleanProvenanceId,
  isCandidateId,
  isPlaceholderId,
  mintIssueToken,
} from '../../../src/newspaper/issue-identity.js';

describe('issue-identity', () => {
  it('isCandidateId is a prefix classification only', () => {
    expect(isCandidateId('ctok_abc123')).toBe(true);
    expect(isCandidateId('cab12')).toBe(true); // no shape or length check here
    expect(isCandidateId('tok_abc123')).toBe(false);
    expect(isCandidateId('Ctok_abc123')).toBe(false); // case-sensitive, as before
    expect(isCandidateId('')).toBe(false);
  });

  it('cleanProvenanceId trims, strips one pair of flanking quotes, and maps non-strings to ""', () => {
    expect(cleanProvenanceId('  tok_abc  ')).toBe('tok_abc');
    expect(cleanProvenanceId('"tok_abc"')).toBe('tok_abc');
    expect(cleanProvenanceId("'tok_abc'")).toBe('tok_abc');
    expect(cleanProvenanceId('""tok_abc""')).toBe('"tok_abc"'); // one pair only
    expect(cleanProvenanceId(' "tok_abc" ')).toBe('tok_abc'); // trimmed first, then stripped
    expect(cleanProvenanceId('" tok_abc "')).toBe(' tok_abc '); // no second trim
    expect(cleanProvenanceId(undefined)).toBe('');
    expect(cleanProvenanceId(42)).toBe('');
  });

  it('isPlaceholderId flags empty, ellipsis, masks, xxx and redacted', () => {
    for (const v of ['', 'tok_...', 'c***', 'tok_<id>', 'cxxxxxxx', 'ctok_redacted', 'REDACTED']) {
      expect(isPlaceholderId(v), v).toBe(true);
    }
    for (const v of ['tok_abc123', 'ctok_abc123']) expect(isPlaceholderId(v), v).toBe(false);
  });

  it('authorKey prefers the popclaw id, falls back to name#sigil, and keys anonymous items by the caller\'s index', () => {
    expect(authorKey({ authorPopclawId: 'pid', author: 'A', sigil: 's' }, 3)).toBe('pid');
    expect(authorKey({ author: 'A', sigil: 's' }, 3)).toBe('A#s');
    expect(authorKey({}, 3)).toBe('anon:3');
    expect(authorKey({}, 4)).not.toBe(authorKey({}, 3)); // anonymous items never merge
  });

  it('candidateNumberAt is index + 1', () => {
    expect(candidateNumberAt(0)).toBe(1);
    expect(candidateNumberAt(41)).toBe(42);
  });

  describe('mintIssueToken', () => {
    afterEach(() => vi.restoreAllMocks());

    it('is tok_ + base-36 digits of exactly one Math.random() draw per call', () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
      expect(mintIssueToken()).toBe('tok_4fzzzxjylr');
      expect(random).toHaveBeenCalledTimes(1);
      expect(mintIssueToken()).toBe('tok_4fzzzxjylr');
      expect(random).toHaveBeenCalledTimes(2);
    });
  });
});
