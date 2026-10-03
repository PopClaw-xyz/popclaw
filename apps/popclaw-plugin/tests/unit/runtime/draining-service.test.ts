import {afterEach, expect, it, vi} from 'vitest';
import {createDrainingService} from '../../../src/runtime/draining-service.js';
function deferred() {let resolve!:()=>void; const promise = new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
afterEach(() => vi.useRealTimers());
it('stop waits through the real operation and forbids late timer installation', async () => {
  vi.useFakeTimers(); const delivery = deferred(); let receipt = false;
  const work = vi.fn(async () => {await delivery.promise; receipt = true;});
  const service = createDrainingService(work, vi.fn(), 5000);
  const starting = service.start(); await Promise.resolve();
  let stopped = false; const stop = service.stop().then(() => {stopped = true;});
  await Promise.resolve(); expect(stopped).toBe(false); expect(receipt).toBe(false);
  delivery.resolve(); await Promise.all([starting,stop]);
  expect(receipt).toBe(true); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(15000); expect(work).toHaveBeenCalledOnce();
});
it('does not overlap timer work and drains a later tick', async () => {
  vi.useFakeTimers(); const delivery = deferred(); const work = vi.fn().mockResolvedValueOnce(undefined).mockImplementation(() => delivery.promise);
  const service = createDrainingService(work, vi.fn(), 5000);
  await service.start(); await service.start();
  await vi.advanceTimersByTimeAsync(15000); expect(work).toHaveBeenCalledTimes(2);
  let stopped = false; const stop = service.stop().then(() => {stopped = true;});
  await Promise.resolve(); expect(stopped).toBe(false);
  delivery.resolve(); await stop; expect(vi.getTimerCount()).toBe(0);
});
