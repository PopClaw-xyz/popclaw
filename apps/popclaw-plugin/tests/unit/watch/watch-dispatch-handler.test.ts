import { describe, it, expect } from 'vitest';
import { WatchRegistry } from '../../../src/watch/watch-registry';
import { handleWatchDispatch } from '../../../src/watch/watch-dispatch-handler';

function envelopeWithPayload(payload: unknown) {
  return {
    eventId: 'evt-123',
    envelope: { watchDispatch: payload } as Record<string, unknown>,
  };
}

describe('handleWatchDispatch', () => {
  it('adds the watch slice to the registry with warm default state', () => {
    const registry = new WatchRegistry();
    const now = 1_000_000;
    handleWatchDispatch(
      envelopeWithPayload({
        watchId: 'w1',
        targetPopclawId: 'TargetA',
        platform: 'x',
        handle: 'blackfeather_ai',
      }),
      { registry, now: () => now },
    );
    const all = registry.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.watchId).toBe('w1');
    expect(all[0]!.handle).toBe('blackfeather_ai');
    expect(all[0]!.state.consecutiveHits).toBe(0);
    expect(all[0]!.state.consecutiveMisses).toBe(0);
    expect(all[0]!.nextPollAtMs).toBe(now + 5 * 60_000);
  });

  it('duplicate dispatch is idempotent', () => {
    const registry = new WatchRegistry();
    const now = 1_000_000;
    const env = envelopeWithPayload({
      watchId: 'w1',
      targetPopclawId: 'TargetA',
      platform: 'x',
      handle: 'blackfeather_ai',
    });
    handleWatchDispatch(env, { registry, now: () => now });
    handleWatchDispatch(env, { registry, now: () => now + 10 });
    expect(registry.all()).toHaveLength(1);
  });

  it('ignores malformed payload (no watch_id or target)', () => {
    const registry = new WatchRegistry();
    handleWatchDispatch(envelopeWithPayload({}), { registry, now: () => 0 });
    expect(registry.all()).toHaveLength(0);
  });

  it('ignores dispatch missing handle (older lore-house would 404 on scrape)', () => {
    const registry = new WatchRegistry();
    handleWatchDispatch(
      envelopeWithPayload({
        watchId: 'w1',
        targetPopclawId: 'TargetA',
        platform: 'x',
        // handle deliberately omitted
      }),
      { registry, now: () => 0 },
    );
    expect(registry.all()).toHaveLength(0);
  });
});

// Start from the House's timestamp of consent, never zero.
// Starting at zero would fetch the account's entire post history on the first poll, the mirroring-account behavior
// the owner explicitly forbade. The registry is in-memory, so every ranger restart would repeat that full fetch.
describe('watch start point', () => {
  function dispatchWith(since?: number | string) {
    const registry = new WatchRegistry();
    handleWatchDispatch(
      {
        envelope: {
          watchDispatch: {
            watchId: 'w1',
            targetPopclawId: 'TARGET',
            platform: 'x',
            handle: 'someone',
            ...(since === undefined ? {} : { since }),
          },
        },
      } as unknown as Parameters<typeof handleWatchDispatch>[0],
      { registry, now: () => 1_700_000_000_000 },
    );
    return registry.all()[0]!;
  }

  it('照灯坊给的那一刻起算', () => {
    expect(dispatchWith(1_690_000_000).state.lastSeenCreatedAt).toBe(1_690_000_000);
  });

  it('int64 以字符串回来也认', () => {
    expect(dispatchWith('1690000000').state.lastSeenCreatedAt).toBe(1_690_000_000);
  });

  it('老灯坊不给 since → 从此刻起算，绝不回灌', () => {
    const entry = dispatchWith(undefined);
    expect(entry.state.lastSeenCreatedAt).toBe(1_700_000_000);
    expect(entry.state.lastSeenCreatedAt).not.toBe(0);
  });
});
