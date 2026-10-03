/**
 * Relative-value gate — ADR-0012 amendment (2026-06-14).
 *
 * Only actors in the owner's social graph are candidates for a notification.
 * Strangers are dropped (anti-spam). This refines ADR-0012's original
 * "(1) owner receives a DM → L1" to "graph-member DM → L1; stranger DM → silent".
 *
 * ponytail: graph membership only. Full VIP-tier scoring (ADR-0012 §VIP, cap 30,
 * interaction-weighted) is deferred until social-weight-principles lands.
 */

import type { NotificationKind } from './types.js';

export interface GraphLike {
  /**
   * ADR-0037: the gate uses a **person-level union** (followed on any one
   * house = a person inside the graph). DM closeness looks at the person, not
   * the house — `SocialGraph.following()` is exactly that union view.
   */
  following(): ReadonlyArray<{ popclawId: string }>;
}

/** True if `actorPopclawId` is someone the owner follows (on any house). */
export function isInOwnerGraph(actorPopclawId: string, graph: GraphLike): boolean {
  if (!actorPopclawId) return false;
  return graph.following().some((f) => f.popclawId === actorPopclawId);
}

/**
 * Notification kinds that are naturally outside the graph, but whose event
 * itself is the value — the gate **explicitly exempts** them.
 *
 * `followed_you`: a new follower is almost certainly outside bond-book ∪
 * follows (they just met me, I haven't met them yet). Without the exemption,
 * new-follower notifications would be dropped entirely, making the feature
 * effectively nonexistent.
 */
const GATE_EXEMPT_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>(['followed_you']);

/**
 * The single gate: every "should this interrupt the owner" decision passes
 * through here.
 *
 * `isMountedHouseOfficial` (optional) = mounting a house means knowing it: the
 * owner writing a house into `lore_houses` is explicit consent to receive
 * that house's official messages (ADR-0041). A house's official account is
 * inevitably a "stranger" to a new owner;
 * without this leg, the world-house's postcards/return letters would be
 * silently dropped. Not passing it → behavior identical to before, byte for byte.
 */
export function passesRelativeValueGate(
  kind: NotificationKind,
  actorPopclawId: string,
  graph: GraphLike,
  isMountedHouseOfficial?: (actorPopclawId: string) => boolean,
  /**
   * The receptionist's fact card (ADR-0046). Not passing it = behavior
   * identical to before, byte for byte (an honest degrade for test stubs /
   * when not yet wired up).
   *
   * **A block is a one-vote veto that overrides every exemption** — including
   * `GATE_EXEMPT_KINDS` and the follow relationship. A ready-made bug from a
   * real machine on 2026-07-31: `bond block` only changed the tier and left
   * the follow table untouched, and this gate only looked at
   * `isInOwnerGraph`, so **someone who was followed and then blocked still got
   * pushed to the owner's phone as L1**. The daily paper already understood
   * this rule (`gather-materials` states explicitly "not a single blocked
   * person should appear"), but notifications didn't — this is exactly the
   * cost of scattering the same criterion across multiple places.
   *
   * Only the `blocked` field is used here: the remaining facts (tier /
   * followed / official account) are left to the "how much information to
   * give" layer. ADR-0012 states explicitly that "bond tier does **not**
   * participate in notification gating this cycle — it is only used for
   * sorting and tagging brief material." Letting closeness leverage the
   * interruption rate is exactly the "interruption frequency slipping out of
   * the owner's control" that ADR was written to prevent. The receptionist
   * does not touch that red line.
   */
  verdict?: { blocked: boolean; verifiedFollowerCount?: number },
  /**
   * External standing that earns a stranger the right to interrupt: a verified
   * account whose follower snapshot reaches this many.
   * The owner sets it in `cadence`; `0` or absent turns the exemption off, and
   * absent means this function behaves exactly as it did before.
   *
   * Why an exemption at all: a well-known person writing to you is the case
   * where "stranger → silence" is most obviously wrong. Why a number the owner
   * owns rather than one we pick in code: interruption frequency belongs to the
   * owner (ADR-0012), and a follower count is the one unforgeable-looking
   * signal you can actually buy (ADR-0046) — the line between "worth waking
   * you" and "bought their way in" is a judgement, and it is his.
   */
  vipExternalFollowerThreshold?: number,
): boolean {
  if (verdict?.blocked === true) return false;
  if (GATE_EXEMPT_KINDS.has(kind)) return true;
  if (isInOwnerGraph(actorPopclawId, graph)) return true;
  if (isMountedHouseOfficial?.(actorPopclawId) === true && actorPopclawId.length > 0) return true;
  return (
    (vipExternalFollowerThreshold ?? 0) > 0 &&
    (verdict?.verifiedFollowerCount ?? 0) >= vipExternalFollowerThreshold!
  );
}
