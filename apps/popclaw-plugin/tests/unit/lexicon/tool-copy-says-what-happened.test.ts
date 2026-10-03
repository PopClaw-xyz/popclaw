import { describe, expect, it } from 'vitest';
import { EN } from '../../../src/lexicon/en.js';
import { ZH_CN } from '../../../src/lexicon/zh-CN.js';

/**
 * Tool and command replies say what the code actually did (tool-copy audit,
 * 2026-09-26). The trigger: a follow receipt said the followee's activity
 * would "show up under your name", and both the owner and the agent relaying
 * it read that as their posts being attributed to the owner. Each row pins
 * the phrase that carries the corrected meaning, in both locales, so a later
 * rewording has to keep saying the true thing.
 */
const en = EN.copy as Record<string, string>;
const zh = ZH_CN.copy as Record<string, string>;

const PHRASES: ReadonlyArray<readonly [key: string, en: string, zh: string]> = [
  ['relation.followReceived', 'They can see that you followed them', '对方会知道这次关注'],
  ['follow.cli.uncheckedNote', 'check this id against the roster', '核对这个 id'],
  ['relation.unfollowReceived', 'Nobody has to approve it', '不需要谁同意'],
  ['relation.followQueued', 'the follow of {who} has not reached the lore-house yet', '关注 {who} 还没送到灯坊'],
  ['follow.cli.unknownId', "I followed it as typed; if that's wrong: /popclaw unfollow {id}", '我已按你给的原样关注；如果不对：/popclaw unfollow {id}'],
  ['notify.mcp.followIntent.line', 'people you tapped Follow on in the paper are waiting for your OK', '你在报纸上点了关注的 {count} 位，等你点头'],
  ['help.reply.summary', 'nothing is posted to X or other platforms', '不会发到 X 或其他平台'],
  ['onboarding.mark.saved', 'signed by you, so it knows who marked it', '带你签名的 +1，所以它知道是谁标的'],
  ['onboarding.phrasebook', 'the item gets a +1 signed by you', '以你的签名给这条内容 +1'],
  ['newspaper.page.colophon', "with your assistant's model", '用你的助手所用的模型'],
  ['newspaper.page.colophonShared', 'a copy is on the share link for 24 hours', '分享链接上留一份，24 小时后作废'],
  ['doctor.offer.ask', 'the contact your home lore-house lists', '你主灯坊公布的联系人'],
  ['doctor.sent.tail', "That lore-house's contact will reply", '那座灯坊的联系人看到了会私信回你'],
  ['doctor.preview.to', 'its listed contact {contact}', '它公布的联系人 {contact}'],
  ['doctor.usage', 'when the lore-house contact you are writing to asks for it', '只有收信的灯坊联系人主动要求时才加'],
  ['help.feedback.summary', 'the people who run the lore-house', '向运营灯坊的人反馈'],
  ['notify.verifyDone.snapshotWithFollowers', 'current follower count ({followers})', '此刻的关注者人数（{followers}）'],
  ['relation.houseNoFollow', 'arrive without a notification and wait in your inbox', '默认不提醒，留在收件箱里等你看'],
  ['status.house.noRelationReads', 'still recognised from your own follow list', '仍按你本机的关注名单照常认出'],
  ['status.todo.noHouseCard.benefit', "other people's notifications about you", '别人收到的关于你的通知'],
  ['post.replyNotInFeed', "stay out of your followers' feeds", '回复默认不进关注者的动态'],
  ['feedback.receipt.inboxNote', 'If they reply, it lands in your inbox', '对方回信的话'],
  ['notify.mcp.dm.line', 'tell me what to reply', '告诉我回什么'],
  ['feed.public.sharedBy', 'the original author on the other platform is not verified', '原平台上的作者未经核验'],
  ['onboarding.lantern.houseKnowsYou', 'has your namecard', '有你的名帖'],
  ['reply.cli.sent', 'replied on PopClaw to {target}', '已在 PopClaw 上回复 {target}'],
  ['react.cli.recorded', '(@{handle} is not told)', '（不会告知 @{handle}）'],
  ['mark.cli.pushed', 'the lore-house got a +1 signed by you', '灯坊收到一个带你签名的 +1'],
  ['mark.cli.pushFailed', 'lore-house push failed: {error}', '推送到灯坊失败：{error}'],
  ['mark.cli.unknownError', 'unknown error', '未知错误'],
  ['post.cli.usage', '(root post)', '（原创帖）'],
  ['post.cli.notHex', 'must be hex chars', '只能是十六进制字符'],
  ['post.cli.prefixTooShort', 'prefix too short', '前缀太短'],
  ['post.cli.tooLong', 'event_id is 64 hex chars max', 'event_id 最多 64 位十六进制'],
  ['post.cli.prefixAmbiguous', 'prefix ambiguous: {candidates}', '前缀有歧义：{candidates}'],
  ['post.cli.prefixNoMatch', 'prefix matches no known event', '前缀对不上任何已知事件'],
  ['post.cli.replyQuoteExclusive', 'mutually exclusive', '只能二选一'],
  ['post.cli.serverError', 'failed server-side (HTTP {status})', '在服务端失败（HTTP {status}）'],
  ['post.cli.rejected', 'rejected by lore-house (HTTP {status})', '被灯坊拒收（HTTP {status}）'],
  ['post.cli.quoted', 'quoted #{short}', '已引用 #{short}'],
  ['post.cli.replied', 'replied #{short}', '已回复 #{short}'],
  ['post.cli.posted', 'posted #{short}', '已发帖 #{short}'],
];

