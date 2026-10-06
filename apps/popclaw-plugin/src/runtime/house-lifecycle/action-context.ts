import { getOrCreatePerProcess } from '../once.js';
import { createHostAsyncScope } from '../../host/local-host-adapter.js';
import type { HouseReadFailureCode } from './read-failure.js';
import type { HouseGate } from './manager.js';
import type { Signer } from '../../identity/signer.js';
import { signEnvelope, type SignEnvelopeResult } from '../../identity/sign-envelope.js';

export type ActionGate = Pick<HouseGate, 'isActive' | 'signal'> & {readonly origin?: string; inactiveReason?(): HouseReadFailureCode};

/** Root signers preserve synchronous crypto methods and guard each private-key
 * operation under the caller's captured action, including async completion. */
export function actionSigner(signer: Signer): Signer {
  return new Proxy(signer, {get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== 'function') return value;
    if (!['sign', 'sealDm', 'sealDmMedia'].includes(String(property))) return value.bind(target);
    return (...args: unknown[]) => {
      assertActionActive();
      const result: unknown = value.apply(target, args);
      if (property === 'sign') return Promise.resolve(result).then(signed => {assertActionActive();return signed;});
      assertActionActive();
      return result;
    };
  }});
}

export function currentActionSignal(): AbortSignal | undefined { return actions.getStore()?.signal; }

const actions = createHostAsyncScope<ActionGate>();
// A current invocation is distinct from the stable House generation retained
// by a draft. captureActionContext intentionally does not capture this scope.
const invocationAssertions = getOrCreatePerProcess('social-send-invocation', () => createHostAsyncScope<() => void>());
export function withActionInvocation<T>(assertCurrent: () => void, work: () => T): T {
  const parent = invocationAssertions.getStore();
  return invocationAssertions.run(() => { parent?.(); assertCurrent(); }, work);
}
const houseActions = createHostAsyncScope<readonly ReadonlyMap<string, ActionGate>[]>();

/** A command captures all known targets once; only the selected target is
 * checked. Cancelling A therefore cannot disable an unrelated B action. */
export function withHouseActions<T>(gates: ReadonlyMap<string, ActionGate>, work: () => T): T {
  return houseActions.run([...(houseActions.getStore() ?? []), gates], work);
}

export function assertHouseActionActive(origin: string): void {
  assertActionActive();
  for (const scope of houseActions.getStore() ?? []) {
    const gate = scope.get(origin);
    if (!gate) throw new ActionInactiveError();
    assertActionActive(gate);
  }
}

/** Drafts and deferred callbacks retain the authority from their creation,
 * even when invoked inside a newer command after logout and login. */
export function captureActionContext<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const gate = actions.getStore();
  const scopes = houseActions.getStore() ?? [];
  return (...args) => withAction(gate, () =>
    houseActions.run([...(houseActions.getStore() ?? []), ...scopes], () => fn(...args)));
}

export class ActionInactiveError extends Error {
  constructor(readonly code: HouseReadFailureCode = 'HOUSE_ACTION_STALE', readonly origin?: string) { super('House action is no longer active'); this.name = 'ActionInactiveError'; }
}
export function assertActionActive(gate?: ActionGate): void {
  invocationAssertions.getStore()?.();
  for (const current of [gate, actions.getStore()]) {
    if (current && (current.signal.aborted || !current.isActive())) throw new ActionInactiveError(current.inactiveReason?.() ?? 'HOUSE_ACTION_STALE', current.origin);
  }
}
export function rethrowActionCancellation(error: unknown): void {
  if (error instanceof ActionInactiveError) throw error;
  assertActionActive();
}

/** Preserve errors and return values while retaining every enclosing generation. */
export function withAction<T>(gate: ActionGate | undefined, work: () => T): T {
  assertActionActive(gate);
  const parent = actions.getStore();
  const captured = gate && parent ? {
    signal: AbortSignal.any([gate.signal, parent.signal]),
    isActive: () => gate.isActive() && parent.isActive(),
    origin: gate.origin,
    inactiveReason: () => !gate.isActive() ? gate.inactiveReason?.() ?? 'HOUSE_ACTION_STALE' : parent.inactiveReason?.() ?? 'HOUSE_ACTION_STALE',
  } : gate;
  return captured ? actions.run(captured, work) : work();
}

