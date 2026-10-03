/**
 * Deterministic markdown for the morning "people you care about" review card
 * (§E2). No LLM — dynamic summaries are already produced by the dreamer, this
 * only formats. v1 sections: recent (tier>=friend, non-milestone) + milestones
 * (milestone, any tier) + proposals (pending tier upgrades with 1/2/3). A
 * "block an old friend" ping is a deferred follow-on.
 */
import { isAtLeast, tierLabel, type BondTier } from './bond-tier.js';
import { displayNamed, type NameChain } from '../identity/person-name.js';
import type { BondProposal } from './proposals-store.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

export interface ReviewDynamic {
  id: number;
  popclawId: string;
  tier: BondTier;
  remarkName: string;
  ts: number;
  summary: string;
  isMilestone: boolean;
}

export interface RenderReviewInput {
  dynamics: readonly ReviewDynamic[];
  proposals: readonly BondProposal[];
  /** The single name chain; absent → the server-given name, then the sigil alone. */
  nameOf?: NameChain;
  /**
   * Follow-doorbell pending rows (doorbell spec §6.5, the morning-card half
   * of the double insurance): non-empty renders one more numbered section
   * with its reply syntax at the foot. Plain data on purpose — this renderer
   * stays deterministic and store-free; the caller reads the store when it
   * can reach one. Names render verbatim `name#sigil` as stored, the one
   * string every other doorbell surface also shows.
   */
  pendingFollows?: ReadonlyArray<{ display_name: string }>;
}

// One rule for both, and the same one every other surface follows: show the
// name chain (name plus sigil), never a slice of a raw popclaw_id. A bare
// prefix is unreadable, unsayable, and — the reason it actually matters —
// indistinguishable from somebody else's prefix.
function who(d: ReviewDynamic, nameOf?: NameChain): string {
  return displayNamed(d.popclawId, nameOf, d.remarkName);
}
function whoProposal(p: BondProposal, nameOf?: NameChain): string {
  return displayNamed(p.popclawId, nameOf);
}

export function renderReview(input: RenderReviewInput): string {
  const lang = ownerLang();
  const milestones = input.dynamics.filter((d) => d.isMilestone);
  const recent = input.dynamics.filter((d) => !d.isMilestone && isAtLeast(d.tier, 'friend'));

  const lines: string[] = [renderCopy(lang, 'review.card.header'), ''];

  if (milestones.length > 0) {
    lines.push(renderCopy(lang, 'review.card.milestonesHeader'));
    for (const d of milestones) {
      lines.push(renderCopy(lang, 'review.card.milestoneLine', { who: who(d, input.nameOf), summary: d.summary }));
    }
    lines.push('');
  }
  if (recent.length > 0) {
    lines.push(renderCopy(lang, 'review.card.recentHeader'));
    for (const d of recent) {
      lines.push(
        renderCopy(lang, 'review.card.recentLine', {
          who: who(d, input.nameOf),
          tier: tierLabel(d.tier, lang),
          summary: d.summary,
        }),
      );
    }
    lines.push('');
  }
  if (milestones.length === 0 && recent.length === 0) {
    lines.push(renderCopy(lang, 'review.card.noUpdates'), '');
  }

  if (input.proposals.length > 0) {
    lines.push(renderCopy(lang, 'review.card.proposalsHeader'));
    input.proposals.forEach((p, i) => {
      const n = i + 1;
      lines.push(
        `${n}. ` +
          renderCopy(lang, 'review.card.proposalLine', {
            who: whoProposal(p, input.nameOf),
            fromTier: tierLabel(p.fromTier, lang),
            toTier: tierLabel(p.toTier, lang),
            rationale: p.rationale,
          }) +
          ` — \`/popclaw review ${n} 1\``,
      );
    });
    lines.push('');
  }

  // Last on purpose: the card's native business (dynamics, proposals) first,
  // the doorbell's fallback insurance last. Same shape as the proposals
  // section — numbered, own reply syntax at the foot.
  const pendingFollows = input.pendingFollows ?? [];
  if (pendingFollows.length > 0) {
    lines.push(renderCopy(lang, 'review.card.pendingHeader'));
    pendingFollows.forEach((p, i) => {
      lines.push(renderCopy(lang, 'review.card.pendingLine', { n: String(i + 1), name: p.display_name }));
    });
    lines.push(renderCopy(lang, 'review.card.pendingSyntax'));
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
