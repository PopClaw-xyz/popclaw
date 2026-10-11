import type { ReadRequestScope } from '../runtime/read-request-scope.js';
import type { WorldSummaryResult } from './world-summary-client.js';

/** Registration-local, request-local failed-read reuse. No TTL or last-session fallback. */
export class SummaryReadReuse {
  private readonly requests = new WeakMap<object, WeakMap<object, Map<number, Promise<WorldSummaryResult>>>>();

  async read(scope: ReadRequestScope | undefined, client: object, windowHours: number, retry: boolean,
    work: () => Promise<WorldSummaryResult>): Promise<WorldSummaryResult> {
    if (scope && !scope.isCurrent()) return {ok:false,failure:{code:'HOUSE_ACTION_STALE'}};
    if (!scope?.requestToken) return work();
    const token = scope.requestToken;
    let clients = this.requests.get(token);
    if (!clients) { clients = new WeakMap(); this.requests.set(token, clients); }
    let windows = clients.get(client);
    if (!windows) { windows = new Map(); clients.set(client, windows); }
    const previous = windows.get(windowHours);
    if (previous && !retry) {
      const result = await previous;
      if (!scope.isCurrent()) return {ok:false,failure:{code:'HOUSE_ACTION_STALE'}};
      return result.ok ? result : {...result,reused:true};
    }
    const pending = Promise.resolve().then(work);
    windows.set(windowHours,pending);
    try {
      const result = await pending;
      // Fresh successful reads remain fresh; only remote failures survive this call.
      if (result.ok || !result.failure.code.startsWith('HOUSE_REMOTE_') || !scope.isCurrent()) {
        if (windows.get(windowHours) === pending) windows.delete(windowHours);
      }
      if (!scope.isCurrent()) return {ok:false,failure:{code:'HOUSE_ACTION_STALE'}};
      return result;
    } catch (error) {
      if (windows.get(windowHours) === pending) windows.delete(windowHours);
      throw error;
    }
  }
}
