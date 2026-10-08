import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw, checkEnvelopeWire, canonicalizeEnvelope, L_ENVELOPE_MAX_BYTES } from '../../../src/protocol/public-envelope-generated.js';
import { signEnvelope } from '../../../src/identity/sign-envelope.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { signDirectMessage, checkDirectMessageFits } from '../../../src/messaging/sign-message.js';
import { loadDmAttachment, loadReceivedDmAttachment, receiveDmMedia } from '../../../src/messaging/dm-media.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import * as draftStore from '../../../src/tools/draft-store.js';
import { buildFakeApi, findTool, makeImageDmFixture } from '../../helpers/register-tools-fixture.js';
import { sendDraftConfirmed } from '../../helpers/owner-approval-script.js';
import { draftToken } from '../../helpers/draft-token.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';

const LARGE_BYTES = 1024 * 1024 + 65536;
const attachment = () => new Uint8Array(LARGE_BYTES).fill(0xa7);
function makeSigner(byte = 1) {
  const seed = new Uint8Array(32).fill(byte), kp = nacl.sign.keyPair.fromSeed(seed);
  return new MasterKeySigner({seed, ...kp, popclawId: bs58.encode(kp.publicKey)});
}
const localFile = (bytes: Uint8Array) => {
  const path = join(mkdtempSync(join(tmpdir(), 'dm-capacity-')), 'original.png');
  writeFileSync(path, bytes);
  return path;
};
afterEach(() => { _draftsForTest.clear(); vi.restoreAllMocks(); });

// Exact unsigned-fit/signed-over edge, including the CID and inner signature.
async function boundaryEnvelope(signer = makeSigner(), recipient = makeSigner(99)) {
  const small = await signDirectMessage(signer, {
    toPopclawId: await recipient.popclawId(), body: 'hi', nickname: 'TestUser', ts: 1713657800,
    media: {bytes: new Uint8Array(1), mime: 'image/png'},
  });
  const sp = popclaw.identity.SignedPayload.decode(small.signedPayloadBytes);
  const env = popclaw.event.EventEnvelope.decode(sp.payload);
  const bytes = new Uint8Array(L_ENVELOPE_MAX_BYTES - sp.payload.length + 1 - 10);
  env.directMessage!.mediaCiphertext = bytes;
  // Account for the longer length varints, then make the signed wire exactly cap + 1.
  env.directMessage!.mediaCiphertext = new Uint8Array(bytes.length + L_ENVELOPE_MAX_BYTES + 1 - popclaw.event.EventEnvelope.encode(env).finish().length);
  const signedLength = popclaw.event.EventEnvelope.encode(env).finish().length;
  const {eventId, signature, ...unsigned} = env;
  expect(eventId).toHaveLength(64);
  expect(signature).toHaveLength(nacl.sign.signatureLength);
  return {signer, unsigned: {...unsigned, actor: {...env.actor}, target: {...env.target}, directMessage: {...env.directMessage}}, signedLength};
}

