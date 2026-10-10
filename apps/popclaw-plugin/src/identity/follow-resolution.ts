/**
 * Identity resolution — turn a human-readable follow reference into a
 * decision: follow this popclaw_id, or show candidates to pick from.
 *
 * Pure logic: the lore-house `/v1/resolve` call is injected as `resolve`, so
 * this is unit-testable without a network. Surfaces (slash command + the
 * popclaw_follow tool) format the result.
 */
import bs58 from 'bs58';
import { deriveSigil, parseSigilInput } from '../invite/sigil.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/** A resolved identity candidate (mirrors lore-house `/v1/resolve`). */
export interface ResolveCandidate {
  readonly popclawId: string;
  readonly nickname: string;
  readonly sigil: string;
  readonly profiles: ReadonlyArray<{
    platform: string;
    handle: string;
    followerCount: number;
  }>;
}

export type IdVerification =
  | { status: 'verified'; nickname: string; sigil: string }
  | { status: 'unknown'; sigil: string }
  | { status: 'offline'; sigil: string };

/**
 * Confirm a raw popclaw_id is a real jianghu identity by resolving its derived
 * sigil and checking a returned candidate has exactly this id. A typo's sigil
 * differs from the real id's, so it can't match → 'unknown'. `sigilOf` is
 * injected (default deriveSigil) to keep this pure/testable.
 */
