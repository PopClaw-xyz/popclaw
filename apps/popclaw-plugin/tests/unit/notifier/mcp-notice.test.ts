import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  unreadNotice,
  renderNotifications,
  makeNotificationsTool,
} from '../../../src/notifier/mcp-notice.js';
import type { Notifier } from '../../../src/notifier/notifier.js';
import type { NotificationItem, NotificationLevel } from '../../../src/notifier/types.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S6 L1 push lexicon: renderNotifications now pre-renders in `ownerLang()`.
// S13: unreadNotice now goes through the same lexicon (was the last hardcoded
// zh string in this file). Every assertion below predates the lexicon and
// encodes the pre-migration zh production strings — pin the process register
// to zh-CN for the whole file so they keep proving zero regression unchanged.
// The dedicated en-lane block passes `'en'` explicitly.
beforeAll(() => setOwnerLang('zh-CN', 'config'));
afterAll(() => setOwnerLang(undefined));

describe('unreadNotice (L1 piggyback)', () => {
  it('appends NOTHING when there is nothing unread', () => {
    expect(unreadNotice(0, 0)).toBeNull();
  });

  it('leads with L1 (私信/提及) and trails with L2 (动态)', () => {
    expect(unreadNotice(3, 2)).toBe('📬 3 条新私信/提及待看，2 条动态 —— 调 popclaw_notifications 查看');
  });

  it('omits the tier that is empty', () => {
    expect(unreadNotice(1, 0)).toBe('📬 1 条新私信/提及待看 —— 调 popclaw_notifications 查看');
    expect(unreadNotice(0, 4)).toBe('📬 4 条动态 —— 调 popclaw_notifications 查看');
  });
});

