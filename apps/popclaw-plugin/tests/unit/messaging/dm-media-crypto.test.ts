import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import ed2curve from 'ed2curve';
import {
  encryptDmMedia,
  decryptDmMedia,
  MAX_DM_MEDIA_BYTES,
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

  // 同一对密钥下两个盒子共用一个 nonce = XSalsa20 keystream 复用，教科书级踩雷。
  it('uses a nonce distinct from any caller-supplied one, fresh per call', () => {
    const a = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    const b = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    expect(a.nonce).toHaveLength(DM_NONCE_BYTES);
    expect(Array.from(a.nonce)).not.toEqual(Array.from(b.nonce));
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext));
  });

  // 盒子是 authenticated 的：开得开就证明是那个发信人封的。
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

  // 与 decryptDmBody 同一条铁律：它坐在收件箱投递循环里，一封坏消息
  // 绝不能毒死整个批次。
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

  // 盒子里第一行是 mime，剩下是原始字节。少了分隔符 = 不是我们封的。
  it('reports a sealed blob without the mime header as malformed', () => {
    const nonce = nacl.randomBytes(DM_NONCE_BYTES);
    const edPk = bs58.decode(bob.popclawId);
    // 直接封一段没有 mime 头的字节
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

  it('rejects oversized media at seal time instead of shipping an unsendable envelope', () => {
    const tooBig = new Uint8Array(MAX_DM_MEDIA_BYTES + 1);
    expect(() => encryptDmMedia(tooBig, 'image/gif', bob.popclawId, alice.secretKey)).toThrow(/1 ?MB|too large|上限/i);
  });

  it('accepts media exactly at the cap', () => {
    const atCap = new Uint8Array(MAX_DM_MEDIA_BYTES);
    expect(() => encryptDmMedia(atCap, 'image/gif', bob.popclawId, alice.secretKey)).not.toThrow();
  });

  // mime 封在盒子里面：灯坊连"这是张贴纸还是截图"都看不出来。
  it('keeps the mime inside the box (not a plaintext field)', () => {
    const sealed = encryptDmMedia(PNG, 'image/png', bob.popclawId, alice.secretKey);
    expect(Object.keys(sealed).sort()).toEqual(['ciphertext', 'nonce']);
  });

  it('rejects a mime containing the newline separator', () => {
    expect(() => encryptDmMedia(PNG, 'image/png\nX', bob.popclawId, alice.secretKey)).toThrow();
  });
});
