/**
 * apifyInstagram — Plan 10.10 factory for Instagram via Apify's
 * `sones/instagram-posts-scraper-lowcost` actor ($0.20/1k results,
 * down from $1.50/1k with the old `apify/instagram-scraper`) — plus ~$0.007
 * of platform usage per run, which is what the bill is really made of.
 *
 * Output shape: `{ code, post_url, caption: {pk, text}|null, taken_at }`.
 * `code` is the shortcode (e.g. "DXg_ZGfHKmT"). `caption` is an object,
 * NOT a plain string — extract `.text` with a null-guard.
 *
 * Sigil flow is not implemented for IG (tracked in plan-10.7-followups.md
 * item #2). fetchVerificationTargets returns empty without making an HTTP
 * call — the invite-verification path doesn't reach this scraper.
 */

import {
  ApifyActorScraper,
  type CostObserverCallback,
  type ApifyActorScraperOptions,
} from './apify-actor-scraper.js';
import type { ScrapedPost } from '../platform-scraper.js';

const ACTOR_SLUG = 'sones/instagram-posts-scraper-lowcost';
const COST_PER_RESULT_USD = 0.0002;
/** Apify platform usage per run; the bill is dominated by this, not by results. */
const COST_PER_RUN_USD = 0.007;

interface IgPost {
  /** Shortcode, e.g. "DXg_ZGfHKmT" — used as post ID. */
  code?: string;
  /** Full post URL. */
  post_url?: string;
  /** Caption is an OBJECT, not a string. May be null if no caption. */
  caption?: { pk?: string; text?: string } | null;
  /** Unix timestamp in seconds. */
  taken_at?: number;
}

export interface ApifyInstagramOverrides {
  fetch?: ApifyActorScraperOptions['fetch'];
  sleep?: ApifyActorScraperOptions['sleep'];
}

export function apifyInstagram(
  token: string,
  onScrapeComplete?: CostObserverCallback,
  overrides: ApifyInstagramOverrides = {},
): ApifyActorScraper {
  return new ApifyActorScraper({
    token,
    actorSlug: ACTOR_SLUG,
    platform: 'instagram',
    costPerResultUsd: COST_PER_RESULT_USD,
    costPerRunUsd: COST_PER_RUN_USD,
    onScrapeComplete,
    fetch: overrides.fetch,
    sleep: overrides.sleep,

    buildTimelineInput: (handle, _since, maxItems) => ({
      usernames: [handle],
      postsPerProfile: maxItems,
    }),

    parseTimelineOutput: (items, _handle, since): ScrapedPost[] => {
      const posts = items as IgPost[];
      const sinceMs = since.getTime();
      return posts
        .filter((p): p is Required<Pick<IgPost, 'code'>> & IgPost =>
          typeof p.code === 'string' &&
          typeof p.taken_at === 'number' &&
          !Number.isNaN(p.taken_at))
        .map((p) => {
          const text =
            p.caption != null && typeof p.caption.text === 'string'
              ? p.caption.text
              : '';
          return {
            id: p.code,
            text,
            createdAt: new Date(p.taken_at! * 1000),
            originalUrl:
              typeof p.post_url === 'string'
                ? p.post_url
                : `https://www.instagram.com/p/${encodeURIComponent(p.code)}/`,
          };
        })
        .filter((p) => p.createdAt.getTime() > sinceMs);
    },

    // No sigil flow for IG — buildVerificationInput/parseVerificationOutput
    // left undefined so the base class returns empty targets without an HTTP call.
  });
}
