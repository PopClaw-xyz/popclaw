/**
 * Deterministic test signers for fixture-identity vectors.
 *
 * Two named fixtures are supported:
 *
 *   BlackFeather — popclaw_id = 7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM
 *   Scout        — popclaw_id = 6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM
 *
 * These popclaw_ids appear in the post_root_minimal / post_quote_minimal
 * canonical-serialization fixtures (test-vectors.json). The CID is computed
 * solely from canonical bytes, which do NOT include the signature — so only
 * the popclawId string (not the private key) affects CID output.
 *
 * Implementation: construct a MasterKey directly with a deterministic seed
 * (no external state) but override popclawId to the fixture value so that
 * canonicalizeEnvelope() embeds the correct actor.popclawId in the wire bytes.
 */
import nacl from 'tweetnacl';
import type { Signer } from '../../src/identity/signer.js';
import { MasterKeySigner } from '../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../src/identity/keystore.js';

/**
 * #227 added `sealDm`/`openDm` to Signer. Spread this into the many inline
 * test fakes that never send or receive a DM, so they satisfy the interface
 * without pretending to do crypto: sealing is a loud failure (the send path's
 * contract), opening reports the typed failure the delivery loop expects.
 */
export const noDmCrypto = {
  sealDmMedia(): never { throw new Error('not wired for this fake'); },
  openDmMedia() { return { ok: false, reason: 'decrypt_failed' } as never; },
  sealDm(): never {
    throw new Error('test signer: sealDm not wired for this fake');
  },
  openDm() {
    return { ok: false, reason: 'decrypt_failed' } as const;
  },
};

const FIXTURES: Record<string, { seed: Uint8Array; popclawId: string }> = {
  BlackFeather: {
    // Deterministic seed: all bytes = 0xBF. The actual signing key does not
    // affect CID; only popclawId matters for canonical serialization parity.
    seed: new Uint8Array(32).fill(0xbf),
    popclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
  },
  Scout: {
    // Deterministic seed: all bytes = 0x5c.
    seed: new Uint8Array(32).fill(0x5c),
    popclawId: '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM',
  },
};

/**
 * Return a Signer whose popclawId() matches the named fixture identity.
 *
 * The signer uses a real Ed25519 keypair (so signatures are valid), but the
 * popclawId is overridden to the fixture value so that CID-parity tests pass.
 */
export function makeTestSigner(name: string): Signer {
  const f = FIXTURES[name];
  if (!f) throw new Error(`makeTestSigner: unknown fixture name "${name}". Known: ${Object.keys(FIXTURES).join(', ')}`);

  const kp = nacl.sign.keyPair.fromSeed(f.seed);
  const key: MasterKey = {
    seed: f.seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: f.popclawId, // override — canonical parity depends on this string
  };
  return new MasterKeySigner(key);
}