describe('tool copy says what actually happened', () => {
  it.each(PHRASES)('%s carries its key phrase in both locales', (key, enPhrase, zhPhrase) => {
    expect(en[key]).toContain(enPhrase);
    expect(zh[key]).toContain(zhPhrase);
  });

  it('no copy claims a follow puts anything under the owner\'s name', () => {
    for (const text of [...Object.values(en), ...Object.values(zh)]) {
      if (typeof text !== 'string') continue;
      expect(text).not.toMatch(/under your name|跟着你的名号记下/);
    }
  });

  // One follow receipt. The tool, the slash command and the onboarding errand
  // each used to override relation.followReceived with a wording of their own,
  // which is how "under your name" got past the careful one.
  it('the follow receipt exists once: the per-path copies are gone', () => {
    for (const key of ['follow.success', 'follow.cli.ok', 'onboarding.errand.followed', 'follow.cli.okUnchecked']) {
      expect(en[key]).toBeUndefined();
      expect(zh[key]).toBeUndefined();
    }
    expect(en['follow.cli.unknownId']).not.toContain('Now following');
    expect(zh['follow.cli.unknownId']).not.toContain('已关注 {id}');
  });

  // Same rule, the unfollow side: popclaw_unfollow used to override
  // relation.unfollowReceived with its own 'unfollow.success' ("Unfollowed
  // {who}."), the same per-path pattern removed above for follow.
  it('the unfollow receipt exists once: unfollow.success is gone', () => {
    expect(en['unfollow.success']).toBeUndefined();
    expect(zh['unfollow.success']).toBeUndefined();
  });

  it('a follow is not called public', () => {
    expect(en['relation.followReceived']).not.toMatch(/public:/);
    expect(zh['relation.followReceived']).not.toContain('关注是公开的');
  });

  // G1-copy (found in real acceptance): the owner asked "how do I know this
  // follow happened in world and not in me?" — the success receipts said only
  // "the lore-house" / "灯坊", never which one.
  //
  // Architect ruling: name ONLY the house that actually accepted the
  // declaration, and only then — never on a queued or refused outcome (those
  // must not read as success or name a house at all), and never a guess when
  // the house is unknown (the …NoHouse variants carry no {house} either).
  it('only the accepted-lane receipts name the house; queued/no-house variants never do', () => {
    for (const key of ['relation.followReceived', 'relation.unfollowReceived']) {
      expect(en[key]).toContain('{house}');
      expect(zh[key]).toContain('{house}');
    }
    for (const key of [
      'relation.followQueued', 'relation.unfollowQueued',
      'relation.followReceivedNoHouse', 'relation.unfollowReceivedNoHouse',
    ]) {
      expect(en[key]).not.toContain('{house}');
      expect(zh[key]).not.toContain('{house}');
    }
  });

  // The other party's gender is unknown; 「他」 assumed male. Same lexicon
  // block, follow receipt only (both the named-house and no-house variants) —
  // its siblings here (queued/unfollow/etc.) never referred to the other
  // party by pronoun in the first place.
  it('the follow receipt uses 对方, not a gendered 他, for the other party', () => {
    for (const key of ['relation.followReceived', 'relation.followReceivedNoHouse']) {
      expect(zh[key]).toContain('对方');
      expect(zh[key]).not.toMatch(/他/);
    }
  });

  it('marks are never described as anonymous', () => {
    for (const key of ['onboarding.mark.saved', 'onboarding.phrasebook', 'mark.cli.pushed']) {
      expect(en[key]).not.toMatch(/anonymous/i);
      expect(zh[key]).not.toContain('匿名');
    }
  });

  it('a lore-house contact is never called "the makers" or 官方/作者', () => {
    for (const key of ['doctor.offer.ask', 'doctor.sent.tail', 'doctor.preview.to', 'doctor.usage', 'help.feedback.summary']) {
      expect(en[key]).not.toMatch(/makers|official/);
      expect(zh[key]).not.toMatch(/官方|作者/);
    }
  });
});
