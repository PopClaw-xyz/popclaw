import {expect,it,vi} from 'vitest';
import {createLazyRuntime} from '../../../src/runtime/lazy-runtime.js';
function deferred<T>() {let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
it('stopping an unopened runtime never initializes it',async()=>{
  const build=vi.fn();const lifecycle=createLazyRuntime(build);
  await lifecycle.stop();expect(build).not.toHaveBeenCalled();await expect(lifecycle.get()).rejects.toThrow('STOPPED');
});
it('stop during initialization aborts late startup and waits through real shutdown',async()=>{
  const init=deferred<{shutdown:()=>Promise<void>}>();const drain=deferred<void>();let signal:AbortSignal|undefined;
  const shutdown=vi.fn(()=>drain.promise);
  const lifecycle=createLazyRuntime(s=>{signal=s;return init.promise;});
  const opening=lifecycle.get();await Promise.resolve();
  let stopped=false;const stop=lifecycle.stop().then(()=>{stopped=true;});
  expect(signal?.aborted).toBe(true);await Promise.resolve();expect(stopped).toBe(false);
  init.resolve({shutdown});await opening;await Promise.resolve();expect(shutdown).toHaveBeenCalledOnce();expect(stopped).toBe(false);
  drain.resolve();await stop;await lifecycle.stop();expect(shutdown).toHaveBeenCalledOnce();
});

it('cancels a requested runtime before its builder microtask, and both stop callers finish without construction', async () => {
  const build = vi.fn(async () => ({ shutdown: vi.fn(async () => {}) }));
  const lifecycle = createLazyRuntime(build);
  const opening = lifecycle.get().then(() => 'started', error => (error as Error).message);
  const first = lifecycle.stop();
  const second = lifecycle.stop();
  expect(first).toBe(second);
  await expect(first).resolves.toBeUndefined();
  expect(await opening).toBe('HOST_RUNTIME_STOPPED');
  expect(build).not.toHaveBeenCalled();
  await expect(lifecycle.get()).rejects.toThrow('HOST_RUNTIME_STOPPED');
});

it('does not mistake a failed ignited builder for cold cancellation', async () => {
  let fail!: (error: Error) => void;
  const init = new Promise<{ shutdown(): Promise<void> }>((_resolve, reject) => { fail = reject; });
  const build = vi.fn(() => init);
  const lifecycle = createLazyRuntime(build);
  const opening = lifecycle.get().catch(error => error);
  await Promise.resolve();
  expect(build).toHaveBeenCalledOnce();
  const stopping = lifecycle.stop();
  const stopped = expect(stopping).rejects.toThrow('BOOT_FAILED');
  fail(new Error('BOOT_FAILED'));
  await stopped;
  expect((await opening).message).toBe('BOOT_FAILED');
  expect(lifecycle.stop()).toBe(stopping);
});

it('a failed build can retry, and cancelling its unignited retry does not inherit the previous attempt', async () => {
  const build = vi.fn(async () => ({ shutdown: vi.fn(async () => {}) }));
  build.mockRejectedValueOnce(new Error('FIRST_BOOT_FAILED'));
  const lifecycle = createLazyRuntime(build);
  await expect(lifecycle.get()).rejects.toThrow('FIRST_BOOT_FAILED');
  const retry = lifecycle.get().catch(error => (error as Error).message);
  await expect(lifecycle.stop()).resolves.toBeUndefined();
  expect(await retry).toBe('HOST_RUNTIME_STOPPED');
  expect(build).toHaveBeenCalledOnce();
});

it('an ignited retry after failure still drains its own runtime exactly once', async () => {
  const init = deferred<{ shutdown(): Promise<void> }>();
  const drain = deferred<void>();
  const shutdown = vi.fn(() => drain.promise);
  const build = vi.fn(() => init.promise).mockRejectedValueOnce(new Error('FIRST_BOOT_FAILED'));
  const lifecycle = createLazyRuntime(build);
  await expect(lifecycle.get()).rejects.toThrow('FIRST_BOOT_FAILED');
  const retry = lifecycle.get();
  await Promise.resolve();
  expect(build).toHaveBeenCalledTimes(2);
  let stopped = false;
  const stopping = lifecycle.stop().then(() => { stopped = true; });
  init.resolve({ shutdown });
  await retry;
  await Promise.resolve();
  expect(shutdown).toHaveBeenCalledOnce();
  expect(stopped).toBe(false);
  drain.resolve();
  await stopping;
  expect(shutdown).toHaveBeenCalledOnce();
});
