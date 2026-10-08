import { rethrowActionCancellation } from '../../runtime/house-lifecycle/action-context.js';
/**
 * TwitterApiIoScraper — direct-REST provider for X/Twitter
 * via TwitterAPI.io ($0.15/1k tweets, $0.00015 per empty call).
 *
 * Endpoint: GET https://api.twitterapi.io/twitter/tweet/advanced_search
 *   query      = `from:<handle> [since_id:<id> | since:<YYYY-MM-DD>]`
 *   queryType  = 'Latest'
 *   cursor     = pagination token (empty string for first page)
 *
 * NOTE: the `since_time` URL param is SILENTLY IGNORED by twitterapi.io
 * (verified 2026-06-16, and again 2026-08-24 on the live house-ranger where
 * 4,555 of 4,747 polls came back a full 20-tweet page regardless). The
 * recency filter MUST be a Twitter-native operator inside `query`.
 *
 * Rationale for choosing advanced_search over /user/last_tweets:
 *   - /user/last_tweets returned empty for verified accounts in live probes
 *     (Apr 2026) even with includeReplies=true. advanced_search works.
 *   - with the `since_id:` operator an empty poll returns an empty page, so
 *     it costs the ~$0.0002 floor instead of the $0.003 a full 20-tweet page
 *     costs when it is fetched and then discarded client-side.
 *
 * Native retweets are excluded by `from:handle` scope (Twitter search
 * treats original author as tweet author). Defensive filter on
 * retweeted_tweet !== null for the rare edge case.
 *
 * Cost observability: one CostEvent is emitted per HTTP call (per fetchPage
 * invocation), mirroring ApifyActorScraper.callActor. Multi-page scrapes
 * therefore emit one event per page, each with that page's tweet count and
 * real round-trip latency.
 *
 * WARNING — keep field-extraction in sync with the mirror implementation in
 * popclaw-sim-persona (`src/scraper/twitterapi-io-source.ts`); both parse the
 * same TwitterAPI.io (Kaito) response shape and its header warns the same
 * about this file. Sync history: `extendedEntities.media` parsing was ported
 * from the sim-persona side here on 2026-07-31 (mirror posts were losing all
 * media — mapMedia is intentionally identical in semantics both sides).
 */

import type {
  AuthorProfileSnapshot,
  FetchedPost,
  PlatformScraper,
  ScrapedMedia,
  ScrapedPost,
  VerificationTargets,
  VerifiedPost,
  SelfReply,
} from '../platform-scraper.js';
import type { CostObserverCallback } from './apify-actor-scraper.js';

const API_BASE = 'https://api.twitterapi.io';
const COST_PER_RESULT_USD = 0.00015;
const EMPTY_CALL_COST_USD = 0.00015;
const RETRY_DELAYS_MS = [0, 1000, 4000, 16000];
const PROVIDER_NAME = 'twitterapi.io';

export interface TwitterApiIoScraperOptions {
  readonly apiKey: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onScrapeComplete?: CostObserverCallback;
  readonly apiBaseUrl?: string;
}

/** Greppable marker for "the account ran out of money", not "the request failed".
 *  It rides inside the error message so it survives every `String(err)` on the
 *  way out (quest reason field, ranger info logs) without new plumbing — the
 *  host swallows warn/error, so an error-level log alone would be invisible. */
export const CREDIT_EXHAUSTED_MARKER = 'PROVIDER_CREDITS_EXHAUSTED';

export class TwitterApiIoRequestError extends Error {
  readonly status: number;
  /** true when the provider rejected us for lack of credits/quota, i.e. the fix
   *  is a top-up, not a retry. #180: this used to be indistinguishable from a
   *  plain scrape failure, so a drained balance looked like ranger ABSTAINs. */
  readonly creditExhausted: boolean;
  constructor(status: number, msg: string, creditExhausted = false) {
    super(creditExhausted ? `${CREDIT_EXHAUSTED_MARKER} ${msg}` : msg);
    this.name = 'TwitterApiIoRequestError';
    this.status = status;
    this.creditExhausted = creditExhausted;
  }
}

