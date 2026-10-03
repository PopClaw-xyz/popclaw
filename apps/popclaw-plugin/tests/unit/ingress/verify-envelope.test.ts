import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { verifyInboundEnvelope } from '../../../src/ingress/verify-envelope.js';

const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
const actor = bs58.encode(key.publicKey);
function signed(body: Record<string, unknown>) {
  const env = { actor: { popclawId: actor }, timestamp: 123, ...body };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({ ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, key.secretKey) }).finish();
}

describe('inbound envelope trust before side effects', () => {
  it('accepts a real signed DM only for its recipient with actor/from consistency', () => {
    const bytes = signed({ directMessage: { fromPopclawId: actor, toPopclawId: 'local', body: 'sealed' } });
    expect(verifyInboundEnvelope(bytes, { recipientPopclawId: 'local' }).actor?.popclawId).toBe(actor);
    expect(() => verifyInboundEnvelope(bytes, { recipientPopclawId: 'other' })).toThrow('RECIPIENT_MISMATCH');
    expect(() => verifyInboundEnvelope(bytes, { publicStream: true })).toThrow('NOT_PUBLIC');
    const forgedFrom = signed({ directMessage: { fromPopclawId: 'other', toPopclawId: 'local' } });
    expect(() => verifyInboundEnvelope(forgedFrom, { recipientPopclawId: 'local' })).toThrow('ACTOR_MISMATCH');
  });

  it('rejects false CID and invalid signature even if the envelope parses', () => {
    const bytes = signed({ post: { blocks: [{ content: 'hi' }] } });
    const env = popclaw.event.EventEnvelope.decode(bytes);
    env.eventId = '0'.repeat(64);
    expect(() => verifyInboundEnvelope(popclaw.event.EventEnvelope.encode(env).finish())).toThrow('CID_MISMATCH');
    const bad = popclaw.event.EventEnvelope.decode(bytes);
    bad.signature[0] = bad.signature[0]! ^ 1;
    expect(() => verifyInboundEnvelope(popclaw.event.EventEnvelope.encode(bad).finish())).toThrow('SIGNATURE_INVALID');
  });

  it('requires the receiving house authority for official payloads; arbitrary user posts remain valid', () => {
    const official = signed({ houseEvent: { kind: 'example.notice' } });
    expect(() => verifyInboundEnvelope(official)).toThrow('OFFICIAL_SOURCE_MISMATCH');
    expect(() => verifyInboundEnvelope(official, { isOfficialActor: () => false })).toThrow('OFFICIAL_SOURCE_MISMATCH');
    expect(verifyInboundEnvelope(official, { isOfficialActor: id => id === actor }).eventId).toBeTruthy();
    expect(verifyInboundEnvelope(signed({ post: { blocks: [{ content: 'hi' }] } })).eventId).toBeTruthy();
  });
});
