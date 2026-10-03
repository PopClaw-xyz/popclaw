import { describe, it, expect } from 'vitest';
import { WatchRegistry, defaultEntry } from '../../../src/watch/watch-registry';
import { handleWatchCancel } from '../../../src/watch/watch-cancel-handler';

describe('handleWatchCancel', () => {
  it('removes the slice matching watch_id', () => {
    const r = new WatchRegistry();
    r.add('w1', 'T1', 'T1', 'x', defaultEntry(0));
    handleWatchCancel(
      { eventId: 'e', envelope: { watchCancel: { watchId: 'w1', reason: 'reassigned' } } },
      { registry: r },
    );
    expect(r.all()).toHaveLength(0);
  });

  it('unknown watch_id is a no-op', () => {
    const r = new WatchRegistry();
    r.add('w1', 'T1', 'T1', 'x', defaultEntry(0));
    handleWatchCancel(
      { eventId: 'e', envelope: { watchCancel: { watchId: 'wUnknown', reason: 'x' } } },
      { registry: r },
    );
    expect(r.all()).toHaveLength(1);
  });
});
