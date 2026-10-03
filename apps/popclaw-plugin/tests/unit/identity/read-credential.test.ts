/**
 * The client half of the golden vectors.
 *
 * Both ends of this protocol build a byte-identical string from their own
 * separately-written code. That is the arrangement that went wrong on CIDs:
 * two implementations, one canonical form described in prose, and a
 * disagreement nobody saw until signatures started failing in the field. So
 * the vectors are not a fixture this code produced and then checked itself
 * against — they were computed by the house's implementation, and what these
 * cases assert is that OUR constructor, given the same inputs, emits the same
 * bytes.
 *
 * The message ends with the origin for a reason, and the IPv6 case is the one
 * that proves it: `http://[::1]:8102` contains colons of its own, and only a
 * field in the last position can afford to.
 *
 * Reading the fixture is deliberate. Restating the expected strings here
 * would make this a test of a copy, and a copy silently goes stale the day
 * the contract moves.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import {
  buildReadCredential,
  readCredentialMessage,
  READ_CREDENTIAL_MAX_TOKEN_CHARS,
  type ReadAudience,
  type ReadPurpose,
} from '../../../src/identity/read-credential.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = resolve(HERE, '../../fixtures/relation-read-v2-vectors.json');

interface Vector {
  readonly name: string;
  readonly purpose: ReadPurpose;
  readonly audience: ReadAudience & { readonly house_key: string };
  readonly ts: number;
  readonly message: string;
  readonly signature_b64: string;
  readonly token: string;
}
const fixture = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  readonly seeds: Record<'requester' | 'house_a' | 'house_b', string>;
  readonly requester_popclaw_id: string;
  readonly positive: readonly Vector[];
};

/** `how_to_recompute`: 32 bytes, the tag's UTF-8 at the front, zero padded. */
function signerFor(tag: string): MasterKeySigner {
  const seed = new Uint8Array(32);
  seed.set(new TextEncoder().encode(tag));
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return new MasterKeySigner({
    seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: bs58.encode(kp.publicKey),
  });
}

describe('the read credential, against the house-computed vectors', () => {
  const signer = signerFor(fixture.seeds.requester);

  it('derives the same identity from the published seed rule', async () => {
    // If this is wrong every case below compares the wrong key's signatures
    // and they all fail together, which reads as "the algorithm is wrong"
    // when the real answer is "we disagree about the seed".
    expect(await signer.popclawId()).toBe(fixture.requester_popclaw_id);
  });

  it('has vectors to check at all', () => {
    // A fixture that silently became an empty list would make every
    // `for` below pass by iterating nothing.
    expect(fixture.positive.length).toBeGreaterThanOrEqual(7);
  });

  for (const v of fixture.positive) {
    it(`builds ${v.name} byte for byte`, async () => {
      const audience = { origin: v.audience.origin, houseKey: v.audience.house_key };
      expect(readCredentialMessage(v.purpose, fixture.requester_popclaw_id, audience, v.ts)).toBe(v.message);

      // The whole token, not just the message: the wire form's own shape
      // (four segments, `v2.`, seconds) is as much the contract as the
      // signed bytes are.
      const token = await buildReadCredential(signer, audience, v.purpose, () => v.ts * 1000);
      expect(token).toBe(v.token);
      expect(token.split('.')).toHaveLength(4);
      expect(token.length).toBeLessThanOrEqual(READ_CREDENTIAL_MAX_TOKEN_CHARS);
    });
  }

  it('reads the clock in seconds, not milliseconds', async () => {
    // The failure this guards is not loud: a millisecond ts passes every
    // syntax rule and fails only the freshness compare, which presents as
    // clock skew — so people go and check NTP, not the unit.
    const token = await buildReadCredential(
      signer,
      { origin: 'https://house.example', houseKey: fixture.requester_popclaw_id },
      'relation-list',
      () => 1_789_650_000_123,
    );
    expect(token.split('.')[2]).toBe('1789650000');
  });
});
