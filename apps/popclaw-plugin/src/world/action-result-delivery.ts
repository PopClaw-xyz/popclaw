import type { WorldActionClient, WorldActionGate } from './action-client.js';

export interface WorldActionResultDeliveryOptions {
  client: Pick<WorldActionClient, 'bindConsumerGate' | 'onPending' | 'hasPending' | 'drainPending'>;
  gate: WorldActionGate; retryMs?: number; onError?(error: unknown): void;
}
/** G0 starts this resource with drain(), fences synchronously with stop(), then
 * awaits whenIdle() before closing its DB. One timer exists only while durable
 * eligible original-accounting obligations remain pending. No status read or action is sent. */
export function createWorldActionResultDelivery(options: WorldActionResultDeliveryOptions) {
  const { client, gate: parentGate } = options, retryMs = options.retryMs ?? 1000;
  if (!Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 60000) throw new Error('RESULT_RETRY_INTERVAL_INVALID');
  let started = false, stopped = false;
  const localStop = new AbortController();
  const gate: WorldActionGate = { origin: parentGate.origin, signal: AbortSignal.any([parentGate.signal, localStop.signal]),
    isActive: () => !stopped && !localStop.signal.aborted && !parentGate.signal.aborted && parentGate.isActive() };
  client.bindConsumerGate(gate);
  let running: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  const active = () => !stopped && !gate.signal.aborted && gate.isActive();
  const report = (error: unknown) => { try { options.onError?.(error); } catch { /* Reporting cannot reactivate a resource. */ } };
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const schedule = () => {
    if (!started || !active() || timer || running) return;
    try { if (!client.hasPending()) return; } catch (error) { report(error); return; }
    timer = setTimeout(() => { timer = null; void drain(); }, retryMs);
  };
  const drain = (): Promise<void> => {
    if (!active()) return Promise.resolve();
    started = true; clear();
    if (running) return running;
    // Assign single-flight before invoking consumer code that can reenter.
    const pass = Promise.resolve().then(async () => {
      if (active()) await client.drainPending(gate);
    }).catch(report);
    running = pass;
    void pass.finally(() => { if (running === pass) running = null; schedule(); });
    return pass;
  };
  const unsubscribe = client.onPending(() => { if (started && active()) void drain(); });
  const stop = () => { stopped = true; localStop.abort(); clear(); unsubscribe(); parentGate.signal.removeEventListener('abort', stop); };
  parentGate.signal.addEventListener('abort', stop, { once: true });
  if (gate.signal.aborted) stop();
  return { drain, stop, whenIdle: () => running ?? Promise.resolve() };
}
