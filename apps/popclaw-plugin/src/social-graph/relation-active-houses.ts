import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { MAX_RELATION_SEQ } from './relation-allocator.js';

export interface ActiveRelationHouses {
  readonly houses: readonly (string | undefined)[];
  readonly uncertain?: 'RELATION_ACTIVE_STATE_UNCERTAIN';
  /** Absent with uncertain means the missing namespace cannot be localized. */
  readonly uncertainHouses?: readonly (string | undefined)[];
}
interface Position { seq: bigint; eventId: string; following: boolean }
interface Namespace {
  routes: Set<string | undefined>;
  local?: Position;
  applied?: Position;
  uncertain: boolean;
}

/** Read local intent, not remote agreement. Only positions within the same
 * house key can supersede each other. Missing/conflicting evidence is never
 * converted into an empty set that would authorize a new default edge. */
export function activeRelationHouses(db: HostDb, followee: string, owner: string): ActiveRelationHouses {
  if (!owner) return { houses: [], uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN' };
  return db.transaction((tx): ActiveRelationHouses => {
    const namespaces = new Map<string, Namespace>();
    const namespace = (key: string) => {
      let value = namespaces.get(key);
      if (!value) { value = { routes: new Set(), uncertain: false }; namespaces.set(key, value); }
      return value;
    };
    const ledger = new Map<string | undefined, { type: string; event_id: string | null; house_key: string | null }>();
    for (const row of tx.queryAll<{ house_slug: string; type: string; event_id: string | null; house_key: string | null }>(
      `SELECT f.house_slug,f.type,f.event_id,o.house_key FROM follow_events f
       LEFT JOIN relation_outbox o ON o.event_id=f.event_id
       WHERE f.followee=? AND f.follow_type='PUBLIC' ORDER BY f.id`, [followee])) {
      ledger.set(row.house_slug || undefined, row);
    }
    // Include historical routes: one key under two routes must not silently
    // merge independent House choices just because the key was reused.
    for (const row of tx.queryAll<{ house_key: string; house_slug: string | null }>(
      'SELECT DISTINCT house_key,house_slug FROM relation_outbox WHERE followee_popclaw_id=?', [followee])) {
      namespace(row.house_key).routes.add(row.house_slug || undefined);
    }
    for (const row of tx.queryAll<{ house_key: string; event_id: string; seq: string; signed_payload: Uint8Array }>(
      `SELECT o.house_key,o.event_id,CAST(o.seq AS TEXT) AS seq,o.signed_payload
       FROM relation_outbox o WHERE o.followee_popclaw_id=? AND o.seq=(
         SELECT MAX(i.seq) FROM relation_outbox i
         WHERE i.house_key=o.house_key AND i.followee_popclaw_id=o.followee_popclaw_id)`, [followee])) {
      const ns = namespace(row.house_key);
      try {
        const signed = popclaw.identity.SignedPayload.decode(row.signed_payload);
        const env = popclaw.event.EventEnvelope.decode(signed.payload as Uint8Array);
        const payload = env.followDeclared ?? env.followRevoked;
        const seq = BigInt(row.seq);
        if (!payload || env.actor?.popclawId !== owner || payload.followeePopclawId !== followee ||
          env.eventId !== row.event_id || payload.order?.houseKey !== row.house_key ||
          BigInt(String(payload.order.seq)) !== seq || seq < 1n || seq > MAX_RELATION_SEQ ||
          payload.followType !== 0 || (payload.order.resolves?.length ?? 0) !== 0) throw new Error('Invalid original');
        const position = { seq, eventId: row.event_id, following: env.followDeclared != null };
        if (ns.local && (ns.local.seq !== position.seq || ns.local.eventId !== position.eventId ||
          ns.local.following !== position.following)) ns.uncertain = true;
        else ns.local = position;
      } catch { ns.uncertain = true; }
    }
    for (const row of tx.queryAll<{ house_key: string; state: string; seq: string | null; applied_event_id: string | null; conflicted: number }>(
      `SELECT house_key,state,CAST(applied_seq AS TEXT) AS seq,applied_event_id,conflicted
       FROM relation_edges WHERE follower_popclaw_id=? AND followee_popclaw_id=?`, [owner, followee])) {
      const ns = namespace(row.house_key);
      if (row.conflicted || row.seq === null || !row.applied_event_id || !['following', 'revoked'].includes(row.state)) ns.uncertain = true;
      else ns.applied = { seq: BigInt(row.seq), eventId: row.applied_event_id, following: row.state === 'following' };
    }
    const highKnown = (ns: Namespace) => {
      const local = ns.local?.seq ?? 0n, applied = ns.applied?.seq ?? 0n;
      return local > applied ? local : applied;
    };
    for (const row of tx.queryAll<{ house_key: string; signed: string; observed: string }>(
      'SELECT house_key,CAST(signed AS TEXT) AS signed,CAST(observed AS TEXT) AS observed FROM relation_seq WHERE followee_popclaw_id=?', [followee])) {
      const ns = namespace(row.house_key), known = highKnown(ns);
      if (BigInt(row.signed) > known || BigInt(row.observed) > known) ns.uncertain = true;
    }
    for (const row of tx.queryAll<{ house_key: string; seq: string }>(
      `SELECT house_key,CAST(MAX(seq) AS TEXT) AS seq FROM relation_event_log
       WHERE follower_popclaw_id=? AND followee_popclaw_id=? AND seq IS NOT NULL
       AND verdict IN ('pending','fork_branch') GROUP BY house_key`, [owner, followee])) {
      const ns = namespace(row.house_key);
      if (BigInt(row.seq) > highKnown(ns)) ns.uncertain = true;
    }
    // Pins locate namespaces already evidenced for this target; an unrelated
    // pin (including a broken one) must not create an edge or veto this action.
    for (const row of tx.queryAll<{ house_key: string; origin: string }>('SELECT house_key,origin FROM house_binding_pin')) {
      const ns = namespaces.get(row.house_key);
      if (!ns) continue;
      try { ns.routes.add(hostDbSlug(row.origin)); }
      catch { ns.uncertain = true; }
    }
    // Fill an absent original route from the same durable pinned namespace,
    // never from the current home or a contact's history.
    for (const ns of namespaces.values()) {
      if (ns.routes.size === 2 && ns.routes.has(undefined)) ns.routes.delete(undefined);
    }
    const active = new Set<string | undefined>(), uncertain = new Set<string | undefined>();
    const covered = new Set<string | undefined>();
    const keysByRoute = new Map<string | undefined, Set<string>>();
    let globalUnknown = false;
    for (const [key, ns] of namespaces) {
      // Pins alone are routing metadata, not evidence of any relation.
      if (!ns.local && !ns.applied && !ns.uncertain) continue;
      for (const route of ns.routes) {
        const keys = keysByRoute.get(route) ?? new Set<string>(); keys.add(key); keysByRoute.set(route, keys);
        covered.add(route);
      }
      if (ns.routes.size !== 1 || ns.routes.has(undefined)) {
        ns.uncertain = true;
        if (!ns.routes.size || ns.routes.has(undefined)) globalUnknown = true;
      }
      if (ns.local && ns.applied && ns.local.seq === ns.applied.seq &&
        (ns.local.eventId !== ns.applied.eventId || ns.local.following !== ns.applied.following)) ns.uncertain = true;
      const latest = ns.local && (!ns.applied || ns.local.seq > ns.applied.seq) ? ns.local : ns.applied;
      for (const route of ns.routes) {
        if (ns.uncertain) uncertain.add(route);
        else if (latest?.following) active.add(route);
      }
    }
    for (const [route, keys] of keysByRoute) if (keys.size > 1) uncertain.add(route);
    for (const [storedRoute, row] of ledger) {
      const routes = row.house_key ? namespaces.get(row.house_key)?.routes : undefined;
      const route = storedRoute === undefined && routes?.size === 1 ? [...routes][0] : storedRoute;
      if (!covered.has(route)) {
        if (row.event_id) uncertain.add(route);
        else if (row.type === 'FollowDeclared') active.add(route);
      } else if (!row.event_id || !row.house_key) {
        // An unpositioned latest row cannot be ordered against a signed chain.
        uncertain.add(route);
      }
    }
    for (const route of uncertain) active.delete(route);
    const houses = [...active];
    return globalUnknown ? { houses, uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN' } : uncertain.size
      ? { houses, uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN', uncertainHouses: [...uncertain] }
      : { houses };
  });
}
