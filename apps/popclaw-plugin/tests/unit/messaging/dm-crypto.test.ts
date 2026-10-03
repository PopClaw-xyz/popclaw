import { describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import ed2curve from 'ed2curve';
import {
  encryptDmBody,
  decryptDmBody,
  looksEncrypted,
  DM_NONCE_BYTES,
  type SealedDmBody,
} from '../../../src/messaging/dm-crypto.js';

/** Throwaway identity — same shape as Keystore's MasterKey, generated per test. */
function throwaway(): { popclawId: string; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { popclawId: bs58.encode(kp.publicKey), secretKey: kp.secretKey };
}

/** A syntactically valid, correctly-sized popclaw_id that is NOT a convertible curve point. */
const NON_CURVE_ID = bs58.encode(new Uint8Array(32).fill(0x7f));

describe('dm-crypto — round trip', () => {
  it('recipient recovers the exact plaintext', () => {
    const alice = throwaway();
    const bob = throwaway();

    const sealed = encryptDmBody('见字如面。', bob.popclawId, alice.secretKey);
    const opened = decryptDmBody(sealed, alice.popclawId, bob.secretKey);

    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.plaintext).toBe('见字如面。');
  });

  it('survives emoji, newlines and a JSON redpacket-ticket-shaped body', () => {
    const alice = throwaway();
    const bob = throwaway();
    const body = JSON.stringify({ tag: 'popclaw/redpacket-ticket@1', note: '恭喜发财 🧧\n第二行' });

    const sealed = encryptDmBody(body, bob.popclawId, alice.secretKey);
    const opened = decryptDmBody(sealed, alice.popclawId, bob.secretKey);

    expect(opened.ok && opened.plaintext).toBe(body);
  });

  it('handles an empty body', () => {
    const alice = throwaway();
    const bob = throwaway();

    const opened = decryptDmBody(
      encryptDmBody('', bob.popclawId, alice.secretKey),
      alice.popclawId,
      bob.secretKey,
    );

    expect(opened.ok && opened.plaintext).toBe('');
  });

  it('emits a 24-byte nonce and a ciphertext that is not the plaintext', () => {
    const alice = throwaway();
    const bob = throwaway();

    const sealed = encryptDmBody('hello', bob.popclawId, alice.secretKey);

    expect(sealed.nonce.length).toBe(DM_NONCE_BYTES);
    expect(sealed.nonce.length).toBe(24);
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain('hello');
  });
});

describe('dm-crypto — fresh nonce per message', () => {
  it('two encryptions of the same plaintext differ', () => {
    const alice = throwaway();
    const bob = throwaway();

    const a = encryptDmBody('same text', bob.popclawId, alice.secretKey);
    const b = encryptDmBody('same text', bob.popclawId, alice.secretKey);

    expect(Array.from(a.nonce)).not.toEqual(Array.from(b.nonce));
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext));

    // ...and both still open.
    expect(decryptDmBody(a, alice.popclawId, bob.secretKey).ok).toBe(true);
    expect(decryptDmBody(b, alice.popclawId, bob.secretKey).ok).toBe(true);
  });
});

