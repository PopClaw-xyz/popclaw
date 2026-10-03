import { describe, it, expect } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';

describe('InMemoryHostAdapter', () => {
  it('storage roundtrips bytes', async () => {
    const h = new InMemoryHostAdapter();
    await h.storage.write('identity', 'master.key', new Uint8Array([1, 2, 3]));
    const got = await h.storage.read('identity', 'master.key');
    expect(got).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('storage lists by prefix, sorted', async () => {
    const h = new InMemoryHostAdapter();
    await h.storage.write('cache', 'a.json', new Uint8Array());
    await h.storage.write('cache', 'b.json', new Uint8Array());
    await h.storage.write('cache', 'other', new Uint8Array());
    expect(await h.storage.list('cache', 'a')).toEqual(['a.json']);
    expect(await h.storage.list('cache')).toEqual(['a.json', 'b.json', 'other']);
  });

  it('timer schedules and cancels', () => {
    const h = new InMemoryHostAdapter();
    let fired = 0;
    h.timer.schedule(100, () => fired++);
    h.timer.schedule(50, () => fired++).cancel();
    h.timer.flush(200);
    expect(fired).toBe(1);
  });

  it('clock can be advanced', () => {
    const base = new Date('2026-04-21T00:00:00Z');
    const h = new InMemoryHostAdapter({ now: base });
    expect(h.clock.now().toISOString()).toBe(base.toISOString());
    h.clock.advance(5_000);
    expect(h.clock.now().getTime() - base.getTime()).toBe(5_000);
  });
});
