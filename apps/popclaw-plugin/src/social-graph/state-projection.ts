/**
 * Pure projection from append-only event logs to materialized state.
 * Only public follow/revoke events contribute to this projection.
 */

export type FollowType = 'PUBLIC' | 'PRIVATE';

export interface FollowDeclaredEvent {
  type: 'FollowDeclared';
  followee: string;
  followType: FollowType;
  tasteSubscribed: boolean;
  timestamp: number;             // seconds since epoch
  signature: string;             // base64
  /** Spec B slice ③: the house this follow was declared to (the one where they were found). Empty = the home house. */
  houseSlug?: string;
}

export interface FollowRevokedEvent {
  type: 'FollowRevoked';
  followee: string;
  followType: FollowType;
  timestamp: number;
  signature: string;
  /** The same house it was originally declared to (an unfollow must go back to the original house). Empty = the home house. */
  houseSlug?: string;
}

export type DeclaredEvent = FollowDeclaredEvent | FollowRevokedEvent;

export interface FollowingEntry {
  popclawId: string;
  followType: FollowType;
  tasteSubscribed: boolean;
  since: number;
  /**
   * The house this follow declaration was sent to. `''` = unknown origin
   * (a pre-migration-014 legacy row, or the person wasn't in any house's
   * cache at the time of the follow) — see `followsInHouse`'s handling of
   * the empty string.
   */
  houseSlug: string;
}

export interface SocialGraphState {
  schemaVersion: 1;
  rebuiltAt: number;             // ms
  popclawId: string;
  /** Person-level union: one entry per person (ADR-0037 layer 2, "DM closeness looks at the person, not the house"). */
  following: FollowingEntry[];
  /** House-level: key = house_slug (`''` = unknown origin). ADR-0037 layer 1, "a declaration belongs to a house." */
  followingByHouse: Map<string, FollowingEntry[]>;
}

/** The projection key — ADR-0037: the house is a dimension of "fact," and a follow declaration is a fact. */
function keyOf(houseSlug: string, followee: string): string {
  return `${houseSlug}\0${followee}`;
}

/**
 * Replay events in insertion order; latest event wins per
 * `(followee, house_slug, type)`.
 *
 * **The dual key is necessary** (ADR-0037 Consequences): in the old
 * followee-only-keyed projection, a FollowRevoked from ANY house would
 * `delete` the whole person — follow them in the `me` house, unfollow them
 * in the `world` house, and the `me`-house follow would also evaporate from
 * the local projection (feed weighting / DM gate / status would all go
 * blind to it), even though the house side still remembered it.
 */
export function projectState(
  myPopclawId: string,
  declared: readonly DeclaredEvent[],
): SocialGraphState {
  // Outgoing (me → others), dual-keyed by (followee, house_slug)
  const rows = new Map<string, FollowingEntry>();
  for (const ev of declared) {
    if (ev.followType !== 'PUBLIC') continue;     // Public events only.
    const houseSlug = ev.houseSlug ?? '';
    const key = keyOf(houseSlug, ev.followee);
    if (ev.type === 'FollowDeclared') {
      rows.set(key, {
        popclawId: ev.followee,
        followType: 'PUBLIC',
        tasteSubscribed: ev.tasteSubscribed,
        since: ev.timestamp,
        houseSlug,
      });
    } else if (ev.type === 'FollowRevoked') {
      rows.delete(key);
    }
  }

  const newestFirst = (a: FollowingEntry, b: FollowingEntry) => b.since - a.since;
  const all = [...rows.values()].sort(newestFirst);

  const followingByHouse = new Map<string, FollowingEntry[]>();
  for (const e of all) {
    const list = followingByHouse.get(e.houseSlug);
    if (list) list.push(e);
    else followingByHouse.set(e.houseSlug, [e]);
  }

  // Person-level union: one entry per person, keeping the most recent
  // declaration (the display convention for "most recently followed");
  // tasteSubscribed is true if it's true in any house.
  const union = new Map<string, FollowingEntry>();
  for (const e of all) {
    const prev = union.get(e.popclawId);
    if (!prev) union.set(e.popclawId, { ...e });
    else if (e.tasteSubscribed) prev.tasteSubscribed = true;
  }

  return {
    schemaVersion: 1,
    rebuiltAt: Date.now(),
    popclawId: myPopclawId,
    following: [...union.values()].sort(newestFirst),
    followingByHouse,
  };
}

/**
 * House-level check (ADR-0037, "content attention looks at the house"): used
 * by feed weighting / the daily paper / recommend.
 *
 * Matches strictly per house. A row with an empty house_slug (a legacy row,
 * or the person wasn't in any cache at follow time) means the **home
 * house** — those events genuinely landed in the home house via
 * `pushRouted(…, undefined, …)` — the normalization happens at
 * `SocialGraph.normalizeHouse`'s projection entry point, so by the time it
 * gets here it's already a real house name.
 * Deliberately NOT relaxed to "counts in any house": that would give someone
 * I follow in the `me` house follow-weighting on content they post in the
 * `world` house too, which is exactly the cross-house noise ADR-0037 exists
 * to eliminate.
 */
export function followsInHouse(
  state: SocialGraphState,
  popclawId: string,
  houseSlug: string | undefined,
): boolean {
  if (!popclawId) return false;
  return (state.followingByHouse.get(houseSlug ?? '') ?? []).some((e) => e.popclawId === popclawId);
}
