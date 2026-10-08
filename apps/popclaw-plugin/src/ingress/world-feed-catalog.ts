/**
 * WorldFeedCatalog — the cross-house merged view (spec B, slice ②).
 *
 * The client side is the only join point in the federation: houses never talk
 * to each other, each house only holds its own partial truth, and the full
 * truth only exists locally. This class is that "join point" — it wraps N
 * per-slug `WorldFeedCache` instances (each database already naturally
 * isolated under `data/lorehouses/<slug>.db`) plus N snapshot clients, and
 * presents downstream code the **exact same** read-side shape as a single
 * cache (`WorldFeedReader` + `SnapshotSource`), so dreamer / recommend / the
 * daily paper / search / pings all need zero business-logic changes.
 *
 * Three rules:
 *   1. Every item read out gets tagged with `houseSlug` (the house it came
 *      from) — this is what slice ③'s write-side routing relies on.
 *   2. Dedupe by event_id (a global CID; a cross-house collision means the
 *      same event relayed); the first house that saw it wins, and any house
 *      that saw it later gets recorded into `alsoInHouses`. Falls back to
 *      (platform, post_id) when there's no event_id.
 *   3. Sorting follows the same semantics as a single house: created_at DESC,
 *      platform_post_id ASC — the same yardstick as the SQL `ORDER BY`, so a
 *      single-house configuration (array length 1) produces byte-for-byte
 *      identical results.
 *
 * What this does NOT do: writes (a record belongs to one specific house, and
 * the SSE callback writes straight into that house's cache), inbox/DM,
 * ranger — all deferred to later slices.
 */
import type { popclaw } from '@popclaw/contracts';
import type { SnapshotSource, WorldFeedQuery } from './world-feed-client.js';
import type { HouseStore } from './world-feed-store.js';
import type { HouseSilence } from './house-silence.js';
import {
  numberOrZero,
  type CachedFeedItem,
  type ReadableFeedItem,
} from './feed-item-projection.js';
import type { ReplyToOwner, WorldFeedReader } from './world-feed-cache.js';

/**
 * One house's read-side pair: the cache (where SSE lands) + the snapshot
 * client (live pull). `db` is the write/shutdown-side handle and the read
 * side must not know it (shutdown belongs to index.ts's `shutdown()`).
 */
export interface HouseFeed extends Omit<HouseStore, 'db'> {
  readonly snapshot: SnapshotSource;
}

/** Local provenance, assigned by the catalog rather than supplied by a peer. */
export type HouseSnapshotItem = popclaw.event.IWorldFeedItem & {readonly houseSlug: string};

export interface WorldFeedCatalogOptions {
  /** A one-line warning (with the slug) when a given house can't be pulled from. Omit = silent. */
  readonly warn?: (msg: string) => void;
}

/** Dedupe key: event_id is a global CID, a matching id across houses is the same event; falls back to (platform, post_id) when absent. */
function keyOf(i: { eventId?: string; platform: string; platformPostId: string }): string {
  return i.eventId ? `e:${i.eventId}` : `p:${i.platform}\0${i.platformPostId}`;
}

/** The same yardstick as SQL's `ORDER BY platform_post_created_at DESC, platform_post_id`. */
function newestFirst(a: CachedFeedItem, b: CachedFeedItem): number {
  if (b.platformPostCreatedAt !== a.platformPostCreatedAt) {
    return b.platformPostCreatedAt - a.platformPostCreatedAt;
  }
  return a.platformPostId < b.platformPostId ? -1 : a.platformPostId > b.platformPostId ? 1 : 0;
}

export class WorldFeedCatalog implements WorldFeedReader, SnapshotSource {
  private readonly feeds: HouseFeed[];
  constructor(
    feeds: readonly HouseFeed[],
    private readonly opts: WorldFeedCatalogOptions = {},
  ) {
    if (feeds.length === 0) throw new Error('WorldFeedCatalog needs at least one house');
    this.feeds = [...feeds];
  }

  /** Retain historical feeds and append newly mounted houses in place. */
  mount(feed: HouseFeed): void {
    const existing = this.forHouse(feed.slug);
    if (existing) {
      if (existing.baseUrl !== feed.baseUrl) throw new Error(`HOUSE_SLUG_COLLISION: ${feed.slug}`);
      return;
    }
    this.feeds.push(feed);
  }

  /** All houses in configured order; `[0]` is the home house. */
  houses(): readonly HouseFeed[] {
    return this.feeds;
  }

  /**
   * Per-house "when did your last frame land" (#588) — read straight off the
   * caches this catalog already holds open, so it costs one SQL per house and
   * never a network call. Feeds the outage line on an empty feed / summary.
   */
  houseSilence(): HouseSilence[] {
    return this.feeds.map((f) => ({ slug: f.slug, lastFrameAt: f.cache.lastFrameAt() }));
  }

  /** The home house. */
  home(): HouseFeed {
    return this.feeds[0]!;
  }

  forHouse(slug: string): HouseFeed | undefined {
    return this.feeds.find((f) => f.slug === slug);
  }

  /**
   * Pull per house → tag the source → dedupe → sort → truncate. The single
   * implementation behind every merged read. `of` extracts the row into a
   * CachedFeedItem (`repliesToOwner`'s rows are wrapped one level deeper).
   */
  private merge<T>(
    pick: (f: HouseFeed) => T[],
    of: (t: T) => CachedFeedItem,
    n?: number,
  ): T[] {
    const seen = new Map<string, CachedFeedItem>();
    const out: T[] = [];
    for (const f of this.feeds) {
      for (const row of pick(f)) {
        const item = of(row);
        const key = keyOf(item);
        const first = seen.get(key);
        if (first) {
          // The same event showed up in multiple houses (a relay). The first house that saw it wins; record the later one(s).
          (first.alsoInHouses ??= []).push(f.slug);
          continue;
        }
        item.houseSlug = f.slug;
        seen.set(key, item);
        out.push(row);
      }
    }
    out.sort((a, b) => newestFirst(of(a), of(b)));
    return n === undefined ? out : out.slice(0, n);
  }

