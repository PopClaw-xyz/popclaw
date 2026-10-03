/**
 * Two-stage envelope signing helper.
 *
 * Given an unsigned `EventEnvelope` object (no `eventId`, no `signature`):
 *   1. Canonicalize via the pinned public codec (sets eventId="", signature=b"").
 *   2. Compute event_id = hex(SHA-256(canonical bytes)).
 *   3. Inner signature over the canonical bytes → envelope.signature.
 *   4. Re-encode the now-signed envelope as protobuf bytes.
 *   5. Outer signature over the encoded envelope bytes.
 *   6. Return a `SignedPayload { payload, signature, signer_pubkey }` as bytes.
 *
 * This is the exact flow `EventBuilder.build` has used since Scope A; it lives
 * here so both `EventBuilder` (feed) and `InviteInitiator` can share it without
 * duplicating canonicalization logic.
 */
import { snapshotPublicAuthorEnvelope } from '../protocol/public-author-envelope.js';
import { popclaw, checkEnvelopeWire, canonicalizeEnvelope, cidFromCanonical } from '../protocol/public-envelope-generated.js';
import bs58 from 'bs58';
import type { Signer } from './signer.js';

export interface SignEnvelopeResult {
  /** SignedPayload protobuf bytes, ready to POST to /v1/push. */
  readonly signedPayloadBytes: Uint8Array;
  /** Event CID (hex SHA-256 of canonical bytes). */
  readonly eventId: string;
}

type Pb = {
  event: { EventEnvelope: { encode(m: unknown): { finish(): Uint8Array } } };
  identity: { SignedPayload: { encode(m: unknown): { finish(): Uint8Array } } };
};

export async function signEnvelope(
  signer: Signer,
  envelope: Record<string, unknown>,
): Promise<SignEnvelopeResult> {
  // Reject author fields before the public encoder can discard them. Snapshot
  // before the first await so lookup/sign callbacks cannot change signed data.
  const snapshot = snapshotPublicAuthorEnvelope(envelope);
  checkEnvelopeWire((popclaw as unknown as Pb).event.EventEnvelope.encode(snapshot).finish());
  const popclawId = await signer.popclawId();

  // 1. Canonical bytes (event_id="" + signature=b"") via algorithms.
  const canonical = canonicalizeEnvelope(snapshot);

  // 2. event_id = hex(SHA-256(canonical))
  const eventId = cidFromCanonical(canonical);

  // 3. Inner signature over canonical bytes.
  const innerSig = await signer.sign(canonical);

  // 4. Rebuild envelope with event_id and inner signature set, then re-encode.
  const signedEnvelope: Record<string, unknown> = {
    ...snapshot,
    eventId,
    signature: innerSig,
  };
  const ns = popclaw as unknown as Pb;
  const envelopeBytes = ns.event.EventEnvelope.encode(signedEnvelope).finish();

  // 5. Outer signature over the encoded envelope.
  const outerSig = await signer.sign(envelopeBytes);

  // 6. Wrap as SignedPayload.
  const signedPayloadBytes = ns.identity.SignedPayload.encode({
    payload: envelopeBytes,
    signature: outerSig,
    signerPubkey: bs58.decode(popclawId),
  }).finish();

  return { signedPayloadBytes, eventId };
}