describe('renderNotifications', () => {
  const item = (
    level: NotificationLevel,
    kind: NotificationItem['kind'],
    payload: Record<string, unknown>,
  ): NotificationItem => ({ id: 1, level, kind, payload, enqueuedAt: 0 });

  // 陌生人来信本来是静默的；有分量的陌生人不该被吃掉。
  // 标签只报事实（认证 + 粉丝数），不替主人下"这人重要"的结论。
  it('大 V 来信/关注：报出他是谁、有多少分量', () => {
    const out = renderNotifications([
      item('L1', 'dm', { fromPopclawId: 'abcdef0123456789', fromName: '某位大V', body: '你好', verifiedFollowerCount: 250_000 }),
      item('L2', 'followed_you', { followerPopclawId: 'ffee00112233', verifiedFollowerCount: 1_300_000 }),
    ]);
    expect(out).toContain('认证 · 250k 粉');
    expect(out).toContain('认证 · 1.3m 粉');
  });

  it('不知道分量就一个字不加（0 不是"没有粉丝"，是"没查过"）', () => {
    const out = renderNotifications([
      item('L1', 'dm', { fromPopclawId: 'abcdef0123456789', fromName: '老张', body: '在吗' }),
    ]);
    expect(out).not.toContain('认证 ·');
  });

  // 做梦整理出来的东西终于有嘴了。
  // 名字照全局规矩走「名号#印信」，档位报人话不报 wire 值。
  // 文案要写全「当前及建议档位」与回应方式。
  it('renders the dreamer\'s findings the way the owner would hear them', () => {
    const out = renderNotifications([
      item('L2', 'bond_proposal', {
        popclawId: 'abcdef0123456789',
        fromTier: 'acquaintance',
        toTier: 'friend',
        rationale: '最近 30 天互动 7 次',
      }),
      item('L2', 'bond_milestone', { popclawId: 'ffee00112233', summary: '像是要结婚了' }),
    ]);
    expect(out).toContain(`[L2] 升档提议 · 昨晚整理——#${deriveSigil('abcdef0123456789')}（认识 → 好友）最近 30 天互动 7 次，升吗？`);
    expect(out).toContain('接受／拒绝／暂缓');
    expect(out).toContain('popclaw_decide_bond_tier_proposal');
    expect(out).toContain(`[L2] 大事 · #${deriveSigil('ffee00112233')}像是要结婚了`);
    expect(out).not.toContain('friend"');
    expect(out).not.toContain('acquaintance');
    expect(out).not.toContain('abcdef01…');
  });

  it('says so when the queue is empty', () => {
    expect(renderNotifications([])).toBe('📭 没有待看的通知。');
  });

  // 这些行最终由宿主 agent 转告主人 → 与 renderL1 同口径：`名号#印信`，
  // 没名字只报 `#印信`。裸 id 前缀一个字都不留。
  it('renders each item with what it is and where to act', () => {
    const out = renderNotifications([
      item('L1', 'dm', { fromPopclawId: 'abcdef0123456789', fromName: '老张', body: '在吗' }),
      item('L2', 'followed_you', { followerPopclawId: 'ffee00112233' }),
    ]);
    expect(out).toContain('你有 2 条待看');
    expect(out).toContain(
      `📨 收到信件\n来自：老张#${deriveSigil('abcdef0123456789')}\n\n在吗`,
    );
    expect(out).toContain(`[L2] 新粉 · #${deriveSigil('ffee00112233')} 关注了你`);
    expect(out).not.toContain('abcdef01…');
    expect(out).not.toContain('ffee0011…');
  });

  // 纯图私信：正文是空串，不能渲成一对空引号。
  it('纯图私信渲成「一张图 📎」，不留空引号', () => {
    const out = renderNotifications([
      item('L1', 'dm', { fromPopclawId: 'abcdef0123456789', fromName: '老张', body: '', mediaPath: '/x/1.png' }),
    ]);
    expect(out).toContain(`来自：老张#${deriveSigil('abcdef0123456789')}\n\n📎 附件：1.png`);
    expect(out).not.toContain('「」');
  });

  // 交情上下文尾行（2026-07-29）：MCP 宿主下主人是通过 agent 转述读到这些行的，
  // 「这人是谁」的价值只多不少 —— 与 renderL1 同款尾行、同一份 payload 素材。
  it('dm / reply / followed_you 各自带交情上下文尾行', () => {
    const out = renderNotifications([
      item('L1', 'dm', { fromPopclawId: 'abcdef0123456789', body: '在吗', bondLine: '　 ↳ 密友 · 昨天他给你来过信' }),
      item('L1', 'reply', { fromPopclawId: 'aa11', body: '好', targetPostId: 'p1', bondLine: '　 ↳ 好友' }),
      item('L2', 'followed_you', { followerPopclawId: 'ffee00112233', bondLine: '　 ↳ 认识 · 爱做菜' }),
    ]);
    expect(out).toContain('在吗\n　 ↳ 密友 · 昨天他给你来过信');
    expect(out).toContain('看这条 p1\n　 ↳ 好友');
    expect(out).toContain('关注了你\n　 ↳ 认识 · 爱做菜');
  });

  it('没有尾行时逐字不变（整行不出，不是空行）', () => {
    const out = renderNotifications([
      item('L1', 'dm', { fromPopclawId: 'abcdef0123456789', body: '在吗' }),
    ]);
    expect(out).not.toContain('↳');
    expect(out.split('\n')).toHaveLength(5); // 抬头 + 一条
  });
});

