/**
 * Plan 10.14 — BudgetGuard unit tests.
 *
 * Soft cap on cost-observer events. Emits warn at `warnPct`, error +
 * `tripped=true` at 100 %; untrips when older events age out of the
 * rolling window. WatchLoop consults `isTripped()` before scraping.
 */
import { describe, it, expect } from 'vitest';
import { BudgetGuard } from '../../../src/observability/budget-guard';

interface CapturedLog {
  warns: Array<{ obj: Record<string, unknown>; msg: string }>;
  errors: Array<{ obj: Record<string, unknown>; msg: string }>;
  infos: Array<{ obj: Record<string, unknown>; msg: string }>;
  logger: {
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
    info: (obj: Record<string, unknown>, msg: string) => void;
  };
}

function captureLogger(): CapturedLog {
  const cap: Omit<CapturedLog, 'logger'> = { warns: [], errors: [], infos: [] };
  return {
    ...cap,
    logger: {
      warn: (obj, msg) => cap.warns.push({ obj, msg }),
      error: (obj, msg) => cap.errors.push({ obj, msg }),
      info: (obj, msg) => cap.infos.push({ obj, msg }),
    },
  };
}

function costEvent(t: number, usd: number, platform = 'x') {
  return { time: t, providerName: 'p', platform, resultsCount: 1, estimatedCostUsd: usd, latencyMs: 10 };
}

describe('BudgetGuard', () => {
  it('is a no-op when budgetUsd is null (backwards-compatible default)', () => {
    const cap = captureLogger();
    const g = new BudgetGuard({ budgetUsd: null, warnPct: 80, windowMs: 1000, logger: cap.logger });
    g.record(costEvent(0, 999));
    g.record(costEvent(1, 999));
    expect(g.isTripped()).toBe(false);
    expect(cap.warns).toHaveLength(0);
    expect(cap.errors).toHaveLength(0);
  });

  it('emits WARN exactly once when crossing warn_pct upward', () => {
    const cap = captureLogger();
    const g = new BudgetGuard({ budgetUsd: 10, warnPct: 80, windowMs: 60_000, logger: cap.logger, now: () => 0 });
    g.record(costEvent(0, 5));     // 50 % — no warn
    expect(cap.warns).toHaveLength(0);
    g.record(costEvent(0, 3.5));   // 85 % — warn
    expect(cap.warns).toHaveLength(1);
    expect(cap.warns[0]!.msg).toBe('daily budget warn');
    expect(cap.warns[0]!.obj.consumedUsd).toBeCloseTo(8.5, 8);
    expect(cap.warns[0]!.obj.pct).toBeCloseTo(85, 8);

    // Add another below 100 %; consumed=8.5+1=9.5 still in WARN band, no second warn
    g.record(costEvent(0, 1));
    expect(cap.warns).toHaveLength(1);
  });

  it('emits ERROR + sets tripped=true at 100 %', () => {
    const cap = captureLogger();
    const g = new BudgetGuard({ budgetUsd: 10, warnPct: 80, windowMs: 60_000, logger: cap.logger, now: () => 0 });
    g.record(costEvent(0, 9));     // 90 % — warn
    expect(cap.warns).toHaveLength(1);
    expect(g.isTripped()).toBe(false);

    g.record(costEvent(0, 1.5));   // 105 % — error + trip
    expect(cap.errors).toHaveLength(1);
    expect(cap.errors[0]!.msg).toBe('daily budget exceeded; throttling all scrape calls');
    expect(g.isTripped()).toBe(true);
  });

  it('does not re-emit ERROR while already tripped', () => {
    const cap = captureLogger();
    const g = new BudgetGuard({ budgetUsd: 10, warnPct: 80, windowMs: 60_000, logger: cap.logger, now: () => 0 });
    g.record(costEvent(0, 11));    // trip immediately
    expect(cap.errors).toHaveLength(1);
    g.record(costEvent(0, 5));     // still tripped, but no duplicate
    g.record(costEvent(0, 1));
    expect(cap.errors).toHaveLength(1);
    expect(g.isTripped()).toBe(true);
  });

  it('untrips when window expires and emits INFO recovery', () => {
    const cap = captureLogger();
    let now = 1_000_000;
    const g = new BudgetGuard({ budgetUsd: 10, warnPct: 80, windowMs: 60_000, logger: cap.logger, now: () => now });

    g.record(costEvent(now, 11));
    expect(g.isTripped()).toBe(true);

    now += 30_000;                    // mid-window: still tripped
    expect(g.isTripped()).toBe(true);

    now += 31_000;                    // 61_000 ms after the event > 60_000 windowMs
    // First call after recovery clears. Trigger via record() to force the sweep + state update.
    g.record(costEvent(now, 1));      // window now contains only this one $1 event
    expect(g.isTripped()).toBe(false);
    expect(cap.infos.some((l) => l.msg === 'daily budget back below threshold; throttle released')).toBe(true);
  });

  it('rolling window is sticky: events at boundary stay; just past it drop', () => {
    // budget 7.5 so consumed=10 (both events) trips, consumed=5 (one event) doesn't.
    const cap = captureLogger();
    let now = 1_000_000;
    const g = new BudgetGuard({ budgetUsd: 7.5, warnPct: 80, windowMs: 60_000, logger: cap.logger, now: () => now });
    g.record(costEvent(now, 5));               // event at t=1_000_000
    now += 60_000;                              // exactly windowMs later
    g.record(costEvent(now, 5));
    expect(g.isTripped()).toBe(true);           // boundary inclusive: both events count → consumed 10 > 7.5

    now += 1;                                   // sweep: first event drops (now-windowMs > 1_000_000)
    expect(g.isTripped()).toBe(false);          // consumed back to 5 < 7.5
  });

  it('sums across platforms uniformly (single global budget)', () => {
    const cap = captureLogger();
    const g = new BudgetGuard({ budgetUsd: 2.50, warnPct: 80, windowMs: 60_000, logger: cap.logger, now: () => 0 });
    g.record(costEvent(0, 2.0, 'x'));
    g.record(costEvent(0, 0.5, 'instagram'));
    expect(g.isTripped()).toBe(true);  // cross-platform sum 2.5 hits the 2.50 budget
  });

  it('warnPct configurable: 50 % triggers earlier', () => {
    const cap = captureLogger();
    const g = new BudgetGuard({ budgetUsd: 10, warnPct: 50, windowMs: 60_000, logger: cap.logger, now: () => 0 });
    g.record(costEvent(0, 4));         // 40 % — silent
    expect(cap.warns).toHaveLength(0);
    g.record(costEvent(0, 2));         // 60 % — warn
    expect(cap.warns).toHaveLength(1);
  });

  it('isTripped() is window-aware even without a record() call', () => {
    // After events age out enough to cross back below 100 %, isTripped should
    // return false on a read-only check (no record() needed). This matters
    // because WatchLoop consults isTripped() between scrapes — there isn't
    // necessarily a record() event right before the check.
    const cap = captureLogger();
    let now = 1_000_000;
    const g = new BudgetGuard({ budgetUsd: 10, warnPct: 80, windowMs: 60_000, logger: cap.logger, now: () => now });

    g.record(costEvent(now, 11));
    expect(g.isTripped()).toBe(true);

    now += 61_000;
    expect(g.isTripped()).toBe(false);
  });
});
