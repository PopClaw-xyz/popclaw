import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorldActionResultDelivery } from '../../../src/world/action-result-delivery.js';
function fixture() {
  vi.useFakeTimers(); const abort = new AbortController(); let pending = true;
  const listeners = new Set<() => void>();
  const client = { bindConsumerGate: vi.fn(), onPending: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    hasPending: vi.fn(() => pending), drainPending: vi.fn(async () => {}) };
  const gate = { origin: 'https://world.invalid', signal: abort.signal, isActive: () => !abort.signal.aborted };
  const delivery = createWorldActionResultDelivery({ client, gate, retryMs: 10 });
  return { client, gate, delivery, listeners, abort, complete: () => { pending = false; } };
}
afterEach(() => { vi.useRealTimers(); });
describe('durable action result delivery lifecycle', () => {
  it('starts only explicitly, retries pending consumers once per timer, and stops polling after ACK', async () => {
    const f = fixture(); for (const cb of f.listeners) cb(); await vi.advanceTimersByTimeAsync(100); expect(f.client.drainPending).not.toHaveBeenCalled();
    await f.delivery.drain(); expect(f.client.drainPending).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10); expect(f.client.drainPending).toHaveBeenCalledTimes(2);
    f.complete(); await vi.advanceTimersByTimeAsync(10); expect(vi.getTimerCount()).toBe(0);
    f.delivery.stop();
  });
  it('coalesces notifications and joins existing work after synchronous stop', async () => {
    const f = fixture(); let release!: () => void;
    f.client.drainPending.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    const pass = f.delivery.drain(); await Promise.resolve();
    for (const cb of f.listeners) { cb(); cb(); }
    expect(f.client.drainPending).toHaveBeenCalledOnce(); expect(f.delivery.drain()).toBe(pass);
    f.delivery.stop(); expect(f.client.bindConsumerGate.mock.calls[0]![0].signal.aborted).toBe(true); expect(f.gate.signal.aborted).toBe(false); expect(f.listeners.size).toBe(0); let idle = false; void f.delivery.whenIdle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle).toBe(false); release(); await pass;
    expect(vi.getTimerCount()).toBe(0); await f.delivery.drain(); expect(f.client.drainPending).toHaveBeenCalledOnce();
  });
  it('business gate abort prevents status persistence notification from waking consumers', async () => {
    const f = fixture(); await f.delivery.drain(); f.abort.abort();
    for (const cb of f.listeners) cb(); await vi.advanceTimersByTimeAsync(100);
    expect(f.client.drainPending).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('survives consumer errors and allows stop inside a callback without deadlock', async () => {
    const f = fixture(); f.client.drainPending.mockRejectedValueOnce(new Error('retry'));
    await f.delivery.drain(); expect(vi.getTimerCount()).toBe(1);
    f.client.drainPending.mockImplementation(async () => { f.delivery.stop(); });
    await vi.advanceTimersByTimeAsync(10); await f.delivery.whenIdle(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('split receipt retry eligibility', () => {
  it('does not poll permanently invalid, unsupported, blocked or unselected obligations', async () => {
    const f = fixture(); f.complete(); await f.delivery.drain();
    expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(1000); expect(f.client.drainPending).toHaveBeenCalledOnce(); f.delivery.stop();
  });
  it('does not create a hot timer when ledger eligibility is corrupt', async () => {
    const f = fixture(); f.client.hasPending.mockImplementation(()=>{throw new Error('unsupported profile');});
    await f.delivery.drain(); expect(vi.getTimerCount()).toBe(0); f.delivery.stop();
  });
});
