/**
 * Per-fire trace facts for the routing hook — one info line laying out what
 * **every passenger** on the `before_prompt_build` handler decided, every time
 * it runs. Gated by the repo-wide switch (`POPCLAW_TRACE=routing`, or the
 * legacy `POPCLAW_ROUTING_TRACE=1`); see `observability/trace.ts`.
 *
 * Why: in #374 that handler was registered in the wrong namespace and all three
 * of its passengers (routing L1/L2/L3, the `observeOwnerText` live language
 * signal, and the "the owner just handed you these files" notice) died silently
 * **together** for three weeks — none of them had any independent proof of
 * life. Any one of them failing again must be verifiable on its own.
 *
 * 🔒 **Privacy rule (never relax it)**: the trace must never print message
 * bodies from anyone but the owner, or attachment filenames. Only these may
 * appear:
 *   1. the trigger phrase that matched — a constant from **our own** table
 *      (`LEXICON` or a house guide), not something the owner typed;
 *   2. tool names and house slugs;
 *   3. language codes;
 *   4. counts and lengths;
 *   5. `ownerTextSample` — the **one** free-text field, and the only way to fill
 *      it is `sampleOwnerText`, which is gated by `POPCLAW_TRACE_TEXT` and
 *      strips the host envelope first. See below.
 * The rule is enforced by the **type**: `RoutingTraceFacts` has exactly one
 * free-text field, and `formatRoutingTrace` accepts nothing else — adding a
 * second one requires changing the type, which review (and a unit test) sees.
 *
 * Pure functions, zero I/O: "which segments should be logged" is directly
 * assertable in a unit test, with no log-string scraping.
 */

import { traceTextEnabled } from '../observability/trace.js';
import { stripEnvelope } from '../lexicon/owner-language.js';

export interface RoutingTraceFacts {
  /** Which fire this is, within the process (1-based). */
  readonly fire: number;
  /** Whether the L1 standing block was injected this turn (kill switch → false). */
  readonly l1: boolean;
  /** L2 hits: tool name + the matched phrase (a table constant) + source house. */
  readonly l2: readonly {
    readonly tool: string;
    readonly trigger: string;
    readonly from?: string;
  }[];
  /** L3 house-side entries: how many loaded this fire, and from which houses. */
  readonly house: { readonly entries: number; readonly slugs: readonly string[] };
  /** `observeOwnerText`'s verdict: detected language code (null = undetected)
   *  and whether the register actually switched. */
  readonly lang: { readonly detected: string | null; readonly switched: boolean };
  /** How many attachments the notice reported (0 = no notice). Filenames never
   *  enter the trace. */
  readonly attachments: number;
  /** Host-envelope strip counter (see `noteEnvelopeStripped`): how many strips
   *  actually found a `[…] Sender: ` prefix, out of how many looked. Optional —
   *  omit it and the segment is absent. Counts only, no text. */
  readonly envelope?: { readonly stripped: number; readonly seen: number };
  /** The owner's own words, enveloped-stripped and clipped — **only** ever set
   *  from `sampleOwnerText` (switch-gated). The single free-text field. */
  readonly ownerTextSample?: string;
}

/** The module name this trace is partitioned under (`POPCLAW_TRACE=routing`). */
export const ROUTING_TRACE = 'routing';

/** Long enough to recognise the phrasing, short enough not to be a transcript. */
const SAMPLE_MAX_CHARS = 80;

/**
 * The beta lexicon-tuning sample: what did the owner actually say on this fire?
 * Returns `undefined` (no field, no segment) unless `POPCLAW_TRACE_TEXT` allows
 * it, so the caller can pass it unconditionally inside the lazy trace builder.
 *
 * Recorded on hits **and** misses on purpose — an `l2=none` turn is exactly the
 * sample that tells us whether a lexicon entry is missing.
 *
 * Three reductions, all deliberate: the host envelope goes first (sender name /
 * id / timestamp are not the owner's words and must never be logged — same
 * `stripEnvelope` the language signal uses), all whitespace collapses to single
 * spaces so one turn stays one grep-able line, and the result is clipped to 80
 * **characters** (code points, so CJK counts as one).
 */
export function sampleOwnerText(
  text: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!traceTextEnabled(env)) return undefined;
  const body = stripEnvelope(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return undefined;
  const chars = [...body];
  return chars.length > SAMPLE_MAX_CHARS ? `${chars.slice(0, SAMPLE_MAX_CHARS).join('')}…` : body;
}

/** One fire = one line. Fixed segment order, so it greps and asserts cleanly. */
export function formatRoutingTrace(f: RoutingTraceFacts): string {
  const l2 =
    f.l2.length === 0
      ? 'none'
      : f.l2.map((h) => `${h.tool}("${h.trigger}"${h.from ? `@${h.from}` : ''})`).join(',');
  const slugs = f.house.slugs.length === 0 ? '' : `@${f.house.slugs.join(',')}`;
  return [
    `popclaw: routing trace #${f.fire}`,
    `l1=${f.l1 ? 'injected' : 'skipped'}`,
    `l2=${l2}`,
    `l3=${f.house.entries}entries${slugs}`,
    `lang=${f.lang.detected ?? 'undetected'}${f.lang.switched ? '(switched)' : ''}`,
    `attach=${f.attachments}`,
    ...(f.envelope ? [`env=${f.envelope.stripped}/${f.envelope.seen}`] : []),
    // Last segment: variable length, and absent entirely when the switch is off.
    ...(f.ownerTextSample ? [`text="${f.ownerTextSample}"`] : []),
  ].join(' · ');
}
