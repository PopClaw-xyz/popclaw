/**
 * `/popclaw help` is the ONLY place the owner (and the agent reading over their
 * shoulder) learns a subcommand exists. A subcommand missing from the help table
 * works perfectly and is, in practice, not there at all — `notify-here`,
 * `notify-off` and `taste` lived outside it for months.
 *
 * Three gates, and each catches something the others can't:
 *   - `SUBCOMMAND_NAMES` types the SUBCOMMANDS map as a `Record`, so adding or
 *     removing a handler without touching the list is a compile error (tsc).
 *   - this file, so `HELP_SUBS` and that list stay the same set.
 *   - and the lexicon keys, checked here too: `helpEntries()` builds its key
 *     with a template literal (`help.${sub.name}.summary`), which the
 *     renderCopy-keys static scan cannot see. A HELP_SUBS entry with no lexicon
 *     key doesn't throw — `renderCopy`'s fallback chain prints the bare key
 *     string into the owner's help listing.
 *
 * One lane is enough for the key checks: lexicon/completeness.test.ts already
 * asserts EN.copy and ZH_CN.copy have identical key sets, so a key present in
 * en but missing in zh-CN fails there.
 */
import { describe, expect, it } from 'vitest';
import { HELP_SUBS, SUBCOMMAND_NAMES } from '../../../src/index.js';
import { EN } from '../../../src/lexicon/en.js';

describe('/popclaw help table', () => {
  it('documents exactly the subcommands that exist', () => {
    expect(HELP_SUBS.map((s) => s.name).sort()).toEqual([...SUBCOMMAND_NAMES].sort());
  });

  it('lists each subcommand once', () => {
    const names = HELP_SUBS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has a lexicon summary for every subcommand', () => {
    const missing = HELP_SUBS.filter((s) => !(`help.${s.name}.summary` in EN.copy)).map((s) => s.name);
    expect(missing).toEqual([]);
  });

  it('has a lexicon usage / examples value wherever the table flags one', () => {
    const missing = HELP_SUBS.flatMap((s) => [
      ...(s.usage && !(`help.${s.name}.usage` in EN.copy) ? [`help.${s.name}.usage`] : []),
      ...(s.examples && !(`help.${s.name}.examples` in EN.copy) ? [`help.${s.name}.examples`] : []),
    ]);
    expect(missing).toEqual([]);
  });
});
