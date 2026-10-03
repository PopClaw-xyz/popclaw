/**
 * Per-slice watch state machine. Pure functions + a tiny in-memory map.
 *
 * Tiers (evaluated top-to-bottom; first match wins):
 *   hot   — consecutive_hits >= 3            → 30s
 *   sleep — consecutive_misses >= 20         → 24h
 *   cold  — consecutive_misses >= 5          → 1h
 *   warm  — otherwise (incl. fresh default)  → 5min
 *
 * `consecutive_hits` and `consecutive_misses` are mutually exclusive: a
 * single poll result zeroes one and increments the other.
 * `lastSeenCreatedAt` is the platform-reported seconds-since-epoch of
 * the newest post we've forwarded for this slice; next poll uses this
 * as the scraper's `since` argument.
 *
 * The map is in-memory, but the cursor is optionally written through to
 * SQLite (#181) so a restart resumes on the exact `since_id` rather than
 * re-fetching a billed page per target.
 */

import { canonicalPlatform } from '../scraper/platform-scraper.js';

/**
 * Base tier intervals. Production values; tests may override the whole table
 * via env `POPCLAW_WATCH_TIER_INTERVAL_MS_JSON` (read once at module load). The override must be a JSON object with any
 * subset of the four tier keys; missing keys retain the default.
 */
const DEFAULT_TIER_INTERVAL_MS = {
  hot: 30_000,
  warm: 5 * 60_000,
  cold: 60 * 60_000,
  sleep: 24 * 60 * 60_000,
} as const;

function resolveTierIntervals(): {
  hot: number;
  warm: number;
  cold: number;
  sleep: number;
} {
  const raw = process.env.POPCLAW_WATCH_TIER_INTERVAL_MS_JSON;
  if (!raw) return { ...DEFAULT_TIER_INTERVAL_MS };
  try {
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_TIER_INTERVAL_MS>;
    return {
      hot: parsed.hot ?? DEFAULT_TIER_INTERVAL_MS.hot,
      warm: parsed.warm ?? DEFAULT_TIER_INTERVAL_MS.warm,
      cold: parsed.cold ?? DEFAULT_TIER_INTERVAL_MS.cold,
      sleep: parsed.sleep ?? DEFAULT_TIER_INTERVAL_MS.sleep,
    };
  } catch {
    return { ...DEFAULT_TIER_INTERVAL_MS };
  }
}

export const TIER_INTERVAL_MS = resolveTierIntervals();

/**
 * Per-platform minimum poll interval, applied on top of the tier interval.
 * Instagram: Apify bills the actor per *run* (~$0.011 measured 2026-09-02),
 * not per result, so 11 accounts on hourly COLD polls cost ~$3/day for
 * ~10 posts. A 4h floor (sim-persona's old 240-min IG floor) is ~$0.7/day.
 * Override via env JSON `POPCLAW_WATCH_PLATFORM_FLOOR_MS_JSON`, e.g.
 * `{"instagram":21600000}`; platforms not listed have no floor.
 */
const DEFAULT_PLATFORM_FLOOR_MS: Record<string, number> = {
  instagram: 4 * 60 * 60_000,
};

/** Exported for tests; non-numeric values are dropped (a NaN schedule = a watch that never polls again). */
export function resolvePlatformFloors(raw: string | undefined): Record<string, number> {
  const floors = { ...DEFAULT_PLATFORM_FLOOR_MS };
  if (!raw) return floors;
  try {
    for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) floors[canonicalPlatform(k)] = v;
    }
  } catch {
    // malformed override → defaults
  }
  return floors;
}

export const PLATFORM_FLOOR_MS = resolvePlatformFloors(process.env.POPCLAW_WATCH_PLATFORM_FLOOR_MS_JSON);

export enum Tier {
  HOT = 'hot',
  WARM = 'warm',
  COLD = 'cold',
  SLEEP = 'sleep',
}

export interface EntryState {
  consecutiveHits: number;
  consecutiveMisses: number;
  lastSeenCreatedAt: number;
  /**
   * Platform-native id of the newest post seen. Feeds the scraper's exact
   * `sinceId` cursor; '' until the first hit (then the timestamp is the only
   * cursor available and the provider falls back to day granularity).
   */
  lastSeenPlatformPostId: string;
}

export interface RegistryEntry {
  watchId: string;
  targetPopclawId: string;
  /**
   * Platform-native username for the scraper to query (e.g. Twitter
   * handle). Resolved from verified_profiles.handle by lore-house and
   * carried on WatchDispatch. MUST be used in place of targetPopclawId
   * for any remote API call — base58 popclaw_id is not a Twitter
   * username.
   */
  handle: string;
  platform: string;
  state: EntryState;
  nextPollAtMs: number;
}

/**
 * `sinceSecs` is where this watch starts — the lore-house sends the instant the
 * account's owner consented (or, on a re-arm, the last post already taken in).
 *
 * It is not optional in spirit: seeding at 0 means the very first poll asks for
 * everything the account has ever posted — the back-filling the owner ruled out
 * (forward sync only, nothing from before) and, because the registry is
 * in-memory, a re-fetch on every ranger restart (softened by the watermark
 * store, which resumes from the exact post id when it has one). Omitted → start from now,
 * which is the safe reading of an older lore-house that sends no `since`.
 */
