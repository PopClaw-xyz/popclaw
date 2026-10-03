import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDeliveryFailure } from '../../../src/notifier/delivery-failure.js';

/** Issue #236: the note that turns "nothing is happening" into a reason. */
describe('fileDeliveryFailure', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'popclaw-df-')), 'notify-delivery-failure.json');

  it('remembers the failure and forgets it once delivery works again', () => {
    const s = fileDeliveryFailure(file());
    expect(s.get()).toBeNull();
    s.set({ at: 1753711800, reason: 'sendMessage ret=-2 errmsg=prepare failed' });
    expect(s.get()).toEqual({ at: 1753711800, reason: 'sendMessage ret=-2 errmsg=prepare failed' });
    // A recovered channel must not leave the owner staring at a stale worry.
    s.clear();
    expect(s.get()).toBeNull();
  });

  it('caps the reason — a channel error can be a whole stack, this is one status line', () => {
    const s = fileDeliveryFailure(file());
    s.set({ at: 1, reason: 'x'.repeat(500) });
    expect(s.get()!.reason.length).toBeLessThanOrEqual(160);
  });

  it('an unreadable or absent note reads as "nothing to report", never a throw', () => {
    // Failing to record a failure must not become a second failure.
    expect(fileDeliveryFailure('/nonexistent/dir/that/does/not/exist.json').get()).toBeNull();
    expect(() =>
      fileDeliveryFailure('/nonexistent/dir/that/does/not/exist.json').set({ at: 1, reason: 'x' }),
    ).not.toThrow();
  });
});
