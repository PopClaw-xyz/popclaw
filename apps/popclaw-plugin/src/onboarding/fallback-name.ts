/**
 * Deterministic world-flavoured name for when the LLM is unavailable during
 * onboarding naming. The placeholder `ranger-xxxxxx` must NEVER reach the world
 * (owner decision 2026-06-15: faceless reads as a fake person); a memorable
 * fallback is always better than a machine id. Owners are soft-nagged to
 * personalize it afterwards.
 *
 * S5: the two word lists live in the lexicon (`onboarding.fallbackName.*`), one
 * pair per language, so an English owner is not handed a Chinese name they
 * cannot read out. Determinism is per-language: the same id crossed with the
 * same list always yields the same name.
 *
 * `lang` is a parameter and not just `ownerLang()` because of the bilingual
 * first screen: on a fresh identity we do not yet know which language the
 * owner speaks, so the arrival card is rendered once per lane and each lane
 * needs its own candidate — the Chinese half used to carry the English
 * fallback name ("Night drifter" under Chinese prose, 2026-08-24 smoke).
 */
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

// ponytail: deterministic hash; cross-owner collisions possible, sigil disambiguates.
export function fallbackName(popclawId: string, lang: Lang = ownerLang()): string {
  const adjectives = renderCopy(lang, 'onboarding.fallbackName.adjectives').split('|');
  const nouns = renderCopy(lang, 'onboarding.fallbackName.nouns').split('|');
  const join = renderCopy(lang, 'onboarding.fallbackName.join');

  let h = 2166136261;
  for (let i = 0; i < popclawId.length; i++) {
    h = (h ^ popclawId.charCodeAt(i)) >>> 0;
    h = (h * 16777619) >>> 0;
  }
  // Rotate bits to get an independent second index without dividing
  const h2 = ((h >>> 5) ^ (h << 7)) >>> 0;
  // Non-null: modulo of a non-empty array length is always a valid index.
  const adj = adjectives[h % adjectives.length]!;
  const noun = nouns[h2 % nouns.length]!;
  return adj + join + noun;
}
