/**
 * PlatformScraper — used by VerifyInviteHandler and ScrapeContentHandler
 * to read public data from a social platform (currently just X).
 *
 * `fetchVerificationTargets` returns the handle’s first post and self-reply
 * chain, where account verification looks for the sigil.
 */

export interface VerifiedPost {
  /** Platform-native post id (e.g. Twitter `id_str`). */
  readonly id: string;
  /** Post body text. */
  readonly text: string;
  /** Creation time (platform-reported). */
  readonly createdAt: Date;
}

export interface SelfReply {
  readonly id: string;
  readonly text: string;
  readonly createdAt: Date;
  /** The post under which this reply was authored by the same handle. */
  readonly parentPostId: string;
}

export interface VerificationTargets {
  /**
   * Earliest post within a bounded recent scan window (implementation-
   * defined size; a typical window is the most recent ~100 tweets). NOT
   * guaranteed to be the account's literal first-ever tweet — paginating
   * to the account's genesis is rate-limit hostile on the API v2 fallback
   * and infeasible on Playwright without infinite scroll. `null` when the
   * window is empty (brand-new account, all visible posts deleted, private
   * account, or handle does not exist).
   *
   * Implication for the sigil placement rule: users must place the sigil
   * inside the recent scan window, either as a standalone post or as a
   * self-reply. A sigil placed *only* in a tweet older than the scan
   * window will not verify — document this in the user-facing flow.
   */
  readonly firstPost: VerifiedPost | null;
  /**
   * Replies within the scan window whose `in_reply_to_user_id` equals
   * the handle's own user id (i.e., same-author replies). Order is
   * platform-dependent; callers should not rely on it.
   */
  readonly selfReplies: readonly SelfReply[];
  /**
   * Raw bytes of the fetched responses (concatenated if multiple calls),
   * for `evidence_hash` and `evidence_sample` per spec §5.5.
   */
  readonly rawBytes: Uint8Array;
  /**
   * ADR-0025 task 4.3: platform-native stable account id resolved during verification.
   * X → rest_id, TikTok → sec_uid, YouTube → channel id, Instagram → pk.
   * `undefined` when the scraper does not expose it (handler treats as "" = not captured).
   */
  readonly accountId?: string;
}

/** Media attachment carried by a scraped post (image gets the original URL;
 *  video/gif get the thumbnail URL — live HLS streams are not surfaced). */
export interface ScrapedMedia {
  readonly kind: 'image' | 'video' | 'gif';
  readonly url: string;
  readonly width?: number;
  readonly height?: number;
}

export interface ScrapedPost {
  readonly id: string;
  readonly text: string;
  readonly createdAt: Date;
  readonly originalUrl: string;
  /**
   * Media attachments parsed from the provider response. Absent/empty = the
   * scraper surfaced none (either the post has none, or the provider never
   * parses them — check the provider's implementation before assuming none).
   */
  readonly media?: ScrapedMedia[];
  /**
   * ADR-0025: Platform-native parent post id when this post is a reply.
   * Empty string or absent = not a reply (maps to Origin.reply_to_id "").
   */
  readonly inReplyToId?: string;
}

/**
 * ADR-0034: result of a by-id direct fetch — the proof-URL verification path.
 * Providers' search indexes are blind to low-follower/new accounts; the by-id
 * endpoint is not.
 */
export interface FetchedPost {
  /** `null` when the id resolves to nothing (deleted, wrong id, private). */
  readonly post: VerifiedPost | null;
  /** Raw response bytes — `evidence_hash` / `evidence_sample` source. */
  readonly rawBytes: Uint8Array;
  /** ADR-0025 platform-native stable account id of the author. */
  readonly accountId?: string;
  /**
   * Author handle AS THE PLATFORM REPORTS IT — the load-bearing bit of the
   * proof path: the caller compares it against the claimed handle so pointing
   * at somebody else's post can't earn a verification. Casing may differ.
   */
  readonly authorHandle?: string;
}

/**
 * ADR-0040: the account snapshot taken at the moment of verification —
 * follower count, avatar, bio. Pure garnish on the verification: it is fetched
 * AFTER the APPROVE decision and its failure must never change that decision.
 */
export interface AuthorProfileSnapshot {
  readonly followerCount: number;
  readonly avatarUrl: string;
  readonly bio: string;
}

export interface PlatformScraper {
  /**
   * Fetch the handle's first post + self-reply chain for sigil verification.
   * Throws on transport failure (ranger treats as ABSTAIN).
   */
  fetchVerificationTargets(handle: string): Promise<VerificationTargets>;
  /**
   * ADR-0040: one-shot profile snapshot for an APPROVED verification. Optional —
   * only providers with a user-info endpoint implement it (v1: twitterapi.io).
   * `null` = handle resolved to nothing. Throws on transport failure; the caller
   * reports zeros and approves anyway.
   */
  fetchAuthorProfile?(handle: string): Promise<AuthorProfileSnapshot | null>;
  /**
   * ADR-0034: fetch one post by its platform-native id. Optional — only
   * providers with a working by-id endpoint implement it (v1: twitterapi.io).
   * Throws on transport failure; the caller falls back to the search path.
   */
  fetchPostById?(nativePostId: string): Promise<FetchedPost>;
  /**
   * Fetch up to `maxItems` posts newer than `since` (used by ScrapeContent).
   *
   * `sinceId` is an OPTIONAL platform-native post-id cursor. Providers whose
   * API honours an exact "newer than this id" filter should prefer it over
   * `since` — it is what makes a quiet poll cheap instead of re-buying (and
   * discarding) a full page. Providers without one ignore the argument.
   * Decorators MUST forward it (PR #183 lesson: a silently-dropped argument
   * in a wrapper is invisible until the bill arrives).
   */
  scrapeTimeline(
    handle: string,
    since: Date,
    maxItems: number,
    sinceId?: string,
  ): Promise<ScrapedPost[]>;
}

/**
 * Platform-keyed scraper registry. Keys are canonical platform strings
 * matching `ranger_capabilities.capabilities` on the lore-house side:
 *   'x' | 'instagram' | 'tiktok'
 * Not every ranger exposes all platforms — registry only contains the
 * ones actually backed by a working scraper given current env/config.
 */
export type PlatformScraperRegistry = ReadonlyMap<string, PlatformScraper>;

/**
 * Normalise a platform string to its canonical registry key. Legacy
 * fixtures and some wire payloads still carry `'twitter'` (pre-X-rename);
 * the canonical name on both sides is now `'x'`. Use this on every
 * `registry.get(...)` call site so handlers accept either string.
 */
export function canonicalPlatform(p: string): string {
  // Case-insensitive: users type "X"/"Twitter"; registry keys are lowercase.
  // A real-machine invite with platform "X" ABSTAINed on registry miss (2026-07-26).
  const lower = p.toLowerCase();
  if (lower === 'twitter') return 'x';
  return lower;
}
