/**
 * 「这一页是完整的」这句话，只在我们真知道这台机器的上限时才说得出口。
 *
 * 2026-08-29 乙机说「素材被截断了」，然后跑去 feed 补全，结果整份报纸把每个人的话安到了
 * 别人头上。它很可能说的是实话：宿主超限时**保头保尾、砍掉中间、不通知工具**，而候选页
 * 上印着「一条不缺、没有任何内容被截断」。真实上限只有在宿主发来 `model_call_started`
 * 时才知道 —— MCP 那条根收不到任何宿主事件，重启后的第一次调用也收不到。
 *
 * 主人 2026-08-30 的裁定（方案 C）：**赌大照旧，但不知道的时候就别写那句保证**，
 * 并给模型一条诚实的出路。它发现缺页时的唯一出路不能是「不信插件、自己去取数据」。
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
    // 出路必须写明,否则模型发现缺页时只剩「自己去取数据」这一条路 —— 认错人就是这么来的
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
 * 「下面的编号从 1 到 N 依次排下来」——这句话印在候选页上，必须为真。
 *
 * 页面顺序由「同作者条数」决定（有交情的在前，陌生人少的在前，一两条的合成「零散来稿」
 * 收在页尾）。而**预算裁剪会改变条数**：一个从四条被砍到两条的作者会越过「零散」门槛、
 * 被挪到页尾——可编号是裁剪前那一轮发的。实测能排出 [1][2][3][6][7][8][9][10][4][5]。
 *
 * 2026-08-27 两台机器就是看着这种跳号，判定「内容被截断了」，跑去 feed 补全，
 * 一台把整份候选集端上了版面，另一台把输出预算烧光挂死。修法是裁剪之后重新分一次组
 * （幂等：组的大小刚刚才排过序），让页面顺序、落盘顺序、编号重新变回同一件事。
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
    // 裁掉了多少,必须说 —— 以前页面只印裁剪后的数,当成「今天就这么点事」
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
    expect(p).toContain('336'); // 今天全天
    expect(p).toContain('2');   // 这一页
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

    // 裁剪之后**不**重新分组 —— 这是修复前的行为,留在这里当反例
    const before = numbersOn(trimmed);
    expect(isAscending(before)).toBe(false);

    // 裁剪之后重新分组 —— 现在 gather 就是这么做的
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
