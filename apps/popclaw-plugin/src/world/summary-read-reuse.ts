import type { ReadRequestScope } from '../runtime/read-request-scope.js';
import type { WorldSummaryResult } from './world-summary-client.js';

interface SummaryReadClient {
  captureReadGeneration?(): ReadRequestScope | undefined;
}
interface ReadAttempt {
  readonly generation: ReadRequestScope;
  readonly result: Promise<WorldSummaryResult>;
}
const stale = (): WorldSummaryResult => ({ ok: false, failure: { code: 'HOUSE_ACTION_STALE' } });

/** Registration-local failure reuse; both owner input and House generation must be proven. */
export class SummaryReadReuse {
  private readonly requests = new WeakMap<object, WeakMap<object, WeakMap<object, Map<number, ReadAttempt>>>>();

  async read(scope: ReadRequestScope | undefined, client: SummaryReadClient, windowHours: number, retry: boolean,
    work: () => Promise<WorldSummaryResult>, generation = client.captureReadGeneration?.()): Promise<WorldSummaryResult> {
    const current = () => (!scope || scope.isCurrent()) && (!generation || generation.isCurrent());
    if (!current()) return stale();
    // Unknown request or connection identities disable reuse, not completion fencing.
    if (!scope?.requestToken || !generation) {
      const result = await work();
      return current() ? result : stale();
    }
    let clients = this.requests.get(scope.requestToken);
    if (!clients) { clients = new WeakMap(); this.requests.set(scope.requestToken, clients); }
    let generations = clients.get(client);
    if (!generations) { generations = new WeakMap(); clients.set(client, generations); }
    let windows = generations.get(generation.token);
    if (!windows) { windows = new Map(); generations.set(generation.token, windows); }
    const previous = windows.get(windowHours);
    // An original gate can expire before the manager rotates its signal. Check
    // that captured gate as well as the current capture before reusing anything.
    if (previous && !retry && previous.generation.isCurrent()) {
      const result = await previous.result;
      if (!current() || !previous.generation.isCurrent()) return stale();
      return result.ok ? result : { ...result, reused: true };
    }
    const pending = Promise.resolve().then(work);
    const attempt = { generation, result: pending };
    windows.set(windowHours, attempt);
    try {
      const result = await pending;
      if (result.ok || !result.failure.code.startsWith('HOUSE_REMOTE_') || !current()) {
        if (windows.get(windowHours) === attempt) windows.delete(windowHours);
      }
      return current() ? result : stale();
    } catch (error) {
      if (windows.get(windowHours) === attempt) windows.delete(windowHours);
      throw error;
    }
  }
}