export async function verifyPopclawId(
  popclawId: string,
  resolve: (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null>,
  sigilOf: (id: string) => string = deriveSigil,
): Promise<IdVerification> {
  const result = await resolveIdCandidate(popclawId, resolve, sigilOf);
  return result.status === 'verified'
    ? { status: 'verified', nickname: result.candidate.nickname, sigil: result.sigil }
    : result;
}

/** Keep verification and candidate material from the same lookup. */
async function resolveIdCandidate(
  popclawId: string,
  resolve: (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null>,
  sigilOf: (id: string) => string = deriveSigil,
) {
  const sigil = sigilOf(popclawId);
  const cands = await resolve({ sigil });
  if (cands === null) return { status: 'offline' as const, sigil };
  const match = cands.find((c) => c.popclawId === popclawId);
  return match
    ? { status: 'verified' as const, candidate: match, sigil }
    : { status: 'unknown' as const, sigil };
}

export type ParsedTarget =
  | { kind: 'popclawId'; popclawId: string }
  | { kind: 'sigil'; sigil: string; name?: string }
  | { kind: 'name'; name: string };

function isFullPopclawId(s: string): boolean {
  try {
    return bs58.decode(s).length === 32; // Ed25519 pubkey
  } catch {
    return false;
  }
}

/**
 * Classify a follow reference. Precedence: `name#sigil` / bare sigil → sigil
 * (precise key); a 32-byte base58 string → popclaw_id (precise); anything else
 * → name (fuzzy). Sigils are lowercased so a pasted `#4F68BD` still resolves.
 */
export function parseFollowTarget(input: string): ParsedTarget {
  const t = input.trim();

  // name#sigil (the canonical popclaw.me/<handle>#<sigil> shape).
  const hash = t.lastIndexOf('#');
  if (hash > 0) {
    const name = t.slice(0, hash).trim();
    const sig = parseSigilInput(t.slice(hash + 1));
    if (sig !== null) return name ? { kind: 'sigil', sigil: sig, name } : { kind: 'sigil', sigil: sig };
  }

  // bare sigil (`#4f68bd8k` or `4f68bd8k`).
  const bare = parseSigilInput(t.startsWith('#') ? t.slice(1) : t);
  if (bare !== null) return { kind: 'sigil', sigil: bare };

  if (isFullPopclawId(t)) return { kind: 'popclawId', popclawId: t };

  return { kind: 'name', name: t };
}

export type FollowResolution =
  | { kind: 'follow'; popclawId: string; candidate?: ResolveCandidate; unverified?: 'unknown' | 'offline'; sigil?: string }
  | {
      kind: 'choose';
      candidates: ResolveCandidate[];
      /**
       * These candidates came from the sigil→name fallback below: the owner
       * typed something that parsed as a sigil, no sigil matched, and this is
       * what a *name substring* search turned up instead. They are a guess at
       * what was meant, not a match on what was typed — so a lone candidate
       * must never be auto-selected downstream (#287).
       */
      guessed?: true;
    }
  | { kind: 'empty'; ref: string }
  | { kind: 'lantern' };

/** lowercase + strip whitespace, so equivalent-looking names collapse to the same key — '苍梧居士' / '苍 梧' / 'ELON' collapse. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * Resolve `input` to a follow decision. `resolve` queries lore-house
 * `/v1/resolve` and returns candidates, or `null` when the lore-house is unreachable.
 *
 * Rule (ADR-0028): precise key (sigil / popclaw_id) with a unique hit →
 * follow; fuzzy key (name) or a sigil collision → choose; nothing → empty.
 */
export async function resolveFollowTarget(
  input: string,
  resolve: (q: { sigil?: string; name?: string }) => Promise<ResolveCandidate[] | null>,
): Promise<FollowResolution> {
  const p = parseFollowTarget(input);

  if (p.kind === 'popclawId') {
    const v = await resolveIdCandidate(p.popclawId, resolve);
    if (v.status === 'verified') {
      return { kind: 'follow', popclawId: p.popclawId, candidate: v.candidate };
    }
    return { kind: 'follow', popclawId: p.popclawId, unverified: v.status, sigil: v.sigil };
  }

  if (p.kind === 'sigil') {
    const cands = await resolve({ sigil: p.sigil });
    if (cands === null) return { kind: 'lantern' };
    let matched = cands;
    if (p.name) {
      // name#sigil: the name disambiguates a (rare) sigil collision.
      const n = norm(p.name);
      const narrowed = cands.filter((c) => norm(c.nickname).includes(n));
      if (narrowed.length > 0) matched = narrowed;
    }
    if (matched.length === 0) {
      // Crockford base32 (ADR-0015) maps i/l/o onto digits, so a bare
      // handle typed without a leading '#' can fold into something that
      // *looks* like a valid sigil (e.g. "alice2" → "a11ce2") even though
      // the owner meant a name. If that folded sigil misses AND the input
      // wasn't an explicit `#...` AND there's no name#sigil component
      // (both signal precise intent), retry as a name search on the
      // ORIGINAL text — not the folded sigil — so real handles still work.
      const explicitHash = input.trim().startsWith('#');
      if (!p.name && !explicitHash) {
        const original = input.trim();
        const nameCands = await resolve({ name: original });
        if (nameCands === null) return { kind: 'lantern' };
        if (nameCands.length === 0) return { kind: 'empty', ref: original };
        // `guessed`: nothing matched the sigil the input folded into; these
        // are name-substring hits on the raw text. Crockford folds i/l/o onto
        // digits, so plenty of Latin handles parse as valid sigils — which
        // means a lone hit here can be a stranger who merely shares a
        // substring with whatever the owner typed. Downstream this must cost
        // a confirmation, not a silent selection.
        return { kind: 'choose', candidates: nameCands, guessed: true };
      }
      return { kind: 'empty', ref: `#${p.sigil}` };
    }
    const only = matched[0];
    if (matched.length === 1 && only) return { kind: 'follow', popclawId: only.popclawId, candidate: only };
    return { kind: 'choose', candidates: matched };
  }

  // Fuzzy key → always let the owner pick, even on a single hit.
  const cands = await resolve({ name: p.name });
  if (cands === null) return { kind: 'lantern' };
  if (cands.length === 0) return { kind: 'empty', ref: p.name };
  return { kind: 'choose', candidates: cands };
}

/**
 * Render candidates for the owner to pick. Each line is `nickname#sigil` so the next
 * follow/unfollow is a precise key (re-issue `关注 苍梧居士#4f68bd` → unique → auto).
 *
 * `action` picks the verb: the same ambiguous-name prompt is shown for both
 * popclaw_follow and popclaw_unfollow (N2 — an unfollow prompt must never read
 * back the follow example, or picking it would re-follow the person instead).
 */
export function formatCandidateList(
  candidates: ResolveCandidate[],
  lang: Lang = ownerLang(),
  action: 'follow' | 'unfollow' = 'follow',
): string {
  const lines = candidates.map((c, i) => {
    const accts = c.profiles.map((p) => `${p.platform} @${p.handle}`).join('·');
    return `${i + 1}. ${c.nickname}#${c.sigil}${accts ? `（${accts}）` : ''}`;
  });
  const first = candidates[0];
  const exampleKey = action === 'unfollow' ? 'unfollow.candidateExample' : 'follow.candidateExample';
  const headerKey = action === 'unfollow' ? 'unfollow.candidateHeader' : 'follow.candidateHeader';
  const example = first ? renderCopy(lang, exampleKey, { who: `${first.nickname}#${first.sigil}` }) : '';
  const header = renderCopy(lang, headerKey, { count: String(candidates.length), example });
  return [header, ...lines].join('\n');
}
