/**
 * sign Reply / DirectMessage envelopes.
 *
 * Mirrors `social-graph/sign-event.ts` but for the messaging events. Same
 * Invariant #1 discipline: any proto3-default field MUST be omitted from
 * the JS object before pbjs encoding, otherwise the canonical CID will
 * differ from what prost (Rust) recomputes after decode and lore-house
 * will reject with `cid_mismatch`.
 *
 * Default values to elide on the wire:
 *   - PostRef.author_popclaw_id (string ""):  omit when unknown
 *   - DirectMessage.in_reply_to_post:         omit when no post context
 *   - Reply.ts / DirectMessage.ts:            int64 0 — but we always set
 *                                              a real timestamp so this
 *                                              is never default in practice
 *   - envelope.lorehouse (string ""):         always omit — empty = "the house
 *                                              you're talking to" (ADR-0025 task 4.5b)
 */

import { signEnvelope, type SignEnvelopeResult } from '../identity/sign-envelope.js';
import type { Signer } from '../identity/signer.js';
import { popclaw, checkEnvelopeWire } from '../protocol/public-envelope-generated.js';
import nacl from 'tweetnacl';

export interface PostRefArgs {
  readonly platform: string;
  readonly platformPostId: string;
  readonly authorPopclawId?: string;
}

export interface ReplyArgs {
  readonly inReplyTo: PostRefArgs;
  readonly body: string;
  /** Actor's display name — must be non-empty. */
  readonly nickname: string;
  /** Optional override for the timestamp; defaults to now. */
  readonly ts?: number;
}

export interface DirectMessageArgs {
  readonly replyToEventId?: string;
  readonly toPopclawId: string;
  readonly body: string;
  /** Actor's display name — must be non-empty. */
  readonly nickname: string;
  /** Optional context: a post that triggered this DM. */
  readonly inReplyToPost?: PostRefArgs;
  /** Optional override for the timestamp; defaults to now. */
  readonly ts?: number;
  /**
   * An image carried along with the message (#231). It is sealed into a
   * **second box** (its own nonce), not inside the body. When no image is
   * attached, these two proto fields must be omitted entirely — passing an
   * empty array would change the canonical bytes and cause CID drift.
   */
  readonly media?: { readonly bytes: Uint8Array; readonly mime: string };
}

/**
 * What `DirectMessage.body` (field 4) carries once the real body rides in
 * `ciphertext` — base64("encrypted"). It is NOT the message.
 *
 * It exists solely because an un-upgraded lore-house rejects an empty body
 * (`payload_validators.rs:1023`), so old houses keep relaying encrypted DMs
 * unchanged during the transition. Readers discriminate on `looksEncrypted()`
 * (ciphertext presence), never on this string — do not turn it into a sentinel.
 */
export const DM_ENCRYPTED_BODY_PLACEHOLDER = 'ZW5jcnlwdGVk';

function buildPostRef(args: PostRefArgs): Record<string, unknown> {
  const ref: Record<string, unknown> = {
    platform: args.platform,
    platformPostId: args.platformPostId,
  };
  // authorPopclawId is empty-string default — omit when unknown.
  if (args.authorPopclawId && args.authorPopclawId.length > 0) {
    ref.authorPopclawId = args.authorPopclawId;
  }
  return ref;
}

export async function signReply(
  signer: Signer,
  args: ReplyArgs,
): Promise<SignEnvelopeResult> {
  if (!args.nickname.trim()) {
    throw new Error('signReply: actor.nickname must be non-empty');
  }
  const popclawId = await signer.popclawId();
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  const reply: Record<string, unknown> = {
    fromPopclawId: popclawId,
    inReplyTo: buildPostRef(args.inReplyTo),
    body: args.body,
    ts,
  };

  const env: Record<string, unknown> = {
    actor: { popclawId, nickname: args.nickname },
    // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
    timestamp: ts,
    reply,
  };
  return signEnvelope(signer, env);
}

export async function signDirectMessage(
  signer: Signer,
  args: DirectMessageArgs,
): Promise<SignEnvelopeResult> {
  return signEnvelope(signer, await buildDirectMessageEnvelope(signer, args));
}

/** Exact protobuf capacity check before showing a draft. No signature,
 * SignedPayload, egress, confirmation or receipt is produced. Ed25519
 * signatures have fixed length; the CID is a 64-character SHA-256 hex.
 * Sending still checks the actual signed bytes in signEnvelope. */
export async function checkDirectMessageFits(signer: Signer, args: DirectMessageArgs): Promise<number> {
  const envelope = await buildDirectMessageEnvelope(signer, args);
  const bytes = popclaw.event.EventEnvelope.encode({
    ...envelope, eventId: '0'.repeat(64), signature: new Uint8Array(nacl.sign.signatureLength),
  }).finish();
  checkEnvelopeWire(bytes);
  return bytes.length;
}

async function buildDirectMessageEnvelope(signer: Signer, args: DirectMessageArgs): Promise<Record<string, unknown>> {
  if (!args.nickname.trim()) {
    throw new Error('signDirectMessage: actor.nickname must be non-empty');
  }
  const popclawId = await signer.popclawId();
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  // #227: the body is sealed to the recipient before it ever reaches the wire.
  // Throws on an unusable recipient id — see DM_ENCRYPTED_BODY_PLACEHOLDER.
  const sealed = signer.sealDm(args.body, args.toPopclawId);
  const dm: Record<string, unknown> = {
    fromPopclawId: popclawId,
    toPopclawId: args.toPopclawId,
    body: DM_ENCRYPTED_BODY_PLACEHOLDER,
    ts,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
  };
  // in_reply_to_post is a sub-message; omit entirely when not provided
  // (proto3 default for message-typed fields).
  if (args.inReplyToPost) {
    dm.inReplyToPost = buildPostRef(args.inReplyToPost);
  }
  // #231 image: the second box. **Only write these two fields when there is
  // actually an image** — Invariant #1: empty bytes is the proto3 default value,
  // and writing it in would make the CID recomputed after prost decoding mismatch.
  if (args.media) {
    const sealedMedia = signer.sealDmMedia(args.media.bytes, args.media.mime, args.toPopclawId);
    dm.mediaCiphertext = sealedMedia.ciphertext;
    dm.mediaNonce = sealedMedia.nonce;
  }

  const env: Record<string, unknown> = {
    actor: { popclawId, nickname: args.nickname },
    // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
    timestamp: ts,
    target: { scope: 1, targetIds: [args.toPopclawId] },
    directMessage: dm,
    ...(args.replyToEventId ? { prevEventId: args.replyToEventId } : {}),
  };
  return env;
}
