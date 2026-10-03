/**
 * 「那三条原则能挑够最好，挑不够你就用热门来凑，让用户读报纸有一个基本的好的体验就好，
 *   不能太少了，空的也不行」——主人 2026-08-28。
 *
 * 同一天他撤掉了固定条数：「挑多少你可以自己决定，不一定要写死就是 90 条」。
 * 所以这一层只守两端：**下限**（低于它就是一份空报纸，插件按热闹补齐并说出来），
 * 以及**跑飞护栏**（把整份候选原样交回来，那不叫挑）。中间一律放行。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { putIssue, latestCandidate, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { issue, item } from './_issue-fixture.js';

/** 三十条,分属三十个人 —— 免得每人上限把补齐那一步挡掉。 */
const thirty = (): ReturnType<typeof issue> =>
  issue({
    pulse: Array.from({ length: 30 }, (_, i) =>
      item({
        text: `post ${i + 1}`,
        eventId: `e${i + 1}`,
        author: `a${i + 1}`,
        sigil: `sig${i + 1}`,
        authorPopclawId: `pid-${i + 1}`,
        replyCount: 30 - i, // 越靠前越热闹
      }),
    ),
  });

const opts = { mintToken: () => 'tok_x', contentRules: '', leadMax: 3, perAuthorMax: 6, floor: 15, topUpTo: 20 };

describe('挑不够就用热闹补齐', () => {
  beforeEach(() => _resetIssuesForTest());

  it('只挑了三条 → 补到下限之上,补了几条明说,且补进来的都记在「热闹」名下', () => {
    putIssue('c1', thirty());
    const r = buildIssueFromPicks('c1', { taste: [1, 2], bond: [3] }, opts);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.notes.join(' ')).toContain('added by what was liveliest');
    // 补齐后不再是一份空报纸
    expect(r.payload).toContain('post 1');
    // 主人自己挑的那三条,归属不许被补齐动过 —— 版面那行账要靠它
    expect(r.payload).toContain('post 3');
  });

  it('挑够了就一个字都不补 —— 下限是地板不是配额', () => {
    putIssue('c2', thirty());
    const many = Array.from({ length: 18 }, (_, i) => i + 1);
    const r = buildIssueFromPicks('c2', { taste: many }, opts);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.notes.join(' ')).not.toContain('liveliest');
  });

  it('挑了二十条也不再被说「离目标还差得远」—— 固定条数已经撤掉了', () => {
    putIssue('c3', thirty());
    const r = buildIssueFromPicks('c3', { taste: Array.from({ length: 20 }, (_, i) => i + 1) }, opts);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.notes.join(' ')).not.toContain('aims for');
  });
});

/**
 * 令牌错配这一族，两端各一道闸。
 *
 * 候选令牌带 `c`，出版令牌不带，两者存在同一个账本、同一种格式。没有这道闸时，写手交回
 * 一个**出版令牌**会**静默命中**：它的 1..53 落到一个只有二十条的 pulse 上，越界的被当成
 * 「不在页上」丢掉，没越界的指向完全不同的条目——素材页照着这批错的返全文，写手照着写，
 * 成品报纸自洽、看起来正常，只是整份选题都不是它挑的。写手已经混淆过两次令牌
 * （2026-08-27、2026-08-29）。发布那一侧 8/29 就有了对称的闸，挑选这一侧一直漏着。
 */
describe('令牌错配', () => {
  beforeEach(() => _resetIssuesForTest());

  it('拿出版令牌来交挑选 → 当场点名说错了,绝不静默命中', () => {
    putIssue('tok_already_chosen', thirty());
    const r = buildIssueFromPicks('tok_already_chosen', { taste: [1, 2, 3] }, opts);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.message).toContain('publish_token, not the candidate_token');
  });

  it('候选令牌照旧通行 —— 这道闸不许挡住正路', () => {
    putIssue('ctok_fine', thirty());
    expect(buildIssueFromPicks('ctok_fine', { taste: [1, 2, 3] }, opts).kind).toBe('ready');
  });
});

/**
 * 刷屏日：候选池几乎全是同一个人。
 *
 * 补齐用的 selectByHeat 原本从零开始数每人配额，不知道外层挑选已经用掉多少——于是它选出的
 * 「最热」全撞在一个已经用满的作者身上，被外层逐条拒绝，**补齐名存实亡**：回执写着「垫了 3 条」，
 * 听起来问题解决了，而这一期其实远在下限之下。现在配额是共享的，且补完仍然不够时会明说。
 */
describe('刷屏日的补齐', () => {
  beforeEach(() => _resetIssuesForTest());

  const oneAuthor = (): ReturnType<typeof issue> =>
    issue({
      pulse: Array.from({ length: 40 }, (_, i) =>
        item({ text: `p${i}`, eventId: `e${i}`, replyCount: 40 - i }),
      ),
    });

  it('补不动的时候要说「补完仍然不够」,不能只报补了几条', () => {
    putIssue('ctok_spam', oneAuthor());
    const r = buildIssueFromPicks('ctok_spam', { taste: [1, 2] }, opts);
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    const said = r.notes.join(' ');
    expect(said).toContain(`still under ${opts.floor}`);
    expect(said).toContain('too few people');
  });

  it('每人上限照旧守死 —— 补齐不许拿它换条数', () => {
    putIssue('ctok_spam2', oneAuthor());
    const r = buildIssueFromPicks('ctok_spam2', { taste: [1, 2] }, opts);
    if (r.kind !== 'ready') throw new Error(r.message);
    const printed = [...r.payload.matchAll(/^\[(\d+)\]/gm)].length;
    expect(printed).toBeLessThanOrEqual(opts.perAuthorMax);
  });
});

/**
 * 令牌不该是一场记忆力考试。
 *
 * 2026-08-30 乙机：3 分钟铸 11 份候选集、零次挑选成功。宿主自己的技能工坊读了那次会话，
 * 把结论写进它生成的技能里：「**模型记不住令牌——它必须从工具输出里重新读出来逐字打进去**」
 * 「**不要拿同一个占位符重试——那会永远循环**」。它就是在拿占位符重试。
 *
 * 六个晚上的事故全绕着同一个要求转：跨一次工具往返、逐字誊写一个随机不透明串。
 * 所以别再给这个要求打补丁了 —— 令牌认不出来时，落到最新那份候选集上，
 * **而素材页就从那一份生成**，写手写的东西和我们给的编号天然同源。
 */
describe('令牌认不出来时不该死循环', () => {
  beforeEach(() => _resetIssuesForTest());

  it('盘上找得到最新那份候选集', () => {
    putIssue('ctok_old', thirty());
    putIssue('ctok_new', thirty());
    // 同日守门后 today 由调用方判定;这里沿用夹具日期 = 这些候选集都是「今天」的。
    expect(latestCandidate(undefined, thirty().dateLabel)?.token).toBe('ctok_new');
  });

  it('出版令牌不算候选集 —— 兜底只认 c 开头的', () => {
    putIssue('tok_an_issue', thirty());
    expect(latestCandidate(undefined, thirty().dateLabel)).toBeUndefined();
  });

  it('一份候选集都没有 → 老实说没有,不瞎兜', () => {
    expect(latestCandidate(undefined, thirty().dateLabel)).toBeUndefined();
  });
});
