/**
 * WorldSummaryClient — S4-T2
 *
 * Typed client for GET /v1/world-summary.
 * Pattern mirrors WorldFeedClient (src/ingress/world-feed-client.ts):
 *   - inject fetch + baseUrl in constructor;
 *   - network failure / non-2xx → null (never throws).
 *
 * Decision note: placed in `src/world/` (new sibling of guide.ts) rather than
 * extending WorldFeedClient, because:
 *   1. /v1/world-summary is a JSON REST endpoint, not protobuf/SSE like world-feed;
 *   2. WorldFeedClient's fetchSnapshot has a fundamentally different return type;
 *   3. keeping the two concerns separate avoids a bloated class.
 * The fetch + baseUrl injection pattern is identical to WorldFeedClient's constructor.
 */
import { houseReadFailure, type HouseReadFailure } from '../runtime/house-lifecycle/read-failure.js';
import { displayPerson } from '../identity/person-resolver.js';
import { LORE_HOUSE_TIMEOUT_MS } from './http-timeout.js';
import type { NameChain } from '../identity/person-name.js';

/** One entry in the `authors` map of WorldSummaryResponse. */
export interface AuthorEntry {
  readonly nickname: string;
}

/** One hot post from the summary window. `author` is a popclaw_id key into `authors`. */
export interface HotPost {
  readonly event_id: string;
  readonly author: string;
  readonly platform: string;
  readonly body_preview: string;
  readonly reply_count: number;
  readonly quote_count: number;
  readonly created_at_ms: number;
}

/**
 * v2 (S4.2): lifetime mechanical counters — the world-state line.
 * Mirrors world_summary.rs `WorldState` (lifetime, NOT window-scoped).
 */
export interface WorldState {
  /** Identities the world has ever seen (events distinct actor_popclaw_id). */
  readonly identities_total: number;
  /** Identities that declared a namecard (profile_cards rows). */
  readonly namecards_total: number;
  /** Externally-proven platform accounts (verified_profiles NOT revoked). */
  readonly verified_accounts_total: number;
  /** popclaw-native posts ever (posts rows, all time). */
  readonly native_posts_total: number;
}

/** v2 (S4.2): one un-revoked verified account of a notable identity. */
export interface NotableAccount {
  readonly platform: string;
  readonly handle: string;
  readonly follower_count: number;
}

/**
 * v2 (S4.2): a verified identity on the notable-people roster. ONLY identities with
 * at least one un-revoked verified account appear here — mirrored sim
 * personas are never passed off as verified celebrities (constitutional rule).
 */
export interface NotablePerson {
  /** base58 popclaw_id */
  readonly popclaw_id: string;
  /** profile_cards.nickname, else the highest-follower account handle. */
  readonly nickname: string;
  /** All un-revoked verified accounts, highest follower_count first. */
  readonly accounts: NotableAccount[];
  /** Sum of account follower_counts — the roster's sort key. */
  readonly followers_total: number;
}

/**
 * Wire shape from GET /v1/world-summary.
 * All field names are snake_case exactly as serialised by the Rust server
 * (world_summary.rs `WorldSummaryResponse`).
 *
 * The v2 fields (world_state / notable_people / summary_note) are optional on
 * purpose: an old server simply omits them and the client renders the v1 card.
 */
export interface WorldSummaryResponse {
  readonly window_hours: number;
  readonly generated_at_ms: number;
  readonly total_posts: number;
  readonly distinct_authors: number;
  /** keyed by base58 popclaw_id */
  readonly authors: Record<string, AuthorEntry>;
  readonly hot_posts: HotPost[];
  /** v2: world-state counters; absent on pre-v2 servers. */
  readonly world_state?: WorldState;
  /** v2: notable-people roster (verified-only, top 10); absent on pre-v2 servers. */
  readonly notable_people?: NotablePerson[];
  /** v2: one-line self-description of the hot-ranking algorithm. */
  readonly summary_note?: string;
}

export interface WorldSummaryClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}

export type WorldSummaryResult = {readonly ok:true;readonly summary:WorldSummaryResponse} | {readonly ok:false;readonly failure:HouseReadFailure};

export class WorldSummaryClient {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly opts: WorldSummaryClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  /**
   * Fetch the world summary for the given time window.
   *
   * @param windowHours - Optional override; server default (24h) used when absent.
   * @returns Typed response, or `null` on any error (network / non-2xx / parse).
   */
  async fetchSummary(windowHours?: number): Promise<WorldSummaryResponse | null> {
    const result = await this.fetchSummaryResult(windowHours);
    return result.ok ? result.summary : null;
  }

  /** Foreground callers retain local refusal and remote error classification;
   * other summary consumers keep the safe nullable facade above. */
  async fetchSummaryResult(windowHours?: number): Promise<WorldSummaryResult> {
    const qs = new URLSearchParams();
    if (windowHours !== undefined) qs.set('window_hours', String(windowHours));
    const qStr = qs.toString();
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/world-summary${qStr ? `?${qStr}` : ''}`;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS) });
      if (!res.ok) return {ok:false,failure:{code:'HOUSE_REMOTE_HTTP',origin:this.opts.baseUrl,status:res.status}};
      try {
        const json = (await res.json()) as WorldSummaryResponse;
        if (!json || typeof json !== 'object' || !Array.isArray(json.hot_posts) || !json.authors
          || typeof json.authors !== 'object' || typeof json.window_hours !== 'number'
          || typeof json.total_posts !== 'number' || typeof json.distinct_authors !== 'number')
          return {ok:false,failure:{code:'HOUSE_REMOTE_PARSE',origin:this.opts.baseUrl}};
        return {ok:true,summary:json};
      } catch (error) {
        const failure = houseReadFailure(error,this.opts.baseUrl);
        return {ok:false,failure:error instanceof SyntaxError ? {code:'HOUSE_REMOTE_PARSE',origin:this.opts.baseUrl} : failure};
      }
    } catch (error) {
      return {ok:false,failure:houseReadFailure(error,this.opts.baseUrl)};
    }
  }

  /**
   * Resolve a nickname for a given popclaw_id from a WorldSummaryResponse.
   * Falls back to the **sigil** when the author is not present in the `authors`
   * map (e.g. orphaned hot_post references) — this string is shown to the owner,
   * and a bare id prefix tells them nothing (ADR-0032).
   *
   * The nickname the server gives us **is** the other party's self-reported
   * name → it only competes for the second tier of the unique name chain;
   * if the owner has set an alias, the alias overrides it (takes effect when
   * `nameOf` is injected).
   */
  static nicknameFor(
    summary: WorldSummaryResponse,
    popclawId: string,
    nameOf?: NameChain,
  ): string {
    const server = summary.authors[popclawId]?.nickname;
    const chained = nameOf ? nameOf(popclawId, server) : server;
    return chained || displayPerson(popclawId);
  }
}
