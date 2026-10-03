import { assertActionActive } from '../runtime/house-lifecycle/action-context.js';
/**
 * How much standing a stranger arrives with, cached so the receptionist can
 * answer without touching the network.
 *
 * The receptionist's first property is that it costs nothing (ADR-0046): the
 * verdict it hands the notification gate is assembled from local facts, in the
 * receive loop, with no round trip. External follower counts live on the
 * lore-house (`verified_profiles.follower_count`, an ADR-0040 snapshot taken
 * the day the account was verified), so the only way they can take part in that
 * verdict is if somebody fetched them earlier. That is all this is.
 *
 * ponytail: in-process Map, no table. Both callers — the DM receive path and
 * the follower sync — run inside the gateway process. Entries and requests are
 * isolated by house origin and actor: one house cannot supply another's verdict.
 * A restart costs one extra fetch per stranger. Give it a
 * sqlite table if it ever needs to survive restarts or be read from a second
 * process.
 */
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';

/** A snapshot is a snapshot: a week-old follower count is not today's standing. */
const TTL_MS = 7 * 24 * 3600 * 1000;

interface Entry {
  followerCount: number;
  fetchedAt: number;
}

export interface VerifiedFollowersCacheDeps {
  readonly loreHouseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export class VerifiedFollowersCache {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly entries = new Map<string, Entry>();
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(private readonly deps: VerifiedFollowersCacheDeps) {
    this.fetchFn = deps.fetch ?? globalThis.fetch;
    this.now = deps.now ?? Date.now;
  }

  /**
   * The zero-network answer. `undefined` = we have never looked, or what we
   * have is stale — honestly absent, never a guess and never a fetch.
   * Omitting houseOrigin retains the configured home-house lookup.
   */
  getFresh(popclawId: string, houseOrigin = this.deps.loreHouseUrl): number | undefined {
    const origin = this.originOf(houseOrigin);
    if (!origin) return undefined;
    const hit = this.entries.get(this.cacheKey(origin, popclawId));
    if (!hit) return undefined;
    return this.now() - hit.fetchedAt <= TTL_MS ? hit.followerCount : undefined;
  }

  /**
   * Fetch and remember. Never throws and never blocks anything that matters —
   * every caller is fire-and-forget or on a background sync.
   *
   * "No such person" is remembered as 0 so a stranger writing repeatedly does
   * not have us knocking on the lore-house each time. An unreachable
   * lore-house is remembered as nothing at all — that is a different fact, and
   * caching it would turn a blip into a week of blindness.
   */
  refresh(popclawId: string, houseOrigin = this.deps.loreHouseUrl): Promise<void> {
    const origin = this.originOf(houseOrigin);
    if (!origin) return Promise.resolve();
    const key = this.cacheKey(origin, popclawId);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const task = this.refreshOnce(popclawId, origin, key).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, task);
    return task;
  }

  private originOf(houseOrigin: string): string | undefined {
    try {
      const url = new URL(houseOrigin);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
    } catch { return undefined; }
  }

  private cacheKey(origin: string, popclawId: string): string {
    return JSON.stringify([origin, popclawId]);
  }

  private async refreshOnce(popclawId: string, origin: string, key: string): Promise<void> {
    if (!popclawId) return;
    // Already known and still fresh — the TTL is the only thing that decides
    // when to ask again. Without this, a stranger writing five times in a row
    // is five round trips to say the same thing.
    if (this.getFresh(popclawId, origin) !== undefined) return;
    const url = `${origin}/v1/profile/${encodeURIComponent(popclawId)}`;
    try {
      assertActionActive();
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS) });
      assertActionActive();
      if (res.status === 404) {
        this.entries.set(key, { followerCount: 0, fetchedAt: this.now() });
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as { profiles?: { follower_count?: number }[] };
      assertActionActive();
      // The largest single platform, never a sum — and never mixed with
      // `house_follower_count`, which counts follows on this lore-house and
      // means something else entirely (see lore-house profiles.rs: "never sum
      // the two"). Someone with 100k on X and 100k on GitHub is a 100k person,
      // most likely the same 100k people.
      const best = (body.profiles ?? []).reduce(
        (max, p) => Math.max(max, Number(p.follower_count ?? 0) || 0),
        0,
      );
      this.entries.set(key, { followerCount: best, fetchedAt: this.now() });
    } catch {
      /* Unreachable or cancelled: neither establishes a profile fact. */
    }
  }
}
