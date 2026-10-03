/**
 * The receiving half of `popclaw_write_taste` — the agent hands back its conclusion after
 * mining memory.
 *
 * Same two hard constraints as the night digest's `recordDream`:
 * 1. **No tags, no acceptance** (Appendix A.3) — the tail runs on every tool call, and can only
 *    do local tag matching; handing over a paragraph of prose alone means nothing gets
 *    persisted.
 * 2. **Read back verbatim to the owner after persisting** (A.4) — this is the answer to "what
 *    if the AI guessed wrong": he has to be able to see what got written before he can even
 *    think about overturning it.
 */
import {
  readLearnedTaste,
  writeLearnedTaste,
  LEARNED_FROM_MEMORY,
  type LearnedTaste,
} from './learned-writer.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

const MAX_TAGS = 12;

export interface WriteTasteInput {
  tags?: unknown;
  mute?: unknown;
  summary?: unknown;
}

export interface WriteTasteDeps {
  tasteRoot: string;
  /** Seam: tests plug in a fake here; in production it's writeLearnedTaste. */
  write?: (t: LearnedTaste, file: string) => Promise<void>;
  /** Seam: reads the existing copy, used for merging. In production it's readLearnedTaste. */
  read?: (file: string) => Promise<LearnedTaste>;
  /** S3 rollout — defaults to `ownerLang()` (S1 process-wide singleton). */
  lang?: Lang;
}

/** Trims whitespace, dedupes, preserves order, caps the count. Duplicate tags coming back from the LLM are the norm. */
function clean(xs: unknown, cap = MAX_TAGS): string[] {
  const out: string[] = [];
  if (!Array.isArray(xs)) return out;
  for (const x of xs) {
    if (typeof x !== 'string') continue;
    const t = x.trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= cap) break;
  }
  return out;
}

export async function writeTasteFromMemory(
  deps: WriteTasteDeps,
  input: WriteTasteInput,
): Promise<{ text: string }> {
  const lang = deps.lang ?? ownerLang();
  const tags = clean(input.tags);
  if (tags.length === 0) {
    return { text: renderCopy(lang, 'taste.write.tagsEmpty') };
  }
  const summary = typeof input.summary === 'string' ? input.summary.trim() : '';

  // **Merge, not overwrite** — this surfaced during real-machine acceptance testing: this
  // harvest run using different search terms won't dig up what the last run found (last round
  // dug up "literacy games / Flutter / red-packet contracts", this round it's "Starship /
  // social philosophy"). Overwriting would make the owner running it again actually **lose
  // tags**, which is the most trust-damaging kind of regression.
  //
  // New tags go first: when capping the count, the old ones get evicted, so this layer can
  // keep updating itself over time instead of freezing at its first run.
  // (The night-digest path is an overwrite-write, because it looks at the same social log
  // every night and can self-correct; this path is sparse-sampled historical mining, where
  // every run sees a different slice, so it can only accumulate.)
  const prev = await (deps.read ?? ((f) => readLearnedTaste({ tasteRoot: deps.tasteRoot }, f)))(
    LEARNED_FROM_MEMORY,
  ).catch(() => ({ tags: [], mute: [], summary: '' }) as LearnedTaste);
  const merged = clean([...tags, ...prev.tags]);
  const mergedMute = clean([...clean(input.mute), ...prev.mute]);
  const added = merged.filter((t) => !prev.tags.includes(t));

  const taste: LearnedTaste = { tags: merged, mute: mergedMute, summary };
  await (deps.write ?? ((t, f) => writeLearnedTaste({ tasteRoot: deps.tasteRoot }, t, f)))(
    taste,
    LEARNED_FROM_MEMORY,
  );

  // Read it back verbatim: if the owner can't see it, he can't overturn it (A.4 sovereign layer).
  const sep = renderCopy(lang, 'taste.write.sep');
  const lines = [
    renderCopy(lang, 'taste.write.saved', { file: LEARNED_FROM_MEMORY }),
    '',
    renderCopy(lang, 'taste.write.likes', { tags: merged.join(sep) }),
    renderCopy(lang, 'taste.write.mute', {
      mute: taste.mute.length ? taste.mute.join(sep) : renderCopy(lang, 'taste.write.muteEmpty'),
    }),
  ];
  if (prev.tags.length > 0) {
    lines.push(
      '',
      renderCopy(lang, 'taste.write.merged', {
        added: added.length > 0 ? added.join(sep) : renderCopy(lang, 'taste.write.noneAdded'),
      }),
    );
  }
  if (summary) lines.push('', summary);
  lines.push('', renderCopy(lang, 'taste.write.footer'));
  return { text: lines.join('\n') };
}
