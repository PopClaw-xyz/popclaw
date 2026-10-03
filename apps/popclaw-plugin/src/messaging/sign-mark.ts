/**
 * ADR-0019 — sign Mark / MarkRevoked envelopes.
 * Same Invariant #1 discipline as sign-message.ts: MarkPayload has only one
 * marked_event_id field, and a valid value is always 64 non-empty hex chars, so
 * there is no proto3 default value that needs eliding.
 * (Contrast with sign-message.ts: PostRef.author_popclaw_id and
 * DirectMessage.in_reply_to_post both have default values that need eliding;
 * the Mark family has no such issue.)
 *
 * ADR-0025 task 4.5b: envelope.lorehouse is omitted (proto3 default "" = "the house
 * you're talking to"). DO NOT set lorehouse on the JS object.
 */

import { signEnvelope, type SignEnvelopeResult } from '../identity/sign-envelope.js';
import type { Signer } from '../identity/signer.js';

const HEX64 = /^[0-9a-f]{64}$/;

/** Marks are always popclaw-native; no platform override by design. */
export interface MarkArgs {
  readonly markedEventId: string;
  readonly nickname: string;
  readonly ts?: number;
}

function assertArgs(args: MarkArgs, fn: string): void {
  if (!args.nickname.trim()) throw new Error(`${fn}: actor.nickname must be non-empty`);
  if (!HEX64.test(args.markedEventId)) throw new Error(`${fn}: markedEventId must be 64 lowercase hex chars`);
}

export async function signMark(signer: Signer, args: MarkArgs): Promise<SignEnvelopeResult> {
  assertArgs(args, 'signMark');
  const popclawId = await signer.popclawId();
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  return signEnvelope(signer, {
    actor: { popclawId, nickname: args.nickname },
    // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
    timestamp: ts,
    mark: { markedEventId: args.markedEventId },
  });
}

export async function signMarkRevoked(signer: Signer, args: MarkArgs): Promise<SignEnvelopeResult> {
  assertArgs(args, 'signMarkRevoked');
  const popclawId = await signer.popclawId();
  const ts = args.ts ?? Math.floor(Date.now() / 1000);
  return signEnvelope(signer, {
    actor: { popclawId, nickname: args.nickname },
    // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
    timestamp: ts,
    markRevoked: { markedEventId: args.markedEventId },
  });
}
