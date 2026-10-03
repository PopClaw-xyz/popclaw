import { describe, it, expect, afterEach } from 'vitest';
import {
  briefingCard,
  cardText,
  buildExpandedCard,
  bondBookLine,
  followedText,
  verifiedNudgeText,
  errandSkippedText,
  errandNotFoundText,
  errandAmbiguousText,
  attuneSkippedText,
  tasteSavedText,
  channelNoticeText,
  lanternUnreachableText,
  markSavedText,
  markFailedText,
  mehAckText,
  namingRetryText,
  ordinalRetryText,
  pushFailedText,
} from '../../../src/onboarding/act-cards.js';
import { buildErrandBriefing } from '../../../src/onboarding/briefing.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';

// S5: every one of these is plugin-direct copy, so what comes out depends on
// the owner's language. The honesty disciplines below are asserted **in both
// lanes** — a rule that only holds in English is not a rule.
function speaking(tag: string): void {
  setOwnerLang(tag, 'config');
}

afterEach(() => setOwnerLang(undefined));

describe('briefingCard', () => {
  const card = briefingCard(buildErrandBriefing({}), '一行提示');

  it('把简报兜底散文铺成一张卡，正文与简报同源', () => {
    expect(cardText(card)).toContain("anyone above they'd like to follow");
  });

  it('零按钮（入住清单是对话，不是表单）', () => {
    expect(card.actions).toBeUndefined();
  });

  it('可选的 context 行进得去，不给就没有', () => {
    expect(card.blocks.some((b) => b.kind === 'context')).toBe(true);
    const bare = briefingCard(buildErrandBriefing({}));
    expect(bare.blocks.some((b) => b.kind === 'context')).toBe(false);
  });
});

describe('短文案的诚实纪律 — zh-CN 车道', () => {
  it('交情本：逐字「任何服务器、任何其他用户都读不到」，绝不说"任何人"', () => {
    speaking('zh-CN');
    expect(bondBookLine()).toContain('这个本子只在你这台机器上，任何服务器、任何其他用户都读不到');
    expect(bondBookLine()).not.toContain('任何人');
  });

  it('关注回报带上交情本那一句', () => {
    speaking('zh-CN');
    const t = followedText('mrbeast#AAAA1111');
    expect(t).toContain('mrbeast#AAAA1111');
    expect(t).toContain('任何服务器、任何其他用户都读不到');
    // The one follow receipt, not a wording of the errand's own. No house was
    // passed in, so it's the neutral no-house variant (architect ruling:
    // never guess the home house).
    expect(t.startsWith(`${renderCopy('zh-CN', 'relation.followReceivedNoHouse', { who: 'mrbeast#AAAA1111' })}\n`)).toBe(true);
  });

  // G1-copy caller carry-over: the errand act (orchestrator.ts) passes
  // outcome.house — the house makeErrandFollow's own runFollowCommand call
  // named — into followedText. If that plumbing ever dropped it, only
  // mcp-follow-doorbell would have noticed (it names a real house) — this
  // pins it directly.
  it('关注回报：house 已知时，报文点名那个坊（等同命令自身文案，只是 who 不同）', () => {
    speaking('zh-CN');
    const t = followedText('mrbeast#AAAA1111', 'north-house');
    expect(t.startsWith(`${renderCopy('zh-CN', 'relation.followReceived', { who: 'mrbeast#AAAA1111', house: 'north-house' })}\n`)).toBe(true);
    // Same key, same house, only `who` differs.
    expect(t.replace('mrbeast#AAAA1111', 'raw-id')).toBe(
      `${renderCopy('zh-CN', 'relation.followReceived', { who: 'raw-id', house: 'north-house' })}\n${bondBookLine()}`,
    );
  });

  it('认证只在对方真挂着背书时才提，且指明怎么弄', () => {
    speaking('zh-CN');
    const t = verifiedNudgeText('mrbeast#AAAA1111', 'X');
    expect(t).toContain('X 的背书');
    expect(t).toContain('我要认证');
  });

  it('跳过差事：说清诚实后果，不施压', () => {
    speaking('zh-CN');
    expect(errandSkippedText()).toContain('一个人都没有');
    expect(errandSkippedText()).toContain('报纸会挺空的');
  });

  it('跳过口味：不追问第二次，只说以后照热度来', () => {
    speaking('zh-CN');
    expect(attuneSkippedText()).toContain('先按热度给你');
  });

  it('口味只进本机', () => {
    speaking('zh-CN');
    expect(tasteSavedText()).toContain('不上传');
  });

  it('通知频道：告知不索要', () => {
    speaking('zh-CN');
    expect(channelNoticeText()).toContain('在这儿找你');
    expect(channelNoticeText()).not.toContain('设置');
  });

  it('标记成功：带签名 +1 + 本地快照；上报失败照实说', () => {
    speaking('zh-CN');
    expect(markSavedText(2)).toContain('带你签名的 +1');
    expect(markSavedText(2, false)).toContain('上报没成');
    expect(markFailedText(2)).toContain('没标上');
  });

  it('无感 / 越界编号 / 名片推送失败都给得出下一步', () => {
    speaking('zh-CN');
    expect(mehAckText(3)).toContain('少推');
    expect(ordinalRetryText(8)).toContain('1 到 8');
    expect(ordinalRetryText(0)).toContain('没有可挑的条目');
    expect(pushFailedText('白驹', 500)).toContain('HTTP 500');
    expect(pushFailedText('白驹', 'network')).toContain('网络不通');
  });

  it('取名重试三种理由各有说法，且不逼主人', () => {
    speaking('zh-CN');
    expect(namingRetryText('empty')).toContain('报个编号');
    expect(namingRetryText('placeholder')).toContain('机器占位名');
    expect(namingRetryText('digit')).toContain('没有这个编号');
  });

  it('灯坊够不着：不阻塞脊柱', () => {
    speaking('zh-CN');
    expect(lanternUnreachableText()).toContain('往下走');
  });
});

