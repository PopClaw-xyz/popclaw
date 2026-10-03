import { describe, it, expect } from 'vitest';
import { fallbackName } from '../../../src/onboarding/fallback-name.js';
import { isPlaceholderNickname } from '../../../src/onboarding/identity-writer.js';

describe('fallbackName', () => {
  const id = '7kunxRn4HDktB2wyNYjrQUD3ZiVEtygp63U8ytaA5dbB';

  it('is deterministic for the same popclaw_id', () => {
    expect(fallbackName(id)).toBe(fallbackName(id));
  });

  it('never produces a ranger-xxxxxx placeholder', () => {
    expect(isPlaceholderNickname(fallbackName(id))).toBe(false);
  });

  it('is non-empty and within nickname length bounds', () => {
    const n = fallbackName(id);
    expect(n.length).toBeGreaterThan(0);
    expect(n.length).toBeLessThanOrEqual(12);
  });

  it('different ids generally differ', () => {
    expect(fallbackName('aaaaaa')).not.toBe(fallbackName('zzzzzz'));
  });
});
