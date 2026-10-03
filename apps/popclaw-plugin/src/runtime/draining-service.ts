/** A host service timer whose stop waits for the actual in-flight operation. */
export function createDrainingService(work: () => Promise<void>, onError: (error: unknown) => void, intervalMs: number) {
  let active = false;
  let generation = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let starting: Promise<void> | undefined;
  const once = (captured: number): Promise<void> => {
    if (!active || captured !== generation) return Promise.resolve();
    if (inFlight) return inFlight;
    const task = Promise.resolve().then(work).catch(onError).finally(() => {
      if (inFlight === task) inFlight = undefined;
    });
    inFlight = task;
    return task;
  };
  return {
    start(): Promise<void> {
      if (active) return starting ?? Promise.resolve();
      active = true;
      const captured = ++generation;
      starting = (async () => {
        await once(captured);
        if (!active || captured !== generation) return;
        timer = setInterval(() => { void once(captured); }, intervalMs);
        timer.unref?.();
      })();
      return starting;
    },
    async stop(): Promise<void> {
      active = false;
      generation += 1;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
