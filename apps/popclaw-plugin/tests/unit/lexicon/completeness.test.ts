import { describe, expect, it } from 'vitest';
import { EN } from '../../../src/lexicon/en.js';
import { ZH_CN } from '../../../src/lexicon/zh-CN.js';
import { LANGS, renderCopy } from '../../../src/lexicon/index.js';

/**
 * The lexicon's only real invariant: en and zh-CN must offer exactly the
 * same keys (terms + copy, including nested tier/roles/worldKinds) — a
 * missing key in one language is a silent fallback-to-wrong-language bug
 * waiting to happen once S1+ starts reading this table at runtime.
 */
function keyPaths(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.keys(obj)
    .sort()
    .flatMap((k) => keyPaths((obj as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k));
}

describe('lexicon completeness (en vs zh-CN)', () => {
  it('terms: identical key sets, including nested tier/roles/worldKinds', () => {
    expect(keyPaths(EN.terms)).toEqual(keyPaths(ZH_CN.terms));
  });

  it('copy: identical key sets', () => {
    expect(keyPaths(EN.copy)).toEqual(keyPaths(ZH_CN.copy));
  });

  it('terms: every leaf is a non-empty string in both languages', () => {
    for (const path of keyPaths(EN.terms)) {
      const en = path.split('.').reduce((o: unknown, k) => (o as Record<string, unknown>)[k], EN.terms);
      const zh = path.split('.').reduce((o: unknown, k) => (o as Record<string, unknown>)[k], ZH_CN.terms);
      expect(typeof en, `EN.terms.${path}`).toBe('string');
      expect(typeof zh, `ZH_CN.terms.${path}`).toBe('string');
      expect((en as string).length, `EN.terms.${path}`).toBeGreaterThan(0);
      expect((zh as string).length, `ZH_CN.terms.${path}`).toBeGreaterThan(0);
    }
  });

  it('status.how.orConjunction is a suffix of status.how.orMarker, in every lane', () => {
    // splitAtOr (commands/status.ts) cuts the `how` line at `orMarker` and
    // keeps `orConjunction` on the continuation line by slicing
    // `marker.length - conjunction.length` characters off the tail of the
    // match. That arithmetic silently assumes orConjunction is a suffix of
    // orMarker — a translator changing one without the other (or a new
    // language lane) must fail here, not produce a mis-split line at runtime.
    for (const lang of LANGS) {
      const marker = renderCopy(lang, 'status.how.orMarker');
      const conjunction = renderCopy(lang, 'status.how.orConjunction');
      expect(marker.endsWith(conjunction), `${lang}: "${marker}" should end with "${conjunction}"`).toBe(true);
    }
  });

  /**
   * These two are the answer to "nothing has started yet" — and they reach
   * the owner on every host, MCP included, where there is no slash command
   * to type. Naming one there is a fake instruction. Slash stays the
   * capability layer; the copy points at plain words, which every host has.
   * Scoped to these two keys on purpose: surfaces that only exist on the
   * gateway may still name a command.
   */
  it('the "not started yet" copy names no slash command, in every lane', () => {
    for (const lang of LANGS) {
      for (const key of ['onboarding.notStarted.hint', 'onboarding.readonly.notStarted']) {
        expect(renderCopy(lang, key), `${lang}: ${key}`).not.toContain('/popclaw');
      }
    }
  });
});
