/**
 * 切片 H — 账本落盘。真机 2026-07-31：主代理把出报纸派给子代理，取素材与发布落在
 * 两个插件上下文里，纯内存的账本必然落空 → agent 反复报「令牌已过期」。下面第一条
 * 测试就是那个场景（写完把内存清掉，模拟"另一个实例"来读）。
 *
 * v0.2 起账本里装的不再是一串许可链接，而是整份 issue —— 版面在发布这一侧才排，
 * 所以要过河的是全部素材。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  putIssue,
  getIssue,
  getEdit,
  putEdit,
  deleteIssue,
  latestCandidate,
  latestPickedIssue,
  sweepStaleIssues,
  _resetIssuesForTest,
  _backdateIssueForTest,
} from '../../../src/newspaper/issue-store.js';
import { issue, item } from './_issue-fixture.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'popclaw-issues-'));
  _resetIssuesForTest();
});
afterEach(() => {
  _resetIssuesForTest(dir);
});

describe('分批交稿:存稿也要过河', () => {
  it('第一批的稿子跟素材同落一个盘 —— 换了进程,第二批还接得上', () => {
    putIssue('tok_b', issue(), dir);
    putEdit('tok_b', { masthead: '云舟江湖报', items: { '1': { h: 'a', s: 'aa.' } } }, dir);
    _resetIssuesForTest(); // 只清内存 = 补稿那一批落在另一个上下文里
    expect(getEdit('tok_b', dir)?.items?.['1']?.s).toBe('aa.');
    expect(getIssue('tok_b', dir)?.pulse[0]?.author).toBe('levelsio'); // 素材没被存稿顶掉
  });

  it('存稿不给续命:两小时从取素材那一刻算起,补稿刷新不了它', () => {
    putIssue('tok_c', issue(), dir);
    putEdit('tok_c', { masthead: 'm' }, dir);
    // 把「取素材的时刻」拨回三小时前 —— 补稿把 created_at 原样留下,所以这本账照样到期。
    const f = join(dir, 'tok_c.json');
    const raw = JSON.parse(readFileSync(f, 'utf-8')) as { created_at: number };
    writeFileSync(f, JSON.stringify({ ...raw, created_at: Date.now() - 3 * 60 * 60 * 1000 }), 'utf-8');
    _resetIssuesForTest();
    expect(getIssue('tok_c', dir)).toBeUndefined();
    expect(getEdit('tok_c', dir)).toBeUndefined();
  });

  it('没有这本账就没处挂稿子 —— 空令牌上的 putEdit 什么也不做', () => {
    putEdit('nope', { masthead: 'm' }, dir);
    expect(existsSync(join(dir, 'nope.json'))).toBe(false);
    expect(getEdit('nope', dir)).toBeUndefined();
  });
});

describe('issue store (on disk)', () => {
  it('另一个插件实例(子代理)也能查到同一个令牌 —— 事故的正主', () => {
    putIssue('tok_a', issue(), dir);
    _resetIssuesForTest(); // 只清内存,盘上那本还在 = 换了个进程/上下文
    expect(getIssue('tok_a', dir)?.pulse[0]?.author).toBe('levelsio');
  });

  it('整份素材逐字过河 —— 版面在对岸才排,少一格就少一块版', () => {
    const stored = issue({
      pulse: [item({ author: 'a', tier: 'card' }), item({ author: 'b', houseSlug: 'house-world' })],
      pings: [{ fromShort: '张三#abcd1234', bodyPreview: '在吗' }],
      houseVoices: { 'house-world': '世界刚开张' },
      houseLetters: [{ houseSlug: 'house-world', fromShort: '世界#x', dateLabel: '八月一日', body: '欢迎' }],
      mantles: [{ houseSlug: 'house-world', level: 1, text: '蒂法在家', asOf: '14:49' }],
      homeSections: [
        { houseSlug: 'house-world', asOf: '14:49', homes: [{ name: '小屋', visitUrl: 'https://w/h/1', owner: '#z1' }] },
      ],
      byHouse: { 'house-me': 1, 'house-world': 1 },
    });
    putIssue('tok_full', stored, dir);
    _resetIssuesForTest();
    expect(getIssue('tok_full', dir)).toEqual(stored);
  });

  it('超过 2 小时的账不认', () => {
    putIssue('tok_old', issue(), dir);
    _resetIssuesForTest();
    writeFileSync(
      join(dir, 'tok_old.json'),
      JSON.stringify({ issue: issue(), created_at: Date.now() - 3 * 3600_000 }),
    );
    expect(getIssue('tok_old', dir)).toBeUndefined();
  });

  it('写入时顺手扫掉过期文件', () => {
    const stale = join(dir, 'tok_stale.json');
    writeFileSync(stale, '{}');
    const old = (Date.now() - 5 * 3600_000) / 1000;
    utimesSync(stale, old, old);
    putIssue('tok_fresh', issue(), dir);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(dir)).toEqual(['tok_fresh.json']);
  });

  it('JSON 坏了 / 目录不可写 —— 一律当作没有,绝不抛', () => {
    writeFileSync(join(dir, 'tok_bad.json'), 'not json{');
    expect(getIssue('tok_bad', dir)).toBeUndefined();
    // 目录名指向一个文件 → mkdir 必失败;put 仍然只走内存,不抛
    const notADir = join(dir, 'tok_bad.json');
    expect(() => putIssue('tok_c', issue(), notADir)).not.toThrow();
    expect(getIssue('tok_c', notADir)).toBeDefined(); // 内存快路径还在
  });

  it('形状不对的盘上文件当作没有(老版本留下的 F2 账本就是这样)', () => {
    writeFileSync(join(dir, 'tok_v1.json'), JSON.stringify({ allowedUrls: ['https://x/1'], created_at: Date.now() }));
    expect(getIssue('tok_v1', dir)).toBeUndefined();
  });

  it('令牌带路径分隔符一律不落盘(挡 `../` 穿越)', () => {
    putIssue('../../evil', issue(), dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('deleteIssue 把文件也删掉', () => {
    putIssue('tok_d', issue(), dir);
    deleteIssue('tok_d', dir);
    _resetIssuesForTest();
    expect(getIssue('tok_d', dir)).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('不给目录 = 老的纯内存行为(未接线的装配照旧能用)', () => {
    putIssue('tok_mem', issue());
    expect(getIssue('tok_mem')?.pulse).toHaveLength(1);
  });
});

describe('latestPickedIssue —— 成刊行走器的排序与过滤语义', () => {
  // r9(2026-09-06)后 publish 不再无令牌绑定,r25 后挑号也不再回退 —— latestPickedIssue
  // 与 latestCandidate 都无生产调用方;它们留下的意义:两副面孔共用同一行走器,这里
  // 钉的铸序/TTL/同日语义就是那份共享语义。夹具的 dateLabel 是固定历史日期;
  // 这些用例只关心「挑过/最新」,today 一律传夹具同款。
  const FIXTURE_DAY = issue().dateLabel;

  it('只认「挑过的」成刊:最新的若是一份候选集,跳过它', () => {
    putIssue('tok_a', issue(), dir);
    putIssue('ctok_newest', issue(), dir); // 后写 = mtime 最新,但它是候选集
    const r = latestPickedIssue(dir, FIXTURE_DAY);
    expect(r?.token).toBe('tok_a');
  });

  // 「最新」按铸造时刻(created_at)算,不按写入 mtime(2026-09-06 r6 裁定:putEdit
  // 会抬 mtime,压着存稿的旧刊不能靠它反超)。真机上两次铸造相隔秒级;测试里两次
  // putIssue 背靠背可能落在同一毫秒 —— 铸造并列按设计不裁决,所以把先铸的拨回
  // 一秒,让先后毫不含糊(同 numbering-stability 的排序用例)。
  it('多份成刊并存 → 绑最新铸的那份', () => {
    putIssue('tok_first', issue(), dir);
    _backdateIssueForTest('tok_first', Date.now() - 1000, dir);
    putIssue('tok_second', issue(), dir);
    expect(latestPickedIssue(dir, FIXTURE_DAY)?.token).toBe('tok_second');
  });

  it('空账本 → undefined(交给上层去响亮拒绝)', () => {
    expect(latestPickedIssue(dir, FIXTURE_DAY)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 同日守门(2026-09-03 夜裁定):新一天的报纸请求绝不能被前一天的残刊劫持。
// 真机(甲机):昨晚没写完的 issue 文件留到今天,无令牌 publish 一绑,今天
// 的稿子就压在昨天的编号上。残刊按「当场死亡」处理:不绑,且见着就删——
// 它们本来就是 2 小时 TTL 的草稿,打扫是 TTL 清扫的分内事,这里是那条腰带。
// ---------------------------------------------------------------------------
describe('同日守门 —— 前一天的账当场死亡,不绑且删', () => {
  const TODAY = '2026年9月3日';
  const YESTERDAY = '2026年9月2日';

  it('最新成刊是昨天的 → 不绑(undefined),且文件当场删掉', () => {
    putIssue('tok_stale', issue({ dateLabel: YESTERDAY }), dir);
    _resetIssuesForTest(); // 只清内存,盘上那份还在 = 换了进程/上下文
    expect(latestPickedIssue(dir, TODAY)).toBeUndefined();
    expect(existsSync(join(dir, 'tok_stale.json'))).toBe(false);
  });

  it('昨天的成刊还压着没写完的存稿 → 同样死亡删账(不能被今天的无令牌稿续上)', () => {
    putIssue('tok_stale', issue({ dateLabel: YESTERDAY }), dir);
    putEdit('tok_stale', { masthead: '旧报' }, dir);
    _resetIssuesForTest();
    expect(latestPickedIssue(dir, TODAY)).toBeUndefined();
    expect(getEdit('tok_stale', dir)).toBeUndefined(); // 文件连同存稿一起没了
  });

  it('今天的成刊照常绑(同日续写/信道故障恢复不受影响)', () => {
    putIssue('tok_today', issue({ dateLabel: TODAY }), dir);
    _resetIssuesForTest();
    expect(latestPickedIssue(dir, TODAY)?.token).toBe('tok_today');
  });

  it('昨天的最新、今天的手里还有一份 → 删昨天的,绑今天的', () => {
    putIssue('tok_today', issue({ dateLabel: TODAY }), dir);
    putIssue('tok_yday', issue({ dateLabel: YESTERDAY }), dir); // 后写 = mtime 最新
    _resetIssuesForTest();
    expect(latestPickedIssue(dir, TODAY)?.token).toBe('tok_today');
    expect(existsSync(join(dir, 'tok_yday.json'))).toBe(false);
  });

  it('候选集同样守门:昨天的候选集不绑、当场删(挑号不能压在昨天的候选页上)', () => {
    putIssue('ctok_stale', issue({ dateLabel: YESTERDAY }), dir);
    _resetIssuesForTest();
    expect(latestCandidate(dir, TODAY)).toBeUndefined();
    expect(existsSync(join(dir, 'ctok_stale.json'))).toBe(false);
  });

  it('不传 today → 用当下时钟算(真机路径),昨天的账照样死', () => {
    putIssue('tok_stale', issue({ dateLabel: YESTERDAY }), dir);
    _resetIssuesForTest();
    // YESTERDAY 是写死的过去日期,无论测试机今天几号都 ≠ 今天。
    expect(latestPickedIssue(dir)).toBeUndefined();
    expect(existsSync(join(dir, 'tok_stale.json'))).toBe(false);
  });

  it('内存快路径同样守门:昨天的内存账被清出门', () => {
    putIssue('tok_mem_stale', issue({ dateLabel: YESTERDAY }), dir);
    expect(latestPickedIssue(dir, TODAY)).toBeUndefined();
    expect(getIssue('tok_mem_stale', dir)).toBeUndefined(); // 内存里也删了
  });
});

describe('sweepStaleIssues —— 派工时清存货,每间车间从干净的桌面开工', () => {
  const TODAY = '2026年9月3日';
  const YESTERDAY = '2026年9月2日';

  it('混合日期的账本 → 只留今天的(候选集与成刊一起清)', () => {
    putIssue('tok_today', issue({ dateLabel: TODAY }), dir);
    putIssue('tok_yday', issue({ dateLabel: YESTERDAY }), dir);
    putIssue('ctok_yday', issue({ dateLabel: YESTERDAY }), dir);
    putIssue('ctok_today', issue({ dateLabel: TODAY }), dir);
    _resetIssuesForTest();
    sweepStaleIssues(dir, TODAY);
    expect(readdirSync(dir).sort()).toEqual(['ctok_today.json', 'tok_today.json']);
  });

  it('内存账同样清:昨天的条目从进程表里出去', () => {
    putIssue('tok_today', issue({ dateLabel: TODAY }), dir);
    putIssue('tok_yday', issue({ dateLabel: YESTERDAY }), dir);
    sweepStaleIssues(dir, TODAY);
    expect(getIssue('tok_yday', dir)).toBeUndefined();
    expect(getIssue('tok_today', dir)).toBeDefined();
  });

  it('目录不存在 / 坏 JSON —— 绝不抛(派工永不被清扫卡住)', () => {
    expect(() => sweepStaleIssues(join(dir, 'nope'), TODAY)).not.toThrow();
    writeFileSync(join(dir, 'tok_bad.json'), 'not json{');
    expect(() => sweepStaleIssues(dir, TODAY)).not.toThrow();
    // 坏文件没有 dateLabel 可判,归 TTL 清扫管,这里不动它
    expect(existsSync(join(dir, 'tok_bad.json'))).toBe(true);
  });
});
