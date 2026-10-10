/**
 * Claiming a complete page is justified only when this machine's limit is actually known.
 *
 * On 2026-08-29 machine B reported truncated materials, fetched feed data to fill gaps, and
 * misattributed every person's words. The truncation claim may have been true: the host keeps
 * both ends and removes the middle on overflow without notifying the tool, while the candidate
 * page claimed nothing was missing or truncated. The real limit is known only after a host
 * model_call_started event; MCP receives no host events, nor does the first call after restart.
 *
 * Owner decision, 2026-08-30 (plan C): retain the optimistic budget, but omit the guarantee
 * when the limit is unknown and give the model an honest exit. Fetching its own replacement
 * data because it distrusts the plugin must not be the only response to missing content.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildCandidatePage, candidateOrder } from '../../../src/newspaper/build-candidate-page.js';
import {
  noteContextTokenBudget,
  pageBudgetNow,
  _resetBudgetForTest,
} from '../../../src/newspaper/host-budget.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { issue, item } from './_issue-fixture.js';
import type { PulseItem } from '../../../src/newspaper/issue.js';

const page = (): string =>
  buildCandidatePage(issue({ pulse: [item()] }), {
    tasteText: '',
    bondLines: [],
    publishToken: 'ctok_x',
    suggestMin: 20,
    suggestMax: 40,
    floor: 15,
    perAuthorMax: 6,
    budget: pageBudgetNow(),
    dayTotal: 1,
    overBudget: false,
  });

const L = (k: string, v: Record<string, string> = {}): string =>
  renderCopy('zh-CN', `newspaper.candidates.${k}`, v);

describe('页面完整性这句保证', () => {
  beforeEach(() => _resetBudgetForTest());

  it('不知道这台机器的上限 → 不许说「完整」,并给出一条诚实的出路', () => {
    const p = page();
    expect(p).not.toContain(L('integrity.known'));
    expect(p).toContain('complete saved candidate document');
    // State the exit explicitly; otherwise missing pages leave only self-fetching data, which caused misattribution.
    expect(p).toContain('never substitute a fresh feed');
  });

  it('宿主报了真实预算 → 这句保证才说得出口', () => {
    noteContextTokenBudget(undefined, 1_000_000);
    const p = page();
    expect(p).toContain('Follow page_cursor');
    expect(p).not.toContain('按预估容量');
  });

  it('预算变了,保证也跟着变 —— 它不是一句写死的话', () => {
    noteContextTokenBudget(undefined, 1_000_000);
    expect(page()).toContain('Follow page_cursor');
    _resetBudgetForTest();
    expect(page()).not.toContain(L('integrity.known'));
    expect(page()).toContain('Follow page_cursor');
  });

/**
 * The candidate page promises numbers in order from 1 to N; that must be true.
 *
 * Page order depends on per-author counts: bonded authors first, then strangers with fewer
 * items; one- or two-item authors join scattered submissions at the end. Budget trimming
 * changes those counts. An author trimmed from four to two moves to the end, but numbering
 * was assigned before trimming, yielding [1][2][3][6][7][8][9][10][4][5].
 *
 * Both machines interpreted these gaps as truncation on 2026-08-27 and fetched feed data.
 * One published the whole candidate set; the other exhausted its output budget and stalled.
 * Regroup after trimming (idempotent since group sizes were just sorted) to align page order,
 * persisted order, and numbering again.
 */
  it('这一页装不下今天全部 → 不许再说「完整」,要说「中间可能真的被截掉了」', () => {
    const p = buildCandidatePage(issue({ pulse: [item()] }), {
      tasteText: '',
      bondLines: [],
      publishToken: 'ctok_x',
      suggestMin: 20,
      suggestMax: 40,
      floor: 15,
      perAuthorMax: 6,
      budget: 16_000,
      dayTotal: 400,
      overBudget: true,
    });
    expect(p).toContain('Follow page_cursor');
    expect(p).not.toContain(L('integrity.known'));
    // Report how much was trimmed; previously the page showed only the remaining count as though that were the whole day.
    expect(p).toContain('399');
  });

  it('裁掉了多少要说出来:全天数与本页数分开印,不许合并成一个', () => {
    const p = buildCandidatePage(issue({ pulse: [item(), item({ eventId: 'e2' })] }), {
      tasteText: '',
      bondLines: [],
      publishToken: 'ctok_x',
      suggestMin: 20,
      suggestMax: 40,
      floor: 15,
      perAuthorMax: 6,
      budget: 60_000,
      dayTotal: 336,
      overBudget: false,
    });
    expect(p).toContain('336'); // The entire day.
    expect(p).toContain('2');   // This page.
  });
});

describe('候选页编号必须单调 —— 页面自己是这么承诺的', () => {
  const mk = (author: string, i: number): PulseItem =>
    item({
      author,
      sigil: `${author}sig`,
      authorPopclawId: `pid-${author}`,
      eventId: `e${author}${i}`,
      text: `t${i}`,
    });

  it('裁剪把一个作者砍进「零散来稿」之后,编号仍然从 1 数到 N', () => {
    const pulse = [
      ...Array.from({ length: 3 }, (_, i) => mk('B', i)),
      ...Array.from({ length: 4 }, (_, i) => mk('A', i)),
      ...Array.from({ length: 5 }, (_, i) => mk('C', i)),
    ];
    const ordered = candidateOrder(pulse, 'zh-CN');
    let dropped = 0;
    const trimmed = ordered.filter((p) => !(p.author === 'A' && dropped++ < 2));

    // No regrouping after trimming: preserve the pre-fix behavior here as a counterexample.
    const before = numbersOn(trimmed);
    expect(isAscending(before)).toBe(false);

    // Regroup after trimming, as gather now does.
    const after = numbersOn(candidateOrder(trimmed, 'zh-CN'));
    expect(isAscending(after)).toBe(true);
    expect(after).toEqual([...Array(after.length)].map((_, i) => i + 1));
  });
});

function numbersOn(pulse: readonly PulseItem[]): number[] {
  const html = buildCandidatePage(
    issue({ pulse: [...pulse], totalCount: pulse.length }),
    {
      tasteText: '',
      bondLines: [],
      publishToken: 'ctok_x',
      suggestMin: 20,
      suggestMax: 40,
      floor: 15,
      perAuthorMax: 6,
      budget: 60_000,
      dayTotal: pulse.length,
      overBudget: false,
    },
  );
  return [...html.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
}

const isAscending = (n: readonly number[]): boolean => n.every((x, i) => i === 0 || x > n[i - 1]!);
