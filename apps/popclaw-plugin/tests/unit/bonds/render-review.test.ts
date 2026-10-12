import { beforeAll, describe, expect, it } from 'vitest';
import { renderReview, type ReviewDynamic } from '../../../src/bonds/render-review.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import type { BondProposal } from '../../../src/bonds/proposals-store.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S13 slice: renderReview now renders in `ownerLang()` (default en-US) instead
// of hardcoded zh — pin zh-CN so the existing assertions below stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

function dyn(over: Partial<ReviewDynamic>): ReviewDynamic {
  return { id: 1, popclawId: 'A', tier: 'friend', remarkName: '', ts: 100, summary: 's', isMilestone: false, ...over };
}
function prop(over: Partial<BondProposal>): BondProposal {
  return { id: 1, popclawId: 'A', fromTier: 'friend', toTier: 'close', rationale: '最近 30 天互动 10 次', status: 'pending', createdAt: 0, decidedAt: null, ...over };
}

describe('renderReview', () => {
  it('empty → "今天没有新动态" and no proposals line', () => {
    const text = renderReview({ dynamics: [], proposals: [] });
    expect(text).toContain('今天没有新动态');
  });

  it('splits 近况 (tier>=friend, non-milestone) from 大事 (milestone any tier)', () => {
    const text = renderReview({
      dynamics: [
        dyn({ id: 1, popclawId: 'A', tier: 'close', remarkName: '阿青', summary: '发了新文章', isMilestone: false }),
        dyn({ id: 2, popclawId: 'B', tier: 'acquaintance', remarkName: '', summary: '融资千万', isMilestone: true }),
        dyn({ id: 3, popclawId: 'C', tier: 'acquaintance', remarkName: '', summary: '普通帖', isMilestone: false }),
      ],
      proposals: [],
    });
    expect(text).toContain('近况');
    expect(text).toContain('阿青');
    expect(text).toContain('发了新文章');
    expect(text).toContain('大事');
    expect(text).toContain('融资千万');
    // acquaintance non-milestone (id 3) is below the recent-activity floor → not shown
    expect(text).not.toContain('普通帖');
  });

  // Proposal rows leaked the raw popclaw_id prefix.
  // The global rule is name#sigil: raw prefixes are unreadable and hard to distinguish.
  it('提议行与动态行都走名字链，不漏裸 id 前缀', () => {
    const id = 'Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2';
    const text = renderReview({
      dynamics: [dyn({ id: 1, popclawId: id, tier: 'close', remarkName: '', summary: '发了新文章', isMilestone: false })],
      proposals: [prop({ id: 7, popclawId: id, fromTier: 'friend', toTier: 'close', rationale: '最近 30 天互动 10 次' })],
      nameOf: () => '苍梧居士',
    });
    expect(text).toContain(`苍梧居士#${deriveSigil(id)}`);
    expect(text).not.toContain(id.slice(0, 10));
  });

  it('numbers pending proposals with 1/2/3 instructions', () => {
    const text = renderReview({
      dynamics: [],
      proposals: [prop({ id: 7, popclawId: 'ELON', fromTier: 'friend', toTier: 'close', rationale: '最近 30 天互动 10 次' })],
    });
    expect(text).toContain('提议');
    expect(text).toMatch(/1[.、]/); // numbered "1."
    expect(text).toContain('好友');
    expect(text).toContain('密友');
    expect(text).toContain('最近 30 天互动 10 次');
    expect(text).toContain('/popclaw review 1 1'); // accept hint for proposal #1
  });

  // Follow doorbell §6.5, second fallback: the morning card's pending-follow section (redundant coverage). Store names as
  // name#sigil, matching the injected content so owner vocabulary and agent matching use the same identity.
  it('pendingFollows 非空 → 渲染「待关注」一节：编号、名字照存、节尾回复语法', () => {
    const text = renderReview({
      dynamics: [dyn({ id: 1, popclawId: 'A', tier: 'close', remarkName: '阿青', summary: '发了新文章' })],
      proposals: [],
      pendingFollows: [{ display_name: '云舟#3m8v' }, { display_name: 'levelsio#9xqe' }],
    });
    expect(text).toContain('待关注');
    expect(text).toContain('1. 云舟#3m8v');
    expect(text).toContain('2. levelsio#9xqe');
    expect(text).toContain('回数字或「都要」');
    expect(text).toContain('48 小时后我就不提了');
  });

  it('pendingFollows 为空数组或未传 → 不渲染「待关注」一节', () => {
    const without = renderReview({ dynamics: [], proposals: [] });
    const emptyList = renderReview({ dynamics: [], proposals: [], pendingFollows: [] });
    for (const text of [without, emptyList]) {
      expect(text).not.toContain('待关注');
      expect(text).toContain('今天没有新动态');
    }
  });
});
