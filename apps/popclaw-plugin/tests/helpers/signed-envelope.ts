import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { canonicalizeEnvelope } from '../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import type { popclaw } from '@popclaw/contracts';

/** Deterministic real signatures for transport tests; labels live in the body. */
export function signedFixtureEnvelope(label: string): popclaw.event.IEventEnvelope {
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
  const env = { actor: { popclawId: bs58.encode(key.publicKey) }, timestamp: 1, post: { blocks: [{ content: label }] } };
  const canonical = canonicalizeEnvelope(env);
  return { ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, key.secretKey) };
}
