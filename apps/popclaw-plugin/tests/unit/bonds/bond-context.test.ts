import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeBondContext, BOND_CONTEXT_PREFIX, bondContextPrefix } from '../../../src/bonds/bond-context.js';
import type { BondTier } from '../../../src/bonds/bond-tier.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderL1 } from '../../../src/notifier/owner-notifier.js';
import { deriveSigil } from '../../../src/invite/sigil.js';

const NOW = 1_800_000_000; // Freeze "now"; all relative times derive from this instant.
const DAY = 86_400;

// bond-context.ts now uses tierLabel()/renderCopy(), with lang defaulting to ownerLang().
// The pre-migration production copy was Chinese; pin zh-CN so these assertions remain unchanged (zero regression).
beforeAll(() => setOwnerLang('zh-CN', 'config'));
afterAll(() => setOwnerLang(undefined));

function ctx(
  bond: { tier: BondTier; description?: string; lastInteractionTs?: number | null } | null,
  lastIncomingTs: number | null = null,
) {
  return makeBondContext({
    bond: () =>
      bond
        ? {
            tier: bond.tier,
            description: bond.description ?? '',
            lastInteractionTs: bond.lastInteractionTs ?? null,
          }
        : null,
    lastIncomingTs: () => lastIncomingTs,
    now: () => NOW,
  });
}

describe('bondContext — 交情上下文尾行', () => {
  it('三段全有：档位 · 最近互动 · dreamer 的认识', () => {
    const line = ctx({ tier: 'close', description: '爱烧脑科幻，正备战发布。常聊剪辑。' }, NOW - 3600)(
      'abc',
    );
    expect(line).toBe(`${BOND_CONTEXT_PREFIX}密友 · 今天他给你来过信 · 爱烧脑科幻，正备战发布`);
  });

  it('只有 tier：不硬凑另外两段', () => {
    expect(ctx({ tier: 'friend' })('abc')).toBe(`${BOND_CONTEXT_PREFIX}好友`);
  });

  it('全空 → 整行不出（陌生人绝不硬凑一行废话）', () => {
    expect(ctx(null)('abc')).toBe('');
    expect(ctx({ tier: 'stranger' })('abc')).toBe('');
  });

  it('空 id 直接放弃', () => {
    expect(ctx({ tier: 'friend' })('')).toBe('');
  });

  it('拉黑/拒收不当档位报出来（那是我对他的处置，不是交情）', () => {
    expect(ctx({ tier: 'blocked', description: '刷屏的' })('abc')).toBe(
      `${BOND_CONTEXT_PREFIX}刷屏的`,
    );
  });

  describe('时间人话化', () => {
    const at = (ts: number) => ctx({ tier: 'friend' }, ts)('abc');
    it('今天', () => expect(at(NOW - 3600)).toContain('今天他给你来过信'));
    it('昨天', () => expect(at(NOW - DAY - 60)).toContain('昨天他给你来过信'));
    it('N 天前', () => expect(at(NOW - 3 * DAY)).toContain('3 天前他给你来过信'));
    it('7 天 → 1 周前', () => expect(at(NOW - 7 * DAY)).toContain('1 周前他给你来过信'));
    it('30 天以上 → 很久以前', () => expect(at(NOW - 90 * DAY)).toContain('很久以前他给你来过信'));
    it('未来的 ts 不出这一段（时钟异常不许瞎说）', () =>
      expect(at(NOW + DAY)).toBe(`${BOND_CONTEXT_PREFIX}好友`));
    it('0 / 负数 ts 不出这一段', () => {
      expect(at(0)).toBe(`${BOND_CONTEXT_PREFIX}好友`);
      expect(at(-1)).toBe(`${BOND_CONTEXT_PREFIX}好友`);
    });
    it('NaN ts 不出这一段', () => expect(at(Number.NaN)).toBe(`${BOND_CONTEXT_PREFIX}好友`));
  });

  it('取两个方向里更近的那一次，方向决定措辞', () => {
    // Their letter was five days ago, my action one day ago: report my action.
    const mine = ctx({ tier: 'friend', lastInteractionTs: NOW - DAY }, NOW - 5 * DAY)('abc');
    expect(mine).toContain('昨天你主动找过他');
    // Reverse the order.
    const his = ctx({ tier: 'friend', lastInteractionTs: NOW - 5 * DAY }, NOW - DAY)('abc');
    expect(his).toContain('昨天他给你来过信');
  });

  it('beforeTs 排除当前这一封（否则永远只会说"今天他给你来过信"）', () => {
    const c = makeBondContext({
      bond: () => ({ tier: 'friend', description: '', lastInteractionTs: null }),
      // Only the current letter (ts = NOW) exists; there is no earlier letter.
      lastIncomingTs: (_id, beforeTs) => (beforeTs > NOW ? NOW : null),
      now: () => NOW,
    });
    expect(c('abc', NOW)).toBe(`${BOND_CONTEXT_PREFIX}好友`);
  });

  it('description 只取第一子句', () => {
    expect(ctx({ tier: 'friend', description: '独立导演。住柏林。' })('abc')).toBe(
      `${BOND_CONTEXT_PREFIX}好友 · 独立导演`,
    );
  });

  it('description 过长截断不截出半个英文词', () => {
    const line = ctx({
      tier: 'friend',
      description: '做 distributed systems consulting 很多年的老工程师',
    })('abc');
    expect(line).not.toMatch(/consulti…|syste…/);
    expect(line.endsWith('…')).toBe(true);
  });

  it('整行不超过 80 字', () => {
    const line = ctx(
      { tier: 'close_plus', description: '这'.repeat(200), lastInteractionTs: NOW - 2 * DAY },
      NOW - 9 * DAY,
    )('abc');
    expect(line.length).toBeLessThanOrEqual(80);
  });

  it('查库抛异常 → 整段尾行放弃，绝不外抛（通知本体不受牵连）', () => {
    const c = makeBondContext({
      bond: () => {
        throw new Error('db locked');
      },
      now: () => NOW,
    });
    expect(c('abc')).toBe('');
  });

  it('没接 lastIncomingTs 也能出档位 + 认识（可选依赖）', () => {
    const c = makeBondContext({
      bond: () => ({ tier: 'friend', description: '爱做菜', lastInteractionTs: null }),
      now: () => NOW,
    });
    expect(c('abc')).toBe(`${BOND_CONTEXT_PREFIX}好友 · 爱做菜`);
  });
});

