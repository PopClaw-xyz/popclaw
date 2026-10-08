/**
 * BudgetGuard.
 *
 * Soft cap on commercial-scrape spend. Records each cost-observer event
 * into a rolling 24 h window (configurable). When consumption crosses
 * `warnPct` upward, emits a structured WARN; at 100 %, emits ERROR + sets
 * `tripped=true`. The watch loop consults `isTripped()` before each
 * scrape and short-circuits to a miss when it returns true, letting the
 * tier state machine (HOT → WARM → COLD → SLEEP) drive handles down
 * naturally; consumption decays as old events age out and the breaker
 * untrips on its own.
 *
 * Backwards-compatible default: `budgetUsd: null` → guard is a no-op
 * (no recording, no warnings, never trips). Existing deployments observe
 * zero behaviour change unless they opt in via `POPCLAW_DAILY_BUDGET_USD`.
 *
 */

import type { CostEvent } from '../scraper/commercial/apify-actor-scraper.js';

export interface BudgetLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface BudgetGuardOptions {
  /** Total USD allowed in any rolling `windowMs` window. `null` disables the guard entirely. */
  readonly budgetUsd: number | null;
  /** Percent of `budgetUsd` that triggers a one-shot WARN. */
  readonly warnPct: number;
  /** Rolling window in milliseconds (default 24 h). */
  readonly windowMs: number;
  readonly logger?: BudgetLogger;
  readonly now?: () => number;
}

interface RecordedEvent {
  readonly timeMs: number;
  readonly costUsd: number;
  readonly platform: string;
}

const NULL_LOGGER: BudgetLogger = {
  warn: () => undefined,
  error: () => undefined,
  info: () => undefined,
};

const WINDOW_24H_MS = 24 * 3600 * 1000;

export class BudgetGuard {
  private readonly logger: BudgetLogger;
  private readonly now: () => number;
  private readonly events: RecordedEvent[] = [];
  private warnFired = false;
  private tripped = false;

  constructor(private readonly opts: BudgetGuardOptions) {
    this.logger = opts.logger ?? NULL_LOGGER;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Build from `process.env.POPCLAW_DAILY_BUDGET_USD` + optional warn-pct. */
  static fromEnv(logger?: BudgetLogger): BudgetGuard {
    const raw = process.env.POPCLAW_DAILY_BUDGET_USD;
    const budgetUsd = raw ? Number.parseFloat(raw) : NaN;
    const warnRaw = process.env.POPCLAW_DAILY_BUDGET_WARN_PCT;
    const warnPct = warnRaw ? Number.parseFloat(warnRaw) : 80;
    return new BudgetGuard({
      budgetUsd: Number.isFinite(budgetUsd) && budgetUsd > 0 ? budgetUsd : null,
      warnPct: Number.isFinite(warnPct) && warnPct > 0 ? warnPct : 80,
      windowMs: WINDOW_24H_MS,
      logger,
    });
  }

  /** Called from the cost observer for every commercial scrape. No-op when disabled. */
  record(event: CostEvent): void {
    if (this.opts.budgetUsd === null) return;
    this.events.push({
      timeMs: this.now(),
      costUsd: event.estimatedCostUsd,
      platform: event.platform,
    });
    this.evaluate();
  }

  /** True when current rolling sum has crossed 100 % of budget. Cheap to call. */
  isTripped(): boolean {
    if (this.opts.budgetUsd === null) return false;
    // Re-evaluate on read so callers see the up-to-date state even if no
    // record() has fired since the last expiry boundary. WatchLoop polls
    // this every tick — the cost is one Date.now() + a few array ops.
    this.evaluate();
    return this.tripped;
  }

  // ─── internals ───────────────────────────────────────────────────────

  private dropExpired(): void {
    const cutoff = this.now() - this.opts.windowMs;
    while (this.events.length > 0 && this.events[0]!.timeMs < cutoff) {
      this.events.shift();
    }
  }

  /** Sweep, sum, decide which level to emit, set/clear the trip flag. */
  private evaluate(): void {
    if (this.opts.budgetUsd === null) return;
    this.dropExpired();
    const consumed = this.events.reduce((s, e) => s + e.costUsd, 0);
    const pct = (consumed / this.opts.budgetUsd) * 100;

    if (pct >= 100 && !this.tripped) {
      this.tripped = true;
      this.logger.error(
        {
          consumedUsd: consumed,
          budgetUsd: this.opts.budgetUsd,
          pct,
          windowHours: this.opts.windowMs / 3600_000,
        },
        'daily budget exceeded; throttling all scrape calls',
      );
      return;
    }

    if (pct < 100 && this.tripped) {
      this.tripped = false;
      this.warnFired = pct >= this.opts.warnPct; // stay 'in WARN band' if applicable
      this.logger.info(
        {
          consumedUsd: consumed,
          budgetUsd: this.opts.budgetUsd,
          pct,
          windowHours: this.opts.windowMs / 3600_000,
        },
        'daily budget back below threshold; throttle released',
      );
      return;
    }

    if (!this.tripped && pct >= this.opts.warnPct && !this.warnFired) {
      this.warnFired = true;
      this.logger.warn(
        {
          consumedUsd: consumed,
          budgetUsd: this.opts.budgetUsd,
          pct,
          windowHours: this.opts.windowMs / 3600_000,
        },
        'daily budget warn',
      );
    } else if (pct < this.opts.warnPct) {
      this.warnFired = false;
    }
  }
}
