import { assertActionActive, questAction, rethrowActionCancellation, runAction, signActionEnvelope, type ActionGate } from '../runtime/house-lifecycle/action-context.js';
/**
 * VerifyInviteHandler.
 *
 * Decision precedence (highest first):
 *   1. `mock` injected via constructor / createDefaultMock() from env —
 *      `POPCLAW_VERIFY_STUB_OUTCOME={APPROVE|REJECT|ABSTAIN}`. E2E
 *      scenarios S-B1/S-B2/S-B4 rely on this for determinism.
 *   2a. `proofUrl` (ADR-0034) — when the payload carries a post URL and the
 *      scraper supports by-id fetch: extract `/status/<digits>`, fetch the post
 *      by id, APPROVE iff the provider says the claimed handle authored it AND
 *      the bound token is in its text. Any miss falls through to 2b — this path
 *      never REJECTs on its own. Needed because provider search indexes are
 *      blind to low-follower / freshly-registered accounts, i.e. the onboarding
 *      population. Placement rule does not apply here (explicit author check
 *      replaces it), so a reply under someone else's post is valid proof.
 *   2b. `scraper` (PlatformScraper) — production path. Calls
 *      `fetchVerificationTargets(handle)`; APPROVE iff the bound token
 *      `<handle>#<sigil>` (case-insensitive) appears in the handle's first
 *      post text OR in any self-reply authored by the same handle under one
 *      of their own posts.
 *      Binding the handle (not a bare sigil) defeats the quote-tweet/repost
 *      replay: a repost carries the original author's handle, never the
 *      claimed one. REJECT if fetched OK but the token is absent, ABSTAIN if
 *      the fetch itself failed. Bio / pinned post are NO LONGER valid.
 *   3. Fallback: ABSTAIN with reason "no scraper configured".
 *
 * Evidence policy (spec §5.5, Strategy Z):
 *   - evidence_hash = SHA-256(rawBytes of the fetched response)
 *   - evidence_sample = first 16 KB of rawBytes
 * For the mock / fallback paths, evidence_hash stays 32 zero bytes (still
 * non-default so pbjs + prost encode identically) and evidence_sample is
 * omitted (proto3-default conditional spread — see Invariant #1).
 */

import { createHash } from 'node:crypto';
import type { Signer } from '../identity/signer.js';
import type { EventEgress } from '../egress/event-egress.js';
import type { InboundEnvelope } from '../ingress/event-ingress.js';
import {
  canonicalPlatform,
  type AuthorProfileSnapshot,
  type FetchedPost,
  type PlatformScraper,
  type PlatformScraperRegistry,
} from '../scraper/platform-scraper.js';

/**
 * ADR-0034: pull the platform-native post id out of a proof URL.
 *
 * The URL is an UNTRUSTED pointer supplied by the applicant. Only the numeric
 * `/status/<id>` path segment is honoured — never the host, never the handle
 * segment, never a query param (`?u=https://x.com/a/status/1` must not match).
 * Everything the decision rests on is re-fetched from the provider by that id.
 */
export function extractPostId(rawUrl: string): string | null {
  let pathname: string;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    pathname = u.pathname;
  } catch {
    return null;
  }
  return /\/status\/(\d+)(?:\/|$)/.exec(pathname)?.[1] ?? null;
}

export type VerifyInviteOutcome = 'APPROVE' | 'REJECT' | 'ABSTAIN';

export interface VerifyInviteMockHook {
  decide(payload: Record<string, unknown>): VerifyInviteOutcome;
}

/**
 * Reads `POPCLAW_VERIFY_STUB_OUTCOME` and returns a hook matching the
 * requested outcome, or `undefined` to fall back to scraper / ABSTAIN.
 */
export function createDefaultMock(): VerifyInviteMockHook | undefined {
  const env = process.env.POPCLAW_VERIFY_STUB_OUTCOME;
  if (!env) return undefined;
  const upper = env.toUpperCase() as VerifyInviteOutcome;
  if (upper !== 'APPROVE' && upper !== 'REJECT' && upper !== 'ABSTAIN') return undefined;
  return { decide: () => upper };
}

