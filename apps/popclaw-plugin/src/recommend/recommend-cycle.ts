/**
 * Orchestrate one Recommend Cycle: cache → score → social-graph boost
 * → minScore filter → topK → render. All external dependencies are
 * injected so this is fully unit-testable.
 *
 * scoring is now batched (one LLM call for the whole pool
 * matrix), so `llmScore` and `llmRender` share the same signature
 * (prompt → text). Callers can pass the same function for both, or wire
 * different models if they want a cheaper one for scoring.
 */

import type { CadenceConfig } from '../cadence/cadence-loader.js';
import type { TasteLoader, EnabledTasteSource } from '../taste/taste-loader.js';
import { scoreAgainstTaste, type LLMCompleteFn, type ScoredItem, type LineageEntry } from './score-against-taste.js';
import { renderDigest } from './render-digest.js';
import { ScoreCache, hashTasteSources } from './score-cache.js';

interface CacheLike {
  recent(n: number): readonly Scoreable[];
}

interface SocialGraphLike {
  /** ADR-0037 "content attention is per-house": the weighting only checks whether I follow them **on that specific house**. */
  followsIn(popclawId: string, houseSlug?: string): boolean;
}

interface Scoreable {
  platform: string;
  authorPopclawId: string;
  platformPostId: string;
  textPreview: string;
  platformPostCreatedAt: number;
  /** The source house (tagged on when read out of WorldFeedCatalog). Undefined when reading a single-house cache directly. */
  houseSlug?: string;
}

export interface RecommendCycleDeps {
  cache: CacheLike;
  tasteLoader: Pick<TasteLoader, 'enabledSources'>;
  cadence: CadenceConfig;
  socialGraph: SocialGraphLike;
  /** LLM call used for scoring + rendering. Callers may pass the same fn twice. */
  llmScore: LLMCompleteFn;
  llmRender: LLMCompleteFn;
  /**
   * Optional persistent score cache. When supplied, items already scored
   * under the current taste sources are skipped — only newly-arrived items
   * hit the LLM. Steady-state cost reduction is large (typically 80-95%
   * fewer scoring calls). Omit to request a full rescore (full rescore
   * every cycle).
   */
  scoreCache?: ScoreCache;
}

const FOLLOW_BOOST = 0.1;

/** Per-author cap on items entering the scoring pool — keeps a single noisy
 * account from crowding the digest. Tunable; 3 chosen empirically as a
 * default that lets prolific accounts contribute their best handful without
 * dominating maxItemsPerDigest=8 outputs.
 */
const PER_AUTHOR_QUOTA = 3;
/** Oversample multiplier when pulling from cache, so the per-author cap still
 * has enough leftovers to fill the pool with diverse authors. */
const RAW_POOL_OVERSAMPLE = 5;

function itemKey(it: { platform: string; platformPostId: string }): string {
  return `${it.platform}:${it.platformPostId}`;
}

/**
 * Reverse-extract the raw 0-1 LLM scores per source from a ScoredItem.
 * Lineage stores `weight × matrix[i][j]`; divide back to recover the matrix
 * row, which is what the cache persists (so weight changes alone invalidate
 * via tasteHash without losing the underlying judgments).
 */
function rawRowFromScored(s: ScoredItem, sources: readonly EnabledTasteSource[]): number[] {
  return sources.map((src, j) => {
    const lin = s.lineage[j];
    if (!lin || src.weight === 0) return 0;
    return lin.contribution / src.weight;
  });
}

function buildScoredFromRow(
  item: ScoredItem['item'],
  rawRow: number[],
  sources: readonly EnabledTasteSource[],
): ScoredItem {
  const lineage: LineageEntry[] = sources.map((src, j) => ({
    path: src.path,
    contribution: src.weight * (rawRow[j] ?? 0),
  }));
  const score = lineage.reduce((s, l) => s + l.contribution, 0);
  return { item, score, lineage };
}

export interface RecommendCycleResult {
  /** Markdown digest the renderer produced (string the user actually sees). */
  readonly digest: string;
  /** Items that made it into the digest (top-K after scoring + boost + filter + sort). */
  readonly top: readonly ScoredItem[];
}

export async function runRecommendCycle(deps: RecommendCycleDeps): Promise<RecommendCycleResult> {
  const { cache, tasteLoader, cadence, socialGraph, llmScore, llmRender, scoreCache } = deps;

  const poolSize = cadence.filtering.maxItemsPerDigest * 5;
  const raw = cache.recent(poolSize * RAW_POOL_OVERSAMPLE);
  const perAuthor = new Map<string, number>();
  const items: typeof raw[number][] = [];
  for (const it of raw) {
    const seen = perAuthor.get(it.authorPopclawId) ?? 0;
    if (seen >= PER_AUTHOR_QUOTA) continue;
    items.push(it);
    perAuthor.set(it.authorPopclawId, seen + 1);
    if (items.length >= poolSize) break;
  }

  const sources = await tasteLoader.enabledSources();

  // split into "already scored under this taste" vs "needs LLM".
  let scored: ScoredItem[];
  if (scoreCache) {
    const tasteHash = hashTasteSources(sources);
    const cached: { item: typeof items[number]; rawRow: number[] }[] = [];
    const toScore: typeof items[number][] = [];
    for (const it of items) {
      const hit = scoreCache.lookup(itemKey(it), tasteHash);
      if (hit) cached.push({ item: it, rawRow: hit });
      else toScore.push(it);
    }

    const fresh = toScore.length > 0 ? await scoreAgainstTaste(toScore, sources, llmScore) : [];

    // Persist newly-scored items into cache.
    for (const s of fresh) {
      scoreCache.put(itemKey(s.item), tasteHash, rawRowFromScored(s, sources));
    }
    if (fresh.length > 0) await scoreCache.save();

    // Reassemble in input order (preserves recency-then-quota positioning so
    // downstream sort is stable for items that tie on score).
    const byKey = new Map<string, ScoredItem>();
    for (const s of fresh) byKey.set(itemKey(s.item), s);
    for (const c of cached) byKey.set(itemKey(c.item), buildScoredFromRow(c.item, c.rawRow, sources));
    scored = items.map((it) => byKey.get(itemKey(it))!);
  } else {
    scored = await scoreAgainstTaste(items, sources, llmScore);
  }

  const boosted: ScoredItem[] = scored.map((s) => {
    const item = s.item as Scoreable;
    const boost = socialGraph.followsIn(item.authorPopclawId, item.houseSlug) ? FOLLOW_BOOST : 0;
    return { ...s, score: s.score + boost };
  });

  const filtered = boosted.filter((s) => s.score >= cadence.filtering.minScore);
  filtered.sort((a, b) => b.score - a.score);
  const top = filtered.slice(0, cadence.filtering.maxItemsPerDigest);

  const digest = await renderDigest(top, cadence, llmRender);
  return { digest, top };
}
