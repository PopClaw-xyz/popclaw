import { lexiconFor, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/** Bond tier = the relative-value / distance dimension (FP-2). Discrete, ordered enum. */
export const BOND_TIERS = [
  'reject',
  'blocked',
  'stranger',
  'acquaintance',
  'friend',
  'close',
  'close_plus',
] as const;

export type BondTier = (typeof BOND_TIERS)[number];

const RANK: Record<BondTier, number> = {
  reject: 0,
  blocked: 1,
  stranger: 2,
  acquaintance: 3,
  friend: 4,
  close: 5,
  close_plus: 6,
};

export function tierRank(tier: BondTier): number {
  return RANK[tier];
}

/** True if `tier` is at or above `floor` by rank. */
export function isAtLeast(tier: BondTier, floor: BondTier): boolean {
  return RANK[tier] >= RANK[floor];
}

/** Higher-ranked of the two (for peak_tier maintenance). */
export function maxTier(a: BondTier, b: BondTier): BondTier {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * Bond-tier display label in `lang` (defaults to the owner's language).
 * Single source of truth for tier names, out of the lexicon's `terms.tier`
 * table. `commands/popclaw-bond.ts` used to export a `TIER_LABEL` constant —
 * a zh-CN-only snapshot of the same table, kept as a deprecated compat alias
 * for the handful of consumers still out of S3's scope (bond-context.ts,
 * render-review.ts, popclaw-review.ts, the newspaper prompt, the hidden
 * popclaw_list_pending_proposals tool). Rollout slice 6 moved every one of
 * those onto this helper (bond-context.ts fully bilingual via `lang`; the
 * others still zh-only by scope, but now via `tierLabel(tier, 'zh-CN')`
 * instead of the object lookup) and retired `TIER_LABEL` for good.
 */
export function tierLabel(tier: BondTier, lang: Lang = ownerLang()): string {
  return lexiconFor(lang).terms.tier[tier];
}
