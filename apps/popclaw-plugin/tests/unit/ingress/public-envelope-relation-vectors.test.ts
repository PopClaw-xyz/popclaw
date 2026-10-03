/**
 * The four relation vectors frozen into public-envelope-01.5, driven through
 * the entry points production actually imports: `signEnvelope` (src/identity),
 * the `src/protocol/public-envelope.js` facade, and `@popclaw/contracts` /
 * `@popclaw/algorithms` — never the generated module directly. A test that
 * imports the internal file proves the codec works; this one proves the codec
 * the plugin reaches at runtime works.
 *
 * public-baseline.json, which the neighbouring golden test reads, carries the
 * declared/revoked x order absent/present/empty ineligibility matrix as raw
 * wire cases. These four are the complementary half: real signed originals
 * built by the production signer, proving the same exclusion does not disturb
 * the canonical bytes, the CID or the author signature.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { decodeEnvelope, canonicalizeEnvelope, checkEnvelopeWire, checkPublicEnvelopeStructure } from '../../../src/protocol/public-envelope.js';
import { signEnvelope } from '../../../src/identity/sign-envelope.js';
import { makeTestSigner } from '../../helpers/test-signer.js';

const signer = makeTestSigner('BlackFeather');
const FOLLOWEE = '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM';
// Deliberately NOT the followee. When house_key and followee carry the same
// string, an implementation that fills one from the other emits identical
// bytes and every assertion below is blind to it.
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';
const RESOLVES_A = 'a'.repeat(64);
const RESOLVES_B = 'b'.repeat(64);
// Relation vectors are scoped to one house: `lorehouse` carries the base58
// house key, the same value that appears inside RelationOrder.house_key.
const relationOuter = () => ({
  actor: { popclawId: '11111111111111111111111111111111' },
  target: {},
  lorehouse: HOUSE_KEY,
  timestamp: 1_713_657_600,
});

// Mirrors of gen_fixtures.rs (protocol/packages/contracts/crates/algorithms/
// src/bin/gen_fixtures.rs); any change there must be reflected here.
const ENVELOPES: Record<string, () => Record<string, unknown>> = {
  follow_declared_ordered: () => ({
    ...relationOuter(),
    // resolves [] omitted — an empty repeated field must elide.
    followDeclared: { followeePopclawId: FOLLOWEE, tasteSubscribed: true, order: { seq: 7, houseKey: HOUSE_KEY } },
  }),
  follow_declared_order_present_but_empty: () => ({
    ...relationOuter(),
    followDeclared: { followeePopclawId: FOLLOWEE, tasteSubscribed: true, order: {} },
  }),
  follow_declared_seq_beyond_double: () => ({
    ...relationOuter(),
    // A decimal string, not a BigInt literal: the pinned encoder rejects BigInt
    // and a JS number rounds 2^53+1 down to 2^53, which the domain reads as a
    // different counter entirely.
    followDeclared: { followeePopclawId: FOLLOWEE, order: { seq: '9007199254740993', houseKey: HOUSE_KEY } },
  }),
  follow_revoked_ordered_recovery: () => ({
    ...relationOuter(),
    followRevoked: { followeePopclawId: FOLLOWEE, order: { seq: 9, houseKey: HOUSE_KEY, resolves: [RESOLVES_A, RESOLVES_B] } },
  }),
};
const NAMES = Object.keys(ENVELOPES);

type Vector = { name: string; canonical_bytes_hex: string; cid: string };
const fixtureFile = new URL('../../../../../protocol/packages/contracts/fixtures/test-vectors.json', import.meta.url);
const fixtures = new Map<string, Vector>(
  (JSON.parse(readFileSync(fixtureFile, 'utf8')).canonical_serialization as Vector[]).map(vector => [vector.name, vector]),
);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Sign through the production helper, then read the result back exactly as
 *  world-push-effect.ts does: unwrap SignedPayload, then the facade decode.
 *
 *  Since `.01.6` a relation original is never publicly eligible, ordered or
 *  not. That is a statement about one lane, not about the event: these four
 *  legitimate ordered originals must still pass the generic wire/codec layer
 *  and keep the exact canonical bytes and CID their author signature covers,
 *  which is what every caller below goes on to assert. Both halves are pinned
 *  here so the exclusion can never be mistaken for the relation path itself
 *  having been broken. */
async function roundTrip(envelope: Record<string, unknown>) {
  const signed = await signEnvelope(signer, envelope);
  const raw = new Uint8Array(popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload);
  // The generic layer still accepts it: this is not a wire or codec rejection.
  expect(() => checkEnvelopeWire(raw)).not.toThrow();
  // The public lane does not, whether or not `order` is present.
  expect(() => checkPublicEnvelopeStructure(raw)).toThrow('NOT_PUBLIC');
  const decoded = decodeEnvelope(raw);
  return { signed, decoded, canonical: hex(canonicalizeEnvelope(decoded)) };
}

