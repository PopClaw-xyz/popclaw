/**
 * S1 (three-act onboarding spec §3/§8) — issues the namecard (ProfilePayload, ADR-0008).
 *
 * The produced envelope shape matches the namecard_popclaw_minimal vector: no
 * target, lorehouse omitted (empty = the local node).
 * Invariant #1: proto3 default-value fields are never set (empty string / empty
 * array never go on the wire).
 * ADR-0025 task 4.5b: envelope.lorehouse is not set (proto3 default "" = the local node).
 *
 * Note: this module is the protocol leg. The naming UX (LLM suggestions, consent
 * gate, sigil education) is wired in at S3; namecard is an onboarding stage, not
 * a /popclaw command (see memory nameplate-is-onboarding-stage-not-command).
 */
import { signEnvelope, type SignEnvelopeResult } from '../identity/sign-envelope.js';
import type { Signer } from '../identity/signer.js';

export interface ProfileArgs {
  /** Nickname. Required, non-empty — the "no meaningless default name" rule is
   *  enforced by the calling layer (the onboarding passport act). */
  readonly nickname: string;
  readonly oneLineIntro?: string;
  readonly tasteTags?: readonly string[];
  /** seeker / jester / pioneer / hermit or a free-form string; omitted if empty. */
  readonly rolePersona?: string;
  readonly locationHint?: string;
  readonly avatarUri?: string;
  /** Timestamp (unix seconds) when the owner confirmed sending. Defaults to now.
   *  Projections take the latest by this field (ADR-0008). */
  readonly declaredAt?: number;
  /** envelope timestamp (unix seconds). Defaults to match declaredAt. */
  readonly ts?: number;
}

export async function signProfile(
  signer: Signer,
  args: ProfileArgs,
): Promise<SignEnvelopeResult> {
  if (!args.nickname.trim()) {
    throw new Error('signProfile: nickname must be non-empty');
  }
  const popclawId = await signer.popclawId();
  const declaredAt = args.declaredAt ?? Math.floor(Date.now() / 1000);
  const ts = args.ts ?? declaredAt;

  const profile: Record<string, unknown> = {
    nickname: args.nickname,
    declaredAt,
  };
  if (args.oneLineIntro) profile.oneLineIntro = args.oneLineIntro;
  if (args.tasteTags && args.tasteTags.length > 0) profile.tasteTags = [...args.tasteTags];
  if (args.rolePersona) profile.rolePersona = args.rolePersona;
  if (args.locationHint) profile.locationHint = args.locationHint;
  if (args.avatarUri) profile.avatarUri = args.avatarUri;

  const env: Record<string, unknown> = {
    actor: { popclawId, nickname: args.nickname },
    // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
    timestamp: ts,
    profile,
  };
  return signEnvelope(signer, env);
}