export function defaultEntry(
  nowMs: number,
  sinceSecs?: number,
  platform = '',
): EntryState & { nextPollAtMs: number } {
  const state: EntryState = {
    consecutiveHits: 0,
    consecutiveMisses: 0,
    lastSeenCreatedAt: sinceSecs && sinceSecs > 0 ? sinceSecs : Math.floor(nowMs / 1000),
    lastSeenPlatformPostId: '',
  };
  return { ...state, nextPollAtMs: nextPollAt(state, nowMs, platform) };
}

export function tierOf(state: EntryState): Tier {
  if (state.consecutiveHits >= 3) return Tier.HOT;
  if (state.consecutiveMisses >= 20) return Tier.SLEEP;
  if (state.consecutiveMisses >= 5) return Tier.COLD;
  return Tier.WARM;
}

export function nextPollAt(state: EntryState, nowMs: number, platform = ''): number {
  const floor = platform ? (PLATFORM_FLOOR_MS[canonicalPlatform(platform)] ?? 0) : 0;
  return nowMs + Math.max(TIER_INTERVAL_MS[tierOf(state)], floor);
}

export function transitionAfterPoll(
  prev: EntryState,
  hit: boolean,
  newestCreatedAtOnHit: number,
  newestPostIdOnHit = '',
): EntryState {
  if (hit) {
    return {
      consecutiveHits: prev.consecutiveHits + 1,
      consecutiveMisses: 0,
      lastSeenCreatedAt: newestCreatedAtOnHit,
      lastSeenPlatformPostId: newestPostIdOnHit || prev.lastSeenPlatformPostId,
    };
  }
  return {
    consecutiveHits: 0,
    consecutiveMisses: prev.consecutiveMisses + 1,
    lastSeenCreatedAt: prev.lastSeenCreatedAt,
    lastSeenPlatformPostId: prev.lastSeenPlatformPostId,
  };
}

/** Optional disk backing for the cursor. See watch-watermark-store.ts (#181). */
export interface WatchWatermarkStoreLike {
  load(watchId: string): Pick<EntryState, 'lastSeenCreatedAt' | 'lastSeenPlatformPostId'> | null;
  save(watchId: string, state: EntryState): void;
}

export class WatchRegistry {
  private readonly byWatchId = new Map<string, RegistryEntry>();

  /** No store = pure in-memory, the pre-#181 behaviour (tests, CLI paths). */
  constructor(private readonly store?: WatchWatermarkStoreLike) {}

  add(
    watchId: string,
    targetPopclawId: string,
    handle: string,
    platform: string,
    seed: EntryState & { nextPollAtMs: number },
  ): void {
    const { nextPollAtMs, ...state } = seed;
    // A re-dispatch of a watch we already hold (the house re-emits every
    // pinned watch each time we re-register, i.e. after every reconnect)
    // must not reset the tier machine or push nextPollAt out again — once a
    // minute, that meant nothing was ever due (2026-09-02 feed stall).
    const existing = this.byWatchId.get(watchId);
    if (existing) {
      existing.targetPopclawId = targetPopclawId;
      existing.handle = handle;
      existing.platform = platform;
      return;
    }
    // #181: the seed the lore-house dispatches is a *timestamp* (consent instant
    // or last mirrored post). Our own watermark, when it is at least as new,
    // additionally carries the exact post id — the difference between asking
    // `since_id:<id>` (empty page, $0.00015) and `since:<day>` (full billed
    // page the client then filters away) on the first poll after a restart.
    // `>=` not `>`: on a tie the timestamps say the same thing and the id is
    // pure gain.
    const saved = this.store?.load(watchId);
    if (saved && saved.lastSeenCreatedAt >= state.lastSeenCreatedAt) {
      state.lastSeenCreatedAt = saved.lastSeenCreatedAt;
      state.lastSeenPlatformPostId = saved.lastSeenPlatformPostId;
    }
    this.byWatchId.set(watchId, {
      watchId,
      targetPopclawId,
      handle,
      platform,
      state,
      nextPollAtMs,
    });
  }

  remove(watchId: string): void {
    this.byWatchId.delete(watchId);
  }

  has(watchId: string): boolean {
    return this.byWatchId.has(watchId);
  }

  all(): RegistryEntry[] {
    return [...this.byWatchId.values()];
  }

  due(nowMs: number): RegistryEntry[] {
    return this.all().filter((e) => nowMs >= e.nextPollAtMs);
  }

  updateAfterPoll(
    watchId: string,
    hit: boolean,
    newestCreatedAtOnHit: number,
    nowMs: number,
    newestPostIdOnHit = '',
  ): void {
    const entry = this.byWatchId.get(watchId);
    if (!entry) return;
    entry.state = transitionAfterPoll(
      entry.state,
      hit,
      newestCreatedAtOnHit,
      newestPostIdOnHit,
    );
    entry.nextPollAtMs = nextPollAt(entry.state, nowMs, entry.platform);
    // Only a hit moves the cursor; a miss would rewrite the same row every poll.
    if (hit) this.store?.save(watchId, entry.state);
  }
}
