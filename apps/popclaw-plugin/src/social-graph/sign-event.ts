/**
 * Wrap signEnvelope to produce signed FollowDeclared / FollowRevoked envelopes.
 * Encoded as protobuf via the existing pbjs runtime; bytes ready for /v1/push.
 *
 * Invariant #1 (proto3 defaults must be elided on the wire — see Plan 5/7
 * memory): for PUBLIC follows the FollowType enum is 0 and SubscriptionVisibility
 * is 0, both default values. pbjs would serialize them as explicit zero bytes
 * if present in the JS object, but prost (Rust) elides defaults — the resulting
 * CIDs would mismatch and lore-house would reject with `cid_mismatch`. So we
 * MUST omit any field whose value is its proto3 default.
 *
 * Default values for these payload fields:
 *   - follow_type:                   0 (PUBLIC)        → omit when PUBLIC
 *   - taste_subscribed:              false             → omit when false
 *   - taste_subscription_visibility: 0 (SV_PUBLIC)     → always omit (no path
 *     in Plan 11.1 sets this non-default; Phase 4 will revisit when private
 *     taste subscription lands)
 */

import { signEnvelope, type SignEnvelopeResult } from '../identity/sign-envelope.js';
import type { Signer } from '../identity/signer.js';
import { MAX_RELATION_SEQ } from './relation-allocator.js';
import type { FollowType } from './state-projection.js';

/**
 * The ordering and scope this action is signed under. Present =
 * ordered mode; absent = legacy, and the field elides so every legacy CID is
 * byte-identical to what it was before ordered mode existed.
 *
 * `resolves` is deliberately absent from this type: a non-empty `resolves`
 * makes the event a fork recovery, which the relation contract refuses to apply as an
 * ordinary Follow or Unfollow. There is no ordinary-action path that should be
 * able to set it by accident, so it is not offered here at all.
 */
export interface RelationOrderArgs {
  /** Per-edge counter, from RelationAllocator. Effective domain 1..=2^63-1. */
  readonly seq: bigint;
  /** base58 HouseBinding.house_key of the house this action is scoped to. */
  readonly houseKey: string;
}

export interface FollowDeclaredArgs {
  readonly followee: string;
  readonly followType: FollowType;
  readonly tasteSubscribed: boolean;
  readonly order?: RelationOrderArgs;
}

export interface FollowRevokedArgs {
  readonly followee: string;
  readonly followType: FollowType;
  readonly order?: RelationOrderArgs;
}

/**
 * Encode `order` for protobufjs, or return undefined for legacy mode.
 *
 * `seq` goes out as a DECIMAL STRING, and that is not a style choice.
 * protobufjs does not accept a BigInt for a uint64 field and silently encodes
 * **0** — which is not a rounding error but precisely the value the relation contract calls
 * illegal new format, so the receiving house would refuse the event and the
 * author would have burned a seq on bytes nobody can apply. A JS Number is no
 * better above 2^53, where it stops being able to represent its own successor.
 *
 * The domain is enforced here, at the last point before bytes exist: seq 0 is
 * indistinguishable from unset inside a present `order`, and anything above
 * 2^63-1 lands in a Postgres BIGINT as a negative number, after which
 * comparison runs backwards in both directions.
 */
function orderToProto(order: RelationOrderArgs | undefined): Record<string, unknown> | undefined {
  if (!order) return undefined;
  if (order.seq < 1n || order.seq > MAX_RELATION_SEQ) {
    throw new Error(`RELATION_SEQ_OUT_OF_DOMAIN: ${order.seq}`);
  }
  if (!order.houseKey) throw new Error('RELATION_ORDER_HOUSE_KEY_REQUIRED');
  // `resolves` omitted: an empty repeated field must elide, and this path
  // never signs a recovery.
  return { seq: order.seq.toString(), houseKey: order.houseKey };
}

const FOLLOW_TYPE_TO_PROTO_INT = { PUBLIC: 0, PRIVATE: 1 } as const;

export async function signFollowDeclared(
  signer: Signer,
  args: FollowDeclaredArgs,
): Promise<SignEnvelopeResult> {
  const followDeclared: Record<string, unknown> = {
    followeePopclawId: args.followee,
  };
  const ft = FOLLOW_TYPE_TO_PROTO_INT[args.followType];
  if (ft !== 0) followDeclared.followType = ft;
  if (args.tasteSubscribed) followDeclared.tasteSubscribed = true;
  // taste_subscription_visibility defaults to 0 (SV_PUBLIC); always omit
  // until Phase 4 introduces taste-subscription wiring.
  const order = orderToProto(args.order);
  if (order) followDeclared.order = order;

  const env: Record<string, unknown> = {
    actor: { popclawId: await signer.popclawId() },
    timestamp: Math.floor(Date.now() / 1000),
    followDeclared,
  };
  return signEnvelope(signer, env);
}

export async function signFollowRevoked(
  signer: Signer,
  args: FollowRevokedArgs,
): Promise<SignEnvelopeResult> {
  const followRevoked: Record<string, unknown> = {
    followeePopclawId: args.followee,
  };
  const ft = FOLLOW_TYPE_TO_PROTO_INT[args.followType];
  if (ft !== 0) followRevoked.followType = ft;
  const order = orderToProto(args.order);
  if (order) followRevoked.order = order;

  const env: Record<string, unknown> = {
    actor: { popclawId: await signer.popclawId() },
    timestamp: Math.floor(Date.now() / 1000),
    followRevoked,
  };
  return signEnvelope(signer, env);
}
