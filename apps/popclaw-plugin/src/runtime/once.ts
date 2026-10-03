/**
 * Process-level "do this once" guard — P-006 §3 (singular runtime resources).
 *
 * The plugin's `register()` runs once per agent that loads it: the main gateway
 * AND ephemeral side-agents (e.g. `popclaw-recommend` waking on its schedule).
 * Identity-bound background services (inbox subscription, ranger, world-feed)
 * must start ONCE per process — not once per register() call, which is what
 * caused the same DM to be delivered N times.
 *
 * Keyed on `globalThis` (not a module-level `let`) so the flag is shared even
 * if agents load the plugin in isolated module contexts: globalThis is the one
 * thing guaranteed shared across all module loads in a single process.
 */
const G = globalThis as unknown as Record<string, true | undefined>;

const flagKey = (key: string): string => `__popclaw_once__${key}`;

/** Runs `fn` only the first time it's called for `key` in this process. */
export function runOncePerProcess(key: string, fn: () => void): 'ran' | 'skipped' {
  const flag = flagKey(key);
  if (G[flag]) return 'skipped';
  G[flag] = true;
  fn();
  return 'ran';
}

/** Test helper: clear the once-flag for `key`. */
export function resetOnceForTest(key: string): void {
  delete G[flagKey(key)];
}

const GV = globalThis as unknown as Record<string, unknown>;
const valueKey = (key: string): string => `__popclaw_singleton__${key}`;

/**
 * Process-wide singleton VALUE: returns the cached value for `key`, creating it
 * once via `factory`. Unlike runOncePerProcess (a side-effect guard), this
 * shares ONE value across every register() invocation — so the live inbox
 * notification gate and the /popclaw follow command hold the SAME socialGraph.
 * Without this, register() runs per plugin-load (gateway + side-agents), each
 * builds its own socialGraph, and a follow done via a command updates a
 * different instance than the gate reads → the follow doesn't take effect on
 * notifications until a gateway restart. P-006 §3 (singular runtime resources).
 */
export function getOrCreatePerProcess<T>(key: string, factory: () => T): T {
  const k = valueKey(key);
  if (!(k in GV)) GV[k] = factory();
  return GV[k] as T;
}

/** Read an existing value without creating or clearing anything. */
export function peekPerProcess<T>(key: string): T | undefined {
  return GV[valueKey(key)] as T | undefined;
}

/**
 * Drop the cached value for `key` so the next `getOrCreatePerProcess` builds a
 * fresh one.
 *
 * A memo whose value OWNS process resources (sqlite handles, streams, a house
 * manager) must be cleared by that value's own shutdown — the memo outlives the
 * lifecycle that created it. `openclaw gateway restart` re-registers the plugin
 * inside the SAME process: the new registration builds a new lifecycle, but its
 * first `get()` still hits this table. Leave the entry behind and it hands back
 * a corpse — closed databases, a stopped house runtime — and every later call
 * fails with "The database connection is not open" / HOUSE_RUNTIME_STOPPED
 * until the process itself is killed (issue #582).
 */
export function clearPerProcess(key: string): void {
  delete GV[valueKey(key)];
}

/** Test helper: clear the singleton value for `key`. Alias of {@link clearPerProcess}. */
export const resetSingletonForTest = clearPerProcess;
