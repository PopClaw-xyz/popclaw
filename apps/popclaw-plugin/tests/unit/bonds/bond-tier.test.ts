import { describe, expect, it } from 'vitest';
import { BOND_TIERS, tierRank, isAtLeast } from '../../../src/bonds/bond-tier.js';

describe('bond-tier', () => {
  it('orders tiers reject < blocked < stranger < acquaintance < friend < close < close_plus', () => {
    const ranks = BOND_TIERS.map((t) => tierRank(t));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(tierRank('reject')).toBeLessThan(tierRank('close'));
  });

  it('isAtLeast compares by rank', () => {
    expect(isAtLeast('friend', 'acquaintance')).toBe(true);
    expect(isAtLeast('acquaintance', 'friend')).toBe(false);
    expect(isAtLeast('close', 'close')).toBe(true);
  });
});
