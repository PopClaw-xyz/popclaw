import { describe, it, expect } from 'vitest';
import { personVerdict } from '../../../src/butler/person-verdict.js';
import { passesRelativeValueGate } from '../../../src/notifier/relative-value.js';

const graphOf = (...ids: string[]) => ({ following: () => ids.map((popclawId) => ({ popclawId })) });

describe('personVerdict — 事实卡', () => {
  it('blocked / reject 都算拉黑（rank < stranger）', () => {
    for (const tier of ['blocked', 'reject'] as const) {
      const v = personVerdict('X', { bondOf: () => ({ tier }) });
      expect(v.blocked).toBe(true);
      expect(v.why).toContain('blocked');
    }
  });

  it('stranger 及以上都不算拉黑', () => {
    for (const tier of ['stranger', 'acquaintance', 'friend', 'close', 'close_plus'] as const) {
      expect(personVerdict('X', { bondOf: () => ({ tier }) }).blocked).toBe(false);
    }
  });

  // A book entry marked stranger differs from no entry at all: the owner has seen the former.
  it('未入簿 → tier 缺席，不拿 stranger 顶替', () => {
    const v = personVerdict('X', { bondOf: () => null });
    expect(v.tier).toBeUndefined();
    expect(v.why).toContain('notInBondBook');
  });

  it('查库抛异常只让那一格缺席，绝不外抛', () => {
    const v = personVerdict('X', {
      bondOf: () => { throw new Error('sqlite 打嗝'); },
      isFollowed: () => { throw new Error('boom'); },
    });
    expect(v.blocked).toBe(false); // Be conservative when evidence is absent.
    expect(v.followed).toBe(false);
  });

  it('判据是码不是散文（渲染归各表面的 lexicon）', () => {
    const v = personVerdict('X', { bondOf: () => ({ tier: 'friend' }), isFollowed: () => true });
    expect(v.why).toEqual(['inBondBook', 'followed']);
  });
});

describe('拉黑一票否决（真机 bug：关注过又拉黑的人照样推到手机）', () => {
  const blocked = personVerdict('X', { bondOf: () => ({ tier: 'blocked' }) });

  it('关注过也挡住 —— bond block 只改 tier 不动 follow 表', () => {
    expect(passesRelativeValueGate('dm', 'X', graphOf('X'))).toBe(true);          // Before the fix.
    expect(passesRelativeValueGate('dm', 'X', graphOf('X'), undefined, blocked)).toBe(false);
  });

  it('压过 followed_you 这类显式豁免（拉黑的人来关注不该响铃）', () => {
    expect(passesRelativeValueGate('followed_you', 'X', graphOf())).toBe(true);   // Before the fix.
    expect(passesRelativeValueGate('followed_you', 'X', graphOf(), undefined, blocked)).toBe(false);
  });

  it('压过挂坊官方豁免', () => {
    expect(passesRelativeValueGate('dm', 'X', graphOf(), () => true, blocked)).toBe(false);
  });

  it('不传事实卡 = 行为与从前一字不差', () => {
    expect(passesRelativeValueGate('dm', 'X', graphOf('X'))).toBe(true);
    expect(passesRelativeValueGate('dm', 'Y', graphOf('X'))).toBe(false);
  });
});
