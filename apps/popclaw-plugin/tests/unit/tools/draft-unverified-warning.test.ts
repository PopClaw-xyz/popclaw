import { describe, it, expect, beforeAll } from 'vitest';
import { unverifiedWarning } from '../../../src/tools/write-tools.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

beforeAll(() => setOwnerLang('zh-CN', 'config'));

// #468: three different ways a draft preview can end up showing `—#sigil`.
// Only two of them used to say anything; the third looked exactly like a
// lore-house-confirmed recipient.
describe('unverifiedWarning', () => {
  it('says nothing when the house confirmed a named recipient', () => {
    expect(unverifiedWarning({ nickname: '青山小待诏' })).toBe('');
  });

  it('warns when the house is offline', () => {
    expect(unverifiedWarning({ unverified: 'offline', nickname: '青山小待诏' })).toContain('⚠️');
  });

  it('warns when the house has never heard of the id', () => {
    expect(unverifiedWarning({ unverified: 'unknown', nickname: '' })).toContain('⚠️');
  });

  it('warns when nothing local can name them and the house was never asked (#468)', () => {
    const text = unverifiedWarning({ nickname: '' });
    expect(text).toContain('⚠️');
    expect(text).toContain('没有名号');
  });

  it('an unverified verdict outranks the unnamed line — do not print both', () => {
    const unknown = unverifiedWarning({ unverified: 'unknown', nickname: '' });
    expect(unknown).not.toContain('没有名号');
  });
});
