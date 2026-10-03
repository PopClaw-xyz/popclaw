/**
 * Sigil derivation + input parsing for the plugin — the single entry point;
 * downstream passport/invite-link builders derive through `deriveSigil`, so
 * they follow the canonical alphabet/length automatically (ADR-0015).
 *
 * `deriveSigil` is a thin re-export of `@popclaw/algorithms::sigil` at the
 * canonical `SIGIL_LEN` (same function the lore-house uses for
 * `expected_sigil`). `parseSigilInput` normalizes untrusted resolve input
 * (follow refs, profile command args, wallet invitee tokens) and enforces
 * the 6-12 char prefix-match window.
 *
 * Canonical formula:
 *   sigil(popclaw_id, len) = crockford32_lower(SHA-256(popclaw_id utf-8 bytes))[..len]
 * Test vector: `deriveSigil("BlackFeather") === "gdx8rgtp"`.
 */
import { sigil, SIGIL_LEN, normalizeSigilInput } from '@popclaw/algorithms';

// Normalization is itself part of identity resolution (local sources need to reverse-look-up by the "folded nickname"), so it's re-exported through this single entry point.
export { normalizeSigilInput };

export function deriveSigil(popclawIdBase58: string): string {
  return sigil(popclawIdBase58, SIGIL_LEN);
}

/** Resolve input length window (ADR-0015 global constraints). */
const SIGIL_INPUT_MIN_LEN = 6;
const SIGIL_INPUT_MAX_LEN = 12;

/**
 * Parse untrusted sigil/prefix input: normalize (trim/lowercase/fold
 * o->0,i->1,l->1, reject out-of-alphabet incl. u), then enforce the 6-12
 * char resolve window. Returns the normalized sigil, or null if invalid.
 */
export function parseSigilInput(raw: string): string | null {
  const norm = normalizeSigilInput(raw);
  if (norm === null) return null;
  if (norm.length < SIGIL_INPUT_MIN_LEN || norm.length > SIGIL_INPUT_MAX_LEN) return null;
  return norm;
}
