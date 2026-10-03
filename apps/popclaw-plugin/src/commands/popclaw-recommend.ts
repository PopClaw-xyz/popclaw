/**
 * /popclaw recommend — text digest (taste scoring + follow weighting + render).
 *   --feedback  records layout feedback to canvas-style.md (does not produce a report)
 * --visual retired along with brief (#137, the text+image version merged into the daily paper);
 * passing it still produces the text digest as usual, just prefixed with one notice line.
 */
import type { TasteLoader } from '../taste/taste-loader.js';
import type { CadenceLoader } from '../cadence/cadence-loader.js';
import type { SocialGraph } from '../social-graph/social-graph.js';
import { runRecommendCycle } from '../recommend/recommend-cycle.js';
import type { LLMCompleteFn } from '../recommend/score-against-taste.js';
import type { ScoreCache } from '../recommend/score-cache.js';
import { handleStyleFeedback } from '../visual/style-notes.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';

export interface RecommendCacheLike {
  recent(n: number): readonly {
    platform: string;
    authorPopclawId: string;
    platformPostId: string;
    textPreview: string;
    platformPostCreatedAt: number;
  }[];
}

export interface PopclawRecommendArgs {
  positional: string[];
  flags: Record<string, string>;
}

export interface PopclawRecommendDeps {
  cache: RecommendCacheLike;
  tasteLoader: TasteLoader;
  cadenceLoader: CadenceLoader;
  socialGraph: SocialGraph;
  llmScore: LLMCompleteFn;
  llmRender: LLMCompleteFn;
  scoreCache?: ScoreCache;
  styleFile?: string; // canvas-style.md for --feedback (PopclawPaths.canvasStyleFile())
  now?: () => number;
}

export async function runPopclawRecommendCommand(
  args: PopclawRecommendArgs,
  deps: PopclawRecommendDeps,
): Promise<{ text: string }> {
  const fb = handleStyleFeedback(args.flags, deps.styleFile ?? '', deps.now);
  if (fb) return fb;

  const notice = 'visual' in args.flags ? `${renderCopy(ownerLang(), 'recommend.visualRetired')}\n` : '';
  try {
    const cadence = await deps.cadenceLoader.load();
    const result = await runRecommendCycle({
      cache: { recent: (n) => deps.cache.recent(n) },
      tasteLoader: deps.tasteLoader,
      cadence,
      socialGraph: deps.socialGraph,
      llmScore: deps.llmScore,
      llmRender: deps.llmRender,
      scoreCache: deps.scoreCache,
    });
    return { text: notice + result.digest };
  } catch (err) {
    return { text: failureText('/popclaw recommend', err) };
  }
}
