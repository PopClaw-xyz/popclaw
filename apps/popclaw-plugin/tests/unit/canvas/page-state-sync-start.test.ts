/**
 * `startPageStateSync` — the shared starter every resident root calls.
 *
 * The leg nothing else replaces: the canvas cannot ask a house which of the
 * people on a page this reader follows, so a root that does not answer is a
 * root whose published pages carry chips that never colour, with nothing
 * anywhere to say why.
 */
import { describe, it, expect } from 'vitest';
import {
  startPageStateSync,
  PAGE_STATE_TICK_MS,
  type SyncAnswerClient,
} from '../../../src/canvas/sync-answer-client.js';
import { createViewingSignal } from '../../../src/canvas/viewing-signal.js';
import type { Signer } from '../../../src/identity/signer.js';

/** Never reached: every test injects a client, the only signing user. */
const signer = { popclawId: async () => 'self', sign: async () => new Uint8Array() } as unknown as Signer;

function harness(client: SyncAnswerClient, baseUrl: string | null = 'https://canvas.invalid') {
  const info: string[] = [];
  return {
    info,
    deps: {
      baseUrl,
      signer,
      stateOf: () => 'none' as const,
      client,
      logger: { info: (m: string) => void info.push(m) },
    },
  };
}

describe('startPageStateSync', () => {
  it('answers on the very first tick, without waiting out an interval', async () => {
    let calls = 0;
    const h = harness({ answerPending: async () => { calls += 1; return 2; } });
    const loop = startPageStateSync(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(calls).toBe(1);
    // Answered counts are logged, not discarded: without this line there is no
    // way to tell a working leg from a dead one, since both look like grey chips.
    expect(h.info.join('\n')).toContain('answered 2 page-state question(s)');
  });

  it('with no publisher it never asks, and says so once', async () => {
    let calls = 0;
    const h = harness({ answerPending: async () => { calls += 1; return 0; } }, null);
    const loop = startPageStateSync(h.deps);
    await loop.firstTick;
    loop.stop();
    expect(calls).toBe(0);
    expect(h.info.join('\n')).toContain('no publisher configured');
  });

  it('a failing tick is non-fatal, logged at info, and backs the next one off', async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    // The reschedule delay is the only observable of the backoff, so it is
    // read off the timer this loop actually sets.
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    try {
      const h = harness({ answerPending: async () => { throw new Error('canvas down'); } });
      const loop = startPageStateSync({ ...h.deps, intervalMs: 1000, maxBackoffMs: 8000 });
      await expect(loop.firstTick).resolves.toBeUndefined();
      loop.stop();
      expect(delays).toEqual([2000]); // one failure → one doubling
      expect(h.info.join('\n')).toContain('page-state sync tick failed');
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = real;
    }
  });

  it('an accepted answer is recorded on the viewing signal — the doorbell paces off it', async () => {
    // An answer only exists because a paired browser of THIS identity opened a
    // paper, which is the one piece of evidence in this process that the
    // identity about to click ➕ is this one.
    const viewing = createViewingSignal(() => 1_750_000_000_000);
    const h = harness({ answerPending: async () => 2 });
    const loop = startPageStateSync({ ...h.deps, viewing });
    await loop.firstTick;
    loop.stop();
    expect(viewing.lastAnswerAtMs()).toBe(1_750_000_000_000);
  });

  it('nothing to answer means nothing to record: no answers, no viewing signal', async () => {
    const viewing = createViewingSignal(() => 1_750_000_000_000);
    const h = harness({ answerPending: async () => 0 });
    const loop = startPageStateSync({ ...h.deps, viewing });
    await loop.firstTick;
    loop.stop();
    expect(viewing.lastAnswerAtMs()).toBeNull();
  });

  it('a flat minute is the cadence, not an adaptive one', () => {
    // Pinned because the reasoning is easy to "improve" away: there is no push
    // channel from the canvas, so an adaptive cadence could only be fast AFTER
    // the first page of a reading session — the one it needs to be fast for.
    expect(PAGE_STATE_TICK_MS).toBe(60_000);
  });
});
