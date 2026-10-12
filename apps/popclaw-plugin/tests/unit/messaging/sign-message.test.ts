import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import {
  signReply,
  signDirectMessage,
  DM_ENCRYPTED_BODY_PLACEHOLDER,
} from '../../../src/messaging/sign-message.js';
import { popclaw } from '@popclaw/contracts';
import { signEnvelope } from '../../../src/identity/sign-envelope.js';
import { verifyInboundEnvelope } from '../../../src/ingress/verify-envelope.js';
import { makeTestSigner } from '../../helpers/test-signer.js';

function makeSigner(seedByte = 1): MasterKeySigner {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i + seedByte) & 0xff;
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = {
    seed,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    popclawId: bs58.encode(kp.publicKey),
  };
  return new MasterKeySigner(key);
}

/**
 * #227: a DM recipient id must be a REAL Ed25519 public key — it IS the
 * encryption key. Placeholder strings ("Bob") and the made-up fixture ids in
 * test-signer.ts are not valid curve points, so sealing them fails loudly.
 */
const BOB = makeSigner(99);
const BOB_ID = bs58.encode(nacl.sign.keyPair.fromSeed(seedOf(99)).publicKey);

function seedOf(seedByte: number): Uint8Array {
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) seed[i] = (i + seedByte) & 0xff;
  return seed;
}

describe('sign-message — Reply', () => {
  it('produces a signed envelope with the Reply payload populated', async () => {
    const signer = makeSigner();
    const env = await signReply(signer, {
      inReplyTo: {
        platform: 'x',
        platformPostId: '1234567890',
        authorPopclawId: 'AuthorXYZ',
      },
      body: 'great point about RLHF',
      nickname: 'TestNick',
    });
    expect(env.signedPayloadBytes).toBeInstanceOf(Uint8Array);
    expect(env.signedPayloadBytes.byteLength).toBeGreaterThan(0);

    // Decode + verify the Reply field round-trips.
    const sp = popclaw.identity.SignedPayload.decode(env.signedPayloadBytes);
    const decoded = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(decoded.reply).toBeTruthy();
    expect(decoded.reply!.body).toBe('great point about RLHF');
    expect(decoded.reply!.inReplyTo!.platform).toBe('x');
    expect(decoded.reply!.inReplyTo!.platformPostId).toBe('1234567890');
    expect(decoded.reply!.inReplyTo!.authorPopclawId).toBe('AuthorXYZ');
    expect(decoded.actor!.popclawId).toBe(await signer.popclawId());
  });

  it('omits PostRef.author_popclaw_id when unknown (proto3 default elision)', async () => {
    const signer = makeSigner();
    const env = await signReply(signer, {
      inReplyTo: { platform: 'x', platformPostId: '1' /* no author */ },
      body: 'hello',
      nickname: 'TestNick',
    });
    const sp = popclaw.identity.SignedPayload.decode(env.signedPayloadBytes);
    const decoded = popclaw.event.EventEnvelope.decode(sp.payload);
    // pbjs decode produces an empty string when the field is the proto3
    // default and absent; this is the same shape prost would produce, so
    // CIDs match across runtimes.
    expect(decoded.reply!.inReplyTo!.authorPopclawId).toBe('');
  });

  it('uses provided ts when given', async () => {
    const signer = makeSigner();
    const env = await signReply(signer, {
      inReplyTo: { platform: 'x', platformPostId: '1' },
      body: 'hi',
      nickname: 'TestNick',
      ts: 1700000000,
    });
    const sp = popclaw.identity.SignedPayload.decode(env.signedPayloadBytes);
    const decoded = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(Number(decoded.reply!.ts)).toBe(1700000000);
    expect(Number(decoded.timestamp)).toBe(1700000000);
  });
});