describe('DM attachment capacity uses the complete signed public envelope', () => {
  it('loads >1 MiB original bytes without a per-file cap', () => {
    const bytes = attachment(), loaded = loadDmAttachment(localFile(bytes));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.bytes).toEqual(bytes);
  });

  it('signs, validates, authenticates, decrypts, saves and displays >1 MiB intact', async () => {
    const signer = makeSigner(), recipient = makeSigner(99), bytes = attachment();
    const signed = await signDirectMessage(signer, {toPopclawId: await recipient.popclawId(), body: ' unchanged\n', nickname: 'Alice', media: {bytes, mime: 'image/png'}});
    const sp = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes);
    expect(sp.payload.length).toBeLessThan(L_ENVELOPE_MAX_BYTES);
    checkEnvelopeWire(sp.payload);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(nacl.sign.detached.verify(sp.payload, sp.signature, sp.signerPubkey)).toBe(true);
    expect(nacl.sign.detached.verify(canonicalizeEnvelope(env), env.signature, bs58.decode(await signer.popclawId()))).toBe(true);
    expect(env.target!.targetIds).toEqual([await recipient.popclawId()]);
    expect(recipient.openDm(env.directMessage!, await signer.popclawId())).toMatchObject({ok: true, plaintext: ' unchanged\n'});
    const dir = mkdtempSync(join(tmpdir(), 'dm-inbound-capacity-')), warn = vi.fn();
    const path = receiveDmMedia(env.directMessage!, recipient, dir, 42, warn);
    expect(path).not.toBeNull();
    expect(readFileSync(path!)).toEqual(Buffer.from(bytes));
    expect(Buffer.from(loadReceivedDmAttachment(path!, dir).image!.data, 'base64')).toEqual(Buffer.from(bytes));
    expect(warn).not.toHaveBeenCalled();
  });

  it('loads a saved legal >1 MiB image but still rejects paths outside its inbox', () => {
    const bytes = attachment(), path = localFile(bytes);
    expect(Buffer.from(loadReceivedDmAttachment(path, join(path, '..')).image!.data, 'base64')).toEqual(Buffer.from(bytes));
    expect(() => loadReceivedDmAttachment(path, mkdtempSync(join(tmpdir(), 'dm-other-inbox-')))).toThrow('outside this inbox');
  });

  it('rejects signed wire overflow even when the unsigned encoding fits, before outer signing', async () => {
    const {signer, unsigned, signedLength} = await boundaryEnvelope();
    expect(signedLength).toBe(L_ENVELOPE_MAX_BYTES + 1);
    expect(() => checkEnvelopeWire(popclaw.event.EventEnvelope.encode(unsigned).finish())).not.toThrow();
    const sign = vi.spyOn(signer, 'sign');
    await expect(signEnvelope(signer, unsigned)).rejects.toThrow('WIRE_LIMIT');
    expect(sign).toHaveBeenCalledTimes(1); // inner only; no submit-ready outer signature
  });

  it('rejects actual signed wire overflow with zero egress', async () => {
    const {unsigned} = await boundaryEnvelope();
    const signer = makeSigner(), recipient = makeSigner(99), egress = {push: vi.fn()};
    const cipherLength = unsigned.directMessage!.mediaCiphertext!.length;
    // Box overhead: 16-byte MAC plus "image/png\n". Same fields as boundaryEnvelope.
    const bytes = new Uint8Array(cipherLength - 26);
    const out = await runPopclawMessageCommand({positional: [await recipient.popclawId(), 'hi']}, {signer, egress, nickname: 'TestUser', media: {bytes, mime: 'image/png', name: 'edge.png'}});
    expect(out.text).toBe(renderCopy(ownerLang(), 'message.wireLimit'));
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('accepts the complete signed envelope exactly at the unchanged protocol limit', async () => {
    const {signer, unsigned} = await boundaryEnvelope();
    unsigned.directMessage.mediaCiphertext = unsigned.directMessage.mediaCiphertext!.subarray(1);
    const signed = await signEnvelope(signer, unsigned);
    const sp = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes);
    expect(sp.payload.length).toBe(L_ENVELOPE_MAX_BYTES);
    expect(() => checkEnvelopeWire(sp.payload)).not.toThrow();
  });

  it('previews >1 MiB without signing or sending, then sends approved frozen bytes only once', async () => {
    const fx = makeImageDmFixture(), {api, tools} = buildFakeApi();
    const rt = await fx.runtime(), sign = vi.spyOn(rt.boot.signer, 'sign');
    const bytes = attachment(), path = localFile(bytes);
    registerPopclawTools({api, runtime: fx.runtime});
    const draft = await findTool(tools, 'popclaw_draft_message').execute('d', {recipient: fx.recipientRef, body: 'original', attachment_path: path});
    const token = draftToken(draft.text);
    expect(token).toBeTruthy();
    expect(sign).not.toHaveBeenCalled();
    expect(fx.push).not.toHaveBeenCalled();
    writeFileSync(path, Buffer.from('changed after review'));
    await sendDraftConfirmed(findTool(tools, 'popclaw_send_draft').execute, token!);
    expect(fx.push).toHaveBeenCalledTimes(1);
    const sp = popclaw.identity.SignedPayload.decode(fx.push.mock.calls[0]![0]);
    const dm = popclaw.event.EventEnvelope.decode(sp.payload).directMessage!;
    const opened = fx.recipient.openDmMedia({ciphertext: dm.mediaCiphertext, nonce: dm.mediaNonce}, await rt.boot.signer.popclawId());
    expect(opened.ok && opened.bytes).toEqual(bytes);
    await sendDraftConfirmed(findTool(tools, 'popclaw_send_draft').execute, token!);
    expect(fx.push).toHaveBeenCalledTimes(1);
  });

  it('rejects an attachment draft before preview/confirmation when signature and CID push it over the limit', async () => {
    const fx = makeImageDmFixture(), {api, tools} = buildFakeApi();
    const rt = await fx.runtime(), sign = vi.spyOn(rt.boot.signer, 'sign');
    const {unsigned, signedLength} = await boundaryEnvelope(rt.boot.signer, fx.recipient);
    expect(signedLength).toBe(L_ENVELOPE_MAX_BYTES + 1);
    expect(() => checkEnvelopeWire(popclaw.event.EventEnvelope.encode(unsigned).finish())).not.toThrow();
    const path = localFile(new Uint8Array(unsigned.directMessage!.mediaCiphertext!.length - 26));
    expect(unsigned.directMessage!.mediaCiphertext!.length).toBeGreaterThan(1024 * 1024);
    sign.mockClear();
    const mint = vi.spyOn(draftStore, 'putDraft');
    registerPopclawTools({api, runtime: fx.runtime});
    const draft = await findTool(tools, 'popclaw_draft_message').execute('d', {recipient: fx.recipientRef, body: 'hi', attachment_path: path});
    expect(draft.text).toBe(renderCopy(ownerLang(), 'message.wireLimit'));
    expect(draftToken(draft.text)).toBeFalsy();
    expect(mint).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(fx.push).not.toHaveBeenCalled();
  });

  it.each(['image/png', 'audio/ogg', 'application/pdf'])('unsigned preflight length equals the real signed wire (%s)', async mime => {
    const signer = makeSigner(), recipient = makeSigner(99), sign = vi.spyOn(signer, 'sign');
    const args = {toPopclawId: await recipient.popclawId(), body: ' 原文\n😀 ', nickname: '龙图阁',
      ts: 1713657800, replyToEventId: 'ab'.repeat(32),
      inReplyToPost: {platform: 'x', platformPostId: 'p', authorPopclawId: 'author'},
      media: {bytes: attachment(), mime}};
    const previewLength = await checkDirectMessageFits(signer, args);
    expect(sign).not.toHaveBeenCalled();
    const signed = await signDirectMessage(signer, args);
    const sp = popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.eventId).toHaveLength(64);
    expect(env.signature).toHaveLength(nacl.sign.signatureLength);
    expect(previewLength).toBe(sp.payload.length);
  });

  it('does not silently mint a draft when the required media sealing capability is unavailable', async () => {
    const fx = makeImageDmFixture(), {api, tools} = buildFakeApi(), rt = await fx.runtime();
    vi.spyOn(rt.boot.signer, 'sealDmMedia').mockImplementation(() => {throw new Error('MEDIA_SEAL_UNAVAILABLE');});
    const sign = vi.spyOn(rt.boot.signer, 'sign');
    const mint = vi.spyOn(draftStore, 'putDraft');
    registerPopclawTools({api, runtime: fx.runtime});
    await expect(findTool(tools, 'popclaw_draft_message').execute('d', {recipient: fx.recipientRef,
      attachment_path: localFile(new Uint8Array([1]))})).rejects.toThrow('MEDIA_SEAL_UNAVAILABLE');
    expect(mint).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(fx.push).not.toHaveBeenCalled();
  });
});
