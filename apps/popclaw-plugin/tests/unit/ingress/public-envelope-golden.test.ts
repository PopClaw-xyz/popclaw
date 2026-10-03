import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { checkEnvelopeWire, checkPublicEnvelopeStructure, canonicalizeEnvelope, cidFromCanonical, popclaw } from '../../../src/protocol/public-envelope-generated.js';
import { decodeEnvelope } from '../../../src/protocol/public-envelope.js';

// Exact pinned external vectors, not values computed by this implementation.
const vectors = JSON.parse(readFileSync(new URL('../../../../../protocol/packages/contracts/fixtures/public-baseline.json', import.meta.url), 'utf8'));
describe('immutable .3 cross-language vectors through the client facade', () => {
  for (const vector of vectors.wire) it(vector.name, () => {
    const raw = Buffer.from(vector.wire_hex, 'hex');
    for (const [check, accepted] of [[checkEnvelopeWire, vector.structural], [checkPublicEnvelopeStructure, vector.public]] as const) {
      if (accepted) expect(() => check(raw)).not.toThrow();
      else expect(() => check(raw)).toThrow();
    }
  });
  for (const vector of vectors.signed) it(vector.name, () => {
    const raw = Buffer.from(vector.wire_hex, 'hex');
    const envelope = decodeEnvelope(raw), core = canonicalizeEnvelope(envelope);
    expect(Buffer.from(core).toString('hex')).toBe(vector.canonical_hex);
    expect(cidFromCanonical(core)).toBe(vector.cid);
    expect(nacl.sign.detached.verify(core, envelope.signature, Buffer.from(vector.public_key_hex, 'hex'))).toBe(true);
    const wrapped = popclaw.identity.SignedPayload.decode(Buffer.from(vector.signed_payload_hex, 'hex'));
    expect(Buffer.from(wrapped.payload)).toEqual(raw);
    expect(nacl.sign.detached.verify(wrapped.payload, wrapped.signature, wrapped.signerPubkey)).toBe(true);
  });
  it('refuses cryptographically valid reserved wire without stripping signed bytes', () => {
    const vector = vectors.signed_reserved;
    expect(nacl.sign.detached.verify(Buffer.from(vector.canonical_hex, 'hex'), Buffer.from(vector.signature_hex, 'hex'), Buffer.from(vector.public_key_hex, 'hex'))).toBe(true);
    expect(() => decodeEnvelope(Buffer.from(vector.wire_hex, 'hex'))).toThrow('RESERVED_OCCURRENCE');
  });
});
