import { describe, it, expect, vi } from 'vitest';
import { HeartbeatPublisher } from '../../../src/watch/heartbeat-publisher';
import { WatchRegistry, defaultEntry } from '../../../src/watch/watch-registry';

describe('HeartbeatPublisher', () => {
  it('emits one heartbeat per active watch on tick', async () => {
    const r = new WatchRegistry();
    r.add('wA', 'T1', 'T1', 'x', defaultEntry(0));
    r.add('wB', 'T2', 'T2', 'x', defaultEntry(0));
    const emit = vi.fn();

    const hb = new HeartbeatPublisher({
      registry: r,
      emit,
      now: () => 1000,
    });
    await hb.tick();
    expect(emit).toHaveBeenCalledTimes(2);
    const calls = emit.mock.calls.map((c) => (c[0] as { watchId: string }).watchId);
    expect(new Set(calls)).toEqual(new Set(['wA', 'wB']));
  });

  it('recent_hits is sampled from registry state', async () => {
    const r = new WatchRegistry();
    r.add('w1', 'T1', 'T1', 'x', {
      consecutiveHits: 4, consecutiveMisses: 0,
      lastSeenCreatedAt: 0, lastSeenPlatformPostId: '', nextPollAtMs: 0,
    });
    const emit = vi.fn();
    const hb = new HeartbeatPublisher({ registry: r, emit, now: () => 1000 });
    await hb.tick();
    expect(emit).toHaveBeenCalledTimes(1);
    const payload = emit.mock.calls[0]![0] as { recentHits: number };
    expect(payload.recentHits).toBe(4);
  });

  it('empty registry emits nothing', async () => {
    const r = new WatchRegistry();
    const emit = vi.fn();
    const hb = new HeartbeatPublisher({ registry: r, emit, now: () => 1000 });
    await hb.tick();
    expect(emit).not.toHaveBeenCalled();
  });

  it('emit error on one watch does not block others', async () => {
    const r = new WatchRegistry();
    r.add('wA', 'T1', 'T1', 'x', defaultEntry(0));
    r.add('wB', 'T2', 'T2', 'x', defaultEntry(0));
    const emit = vi.fn()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce(undefined);

    const hb = new HeartbeatPublisher({ registry: r, emit, now: () => 1000 });
    await hb.tick();
    expect(emit).toHaveBeenCalledTimes(2);
  });
});