describe('sign-message — DirectMessage', () => {
  it('produces a signed envelope with the DirectMessage payload populated', async () => {
    const signer = makeSigner();
    const env = await signDirectMessage(signer, {
      toPopclawId: BOB_ID,
      body: 'are you free for a chat?',
      nickname: 'TestNick',
    });
    expect(env.signedPayloadBytes.byteLength).toBeGreaterThan(0);

    const sp = popclaw.identity.SignedPayload.decode(env.signedPayloadBytes);
    const decoded = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(decoded.directMessage).toBeTruthy();
    // #227: field 4 contains only a placeholder; the real body is in ciphertext, readable only by the recipient.
    expect(decoded.directMessage!.body).toBe(DM_ENCRYPTED_BODY_PLACEHOLDER);
    const opened = BOB.openDm(decoded.directMessage!, await signer.popclawId());
    expect(opened.ok && opened.plaintext).toBe('are you free for a chat?');
    expect(decoded.directMessage!.toPopclawId).toBe(BOB_ID);
    // No in_reply_to_post when not provided
    expect(decoded.directMessage!.inReplyToPost).toBeFalsy();
  });

  it('includes in_reply_to_post when DM is anchored to a post', async () => {
    const signer = makeSigner();
    const env = await signDirectMessage(signer, {
      toPopclawId: BOB_ID,
      body: 'about your post...',
      nickname: 'TestNick',
      inReplyToPost: { platform: 'x', platformPostId: '999' },
    });
    const sp = popclaw.identity.SignedPayload.decode(env.signedPayloadBytes);
    const decoded = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(decoded.directMessage!.inReplyToPost!.platform).toBe('x');
    expect(decoded.directMessage!.inReplyToPost!.platformPostId).toBe('999');
  });

  it('signs a unique envelope per call (different ts → different bytes)', async () => {
    const signer = makeSigner();
    const a = await signDirectMessage(signer, { toPopclawId: BOB_ID, body: 'hi', nickname: 'TestNick', ts: 100 });
    const b = await signDirectMessage(signer, { toPopclawId: BOB_ID, body: 'hi', nickname: 'TestNick', ts: 200 });
    // Different ts means different envelope bytes (and different signature).
    expect(Buffer.from(a.signedPayloadBytes).equals(Buffer.from(b.signedPayloadBytes))).toBe(false);
  });
});

// Task 8 backfill: nickname + lorehouse parity tests for signReply / signDirectMessage

