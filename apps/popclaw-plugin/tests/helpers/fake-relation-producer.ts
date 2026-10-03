/**
 * A stand-in for the ordered producer, shaped like the real one.
 *
 * `SocialGraph` no longer signs or pushes a relation itself: the producer owns
 * the whole write — resolve the house, prove the binding, reserve the seq,
 * sign, journal into `follow_events`, push. So a test that wants the graph to
 * behave as if a follow happened has to supply something that does the
 * journalling part, or `following()` projects an empty ledger and the test
 * passes over nothing.
 *
 * It writes the SAME row the real producer writes, including `event_id`, which
 * is what separates an ordered original from the pre-ordering shape this build
 * no longer emits. It does not sign and it does not push — a test asserting
 * that bytes went out is asserting something the producer owns, and should say
 * so by inspecting `pushed` here rather than the graph's egress seam.
 */
import type { HostDb } from '../../src/host/host-db.js';
import type { RelationOutcome, RelationProducer } from '../../src/social-graph/relation-producer.js';

export interface FakeRelationProducer {
  readonly producer: RelationProducer;
  /** Every call, in order, so a test can assert what the graph asked for. */
  readonly calls: { action: 'declare' | 'revoke'; followee: string; tasteSubscribed: boolean }[];
  /** Make the next answer a refusal instead of an ordered original. */
  refuseNext(reason: string): void;
}

export function fakeRelationProducer(opts: {
  db: HostDb;
  /** Which house each followee lands on; undefined = the home house. */
  houseOf?: (followee: string) => string | undefined;
  houseKey?: string;
  /**
   * The transport step, when a test's subject is what reached the wire.
   *
   * NOTE what this stands in for: routing a relation to a house is the real
   * producer's scope resolver, not `houseOf`. Tests that drive routing or
   * receipt handling through here are exercising the seam, not the decision,
   * and their real home is the producer's own suite.
   */
  egressPush?: (bytes: Uint8Array, houseSlug?: string) => Promise<void> | void;
}): FakeRelationProducer {
  const calls: FakeRelationProducer['calls'] = [];
  let seq = 0n;
  let refusal: string | undefined;

  const journal = (action: 'declare' | 'revoke', followee: string, tasteSubscribed: boolean,
                   houseSlug: string | undefined, eventId: string) => {
    opts.db.execute(
      `INSERT OR IGNORE INTO follow_events
         (type, followee, follow_type, taste_subscribed, timestamp, signature, house_slug, event_id)
       VALUES (?, ?, 'PUBLIC', ?, ?, '', ?, ?)`,
      [action === 'declare' ? 'FollowDeclared' : 'FollowRevoked', followee,
       action === 'declare' && tasteSubscribed ? 1 : 0, 1_713_657_600, houseSlug ?? '', eventId],
    );
  };

  const produce = async (action: 'declare' | 'revoke', followee: string,
                         tasteSubscribed: boolean): Promise<RelationOutcome> => {
    calls.push({ action, followee, tasteSubscribed });
    if (refusal !== undefined) {
      const reason = refusal;
      refusal = undefined;
      return { mode: 'none', transport: 'intent_recorded', domain: 'unknown', action, followee,
               reason: 'HOUSE_BINDING_UNPROVEN', detail: reason };
    }
    seq += 1n;
    // An unfollow goes back to the house the follow was declared to — read
    // from the ledger, not re-derived from where that person is visible now.
    // The real producer resolves this through its scope; matching the rule
    // here is what keeps the routing tests about routing.
    const declaredHouse = action === 'revoke'
      ? opts.db.queryOne<{ house_slug: string }>(
          "SELECT house_slug FROM follow_events WHERE followee = ? AND type = 'FollowDeclared' ORDER BY id DESC LIMIT 1",
          [followee])?.house_slug
      : undefined;
    const houseSlug = action === 'revoke'
      ? (declaredHouse ? declaredHouse : undefined)
      : opts.houseOf?.(followee);
    const eventId = `fake-${action}-${followee}-${seq}`;
    journal(action, followee, tasteSubscribed, houseSlug, eventId);
    let failure: { kind: 'transport'; detail: string } | undefined;
    if (opts.egressPush) {
      // The real producer signs, journals, then pushes. A push failure leaves
      // the original DURABLE and queued for resend — it does not throw and it
      // does not unwind the ledger. Same order, same outcome, here.
      try {
        await opts.egressPush(new TextEncoder().encode(eventId), houseSlug);
      } catch (err) {
        failure = { kind: 'transport', detail: String(err) };
      }
    }
    return {
      mode: 'ordered', transport: failure ? 'queued' : 'accepted', domain: 'unknown', action, followee,
      ...(failure ? { failure } : {}),
      ...(houseSlug ? { houseSlug } : {}),
      houseKey: opts.houseKey ?? '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z',
      eventId, seq, anotherEndHasSigned: false,
    };
  };

  return {
    calls,
    refuseNext(reason: string) { refusal = reason; },
    producer: {
      declare: (followee, o) => produce('declare', followee, o?.tasteSubscribed ?? false),
      revoke: (followee) => produce('revoke', followee, false),
      resendPending: async () => [],
    },
  };
}
