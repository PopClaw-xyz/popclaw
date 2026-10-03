import { describe, it, expect } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { makeTestSigner } from '../../helpers/test-signer.js';
import { signMark, signMarkRevoked } from '../../../src/messaging/sign-mark.js';

const VALID_HEX64 = 'a'.repeat(64);

describe('signMark', () => {
  it('produces a signed envelope with mark.markedEventId populated', async () => {
    const signer = makeTestSigner('BlackFeather');
    const result = await signMark(signer, {
      markedEventId: VALID_HEX64,
      nickname: 'BlackFeather',
      ts: 1700000000,
    });

    expect(result.signedPayloadBytes).toBeInstanceOf(Uint8Array);
    expect(result.signedPayloadBytes.byteLength).toBeGreaterThan(0);

    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);

    expect(env.mark).toBeTruthy();
    expect(env.mark!.markedEventId).toBe(VALID_HEX64);
    expect(env.lorehouse).toBe('');
    expect(env.actor?.nickname).toBe('BlackFeather');
    expect(env.actor?.popclawId).toBe(await signer.popclawId());
    expect(Number(env.timestamp)).toBe(1700000000);
  });

  it('eventId is a 64-char hex digest and matches the decoded envelope', async () => {
    const signer = makeTestSigner('Scout');
    const result = await signMark(signer, {
      markedEventId: VALID_HEX64,
      nickname: 'Scout',
    });

    // signedPayloadBytes round-trips and the signature is present
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    expect(sp.signature).toBeInstanceOf(Uint8Array);
    expect(sp.signature.byteLength).toBeGreaterThan(0);

    expect(result.eventId).toMatch(/^[0-9a-f]{64}$/);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.eventId).toBe(result.eventId);
  });

  it('uses provided ts when given', async () => {
    const signer = makeTestSigner('BlackFeather');
    const result = await signMark(signer, {
      markedEventId: VALID_HEX64,
      nickname: 'BlackFeather',
      ts: 1713657700,
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(Number(env.timestamp)).toBe(1713657700);
  });

  it('throws when nickname is empty', async () => {
    const signer = makeTestSigner('BlackFeather');
    await expect(
      signMark(signer, { markedEventId: VALID_HEX64, nickname: '' }),
    ).rejects.toThrow(/nickname/);
  });

  it('throws when nickname is whitespace only', async () => {
    const signer = makeTestSigner('BlackFeather');
    await expect(
      signMark(signer, { markedEventId: VALID_HEX64, nickname: '   ' }),
    ).rejects.toThrow(/nickname/);
  });

  it('throws when markedEventId is not 64 lowercase hex', async () => {
    const signer = makeTestSigner('BlackFeather');
    // too short
    await expect(
      signMark(signer, { markedEventId: 'a'.repeat(63), nickname: 'BlackFeather' }),
    ).rejects.toThrow(/64 lowercase hex chars/);
    // uppercase not accepted
    await expect(
      signMark(signer, { markedEventId: 'A'.repeat(64), nickname: 'BlackFeather' }),
    ).rejects.toThrow(/64 lowercase hex chars/);
    // non-hex char
    await expect(
      signMark(signer, { markedEventId: 'z'.repeat(64), nickname: 'BlackFeather' }),
    ).rejects.toThrow(/64 lowercase hex chars/);
  });
});

describe('signMarkRevoked', () => {
  it('produces a signed envelope with markRevoked.markedEventId populated', async () => {
    const signer = makeTestSigner('Scout');
    const result = await signMarkRevoked(signer, {
      markedEventId: VALID_HEX64,
      nickname: 'Scout',
      ts: 1700000001,
    });

    expect(result.signedPayloadBytes).toBeInstanceOf(Uint8Array);
    expect(result.signedPayloadBytes.byteLength).toBeGreaterThan(0);

    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);

    expect(env.markRevoked).toBeTruthy();
    expect(env.markRevoked!.markedEventId).toBe(VALID_HEX64);
    expect(env.lorehouse).toBe('');
    expect(env.actor?.nickname).toBe('Scout');
    expect(env.actor?.popclawId).toBe(await signer.popclawId());
    expect(Number(env.timestamp)).toBe(1700000001);
  });

  it('mark field is absent when markRevoked is used', async () => {
    const signer = makeTestSigner('Scout');
    const result = await signMarkRevoked(signer, {
      markedEventId: VALID_HEX64,
      nickname: 'Scout',
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.mark).toBeFalsy();
    expect(env.markRevoked).toBeTruthy();
  });

  it('throws when nickname is empty or whitespace', async () => {
    const signer = makeTestSigner('Scout');
    await expect(
      signMarkRevoked(signer, { markedEventId: VALID_HEX64, nickname: '' }),
    ).rejects.toThrow(/nickname/);
    await expect(
      signMarkRevoked(signer, { markedEventId: VALID_HEX64, nickname: '   ' }),
    ).rejects.toThrow(/nickname/);
  });

  it('throws when markedEventId is not 64 lowercase hex', async () => {
    const signer = makeTestSigner('Scout');
    await expect(
      signMarkRevoked(signer, { markedEventId: 'A'.repeat(64), nickname: 'Scout' }),
    ).rejects.toThrow(/^signMarkRevoked:/);
    await expect(
      signMarkRevoked(signer, { markedEventId: 'a'.repeat(63), nickname: 'Scout' }),
    ).rejects.toThrow(/64 lowercase hex chars/);
  });
});
