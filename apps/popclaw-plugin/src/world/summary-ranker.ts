/**
 * S4-T4 spec 4 — graduated cold-start ranking.
 *
 * If the owner talked about their interests in act one (taste core non-empty)
 * → use a single LLM matrix prompt to re-rank the digest's hot posts by taste
 * relevance; if they didn't / the LLM is unavailable / the output is bad →
 * fall back to original popularity order, never throw (the digest experience
 * must never be blocked by a ranking failure).
 *
 * Cost discipline: all entries go into the same prompt, one call ranks the
 * whole batch (following the same pattern as naming.ts's suggestNames: fence
 * tolerance + zod validation + silent degradation).
 *
 * The verification-inference tier (spec §4.4, second level) is explicitly out
 * of scope for this slice — the demo owner isn't verified and has no material
 * for it; to be added in S5 / once ranger self-scraping lands. No promises made in copy.
 */
import { z } from 'zod';
import type { LLMClientLike } from '../onboarding/naming.js';
import type { HotPost } from './world-summary-client.js';

const replySchema = z.object({ order: z.array(z.number()) });

/** Truncation length for a single preview entering the prompt (controls token count; the opening is enough to rank on). */
const PROMPT_PREVIEW_CHARS = 200;

export function buildSummaryRankPrompt(coreText: string, posts: readonly HotPost[]): string {
  const list = posts
    .map((p, i) => `${i + 1}. ${p.body_preview.replace(/\s+/g, ' ').slice(0, PROMPT_PREVIEW_CHARS)}`)
    .join('\n');
  return [
    "You're helping the owner sort a batch of social posts by relevance to their interests (most relevant first).",
    `# The owner's stated interests\n${coreText.slice(0, 2000)}`,
    `# Post list (number. content preview)\n${list}`,
    `Output only one JSON object, ranking numbers 1 through ${posts.length} from most to least relevant:` +
      '{"order": [3, 1, 2]}',
  ].join('\n\n');
}

/**
 * Re-rank hot posts by taste relevance.
 *
 * - `llm` is null / `coreText` is blank / entries ≤1 → return in original order, zero LLM calls;
 * - LLM output is extracted with fence tolerance + zod validation; out-of-range /
 *   duplicate indices are ignored, and any missed entries are appended at the
 *   tail in their original order (never drop an entry);
 * - any exception → original order, never throw.
 */
export async function rankBySummaryTaste(
  llm: LLMClientLike | null,
  coreText: string,
  posts: HotPost[],
): Promise<HotPost[]> {
  const original = [...posts];
  if (!llm || coreText.trim().length === 0 || posts.length <= 1) return original;
  try {
    const raw = await llm.complete(buildSummaryRankPrompt(coreText, posts));
    const stripped = raw.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1');
    const parsed = replySchema.parse(JSON.parse(stripped));

    const seen = new Set<number>();
    const ranked: HotPost[] = [];
    for (const n of parsed.order) {
      if (!Number.isInteger(n) || n < 1 || n > posts.length || seen.has(n)) continue;
      seen.add(n);
      ranked.push(posts[n - 1]!);
    }
    // Missed entries are appended at the tail in original order — the worst case
    // of a ranking failure is just falling back to popularity order.
    for (let i = 0; i < posts.length; i++) {
      if (!seen.has(i + 1)) ranked.push(posts[i]!);
    }
    return ranked;
  } catch {
    return original;
  }
}