describe('dm-crypto — authenticated plaintext bytes', () => {
  // Deliberately seal raw bytes: the public string sender cannot represent
  // malformed UTF-8, while an authenticated peer can send any byte sequence.
  function sealBytes(bytes: Uint8Array, alice: ReturnType<typeof throwaway>, bob: ReturnType<typeof throwaway>): SealedDmBody {
    const nonce = nacl.randomBytes(DM_NONCE_BYTES);
    const recipientKey = ed2curve.convertPublicKey(bs58.decode(bob.popclawId));
    if (!recipientKey) throw new Error('Fixture recipient must be a convertible curve point');
    return { nonce, ciphertext: nacl.box(bytes, nonce, recipientKey, ed2curve.convertSecretKey(alice.secretKey)) };
  }

  it.each([
    { name: 'UTF-8 BOM', bytes: Uint8Array.of(0xef, 0xbb, 0xbf, 0x41), text: 'A' },
    { name: 'malformed UTF-8', bytes: Uint8Array.of(0x41, 0xc3, 0x28, 0xff), text: 'A\ufffd(\ufffd' },
  ])('preserves $name bytes while retaining the legacy decoded string', ({ bytes, text }) => {
    const alice = throwaway(), bob = throwaway();
    const opened = decryptDmBody(sealBytes(bytes, alice, bob), alice.popclawId, bob.secretKey);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error('Authenticated fixture must open');
    expect(opened.plaintext).toBe(text);
    expect(opened.plaintextBytes).toEqual(bytes);
  });

  it('copies the actual opened buffer without sharing mutable storage with crypto inputs or another result', () => {
    const alice = throwaway(), bob = throwaway();
    const original = Uint8Array.of(0x41, 0x42, 0x43);
    const sealed = sealBytes(original, alice, bob);
    const ciphertext = sealed.ciphertext.slice(), nonce = sealed.nonce.slice();
    const realOpen = nacl.box.open;
    let openedBuffer: Uint8Array | null = null;
    // A pass-through probe retains the real library result, not a fabricated
    // plaintext or a claim that tweetnacl caches decrypted messages.
    const probe = vi.spyOn(nacl.box, 'open').mockImplementation((...args) => {
      openedBuffer = realOpen(...args);
      return openedBuffer;
    });
    let result: ReturnType<typeof decryptDmBody>;
    try { result = decryptDmBody(sealed, alice.popclawId, bob.secretKey); }
    finally { probe.mockRestore(); }
    expect(result.ok).toBe(true);
    if (!result.ok || !result.plaintextBytes || !openedBuffer) throw new Error('Authenticated fixture must expose bytes');
    const raw: Uint8Array = openedBuffer;
    expect(result.plaintextBytes).toEqual(original);
    expect(result.plaintextBytes.buffer).not.toBe(raw.buffer);
    expect(result.plaintextBytes.buffer).not.toBe(sealed.ciphertext.buffer);
    expect(result.plaintextBytes.buffer).not.toBe(sealed.nonce.buffer);
    expect(result.plaintextBytes.buffer).not.toBe(original.buffer);
    raw[0] = 0x58;
    expect(result.plaintextBytes).toEqual(original);
    result.plaintextBytes[1] = 0x59;
    expect(raw[1]).toBe(original[1]);
    expect(result.plaintext).toBe('ABC');
    expect(sealed.ciphertext).toEqual(ciphertext); expect(sealed.nonce).toEqual(nonce);
    const reopened = decryptDmBody(sealed, alice.popclawId, bob.secretKey);
    expect(reopened.ok && reopened.plaintextBytes).toEqual(original);
  });
});

