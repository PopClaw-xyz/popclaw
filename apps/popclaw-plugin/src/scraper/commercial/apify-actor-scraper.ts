import { rethrowActionCancellation } from '../../runtime/house-lifecycle/action-context.js';
/**
 * ApifyActorScraper — Plan 10.7 generic Apify-backed scraper.
 *
 * Wraps a single Apify actor via the synchronous
 * `POST /v2/acts/{owner}~{actor}/run-sync-get-dataset-items` endpoint.
 * Platform-specific I/O normalisation is injected so the same class
 * powers apifyTwitter / apifyInstagram / apifyTiktok.
 *
 * Cost observability: on every successful call, invokes the optional
 * `onScrapeComplete` callback with estimated USD cost (results × per-result
 * rate + optional flat per-run rate) + latency + provider name. Foundation for DePIN billing (Phase 4+).
 *
 * Errors:
 *   - HTTP 402 → ApifyQuotaError (out of credits; op alert path)
 *   - Other non-retriable 4xx (401/403/404) → ApifyRequestError
 *   - 429 / 5xx / fetch throw → retry ladder [0, 1s, 4s, 16s]
 */

import type {
  PlatformScraper,
  ScrapedPost,
  VerificationTargets,
} from '../platform-scraper.js';

const APIFY_API_BASE = 'https://api.apify.com/v2';
const RETRY_DELAYS_MS = [0, 1000, 4000, 16000];

export interface CostEvent {
  providerName: string;
  platform: string;
  estimatedCostUsd: number;
  resultsCount: number;
  latencyMs: number;
}

export type CostObserverCallback = (event: CostEvent) => void;

export interface ApifyActorScraperOptions {
  readonly token: string;
  readonly actorSlug: string;               // "owner/actor"
  readonly platform: string;                // 'x' | 'instagram' | 'tiktok'
  readonly costPerResultUsd: number;
  /**
   * Flat USD per actor run (Apify platform usage: compute + proxy), billed
   * even for an empty page. Measured 2026-09-02 on the IG lowcost actor:
   * $0.011/run at 20 results vs $0.004 from the per-result rate alone.
   */
  readonly costPerRunUsd?: number;
  readonly buildTimelineInput: (handle: string, since: Date, maxItems: number) => unknown;
  /**
   * Normalises actor output into ScrapedPost[]. Receives `since` so the
   * adapter can drop items older than the caller's watermark — Apify
   * actors typically return `maxItems` in chronological-desc order with
   * no server-side `since` filter of their own.
   */
  readonly parseTimelineOutput: (items: unknown[], handle: string, since: Date) => ScrapedPost[];
  readonly buildVerificationInput?: (handle: string) => unknown;
  readonly parseVerificationOutput?: (items: unknown[], handle: string, rawBytes: Uint8Array) => VerificationTargets;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onScrapeComplete?: CostObserverCallback;
  readonly apiBaseUrl?: string;
}

export class ApifyRequestError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = 'ApifyRequestError';
    this.status = status;
  }
}

export class ApifyQuotaError extends Error {
  constructor(msg = 'apify quota exceeded (HTTP 402); upgrade plan or wait for reset') {
    super(msg);
    this.name = 'ApifyQuotaError';
  }
}

export class ApifyActorScraper implements PlatformScraper {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly providerName: string;

  constructor(private readonly opts: ApifyActorScraperOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.apiBaseUrl ?? APIFY_API_BASE;
    this.providerName = `apify.${opts.actorSlug.replace('/', '-')}`;
  }

  async scrapeTimeline(handle: string, since: Date, maxItems: number): Promise<ScrapedPost[]> {
    const input = this.opts.buildTimelineInput(handle, since, maxItems);
    const { items, latencyMs } = await this.callActor(input);
    this.emitCost(items.length, latencyMs);
    return this.opts.parseTimelineOutput(items, handle, since);
  }

  async fetchVerificationTargets(handle: string): Promise<VerificationTargets> {
    if (!this.opts.buildVerificationInput || !this.opts.parseVerificationOutput) {
      return { firstPost: null, selfReplies: [], rawBytes: new Uint8Array(0) };
    }
    const input = this.opts.buildVerificationInput(handle);
    const { items, latencyMs, rawBytes } = await this.callActor(input);
    this.emitCost(items.length, latencyMs);
    return this.opts.parseVerificationOutput(items, handle, rawBytes);
  }

  private async callActor(input: unknown): Promise<{ items: unknown[]; latencyMs: number; rawBytes: Uint8Array }> {
    const url = `${this.baseUrl}/acts/${this.actorPath()}/run-sync-get-dataset-items`;
    const start = Date.now();
    const res = await this.fetchWithRetries(url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.opts.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    const buffer = await res.arrayBuffer();
    const rawBytes = new Uint8Array(buffer);
    const latencyMs = Date.now() - start;
    const text = new TextDecoder('utf-8').decode(rawBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApifyRequestError(res.status, `apify: response not JSON: ${text.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new ApifyRequestError(res.status, `apify: expected array, got ${typeof parsed}`);
    }
    return { items: parsed, latencyMs, rawBytes };
  }

  private emitCost(resultsCount: number, latencyMs: number): void {
    if (!this.opts.onScrapeComplete) return;
    try {
      this.opts.onScrapeComplete({
        providerName: this.providerName,
        platform: this.opts.platform,
        estimatedCostUsd: resultsCount * this.opts.costPerResultUsd + (this.opts.costPerRunUsd ?? 0),
        resultsCount,
        latencyMs,
      });
    } catch (err) {
      rethrowActionCancellation(err);
      // Suppress observer errors — never abort a scrape because of a hook.
      console.warn(`apify cost observer threw: ${String(err)}`);
    }
  }

  private actorPath(): string {
    // Apify URL path uses `~` instead of `/` for owner~actor.
    return this.opts.actorSlug.replace('/', '~');
  }

  private isRetriableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private async fetchWithRetries(url: string, init: RequestInit): Promise<Response> {
    let lastErr: Error = new Error('apify fetchWithRetries: unreachable');
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
      if (res.status === 402) throw new ApifyQuotaError();
      if (!this.isRetriableStatus(res.status)) {
        throw new ApifyRequestError(res.status, `apify: ${res.status} ${res.statusText}`);
      }
      lastErr = new ApifyRequestError(res.status, `apify: ${res.status} ${res.statusText}`);
    }
    throw lastErr;
  }
}