/** Resident resources carry a new owner-checked capability, independent of
 * whichever command happened to open them. Business continuations still use
 * withAction/withHouseActions and retain all their original constraints. */
export function withResourceAction<T>(gate: HouseGate, work: () => T): T {
  return actions.run(gate, () => houseActions.run([], () => {
    assertActionActive(gate);
    return work();
  }));
}

/** Background work consumes cancellation, but always awaits the real operation. */
export async function runAction(gate: ActionGate | undefined, work: () => Promise<void>): Promise<void> {
  try { await withAction(gate, work); }
  catch (error) { if (!(error instanceof ActionInactiveError)) throw error; }
}

/** QuestDispatch.expires_at is uint64 epoch seconds. Missing/zero is not authority. */
export function questAction(gate: ActionGate | undefined, expiresAt: unknown, now: () => number = Date.now): ActionGate | undefined {
  if (!gate) return undefined; // Compatibility for legacy, non-session callers.
  let expiry = 0n;
  try {
    const text = typeof expiresAt === 'object' && expiresAt !== null ? String(expiresAt) : String(expiresAt ?? '');
    if (/^[1-9][0-9]*$/.test(text) && !(typeof expiresAt === 'number' && !Number.isSafeInteger(expiresAt))) {
      const parsed = BigInt(text);
      if (parsed <= 18446744073709551615n) expiry = parsed;
    }
  } catch { /* Invalid expiry denies the action. */ }
  return { signal: gate.signal, isActive: () => gate.isActive() && expiry > BigInt(Math.floor(now() / 1000)) };
}

export async function signActionEnvelope(signer: Signer, envelope: Record<string, unknown>, gate?: ActionGate): Promise<SignEnvelopeResult> {
  // signEnvelope contains multiple awaits. Guard each signer call, including the
  // outer signature, without claiming that an already-started signer can stop.
  const guarded = new Proxy(signer, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => { assertActionActive(gate); return value.apply(target, args); };
  } });
  assertActionActive(gate);
  const result = await signEnvelope(guarded, envelope);
  assertActionActive(gate);
  return result;
}

/** Called at every actual HTTP attempt, not merely at the first SDK method call. */
export function actionFetch(gate?: ActionGate, fetchFn: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    assertActionActive(gate);
    const signals = [gate?.signal, actions.getStore()?.signal, init?.signal,
      input instanceof Request ? input.signal : undefined].filter((s): s is AbortSignal => !!s);
    try {
      const result = await fetchFn(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
      assertActionActive(gate);
      // Headers can arrive long before the body. Retain the captured scope
      // for every deferred body decoder, including use after this call returns.
      const methods = new Map<PropertyKey, unknown>();
      return new Proxy(result, {get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function') return value;
        if (!['json', 'text', 'arrayBuffer', 'blob', 'formData'].includes(String(property))) return value.bind(target);
        if (!methods.has(property)) methods.set(property, captureActionContext(async (...args: unknown[]) => {
          assertActionActive(gate);
          const body: unknown = await value.apply(target, args);
          assertActionActive(gate);
          return body;
        }));
        return methods.get(property);
      }});
    } catch (error) { assertActionActive(gate); throw error; }
  };
}

/** An owned timer can be cancelled; an injected SDK promise is still awaited. */
export function actionSleep(gate?: ActionGate, sleep?: (ms: number) => Promise<void>): (ms: number) => Promise<void> {
  return async (ms) => {
    assertActionActive(gate);
    if (sleep) await sleep(ms);
    else {
      const signals = [gate?.signal, actions.getStore()?.signal].filter((s): s is AbortSignal => !!s);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(new ActionInactiveError());
        const timer = setTimeout(() => finish(), ms);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    assertActionActive(gate);
  };
}
