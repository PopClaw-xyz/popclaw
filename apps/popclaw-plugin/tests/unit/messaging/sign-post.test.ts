import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { signPost } from '../../../src/messaging/sign-post.js';
import { makeTestSigner } from '../../helpers/test-signer.js';
import { popclaw } from '@popclaw/contracts';

// Load canonical-serialization fixtures for CID parity checks.
const FIXTURES_PATH = resolve(__dirname, '../../../../../protocol/packages/contracts/fixtures/test-vectors.json');
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, 'utf-8')) as {
  canonical_serialization: Array<{ name: string; cid: string }>;
};

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

// CID of post_root_minimal — derived from fixtures so it auto-updates after gen-fixtures.
const ROOT_CID = fixtures.canonical_serialization.find((v) => v.name === 'post_root_minimal')!.cid;

describe('signPost', () => {
  it('signs root post with prev_event_id omitted from wire', async () => {
    const signer = makeTestSigner('BlackFeather');
    const result = await signPost(signer, {
      body: 'hello world',
      nickname: 'BlackFeather',
      ts: 1713657600,
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    // proto3 default — field absent on wire → decoded as ""
    expect(env.prevEventId).toBe('');
    // ADR-0025 task 4.5b: lorehouse is empty (omitted from wire = "the house you're talking to")
    expect(env.lorehouse).toBe('');
    expect(env.actor?.nickname).toBe('BlackFeather');
    expect(env.post?.blocks).toHaveLength(1);
    expect(env.post?.blocks?.[0]?.content).toBe('hello world');
    // blockType TEXT = 0 — proto3 default, decoded from absent field
    expect(env.post?.blocks?.[0]?.blockType).toBe(0);
  });

  it('signs reply post matches post_reply_minimal vector', async () => {
    const POST_ROOT_MINIMAL_CID = ROOT_CID;
    const signer = makeTestSigner('Scout');
    const result = await signPost(signer, {
      body: 'ack',
      replyTo: POST_ROOT_MINIMAL_CID,
      nickname: 'Scout',
      ts: 1713657700,
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.prevEventId).toBe(POST_ROOT_MINIMAL_CID);
    expect(env.post?.blocks).toHaveLength(1);
    expect(env.post?.blocks?.[0]?.content).toBe('ack');

    const vector = fixtures.canonical_serialization.find((v) => v.name === 'post_reply_minimal');
    if (!vector) throw new Error('post_reply_minimal fixture missing');
    expect(result.eventId).toBe(vector.cid);
  });

  it('signs quote post with both prev_event_id and LINK_CARD popclaw URL', async () => {
    const signer = makeTestSigner('Scout');
    const result = await signPost(signer, {
      body: '城东更便宜',
      quoteOf: HEX64_A,
      nickname: 'Scout',
      ts: 1713657800,
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);

    expect(env.prevEventId).toBe(HEX64_A);
    expect(env.post?.blocks).toHaveLength(2);
    expect(env.post?.blocks?.[0]?.content).toBe('城东更便宜');
    expect(env.post?.blocks?.[0]?.blockType).toBe(0); // TEXT default
    expect(env.post?.blocks?.[1]?.blockType).toBe(5); // LINK_CARD
    expect(env.post?.blocks?.[1]?.content).toBe(`https://popclaw.me/post/${HEX64_A}`);
  });

  it('throws when both reply and quote provided', async () => {
    const signer = makeTestSigner('BlackFeather');
    await expect(
      signPost(signer, { body: 'x', replyTo: HEX64_A, quoteOf: HEX64_B, nickname: 'X' }),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it('throws when body is empty or whitespace-only', async () => {
    const signer = makeTestSigner('BlackFeather');
    await expect(signPost(signer, { body: '', nickname: 'X' })).rejects.toThrow(/non-empty/);
    await expect(signPost(signer, { body: '   \n  ', nickname: 'X' })).rejects.toThrow(/non-empty/);
  });

  it('throws when nickname is empty or whitespace-only', async () => {
    const signer = makeTestSigner('BlackFeather');
    await expect(signPost(signer, { body: 'x', nickname: '' })).rejects.toThrow(/nickname/);
    await expect(signPost(signer, { body: 'x', nickname: '   ' })).rejects.toThrow(/nickname/);
  });

  it('sets actor.nickname; lorehouse is empty (ADR-0025 task 4.5b)', async () => {
    const signer = makeTestSigner('Scout');
    const result = await signPost(signer, { body: 'hi', nickname: 'Scout', ts: 1713657600 });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    expect(env.actor?.nickname).toBe('Scout');
    // lorehouse is omitted from wire (proto3 default "") — the house you're talking to
    expect(env.lorehouse).toBe('');
  });

  it('matches post_quote_minimal CID parity vector', async () => {
    // Load post_quote_minimal fixture (built by Task 2 Rust generator).
    // Building the same envelope via signPost must produce identical CID.
    const vector = fixtures.canonical_serialization.find((v) => v.name === 'post_quote_minimal');
    if (!vector) throw new Error('post_quote_minimal fixture missing from test-vectors.json');

    // The quote target is the CID of post_root_minimal (the root post).
    const signer = makeTestSigner('Scout');
    const result = await signPost(signer, {
      body: '城东更便宜',
      quoteOf: ROOT_CID,
      nickname: 'Scout',
      ts: 1713657800,
    });
    expect(result.eventId).toBe(vector.cid);
  });

  it('proto3 default elision: root post CID matches post_root_minimal vector', async () => {
    const signer = makeTestSigner('BlackFeather');
    const result = await signPost(signer, {
      body: 'hi',
      nickname: 'BlackFeather',
      ts: 1713657600,
    });
    const sp = popclaw.identity.SignedPayload.decode(result.signedPayloadBytes);
    const env = popclaw.event.EventEnvelope.decode(sp.payload);
    // Field absent on wire → pbjs decodes as proto3 default "" for string.
    expect(env.prevEventId).toBe('');

    const vector = fixtures.canonical_serialization.find((v) => v.name === 'post_root_minimal');
    if (!vector) throw new Error('post_root_minimal fixture missing');
    expect(result.eventId).toBe(vector.cid);
  });
});