interface KaitoMediaSize {
  w?: number;
  h?: number;
}
interface KaitoMedia {
  type?: 'photo' | 'video' | 'animated_gif';
  media_url_https?: string;
  sizes?: { large?: KaitoMediaSize; medium?: KaitoMediaSize };
}

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
  retweeted_tweet?: unknown;
  extendedEntities?: { media?: KaitoMedia[] };
}

interface SearchPage {
  tweets?: KaitoTweet[];
  has_next_page?: boolean;
  next_cursor?: string;
}

/** Map a Kaito `extendedEntities.media` entry to ScrapedMedia. Drops entries
 *  with no media_url_https. video → kind='video' carrying the thumbnail URL;
 *  live HLS streams aren't surfaced. Ported 2026-07-31 from popclaw-sim-persona's
 *  mapMedia — semantics identical on both sides (see header warning). */
function mapMedia(m: KaitoMedia): ScrapedMedia | null {
  const url = typeof m.media_url_https === 'string' ? m.media_url_https : '';
  if (!url) return null;
  const kind: ScrapedMedia['kind'] = m.type === 'video'
    ? 'video'
    : m.type === 'animated_gif'
      ? 'gif'
      : 'image';
  const size = m.sizes?.large ?? m.sizes?.medium;
  return {
    kind,
    url,
    ...(size?.w ? { width: size.w } : {}),
    ...(size?.h ? { height: size.h } : {}),
  };
}

export class TwitterApiIoScraper implements PlatformScraper {
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;

  constructor(private readonly opts: TwitterApiIoScraperOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.apiBaseUrl ?? API_BASE;
  }

  async scrapeTimeline(
    handle: string,
    since: Date,
    maxItems: number,
    sinceId = '',
  ): Promise<ScrapedPost[]> {
    const sinceSec = Math.floor(since.getTime() / 1000);
    const accepted: ScrapedPost[] = [];
    let cursor = '';

    while (accepted.length < maxItems) {
      const { page } = await this.fetchPage({ handle, sinceSec, sinceId, cursor });
      const mapped = this.mapTweets(page.tweets ?? [], handle, sinceSec);
      for (const m of mapped) {
        if (accepted.length >= maxItems) break;
        accepted.push(m);
      }
      if (!page.has_next_page || !page.next_cursor) break;
      // TwitterAPI.io's server-side `since_time` is a *hint*, not a hard
      // filter: pages keep going backwards in history past our watermark.
      // Terminate when the current page yielded nothing past mapTweets — all
      // tweets were older than `since`, so all subsequent pages will be too
      // (DESC createdAt ordering).
      if (mapped.length === 0 && (page.tweets?.length ?? 0) > 0) break;
      cursor = page.next_cursor;
    }

    return accepted;
  }

  /**
   * Fetches the most recent page of tweets for verification target extraction.
   * TwitterAPI.io /advanced_search returns 20 tweets per page, which is our
   * implicit sigil scan window — one page is sufficient to find a sigil in the
   * first post or a same-author reply.
   */
  async fetchVerificationTargets(handle: string): Promise<VerificationTargets> {
    const { page, rawBytes } = await this.fetchPage({ handle, sinceSec: 0, sinceId: '', cursor: '' });
    const tweets = (page.tweets ?? []).filter((t) => t.type === 'tweet' && !t.retweeted_tweet);

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

    // ADR-0025 task 4.3: capture X rest_id (stable numeric user id) from any
    // tweet author field. All tweets in the page are from the same handle, so
    // the first with a non-empty author.id gives us the stable id.
    let accountId: string | undefined;
    for (const t of tweets) {
      const id = t.author?.id;
      if (typeof id === 'string' && id.length > 0) {
        accountId = id;
        break;
      }
    }

    return { firstPost, selfReplies, rawBytes, accountId };
  }

