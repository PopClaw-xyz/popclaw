/**
 * InviteInitiator — orchestrates the three-step flow for requesting
 * verification of a (platform, handle) account:
 *
 *   1. EventBuilder.buildInviteRequest  → unsigned InviteRequestPayload envelope
 *   2. signEnvelope (two-stage CID + inner + outer sig) → SignedPayload bytes
 *   3. ServerPushEgress.push              → POST /v1/push
 *
 * Returns both the lore-house-accepted event_id and the canonical sigil the
 * applicant now needs to paste into their `platform` bio so the 3 verifier
 * rangers can cross-check. The sigil is returned here (rather than queried
 * back from lore-house) because it's deterministic from popclaw_id alone
 * and the plugin can show it before the invite is accepted on the server.
 */

import type { Signer } from '../identity/signer.js';
import type { EventBuilder } from '../event/event-builder.js';
import type { EventEgress, PushResult } from '../egress/event-egress.js';
import { signEnvelope } from '../identity/sign-envelope.js';
import { deriveSigil } from './sigil.js';

export interface InviteInitiatorDeps {
  readonly signer: Signer;
  readonly eventBuilder: EventBuilder;
  readonly egress: EventEgress;
}

export interface InviteInitiateOpts {
  readonly platform: string;
  readonly handle: string;
  readonly nickname?: string;
  /** ADR-0026: swap an already-verified account on this platform. */
  readonly replace?: boolean;
  /** ADR-0034: URL of the post carrying the bound token; lets rangers verify by-id. */
  readonly proofUrl?: string;
  /** Consent to keep mirroring later posts. Default off. */
  readonly mirrorOptin?: boolean;
}

export interface InviteInitiateResult {
  /** Canonical Crockford base32 sigil of the popclaw_id (ADR-0015) — the bound token half. */
  readonly expectedSigil: string;
  /** The event_id lore-house accepted (or undefined on non-2xx). */
  readonly pushedEventId: string | undefined;
  /** HTTP-level result for diagnostics. */
  readonly push: PushResult;
}

export class InviteInitiator {
  constructor(private readonly deps: InviteInitiatorDeps) {}

  async initiate(opts: InviteInitiateOpts): Promise<InviteInitiateResult> {
    const envelope = await this.deps.eventBuilder.buildInviteRequest({
      platform: opts.platform,
      handle: opts.handle,
      nickname: opts.nickname,
      replace: opts.replace,
      proofUrl: opts.proofUrl,
      mirrorOptin: opts.mirrorOptin,
    });
    const signed = await signEnvelope(this.deps.signer, envelope);
    const push = await this.deps.egress.push(signed.signedPayloadBytes);
    const popclawId = await this.deps.signer.popclawId();
    return {
      expectedSigil: deriveSigil(popclawId),
      pushedEventId: push.eventId ?? signed.eventId,
      push,
    };
  }
}