/**
 * Core acceptance: render the real-host notification (L1 DM plus bond-context tail) once in each of
 * en/zh. Assemble it through the production index.ts path: `renderL1` supplies the first line and
 * `bondTail()` appends `payload.bondLine` (the result of `bondContext(from, ts)`). Before the fix, the
 * tail was always hardcoded Chinese alongside a bilingual first line. Both lines must now use the same
 * language.
 */
describe('bondContext — 截图那条推送的 en/zh 对照（验收核心）', () => {
  const FROM_ID = 'someTestPopclawId1234567890';
  const SIGIL = deriveSigil(FROM_ID);

  function pushLine(lang: 'en' | 'zh-CN', fromName: string): string {
    const bondCtx = makeBondContext({
      bond: () => ({ tier: 'acquaintance', description: '', lastInteractionTs: null }),
      lastIncomingTs: () => NOW - 3600, // One hour ago maps to today (Chinese label: 今天).
      now: () => NOW,
    });
    const bondLine = bondCtx(FROM_ID, NOW, lang);
    return renderL1(
      {
        id: 1,
        level: 'L1',
        kind: 'dm',
        payload: {
          fromPopclawId: FROM_ID,
          fromName,
          body: '',
          mediaPath: '/x/1.ogg',
          ...(bondLine ? { bondLine } : {}),
        },
        enqueuedAt: 100,
      },
      lang,
    );
  }

  it('zh：完整信件展示保留发件人、附件和关系尾行', () => {
    const line = pushLine('zh-CN', '白鹭昭武大将军');
    expect(line).toBe(
      `📨 收到信件\n来自：白鹭昭武大将军#${SIGIL}\n\n📎 附件：1.ogg\n${BOND_CONTEXT_PREFIX}认识 · 今天他给你来过信`,
    );
  });

  it('en：整条推送不含任何 CJK（这正是截图报障的混杂）', () => {
    const line = pushLine('en', 'Egret');
    expect(line).toBe(
      `📨 Letter received\nFrom: Egret#${SIGIL}\n\n📎 Attachment: 1.ogg\n${bondContextPrefix('en')}acquaintance · messaged you today`,
    );
    expect(line).not.toMatch(/[一-鿿]/);
    expect(line).not.toContain('　'); // the CJK ratchet's Han-only regex above wouldn't catch a stray full-width space
  });
});