describe('signReply (Task 8 backfill)', () => {
  it('sets actor.nickname and lorehouse is empty (ADR-0025 task 4.5b)', async () => {
    const signer = makeTestSigner('BlackFeather');
    const result = await signReply(signer, {
      inReplyTo: { platform: 'x', platformPostId: 'tweet_123' },
      body: 'hi',
      nickname: 'BlackFeather',
      ts: 1713657700,
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.actor?.nickname).toBe('BlackFeather');
    expect(env.lorehouse).toBe('');
  });

  it('throws when nickname is empty or whitespace', async () => {
    const signer = makeTestSigner('BlackFeather');
    await expect(
      signReply(signer, {
        inReplyTo: { platform: 'x', platformPostId: 'X' },
        body: 'hi',
        nickname: '',
      }),
    ).rejects.toThrow(/nickname/);
    await expect(
      signReply(signer, {
        inReplyTo: { platform: 'x', platformPostId: 'X' },
        body: 'hi',
        nickname: '   ',
      }),
    ).rejects.toThrow(/nickname/);
  });
});

describe('signDirectMessage (Task 8 backfill)', () => {
  it('sets actor.nickname and lorehouse is empty (ADR-0025 task 4.5b)', async () => {
    const signer = makeTestSigner('Scout');
    const result = await signDirectMessage(signer, {
      toPopclawId: BOB_ID,
      body: 'private hi',
      nickname: 'Scout',
      ts: 1713657800,
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.actor?.nickname).toBe('Scout');
    expect(env.lorehouse).toBe('');
  });

  it('throws when nickname is empty or whitespace', async () => {
    const signer = makeTestSigner('BlackFeather');
    await expect(
      signDirectMessage(signer, {
        toPopclawId: BOB_ID,
        body: 'hi',
        nickname: '',
      }),
    ).rejects.toThrow(/nickname/);
    await expect(
      signDirectMessage(signer, {
        toPopclawId: BOB_ID,
        body: 'hi',
        nickname: '   ',
      }),
    ).rejects.toThrow(/nickname/);
  });
});

// ---------------------------------------------------------------------------
// #231, second change: attach an image in a second encrypted box.
// ---------------------------------------------------------------------------

/**
 * prost computes the CID by decoding and reencoding canonically. If pbjs bytes equal decode/encode
 * bytes, both runtimes compute the same CID. Explicitly writing a proto3 default, such as empty
 * media_ciphertext, is detected here.
 */
function assertCanonicalRoundTrip(signedPayloadBytes: Uint8Array): void {
  const sp = popclaw.identity.SignedPayload.decode(signedPayloadBytes);
  const decoded = popclaw.event.EventEnvelope.decode(sp.payload);
  const reencoded = popclaw.event.EventEnvelope.encode(decoded).finish();
  expect(Array.from(reencoded)).toEqual(Array.from(sp.payload));
}

describe('signDirectMessage — 图（#231）', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it('seals the picture into its own box the recipient can open (mime + bytes)', async () => {
    const signer = makeSigner();
    const env = await signDirectMessage(signer, {
      toPopclawId: BOB_ID,
      body: '看这个',
      nickname: 'TestNick',
      media: { bytes: PNG, mime: 'image/png' },
    });
    const sp = popclaw.identity.SignedPayload.decode(env.signedPayloadBytes);
    const dm = popclaw.event.EventEnvelope.decode(sp.payload).directMessage!;

    expect(dm.mediaCiphertext!.length).toBeGreaterThan(0);
    expect(dm.mediaNonce!.length).toBe(24);
    // End to end: the recipient decrypts the original bytes and MIME type with their own key.
    const opened = BOB.openDmMedia(
      { ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce },
      await signer.popclawId(),
    );
    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.mime).toBe('image/png');
    expect(opened.ok && Array.from(opened.bytes)).toEqual(Array.from(PNG));
    // Text remains in its own independent encrypted box.
    expect(BOB.openDm(dm, await signer.popclawId())).toMatchObject({ ok: true, plaintext: '看这个' });
    assertCanonicalRoundTrip(env.signedPayloadBytes);
  });

  it('图与文字用不同的 nonce（同一对密钥共用 nonce = keystream 复用）', async () => {
    const signer = makeSigner();
    const env = await signDirectMessage(signer, {
      toPopclawId: BOB_ID,
      body: 'hi',
      nickname: 'TestNick',
      media: { bytes: PNG, mime: 'image/png' },
    });
    const sp = popclaw.identity.SignedPayload.decode(env.signedPayloadBytes);
    const dm = popclaw.event.EventEnvelope.decode(sp.payload).directMessage!;
    expect(Array.from(dm.mediaNonce!)).not.toEqual(Array.from(dm.nonce!));
  });

  it('OMITS both media fields entirely when there is no picture (CID 不漂移)', async () => {
    const signer = makeSigner();
    const env = await signDirectMessage(signer, {
      toPopclawId: BOB_ID,
      body: 'plain text only',
      nickname: 'TestNick',
      ts: 1713657800,
    });
    const sp = popclaw.identity.SignedPayload.decode(env.signedPayloadBytes);
    const dm = popclaw.event.EventEnvelope.decode(sp.payload).directMessage!;
    // This is not an empty array: the field must be absent from the wire. Writing a proto3 default changes the canonical bytes
    // recomputed by prost after decoding, and the house rejects it with cid_mismatch.
    expect(Object.prototype.hasOwnProperty.call(dm, 'mediaCiphertext')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(dm, 'mediaNonce')).toBe(false);
    expect(dm.mediaCiphertext?.length ?? 0).toBe(0);
    assertCanonicalRoundTrip(env.signedPayloadBytes);
  });

  it('throws when the complete signed envelope exceeds the current protocol limit', async () => {
    const signer = makeSigner();
    await expect(
      signDirectMessage(signer, {
        toPopclawId: BOB_ID,
        body: 'hi',
        nickname: 'TestNick',
        media: { bytes: new Uint8Array(2 * 1024 * 1024), mime: 'image/png' },
      }),
    ).rejects.toThrow('WIRE_LIMIT');
  });
});


