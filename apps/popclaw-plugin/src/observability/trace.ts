/**
 * Repo-wide development trace switch, partitioned by module (#374 — routing is
 * the first customer; this file is meant to serve the rest of the plugin too).
 *
 *   (unset)                            TRACE_DEFAULT_ON — currently OFF
 *   POPCLAW_TRACE=off                  everything off (`none` works too)
 *   POPCLAW_TRACE=routing              one module
 *   POPCLAW_TRACE=routing,newspaper    several
 *   POPCLAW_TRACE=all                  everything
 *   POPCLAW_ROUTING_TRACE=1|0          per-module override, wins over the list
 *                                      (generic: POPCLAW_<MODULE>_TRACE)
 *   POPCLAW_TRACE_TEXT=1|0             may a trace line quote the owner's own
 *                                      words? Same default constant as above.
 *
 * Three rules, all load-bearing:
 *
 *  1. **Zero cost when off.** `trace()` takes a lazy builder: with the switch
 *     off nothing is allocated, no string is joined, no fact object is built.
 *     Pinned by a unit test that asserts the builder is never called.
 *  2. **Development instrument, not production evidence.** Anything that must
 *     be visible on a real machine (a hook that registered but never fired, a
 *     failed send) logs unconditionally at info — never behind this switch.
 *     ⚠️ On this repo's hosts warn/error go to /dev/null; **info is the only
 *     visible level**.
 *  3. **No owner data, with exactly one governed exception.** A trace line may
 *     carry our own constants, identifiers, language codes, counts and lengths.
 *     Message bodies and filenames never. The single exception is the owner's
 *     *own* words, gated by `traceTextEnabled` — a short enveloped-stripped
 *     sample used during the beta to tune the routing lexicon (ADR-0045, the
 *     "owner words" section). Each module's fact type enforces the rest: at most one
 *     free-text field, and it must be fed by that switch (see `routing/trace.ts`).
 *
 * Pure functions, zero I/O. The logger is passed in; this module never imports
 * one.
 */

/**
 * OFF since the 0.1.0 release build (2026-08-25): a published package must not
 * default to logging routing traces — least of all the owner's own words
 * (`traceTextEnabled`). Internal machines that still want traces set
 * `POPCLAW_TRACE=all` (and `POPCLAW_TRACE_TEXT=1`) per box. Every
 * default-on/off decision in the plugin routes through here, nowhere else;
 * see docs/install/RELEASE-CHECKLIST.md.
 */
export const TRACE_DEFAULT_ON = false;

const OFF_WORDS = new Set(['off', 'none']);

function requested(env: NodeJS.ProcessEnv): string[] {
  return (env.POPCLAW_TRACE ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Per-module override, then the shared list, then the default. */
export function traceEnabled(module: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const own = env[`POPCLAW_${module.toUpperCase()}_TRACE`];
  if (own === '1') return true;
  if (own === '0') return false;
  const on = requested(env);
  if (on.length === 0) return TRACE_DEFAULT_ON;
  if (on.some((t) => OFF_WORDS.has(t))) return false;
  return on.includes('all') || on.includes(module.toLowerCase());
}

/**
 * May a trace line quote what the owner actually typed? Beta-only instrument:
 * with `l2=none` you cannot tell "correctly not a routing turn" from "the
 * lexicon is too narrow" without seeing the words that missed.
 *
 * Default rides the SAME constant as everything else — cutting the public
 * release build flips one line, not two (ADR-0045: one flip point). An explicit
 * env value always wins, so a single box can opt out without a code change.
 */
export function traceTextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.POPCLAW_TRACE_TEXT ?? '').trim().toLowerCase();
  if (v === '') return TRACE_DEFAULT_ON;
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

/** For the boot line — one glance tells the owner whether this box is tracing. */
export function traceStatusLabel(env: NodeJS.ProcessEnv = process.env): string {
  const on = requested(env);
  const base =
    on.length === 0
      ? TRACE_DEFAULT_ON
        ? 'on(all)'
        : 'off'
      : on.some((t) => OFF_WORDS.has(t))
        ? 'off'
        : `on(${on.join(',')})`;
  // Nothing traced at all → nothing to qualify. Otherwise say it out loud: this
  // box is writing the owner's own words into its log.
  return base === 'off' || !traceTextEnabled(env) ? base : `${base}+text`;
}

/**
 * Emit one trace line for `module` — `build` runs **only** when the switch is
 * on, so an off switch costs one env lookup and nothing else.
 */
export function trace(
  module: string,
  log: (msg: string) => void,
  build: () => string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!traceEnabled(module, env)) return;
  log(build());
}
