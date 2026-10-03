/**
 * The public .3 profile boundary at the signProfile seam: this API can only
 * produce public fields, and a JS caller sneaking extra properties onto the
 * args object can never get them onto the wire (the pre-beta payout surface
 * was removed from the client; house-side preservation is guarded separately
 * in namecard-write-guard.test.ts, and author-object rejection before signing
 * is pinned in public-author-envelope.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { signProfile } from '../../../src/messaging/sign-profile.js';
import { makeTestSigner } from '../../helpers/test-signer.js';
import { popclaw } from '@popclaw/contracts';

describe('signProfile public envelope boundary', () => {
  it('produces a profile payload with only the public client fields', async () => {
    const signer = makeTestSigner('BlackFeather');
    const signed = await signProfile(signer, { nickname: 'BlackFeather', declaredAt: 1_747_526_400 });
    const outer = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes);
    const profile = popclaw.event.EventEnvelope.decode(outer.payload).profile;
    expect(profile?.nickname).toBe('BlackFeather');
    expect(Number(profile?.declaredAt ?? 0)).toBe(1_747_526_400);
    expect('payoutAddresses' in profile!).toBe(false);
  });

  it('extra properties on the args object never reach the wire', async () => {
    const signer = makeTestSigner('BlackFeather');
    // Simulate an untyped JS caller relapsing to the pre-beta shape.
    const args = {
      nickname: 'BlackFeather',
      declaredAt: 1_747_526_400,
      payoutAddresses: [{ chain: 'eip155:31337', address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' }],
    } as Parameters<typeof signProfile>[1];
    const signed = await signProfile(signer, args);
    const outer = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes);
    const profile = popclaw.event.EventEnvelope.decode(outer.payload).profile;
    expect('payoutAddresses' in profile!).toBe(false);
  });
});
