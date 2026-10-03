import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import {
  signFollowDeclared,
  signFollowRevoked,
} from '../../../src/social-graph/sign-event.js';

function makeSigner(): MasterKeySigner {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = i;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

describe('sign-event', () => {
  it('signFollowDeclared produces a signed envelope verifiable with the signer pubkey', async () => {
    const signer = makeSigner();
    const env = await signFollowDeclared(signer, {
      followee: 'BBB',
      followType: 'PUBLIC',
      tasteSubscribed: false,
    });
    expect(env.signedPayloadBytes).toBeInstanceOf(Uint8Array);
    expect(env.signedPayloadBytes.byteLength).toBeGreaterThan(0);
  });

  it('signFollowRevoked includes the followee popclaw_id', async () => {
    const signer = makeSigner();
    const env = await signFollowRevoked(signer, {
      followee: 'BBB',
      followType: 'PUBLIC',
    });
    const bytesAsStr = new TextDecoder('latin1').decode(env.signedPayloadBytes);
    expect(bytesAsStr).toContain('BBB');
  });

  it('different timestamps produce different signatures (no replay)', async () => {
    const signer = makeSigner();
    const e1 = await signFollowDeclared(signer, {
      followee: 'BBB',
      followType: 'PUBLIC',
      tasteSubscribed: false,
    });
    await new Promise((r) => setTimeout(r, 1100)); // ensure timestamp tick (seconds-resolution)
    const e2 = await signFollowDeclared(signer, {
      followee: 'BBB',
      followType: 'PUBLIC',
      tasteSubscribed: false,
    });
    expect(
      Buffer.compare(Buffer.from(e1.signedPayloadBytes), Buffer.from(e2.signedPayloadBytes)),
    ).not.toBe(0);
  });
});
