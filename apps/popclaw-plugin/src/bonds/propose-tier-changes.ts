/**
 * Daily proposal generator (follow-on ③, §E1): from the master's recent
 * OUTGOING-interaction density, propose a ONE-STEP tier upgrade for people who
 * crossed a threshold. Up-only; dedupe vs pending; 7-day cooldown after a
 * reject/defer. The master confirms in the review card. ADR-0022.
 */
import type { BondsStore } from './bonds-store.js';
import type { ProposalsStore } from './proposals-store.js';
import type { BondTier } from './bond-tier.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

const FRIEND_THRESHOLD = 3; // recent interactions to suggest acquaintance→friend
const CLOSE_THRESHOLD = 10; // recent interactions to suggest friend→close
const INTERACTION_WINDOW_SECS = 30 * 24 * 3600;
const COOLDOWN_SECS = 7 * 24 * 3600;

/** One-step upgrade target if the recent-interaction count crosses a threshold. */
function upgradeFor(tier: BondTier, count: number): BondTier | null {
  if (tier === 'acquaintance' && count >= FRIEND_THRESHOLD) return 'friend';
  if (tier === 'friend' && count >= CLOSE_THRESHOLD) return 'close';
  return null; // reject/blocked/stranger/close/close_plus → no auto-proposal
}

export interface ProposeDeps {
  bondsStore: BondsStore;
  proposalsStore: ProposalsStore;
  now: () => number; // seconds
}

/** One proposal as it was just created — enough to tell the owner about it without a second read. */
export interface CreatedProposal {
  popclawId: string;
  fromTier: BondTier;
  toTier: BondTier;
  rationale: string;
}

/**
 * Generate upgrade proposals; returns the ones created.
 *
 * The proposals themselves, not a count: the dreamer has to be able to tell the
 * owner *who* it is proposing about, and re-reading them back out of the store
 * to find that out would be a second pass over data we are holding right here.
 */
export function proposeTierChanges(deps: ProposeDeps): CreatedProposal[] {
  const { bondsStore, proposalsStore, now } = deps;
  const sinceTs = now() - INTERACTION_WINDOW_SECS;
  const created: CreatedProposal[] = [];
  for (const bond of bondsStore.list({})) {
    const count = bondsStore.recentInteractionCount(bond.popclawId, sinceTs);
    const toTier = upgradeFor(bond.tier, count);
    if (!toTier) continue;

    const last = proposalsStore.lastFor(bond.popclawId, toTier);
    if (last) {
      if (last.status === 'pending') continue; // already awaiting a decision
      // accepted means the tier already moved (upgradeFor wouldn't fire), but guard anyway:
      if (last.status === 'accepted') continue;
      // rejected / deferred → respect cooldown
      if ((last.decidedAt ?? last.createdAt) + COOLDOWN_SECS > now()) continue;
    }

    // A count on its own reads like a meter reading. The dreamer already wrote
    // down what this person has been up to — carrying the latest line means the
    // owner is deciding about a person, not about a number.
    const latest = bondsStore.recentDynamics(bond.popclawId, 1)[0]?.summary?.trim();
    const lang = ownerLang();
    const proposal = {
      popclawId: bond.popclawId,
      fromTier: bond.tier,
      toTier,
      rationale: latest
        ? renderCopy(lang, 'bond.proposal.rationaleWith', { count: String(count), what: latest })
        : renderCopy(lang, 'bond.proposal.rationale', { count: String(count) }),
    };
    proposalsStore.add(proposal);
    created.push(proposal);
  }
  return created;
}
