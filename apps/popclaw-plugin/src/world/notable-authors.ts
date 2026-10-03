/**
 * Client-side "important people" aggregator (S4-T3)
 *
 * Zero-server-change principle (ADR-0001 server-minimization):
 * aggregates from summary.hot_posts + snapshot entries, no new lore-house endpoint.
 *
 * Sort order: platform breadth desc → postCount desc → nickname asc (alphabetical
 * as tiebreaker). Multi-platform stitching (e.g. mrbeast across 4 platforms)
 * naturally floats to the top — that's the display's point.
 */
import { displayPerson } from '../identity/person-resolver.js';
import type { NameChain } from '../identity/person-name.js';

/** A single input source (a hot_post row or a snapshot entry mapped into this shape). */
export interface AuthorSource {
  /** base58 popclaw_id */
  readonly popclawId: string;
  /** platform name, e.g. 'x' / 'youtube' / 'instagram' / 'tiktok' */
  readonly platform: string;
  /** this source's nickname (may be undefined or empty string); the earliest non-empty value wins during aggregation */
  readonly nickname?: string;
  /**
   * Post count contributed by this entry (usually 1 for hot-post sources;
   * the actual count if already aggregated).
   * Defaults to 1.
   */
  readonly postCount?: number;
}

/** Aggregation result: a summary of one popclaw_id across all platforms. */
export interface AuthorAggregate {
  readonly popclawId: string;
  /** Final nickname (first non-empty value; if none, the first 8 chars of popclaw_id). */
  readonly nickname: string;
  /** Deduped + sorted platform list, e.g. ['instagram','tiktok','x','youtube'] */
  readonly platforms: string[];
  /** Sum of postCount across all source entries */
  readonly postCount: number;
}

/**
 * Aggregate the "important people" list.
 *
 * @param inputs  - AuthorSource entries (may come from summary.hot_posts + snapshot mappings)
 * @param cap     - max people to return; undefined = no truncation
 * @param nameOf  - unique name chain; if given, use the owner's own naming (alias overrides the server-supplied self-reported nickname)
 */
export function aggregateNotableAuthors(
  inputs: AuthorSource[],
  cap?: number,
  nameOf?: NameChain,
): AuthorAggregate[] {
  if (inputs.length === 0) return [];

  // Accumulate per-author state
  const byId = new Map<
    string,
    { nickname: string; platforms: Set<string>; postCount: number }
  >();

  for (const item of inputs) {
    const count = item.postCount ?? 1;
    const existing = byId.get(item.popclawId);

    if (existing) {
      existing.platforms.add(item.platform);
      existing.postCount += count;
      // Prefer first non-empty nickname seen
      if (!existing.nickname && item.nickname) {
        existing.nickname = item.nickname;
      }
    } else {
      byId.set(item.popclawId, {
        nickname: item.nickname ?? '',
        platforms: new Set([item.platform]),
        postCount: count,
      });
    }
  }

  // Build result array
  const results: AuthorAggregate[] = [];
  for (const [popclawId, acc] of byId) {
    // The name goes through the unique name chain (alias > self-reported nickname > handle);
    // only fall back to the bare sigil if there's nothing at all — this line feeds
    // directly into the world digest the owner sees (`formatNotableAuthorLine`), and a
    // raw id prefix there is pure noise (ADR-0032).
    const chained = nameOf ? nameOf(popclawId, acc.nickname) : acc.nickname.trim();
    const nickname = chained || displayPerson(popclawId);
    const platforms = [...acc.platforms].sort();
    results.push({ popclawId, nickname, platforms, postCount: acc.postCount });
  }

  // Sort: platform breadth desc → postCount desc → nickname asc
  results.sort((a, b) => {
    const breadthDiff = b.platforms.length - a.platforms.length;
    if (breadthDiff !== 0) return breadthDiff;
    const countDiff = b.postCount - a.postCount;
    if (countDiff !== 0) return countDiff;
    return a.nickname.localeCompare(b.nickname);
  });

  return cap !== undefined ? results.slice(0, cap) : results;
}
