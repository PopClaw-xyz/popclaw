import { describe, expect, it } from 'vitest';
import { TokenBucket } from '../../../src/scraper/token-bucket.js';

/**
 * Use injected `now` + `sleep` so tests don't actually wait on real time.
 * `now` returns a mutable counter; `sleep(ms)` advances the counter and
 * resolves immediately.
 */
function fakeClock(initial = 0) {
  let t = initial;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('starts at full capacity', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 1, ...clock });
    expect(b.peek()).toBe(10);
  });

  it('take() decrements by one', async () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 1, ...clock });
    await b.take();
    expect(b.peek()).toBe(9);
  });

  it('refills one token per second up to cap', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 1, ...clock });
    for (let i = 0; i < 10; i++) {
      // drain the bucket by synthetically removing tokens via take() in a tight loop
      // but here just verify refill arithmetic:
    }
    // Drain
    (b as unknown as { tokens: number }).tokens = 0;
    clock.advance(3000);
    expect(b.peek()).toBe(3);
  });

  it('does not exceed capacity after long idle', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 1, ...clock });
    (b as unknown as { tokens: number }).tokens = 5;
    clock.advance(3_600_000); // 1 hour
    expect(b.peek()).toBe(10);
  });

  it('blocks when empty until refill', async () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, ...clock });
    // Drain
    await b.take();
    await b.take();
    expect(b.peek()).toBe(0);
    // take() should loop through the fake sleep until a token arrives
    await b.take();
    // The fake sleep has advanced the clock by ~1000 ms, granting 1 token
    // which was then immediately consumed.
    expect(b.peek()).toBeGreaterThanOrEqual(0);
  });

  it('refillPerSecond > 1 works (cap 10, 2/sec)', () => {
    const clock = fakeClock();
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 2, ...clock });
    (b as unknown as { tokens: number }).tokens = 0;
    clock.advance(1000); // 1 sec at 2/sec = 2 tokens
    expect(b.peek()).toBe(2);
  });
});
