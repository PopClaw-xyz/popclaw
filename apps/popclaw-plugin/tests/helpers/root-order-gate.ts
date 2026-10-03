/**
 * Named gates for the C3 order pins (tests/unit/runtime/root-order-gateway.test.ts).
 *
 * A gate sits around one real call the gateway root makes during boot:
 * - `hold(label)`: a barrier IN FRONT of the real call, so the test can act
 *   (fire the prompt-build hook, write a file, seed a row) while the root sits
 *   on exactly that await.
 * - `fail(label)`: an injected fault AFTER the real call returned, so whatever
 *   the real call opened exists; it pins how the root's failed-boot drain
 *   treats a rejection at that point, not the state a component that failed
 *   on its own would leave.
 *
 * Every pass records `label` (and `fault:<label>` when the fault fires) into
 * the shared probe event log, so the C0 recorders and these gates share one
 * timeline.
 */
import { barrier, probe, push, type Barrier } from './root-assembly-probe.js';

export const C3_FORCED_FAILURE = 'C3_FORCED_BOOT_FAILURE';

export const gate = {
  holds: new Map<string, Barrier>(),
  fails: new Set<string>(),
  /** Arm a hold on `label`; the returned barrier reports when the root reached it. */
  hold(label: string): Barrier {
    const b = barrier();
    gate.holds.set(label, b);
    return b;
  },
  fail(label: string): void {
    gate.fails.add(label);
  },
  reset(): void {
    gate.holds.clear();
    gate.fails.clear();
  },
};

function fault(label: string): void {
  if (!gate.fails.has(label)) return;
  probe.beforeFail?.();
  push(`fault:${label}`);
  throw new Error(C3_FORCED_FAILURE);
}

/** Wrap an async real call: record, hold if armed, call through, fault if armed. */
export async function gatedAsync<T>(label: string, real: () => Promise<T>): Promise<T> {
  push(label);
  const held = gate.holds.get(label);
  if (held) await held.pass();
  const result = await real();
  fault(label);
  return result;
}

/** Wrap a synchronous real call: record, call through, fault if armed (throws synchronously). */
export function gatedSync<T>(label: string, real: () => T): T {
  push(label);
  const result = real();
  fault(label);
  return result;
}
