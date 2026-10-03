import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signProfile } from '../../../src/messaging/sign-profile.js';
import { makeTestSigner } from '../../helpers/test-signer.js';
import { popclaw } from '@popclaw/contracts';

const FIXTURES_PATH = resolve(__dirname, '../../../../../protocol/packages/contracts/fixtures/test-vectors.json');
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8')) as {
  canonical_serialization: Array<{ name: string; cid: string }>;
};

describe('signProfile', () => {
  it('signs minimal namecard matching namecard_popclaw_minimal vector', async () => {
    const signer = makeTestSigner('BlackFeather');
    const result = await signProfile(signer, {
      nickname: 'BlackFeather',
      declaredAt: 1_747_526_400,
    });
    const vector = fixtures.canonical_serialization.find(
      (v) => v.name === 'namecard_popclaw_minimal',
    );
    if (!vector) throw new Error('namecard_popclaw_minimal fixture missing');
    expect(result.eventId).toBe(vector.cid);
  });

  it('elides all optional fields when empty (Invariant #1)', async () => {
    const signer = makeTestSigner('BlackFeather');
    const result = await signProfile(signer, {
      nickname: 'BlackFeather',
      declaredAt: 1_747_526_400,
      oneLineIntro: '',
      tasteTags: [],
      rolePersona: '',
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.lorehouse).toBe('');
    expect(env.prevEventId).toBe('');
    expect(env.profile?.nickname).toBe('BlackFeather');
    expect(env.profile?.oneLineIntro).toBe('');
    expect(env.profile?.tasteTags ?? []).toHaveLength(0);
    // Byte-strength check: explicit empty optionals must produce the SAME wire
    // as omitting them — eventId equals the minimal vector's CID.
    const vector = fixtures.canonical_serialization.find(
      (v) => v.name === 'namecard_popclaw_minimal',
    );
    expect(result.eventId).toBe(vector?.cid);
  });

  it('carries full card fields when provided', async () => {
    const signer = makeTestSigner('BlackFeather');
    const result = await signProfile(signer, {
      nickname: '青鸾',
      oneLineIntro: '杭州，AI agent 研究者',
      tasteTags: ['ai-agents', 'rust'],
      rolePersona: 'seeker',
      locationHint: 'Hangzhou',
      declaredAt: 1_747_526_401,
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.profile?.nickname).toBe('青鸾');
    expect(env.profile?.tasteTags).toEqual(['ai-agents', 'rust']);
    expect(env.profile?.rolePersona).toBe('seeker');
    expect(Number(env.profile?.declaredAt)).toBe(1_747_526_401);
    expect(env.actor?.nickname).toBe('青鸾');
  });

  it('rejects empty nickname', async () => {
    const signer = makeTestSigner('BlackFeather');
    await expect(signProfile(signer, { nickname: '   ' })).rejects.toThrow(/nickname/);
  });
});
