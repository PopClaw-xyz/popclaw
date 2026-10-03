/**
 * Defensive adoption of the process-wide runtime memo (issue #582).
 *
 * `clearPerProcess('runtime')` on shutdown fixes the restart for builds that
 * HAVE that fix. It cannot fix the upgrade itself: when the instance being shut
 * down is an OLDER build, its shutdown leaves the memo parked on globalThis,
 * and the first registration of the new build adopts a runtime whose sqlite
 * handles are already closed — "The database connection is not open",
 * HOUSE_RUNTIME_STOPPED — once per host, until the process is killed.
 *
 * So the accessor checks the corpse for a pulse before adopting it. Detection
 * may only use state the OLD object already carries: a flag introduced now
 * exists on the new build's runtime and on nothing else. better-sqlite3's
 * `Database.open` flips to false in `close()`, and LocalHostDb keeps its own
 * `closed` — both have been there far longer than this bug.
 */
import { clearPerProcess, getOrCreatePerProcess, peekPerProcess } from './once.js';

const revokedKey = (key: string) => `${key}:revoked-readers`;
function revoked(key: string, memo: object): boolean {
  return peekPerProcess<WeakSet<object>>(revokedKey(key))?.has(memo) === true;
}

/** Revoke readers at shutdown entry, before asynchronous resource draining. */
function revokeRuntimePeek(key: string, memo: Promise<unknown>): void {
  getOrCreatePerProcess(revokedKey(key), () => new WeakSet<object>()).add(memo);
}

function observeShutdown(key: string, memo: Promise<unknown>, closing?: AbortSignal): void {
  if (!closing) return;
  if (closing.aborted) revokeRuntimePeek(key, memo);
  else closing.addEventListener('abort', () => revokeRuntimePeek(key, memo), { once: true });
}

/** Re-check synchronously after an awaiting reader resumes, before it uses the runtime. */
export function runtimeMemoCurrent(key: string, memo: Promise<unknown> | undefined): boolean {
  return memo !== undefined && peekPerProcess(key) === memo && !revoked(key, memo);
}

/**
 * Read only the runtime already requested by this process. Awaiting that
 * promise never calls a factory. A failed, replaced, closed or stopping memo
 * supplies no declaration; readers cannot revive it or clear it.
 */
export async function peekCurrentRuntime<T>(key: string): Promise<T | null> {
  const memo = peekPerProcess<Promise<T>>(key);
  if (!memo || revoked(key, memo)) return null;
  try {
    const runtime = await memo;
    return runtimeMemoCurrent(key, memo) && !isClosedRuntime(runtime) ? runtime : null;
  } catch { return null; }
}

/** The shapes the host db handle can take, read defensively (never constructed). */
type MaybeClosed = { open?: unknown; closed?: unknown; handle?: { open?: unknown } };

/**
 * True only when the runtime's host database is provably closed. Unknown
 * shapes read as alive: a false positive would reboot a healthy runtime and
 * orphan its streams, which is worse than the bug this guards.
 *
 * Hot path — every runtime access goes through here — so it stays property
 * reads with no allocation and no try/catch.
 */
export function isClosedRuntime(runtime: unknown): boolean {
  const db = (runtime as { host?: { db?: MaybeClosed } } | null | undefined)?.host?.db;
  if (!db) return false;
  // Direct better-sqlite3 Database, LocalHostDb's own bookkeeping, the
  // better-sqlite3 Database that LocalHostDb wraps.
  return db.open === false || db.closed === true || db.handle?.open === false;
}

/**
 * The memoized runtime for `key`, rebooted instead of adopted when a previous
 * registration left a closed one behind. `onStaleMemo` is called once per
 * reboot (the caller logs it; this module has no logger).
 */
export async function adoptOrRebootRuntime<T>(
  key: string,
  factory: () => Promise<T>,
  onStaleMemo: () => void,
  closing?: AbortSignal,
): Promise<T> {
  const memo = getOrCreatePerProcess(key, factory);
  // Bind shutdown to THIS promise, never whatever a later registration parks.
  observeShutdown(key, memo, closing);
  const adopted = await memo;
  if (!isClosedRuntime(adopted)) return adopted;
  onStaleMemo();
  clearPerProcess(key);
  const fresh = getOrCreatePerProcess(key, factory);
  observeShutdown(key, fresh, closing);
  return fresh;
}
