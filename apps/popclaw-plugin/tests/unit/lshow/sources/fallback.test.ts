import { describe, it, expect } from 'vitest';
import { FALLBACK_LORE_HOUSE_URL } from '../../../../src/lshow/sources/fallback.js';

describe('FALLBACK_LORE_HOUSE_URL', () => {
  it('points at the public lore-house (zero-config default)', () => {
    expect(FALLBACK_LORE_HOUSE_URL).toBe('https://house.popclaw.me');
  });

  it('is a valid http URL', () => {
    expect(() => new URL(FALLBACK_LORE_HOUSE_URL)).not.toThrow();
  });
});