describe('dm-crypto — decryption never throws, always returns a typed failure', () => {
  const alice = throwaway();
  const bob = throwaway();
  const carol = throwaway();
  const sealed = encryptDmBody('secret', bob.popclawId, alice.secretKey);

  it('wrong recipient fails cleanly', () => {
    const opened = decryptDmBody(sealed, alice.popclawId, carol.secretKey);
    expect(opened).toEqual({ ok: false, reason: 'decrypt_failed' });
  });

  it('wrong sender id fails cleanly (box is authenticated)', () => {
    const opened = decryptDmBody(sealed, carol.popclawId, bob.secretKey);
    expect(opened).toEqual({ ok: false, reason: 'decrypt_failed' });
  });

  it('corrupted ciphertext fails cleanly', () => {
    const corrupted: SealedDmBody = {
      nonce: sealed.nonce,
      ciphertext: Uint8Array.from(sealed.ciphertext),
    };
    corrupted.ciphertext[0] = (corrupted.ciphertext[0] ?? 0) ^ 0xff;

    expect(decryptDmBody(corrupted, alice.popclawId, bob.secretKey)).toEqual({
      ok: false,
      reason: 'decrypt_failed',
    });
  });

  it('corrupted nonce (right length, wrong bytes) fails cleanly', () => {
    const nonce = Uint8Array.from(sealed.nonce);
    nonce[0] = (nonce[0] ?? 0) ^ 0xff;

    expect(decryptDmBody({ ...sealed, nonce }, alice.popclawId, bob.secretKey)).toEqual({
      ok: false,
      reason: 'decrypt_failed',
    });
  });

  it('truncated nonce fails cleanly', () => {
    const opened = decryptDmBody(
      { ...sealed, nonce: sealed.nonce.slice(0, 12) },
      alice.popclawId,
      bob.secretKey,
    );
    expect(opened).toEqual({ ok: false, reason: 'malformed_nonce' });
  });

  it('absent nonce fails cleanly', () => {
    expect(
      decryptDmBody({ ciphertext: sealed.ciphertext }, alice.popclawId, bob.secretKey),
    ).toEqual({ ok: false, reason: 'malformed_nonce' });
  });

  it('malformed popclaw_id (non-base58 alphabet) fails cleanly', () => {
    expect(decryptDmBody(sealed, 'not a popclaw id!!0OIl', bob.secretKey)).toEqual({
      ok: false,
      reason: 'malformed_sender_id',
    });
  });

  it('wrong-length popclaw_id fails cleanly', () => {
    expect(decryptDmBody(sealed, bs58.encode(new Uint8Array(16)), bob.secretKey)).toEqual({
      ok: false,
      reason: 'malformed_sender_id',
    });
  });

  it('empty popclaw_id fails cleanly', () => {
    expect(decryptDmBody(sealed, '', bob.secretKey)).toEqual({
      ok: false,
      reason: 'malformed_sender_id',
    });
  });

  it('well-formed popclaw_id that is not a valid curve point fails cleanly', () => {
    expect(decryptDmBody(sealed, NON_CURVE_ID, bob.secretKey)).toEqual({
      ok: false,
      reason: 'malformed_sender_id',
    });
  });

  it('legacy plaintext row (no ciphertext) fails cleanly', () => {
    expect(decryptDmBody({}, alice.popclawId, bob.secretKey)).toEqual({
      ok: false,
      reason: 'missing_ciphertext',
    });
    expect(decryptDmBody({ ciphertext: new Uint8Array(0) }, alice.popclawId, bob.secretKey)).toEqual(
      { ok: false, reason: 'missing_ciphertext' },
    );
  });

  it('legacy plaintext bytes fed in as ciphertext by mistake fail cleanly', () => {
    const opened = decryptDmBody(
      { ciphertext: new TextEncoder().encode('老明文，忘了加密'), nonce: sealed.nonce },
      alice.popclawId,
      bob.secretKey,
    );
    expect(opened).toEqual({ ok: false, reason: 'decrypt_failed' });
  });

  it('null / undefined / garbage inputs never throw', () => {
    const junk: unknown[] = [
      null,
      undefined,
      {},
      { ciphertext: null, nonce: null },
      { ciphertext: sealed.ciphertext, nonce: new Uint8Array(0) },
      { ciphertext: new Uint8Array(1), nonce: new Uint8Array(DM_NONCE_BYTES) },
    ];
    for (const input of junk) {
      const opened = decryptDmBody(input as SealedDmBody, alice.popclawId, bob.secretKey);
      expect(opened.ok).toBe(false);
    }
    // A malformed recipient key is programmer error, but must not throw either.
    expect(decryptDmBody(sealed, alice.popclawId, new Uint8Array(3)).ok).toBe(false);
  });
});

describe('dm-crypto — encryption throws only on programmer error', () => {
  it('rejects a malformed recipient popclaw_id', () => {
    const alice = throwaway();
    expect(() => encryptDmBody('hi', 'not a popclaw id!!0OIl', alice.secretKey)).toThrow(
      /recipient popclaw_id/,
    );
    expect(() => encryptDmBody('hi', '', alice.secretKey)).toThrow(/recipient popclaw_id/);
    expect(() => encryptDmBody('hi', bs58.encode(new Uint8Array(16)), alice.secretKey)).toThrow(
      /recipient popclaw_id/,
    );
    expect(() => encryptDmBody('hi', NON_CURVE_ID, alice.secretKey)).toThrow(/recipient popclaw_id/);
  });

  it('does not leak key material in the thrown message', () => {
    const alice = throwaway();
    try {
      encryptDmBody('hi', 'not a popclaw id!!0OIl', alice.secretKey);
      expect.unreachable();
    } catch (err) {
      const msg = String(err);
      for (const byte of alice.secretKey.slice(0, 8)) {
        expect(msg).not.toContain(byte.toString(16).padStart(2, '0').repeat(4));
      }
      expect(msg).not.toContain(bs58.encode(alice.secretKey));
    }
  });
});

describe('dm-crypto — looksEncrypted discriminator', () => {
  it('is true for a sealed body', () => {
    const alice = throwaway();
    const bob = throwaway();
    expect(looksEncrypted(encryptDmBody('hi', bob.popclawId, alice.secretKey))).toBe(true);
  });

  it('is false for a legacy plaintext row', () => {
    expect(looksEncrypted({})).toBe(false);
    expect(looksEncrypted({ ciphertext: new Uint8Array(0) })).toBe(false);
    expect(looksEncrypted({ ciphertext: null })).toBe(false);
    expect(looksEncrypted(null)).toBe(false);
    expect(looksEncrypted(undefined)).toBe(false);
  });
});
