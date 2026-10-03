/**
 * host-budget bucketing (dedicated-session cut 1, proposal 2026-09-03 §4-3).
 *
 * The context-token budget used to be ONE process-wide number. With the paper
 * produced in a child session, the main chat and the workshop can sit on
 * different models with different windows, and whichever session had a model
 * call last overwrote the number the other was trimming its pages against.
 * The fix: one bucket per sessionKey, with the old single value living on as
 * the default bucket.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetBudgetForTest,
  budgetKnown,
  hostToolResultCap,
  lastContextTokens,
  noteContextTokenBudget,
  pageBudget,
  pageBudgetDecision,
  pageBudgetLogLine,
  pageBudgetNow,
} from '../../../src/newspaper/host-budget.js';

const MAIN = 'agent:main:telegram:12345';
const CHILD = 'agent:main:popclaw-newspaper:20260903-0700';

describe('host budget buckets', () => {
  beforeEach(() => _resetBudgetForTest());

  it('two sessions never overwrite each other', () => {
    noteContextTokenBudget(MAIN, 50_000);
    noteContextTokenBudget(CHILD, 1_000_000);
    expect(lastContextTokens(MAIN)).toBe(50_000);
    expect(lastContextTokens(CHILD)).toBe(1_000_000);
    // The cap follows the tier, so the two budgets genuinely differ.
    expect(pageBudget(CHILD)).toBe(Math.floor(hostToolResultCap(1_000_000) * 0.88));
    expect(pageBudget(MAIN)).toBeLessThan(pageBudget(CHILD)!);
  });

  it('a later write to one bucket leaves the other untouched (the exact clobber the fix ends)', () => {
    noteContextTokenBudget(MAIN, 50_000);
    noteContextTokenBudget(CHILD, 1_000_000);
    noteContextTokenBudget(CHILD, 300_000);
    expect(lastContextTokens(MAIN)).toBe(50_000);
    expect(lastContextTokens(CHILD)).toBe(300_000);
  });

  it('no sessionKey → the default bucket, exactly the old single-value behavior', () => {
    noteContextTokenBudget(undefined, 1_000_000);
    expect(budgetKnown()).toBe(true);
    expect(budgetKnown(undefined)).toBe(true);
    expect(pageBudgetNow()).toBe(Math.floor(hostToolResultCap(1_000_000) * 0.88));
    expect(pageBudgetNow(undefined)).toBe(pageBudgetNow());
  });

  it('a session that has not reported yet falls back to the default bucket, never to a guess', () => {
    noteContextTokenBudget(undefined, 200_000);
    expect(budgetKnown('agent:main:never-heard-of')).toBe(true);
    expect(pageBudget('agent:main:never-heard-of')).toBe(pageBudget(undefined));
  });

  it('still ignores garbage, per bucket', () => {
    noteContextTokenBudget(MAIN, Number.NaN);
    noteContextTokenBudget(MAIN, -5);
    noteContextTokenBudget(MAIN, undefined);
    expect(budgetKnown(MAIN)).toBe(false);
  });
});

/**
 * Why a page was sized the way it was (2026-09-13).
 *
 * A live workshop run came back with both pages cut, and nothing in the log could say
 * whether the workshop had reported a budget of its own, silently borrowed the chat
 * session's through the default bucket, or fallen through to the constant. The decision now
 * reports which of the three happened — and reports it WITHOUT changing any of them.
 */
describe('pageBudgetDecision', () => {
  beforeEach(() => _resetBudgetForTest());

  it('the session reported its own budget', () => {
    noteContextTokenBudget(CHILD, 1_000_000);
    const d = pageBudgetDecision(CHILD);
    expect(d).toEqual({
      bucketKey: CHILD,
      source: 'own',
      budget: Math.floor(hostToolResultCap(1_000_000) * 0.88),
      tokens: 1_000_000,
    });
  });

  it('the session never reported → the DEFAULT bucket, and it says so', () => {
    noteContextTokenBudget(MAIN, 256_000); // the chat session syncs
    noteContextTokenBudget(undefined, 256_000); // …and lands in the default bucket too
    const d = pageBudgetDecision(CHILD); // the workshop, which never reported
    expect(d.source).toBe('default-bucket');
    expect(d.bucketKey).toBe(CHILD);
    expect(d.tokens).toBe(256_000);
  });

  it('nothing heard at all → the constant applied', () => {
    const d = pageBudgetDecision(CHILD);
    expect(d.source).toBe('constant');
    expect(d.tokens).toBeUndefined();
    expect(d.budget).toBe(60_000);
  });

  it('decides exactly what pageBudgetNow decides — this is diagnostics, not a new policy', () => {
    expect(pageBudgetDecision(CHILD).budget).toBe(pageBudgetNow(CHILD));
    noteContextTokenBudget(undefined, 256_000);
    expect(pageBudgetDecision(CHILD).budget).toBe(pageBudgetNow(CHILD));
    expect(pageBudgetDecision().budget).toBe(pageBudgetNow());
    noteContextTokenBudget(CHILD, 50_000);
    expect(pageBudgetDecision(CHILD).budget).toBe(pageBudgetNow(CHILD));
  });

  it('a caller that names no session reads the default bucket, and the key is empty', () => {
    noteContextTokenBudget(undefined, 200_000);
    const d = pageBudgetDecision();
    expect(d.bucketKey).toBe('');
    expect(d.source).toBe('default-bucket');
  });
});

describe('pageBudgetLogLine', () => {
  beforeEach(() => _resetBudgetForTest());

  it('carries the key verbatim and quoted, plus the numbers — and no content', () => {
    noteContextTokenBudget(CHILD, 200_000);
    const line = pageBudgetLogLine('candidate', pageBudgetDecision(CHILD), 27_926, 42, 155);
    expect(line).toContain(`session "${CHILD}"`);
    expect(line).toContain('(own, 200000 context tokens)');
    expect(line).toContain('page 27926 units, 42 of 155 items trimmed');
    expect(line.startsWith('popclaw: newspaper candidate page built')).toBe(true);
  });

  it('the constant case names no token count (there is none to name)', () => {
    const line = pageBudgetLogLine('material', pageBudgetDecision(CHILD), 100, 0, 15);
    expect(line).toContain('(constant)');
    expect(line).toContain('popclaw: newspaper material page built');
  });
});
