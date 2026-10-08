import { assertActionActive, rethrowActionCancellation } from '../runtime/house-lifecycle/action-context.js';
/**
 * HybridScraper — orchestrator: primary scraper with automatic
 * fallback on throw or empty-targets. `fallback` is optional so rangers
 * with only one configured commercial backend (e.g. Apify alone) can run
 * primary-only.
 *
 * Empty-targets is defined as `firstPost === null && selfReplies.length === 0`.
 * That matches the VerifyInviteHandler contract: with no firstPost and no
 * self-replies, the sigil cannot possibly match, so retrying via the
 * fallback is cheap and worth a shot. Primary-empty + no-fallback
 * propagates the empty result (handler treats as REJECT); primary-threw
 * + no-fallback rethrows (handler treats as ABSTAIN).
 *
 * scrapeTimeline falls back on throw only — timelines have no "empty is
 * suspicious" signal (a quiet handle really does have zero posts in
 * window), so we'd rather return `[]` than pay the fallback cost.
 *
 * TokenBucket is shared across primary + fallback: every delegated call consumes one token. Default bucket is
 * capacity 10, refill 1/s.
 */
import type {
  AuthorProfileSnapshot,
  FetchedPost,
  PlatformScraper,
  ScrapedPost,
  VerificationTargets,
} from './platform-scraper.js';
import { TokenBucket } from './token-bucket.js';

export interface HybridScraperOptions {
  readonly primary: PlatformScraper;
  readonly fallback?: PlatformScraper;
  readonly loggerInfo?: (msg: string) => void;
  /** Shared rate-limit bucket. Defaults to cap 10, refill 1/s. */
  readonly bucket?: TokenBucket;
}

export class HybridScraper implements PlatformScraper {
  private readonly bucket: TokenBucket;

  constructor(private readonly opts: HybridScraperOptions) {
    this.bucket =
      opts.bucket ?? new TokenBucket({ capacity: 10, refillPerSecond: 1 });
  }

  async fetchVerificationTargets(handle: string): Promise<VerificationTargets> {
    // Distinguish "primary threw" (transport failure → ABSTAIN when no
    // fallback) from "primary returned empty" (fetch OK, just nothing
    // matching → REJECT signal when no fallback). Both still try the
    // fallback first if configured — a retweet-only timeline is cheap to
    // re-check — but the two paths diverge when fallback is absent.
    let primaryError: Error | null = null;
    let primaryEmptyResult: VerificationTargets | null = null;
    await this.bucket.take();
    assertActionActive();
    try {
      const result = await this.opts.primary.fetchVerificationTargets(handle);
      if (result.firstPost !== null || result.selfReplies.length > 0) {
        return result;
      }
      primaryEmptyResult = result;
      this.opts.loggerInfo?.(
        `hybrid-scraper: primary empty for ${handle}, trying fallback`,
      );
    } catch (err) {
      rethrowActionCancellation(err);
      primaryError = err instanceof Error ? err : new Error(String(err));
      const snippet = primaryError.message.slice(0, 120);
      this.opts.loggerInfo?.(
        `hybrid-scraper: primary threw for ${handle}: ${snippet}`,
      );
    }

    if (!this.opts.fallback) {
      if (primaryError) throw primaryError;
      return primaryEmptyResult!;
    }

    await this.bucket.take();
    assertActionActive();
    try {
      return await this.opts.fallback.fetchVerificationTargets(handle);
    } catch (err) {
      rethrowActionCancellation(err);
      const fallbackErr = err instanceof Error ? err : new Error(String(err));
      const primaryMsg = primaryError?.message ?? 'primary empty';
      throw new Error(
        `hybrid-scraper: primary failed (${primaryMsg}); ` +
          `fallback failed (${fallbackErr.message})`,
      );
    }
  }

  /**
   * ADR-0034: by-id direct fetch, delegated to whichever side implements it
   * (v1: only twitterapi.io does). No cross-delegate retry — the caller's
   * fallback for a failed proof lookup is the search path, not the other
   * provider. Throws when neither delegate supports it; VerifyInviteHandler
   * catches that and goes back to searching.
   */
  async fetchPostById(nativePostId: string): Promise<FetchedPost> {
    const delegate = this.opts.primary.fetchPostById
      ? this.opts.primary
      : this.opts.fallback?.fetchPostById
        ? this.opts.fallback
        : undefined;
    if (!delegate?.fetchPostById) {
      throw new Error('hybrid-scraper: no delegate implements fetchPostById');
    }
    await this.bucket.take();
    assertActionActive();
    return delegate.fetchPostById(nativePostId);
  }

  /**
   * ADR-0040: profile snapshot, delegated to whichever side implements it
   * (v1: only twitterapi.io). `null` when neither does — a missing snapshot is
   * cosmetic, never a reason to fail or retry a verification.
   */
  async fetchAuthorProfile(handle: string): Promise<AuthorProfileSnapshot | null> {
    const delegate = this.opts.primary.fetchAuthorProfile
      ? this.opts.primary
      : this.opts.fallback?.fetchAuthorProfile
        ? this.opts.fallback
        : undefined;
    if (!delegate?.fetchAuthorProfile) return null;
    await this.bucket.take();
    assertActionActive();
    return delegate.fetchAuthorProfile(handle);
  }

  async scrapeTimeline(
    handle: string,
    since: Date,
    maxItems: number,
    sinceId?: string,
  ): Promise<ScrapedPost[]> {
    await this.bucket.take();
    assertActionActive();
    try {
      return await this.opts.primary.scrapeTimeline(handle, since, maxItems, sinceId);
    } catch (err) {
      rethrowActionCancellation(err);
      if (!this.opts.fallback) throw err;
      this.opts.loggerInfo?.(
        'hybrid-scraper: scrapeTimeline primary threw; falling back',
      );
      await this.bucket.take();
    assertActionActive();
      return await this.opts.fallback.scrapeTimeline(handle, since, maxItems, sinceId);
    }
  }
}