  /**
   * ADR-0034: by-id direct fetch. `GET /twitter/tweets?tweet_ids=<id>` is the
   * only Kaito channel that returns data for low-follower / freshly-registered
   * accounts — advanced_search, user timelines and reply lists are all blind to
   * them, which is exactly the onboarding population.
   */
  async fetchPostById(nativePostId: string): Promise<FetchedPost> {
    const url = `${this.baseUrl}/twitter/tweets?tweet_ids=${encodeURIComponent(nativePostId)}`;
    const start = Date.now();
    const res = await this.fetchWithRetries(url);
    const rawBytes = new Uint8Array(await res.arrayBuffer());
    const latencyMs = Date.now() - start;
    const text = new TextDecoder('utf-8').decode(rawBytes);
    let parsed: { tweets?: KaitoTweet[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TwitterApiIoRequestError(res.status, `twitterapi.io: non-JSON response: ${text.slice(0, 200)}`);
    }
    const t = (parsed.tweets ?? [])[0];
    // Same filter as fetchVerificationTargets: a native retweet has its own id
    // and author = the retweeter, so without this an attacker could bait the
    // victim into retweeting a token-bearing post and pass the author check.
    const usable =
      t && t.type === 'tweet' && !t.retweeted_tweet &&
      typeof t.id === 'string' && typeof t.text === 'string' && !!t.createdAt;
    this.emitCost(usable ? 1 : 0, latencyMs);
    if (!usable) return { post: null, rawBytes };
    return {
      post: { id: t!.id!, text: t!.text!, createdAt: new Date(t!.createdAt!) },
      rawBytes,
      ...(t!.author?.id ? { accountId: t!.author.id } : {}),
      ...(t!.author?.userName ? { authorHandle: t!.author.userName } : {}),
    };
  }

  /**
   * ADR-0040: `GET /twitter/user/info?userName=<handle>` — the follower/avatar/bio
   * snapshot taken at verification time. One extra call (~$0.00015) on APPROVE only.
   * Response shape (live probe): `{"status":"success","data":{"followers":2,
   * "profilePicture":"https://…","description":"…"}}`.
   */
  async fetchAuthorProfile(handle: string): Promise<AuthorProfileSnapshot | null> {
    const url = `${this.baseUrl}/twitter/user/info?userName=${encodeURIComponent(handle)}`;
    const start = Date.now();
    const res = await this.fetchWithRetries(url);
    const text = await res.text();
    const latencyMs = Date.now() - start;
    let parsed: { data?: { followers?: number; profilePicture?: string; description?: string } };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TwitterApiIoRequestError(res.status, `twitterapi.io: non-JSON response: ${text.slice(0, 200)}`);
    }
    const d = parsed.data;
    this.emitCost(d ? 1 : 0, latencyMs);
    if (!d) return null;
    return {
      followerCount: typeof d.followers === 'number' ? d.followers : 0,
      avatarUrl: typeof d.profilePicture === 'string' ? d.profilePicture : '',
      bio: typeof d.description === 'string' ? d.description : '',
    };
  }

  private mapTweets(tweets: KaitoTweet[], handle: string, sinceSec: number): ScrapedPost[] {
    const sinceMs = sinceSec * 1000;
    return tweets
      .filter((t) => t.type === 'tweet')
      .filter((t) => !t.retweeted_tweet)
      .filter((t): t is Required<Pick<KaitoTweet, 'id' | 'text' | 'createdAt'>> & KaitoTweet =>
        typeof t.id === 'string' && typeof t.text === 'string' && typeof t.createdAt === 'string')
      .map((t) => {
        const media = (t.extendedEntities?.media ?? [])
          .map(mapMedia)
          .filter((m): m is ScrapedMedia => m !== null);
        return {
          id: t.id,
          text: t.text,
          createdAt: new Date(t.createdAt),
          originalUrl: typeof t.url === 'string'
            ? t.url
            : `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(t.id)}`,
          ...(media.length > 0 ? { media } : {}),
          ...(typeof t.inReplyToId === 'string' && t.inReplyToId ? { inReplyToId: t.inReplyToId } : {}),
        };
      })
      // Defence-in-depth: re-apply since filter client-side in case the provider's since_time semantics drift.
      // Strict `>`: dropping the boundary post (createdAt == since) prevents the watch-loop from
      // re-counting last poll's newest result as new and pinning the entry in HOT tier.
      .filter((p) => p.createdAt.getTime() > sinceMs);
  }

