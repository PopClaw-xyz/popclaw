/**
 * /popclaw review — the morning "people you care about" card (recent
 * activity + major events + tier upgrade/downgrade proposals), and
 * /popclaw review <n> <1|2|3> to decide proposal #n (1 accept -> change tier /
 * 2 reject / 3 think about it later). Text-reply flow (TUI buttons unreliable). §E1/§E2, ADR-0022.
 */
import type { BondsStore } from '../bonds/bonds-store.js';
import type { ProposalsStore } from '../bonds/proposals-store.js';
import { renderReview } from '../bonds/render-review.js';
import { tierLabel } from '../bonds/bond-tier.js';
import { displayNamed, type NameChain } from '../identity/person-name.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';

export interface PopclawReviewArgs {
  positional: string[];
}
export interface PopclawReviewDeps {
  bondsStore: BondsStore;
  proposalsStore: ProposalsStore;
  /** The single name chain; absent → the old behaviour, byte for byte. */
  nameOf?: NameChain;
  /**
   * The follow doorbell's pending store (doorbell spec §6.5 morning-card
   * double insurance). Absent = no "to follow" section — on hosts that run
   * no doorbell the card is byte-for-byte what it always was.
   */
  pendingFollows?: { listPending(): Array<{ display_name: string }> };
}

const DECISION: Record<string, 'accepted' | 'rejected' | 'deferred'> = {
  '1': 'accepted',
  '2': 'rejected',
  '3': 'deferred',
};

export async function runPopclawReviewCommand(
  args: PopclawReviewArgs,
  deps: PopclawReviewDeps,
): Promise<{ text: string }> {
  const lang = ownerLang();
  try {
    const [first, second] = args.positional;

    // Decide path: /popclaw review <n> <1|2|3>
    if (first !== undefined) {
      const n = Number(first);
      const decision = second !== undefined ? DECISION[second] : undefined;
      if (!Number.isInteger(n) || n < 1 || !decision) {
        return { text: renderCopy(lang, 'review.usage') };
      }
      const pending = deps.proposalsStore.listPending();
      const target = pending[n - 1];
      if (!target) {
        return { text: renderCopy(lang, 'review.noSuchProposal', { n: String(n), pending: String(pending.length) }) };
      }
      deps.proposalsStore.decide(target.id, decision);
      // Same three receipts the popclaw_decide_bond_tier_proposal tool prints —
      // one set of keys, not a second copy of the same three sentences.
      if (decision === 'accepted') {
        deps.bondsStore.setTier(target.popclawId, target.toTier, 'manual');
        return {
          text: renderCopy(lang, 'bond.proposal.accepted', {
            who: displayNamed(target.popclawId, deps.nameOf),
            tier: tierLabel(target.toTier, lang),
          }),
        };
      }
      if (decision === 'rejected') {
        return { text: renderCopy(lang, 'bond.proposal.rejected', { tier: tierLabel(target.fromTier, lang) }) };
      }
      return { text: renderCopy(lang, 'bond.proposal.deferred') };
    }

    // Render path: /popclaw review
    const dynamics = deps.bondsStore.unreportedDynamics();
    const proposals = deps.proposalsStore.listPending();
    const text = renderReview({
      dynamics,
      proposals,
      ...(deps.nameOf ? { nameOf: deps.nameOf } : {}),
      // Double insurance for the follow doorbell: whatever is still pending
      // gets one numbered section on the morning card. An empty set renders
      // nothing, so wiring this can only ever add, never change, the card.
      ...(deps.pendingFollows ? { pendingFollows: deps.pendingFollows.listPending() } : {}),
    });
    deps.bondsStore.markDynamicsReported(dynamics.map((d) => d.id));
    return { text };
  } catch (err) {
    return { text: failureText('/popclaw review', err) };
  }
}
