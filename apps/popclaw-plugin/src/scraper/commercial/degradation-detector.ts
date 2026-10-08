/**
 * DegradationDetector — wraps any PlatformScraper to spot the case where
 * a provider has gone silently degraded (HTTP 200 + empty body for handles
 * that should yield content). Counts consecutive empty results across both
 * scrapeTimeline + fetchVerificationTargets; once `consecutiveEmptyThreshold`
 * is reached, throws `ProviderDegradedError` so HybridScraper falls through
 * to the configured fallback. After `recoveryMs`, the next call retries
 * the inner scraper once; a non-empty response clears the degraded state.
 *
 * scrapeTimeline observation is conditional, not unconditional: an empty
 * result under ANY recency operator (exact `sinceId` cursor, or the
 * day-granularity `since:` fallback the underlying scraper applies whenever
 * no cursor but a nonzero `since` timestamp is given) is the expected
 * success case for a quiet handle and is skipped, not counted. A non-empty
 * result is always observed, no matter the query shape — see scrapeTimeline
 * for the exact predicate (#413, #415).
 *
 * Provider failure case: TwitterAPI.io's search/timeline
 * endpoints went silently empty for every handle on 2026-04-27 while
 * `/user/info` continued to work (so the API key wasn't the issue). With
 * this wrapper, the watch loop falls back to Apify within seconds instead
 * of pulling no data all night.
 *
 * Roadmap (post-#405): the empty-result heuristic is weak — it can only
 * ever observe recency-unfiltered polls, which are now the minority case
 * once since_id/since cursors cover most watch entries. Honest replacement
 * candidate: a periodic unfiltered canary probe, or a provider error-rate
 * signal, neither implemented here.
 */

import type {
  AuthorProfileSnapshot,
  FetchedPost,
  PlatformScraper,
  ScrapedPost,
  VerificationTargets,
} from '../platform-scraper.js';

export interface DegradationLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface DegradationDetectorOptions {
  readonly inner: PlatformScraper;
  readonly providerName: string;
  /** Consecutive empties across all calls that trip the breaker. */
  readonly consecutiveEmptyThreshold: number;
  /** How long to short-circuit before retrying inner once. */
  readonly recoveryMs: number;
  readonly logger?: DegradationLogger;
  readonly now?: () => number;
}

export class ProviderDegradedError extends Error {
  readonly providerName: string;
  constructor(providerName: string) {
    super(`provider degraded: ${providerName}`);
    this.name = 'ProviderDegradedError';
    this.providerName = providerName;
  }
}

const NULL_LOGGER: DegradationLogger = {
  warn: () => undefined,
  info: () => undefined,
};

export class DegradationDetector implements PlatformScraper {
  private readonly logger: DegradationLogger;
  private readonly now: () => number;

  // Mutable state.
  private consecutiveEmpties = 0;
  /** 0 = not degraded; otherwise: epoch-ms when the breaker may probe again. */
  private degradedUntilMs = 0;

  /**
   * ADR-0034: forwarded verbatim iff the inner scraper supports by-id fetch —
   * defined conditionally so `scraper.fetchPostById` stays `undefined` (and the
   * proof path is skipped, not broken) when the inner provider lacks it.
   * Deliberately bypasses the breaker in both directions: a by-id miss for one
   * post is not a degradation signal, and a degraded search index must not
   * block proof verification (the 2026-04-27 incident degraded search/timeline
   * while direct-lookup endpoints kept working).
   */
  readonly fetchPostById?: (nativePostId: string) => Promise<FetchedPost>;

  /**
   * ADR-0040: same conditional forwarding, same reasoning — a profile snapshot
   * is a single-account lookup, not a search, so it neither feeds nor obeys the
   * breaker. Forwarding it is load-bearing: an optional method dropped by a
   * hand-written decorator ships the feature dead (PR #183 P0).
   */
  readonly fetchAuthorProfile?: (handle: string) => Promise<AuthorProfileSnapshot | null>;

