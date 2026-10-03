import { rethrowActionCancellation } from '../../runtime/house-lifecycle/action-context.js';
/**
 * YoutubeDataApiScraper — Plan 10.10 direct-REST PlatformScraper via
 * the official YouTube Data API v3.
 *
 * Free tier: 10,000 quota units/day. Each playlistItems.list costs
 * 1 unit, each channels.list (used once per handle for resolution)
 * costs 1 unit. 10 handles at 30s adaptive polling = ~2,000 units/day.
 *
 * No Apify dependency. Direct HTTPS to googleapis.com with
 * `key=<API_KEY>` query param auth.
 *
 * Handle resolution: call /channels with forHandle=@<handle> to get
 * channelId + uploadsPlaylistId, cache both in-memory (permanent
 * per handle). Subsequent polls skip resolution.
 */

import type { PlatformScraper, ScrapedPost, VerificationTargets } from '../platform-scraper.js';
import type { CostObserverCallback } from './apify-actor-scraper.js';

const API_BASE = 'https://www.googleapis.com/youtube/v3';
const RETRY_DELAYS_MS = [0, 1000, 4000, 16000];
const PROVIDER_NAME = 'youtube.data-api-v3';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function responseItems(value: unknown): unknown[] {
  const items = record(value)?.items;
  return Array.isArray(items) ? items : [];
}

interface ChannelInfo {
  channelId: string;
  uploadsPlaylistId: string;
}

// Module-level cache — persists across instances in a single process.
const CHANNEL_CACHE = new Map<string, ChannelInfo>();

export interface YoutubeDataApiScraperOptions {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onScrapeComplete?: CostObserverCallback;
  readonly apiBaseUrl?: string;
}

export class YoutubeDataApiRequestError extends Error {
  readonly status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.name = 'YoutubeDataApiRequestError';
    this.status = status;
  }
}

export class YoutubeDataApiQuotaError extends Error {
  constructor() {
    super('YouTube Data API daily quota exceeded (HTTP 403 quotaExceeded)');
    this.name = 'YoutubeDataApiQuotaError';
  }
}

export class YoutubeDataApiScraper implements PlatformScraper {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(private readonly opts: YoutubeDataApiScraperOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleepFn = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.apiBaseUrl ?? API_BASE;
  }

  async scrapeTimeline(handleInput: string, since: Date, maxItems: number): Promise<ScrapedPost[]> {
    // Use original input as cache key so caller normalization doesn't cause misses.
    const cacheKey = handleInput;
    let info = CHANNEL_CACHE.get(cacheKey);

    if (!info) {
      // Normalize: prepend '@' if missing before calling the API.
      const handle = handleInput.startsWith('@') ? handleInput : `@${handleInput}`;
      const resolved = await this.get(`/channels?part=contentDetails&forHandle=${encodeURIComponent(handle)}`);
      const items = responseItems(resolved);
      if (items.length === 0) return [];
      const first = record(items[0]);
      const channelId = first?.id;
      const uploads = record(record(first?.contentDetails)?.relatedPlaylists)?.uploads;
      if (typeof channelId !== 'string' || typeof uploads !== 'string') return [];
      info = { channelId, uploadsPlaylistId: uploads };
      CHANNEL_CACHE.set(cacheKey, info);
    }

    const capped = Math.min(Math.max(maxItems, 1), 50);
    const pl = await this.get(
      `/playlistItems?part=snippet,contentDetails&playlistId=${encodeURIComponent(info.uploadsPlaylistId)}&maxResults=${capped}`,
    );

    const sinceMs = since.getTime();
    const items = responseItems(pl);
    return items
      .flatMap((it): ScrapedPost[] => {
        const snippet = record(record(it)?.snippet);
        const videoId = record(snippet?.resourceId)?.videoId;
        const publishedAt = snippet?.publishedAt;
        if (typeof videoId !== 'string' || typeof publishedAt !== 'string') return [];
        return [{
          id: videoId,
          text: typeof snippet?.title === 'string' ? snippet.title : '',
          createdAt: new Date(publishedAt),
          originalUrl: `https://www.youtube.com/watch?v=${videoId}`,
        }];
      })
      .filter((p) => p.createdAt.getTime() > sinceMs)
      .slice(0, maxItems);
  }

  async fetchVerificationTargets(_handle: string): Promise<VerificationTargets> {
    // YouTube does not expose a sigil placement path for verification;
    // return empty targets with no HTTP call.
    return { firstPost: null, selfReplies: [], rawBytes: new Uint8Array(0) };
  }

  private async get(path: string): Promise<unknown> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.baseUrl}${path}${sep}key=${encodeURIComponent(this.opts.apiKey)}`;
    const start = Date.now();
    const res = await this.fetchWithRetries(url);
    const text = await res.text();
    const latencyMs = Date.now() - start;
    this.emitCost(latencyMs);
    try {
      return JSON.parse(text);
    } catch {
      throw new YoutubeDataApiRequestError(res.status, `youtube: non-JSON response`);
    }
  }

  private emitCost(latencyMs: number): void {
    if (!this.opts.onScrapeComplete) return;
    try {
      this.opts.onScrapeComplete({
        providerName: PROVIDER_NAME,
        platform: 'youtube',
        estimatedCostUsd: 0, // free tier
        resultsCount: 1, // 1 quota unit per call
        latencyMs,
      });
    } catch (err) {
      rethrowActionCancellation(err);
      console.warn(`youtube cost observer threw: ${String(err)}`);
    }
  }

  private isRetriableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  private async fetchWithRetries(url: string): Promise<Response> {
    let lastErr: Error = new Error('youtube fetchWithRetries: unreachable');
    for (const delay of RETRY_DELAYS_MS) {
      await this.sleepFn(delay);
      let res: Response;
      try {
        res = await this.fetchFn(url);
      } catch (err) {
        rethrowActionCancellation(err);
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      if (res.ok) return res;

      // 403 may be quotaExceeded (non-retriable) or other auth errors.
      if (res.status === 403) {
        try {
          const body = await res.clone().text();
          const parsed = JSON.parse(body);
          const reason = parsed?.error?.errors?.[0]?.reason;
          if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
            throw new YoutubeDataApiQuotaError();
          }
        } catch (e) {
          if (e instanceof YoutubeDataApiQuotaError) throw e;
          // Fall through to generic 403 handling below.
        }
        throw new YoutubeDataApiRequestError(403, 'youtube: 403 Forbidden');
      }

      if (!this.isRetriableStatus(res.status)) {
        throw new YoutubeDataApiRequestError(res.status, `youtube: ${res.status} ${res.statusText}`);
      }
      lastErr = new YoutubeDataApiRequestError(res.status, `youtube: ${res.status} ${res.statusText}`);
    }
    throw lastErr;
  }
}

/** Test helper: clears the module-level channel cache between test runs. */
export function __clearChannelCache(): void {
  CHANNEL_CACHE.clear();
}
