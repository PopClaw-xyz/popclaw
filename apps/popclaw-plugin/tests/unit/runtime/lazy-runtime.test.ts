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
