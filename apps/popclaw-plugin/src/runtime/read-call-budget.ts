/** Waiting policy for bounded reads. This scope never grants House authority. */
import { createHostAsyncScope } from '../host/local-host-adapter.js';
import { ActionInactiveError, currentActionSignal, assertActionActive, captureActionContext } from './house-lifecycle/action-context.js';
import { RemoteHouseReadError } from './house-lifecycle/read-failure.js';
export class ReadCallBudgetExceeded extends RemoteHouseReadError {
  readonly code = 'READ_CALL_BUDGET_EXCEEDED';
}
export interface ReadCallBudgetOptions { timeoutMs?: number; deadlineAtMs?: number; signal?: AbortSignal }
export interface ReadCallBudget {
  readonly deadlineAtMs: number; readonly signal: AbortSignal;
  remainingMs(): number; assertActive(): void;
}
const budgets = createHostAsyncScope<ReadCallBudget | undefined>();
export const currentReadCallBudget = (): ReadCallBudget | undefined => budgets.getStore();
export const assertReadCallActive = (): void => currentReadCallBudget()?.assertActive();
export function waitForRead<T>(work: Promise<T>, budget = currentReadCallBudget()): Promise<T> {
  if (!budget) return work;
  return new Promise<T>((resolve, reject) => {
    const fail = () => { cleanup(); try { budget.assertActive(); reject(budget.signal.reason ?? new ActionInactiveError()); } catch (error) { reject(error); } };
    const cleanup = () => budget.signal.removeEventListener('abort', fail);
    budget.signal.addEventListener('abort', fail, { once: true });
    work.then(value => { cleanup(); try { budget.assertActive(); resolve(value); } catch (error) { reject(error); } }, error => { cleanup(); reject(error); });
    if (budget.signal.aborted) fail();
  });
}
export async function withReadCallBudget<T>(options: ReadCallBudgetOptions, work: () => Promise<T>): Promise<T> {
  const parent = currentReadCallBudget(), started = Date.now(), actionSignal = currentActionSignal();
  const assertCapturedAction=captureActionContext(() => assertActionActive());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const deadlineAtMs = Math.min(started + timeoutMs, options.deadlineAtMs ?? Infinity, parent?.deadlineAtMs ?? Infinity);
  const controller = new AbortController();
  const signals = [controller.signal, parent?.signal, options.signal, actionSignal].filter((s): s is AbortSignal => !!s);
  const signal = AbortSignal.any(signals);
  let ended = false;
  const budget: ReadCallBudget = { deadlineAtMs, signal, remainingMs: () => Math.max(0, deadlineAtMs - Date.now()),
    assertActive() {
      assertCapturedAction();
      if (parent?.signal.aborted) parent.assertActive();
      if (options.signal?.aborted || actionSignal?.aborted) throw new ActionInactiveError();
      if (Date.now() >= deadlineAtMs || controller.signal.aborted && !ended) throw new ReadCallBudgetExceeded({
        code:'HOUSE_REMOTE_TIMEOUT', diagnostic:{budget:'read-call',phase:'before-fetch',cause:'timeout',cancellation:'deadline',timeoutMs:Math.max(0,deadlineAtMs-started),elapsedMs:Date.now()-started},
      });
      if (ended) throw new ActionInactiveError();
    },
  };
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAtMs-started));
  try { return await budgets.run(budget, () => { budget.assertActive(); return waitForRead(Promise.resolve().then(work), budget); }); }
  finally { clearTimeout(timer); ended = true; controller.abort(); }
}
/** Preserve transport gates while adding the current wait policy. */
export function budgetedFetch(fetchFn: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const budget = currentReadCallBudget();
    if (!budget) return fetchFn(input, init);
    budget.assertActive();
    return waitForRead(fetchFn(input, {...init, signal: init?.signal ? AbortSignal.any([init.signal,budget.signal]) : budget.signal}), budget);
  };
}

/** Internal shared-guide producer: its live waiters own cancellation collectively.
 * Source/action checks remain captured by the producer; no waiter deadline is inherited. */
export function withSharedReadProducer<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return budgets.run(undefined, () => withReadCallBudget({signal},work));
}