  recent(n: number): CachedFeedItem[] {
    return this.merge((f) => f.cache.recent(n), (i) => i, n);
  }

  recentForReading(n: number): ReadableFeedItem[] {
    return this.merge((f) => f.cache.recentForReading(n), (i) => i, n);
  }

  forReadingSince(start: number): ReadableFeedItem[] {
    return this.merge(
      f => (f.cache.forReadingSince?.(start) ?? f.cache.recentForReading(Number.MAX_SAFE_INTEGER))
        .filter(i => i.platformPostCreatedAt >= start),
      i => i,
    );
  }

  byAuthor(popclawId: string, n: number): CachedFeedItem[] {
    return this.merge((f) => f.cache.byAuthor(popclawId, n), (i) => i, n);
  }

  byPlatform(platform: string, n: number): CachedFeedItem[] {
    return this.merge((f) => f.cache.byPlatform(platform, n), (i) => i, n);
  }

  search(query: string, n: number): CachedFeedItem[] {
    return this.merge((f) => f.cache.search(query, n), (i) => i, n);
  }

  repliesToOwner(ownerPopclawId: string, limit: number): ReplyToOwner[] {
    return this.merge((f) => f.cache.repliesToOwner(ownerPopclawId, limit), (r) => r.reply, limit);
  }

  /** The union of author ids across all houses (the source for identity resolution's "people I've seen"). */
  authorIds(): string[] {
    const seen = new Set<string>();
    for (const f of this.feeds) for (const id of f.cache.authorIds()) seen.add(id);
    return [...seen];
  }

  /** The earliest across all houses — "first seen on this machine" is a single value, not per-house. */
  authorFirstSeen(): Map<string, number> {
    const out = new Map<string, number>();
    for (const f of this.feeds) {
      for (const [id, t] of f.cache.authorFirstSeen()) {
        const prev = out.get(id);
        if (prev === undefined || t < prev) out.set(id, t);
      }
    }
    return out;
  }

  /** Find the first hit in house order (the home house wins ties). */
  lookup(platform: string, platformPostId: string): CachedFeedItem | null {
    for (const f of this.feeds) {
      const hit = f.cache.lookup(platform, platformPostId);
      if (hit) {
        hit.houseSlug = f.slug;
        return hit;
      }
    }
    return null;
  }

  /** Only unique across every house counts as unique: two houses each holding a different id colliding on the same prefix → ambiguous. */
  findFullEventId(prefix: string): { full: string | null; ambiguous: string[] } {
    const ids = new Set<string>();
    for (const f of this.feeds) {
      const r = f.cache.findFullEventId(prefix);
      if (r.full) ids.add(r.full);
      for (const a of r.ambiguous) ids.add(a);
    }
    const all = [...ids];
    return all.length === 1 ? { full: all[0]!, ambiguous: [] } : { full: null, ambiguous: all.slice(0, 3) };
  }

  findByEventIdPrefix(prefix: string): { item: CachedFeedItem | null; ambiguous: string[] } {
    const items = new Map<string, CachedFeedItem>();
    const ids = new Set<string>();
    for (const f of this.feeds) {
      const r = f.cache.findByEventIdPrefix(prefix);
      if (r.item) {
        ids.add(r.item.eventId);
        if (!items.has(r.item.eventId)) {
          r.item.houseSlug = f.slug;
          items.set(r.item.eventId, r.item);
        }
      }
      for (const a of r.ambiguous) ids.add(a);
    }
    const all = [...ids];
    if (all.length === 1) {
      const only = items.get(all[0]!);
      return only ? { item: only, ambiguous: [] } : { item: null, ambiguous: all };
    }
    return { item: null, ambiguous: all.slice(0, 3) };
  }

  /**
   * Pull each house's live snapshot concurrently and merge. Whatever comes
   * back lands straight into **that house's own** writable cache while we're at it
   * (backstopping anything SSE missed, so attribution never gets crossed).
   * A single unreachable house only logs a one-line warning and doesn't take
   * the rest down; only throws if every house fails (the caller still needs
   * to see that "the feed is down").
   */
  async fetchSnapshot(q: WorldFeedQuery): Promise<HouseSnapshotItem[]> {
    const settled = await Promise.allSettled(this.feeds.map((f) => f.snapshot.fetchSnapshot(q)));
    const out: HouseSnapshotItem[] = [];
    const seen = new Set<string>();
    let firstErr: unknown;
    for (const [idx, res] of settled.entries()) {
      const f = this.feeds[idx]!;
      if (res.status === 'rejected') {
        firstErr ??= res.reason;
        this.opts.warn?.(`world-feed snapshot ${f.slug} fetch failed — ${String(res.reason)}`);
        continue;
      }
      for (const item of res.value) {
        if (!f.cacheReadOnly) f.cache.record(item);
        const key = keyOf({
          eventId: typeof item.eventId === 'string' ? item.eventId : '',
          platform: typeof item.platform === 'string' ? item.platform : '',
          platformPostId: typeof item.platformPostId === 'string' ? item.platformPostId : '',
        });
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({...item, houseSlug: f.slug});
      }
    }
    if (firstErr !== undefined && out.length === 0 && settled.every((r) => r.status === 'rejected')) {
      throw firstErr;
    }
    out.sort((a, b) => numberOrZero(b.platformPostCreatedAt) - numberOrZero(a.platformPostCreatedAt));
    return q.limit === undefined ? out : out.slice(0, q.limit);
  }
}
