/**
 * The follow doorbell's injection passenger (doorbell spec §6.4) — the
 * context the confirmation turn runs on.
 *
 * PURE: rows and copy in, string out. No store, no IO, never throws on
 * well-formed input. The passenger that calls this (the fifth passenger in
 * index.ts's before_prompt_build handler, after the L2 drain) is read-only
 * on the pending store on purpose: the L1/L2 mutex is owned by the two
 * DELIVERY legs (the timer leg's claim-before-deliverNow, and the drain
 * site's claim in index.ts — "ruling C"); this block only reflects whatever
 * state they left behind, so the three modes fall out of `first_surfaced_ts`:
 *
 *   any row un-surfaced      → the FULL numbered block (head + one entry per
 *                              line + the five execution rules). The whole
 *                              unresolved set is listed, surfaced rows
 *                              included — an unanswered surfaced row is as
 *                              pending as a fresh click, and the owner's
 *                              reply ("all of them" / "1 3") must be able to
 *                              reach every one of them.
 *   all surfaced, unresolved → the one-line pointer (spec §7) plus ONE
 *                              compact line of numbered names — enough for
 *                              the agent to answer the owner's "follow list"
 *                              from context, with no re-teaching of the
 *                              rules and no per-turn wall of names.
 *   nothing pending          → '' (inject nothing).
 *
 * Ordering: rows are numbered in the order given. The row type deliberately
 * carries no first_ts — `listPending()` already yields first_ts ASC (the
 * stable display order the spec asks for); this function never re-sorts.
 */
import { renderCopy, type Lang } from '../lexicon/index.js';

/** One pending row, reduced to everything the injection is allowed to show. */
export interface PendingInjectionRow {
  display_name: string;
  descriptor: string | null;
  /** null = the batch has never been surfaced (the full-block trigger). */
  first_surfaced_ts: number | null;
}

/** Copy templates for both modes. `{i}` `{name}` `{descriptor}` `{count}`
 *  are filled by this module. */
export interface InjectionStrings {
  /** Full-mode head, carries the count. */
  readonly head: string;
  /** `{i}. {name}{descriptor}` — one numbered entry per line. */
  readonly entry: string;
  /** The descriptor's parenthetical note, its own parentheses; empty when
   *  the person has none. */
  readonly entryDescriptor: string;
  /** Rule ①: 6+ or ambiguous → echo the whole batch first. */
  readonly ruleEcho: string;
  /** Rule ②: reply examples are examples; natural language accepted. */
  readonly ruleNatural: string;
  /** Rule ③: "none" skips the batch; unmentioned entries are skipped. */
  readonly ruleSkip: string;
  /** Rule ④: off-topic → don't force it. */
  readonly ruleOffTopic: string;
  /**
   * Rule ⑤ (T13): after executing a batch, report by head-count (N ok /
   * M failed, with names) and point out the correction exit — "unfollow
   * <name>" — for a mistaken pick. The batch receipts are agent-composed,
   * so this rule line IS the receipt copy guidance; no code renders them.
   */
  readonly ruleReport: string;
  /** The pointer line (spec §7), carries the count. */
  readonly pointer: string;
  /** `{i}. {name}` — one compact-list entry, names only. */
  readonly pointerEntry: string;
}

/** renderCopy's placeholder semantics, minus the lookup — the templates
 *  arrive already resolved, this fills them at compose time. */
function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

function entryLine(x: PendingInjectionRow, i: number, T: InjectionStrings): string {
  return fill(T.entry, {
    i: i + 1,
    name: x.display_name,
    descriptor: x.descriptor ? fill(T.entryDescriptor, { descriptor: x.descriptor }) : '',
  });
}

/**
 * The three-mode injection block ('' = inject nothing). Rows are numbered in
 * the order given (see the module header); display_name is rendered verbatim
 * — the plugin-side `name#sigil` is the one string every other surface (the
 * paper, the L1, the share sentence) also shows, so the agent's matching
 * basis and the owner's vocabulary never drift apart.
 */
export function buildPendingInjection(rows: PendingInjectionRow[], T: InjectionStrings): string {
  if (rows.length === 0) return '';
  const unsurfaced = rows.some((r) => r.first_surfaced_ts === null);
  if (unsurfaced) {
    const entries = rows.map((x, i) => entryLine(x, i, T)).join('\n');
    const rules = [T.ruleEcho, T.ruleNatural, T.ruleSkip, T.ruleOffTopic, T.ruleReport].join('\n');
    return [fill(T.head, { count: rows.length }), entries, rules].join('\n');
  }
  const compact = rows.map((x, i) => fill(T.pointerEntry, { i: i + 1, name: x.display_name })).join(' ');
  return [fill(T.pointer, { count: rows.length }), compact].join('\n');
}

/** The templates above, resolved from the lexicon for `lang`. */
export function injectionStrings(lang: Lang): InjectionStrings {
  return {
    head: renderCopy(lang, 'newspaper.doorbell.inject.head'),
    entry: renderCopy(lang, 'newspaper.doorbell.inject.entry'),
    entryDescriptor: renderCopy(lang, 'newspaper.doorbell.inject.entryDescriptor'),
    ruleEcho: renderCopy(lang, 'newspaper.doorbell.inject.rule.echo'),
    ruleNatural: renderCopy(lang, 'newspaper.doorbell.inject.rule.natural'),
    ruleSkip: renderCopy(lang, 'newspaper.doorbell.inject.rule.skip'),
    ruleOffTopic: renderCopy(lang, 'newspaper.doorbell.inject.rule.offTopic'),
    ruleReport: renderCopy(lang, 'newspaper.doorbell.inject.rule.report'),
    pointer: renderCopy(lang, 'newspaper.doorbell.inject.pointer'),
    pointerEntry: renderCopy(lang, 'newspaper.doorbell.inject.pointerEntry'),
  };
}
