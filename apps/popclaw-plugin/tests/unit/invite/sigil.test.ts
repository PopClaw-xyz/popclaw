import { describe, expect, it } from 'vitest';
import { SIGIL_LEN } from '@popclaw/algorithms';
import { deriveSigil, parseSigilInput } from '../../../src/invite/sigil.js';

describe('deriveSigil', () => {
  it('matches canonical ADR-0015 test vector "BlackFeather" -> "gdx8rgtp"', () => {
    // Known fixture from packages/contracts/fixtures/test-vectors.json + the
    // Rust sigil test. Keeps plugin and lore-house on byte-identical sigil math.
    expect(deriveSigil('BlackFeather')).toBe('gdx8rgtp');
  });

  it(`returns SIGIL_LEN (${SIGIL_LEN}) lowercase Crockford base32 chars`, () => {
    const s = deriveSigil('Qm1111111111111111111111111111111111');
    expect(s).toHaveLength(SIGIL_LEN);
    expect(parseSigilInput(s)).toBe(s); // round-trips through the resolve-input alphabet
  });

  it('is stable for repeated calls with the same input', () => {
    const id = 'QmSomePopclawId';
    expect(deriveSigil(id)).toBe(deriveSigil(id));
  });

  it('differs for different popclaw_ids', () => {
    expect(deriveSigil('QmAlice')).not.toBe(deriveSigil('QmBob'));
  });
});

describe('parseSigilInput', () => {
  it('accepts a well-formed 6-12 char input unchanged', () => {
    expect(parseSigilInput('gdx8rgtp')).toBe('gdx8rgtp');
    expect(parseSigilInput('abc123')).toBe('abc123');
    expect(parseSigilInput('0123456789ab')).toBe('0123456789ab'); // 12 chars, upper bound
  });

  it('trims, lowercases, and folds o/i/l', () => {
    expect(parseSigilInput('  GDX8RGTP  ')).toBe('gdx8rgtp');
    expect(parseSigilInput('O0Il11')).toBe('001111');
  });

  it('rejects out-of-alphabet chars (incl. u)', () => {
    expect(parseSigilInput('abcdeu')).toBeNull();
  });

  it('rejects input shorter than 6 chars', () => {
    expect(parseSigilInput('abcde')).toBeNull();
  });

  it('rejects input longer than 12 chars', () => {
    expect(parseSigilInput('0123456789abc')).toBeNull();
  });
});