const OUTCOME_TO_PROTO: Record<VerifyInviteOutcome, number> = {
  APPROVE: 1,
  REJECT: 2,
  ABSTAIN: 3,
};

const EVIDENCE_SAMPLE_MAX_BYTES = 16_384;

export interface VerifyInviteHandlerDeps {
  readonly gate?: ActionGate;
  readonly now?: () => number;
  readonly signer: Signer;
  readonly egress: EventEgress;
  readonly mock?: VerifyInviteMockHook;
  readonly scraperRegistry?: PlatformScraperRegistry;
  readonly loggerInfo?: (msg: string) => void;
}

export class VerifyInviteHandler {
  constructor(private readonly deps: VerifyInviteHandlerDeps) {}

  /**
   * ADR-0034 proof path. Returns the by-id evidence only when BOTH hold:
   *   1. the provider says the claimed handle authored the post (case-insensitive)
   *      — without this check anyone could point at a post that merely quotes
   *      the token and get verified;
   *   2. the bound token `<handle>#<sigil>` is in the post text.
   * Everything else — malformed URL, no by-id support, transport error, no such
   * post, wrong author, missing token — returns null so the caller falls back to
   * the search path. Never REJECTs by itself: a proof miss is not evidence of a
   * bad claim, only of a bad pointer.
   *
   * The placement rule (first post / self-reply) does NOT apply here: it was a
   * proxy for "we can't tell who wrote this". With an explicit author check any
   * post under that handle — including a reply to someone else — is valid proof.
   */
  private async tryProofUrl(
    scraper: PlatformScraper,
    proofUrl: string,
    handle: string,
    boundToken: string,
  ): Promise<{ hit: FetchedPost | null; miss?: string }> {
    if (!proofUrl) return { hit: null };
    if (!scraper.fetchPostById) return { hit: null, miss: 'by-id fetch unsupported' };
    const postId = extractPostId(proofUrl);
    if (!postId) return { hit: null, miss: 'no /status/<id> in url' };
    let fetched: FetchedPost;
    try {
      assertActionActive(this.deps.gate);
      fetched = await scraper.fetchPostById(postId);
      assertActionActive(this.deps.gate);
    } catch (err) {
      rethrowActionCancellation(err);
      this.deps.loggerInfo?.(
        `verify-invite: proof fetch failed for post ${postId} (${String(err).slice(0, 120)}); falling back to search`,
      );
      return { hit: null, miss: `fetch failed: ${String(err).slice(0, 80)}` };
    }
    if (!fetched.post) return { hit: null, miss: 'post not found or not a plain tweet' };
    if ((fetched.authorHandle ?? '').toLowerCase() !== handle.toLowerCase()) {
      this.deps.loggerInfo?.(
        `verify-invite: proof post ${postId} authored by '${fetched.authorHandle ?? ''}', not '${handle}'; falling back to search`,
      );
      return { hit: null, miss: `author '${fetched.authorHandle ?? ''}' != '${handle}'` };
    }
    if (!fetched.post.text.toLowerCase().includes(boundToken)) {
      return { hit: null, miss: 'bound token not in post text' };
    }
    return { hit: fetched };
  }

  async handle(dispatchEnv: InboundEnvelope, payload: Record<string, unknown>): Promise<void> {
    const dispatch = dispatchEnv.envelope['questDispatch'] as Record<string, unknown> | undefined;
    await runAction(questAction(this.deps.gate, dispatch?.['expiresAt'], this.deps.now), () => this.handleActive(dispatchEnv, payload));
  }

