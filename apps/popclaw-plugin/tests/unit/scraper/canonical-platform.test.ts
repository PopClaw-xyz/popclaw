import { describe, it, expect } from 'vitest';
import { canonicalPlatform } from '../../../src/scraper/platform-scraper';

describe('canonicalPlatform', () => {
  it('maps legacy "twitter" → "x"', () => {
    expect(canonicalPlatform('twitter')).toBe('x');
  });

  it('passes canonical "x" through unchanged', () => {
    expect(canonicalPlatform('x')).toBe('x');
  });

  it('passes "instagram" and "tiktok" through unchanged', () => {
    expect(canonicalPlatform('instagram')).toBe('instagram');
    expect(canonicalPlatform('tiktok')).toBe('tiktok');
  });

  it('passes unknown platforms through unchanged (let caller decide)', () => {
    expect(canonicalPlatform('facebook')).toBe('facebook');
    expect(canonicalPlatform('')).toBe('');
  });
});

describe('canonicalPlatform case-insensitivity (real-machine ABSTAIN, 2026-07-26)', () => {
  it('normalizes uppercase and mixed-case input', () => {
    expect(canonicalPlatform('X')).toBe('x');
    expect(canonicalPlatform('Twitter')).toBe('x');
    expect(canonicalPlatform('TWITTER')).toBe('x');
    expect(canonicalPlatform('Instagram')).toBe('instagram');
  });
});
