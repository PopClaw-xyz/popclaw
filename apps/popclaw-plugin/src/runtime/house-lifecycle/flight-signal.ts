/** Union of the per-call flight signal and the manager stop signal. */
export function composeFlightSignal(...input: (AbortSignal | undefined)[]): AbortSignal {
  const signals = input.filter((s): s is AbortSignal => !!s);
  if (signals.length === 0) return new AbortController().signal;
  const anyOf = (AbortSignal as unknown as { any?: (ss: AbortSignal[]) => AbortSignal }).any;
  if (anyOf) return anyOf(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
