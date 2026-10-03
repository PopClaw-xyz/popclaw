/**
 * In-process self-report for the routing hook (#374). Plain counters, zero
 * I/O — register() only writes one string (ADR-0035: register must stay cheap).
 *
 * Why this exists: on 2026-07-31 we established that ADR-0043's L1/L2 had
 * **never fired once**. The hook was registered in the wrong namespace
 * (`api.registerHook` writes the internal-hook table, while the only emitter of
 * `before_prompt_build` reads `registry.typedHooks`, a table only `api.on`
 * writes). The failure mode was **completely silent**: the host raised nothing,
 * and we only logged on a successful injection — so "host has no such hook",
 * "hook on the wrong table" and "all fine, no match this turn" looked identical
 * in the log. Diagnosing it burned dozens of tool calls.
 *
 * This module makes the same class of failure announce itself: a three-state
 * info line at register time, live counters while running, one shout when the
 * hook is registered but never called, and a one-line verdict in
 * `/popclaw status`.
 * ⚠️ Every evidence line must be **info** — on this repo's hosts warn/error go
 * to /dev/null.
 */

/** Register-time verdict. `off` = kill switch on (the hook is still attached:
 *  the recent-attachment notice is not a routing policy). */
export type RoutingMode = 'wired' | 'unavailable' | 'off';

/** Inbound turns with still zero fires = the chain is broken. 3 is enough to
 *  rule out "the gateway just booted". */
export const BROKEN_AFTER = 3;

const stats = {
  mode: 'unavailable' as RoutingMode,
  /** Times the host actually called `before_prompt_build`. The one number that
   *  answers "is the chain alive". */
  fireCount: 0,
  /** Cumulative L2 lexicon entries hit (entries, not turns). */
  l2HitCount: 0,
  /** Inbound messages seen by `before_dispatch` — the known-good control hook. */
  inboundCount: 0,
  /** `stripEnvelope` calls (every turn the language signal / trace looks at). */
  envelopeSeen: 0,
  /** …of which actually carried a host envelope that got stripped off. */
  envelopeStripped: 0,
  lastFiredAt: 0,
  brokenLogged: false,
};

export type RoutingStats = Readonly<typeof stats>;

export function routingStats(): RoutingStats {
  return stats;
}

export function markRoutingMode(mode: RoutingMode): void {
  stats.mode = mode;
}

/** The host called the handler. Whether anything got injected is a separate
 *  question — this only records "the chain is alive". */
export function noteRoutingFire(now = Date.now()): void {
  stats.fireCount++;
  stats.lastFiredAt = now;
}

export function noteRoutingL2Hits(n: number): void {
  stats.l2HitCount += n;
}

/**
 * One inbound message passed through `before_dispatch`.
 * Returns `true` when the "registered but never fired" info line is due —
 * **once per process**, never a flood.
 */
export function noteInboundTurn(): boolean {
  stats.inboundCount++;
  if (stats.mode !== 'wired' || stats.fireCount > 0) return false;
  if (stats.inboundCount < BROKEN_AFTER || stats.brokenLogged) return false;
  stats.brokenLogged = true;
  return true;
}

/**
 * One `stripEnvelope` call; `hit` = a host envelope was actually found and
 * removed.
 *
 * We strip `[Telegram Alice id:… ] Alice: ` by matching a string we never
 * imported — nothing breaks loudly if the host changes the format, the language
 * verdict just quietly goes wrong (the header is 25+ Latin letters and drowns
 * short CJK). This ratio is the only cheap proof either way: still ~1 = the
 * prefix is alive; drops to 0 while language detection stays sane = the host
 * stopped enveloping and the strip can go next round.
 */
export function noteEnvelopeStripped(hit: boolean): void {
  stats.envelopeSeen++;
  if (hit) stats.envelopeStripped++;
}

/** Test seam: a process-wide singleton has to be wiped between cases. */
export function resetRoutingStats(): void {
  stats.mode = 'unavailable';
  stats.fireCount = 0;
  stats.l2HitCount = 0;
  stats.inboundCount = 0;
  stats.envelopeSeen = 0;
  stats.envelopeStripped = 0;
  stats.lastFiredAt = 0;
  stats.brokenLogged = false;
}