  private async handleActive(dispatchEnv: InboundEnvelope, payload: Record<string, unknown>): Promise<void> {
    assertActionActive(this.deps.gate);
    const envelope = dispatchEnv.envelope;
    const dispatch = envelope['questDispatch'] as { taskId?: string } | undefined;
    const taskId = dispatch?.taskId ?? '';
    const platform = (payload['platform'] as string) ?? '';
    const handle = (payload['handle'] as string) ?? '';
    const expectedSigil = (payload['expectedSigil'] as string) ?? '';
    // ADR-0034: optional applicant-supplied post URL. Untrusted pointer — see extractPostId.
    const proofUrl = (payload['proofUrl'] as string) ?? '';

    let outcome: VerifyInviteOutcome;
    let evidenceHash: Uint8Array = new Uint8Array(32);
    let evidenceSample: Uint8Array | null = null;
    let reason: string | undefined;
    // ADR-0025 task 4.3: platform-native stable account id captured during verify.
    // undefined until the scraper populates it; stays undefined for mock/fallback paths.
    let accountId: string | undefined;
    // ADR-0040: the scraper that actually decided this outcome — only it gets asked
    // for the snapshot, so the mock/no-scraper paths never spend a cent.
    let decidingScraper: PlatformScraper | undefined;

    if (this.deps.mock) {
      outcome = this.deps.mock.decide(payload);
      reason = outcome === 'APPROVE' ? undefined : `stub=${outcome}`;
    } else if (this.deps.scraperRegistry) {
      const scraper = this.deps.scraperRegistry.get(canonicalPlatform(platform));
      if (!scraper) {
        this.deps.loggerInfo?.(
          `verify-invite: no scraper for platform '${platform}' (handle='${handle}'); ABSTAIN`,
        );
        outcome = 'ABSTAIN';
        reason = 'no scraper configured';
      } else if (handle && expectedSigil) {
        decidingScraper = scraper;
        // Bind the handle to the sigil: match the token `<handle>#<sigil>`,
        // not a bare sigil. A bare/short sigil leaks via quote-tweets and
        // reposts — anyone reposting someone's verify-tweet carries the sigil
        // into their own timeline and could be falsely verified. The bound
        // token carries the ORIGINAL author's handle, so a repost of someone
        // else's token never matches the claimed handle. Plain text (no
        // t.co/expanded-url parsing needed); case-insensitive because X
        // handles are. Same `<handle>#<sigil>` form the invite copy emits.
        const boundToken = `${handle}#${expectedSigil}`.toLowerCase();
        // ADR-0034: proof path first — a by-id lookup sees the low-follower /
        // brand-new accounts the search index is blind to. It never REJECTs on
        // its own; any miss falls through to the search path below, and only
        // both failing produces REJECT/ABSTAIN.
        assertActionActive(this.deps.gate);
        const proof = await this.tryProofUrl(scraper, proofUrl, handle, boundToken);
        assertActionActive(this.deps.gate);
        if (proof.hit) {
          outcome = 'APPROVE';
          evidenceHash = new Uint8Array(createHash('sha256').update(proof.hit.rawBytes).digest());
          evidenceSample = proof.hit.rawBytes.slice(0, EVIDENCE_SAMPLE_MAX_BYTES);
          accountId = proof.hit.accountId;
        } else {
          // Server-side audit trail: why the proof missed (P6). Without this the
          // real-machine diagnosis that motivated ADR-0034 has no trail.
          const proofNote = proof.miss ? `; proof: ${proof.miss}` : '';
          try {
            assertActionActive(this.deps.gate);
            const targets = await scraper.fetchVerificationTargets(handle);
            assertActionActive(this.deps.gate);
            const hasToken = (text: string) => text.toLowerCase().includes(boundToken);
            const firstMatch = targets.firstPost ? hasToken(targets.firstPost.text) : false;
            const replyMatch = targets.selfReplies.some((r) => hasToken(r.text));
            const found = firstMatch || replyMatch;
            outcome = found ? 'APPROVE' : 'REJECT';
            evidenceHash = new Uint8Array(
              createHash('sha256').update(targets.rawBytes).digest(),
            );
            evidenceSample = targets.rawBytes.slice(0, EVIDENCE_SAMPLE_MAX_BYTES);
            reason = found
              ? undefined
              : `${handle}#${expectedSigil} not in firstPost/selfReplies${proofNote}`;
            // ADR-0025 task 4.3: capture stable account id from verification targets.
            accountId = targets.accountId;
          } catch (err) {
            rethrowActionCancellation(err);
            outcome = 'ABSTAIN';
            reason = `scrape failed: ${String(err).slice(0, 200)}${proofNote}`;
          }
        }
      } else {
        outcome = 'ABSTAIN';
        reason = 'no scraper configured';
      }
    } else {
      outcome = 'ABSTAIN';
      reason = 'no scraper configured';
    }

    // #180: the reason used to stay off the local log — a drained provider balance
    // read as a plain "outcome=ABSTAIN" on the machine while every verification
    // silently failed. Non-APPROVE always says why (info level: the host sends
    // warn/error to /dev/null, so info is the only channel an operator can grep).
    this.deps.loggerInfo?.(
      `verify-invite: task=${taskId} handle=${handle} outcome=${outcome}`
      + (outcome === 'APPROVE' || !reason ? '' : ` reason=${reason}`),
    );

    // ADR-0040: one extra user/info call on APPROVE only — the follower/avatar/bio
    // snapshot of the moment this account was verified. NEVER touches `outcome`:
    // an experience nicety that can block the core path is a bug, so any failure
    // reports zeros (proto3 defaults, elided on the wire = CID-compat) and the
    // APPROVE stands.
    let snapshot: AuthorProfileSnapshot | null = null;
    if (outcome === 'APPROVE' && decidingScraper?.fetchAuthorProfile) {
      try {
        assertActionActive(this.deps.gate);
        snapshot = await decidingScraper.fetchAuthorProfile(handle);
        assertActionActive(this.deps.gate);
      } catch (err) {
        rethrowActionCancellation(err);
        this.deps.loggerInfo?.(
          `verify-invite: snapshot fetch failed for ${handle} (${String(err).slice(0, 120)}); approving without it`,
        );
      }
    }

    // Conditional-spread for proto3-default safety (Invariant #1).
    const questResult: Record<string, unknown> = {
      taskId,
      outcome: OUTCOME_TO_PROTO[outcome],
      evidenceHash,
    };
    if (evidenceSample && evidenceSample.length > 0) {
      questResult['evidenceSample'] = evidenceSample;
    }
    if (reason) {
      questResult['reason'] = reason;
    }
    // ADR-0025 task 4.3: include accountId when captured (proto3 default "" = elides).
    if (accountId) {
      questResult['accountId'] = accountId;
    }
    // ADR-0040 fields 7/8/9 — same conditional-spread discipline: zero values stay
    // off the wire so CIDs match rangers that never took a snapshot.
    if (snapshot) {
      if (snapshot.followerCount > 0) questResult['followerCount'] = snapshot.followerCount;
      if (snapshot.avatarUrl) questResult['avatarUrl'] = snapshot.avatarUrl;
      if (snapshot.bio) questResult['bio'] = snapshot.bio;
    }

    const resultEnvelope: Record<string, unknown> = {
      actor: {
        popclawId: await this.deps.signer.popclawId(),
      },
      // lorehouse: omit (proto3 default "" = "the house you're talking to", ADR-0025 task 4.5b)
      // Note: `platform` here is the social platform (e.g. "twitter"), not the lorehouse.
      timestamp: Math.floor(Date.now() / 1000),
      questResult,
    };

    const signed = await signActionEnvelope(this.deps.signer, resultEnvelope);
    assertActionActive(this.deps.gate);
    const res = await this.deps.egress.push(signed.signedPayloadBytes);
    assertActionActive(this.deps.gate);
    this.deps.loggerInfo?.(
      `verify-invite: pushed task=${taskId} outcome=${outcome} http=${res.status}`,
    );
  }
}