  private async fetchPage(args: {
    handle: string;
    sinceSec: number;
    sinceId: string;
    cursor: string;
  }): Promise<{ page: SearchPage; rawBytes: Uint8Array; latencyMs: number }> {
    // The filter goes INSIDE `query` — twitterapi.io ignores `since_time`
    // (see file header). `since_id:` is exact; `since:` is the day-granularity
    // fallback for entries that only carry a timestamp cursor. No cursor at
    // all (backfill) => no operator => the provider's default window.
    let query = `from:${args.handle}`;
    if (args.sinceId) {
      query += ` since_id:${args.sinceId}`;
    } else if (args.sinceSec > 0) {
      query += ` since:${new Date(args.sinceSec * 1000).toISOString().slice(0, 10)}`;
    }
    const qs = new URLSearchParams({ query, queryType: 'Latest' });
    if (args.cursor) qs.set('cursor', args.cursor);
    const url = `${this.baseUrl}/twitter/tweet/advanced_search?${qs.toString()}`;

    const start = Date.now();
    const res = await this.fetchWithRetries(url);
    const buf = await res.arrayBuffer();
    const latencyMs = Date.now() - start;
    const rawBytes = new Uint8Array(buf);
    const text = new TextDecoder('utf-8').decode(rawBytes);
    let parsed: SearchPage;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TwitterApiIoRequestError(res.status, `twitterapi.io: non-JSON response: ${text.slice(0, 200)}`);
    }
    this.emitCost((parsed.tweets ?? []).length, latencyMs);
    return { page: parsed, rawBytes, latencyMs };
  }

  private emitCost(resultsCount: number, latencyMs: number): void {
    if (!this.opts.onScrapeComplete) return;
    const estimatedCostUsd = resultsCount > 0
      ? resultsCount * COST_PER_RESULT_USD
      : EMPTY_CALL_COST_USD;
    try {
      this.opts.onScrapeComplete({
        providerName: PROVIDER_NAME,
        platform: 'x',
        resultsCount,
        estimatedCostUsd,
        latencyMs,
      });
    } catch (err) {
      rethrowActionCancellation(err);
      console.warn(`twitterapi.io cost observer threw: ${String(err)}`);
    }
  }

  private isRetriableStatus(status: number): boolean {
    return status === 429 || status >= 500;
  }

  /** Build the error for a failed response, reading the body so the *reason*
   *  travels with it. Without the body a credit-exhausted 401 reads exactly
   *  like a revoked key (#180). Body read is best-effort: a torn response must
   *  not mask the status we already have. */
  private async errorFromResponse(res: Response): Promise<TwitterApiIoRequestError> {
    let body = '';
    try {
      body = (await res.text()).slice(0, 200);
    } catch {
      // ignore — status alone is still worth reporting
    }
    const detail = body ? `: ${body}` : '';
    return new TwitterApiIoRequestError(
      res.status,
      `twitterapi.io: ${res.status} ${res.statusText}${detail}`,
      /credits? (is|are)? ?not enough|insufficient credit|out of credit|quota exceeded/i.test(body),
    );
  }

  private async fetchWithRetries(url: string): Promise<Response> {
    let lastErr: Error = new Error('twitterapi.io fetchWithRetries: unreachable');
    for (const delay of RETRY_DELAYS_MS) {
      await this.sleep(delay);
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: 'GET',
          headers: { 'x-api-key': this.opts.apiKey },
        });
      } catch (err) {
        rethrowActionCancellation(err);
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      if (res.ok) return res;
      const err = await this.errorFromResponse(res);
      // A drained balance is not transient: retrying just burns the retry budget
      // (and 429 is how some providers signal it), so stop as soon as we see it.
      if (err.creditExhausted || !this.isRetriableStatus(res.status)) throw err;
      lastErr = err;
    }
    throw lastErr;
  }
}
