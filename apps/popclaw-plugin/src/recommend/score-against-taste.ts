/**
 * Score a batch of feed items against the user's enabled taste sources.
 *
 * Batched scoring replaces N×M sequential LLM calls (slow and expensive —
 * for 40 items × 2 sources that's 80 calls × ~3-5s each = 4-7 minutes
 * AND 80x the LLM credit burn). Now ONE batched call that asks the LLM
 * to return a JSON N×M matrix of scores. Same semantics; ~80x fewer
 * round-trips, ~80x lower token-count overhead per scoring cycle.
 *
 * each cell is now a 4-axis tuple [topic, depth, novelty,
 * dislike] rather than a single 0-1 number. Final per-source contribution
 * = clamp01(0.5*topic + 0.3*depth + 0.2*novelty - 0.4*dislike). Topic
 * dominates (so legacy single-number outputs map cleanly to topic-only
 * with the others = 0); depth and novelty refine the ranking; dislike
 * lets the user's "bored by" section actively penalise an item rather
 * than just failing to upweight it. Backward-compatible: if the LLM
 * returns a flat number per cell instead of [t,d,n,dl], the parser
 * treats it as topic-only.
 *
 * The LLM call is injected (`llmComplete`) so this module is unit-testable
 * without a live model. The caller (RecommendCycle) wires the real LLM.
 */

import type { EnabledTasteSource } from '../taste/taste-loader.js';

export interface Scoreable {
  platform: string;
  authorPopclawId: string;
  platformPostId: string;
  textPreview: string;
  platformPostCreatedAt: number;
  /**
   * Human-readable handle (e.g. `karpathy`). Optional because old test
   * fixtures don't set it, but production cache items always have one and
   * the digest renderer uses it for human-friendly attribution. When
   * absent, the digest falls back to `authorPopclawId`.
   */
  handle?: string;
}

export interface ScoringAxes {
  topic: number;
  depth: number;
  novelty: number;
  dislike: number;
}

export interface LineageEntry {
  path: string;
  contribution: number;
  /** Per-axis breakdown for this source. Set when fresh-scored, may be omitted for cached items. */
  axes?: ScoringAxes;
}

export interface ScoredItem<T extends Scoreable = Scoreable> {
  item: T;
  score: number;
  lineage: LineageEntry[];
}

/** prompt → text. Same shape as LLMRenderFn so callers can use one binding. */
export type LLMCompleteFn = (prompt: string) => Promise<string>;

/**
 * Default axis weights — tunable via env later. topic dominates so legacy
 * single-number scores map cleanly. dislike subtracts so a strong "bored
 * by" hit can drown out a weak topic match (e.g. 0.6 * 0.5 = 0.3 contrib
 * cancelled by 0.7 * 0.4 = 0.28 dislike).
 */
export const AXIS_WEIGHTS: ScoringAxes = {
  topic: 0.5,
  depth: 0.3,
  novelty: 0.2,
  dislike: 0.4,
};

