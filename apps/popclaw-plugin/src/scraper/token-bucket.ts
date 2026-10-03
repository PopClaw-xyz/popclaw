/**
 * Simple token bucket. Callers `await bucket.take()` before each
 * outbound request; if no tokens are available, the call resolves
 * as soon as one refills.
 *
 * Per spec §7.5: capacity 10, refill 1/sec. Matches Scope B's
 * "don't exceed ~30 req/min" budget with burst headroom.
 */

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillPerSecond: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable sleep for tests. Defaults to `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class TokenBucket {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private lastRefillAt: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.capacity;
    this.tokens = opts.capacity;
    this.refillIntervalMs = 1000 / opts.refillPerSecond;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.lastRefillAt = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefillAt;
    const grant = Math.floor(elapsed / this.refillIntervalMs);
    if (grant > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + grant);
      this.lastRefillAt = this.lastRefillAt + grant * this.refillIntervalMs;
    }
  }

  async take(): Promise<void> {
    this.refill();
    while (this.tokens <= 0) {
      const waitMs = Math.max(
        1,
        this.refillIntervalMs - (this.now() - this.lastRefillAt),
      );
      await this.sleep(waitMs);
      this.refill();
    }
    this.tokens -= 1;
  }

  /** For tests/observability: current token count after a manual refill. */
  peek(): number {
    this.refill();
    return this.tokens;
  }
}
