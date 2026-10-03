import { describe, it, expect } from 'vitest';
import {
  WatchRegistry,
  Tier,
  defaultEntry,
  nextPollAt,
  resolvePlatformFloors,
  transitionAfterPoll,
} from '../../../src/watch/watch-registry';

const base = new Date('2026-04-24T00:00:00Z').getTime();

describe('WatchRegistry', () => {
  it('adds then lists', () => {
    const r = new WatchRegistry();
    r.add('w1', 'T1', 'T1', 'x', defaultEntry(base));
    expect(r.all()).toHaveLength(1);
    expect(r.all()[0]!.watchId).toBe('w1');
  });

  it('remove by watch id', () => {
    const r = new WatchRegistry();
    r.add('w1', 'T1', 'T1', 'x', defaultEntry(base));
    r.remove('w1');
    expect(r.all()).toHaveLength(0);
  });

  it('re-dispatch of a watch we already hold keeps its tier state and schedule', () => {
    // The ranger re-registers after every SSE reconnect and the lore-house
    // re-emits WatchDispatch for every pinned watch. On 2026-09-02 that
    // happened once a minute: every add() reseeded WARM with nextPollAt 5 min
    // out, so nothing was ever due and the feed stalled (0 scrapes/10 min).
    const r = new WatchRegistry();
    r.add('w1', 'T1', 'T1', 'x', defaultEntry(base));
    for (let i = 0; i < 6; i++) r.updateAfterPoll('w1', false, 0, base); // → COLD
    const before = r.all()[0]!;
    expect(before.state.consecutiveMisses).toBe(6);
    r.add('w1', 'T1', 'T1', 'x', defaultEntry(base + 60_000));
    const after = r.all()[0]!;
    expect(after.state.consecutiveMisses).toBe(6);
    expect(after.nextPollAtMs).toBe(before.nextPollAtMs);
    expect(r.all()).toHaveLength(1);
  });

  it('re-dispatch still refreshes handle/target metadata', () => {
    const r = new WatchRegistry();
    r.add('w1', 'T1', 'old_handle', 'x', defaultEntry(base));
    r.add('w1', 'T1', 'new_handle', 'x', defaultEntry(base));
    expect(r.all()[0]!.handle).toBe('new_handle');
  });
});

describe('nextPollAt', () => {
  it('warm by default', () => {
    expect(nextPollAt({ consecutiveHits: 0, consecutiveMisses: 0, lastSeenCreatedAt: 0, lastSeenPlatformPostId: '' }, base))
      .toBe(base + 5 * 60_000);
  });
  it('hot when hits >= 3', () => {
    expect(nextPollAt({ consecutiveHits: 3, consecutiveMisses: 0, lastSeenCreatedAt: 0, lastSeenPlatformPostId: '' }, base))
      .toBe(base + 30_000);
  });
  it('sleep when misses >= 20', () => {
    expect(nextPollAt({ consecutiveHits: 0, consecutiveMisses: 20, lastSeenCreatedAt: 0, lastSeenPlatformPostId: '' }, base))
      .toBe(base + 24 * 60 * 60_000);
  });
  it('cold when misses >= 5 but < 20', () => {
    expect(nextPollAt({ consecutiveHits: 0, consecutiveMisses: 5, lastSeenCreatedAt: 0, lastSeenPlatformPostId: '' }, base))
      .toBe(base + 60 * 60_000);
  });
});

describe('transitionAfterPoll', () => {
  it('hit zeroes misses and increments hits', () => {
    const next = transitionAfterPoll(
      { consecutiveHits: 2, consecutiveMisses: 3, lastSeenCreatedAt: 100, lastSeenPlatformPostId: 'p9' },
      true,
      200,
    );
    expect(next).toEqual({ consecutiveHits: 3, consecutiveMisses: 0, lastSeenCreatedAt: 200, lastSeenPlatformPostId: 'p9' });
  });
  it('miss zeroes hits and increments misses', () => {
    const next = transitionAfterPoll(
      { consecutiveHits: 2, consecutiveMisses: 3, lastSeenCreatedAt: 100, lastSeenPlatformPostId: 'p9' },
      false,
      100,
    );
    expect(next).toEqual({ consecutiveHits: 0, consecutiveMisses: 4, lastSeenCreatedAt: 100, lastSeenPlatformPostId: 'p9' });
  });
});

describe('Tier enum', () => {
  it('values', () => {
    expect(Tier.HOT).toBe('hot');
    expect(Tier.WARM).toBe('warm');
    expect(Tier.COLD).toBe('cold');
    expect(Tier.SLEEP).toBe('sleep');
  });
});

describe('per-platform poll floor', () => {
  // Apify bills the Instagram actor per run (~$0.011 measured 2026-09-02),
  // not per result: 11 accounts x hourly COLD polls = $3/day for ~10 posts.
  // The tier machine alone cannot express "never poll IG faster than 4h".
  it('instagram never polls faster than 4h even when HOT', () => {
    const r = new WatchRegistry();
    r.add('ig', 'T1', 'T1', 'instagram', defaultEntry(base));
    for (let i = 0; i < 3; i++) r.updateAfterPoll('ig', true, 100 + i, base);
    expect(r.all()[0]!.state.consecutiveHits).toBe(3); // HOT
    expect(r.all()[0]!.nextPollAtMs - base).toBe(4 * 60 * 60_000);
  });

  it('x keeps the bare tier interval', () => {
    const r = new WatchRegistry();
    r.add('x1', 'T1', 'T1', 'x', defaultEntry(base));
    for (let i = 0; i < 3; i++) r.updateAfterPoll('x1', true, 100 + i, base);
    expect(r.all()[0]!.nextPollAtMs - base).toBe(30_000);
  });
});

describe('per-platform poll floor: edges', () => {
  it('floor lookup canonicalizes the platform string (a real dispatch once carried "X")', () => {
    const r = new WatchRegistry();
    r.add('ig', 'T1', 'T1', 'Instagram', defaultEntry(base));
    r.updateAfterPoll('ig', false, 0, base);
    expect(r.all()[0]!.nextPollAtMs - base).toBe(4 * 60 * 60_000);
  });

  it('a freshly registered instagram watch is seeded at the floor, not WARM', () => {
    // reemit_for_ranger re-dispatches every watch on each SSE reconnect and
    // add() overwrites nextPollAtMs — an unfloored seed = one billed run per
    // IG account per reconnect.
    expect(defaultEntry(base, undefined, 'instagram').nextPollAtMs - base).toBe(4 * 60 * 60_000);
    expect(defaultEntry(base, undefined, 'x').nextPollAtMs - base).toBe(5 * 60_000);
    expect(defaultEntry(base).nextPollAtMs - base).toBe(5 * 60_000);
  });

  it('env override ignores non-numeric values instead of producing a NaN schedule', () => {
    // NaN nextPollAtMs would make due() false forever — the watch silently dies.
    expect(resolvePlatformFloors('{"instagram":"4h","tiktok":7200000}')).toEqual({
      instagram: 4 * 60 * 60_000,
      tiktok: 7_200_000,
    });
    expect(resolvePlatformFloors('not json')).toEqual({ instagram: 4 * 60 * 60_000 });
    expect(resolvePlatformFloors(undefined)).toEqual({ instagram: 4 * 60 * 60_000 });
  });
});