describe('makeNotificationsTool — drains L1+L2, never L3', () => {
  it('drains only L1 and L2, leaving L3 for the paper', async () => {
    const drained: NotificationLevel[] = [];
    const fake: Notifier = {
      enqueue: () => {},
      count: () => 0,
      drain: (level) => {
        drained.push(level!);
        return [];
      },
    };
    const tool = makeNotificationsTool(async () => fake);
    const res = (await tool.execute('c', {})) as { text: string };
    expect(drained).toEqual(['L1', 'L2']); // L3 untouched
    expect(JSON.parse(res.text).owner_text).toBe('📭 没有待看的通知。');
  });

  // 已决定/失效提议不作为新建议继续送达。
  // 提议在入队后、送达前被 /popclaw review 或 decide 工具处理掉时，
  // 这一条 L2 快照要被滤掉——事实仍在 review 卡里，提醒不必再发。
  it('settled bond proposals are drained but not delivered', async () => {
    const reenqueued: unknown[] = [];
    const fake: Notifier = {
      enqueue: () => void reenqueued.push(1),
      count: () => 0,
      drain: (level) =>
        level === 'L2'
          ? [
              {
                id: 1,
                level: 'L2',
                kind: 'bond_proposal' as const,
                payload: { popclawId: 'GONE', fromTier: 'acquaintance', toTier: 'friend' },
                enqueuedAt: 0,
              },
            ]
          : [],
    };
    const tool = makeNotificationsTool(
      async () => fake,
      undefined,
      async () => ({ hasPendingFor: () => false }),
    );
    const res = (await tool.execute('c', {})) as { text: string };
    expect(JSON.parse(res.text).owner_text).toBe('📭 没有待看的通知。'); // dropped → nothing to say
    expect(reenqueued).toHaveLength(0); // dropped ≠ lost-and-retried; decided is decided
  });

  // 送达失败按既有 L2 机制处理——native 路径
  // 在 render 抛错时把已 drain 的活项原样回队（index.ts），MCP 路径此前没有。
  it('render throw re-enqueues the drained items verbatim and reports failure', async () => {
    const reenqueued: Array<{ level: string; kind: string }> = [];
    const fake: Notifier = {
      enqueue: (a) => void reenqueued.push({ level: a.level, kind: a.kind }),
      count: () => 0,
      drain: (level) =>
        level === 'L1'
          ? [{ id: 1, level: 'L1', kind: 'dm' as const, payload: { fromPopclawId: 'abcdef0123456789' }, enqueuedAt: 0 }]
          : [{ id: 2, level: 'L2', kind: 'bond_milestone' as const, payload: {}, enqueuedAt: 0 }],
    };
    // The name chain is called during render — a throwing chain makes the
    // render fail AFTER the rows are already marked delivered.
    const throwingNameOf = (() => {
      throw new Error('boom');
    }) as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof makeNotificationsTool>[1]>>>;
    const tool = makeNotificationsTool(async () => fake, async () => throwingNameOf);
    const res = (await tool.execute('c', {})) as { text: string };
    expect(res.text).toContain('popclaw_notifications'); // honest failure, agent can retry
    expect(reenqueued).toEqual([
      { level: 'L1', kind: 'dm' },
      { level: 'L2', kind: 'bond_milestone' },
    ]);
  });
});

/**
 * S6 L1 push lexicon — en lane parity, same branches as the zh
 * `renderNotifications` assertions above, rendered with `lang='en'`.
 */
describe('renderNotifications · en lane (S6 lexicon parity)', () => {
  const item = (
    level: NotificationLevel,
    kind: NotificationItem['kind'],
    payload: Record<string, unknown>,
  ): NotificationItem => ({ id: 1, level, kind, payload, enqueuedAt: 0 });

  it('empty queue', () => {
    expect(renderNotifications([], undefined, 'en')).toBe('📭 Nothing pending.');
  });

  it('renders each item with what it is and where to act', () => {
    const out = renderNotifications(
      [
        item('L1', 'dm', { fromPopclawId: 'abcdef0123456789', fromName: 'Zhang', body: 'you there' }),
        item('L2', 'followed_you', { followerPopclawId: 'ffee00112233' }),
      ],
      undefined,
      'en',
    );
    expect(out).toContain('You have 2 pending');
    expect(out).toContain(`📨 Letter received\nFrom: Zhang#${deriveSigil('abcdef0123456789')}\n\nyou there`);
    expect(out).toContain(`[L2] new follower · #${deriveSigil('ffee00112233')} followed you`);
  });

  it('media-only DM does not leave dangling empty quotes', () => {
    const out = renderNotifications(
      [item('L1', 'dm', { fromPopclawId: 'abcdef0123456789', fromName: 'Zhang', body: '', mediaPath: '/x/1.png' })],
      undefined,
      'en',
    );
    expect(out).toContain('Letter received');
    expect(out).toContain('📎 Attachment: 1.png');
    expect(out).not.toContain('""');
  });

  it('unknown person falls back to (unknown), not empty', () => {
    const out = renderNotifications([item('L1', 'followed_you', {})], undefined, 'en');
    expect(out).toContain('(unknown) followed you');
  });

  // en lane：当前及建议档位 + 回应方式。
  it('renders the dreamer\'s proposal with both tiers and how to answer', () => {
    const out = renderNotifications(
      [
        item('L2', 'bond_proposal', {
          popclawId: 'abcdef0123456789',
          fromTier: 'acquaintance',
          toTier: 'friend',
          rationale: 'interacted 7 times in the last 30 days',
        }),
      ],
      undefined,
      'en',
    );
    expect(out).toContain(`tier proposal · Went through things last night — #${deriveSigil('abcdef0123456789')} (acquaintance → friend)`);
    expect(out).toContain('accept / reject / defer');
    expect(out).toContain('popclaw_decide_bond_tier_proposal');
  });
});
