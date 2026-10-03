import type { Signer } from '../identity/signer.js';

export interface InviteRequestBuildOpts {
  readonly platform: string;
  readonly handle: string;
  /** Optional override for the actor nickname; defaults to the builder's nickname. */
  readonly nickname?: string;
  /** ADR-0026: swap intent. When the owner already has a verified account on this
   *  platform, replace=true bypasses lore-house's request-time conflict so the new
   *  handle can be filed; the old binding is overwritten only when the new one verifies. */
  readonly replace?: boolean;
  /** ADR-0034: platform-native URL of the post carrying the bound token; enables the
   *  ranger's by-id direct-fetch path (search indexes are blind to new/low-follower
   *  accounts). Empty/absent = the legacy search-discovery path. */
  readonly proofUrl?: string;
  /**
   * The applicant's answer to "keep syncing my later
   * posts?". Rides on their own signed request, so consent is theirs, not a
   * server-side setting. Omitted / false = elided on the wire (CID-compatible).
   */
  readonly mirrorOptin?: boolean;
}

/**
 * Builds canonical EventEnvelope objects for the plugin's outbound events.
 *
 * Envelope construction (shape + timestamps + oneof payload) lives here.
 * Two-stage signing + SignedPayload wrapping lives in `signEnvelope` (used by
 * the invite path's `signEnvelope(signer, buildInviteRequest(...))`).
 */
export class EventBuilder {
  constructor(
    private readonly signer: Signer,
    /** A function reads the owner's name at build time (a rename must reach the next envelope). */
    private readonly nickname: string | (() => string),
  ) {}

  /**
   * Build an unsigned invite_request envelope.
   *
   * Platform belongs to InviteRequestPayload; it is not an envelope field.
   * Timestamp is the current wall clock.
   *
   * Returned object has no `eventId` and no `signature`; feed it to
   * `signEnvelope(signer, envelope)` to produce a SignedPayload.
   */
  async buildInviteRequest(opts: InviteRequestBuildOpts): Promise<Record<string, unknown>> {
    const popclawId = await this.signer.popclawId();
    const nickname = opts.nickname ?? (typeof this.nickname === 'function' ? this.nickname() : this.nickname);

    return {
      actor: {
        popclawId,
        nickname,
      },
      timestamp: Math.floor(Date.now() / 1000),
      inviteRequest: {
        platform: opts.platform,
        handle: opts.handle,
        nickname,
        // Omit when false so the common (non-swap) path stays byte-identical (CID-compat).
        ...(opts.replace ? { replace: true } : {}),
        // Same CID-compat rule: proto3 default "" elides, so no-proof invites keep their old bytes.
        ...(opts.proofUrl ? { proofUrl: opts.proofUrl } : {}),
        ...(opts.mirrorOptin ? { mirrorOptin: true } : {}),
      },
    };
  }
}
