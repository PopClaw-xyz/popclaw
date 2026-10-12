import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import ed2curve from 'ed2curve';
import {
  encryptDmMedia,
  decryptDmMedia,
  DM_NONCE_BYTES,
} from '../../../src/messaging/dm-crypto.js';

function identity(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return { popclawId: bs58.encode(kp.publicKey), secretKey: kp.secretKey };
}

const alice = identity(1);
const bob = identity(2);
const mallory = identity(3);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('DM media encryption', () => {
  it('round-trips bytes and mime through the recipient key', () => {
    const sealed = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    const out = decryptDmMedia(sealed, alice.popclawId, bob.secretKey);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mime).toBe('image/png');
    expect(Array.from(out.bytes)).toEqual(Array.from(PNG));
  });

  // Reusing a nonce for two boxes with the same key pair reuses the XSalsa20 keystream: a textbook failure.
  it('uses a nonce distinct from any caller-supplied one, fresh per call', () => {
    const a = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    const b = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    expect(a.nonce).toHaveLength(DM_NONCE_BYTES);
    expect(Array.from(a.nonce)).not.toEqual(Array.from(b.nonce));
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext));
  });

  // The box is authenticated: successful opening proves it was sealed by that sender.
  it('refuses a box that is not for this recipient', () => {
    const sealed = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    const out = decryptDmMedia(sealed, alice.popclawId, mallory.secretKey);
    expect(out).toEqual({ ok: false, reason: 'decrypt_failed' });
  });

  it('refuses a box attributed to the wrong sender', () => {
    const sealed = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    const out = decryptDmMedia(sealed, mallory.popclawId, bob.secretKey);
    expect(out).toEqual({ ok: false, reason: 'decrypt_failed' });
  });

  // Same invariant as decryptDmBody: this runs inside the inbox delivery loop; one malformed message
  // must never poison the whole batch.
  it('never throws — every malformed input comes back as a typed failure', () => {
    expect(decryptDmMedia(undefined, alice.popclawId, bob.secretKey)).toEqual({
      ok: false,
      reason: 'missing_ciphertext',
    });
    expect(
      decryptDmMedia({ ciphertext: new Uint8Array(0), nonce: new Uint8Array(24) }, alice.popclawId, bob.secretKey),
    ).toEqual({ ok: false, reason: 'missing_ciphertext' });
    expect(
      decryptDmMedia({ ciphertext: new Uint8Array([1, 2, 3]), nonce: new Uint8Array(3) }, alice.popclawId, bob.secretKey),
    ).toEqual({ ok: false, reason: 'malformed_nonce' });
    expect(
      decryptDmMedia({ ciphertext: new Uint8Array([1, 2, 3]), nonce: new Uint8Array(24) }, 'not-base58!!', bob.secretKey),
    ).toEqual({ ok: false, reason: 'malformed_sender_id' });
  });

  // The first line inside the box is MIME; the remainder is raw bytes. No separator means it is not our format.
  it('reports a sealed blob without the mime header as malformed', () => {
    const nonce = nacl.randomBytes(DM_NONCE_BYTES);
    const edPk = bs58.decode(bob.popclawId);
    // Seal bytes directly without a MIME header.
    const raw = new TextEncoder().encode('no-newline-here');
    const ciphertext = nacl.box(
      raw,
      nonce,
      ed2curve.convertPublicKey(edPk)!,
      ed2curve.convertSecretKey(alice.secretKey),
    );
    const out = decryptDmMedia({ ciphertext, nonce }, alice.popclawId, bob.secretKey);
    expect(out).toEqual({ ok: false, reason: 'malformed_media' });
  });

  it('seals media above the former 1 MiB cap without changing bytes', () => {
    const bytes = new Uint8Array(1024 * 1024 + 1).fill(0xa7);
    const sealed = encryptDmMedia(bytes, 'image/gif', bob.popclawId, alice.secretKey);
    const opened = decryptDmMedia(sealed, alice.popclawId, bob.secretKey);
    expect(opened.ok && opened.bytes).toEqual(bytes);
  });

  it('accepts media exactly at the former cap', () => {
    const atCap = new Uint8Array(1024 * 1024);
    expect(() => encryptDmMedia(atCap, 'image/gif', bob.popclawId, alice.secretKey)).not.toThrow();
  });

  // MIME is sealed inside the box: even the LoreHouse cannot distinguish a sticker from a screenshot.
  it('keeps the mime inside the box (not a plaintext field)', () => {
    const sealed = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'nonce']);
  });

  it('rejects a mime containing the newline separator', () => {
    expect(() => encryptDmMedia(PNG, 'image/png\nX', bob.popclawId, alice.secretKey)).toThrow();
  });
});
