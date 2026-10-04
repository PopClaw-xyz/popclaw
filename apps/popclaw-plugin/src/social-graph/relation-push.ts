/**
 * The relation producer's push channel, and the fence the wiring approval
 * turns on: a receipt is only honest if the push went to THIS original's
 * house, re-verified as of the moment the bytes leave.
 *
 * Two things this adapter refuses to do, both of which the generic egress
 * seams allow today:
 *
 *  - **Fall back to home.** `MultiHouseEgress.pushTo` sends an unknown slug to
 *    the home house (multi-house-egress.ts:69–78, by its own contract). For a
 *    legacy event from an untagged source that fallback is the design; for an
 *    ORDERED original bound to a house key it is a misdelivery — the receipt
 *    would come from a house that never owned the edge, and `markSent` would
 *    close a todo the real house never acknowledged. The adapter resolves the
 *    slug against the SAME strict map the scope resolver uses and refuses
 *    unknowns and conflicts before anything goes out.
 *  - **Trust a stale 'supported'.** Between the scope resolution and this push
 *    the owner may have logged the house out, or the binding may have moved.
 *    The original itself names its house (`order.house_key`, signed), so the
 *    adapter re-checks the CURRENT pin for the destination origin and the
 *    CURRENT participation before every push.
 *
 * Local refusals THROW — the producer's `attempt` turns a throw into a
 * `{kind:'transport'}` failure with this message, the original stays queued,
 * and the ordinary schedule retries it. They are never faked into a server
 * receipt: a refusal this end made is not a status code a house returned.
 */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import { pinnedBinding } from '../world/house-binding-pin.js';
import type { RelationScopeHouse } from './relation-scope.js';
import { buildStrictSlugMap } from './relation-scope.js';
import type { RelationPush } from './relation-producer.js';
import type { PushResult } from '../egress/event-egress.js';

export interface RelationPushDeps {
  readonly db: HostDb;
  /** The same strict slug→origin map the scope resolver was built with. */
  readonly houses: readonly RelationScopeHouse[];
  /**
   * Push to a slug the adapter has ALREADY verified against the strict map.
   * Must return the real receipt — the producer's acceptance rule reads
   * `status`/`eventId` off it verbatim, so a void wrapper here would turn
   * every push into 'unacknowledged'.
   */
  readonly pushVerified: (slug: string, bytes: Uint8Array) => Promise<PushResult>;
}

export function makeRelationPush(deps: RelationPushDeps): RelationPush {
  return async (bytes, houseSlug) => {
    const map = buildStrictSlugMap(deps.houses);
    const slug = houseSlug ?? map.homeSlug;
    if (slug === undefined) {
      throw new Error('relation push refused: no houses are configured');
    }
    const house = map.lookup(slug);
    if (house === undefined) {
      throw new Error(
        `relation push refused: house '${slug}' is not in the current configuration — the original stays queued rather than re-routing`,
      );
    }
    if ('conflict' in house) {
      throw new Error(
        `relation push refused: the configuration maps '${slug}' to more than one origin`,
      );
    }

    // THIS original's house, re-verified now. The house key comes from the
    // signed bytes, not from the scope resolution that may be stale. The bytes
    // are a SignedPayload (the outer wrapper sign-event produces) — the
    // envelope rides INSIDE it; decoding the wrapper directly as an envelope
    // walks off the wire format at the payload boundary ("invalid wire type 7",
    // the live follow failure), and the tests never caught it because their
    // fixtures handed over bare envelope bytes.
    const sp = popclaw.identity.SignedPayload.decode(bytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload as Uint8Array);
    const order = env.followDeclared?.order ?? env.followRevoked?.order;
    if (order && order.houseKey) {
      const pin = pinnedBinding(deps.db, house.origin);
      if (!pin) {
        throw new Error(`relation push refused: no pinned binding for ${house.origin}`);
      }
      if (pin.blockedReason) {
        throw new Error(`relation push refused: ${house.origin}'s pin is blocked (${pin.blockedReason})`);
      }
      if (pin.houseKey !== order.houseKey) {
        throw new Error(
          `relation push refused: the original is bound to house key ${order.houseKey.slice(0, 8)}… but ${house.origin}'s pin holds ${pin.houseKey.slice(0, 8)}…`,
        );
      }
      const part = deps.db.queryOne<{ active: number }>(
        'SELECT active FROM relation_participation WHERE house_key = ?',
        [order.houseKey],
      );
      if (!part || part.active !== 1) {
        throw new Error(
          `relation push refused: no active participation for the original's house — logged out since it was signed?`,
        );
      }
    }

    return deps.pushVerified(slug, bytes);
  };
}
