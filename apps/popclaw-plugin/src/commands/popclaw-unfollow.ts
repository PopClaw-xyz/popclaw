/** /popclaw unfollow <popclaw_id> — revoke a public follow. */

import { renderCopy } from '../lexicon/index.js';
import { RelationWriteUnavailableError, relationRefusalCopyKey } from '../social-graph/social-graph.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import type { SocialGraph } from '../social-graph/social-graph.js';
import { safeRecord, type SocialLogRecorder } from '../social-log/social-log.js';
import { selfWriteRefusal } from '../identity/person-resolver.js';

export interface UnfollowDeps {
  socialGraph: SocialGraph;
  /** Revoke only this owner-selected house; the producer validates its scope. */
  house?: string;
  /** Social-log collection point `follow_removed` (spec 2026-07-26 §4). If not injected, not recorded. */
  socialLog?: SocialLogRecorder;
  /**
   * After an accepted per-house revoke, projects the remaining person-level follow
   * union to the bond. If the union is uncertain, retains its previous state.
   * If not injected, skipped.
   */
  bondsStore?: {
    setFollowed(id: string, v: boolean): unknown;
  };
  /** The owner's own popclaw_id — see `ownPopclawId` in FollowCommandDeps. Required for the same reason. */
  ownPopclawId: string;
  /** See `FollowCommandDeps.houseDisplayName` — the same slug→name resolver, same "never the slug" rule. */
  houseDisplayName?: (slug: string) => string | undefined;
}

/**
 * What actually happened to an unfollow — read this, never the reply text.
 * Same style as follow's `FollowOutcome`, kept as its own type because the two
 * commands stop at different places.
 *
 * - `accepted`: a house took the signed revoke and the local projections
 *   (bonds, social log, house name) ran. The only case whose receipt leads with `✓`.
 * - `queued`: signed and durable, no house has taken it yet; nothing projected.
 * - `refused`: stopped before anything was signed — no target, the owner
 *   themselves, not currently following, a house that offers no relation
 *   operations, or no ordered relation writer in this build.
 * - `failed`: something threw inside the revoke step. `transport: 'accepted'`
 *   means the house had already taken it and a local projection failed
 *   afterwards — do not send it again. `unknown` means it threw before this
 *   layer saw the house accept, so whether it left cannot be told from here.
 */
export type UnfollowOutcome =
  | { kind: 'accepted' }
  | { kind: 'queued' }
  | { kind: 'refused'; reason: 'usage' | 'self' | 'notFollowing' | 'house' | 'writeUnavailable' }
  | { kind: 'failed'; transport: 'accepted' | 'unknown' };

export interface UnfollowReply {
  text: string;
  house?: string;
  outcome: UnfollowOutcome;
  remainingFollowing?: boolean;
  remainingFollowingUnknown?: true;
}

export async function runPopclawUnfollowCommand(
  target: string,
  deps: UnfollowDeps,
): Promise<UnfollowReply> {
  if (!target) return { text: 'usage: /popclaw unfollow <popclaw_id>', outcome: { kind: 'refused', reason: 'usage' } };
  // Ahead of the "not following" answer: that sentence would be a strange way
  // to tell the owner they had asked to unfollow themselves.
  const refusal = selfWriteRefusal(target, deps.ownPopclawId);
  if (refusal) return { text: refusal, outcome: { kind: 'refused', reason: 'self' } };
  // Set only once this layer has seen the house accept the revoke.
  let transportAccepted = false;
  try {
    const outcome = deps.house === undefined
      ? await deps.socialGraph.revokeFollowWithOutcome(target)
      : await deps.socialGraph.revokeFollowWithOutcome(target, { house: deps.house });
    if (outcome.mode === 'none') {
      if (outcome.reason === 'RELATION_NOT_FOLLOWING') {
        return { text: `⚠️ ${renderCopy(ownerLang(), 'relation.notFollowing', { who: target })}`,
          outcome: { kind: 'refused', reason: 'notFollowing' } };
      }
      // Same split as follow: a house that offers no relation operations is
      // not this build failing to have wired them up.
      return {
        text: `⚠️ ${renderCopy(ownerLang(), relationRefusalCopyKey(outcome.reason), { who: target })}`,
        outcome: { kind: 'refused', reason: 'house' },
      };
    }
    if (outcome.transport !== 'accepted') {
      // Durable and waiting; the projections below would claim otherwise.
      // not accepted yet, so no house is named —
      // naming one before it has actually landed there would claim something
      // the transport hasn't confirmed.
      return {
        text: `… ${renderCopy(ownerLang(), 'relation.unfollowQueued', { who: target })}`,
        outcome: { kind: 'queued' },
      };
    }
    transportAccepted = true;
    const houseSlug = outcome.houseSlug;
    // A house-scoped revoke must not erase a follow retained at another house.
    const active = await deps.socialGraph.activeFollowHouses(target);
    const remainingFollowing = active.houses.length > 0;
    const remainingFollowingUnknown = !remainingFollowing && !!active.uncertain;
    if (!remainingFollowingUnknown) deps.bondsStore?.setFollowed(target, remainingFollowing);
    // Social log: the revoke was signed and pushed successfully. "Wasn't following in the first
    // place" already returned above -- that's a call where no action happened.
    // house = the one originally declared to (revokeFollow looks it up from the local ledger;
    // ADR-0037: unfollow takes effect per-house).
    safeRecord(deps.socialLog, {
      kind: 'follow_removed',
      ...(houseSlug ? { house_slug: houseSlug } : {}),
      actor: { id: target },
    });
    // name the house ONLY when it is actually
    // known — never guess. In production `relation-scope.ts` always resolves
    // a slug (falling back to the home house's own), so `houseSlug` undefined
    // here is defensive, not a real path; `relation.unfollowReceivedNoHouse`
    // is the same receipt with the house clause dropped for that case, not a
    // guess. `house` rides along on the return value (still possibly
    // undefined) so a caller that re-renders this same choice with a
    // resolved name#sigil (the MCP tool) doesn't have to re-derive it.
    //
    // `house` is a NAME, never the raw `houseSlug` — see the identical rule
    // in follow.ts (owner acceptance on package 4d07af17).
    const house = houseSlug ? deps.houseDisplayName?.(houseSlug) : undefined;
    const receiptKey = house ? 'relation.unfollowReceived' : 'relation.unfollowReceivedNoHouse';
    const vars: Record<string, string> = { who: target, ...(house ? { house } : {}) };
    const remaining = remainingFollowingUnknown
      ? `\n${renderCopy(ownerLang(), 'relation.unfollowRemainingUnknown', { who: target })}`
      : remainingFollowing ? `\n${renderCopy(ownerLang(), 'relation.unfollowRemaining', { who: target })}` : '';
    return { text: `✓ ${renderCopy(ownerLang(), receiptKey, vars)}${remaining}`, house,
      ...(remainingFollowingUnknown ? { remainingFollowingUnknown: true as const } : { remainingFollowing }),
      outcome: { kind: 'accepted' } };
  } catch (err) {
    if (err instanceof RelationWriteUnavailableError) {
      return {
        text: `⚠️ ${renderCopy(ownerLang(), 'relation.writeUnavailable')}`,
        outcome: { kind: 'refused', reason: 'writeUnavailable' },
      };
    }
    return {
      text: failureText('unfollow', err),
      outcome: { kind: 'failed', transport: transportAccepted ? 'accepted' : 'unknown' },
    };
  }
}
