import { describe, expect, it } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { decodeEnvelope, canonicalizeEnvelope, checkPublicEnvelopeStructure } from '../../../src/protocol/public-envelope.js';

describe('fixed public envelope consumption', () => {
  const ordinary = () => popclaw.event.EventEnvelope.encode({ post: { blocks: [{ content: 'hello' }] } }).finish();
  it('rejects original reserved and unknown occurrences before decoding', () => {
    for (const tail of [[234, 1, 0], [162, 6, 0]]) {
      expect(() => decodeEnvelope(Uint8Array.from([...ordinary(), ...tail]))).toThrow();
    }
    const profile = popclaw.event.EventEnvelope.encode({ profile: {} }).finish();
    // Empty Profile field 8 inside the original body, including explicit zero.
    expect(() => decodeEnvelope(Uint8Array.from([226, 1, 2, 64, 0]))).toThrow('RESERVED_OCCURRENCE');
    expect(() => decodeEnvelope(profile)).not.toThrow();
  });
  it('rejects duplicate singular values and duplicate oneofs', () => {
    expect(() => decodeEnvelope(Uint8Array.from([...ordinary(), 34, 0, 34, 0]))).toThrow();
    expect(() => decodeEnvelope(Uint8Array.from([...ordinary(), ...ordinary()]))).toThrow();
  });
  it('retains legal unknown event bytes without interpreting business JSON', () => {
    const raw = popclaw.event.EventEnvelope.encode({ houseEvent: { kind: 'future-game.update_1', body: Uint8Array.of(255, 0) } }).finish();
    expect(checkPublicEnvelopeStructure(raw)).toBe(34);
    expect(Array.from(decodeEnvelope(raw).houseEvent!.body!)).toEqual([255, 0]);
  });
  it('elides implicit defaults consistently in signed canonical bytes', () => {
    expect(canonicalizeEnvelope({ post: {} })).toEqual(canonicalizeEnvelope({ post: {}, timestamp: 0 }));
  });
});