  constructor(private readonly opts: DegradationDetectorOptions) {
    this.logger = opts.logger ?? NULL_LOGGER;
    this.now = opts.now ?? (() => Date.now());
    const innerFetchPostById = opts.inner.fetchPostById?.bind(opts.inner);
    if (innerFetchPostById) this.fetchPostById = innerFetchPostById;
    const innerFetchAuthorProfile = opts.inner.fetchAuthorProfile?.bind(opts.inner);
    if (innerFetchAuthorProfile) this.fetchAuthorProfile = innerFetchAuthorProfile;
  }

  async scrapeTimeline(
    handle: string,
    since: Date,
    maxItems: number,
    sinceId?: string,
  ): Promise<ScrapedPost[]> {
    if (this.shouldShortCircuit()) throw this.degradedError();
    const result = await this.opts.inner.scrapeTimeline(handle, since, maxItems, sinceId);
    // Any recency operator (exact `sinceId` OR the day-granularity `since:`
    // fallback twitterapi-io-scraper.ts applies whenever sinceSec > 0) turns
    // "empty" into the EXPECTED success case for a quiet handle, so an empty
    // result under either carries no evidence about provider health and must
    // NOT be observed (#413: 47 spurious trips/20min the moment since_id
    // shipped; #415: the day-granularity path reproduced the same spurious
    // trips because it wasn't covered by the original guard).
    //
    // A NON-empty result is different: it's still evidence of a healthy
    // provider regardless of which query shape produced it, so it's always
    // observed — this is what resets consecutiveEmpties and re-arms the
    // breaker (clears degradedUntilMs) after a trip. #415: the original
    // guard skipped observation for every cursored call including hits,
    // so a healthy cursored poll could never reset the counter and, worse,
    // could never clear degradedUntilMs — permanently blocking a genuine
    // second outage from tripping the breaker again.
    const noRecencyFilter = !sinceId && since.getTime() <= 0;
    if (noRecencyFilter || result.length > 0) this.observeEmpty(result.length === 0);
    if (this.justTripped()) throw this.degradedError();
    return result;
  }

  async fetchVerificationTargets(handle: string): Promise<VerificationTargets> {
    if (this.shouldShortCircuit()) throw this.degradedError();
    const result = await this.opts.inner.fetchVerificationTargets(handle);
    const isEmpty =
      result.firstPost === null && result.selfReplies.length === 0;
    this.observeEmpty(isEmpty);
    if (this.justTripped()) throw this.degradedError();
    return result;
  }

  private shouldShortCircuit(): boolean {
    if (this.degradedUntilMs === 0) return false;
    return this.now() < this.degradedUntilMs;
  }

  /**
   * Records the result of an inner call. If we were degraded and `now`
   * has passed the recovery deadline, a non-empty result clears the
   * degraded state (logs recovery); an empty result re-arms it.
   */
  private observeEmpty(isEmpty: boolean): void {
    if (isEmpty) {
      this.consecutiveEmpties += 1;
      return;
    }
    if (this.degradedUntilMs > 0 && this.now() >= this.degradedUntilMs) {
      this.logger.info(
        { providerName: this.opts.providerName },
        'provider recovered; failover released',
      );
    }
    this.consecutiveEmpties = 0;
    this.degradedUntilMs = 0;
  }

  /**
   * Has this call's empty bumped us across the threshold for the first
   * time? If so, set the degraded deadline + log a warn. Returns true so
   * the caller throws — the empty result is intentionally swallowed in
   * favour of the failover path.
   */
  private justTripped(): boolean {
    if (this.degradedUntilMs > 0) return false; // already tripped earlier
    if (this.consecutiveEmpties < this.opts.consecutiveEmptyThreshold) return false;
    this.degradedUntilMs = this.now() + this.opts.recoveryMs;
    this.logger.warn(
      {
        providerName: this.opts.providerName,
        consecutiveEmpties: this.consecutiveEmpties,
        recoveryMs: this.opts.recoveryMs,
      },
      'provider degraded; failover triggered',
    );
    return true;
  }

  private degradedError(): ProviderDegradedError {
    return new ProviderDegradedError(this.opts.providerName);
  }
}
