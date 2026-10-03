/**
 * Persistent per-item score cache.
 *
 * Plan 11.2.1 cost optimization: between two /popclaw-recommend cycles, the
 * 40-item pool is mostly the same — only a few new posts arrived. Re-scoring
 * unchanged items via the LLM each time is wasted spend. This cache stores
 * `(itemId, tasteHash) → number[]` so a cycle can skip the LLM for any
 * previously-scored item whose taste sources are unchanged.
 *
 * Invalidation policy: per-item, keyed by `tasteHash` (sha256 over the
 * canonical concatenation of all enabled sources' path|weight|content +
 * a SCORING_SCHEMA_VERSION constant — bumping the latter automatically
 * invalidates the cache when the prompt or contribution formula changes).
 *
 * Storage: a single JSON file. Lazy load on first lookup. Atomic enough for
 * a personal-machine workload (no two processes write concurrently). Format:
 *
 *   { "x:2436265239770031126": { "tasteHash": "ab12...", "scores": [0.5, 0.0] } }
 *
 * Only the most recent tasteHash is kept per item — the previous entry is
 * overwritten on `put`. This keeps the file size bounded by the number of
 * distinct items ever scored, not the cross-product with taste history.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface CacheEntry {
  tasteHash: string;
  scores: number[];
}

interface TasteSourceLike {
  readonly path: string;
  readonly weight: number;
  readonly content: string;
}

/**
 * Bump when the scoring prompt or contribution formula changes. Mixed into
 * `hashTasteSources` so existing cache entries auto-invalidate (one
 * full-rescore cycle, then steady-state cheap again). Saves the operator
 * from having to manually `rm score-cache.json` on every algorithm tweak.
 *
 * - v1: Plan 11.1.2 — single 0-1 per cell, contribution = weight × cell.
 * - v2: Plan 11.2.3 — multi-axis [topic, depth, novelty, dislike] per cell,
 *       contribution = weight × axesToContribution(axes).
 */
const SCORING_SCHEMA_VERSION = 'v2';

export function hashTasteSources(sources: readonly TasteSourceLike[]): string {
  // Canonical: sort by path so same-content-different-input-order produces
  // the same hash. Each source serialised with explicit field separators
  // that can't appear in the input on accident.
  const sorted = [...sources].sort((a, b) => a.path.localeCompare(b.path));
  const parts = sorted.map(
    (s) => `path=${s.path} weight=${s.weight} content=${s.content}`,
  );
  return createHash('sha256')
    .update(`schema=${SCORING_SCHEMA_VERSION}|`)
    .update(parts.join(''))
    .digest('hex');
}

export class ScoreCache {
  private constructor(
    private readonly filePath: string,
    private readonly entries: Map<string, CacheEntry>,
  ) {}

  static load(filePath: string): ScoreCache {
    const entries = new Map<string, CacheEntry>();
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, CacheEntry>;
        if (raw && typeof raw === 'object') {
          for (const [k, v] of Object.entries(raw)) {
            if (
              v &&
              typeof v.tasteHash === 'string' &&
              Array.isArray(v.scores) &&
              v.scores.every((n) => typeof n === 'number')
            ) {
              entries.set(k, { tasteHash: v.tasteHash, scores: v.scores });
            }
          }
        }
      } catch {
        // Malformed file → start empty. Next save will overwrite.
      }
    }
    return new ScoreCache(filePath, entries);
  }

  /** Returns scores if itemId was previously scored under THIS taste; null otherwise. */
  lookup(itemId: string, tasteHash: string): number[] | null {
    const e = this.entries.get(itemId);
    if (!e || e.tasteHash !== tasteHash) return null;
    return e.scores;
  }

  /** Overwrites any previous entry for itemId — only one taste version is retained per item. */
  put(itemId: string, tasteHash: string, scores: number[]): void {
    this.entries.set(itemId, { tasteHash, scores });
  }

  /** Persist to disk. Caller decides when (typically once at end of cycle). */
  async save(): Promise<void> {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const obj: Record<string, CacheEntry> = {};
    for (const [k, v] of this.entries) obj[k] = v;
    writeFileSync(this.filePath, JSON.stringify(obj), 'utf-8');
  }

  /** Test introspection — number of stored entries. */
  size(): number {
    return this.entries.size;
  }
}
