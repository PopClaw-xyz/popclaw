/**
 * The personal inbox's own admission rule for relation frames.
 *
 * The House serves relations down the same connection as private messages, so
 * `verifyInboundEnvelope` is the first thing a relation frame meets. Its
 * non-DM branch used to refuse EVERY non-DM payload on an authenticated inbox,
 * which meant a correctly signed Follow addressed to this owner was rejected
 * before any relation code could see it — and the rejection was reported as a
 * wire error, so a stream carrying nothing but refused relations looked the
 * same as a healthy quiet one.
 *
 * The widening is deliberate and narrow. It does NOT drop the recipient check
 * and does NOT let arbitrary non-DM payloads onto the inbox: a relation is
 * admitted only when this owner is actually a party to it. Direction is read
 * from the SIGNED followee and the SIGNED actor, never from how the frame was
 * routed — deriving it from routing would let the House choose whose edges get
 * written here.
 */
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import type { Signer } from '../../../src/identity/signer.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { verifyInboundEnvelope } from '../../../src/ingress/verify-envelope.js';
import { signEnvelope } from '../../../src/identity/sign-envelope.js';

/**
 * Real identities, not the canonical-parity fixtures: those override
 * `popclawId` to a pinned string that is not the base58 of their own key, and
 * every assertion here depends on the signature actually verifying against
 * the actor it names.
 */
function realSigner(seedByte: number): Signer {
  const seed = new Uint8Array(32).fill(seedByte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return new MasterKeySigner({
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  });
}

const author = realSigner(1);
const owner = realSigner(2);
const stranger = realSigner(3);
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

/** The inbox stream carries the INNER envelope, not the push wrapper. */
async function envelopeBytesOf(signer: Signer, body: Record<string, unknown>): Promise<Uint8Array> {
  const signed = await signEnvelope(signer, {
    actor: { popclawId: await signer.popclawId() },
    target: {},
    timestamp: 1_713_657_600,
    ...body,
  });
  return new Uint8Array(popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload);
}

async function signedFollow(
  signer: Signer,
  followeePopclawId: string,
  body: 'declared' | 'revoked' = 'declared',
): Promise<Uint8Array> {
  const payload = { followeePopclawId, order: { seq: '3', houseKey: HOUSE_KEY } };
  return envelopeBytesOf(signer, {
    lorehouse: HOUSE_KEY,
    ...(body === 'declared' ? { followDeclared: payload } : { followRevoked: payload }),
  });
}

/** A signed non-DM, non-relation payload: the case that must STAY refused. */
async function signedPost(signer: Signer): Promise<Uint8Array> {
  return envelopeBytesOf(signer, { post: {} });
}

describe('a relation frame on the authenticated personal inbox', () => {
  it('admits a Follow that names this owner as the followee', async () => {
    const me = await owner.popclawId();
    const env = verifyInboundEnvelope(await signedFollow(author, me), { recipientPopclawId: me });
    // Admitted AND intact: the followee survives, so a later stage reads the
    // signed direction rather than re-deriving it.
    expect(env.followDeclared?.followeePopclawId).toBe(me);
    expect(env.followDeclared?.order?.houseKey).toBe(HOUSE_KEY);
  });

  it('admits an Unfollow that names this owner as the followee', async () => {
    const me = await owner.popclawId();
    const env = verifyInboundEnvelope(await signedFollow(author, me, 'revoked'), { recipientPopclawId: me });
    expect(env.followRevoked?.followeePopclawId).toBe(me);
  });

  it("admits the echo of this owner's OWN follow of somebody else", async () => {
    const me = await owner.popclawId();
    const them = await stranger.popclawId();
    // Not addressed to me as followee — but I signed it, and the House owes me
    // my own original back on my personal stream.
    const env = verifyInboundEnvelope(await signedFollow(owner, them), { recipientPopclawId: me });
    expect(env.followDeclared?.followeePopclawId).toBe(them);
    expect(env.actor?.popclawId).toBe(me);
  });

  it('refuses a relation between two other parties', async () => {
    const me = await owner.popclawId();
    const them = await stranger.popclawId();
    // Correctly signed, genuinely valid — and none of my business. A House
    // that relays it is trying to write an edge into my graph.
    await expect(
      signedFollow(author, them).then((b) => verifyInboundEnvelope(b, { recipientPopclawId: me })),
    ).rejects.toThrow('RECIPIENT_MISMATCH');
  });

  it('still refuses a non-DM, non-relation payload on the inbox', async () => {
    const me = await owner.popclawId();
    // The widening must be the relation branch only. If this ever passes, the
    // inbox has been opened to everything.
    await expect(
      signedPost(author).then((b) => verifyInboundEnvelope(b, { recipientPopclawId: me })),
    ).rejects.toThrow('INBOX_PAYLOAD_MISMATCH');
  });

  it('still refuses a relation whose signature does not match its actor', async () => {
    const me = await owner.popclawId();
    const bytes = await signedFollow(author, me);
    // Flip one byte of the signature. Admission must not have moved ahead of
    // verification: a tampered frame is refused for the signature, not
    // admitted because its followee reads correctly.
    const tampered = Uint8Array.from(bytes);
    const at = tampered.length - 1;
    tampered[at] = tampered[at]! ^ 1;
    expect(() => verifyInboundEnvelope(tampered, { recipientPopclawId: me })).toThrow();
    // and the untampered original is genuinely admitted, so the case above
    // cannot be passing for the wrong reason
    expect(() => verifyInboundEnvelope(bytes, { recipientPopclawId: me })).not.toThrow();
  });
});
