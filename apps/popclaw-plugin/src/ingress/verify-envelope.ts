import { decodeEnvelope, canonicalizeEnvelope, checkPublicEnvelopeStructure } from '../protocol/public-envelope.js';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

export interface EnvelopeTrust {
  /** The local recipient on the authenticated private inbox. */
  readonly recipientPopclawId?: string;
  readonly publicStream?: boolean;
  /** Authority of THIS source house, never the union of mounted houses. */
  readonly isOfficialActor?: (actorId: string) => boolean;
}

/** Verify before cursor, decryption, media, persistence or dispatch effects.
 * The stream carries the signed inner envelope; it does not carry the
 * producer's HTTP SignedPayload wrapper. Identity is therefore recovered
 * from the signed actor key and checked against the inner signature. */
export function verifyInboundEnvelope(
  bytes: Uint8Array,
  trust: EnvelopeTrust = {},
): popclaw.event.EventEnvelope {
  if (trust.publicStream) checkPublicEnvelopeStructure(bytes);
  const env = decodeEnvelope(bytes);
  const actor = env.actor?.popclawId ?? '';
  let key: Uint8Array;
  try { key = bs58.decode(actor); } catch { throw new Error('ACTOR_INVALID'); }
  if (key.length !== 32) throw new Error('ACTOR_INVALID');
  const canonical = canonicalizeEnvelope(env);
  if (!env.eventId || cidFromCanonical(canonical) !== env.eventId) throw new Error('CID_MISMATCH');
  if (env.signature.length !== 64 || !nacl.sign.detached.verify(canonical, env.signature, key)) {
    throw new Error('SIGNATURE_INVALID');
  }
  if (env.directMessage) {
    if (trust.publicStream) throw new Error('PRIVATE_PAYLOAD');
    if (env.directMessage.fromPopclawId !== actor) throw new Error('ACTOR_MISMATCH');
    if (!trust.recipientPopclawId || env.directMessage.toPopclawId !== trust.recipientPopclawId) {
      throw new Error('RECIPIENT_MISMATCH');
    }
    const targets = env.target?.targetIds ?? [];
    if (targets.length && !targets.includes(trust.recipientPopclawId)) throw new Error('RECIPIENT_MISMATCH');
  } else if (env.followDeclared || env.followRevoked) {
    // Relations ride the same connection as private messages, so they reach
    // here. Direction is explicit, and it is the only thing that makes the
    // delivery legitimate: an inbound relation must name ME as the followee,
    // and an echo of my own must be signed by me. Reading direction off the
    // frame's routing instead would let the House choose whose edges get
    // written into my graph.
    const followee = (env.followDeclared ?? env.followRevoked)?.followeePopclawId ?? '';
    if (trust.recipientPopclawId) {
      const inbound = followee === trust.recipientPopclawId;
      const ownEcho = actor === trust.recipientPopclawId;
      if (!inbound && !ownEcho) throw new Error('RECIPIENT_MISMATCH');
    }
  } else if (trust.recipientPopclawId) {
    // Everything else still has no business on the personal inbox. The
    // relation branch above widens this deliberately and narrowly; it does not
    // remove the check.
    throw new Error('INBOX_PAYLOAD_MISMATCH');
  }
  // These payloads confer house authority. A valid arbitrary actor signature
  // is insufficient, and another mounted house's official key is not enough.
  if (env.houseEvent || env.questDispatch || env.inviteVerified || env.watchDispatch || env.watchCancel) {
    if (!trust.isOfficialActor?.(actor)) throw new Error('OFFICIAL_SOURCE_MISMATCH');
  }
  return env;
}
