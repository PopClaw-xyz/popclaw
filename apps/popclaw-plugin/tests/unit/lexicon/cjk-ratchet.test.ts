import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const exempt: string[] = JSON.parse(readFileSync(join(__dirname, 'cjk-exempt.json'), 'utf8'));

/**
 * CJK-leak ratchet (S0, decision doc section 1 ruling 6 / section 2.6): the whole point of the lexicon
 * is that new user-facing Chinese text lives in `src/lexicon/zh-CN.ts`, not scattered as string
 * literals through the rest of `src/`. This test doesn't try to fix the scatter that already exists:
 * `cjk-exempt.json` grandfathers it in. It only stops the pile from growing: a NEW file with CJK
 * characters that isn't on the exempt list fails the build. Ratchet rule: the exempt list only ever
 * shrinks. If you clean CJK out of a file, delete its entry (the test below warns when one is stale
 * but does not fail; removal is opt-in cleanup). If you add CJK to a NEW file, put the words in
 * `src/lexicon/zh-CN.ts` instead of inline. If that is genuinely impossible, get the addition reviewed
 * and explicitly add the file to `cjk-exempt.json`; do not regenerate the whole list and defeat the
 * ratchet.
 */

const SRC_ROOT = join(__dirname, '../../../src');
const CJK = /[\u4e00-\u9fff]/;
const ALWAYS_EXEMPT = new Set(['src/lexicon/zh-CN.ts']);

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) listTsFiles(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function relPath(absPath: string): string {
  return relative(join(SRC_ROOT, '..'), absPath).split('\\').join('/');
}

describe('CJK-leak ratchet', () => {
  const files = listTsFiles(SRC_ROOT);
  const exemptSet = new Set<string>(exempt);

  const filesWithCjk = files
    .map(relPath)
    .filter((rel) => !ALWAYS_EXEMPT.has(rel))
    .filter((rel) => CJK.test(readFileSync(join(SRC_ROOT, '..', rel), 'utf8')));

  it('has no new CJK-leaking files outside the exempt list', () => {
    const newLeaks = filesWithCjk.filter((rel) => !exemptSet.has(rel));
    expect(
      newLeaks,
      `New file(s) with Chinese text outside src/lexicon/zh-CN.ts: ${newLeaks.join(', ')}. ` +
        `Put new user-facing Chinese in src/lexicon/zh-CN.ts (the "speaking" lexicon) instead ` +
        `of a string literal. If this genuinely can't go through the lexicon, that needs review ` +
        `before adding it to tests/unit/lexicon/cjk-exempt.json — the exempt list only shrinks.`,
    ).toEqual([]);
  });

  it('every exempt entry still exists under src/', () => {
    const fileSet = new Set(files.map(relPath));
    const missing = [...exemptSet].filter((rel) => !fileSet.has(rel));
    expect(missing, `cjk-exempt.json lists file(s) that no longer exist: ${missing.join(', ')}`).toEqual([]);
  });

  it('warns (does not fail) about exempt entries that are already clean', () => {
    const cjkSet = new Set(filesWithCjk);
    const stale = [...exemptSet].filter((rel) => !cjkSet.has(rel));
    if (stale.length > 0) {
      console.warn(
        `[cjk-ratchet] ${stale.length} exempt file(s) no longer contain CJK and can be removed ` +
          `from cjk-exempt.json: ${stale.join(', ')}`,
      );
    }
    expect(true).toBe(true);
  });
});