describe('new DM author recipient targeting', () => {
  it.each([false, true])('signs a PRIVATE single-recipient target with decryptable body (media=%s)', async withMedia => {
    const signer = makeSigner(), sender = await signer.popclawId();
    const media = {bytes: Uint8Array.from([1, 2, 3]), mime: 'image/png'};
    const signed = await signDirectMessage(signer, {toPopclawId:BOB_ID,body:'private target',nickname:'Alice',ts:100,
      ...(withMedia ? {media} : {})});
    const outer = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes);
    const envelope = verifyInboundEnvelope(outer.payload, {recipientPopclawId:BOB_ID});
    expect(envelope.target?.scope).toBe(1);
    expect(envelope.target?.targetIds).toEqual([BOB_ID]);
    expect(envelope.target?.filterCriteria ?? '').toBe('');
    expect(nacl.sign.detached.verify(outer.payload,outer.signature,bs58.decode(sender))).toBe(true);
    expect(envelope.eventId).toBe(signed.eventId);
    const opened = BOB.openDm(envelope.directMessage!,sender);
    expect(opened.ok && opened.plaintext).toBe('private target');
    if (withMedia) {
      const openedMedia = BOB.openDmMedia({ciphertext:envelope.directMessage!.mediaCiphertext,nonce:envelope.directMessage!.mediaNonce},sender);
      expect(openedMedia.ok).toBe(true);
      expect(openedMedia.ok && openedMedia.mime).toBe(media.mime);
      expect(openedMedia.ok && [...openedMedia.bytes]).toEqual([...media.bytes]);
    }
    envelope.target!.scope = 2;
    expect(() => verifyInboundEnvelope(popclaw.event.EventEnvelope.encode(envelope).finish(), {recipientPopclawId:BOB_ID})).toThrow('CID_MISMATCH');
  });

  it('still verifies and decrypts original historical DM bytes without a target', async () => {
    const signer = makeSigner(), sender = await signer.popclawId();
    const sealed = signer.sealDm('historical private body',BOB_ID);
    const signed = await signEnvelope(signer, {actor:{popclawId:sender,nickname:'Alice'},timestamp:100,
      directMessage:{fromPopclawId:sender,toPopclawId:BOB_ID,body:DM_ENCRYPTED_BODY_PLACEHOLDER,ts:100,ciphertext:sealed.ciphertext,nonce:sealed.nonce}});
    const originalWrapper = new Uint8Array(signed.signedPayloadBytes);
    const outer = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes), originalEnvelope = new Uint8Array(outer.payload);
    const envelope = verifyInboundEnvelope(outer.payload,{recipientPopclawId:BOB_ID});
    expect(envelope.target).toBeNull();
    expect(envelope.eventId).toBe(signed.eventId);
    expect(nacl.sign.detached.verify(outer.payload,outer.signature,bs58.decode(sender))).toBe(true);
    const opened = BOB.openDm(envelope.directMessage!,sender);
    expect(opened.ok && opened.plaintext).toBe('historical private body');
    expect([...outer.payload]).toEqual([...originalEnvelope]);
    expect([...signed.signedPayloadBytes]).toEqual([...originalWrapper]);
  });
});
