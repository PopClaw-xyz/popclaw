import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ledger #010 guard: the owner-facing "it did not work" line must come from
 * the lexicon, never from a template literal in a catch-arm.
 *
 * Sixty sites once built it in English by hand. The CJK ratchet could not see
 * them — it guards against Chinese *escaping* the lexicon, not against English
 * *bypassing* it. This is that missing direction, and it is a ratchet too:
 * the count may only go down.
 */
const SRC = new URL('../../../src/', import.meta.url).pathname;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('ledger #010 — the failure line lives in the lexicon', () => {
  it('no source file hand-builds "⚠️ … failed:"', () => {
    const offenders = walk(SRC)
      .filter((p) => !p.includes('/lexicon/'))
      .filter((p) => /⚠️[^\n]*failed:/.test(readFileSync(p, 'utf-8')))
      .map((p) => p.slice(SRC.length));
    expect(offenders).toEqual([]);
  });
});
