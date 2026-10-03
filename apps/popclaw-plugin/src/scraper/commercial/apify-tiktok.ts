import { rethrowActionCancellation } from '../../runtime/house-lifecycle/action-context.js';
/**
 * apifyTiktok — Plan 10.10 TikTok scraper via Apify's
 * `scraptik/tiktok-api` actor (PAY_PER_EVENT, $0.001/call).
 *
 * Unlike Plan 10.7's clockworks/tiktok-scraper (single call, expensive),
 * ScrapTik is a raw API wrapper that needs two calls per poll:
 *   1. Resolve username → sec_uid via usernameToId_username.
 *   2. Fetch posts via userPosts_secUserId.
 *
 * sec_uid is permanent per handle → cache in-memory. First poll per
 * new handle: 2 calls ($0.002); subsequent: 1 call ($0.001).
 *
 * Net: $1.70/1k → ~$0.05/1k at 20 items/call (34× cheaper).
 */

import type { PlatformScraper, ScrapedPost, VerificationTargets } from '../platform-scraper.js';
import type { CostObserverCallback } from './apify-actor-scraper.js';

const ACTOR_PATH = 'scraptik~tiktok-api';  // URL encoding: owner~actor
const COST_PER_CALL_USD = 0.001;
const RETRY_DELAYS_MS = [0, 1000, 4000, 16000];
const PROVIDER_NAME = 'apify.scraptik-tiktok-api';
const APIFY_BASE = 'https://api.apify.com/v2';

export interface ScrapTikScraperOptions {
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onScrapeComplete?: CostObserverCallback;
  readonly apiBaseUrl?: string;
}

export class ScrapTikRequestError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = 'ScrapTikRequestError';
    this.status = status;
  }
}

export class ScrapTikQuotaError extends Error {
  constructor() {
    super('scraptik quota exceeded (HTTP 402)');
    this.name = 'ScrapTikQuotaError';
  }
}

interface ScrapTikAweme {
  aweme_id?: string;
  desc?: string;
  create_time?: number;
  share_url?: string;
}

// Module-level cache: sec_uid is permanent per handle, safe across instances.
const SEC_UID_CACHE = new Map<string, string>();

export class ScrapTikScraper implements PlatformScraper {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(private readonly opts: ScrapTikScraperOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.apiBaseUrl ?? APIFY_BASE;
  }

  async scrapeTimeline(handle: string, since: Date, maxItems: number): Promise<ScrapedPost[]> {
    let secUid = SEC_UID_CACHE.get(handle);
    if (!secUid) {
      const resolved = await this.callActor({ usernameToId_username: handle });
      const first = resolved[0] as { sec_uid?: string } | undefined;
      secUid = first?.sec_uid;
      if (!secUid) return [];
      SEC_UID_CACHE.set(handle, secUid);
    }
    const raw = await this.callActor({
      userPosts_secUserId: secUid,
      userPosts_count: Math.min(Math.max(maxItems, 10), 30),
    });
    const wrapper = raw[0] as { aweme_list?: ScrapTikAweme[] } | undefined;
    const awemeList = wrapper?.aweme_list ?? [];
    const sinceMs = since.getTime();
    return awemeList
      .filter((a): a is Required<Pick<ScrapTikAweme, 'aweme_id' | 'create_time'>> & ScrapTikAweme =>
        typeof a.aweme_id === 'string' && typeof a.create_time === 'number')
      .map((a) => ({
        id: a.aweme_id,
        text: typeof a.desc === 'string' ? a.desc : '',
        createdAt: new Date(a.create_time * 1000),
        originalUrl: typeof a.share_url === 'string'
          ? a.share_url
          : `https://www.tiktok.com/@${encodeURIComponent(handle)}/video/${encodeURIComponent(a.aweme_id)}`,
      }))
      .filter((p) => p.createdAt.getTime() > sinceMs)
      .slice(0, maxItems);
  }

  async fetchVerificationTargets(handle: string): Promise<VerificationTargets> {
    // ADR-0025 task 4.3: resolve sec_uid (TikTok stable id) as a by-product
    // of the username lookup. The sec_uid is already cached from scrapeTimeline
    // if that was called first; otherwise resolve it now.
    let secUid = SEC_UID_CACHE.get(handle);
    if (!secUid) {
      try {
        const resolved = await this.callActor({ usernameToId_username: handle });
        const first = resolved[0] as { sec_uid?: string } | undefined;
        secUid = first?.sec_uid;
        if (secUid) SEC_UID_CACHE.set(handle, secUid);
      } catch {
        // Best-effort: if resolution fails, return without accountId.
      }
    }
    return {
      firstPost: null,
      selfReplies: [],
      rawBytes: new Uint8Array(0),
      ...(secUid ? { accountId: secUid } : {}),
    };
  }

  private async callActor(input: unknown): Promise<unknown[]> {
    const url = `${this.baseUrl}/acts/${ACTOR_PATH}/run-sync-get-dataset-items`;
    const start = Date.now();
    const res = await this.fetchWithRetries(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.opts.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    const text = new TextDecoder('utf-8').decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ScrapTikRequestError(res.status, `scraptik: non-JSON response`);
    }
    if (!Array.isArray(parsed)) {
      throw new ScrapTikRequestError(res.status, `scraptik: expected array, got ${typeof parsed}`);
    }
    const latencyMs = Date.now() - start;
    this.emitCost(latencyMs);
    return parsed;
  }

  private emitCost(latencyMs: number): void {
    if (!this.opts.onScrapeComplete) return;
    try {
      this.opts.onScrapeComplete({
        providerName: PROVIDER_NAME,
        platform: 'tiktok',
        estimatedCostUsd: COST_PER_CALL_USD,
        resultsCount: 0,  // ScrapTik is PAY_PER_EVENT — cost is per call, not per result
        latencyMs,
      });
    } catch (err) {
      rethrowActionCancellation(err);
      console.warn(`scraptik cost observer threw: ${String(err)}`);
    }
  }

  private isRetriableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private async fetchWithRetries(url: string, init: RequestInit): Promise<Response> {
    let lastErr: Error = new Error('scraptik fetchWithRetries: unreachable');
    for (const delay of RETRY_DELAYS_MS) {
      await this.sleep(delay);
      let res: Response;
      try {
        res = await this.fetchFn(url, init);
      } catch (err) {
        rethrowActionCancellation(err);
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      if (res.ok) return res;
      if (res.status === 402) throw new ScrapTikQuotaError();
      if (!this.isRetriableStatus(res.status)) {
        throw new ScrapTikRequestError(res.status, `scraptik: ${res.status} ${res.statusText}`);
      }
      lastErr = new ScrapTikRequestError(res.status, `scraptik: ${res.status} ${res.statusText}`);
    }
    throw lastErr;
  }
}

/** Back-compat factory. Returns a ScrapTikScraper (PlatformScraper). */
export interface ApifyTiktokOverrides {
  fetch?: ScrapTikScraperOptions['fetch'];
  sleep?: ScrapTikScraperOptions['sleep'];
}

export function apifyTiktok(
  token: string,
  onScrapeComplete?: CostObserverCallback,
  overrides: ApifyTiktokOverrides = {},
): ScrapTikScraper {
  return new ScrapTikScraper({
    token,
    onScrapeComplete,
    fetch: overrides.fetch,
    sleep: overrides.sleep,
  });
}

/** Testing-only hook to reset the module-level sec_uid cache. */
export function __clearSecUidCache(): void {
  SEC_UID_CACHE.clear();
}
