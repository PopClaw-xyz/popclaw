/** Lazy initialization and shutdown share the same in-flight runtime promise. */
export function createLazyRuntime<T extends { shutdown(): Promise<void> }>(build: (signal: AbortSignal) => Promise<T>) {
  const closing = new AbortController();
  let pending: { task: Promise<T>; construction: { started: boolean } } | undefined;
  let stopping: Promise<void> | undefined;
  return {
    get(): Promise<T> {
      if (closing.signal.aborted) return Promise.reject(new Error('HOST_RUNTIME_STOPPED'));
      if (pending) return pending.task;
      const construction = { started: false };
      const task = Promise.resolve().then(() => {
        if (closing.signal.aborted) throw new Error('HOST_RUNTIME_STOPPED');
        construction.started = true;
        return build(closing.signal);
      }).catch(error => {
        if (pending?.task === task && !closing.signal.aborted) pending = undefined;
        throw error;
      });
      pending = { task, construction };
      return task;
    },
    stop(): Promise<void> {
      if (stopping) return stopping;
      closing.abort();
      const started = pending;
      stopping = (async () => {
        if (!started) return;
        let runtime: T;
        try { runtime = await started.task; }
        catch (error) {
          // Nothing was constructed: cancellation is not a failed cleanup.
          // Once build entered, its failure must still reach every stop caller.
          if (!started.construction.started && closing.signal.aborted) return;
          throw error;
        }
        await runtime.shutdown();
      })();
      return stopping;
    },
  };
}
