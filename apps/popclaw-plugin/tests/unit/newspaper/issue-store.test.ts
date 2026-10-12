/**
 * Slice H: persist the ledger. On 2026-07-31 a main agent delegated newspaper production; gathering
 * and publishing ran in separate plugin contexts, so an in-memory ledger caused repeated
 * expired-token errors. The first test reproduces this by clearing memory before another instance
 * reads.
 *
 * Since v0.2 the ledger holds the full issue, not a URL allowlist; layout runs at publication, so
 * all material must cross this boundary.
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
    _resetIssuesForTest(); // Clear only memory to simulate supplemental copy arriving in another context.
    expect(getEdit('tok_b', dir)?.items?.['1']?.s).toBe('aa.');
    expect(getIssue('tok_b', dir)?.pulse[0]?.author).toBe('levelsio'); // Saved copy did not replace the material.
  });

  it('存稿不给续命:两小时从取素材那一刻算起,补稿刷新不了它', () => {
    putIssue('tok_c', issue(), dir);
    putEdit('tok_c', { masthead: 'm' }, dir);
    // Move gathering time three hours back; supplemental copy preserves created_at, so this ledger still expires.
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
    _resetIssuesForTest(); // Clear only memory, retaining disk data, to simulate another process/context.
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
    // A file occupies the directory path, so mkdir fails; put still stores in memory without throwing.
    const notADir = join(dir, 'tok_bad.json');
    expect(() => putIssue('tok_c', issue(), notADir)).not.toThrow();
    expect(getIssue('tok_c', notADir)).toBeDefined(); // The in-memory fast path remains available.
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
  // Since r9 (2026-09-06), publish no longer binds without a token; r25 also removed selection fallback. latestPickedIssue
  // and latestCandidate have no production callers, but share a walker; the mint-order, TTL and same-day semantics
  // pinned here are shared semantics. Fixtures use fixed historical dateLabels;
  // these cases test picked/latest selection only, so today always matches the fixture date.
  const FIXTURE_DAY = issue().dateLabel;

  it('只认「挑过的」成刊:最新的若是一份候选集,跳过它', () => {
    putIssue('tok_a', issue(), dir);
    putIssue('ctok_newest', issue(), dir); // Written later, hence latest mtime, but it is a candidate set.
    const r = latestPickedIssue(dir, FIXTURE_DAY);
    expect(r?.token).toBe('tok_a');
  });

  // Latest means creation time (created_at), not write mtime (r6 decision, 2026-09-06: putEdit
  // advances mtime and must not let an older issue overtake a newer one). Real issues are minted seconds apart, but adjacent
  // putIssue calls in tests can share a millisecond. Ties are intentionally unresolved, so move the earlier issue
  // one second back for unambiguous ordering, as in numbering-stability tests.
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
// Same-day guard (decision on 2026-09-03): a new day's newspaper request must never bind yesterday's unfinished issue.
// Real device (host A): yesterday's unfinished issue survived into today; tokenless publication bound it,
// assigning today's copy to yesterday's numbers. Treat stale issues as dead: do not bind them and delete them when found.
// They are two-hour-TTL drafts already; this guard supplements normal TTL cleanup.
// ---------------------------------------------------------------------------
describe('同日守门 —— 前一天的账当场死亡,不绑且删', () => {
  const TODAY = '2026年9月3日';
  const YESTERDAY = '2026年9月2日';

  it('最新成刊是昨天的 → 不绑(undefined),且文件当场删掉', () => {
    putIssue('tok_stale', issue({ dateLabel: YESTERDAY }), dir);
    _resetIssuesForTest(); // Clear only memory while retaining disk data to simulate another process/context.
    expect(latestPickedIssue(dir, TODAY)).toBeUndefined();
    expect(existsSync(join(dir, 'tok_stale.json'))).toBe(false);
  });

  it('昨天的成刊还压着没写完的存稿 → 同样死亡删账(不能被今天的无令牌稿续上)', () => {
    putIssue('tok_stale', issue({ dateLabel: YESTERDAY }), dir);
    putEdit('tok_stale', { masthead: '旧报' }, dir);
    _resetIssuesForTest();
    expect(latestPickedIssue(dir, TODAY)).toBeUndefined();
    expect(getEdit('tok_stale', dir)).toBeUndefined(); // The file and saved copy are both gone.
  });

  it('今天的成刊照常绑(同日续写/信道故障恢复不受影响)', () => {
    putIssue('tok_today', issue({ dateLabel: TODAY }), dir);
    _resetIssuesForTest();
    expect(latestPickedIssue(dir, TODAY)?.token).toBe('tok_today');
  });

  it('昨天的最新、今天的手里还有一份 → 删昨天的,绑今天的', () => {
    putIssue('tok_today', issue({ dateLabel: TODAY }), dir);
    putIssue('tok_yday', issue({ dateLabel: YESTERDAY }), dir); // Written later, hence latest mtime.
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
    // YESTERDAY is a fixed past date, independent of the test machine's current day.
    expect(latestPickedIssue(dir)).toBeUndefined();
    expect(existsSync(join(dir, 'tok_stale.json'))).toBe(false);
  });

  it('内存快路径同样守门:昨天的内存账被清出门', () => {
    putIssue('tok_mem_stale', issue({ dateLabel: YESTERDAY }), dir);
    expect(latestPickedIssue(dir, TODAY)).toBeUndefined();
    expect(getIssue('tok_mem_stale', dir)).toBeUndefined(); // Also removed from memory.
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
    // A corrupt file has no dateLabel to check; TTL cleanup owns it, so leave it alone here.
    expect(existsSync(join(dir, 'tok_bad.json'))).toBe(true);
  });
});