function clamp01(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function axesToContribution(axes: ScoringAxes): number {
  const raw =
    AXIS_WEIGHTS.topic * axes.topic +
    AXIS_WEIGHTS.depth * axes.depth +
    AXIS_WEIGHTS.novelty * axes.novelty -
    AXIS_WEIGHTS.dislike * axes.dislike;
  return clamp01(raw);
}

function buildBatchPrompt(
  items: readonly Scoreable[],
  sources: readonly EnabledTasteSource[],
): string {
  const lines: string[] = [];
  lines.push(
    `You are a relevance scorer. Given the user's "taste" (interests + dislikes) and a list of social-feed items, judge each item against each taste source on FOUR axes:`,
    `  - topic   (0-1): does the item's subject overlap with the user's stated interests in this source?`,
    `  - depth   (0-1): is the item substantive (data, code, paper, concrete reasoning) rather than trivial / one-liner?`,
    `  - novelty (0-1): does it offer a non-obvious idea, an update, an unfamiliar angle? (low for restated common takes)`,
    `  - dislike (0-1): does it match anything the source explicitly marks as "boring", "I dislike", or otherwise penalised? (this SUBTRACTS from the final score)`,
    '',
    'TASTE SOURCES:',
    '',
  );
  sources.forEach((src, i) => {
    lines.push(`[Source ${i + 1}: ${src.path}, weight ${src.weight}]`);
    lines.push(src.content.trim());
    lines.push('');
  });
  lines.push('ITEMS:', '');
  items.forEach((it, i) => {
    const text = it.textPreview.replace(/\s+/g, ' ').trim();
    lines.push(`[Item ${i + 1}] platform=${it.platform} author=${it.authorPopclawId} | ${text}`);
  });
  lines.push(
    '',
    'OUTPUT FORMAT:',
    `Return a JSON array of ${items.length} rows. Each row is an array of ${sources.length} cells. Each cell is a 4-element array [topic, depth, novelty, dislike] of floats in [0,1].`,
    'Output ONLY the JSON. No prose. No markdown fences. No keys. Just the array.',
    `Example shape (replace zeros with your scores): ${JSON.stringify(
      Array.from({ length: items.length }, () =>
        Array.from({ length: sources.length }, () => [0, 0, 0, 0]),
      ),
    )}`,
  );
  return lines.join('\n');
}

/**
 * Per-cell parse result. The parser supports two LLM output shapes:
 *   - 'axes':  the full multi-axis tuple (preferred).
 *   - 'legacy': a single number per cell — treated as the direct
 *               contribution (legacy numeric output contract). The score
 *               formula skips the axis collapse for these.
 */
type ParsedCell =
  | { kind: 'axes'; axes: ScoringAxes }
  | { kind: 'legacy'; value: number }
  | { kind: 'empty' };

/**
 * Tolerates several LLM output shapes:
 *   - Full axis matrix (preferred): [[ [t,d,n,dl], ... ], ...]
 *   - Legacy single-number per cell:   [[ 0.5, ... ], ...]   → direct contribution
 *   - Flat 1D for single-source legacy:[0.5, 0.3, ...]       → direct contribution
 *   - Malformed → returns 'empty' everywhere (caller falls back to score 0).
 */
function parseScoreMatrix(
  raw: string,
  nItems: number,
  nSources: number,
): ParsedCell[][] {
  let body = raw.trim();
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start >= 0 && end > start) body = body.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return emptyMatrix(nItems, nSources);
  }
  if (!Array.isArray(parsed)) return emptyMatrix(nItems, nSources);

  // Legacy: flat 1D (single-source case where the LLM forgot to nest).
  if (nSources === 1 && parsed.every((x) => typeof x === 'number')) {
    const flat = parsed as number[];
    return Array.from({ length: nItems }, (_, i) => [
      { kind: 'legacy' as const, value: clamp01(flat[i]) },
    ]);
  }

  return Array.from({ length: nItems }, (_, i) => {
    const row = (parsed as unknown[])[i];
    if (!Array.isArray(row)) return Array.from({ length: nSources }, (): ParsedCell => ({ kind: 'empty' }));
    return Array.from({ length: nSources }, (_, j): ParsedCell => {
      const cell = row[j];
      if (Array.isArray(cell)) {
        return {
          kind: 'axes',
          axes: {
            topic: clamp01(cell[0]),
            depth: clamp01(cell[1]),
            novelty: clamp01(cell[2]),
            dislike: clamp01(cell[3]),
          },
        };
      }
      if (typeof cell === 'number') return { kind: 'legacy', value: clamp01(cell) };
      return { kind: 'empty' };
    });
  });
}

function emptyMatrix(nItems: number, nSources: number): ParsedCell[][] {
  return Array.from({ length: nItems }, () =>
    Array.from({ length: nSources }, (): ParsedCell => ({ kind: 'empty' })),
  );
}

function cellContribution(cell: ParsedCell): number {
  if (cell.kind === 'legacy') return cell.value;
  if (cell.kind === 'axes') return axesToContribution(cell.axes);
  return 0;
}

export async function scoreAgainstTaste<T extends Scoreable>(
  items: readonly T[],
  sources: readonly EnabledTasteSource[],
  llmComplete: LLMCompleteFn,
): Promise<ScoredItem<T>[]> {
  if (sources.length === 0 || items.length === 0) {
    return items.map((it) => ({ item: it, score: 0, lineage: [] }));
  }

  const prompt = buildBatchPrompt(items, sources);
  let raw: string;
  try {
    raw = await llmComplete(prompt);
  } catch {
    return items.map((it) => ({ item: it, score: 0, lineage: [] }));
  }
  const matrix = parseScoreMatrix(raw, items.length, sources.length);

  return items.map((it, i) => {
    const lineage: LineageEntry[] = sources.map((src, j) => {
      const cell = matrix[i]?.[j] ?? { kind: 'empty' as const };
      const entry: LineageEntry = {
        path: src.path,
        contribution: src.weight * cellContribution(cell),
      };
      if (cell.kind === 'axes') entry.axes = cell.axes;
      return entry;
    });
    const score = lineage.reduce((s, l) => s + l.contribution, 0);
    return { item: it, score, lineage };
  });
}