describe('短文案的诚实纪律 — en 车道（源语言）', () => {
  it('交情本：逐字 "no server and no other user"，绝不说 "nobody"', () => {
    speaking('en-US');
    expect(bondBookLine()).toContain('no server and no other user can read it');
    expect(bondBookLine()).not.toContain('nobody can read');
  });

  it('关注回报带上交情本那一句', () => {
    speaking('en-US');
    const t = followedText('mrbeast#AAAA1111');
    expect(t).toContain('mrbeast#AAAA1111');
    expect(t).toContain('no server and no other user can read it');
  });

  it('认证只在对方真挂着背书时才提，且指明怎么弄', () => {
    speaking('en-US');
    const t = verifiedNudgeText('mrbeast#AAAA1111', 'X');
    expect(t).toContain('X endorsement');
    expect(t).toContain('I want to verify');
  });

  it('跳过差事 / 跳过口味 / 口味只进本机：诚实后果，不施压', () => {
    speaking('en-US');
    expect(errandSkippedText()).toContain('My list is empty');
    expect(errandSkippedText()).toContain("paper will be thin");
    expect(attuneSkippedText()).toContain("go by what's loud for now");
    expect(tasteSavedText()).toContain('Nothing uploaded');
  });

  it('通知频道：告知不索要', () => {
    speaking('en-US');
    expect(channelNoticeText()).toContain('come to you here');
    expect(channelNoticeText()).not.toContain('settings');
  });

  it('标记 / 无感 / 越界编号 / 推送失败都给得出下一步', () => {
    speaking('en-US');
    expect(markSavedText(2)).toContain('signed by you');
    expect(markSavedText(2, false)).toContain("the report didn't go through");
    expect(markFailedText(2)).toContain("Couldn't mark #2");
    expect(mehAckText(3)).toContain('less like #3 from here on');
    expect(ordinalRetryText(8)).toContain('between 1 and 8');
    expect(ordinalRetryText(0)).toContain('Nothing to pick from');
    expect(pushFailedText('Farwalker', 500)).toContain('HTTP 500');
    expect(pushFailedText('Farwalker', 'network')).toContain('no network');
  });

  it('取名重试三种理由各有说法', () => {
    speaking('en-US');
    expect(namingRetryText('empty')).toContain('give me a number');
    expect(namingRetryText('placeholder')).toContain('machine placeholder');
    expect(namingRetryText('digit')).toContain('No such number');
  });

  it('灯坊够不着：不阻塞脊柱', () => {
    speaking('en-US');
    expect(lanternUnreachableText()).toContain('or just carry on');
  });
});

describe('认人失败：查无 / 撞号各有出路（与语种无关的原样回带）', () => {
  it('把主人给的那个串原样带回来', () => {
    expect(errandNotFoundText('张三')).toContain('张三');
    expect(errandAmbiguousText(['· 甲#AAAA1111', '· 乙#BBBB2222'])).toContain('甲#AAAA1111');
  });
});

describe('短文案不泄露导航语法', () => {
  for (const tag of ['en-US', 'zh-CN']) {
    it(`一律不出现 /popclaw next|skip（${tag}）`, () => {
      speaking(tag);
      const all = [
        namingRetryText('empty'), namingRetryText('placeholder'), namingRetryText('digit'),
        pushFailedText('白驹', 500), lanternUnreachableText(), markSavedText(1),
        markSavedText(1, false), markFailedText(1), mehAckText(1), ordinalRetryText(8),
        ordinalRetryText(0), attuneSkippedText(), tasteSavedText(), bondBookLine(),
        followedText('甲#AAAA1111'), verifiedNudgeText('甲#AAAA1111', 'X'), errandSkippedText(),
        errandNotFoundText('x'), channelNoticeText(),
      ].join('\n');
      expect(all).not.toContain('/popclaw next');
      expect(all).not.toContain('/popclaw skip');
    });
  }
});

describe('buildExpandedCard', () => {
  const build = (): ReturnType<typeof buildExpandedCard> =>
    buildExpandedCard({
      ordinal: 2,
      nickname: 'alixearle',
      platform: 'instagram',
      bodyPreview: 'Morning routine ✨ 全文',
      replyCount: 7,
      eventId: 'bbbbbbbbbb222',
      postUrlBase: 'http://localhost:3000',
    });

  it('全 preview + 编号 + 平台标签', () => {
    speaking('en-US');
    const t = cardText(build());
    expect(t).toContain('#2');
    expect(t).toContain('alixearle');
    expect(t).toContain('Morning routine ✨ 全文');
  });

  it('中文车道的编号形态照旧', () => {
    speaking('zh-CN');
    expect(cardText(build())).toContain('第 2 条');
  });

  it('源链接用注入的 base（不硬编码 popclaw.me）', () => {
    expect(cardText(build())).toContain('http://localhost:3000/post/bbbbbbbbbb');
  });

  it('继续行说人话，不印斜杠语法', () => {
    speaking('en-US');
    const ctx = build().blocks.find((b) => b.kind === 'context');
    expect(ctx && 'text' in ctx ? ctx.text : '').toContain('"mark N"');
    expect(ctx && 'text' in ctx ? ctx.text : '').not.toContain('/popclaw');
  });
});
