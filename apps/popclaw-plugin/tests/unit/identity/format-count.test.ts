import { describe, it, expect } from 'vitest';
import { formatFollowerCount } from '../../../src/identity/format-count.js';

describe('formatFollowerCount', () => {
  it('returns empty string for 0 / negative (unknown)', () => {
    expect(formatFollowerCount(0)).toBe('');
    expect(formatFollowerCount(-5)).toBe('');
  });
  it('shows raw number under 1000', () => {
    expect(formatFollowerCount(1)).toBe('1');
    expect(formatFollowerCount(850)).toBe('850');
    expect(formatFollowerCount(999)).toBe('999');
  });
  it('formats thousands with k', () => {
    expect(formatFollowerCount(1000)).toBe('1k');
    expect(formatFollowerCount(8500)).toBe('8.5k');
    expect(formatFollowerCount(67000)).toBe('67k');
    expect(formatFollowerCount(890000)).toBe('890k');
  });
  it('formats millions with m', () => {
    expect(formatFollowerCount(1_300_000)).toBe('1.3m');
    expect(formatFollowerCount(12_000_000)).toBe('12m');
    expect(formatFollowerCount(221_000_000)).toBe('221m');
  });
  it('formats billions with b', () => {
    expect(formatFollowerCount(1_300_000_000)).toBe('1.3b');
  });
  it('carries the 999_999 boundary up to 1m', () => {
    expect(formatFollowerCount(999_999)).toBe('1m');
  });
  it('returns empty string for non-finite input (NaN / Infinity)', () => {
    expect(formatFollowerCount(NaN)).toBe('');
    expect(formatFollowerCount(Infinity)).toBe('');
    expect(formatFollowerCount(-Infinity)).toBe('');
  });
});
