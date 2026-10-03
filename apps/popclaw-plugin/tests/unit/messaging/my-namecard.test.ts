/**
 * Local namecard assembly under the public client contract: the card is
 * public-fields-only (nickname + pinned declaredAt) — the pre-beta payout
 * surface no longer exists in this build, and the whole-row write protection
 * it used to lean on lives in namecard-write-guard.ts (its own suite).
 */
import { describe, it, expect, vi } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { persistNickname } from '../../../src/onboarding/identity-writer.js';
import {
  loadMyNamecard,
  bumpNamecardDeclaredAt,
  signMyNamecard,
} from '../../../src/messaging/my-namecard.js';
import { makeTestSigner } from '../../helpers/test-signer.js';

describe('loadMyNamecard', () => {
  it('returns null when no nickname has ever been persisted', async () => {
    const host = new InMemoryHostAdapter();
    const card = await loadMyNamecard({ host, now: () => 1000 });
    expect(card).toBeNull();
  });

  it('returns null for a machine placeholder nickname (ranger-xxxxxx)', async () => {
    const host = new InMemoryHostAdapter();
    // Simulate a config that somehow carries the literal placeholder pattern
    // (persistNickname itself never writes one — fallbackName guarantees a
    // real-feeling name — but the gate must hold even if it ever did).
    await host.config.saveJson('plugin', { ranger_profile: { nickname: 'ranger-7gXkQz', name_source: 'auto' } });
    const card = await loadMyNamecard({ host, now: () => 1000 });
    expect(card).toBeNull();
  });

  it('an onboarding-accepted auto-sourced name still counts (not gated on name_source)', async () => {
    const host = new InMemoryHostAdapter();
    await persistNickname(host, '夜行客', 'auto'); // e.g. skip-accepted LLM/fallback name
    const card = await loadMyNamecard({ host, now: () => 1000 });
    expect(card?.nickname).toBe('夜行客');
  });

  it('pins declared_at across repeated calls (no now()-per-call drift)', async () => {
    const host = new InMemoryHostAdapter();
    await persistNickname(host, '青鸾', 'owner');

    let clockValue = 1000;
    const now = () => clockValue;

    const first = await loadMyNamecard({ host, now });
    expect(first?.declaredAt).toBe(1000);

    clockValue = 999_999; // clock moved on; declared_at must NOT follow it
    const second = await loadMyNamecard({ host, now });
    expect(second?.declaredAt).toBe(first?.declaredAt);
  });

  it('carries only the public client fields — no payout surface exists to drop', async () => {
    const host = new InMemoryHostAdapter();
    await persistNickname(host, '青鸾', 'owner');
    const card = await loadMyNamecard({ host, now: () => 1000 });
    expect(card).not.toBeNull();
    expect(Object.keys(card!).sort()).toEqual(['declaredAt', 'nickname']);
    // Pin the shape: a reintroduced field must be a deliberate contract
    // change, not an accidental relapse of the pre-beta wallet surface.
    expect('payoutAddresses' in card!).toBe(false);
  });
});

describe('bumpNamecardDeclaredAt', () => {
  it('is monotonic across a backwards-jumping clock', async () => {
    const host = new InMemoryHostAdapter();
    const first = await bumpNamecardDeclaredAt(host, () => 1000);
    expect(first).toBe(1000);

    // Clock jumped backwards (e.g. container reboot with no RTC).
    const second = await bumpNamecardDeclaredAt(host, () => 500);
    expect(second).toBe(1001); // max(500, 1000 + 1), never goes backwards
  });

  it('advances with a forward-moving clock as usual', async () => {
    const host = new InMemoryHostAdapter();
    await bumpNamecardDeclaredAt(host, () => 1000);
    const next = await bumpNamecardDeclaredAt(host, () => 2000);
    expect(next).toBe(2000);
  });
});

describe('signMyNamecard', () => {
  it('signs the public-only card once, with signed bytes', async () => {
    const signer = makeTestSigner('BlackFeather');
    const sign = vi.spyOn(signer, 'sign');
    const result = await signMyNamecard(signer, { nickname: 'BlackFeather', declaredAt: 1_747_526_400 });
    expect(result.signedPayloadBytes.byteLength).toBeGreaterThan(0);
    expect(sign).toHaveBeenCalled();
  });
});
