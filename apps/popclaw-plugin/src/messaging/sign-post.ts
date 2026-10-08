/**
 * Plan: /popclaw post — sign popclaw-native PostPayload envelopes.
 *
 * Three modes:
 *   1. Root post: prev_event_id omitted from envelope.
 *   2. Pure reply: envelope.prev_event_id = target event_id; blocks = [TEXT body].
 *   3. Quote post: envelope.prev_event_id = target; blocks = [TEXT body, LINK_CARD
 *      with content = https://popclaw.me/post/<target>].
 *
 * Canonical encoding invariant:
 *   - prev_event_id "" MUST be omitted (not set on object) — pbjs would emit
 *     a zero tag and prost-decoded CID would mismatch.
 *   - ContentBlock.block_type=0 (TEXT) MUST be omitted; only set blockType
 *     when LINK_CARD (=5).
 *   - ContentBlock.metadata={} MUST be omitted (empty map elision).
 *   - actor.nickname MUST be set (never default ""); runtime fallback guarantees.
 *   - envelope.lorehouse MUST be omitted (proto3 default "" = empty = "the house you're
 *     talking to"; ADR-0025 task 4.5b). DO NOT set lorehouse on the JS object.
 *   - PostPayload.media=[] MUST NOT be set on the JS object (empty repeated elision).
 */
import { signEnvelope, type SignEnvelopeResult } from '../identity/sign-envelope.js';
import type { Signer } from '../identity/signer.js';

const LINK_CARD_BLOCK_TYPE = 5;
const POPCLAW_POST_URL_PREFIX = 'https://popclaw.me/post/';
const HEX64 = /^[0-9a-f]{64}$/;

export interface PostArgs {
  readonly body: string;
  /** event_id (64 hex chars) of the post being replied to. Mutually exclusive with quoteOf. */
  readonly replyTo?: string;
  /** event_id (64 hex chars) of the post being quoted. Mutually exclusive with replyTo. */
  readonly quoteOf?: string;
  /** Actor's display name. MUST be non-empty; runtime provides fallback "ranger-<first6>". */
  readonly nickname: string;
  /** Unix timestamp in seconds. Defaults to Math.floor(Date.now() / 1000). */
  readonly ts?: number;
}

/**
 * Sign a PostPayload envelope for one of three modes:
 *   - Root post: neither replyTo nor quoteOf provided.
 *   - Pure reply: replyTo = target event_id.
 *   - Quote post: quoteOf = target event_id.
 */
export async function signPost(
  signer: Signer,
  args: PostArgs,
): Promise<SignEnvelopeResult> {
  if (args.replyTo && args.quoteOf) {
    throw new Error('signPost: --reply and --quote are mutually exclusive');
  }
  if (!args.body.trim()) {
    throw new Error('signPost: post body must be non-empty (got whitespace or empty)');
  }
  if (!args.nickname.trim()) {
    throw new Error('signPost: actor.nickname must be non-empty');
  }
  if (args.replyTo && !HEX64.test(args.replyTo)) {
    throw new Error(`signPost: replyTo must be 64 hex chars, got: ${args.replyTo.slice(0, 24)}...`);
  }
  if (args.quoteOf && !HEX64.test(args.quoteOf)) {
    throw new Error(`signPost: quoteOf must be 64 hex chars, got: ${args.quoteOf.slice(0, 24)}...`);
  }

  const popclawId = await signer.popclawId();
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  const prev = args.replyTo ?? args.quoteOf ?? '';

  // Build blocks.
  // NOTE: keep body as-is (no trim) on wire — validation only checks trim.
  // The signed canonical bytes preserve the user's input verbatim.
  const blocks: Array<Record<string, unknown>> = [
    {
      // blockType: 0 (TEXT) — DO NOT SET on object (Invariant #1: proto3 default elision).
      content: args.body,
      // metadata: {} — DO NOT SET (empty map elision, Invariant #1).
    },
  ];
  if (args.quoteOf) {
    blocks.push({
      blockType: LINK_CARD_BLOCK_TYPE, // non-zero, MUST be set explicitly
      content: `${POPCLAW_POST_URL_PREFIX}${args.quoteOf}`,
      // metadata: {} — DO NOT SET (empty map elision, Invariant #1).
    });
  }

  // PostPayload — media: [] MUST NOT be set on the JS object (empty repeated elision).
  const post: Record<string, unknown> = { blocks };

  const env: Record<string, unknown> = {
    actor: { popclawId, nickname: args.nickname },
    // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
    timestamp: ts,
    post,
  };
  if (prev) {
    env.prevEventId = prev;
  }
  // else: DO NOT set prevEventId (Invariant #1 — proto3 default "" must not emit)

  return signEnvelope(signer, env);
}
