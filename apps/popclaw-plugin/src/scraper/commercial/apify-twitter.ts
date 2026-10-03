/**
 * apifyTwitter — Plan 10.7 factory for X/Twitter via Apify's
 * `kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest`
 * actor ($0.25/1k results).
 *
 * Output shape (probed against the live actor, Apr 2026):
 *   { type: 'tweet' | 'mock_tweet' | 'demo', id, url, text,
 *     createdAt: string (Twitter RFC-2822, e.g. "Fri Apr 24 02:30:17 +0000 2026"),
 *     isReply, inReplyToUsername, inReplyToId,
 *     author: { userName, id, ... }, ... }
 *
 * `apidojo/tweet-scraper` was the original choice but is Free-tier
 * locked (returns [{noResults:true}]×10 with exitCode 0); kaitoeasyapi
 * accepts free accounts and publishes a cheaper per-result rate.
 *
 * Native retweets are excluded automatically by the `from:handle`
 * query — Twitter search treats the original author as the tweet's
 * author. Mock / demo placeholders (returned when the actor's backend
 * has nothing) carry `type !== 'tweet'` and are filtered defensively.
 */

import {
  ApifyActorScraper,
  type CostObserverCallback,
  type ApifyActorScraperOptions,
} from './apify-actor-scraper.js';
import type { SelfReply, VerifiedPost, VerificationTargets, ScrapedPost } from '../platform-scraper.js';

const ACTOR_SLUG = 'kaitoeasyapi/twitter-x-data-tweet-scraper-pay-per-result-cheapest';
const COST_PER_RESULT_USD = 0.00025;
const SCAN_WINDOW = 100;

interface KaitoTweet {
  type?: string;
  id?: string;
  url?: string;
  text?: string;
  createdAt?: string;
  author?: { userName?: string; id?: string };
  isReply?: boolean;
  inReplyToUsername?: string | null;
  inReplyToId?: string | null;
}

/** Optional test injection — normally tests wrap via the underlying class. */
export interface ApifyTwitterOverrides {
  fetch?: ApifyActorScraperOptions['fetch'];
  sleep?: ApifyActorScraperOptions['sleep'];
}

export function apifyTwitter(
  token: string,
  onScrapeComplete?: CostObserverCallback,
  overrides: ApifyTwitterOverrides = {},
): ApifyActorScraper {
  return new ApifyActorScraper({
    token,
    actorSlug: ACTOR_SLUG,
    platform: 'x',
    costPerResultUsd: COST_PER_RESULT_USD,
    onScrapeComplete,
    fetch: overrides.fetch,
    sleep: overrides.sleep,

    buildTimelineInput: (handle, _since, maxItems) => ({
      from: handle,
      maxItems,
      queryType: 'Latest',
    }),

    parseTimelineOutput: (items, handle, since): ScrapedPost[] => {
      const tweets = items as KaitoTweet[];
      const sinceMs = since.getTime();
      return tweets
        .filter((t) => t.type === 'tweet')
        .filter((t): t is Required<Pick<KaitoTweet, 'id' | 'text' | 'createdAt'>> & KaitoTweet =>
          typeof t.id === 'string' && typeof t.text === 'string' && typeof t.createdAt === 'string')
        .map((t) => ({
          id: t.id,
          text: t.text,
          createdAt: new Date(t.createdAt),
          originalUrl: typeof t.url === 'string'
            ? t.url
            : `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(t.id)}`,
          ...(typeof t.inReplyToId === 'string' && t.inReplyToId ? { inReplyToId: t.inReplyToId } : {}),
        }))
        .filter((p) => p.createdAt.getTime() > sinceMs);
    },

    buildVerificationInput: (handle) => ({
      from: handle,
      maxItems: SCAN_WINDOW,
      queryType: 'Latest',
    }),

    parseVerificationOutput: (items, handle, rawBytes): VerificationTargets => {
      const tweets = (items as KaitoTweet[]).filter((t) => t.type === 'tweet');

      const sorted = [...tweets].sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return ta - tb;
      });
      const earliest = sorted[0];
      const firstPost: VerifiedPost | null =
        earliest && typeof earliest.id === 'string' && typeof earliest.text === 'string' && earliest.createdAt
          ? { id: earliest.id, text: earliest.text, createdAt: new Date(earliest.createdAt) }
          : null;

      const selfReplies: SelfReply[] = [];
      for (const t of tweets) {
        if (!t.isReply) continue;
        // X handles are case-insensitive; the API may return different casing than the user typed.
        if ((t.inReplyToUsername ?? '').toLowerCase() !== handle.toLowerCase()) continue;
        if (typeof t.id !== 'string' || typeof t.text !== 'string' || !t.createdAt || typeof t.inReplyToId !== 'string') continue;
        selfReplies.push({
          id: t.id,
          text: t.text,
          createdAt: new Date(t.createdAt),
          parentPostId: t.inReplyToId,
        });
      }

      return { firstPost, selfReplies, rawBytes };
    },
  });
}
