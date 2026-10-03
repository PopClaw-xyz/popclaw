/**
 * Notifier types (ADR-0012 three-tier thresholds).
 *
 * L1 immediate interrupt — owner-facing push (MVP degrades to: enqueue + drain on next interaction)
 * L2 write to inbox, wait for the next time the owner speaks — accumulate, deliver next time owner speaks
 * L3 goes into the daily brief — daily-brief content
 *
 * `kind` is the fixed set of categories from ADR-0012 §What (L1 only enforced via runtime check):
 *   - 'dm'                  L1: the owner received a DM
 *   - 'vip_at_or_reply'     L1: a VIP-tier followed person @'d or replied
 *   - 'ranger_verify_done'  L1: ranger verification completed
 *   - 'ranger_verify_fail'  L1: ranger verification failed and needs intervention
 *   - 'followed_you'        L2: someone followed me (ADR-0012 amendment 2026-07-27)
 *   - 'follow_new_post'     L2: a non-VIP followed person posted
 *   - 'taste_match'         L2: a new taste match among follows
 *   - 'reply'               L1 for the first reply / L2 for the rest: an echo replying to something I said (ADR-0012 amendment 2026-07-25)
 *   - 'general_reply'       L2: a general reply
 *   - 'system_notice'       L2: a system maintenance notice
 *   - 'recommendation'      L3: recommendations / discovery / what's trending
 *   - 'onboarding_card'     L1/L2/L3: onboarding-stage push (introduced in O-3b)
 *   - 'bond_proposal'      L2: a tier upgrade the dreamer is proposing
 *   - 'bond_milestone'     L2: a milestone the dreamer picked out
 *   - 'follow_intent'      L2: the newspaper's follow doorbell has pending follows
 *                          (doorbell spec §6.4 leg ② — enqueued by the pull loop
 *                          when the owner may speak before the debounce window
 *                          opens; never a stranger's write, the author-set check
 *                          already ran at absorb time)
 *
 * The two `bond_*` kinds never meet the relative-value gate — not by
 * exemption but by construction. They are assembled from the owner's own bond
 * book overnight, so there is no outside actor for a gate to weigh; the gate
 * lives at the call sites that take in events from other people.
 */

export type NotificationLevel = 'L1' | 'L2' | 'L3';

export type NotificationKind =
  | 'dm'
  | 'vip_at_or_reply'
  | 'ranger_verify_done'
  | 'ranger_verify_fail'
  | 'reply'
  | 'followed_you'
  | 'follow_new_post'
  | 'taste_match'
  | 'general_reply'
  | 'system_notice'
  | 'recommendation'
  | 'onboarding_card'
  | 'bond_proposal'
  | 'bond_milestone'
  | 'follow_intent';

export interface NotificationItem {
  readonly id: number;
  readonly level: NotificationLevel;
  readonly kind: NotificationKind;
  /** Free-form payload; structure depends on `kind`. */
  readonly payload: Record<string, unknown>;
  readonly enqueuedAt: number; // unix seconds
  /** Native delivery claim, absent on MCP offers and legacy notifications. */
  readonly deliveryLeaseToken?: string;
}
