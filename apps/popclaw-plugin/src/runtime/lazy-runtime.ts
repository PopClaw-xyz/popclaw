/** Lazy initialization and shutdown share the same in-flight runtime promise. */
export function createLazyRuntime<T extends { shutdown(): Promise<void> }>(build: (signal: AbortSignal) => Promise<T>) {
  const closing = new AbortController();
  let pending: Promise<T> | undefined;
  let stopping: Promise<void> | undefined;
  return {
    get(): Promise<T> {
      if (closing.signal.aborted) return Promise.reject(new Error('HOST_RUNTIME_STOPPED'));
      if (pending) return pending;
      const task = Promise.resolve().then(() => build(closing.signal)).catch(error => {
        if (pending === task && !closing.signal.aborted) pending = undefined;
        throw error;
      });
      pending = task;
      return task;
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      closing.abort();
      const started = pending;
      stopping = (async () => {
        if (!started) return;
        const runtime = await started;
        await runtime.shutdown();
      })();
      return stopping;
    },
  };
}