describe('relation vectors through the runtime facade', () => {
  it('has all four pinned vectors to compare against', () => {
    // Without this, a renamed or dropped fixture would turn every test below
    // into a vacuous pass over an empty set.
    expect(NAMES).toHaveLength(4);
    expect(NAMES.filter(name => fixtures.has(name))).toEqual(NAMES);
    for (const name of NAMES) {
      const vector = fixtures.get(name)!;
      expect(vector.canonical_bytes_hex).toMatch(/^([0-9a-f]{2})+$/);
      expect(vector.cid).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  for (const name of NAMES) it(`${name}: canonical bytes and CID match the pinned vector`, async () => {
    const vector = fixtures.get(name)!;
    const { signed, canonical } = await roundTrip(ENVELOPES[name]!());
    expect(canonical).toBe(vector.canonical_bytes_hex);
    // Two independent production CID paths, both pinned to the same external
    // value rather than to each other.
    expect(signed.eventId).toBe(vector.cid);
    expect(cidFromCanonical(Buffer.from(canonical, 'hex'))).toBe(vector.cid);
  });

  it('keeps an all-default order PRESENT, and distinguishable from no order at all', async () => {
    const present = await roundTrip(ENVELOPES.follow_declared_order_present_but_empty!());
    // A: presence survives the round trip — it is the activation marker for
    // ordered mode, so an encoder that dropped the empty sub-message would
    // silently downgrade the event to legacy.
    expect(present.decoded.followDeclared?.order).not.toBeUndefined();
    expect(present.decoded.followDeclared?.order).not.toBeNull();
    // B: an envelope that really omits `order` must not land on the same bytes.
    const absent = await roundTrip({
      ...relationOuter(),
      followDeclared: { followeePopclawId: FOLLOWEE, tasteSubscribed: true },
    });
    expect(absent.decoded.followDeclared?.order ?? null).toBeNull();
    expect(absent.canonical).not.toBe(present.canonical);
    expect(absent.signed.eventId).not.toBe(present.signed.eventId);
  });

  it('carries seq = 2^53+1 exactly instead of the double it rounds to', async () => {
    const { decoded, signed } = await roundTrip(ENVELOPES.follow_declared_seq_beyond_double!());
    const seq = decoded.followDeclared?.order?.seq;
    expect(seq).not.toBeUndefined();
    // Compared against a literal, never against another value produced by the
    // same decode: two numbers that rounded identically agree on the lie.
    expect(String(seq)).toBe('9007199254740993');
    // 2^53+1 is the first integer a JS Number cannot hold; it rounds DOWN.
    expect(String(seq)).not.toBe('9007199254740992');
    expect(Number.isSafeInteger(Number(String(seq)))).toBe(false);
    expect(signed.eventId).toBe(fixtures.get('follow_declared_seq_beyond_double')!.cid);
  });

  it('keeps house_key and followee apart end to end', async () => {
    // Guard the vector itself first: equal inputs would make the rest pass for
    // the wrong reason.
    expect(HOUSE_KEY).not.toBe(FOLLOWEE);
    const { decoded } = await roundTrip(ENVELOPES.follow_declared_ordered!());
    const declared = decoded.followDeclared;
    expect(declared?.followeePopclawId).toBe(FOLLOWEE);
    expect(declared?.order?.houseKey).toBe(HOUSE_KEY);
    expect(declared?.order?.houseKey).not.toBe(declared?.followeePopclawId);
    expect(String(declared?.order?.seq)).toBe('7');
    expect(declared?.order?.resolves ?? []).toEqual([]);
  });

  it('preserves resolves input order, including the [b,a] case sorting would hide', async () => {
    const ab = await roundTrip(ENVELOPES.follow_revoked_ordered_recovery!());
    expect(ab.decoded.followRevoked?.order?.resolves).toEqual([RESOLVES_A, RESOLVES_B]);
    // The pinned fixture is [a,b], which is already sorted: on its own it
    // cannot catch an implementation that sorts. [b,a] can.
    const ba = await roundTrip({
      ...relationOuter(),
      followRevoked: { followeePopclawId: FOLLOWEE, order: { seq: 9, houseKey: HOUSE_KEY, resolves: [RESOLVES_B, RESOLVES_A] } },
    });
    // A: the input order comes back as given...
    expect(ba.decoded.followRevoked?.order?.resolves).toEqual([RESOLVES_B, RESOLVES_A]);
    // ...and B: it is a genuinely different statement. A sorting encoder would
    // collapse these two onto the same bytes and the same CID.
    expect(ba.canonical).not.toBe(ab.canonical);
    expect(ba.signed.eventId).not.toBe(ab.signed.eventId);
  });
});
