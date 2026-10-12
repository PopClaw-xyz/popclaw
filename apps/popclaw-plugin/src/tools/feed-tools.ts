/** World-feed reads: the feed, keyword search, and the recommendation digest. */

import bs58 from 'bs58';
import type { PublicFeedDisplay } from '../ingress/public-feed-display.js';
import { EmptySchema, ShowFeedSchema, SearchFeedSchema } from './tool-schemas.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import { resolveAuthor } from '../world/author-resolver.js';
import { runPopclawFeedCommand } from '../commands/popclaw-feed.js';
import { runPopclawSearchCommand } from '../commands/popclaw-search.js';
import { runPopclawRecommendCommand } from '../commands/popclaw-recommend.js';
import { houseSilenceOf, houseSilenceText } from '../ingress/house-silence.js';
import { disambiguationText, fetchAuthorSources } from './author-sources.js';
import { type ToolsCtx } from './tools-context.js';
import { withTail } from './tool-tail.js';

/** popclaw_show_feed + popclaw_search_feed, both local-display reads. */
export function registerFeedTools(ctx: ToolsCtx): void {
  const { runtime, deps } = ctx;
  // These two public reads must not trigger the generic unread/nudge tail.
  // Keep the original wrapper in legacy mode, selected from the actual runtime.
  const registerLocalDisplayTool = (tool: { name: string; description: string; parameters: unknown;
    execute(callId: string, params: unknown): Promise<{ type: 'text'; text: string }> }) => {
    let legacy!: typeof tool;
    withTail({ ...deps.api, registerTool: wrapped => { legacy = wrapped as typeof tool; } }, runtime, deps.runCommand).registerTool(tool);
    deps.api.registerTool({ ...tool, execute: async (callId: string, params: unknown) => {
      const rt = await runtime();
      if (!rt.publicFeedDisplay) return legacy.execute(callId, params);
      const invoke = () => tool.execute(callId, params);
      return deps.runCommand ? deps.runCommand(invoke) : invoke();
    } });
  };


  registerLocalDisplayTool({
    name: 'popclaw_show_feed',
    description:
      'Call this tool when the owner says "my feed", "anything new", "what did <someone> post", ' +
      '"recent posts", "latest posts", "what is on/happening in my lore-house", or asks to see a lore-house\'s recent content with authors and post ids. ' +
      "Show the user's world feed of PUBLIC posts (popclaw-native + scraped social posts) — not private messages. " +
      'filter_by_author takes a name or a popclaw_id — a name (e.g. "Elon Musk") is resolved automatically first. ' +
      'Each House selects verified local public-v1 content or its declared ordinary signed snapshot; preserve bounded/history/completeness qualifications. ' +
      'If the tool fails, tell the owner it failed — never make up a result.',
    parameters: ShowFeedSchema,
    execute: async (_callId: string, params: unknown) => {
      const p = params as { filter_by_author?: string; limit?: number };
      const rt = (await runtime()) as { worldFeedClient: unknown; worldFeedCache?: unknown; publicFeedDisplay?: PublicFeedDisplay };
      const display=await rt.publicFeedDisplay?.prepare();
      // runPopclawFeedCommand reads count from positional[0] (parseInt) and
      // --author from flags. See apps/popclaw-plugin/src/commands/popclaw-feed.ts
      const flags: Record<string, string> = {};
      let observedAuthorNote = '';
      if (p.filter_by_author) {
        // S4.1-T3: names go through resolveAuthor first; zero hits → treat
        // the input as a raw popclaw_id (legacy passthrough); ambiguous →
        // ask the owner to pick before fetching anything.
        let author = p.filter_by_author;
        let fullAuthorId = false;
        try { fullAuthorId = bs58.decode(author).length === 32 && bs58.encode(bs58.decode(author)) === author; } catch { /* name */ }
        if (display && !fullAuthorId) {
          const local = display.read({ limit: 100 });
          const candidates = resolveAuthor(author, local.items.filter(hit => !hit.mirrorSigner).map(({ item }) => ({
            popclawId: item.authorPopclawId ?? '', platform: item.platform ?? '', nickname: item.handle || item.actorNickname || '',
          })));
          const hasOrdinary = local.sources.some(source => source.protocol === 'ordinary-snapshot');
          const clarifyOrdinary = renderCopy(ownerLang(), 'feed.ordinary.clarifyAuthor');
          if (candidates.length > 1) return { type: 'text' as const, text: hasOrdinary
            ? `${candidates.map((candidate,index)=>`${index+1}. ${candidate.nickname}`).join('\n')}\n${clarifyOrdinary}`
            : disambiguationText(author, candidates) };
          if (candidates.length === 1) {
            const observedOrdinary = local.items.some(hit => !hit.mirrorSigner && hit.item.authorPopclawId === candidates[0]!.popclawId
              && local.sources.some(source => source.origin === hit.source.origin && source.protocol === 'ordinary-snapshot' && !source.unavailable));
            if (!observedOrdinary && (local.truncated || local.sources.some(source => source.unavailable || source.incomplete))) return {
              type: 'text' as const, text: renderCopy(ownerLang(), 'feed.public.authorLimited'),
            };
            if (observedOrdinary) observedAuthorNote = renderCopy(ownerLang(), 'feed.ordinary.observedAuthor', { nickname: candidates[0]!.nickname });
            author = candidates[0]!.popclawId;
          } else return { type: 'text' as const, text: hasOrdinary ? clarifyOrdinary : renderCopy(ownerLang(), 'feed.public.authorLimited') };
        } else if (!rt.publicFeedDisplay && deps.getWorldDeps !== undefined) {
          const wd = await deps.getWorldDeps();
          const { sources } = await fetchAuthorSources(wd);
          const candidates = resolveAuthor(p.filter_by_author, sources);
          const only = candidates[0];
          if (candidates.length === 1 && only) {
            author = only.popclawId;
          } else if (candidates.length > 1) {
            return {
              type: 'text' as const,
              text: disambiguationText(p.filter_by_author, candidates),
            };
          }
        }
        flags['author'] = author;
      }
      const positional: string[] = [];
      if (typeof p.limit === 'number' && p.limit > 0) {
        positional.push(String(Math.floor(p.limit)));
      }
      const args = { positional, flags };
      const reply = await runPopclawFeedCommand(
        args as Parameters<typeof runPopclawFeedCommand>[0],
        rt.worldFeedClient as Parameters<typeof runPopclawFeedCommand>[1],
        {
          publicFeedDisplay: display,
          // #588: an empty feed is a house outage OR a quiet world, and the agent
          // cannot tell which without this. Lazy — only an empty result pays for it.
          silence: () => houseSilenceText(houseSilenceOf(rt)),
        },
      );
      return { type: 'text' as const, text: observedAuthorNote + reply.text };
    },
  });

  registerLocalDisplayTool({
    name: 'popclaw_search_feed',
    description:
      'Search the selected verified House content by keyword and return matching posts with text and source links. ' +
      'Use when the owner asks about a specific person/topic/event — "show me the latest on Elon", ' +
      '"tell me more about that SpaceX story", "anything about <X>". Reads verified public journals or a bounded signed ordinary House snapshot; ' +
      'summarise them for the owner and offer the source link (original_url) for deeper detail. ' +
      'This needs a real keyword — a wildcard is not a way to list recent posts, use popclaw_show_feed for that. ' +
      'Ordinary Houses provide bounded signed snapshots; public-v1 uses local retained content. Retain history, completeness and observation-time qualifications.',
    parameters: SearchFeedSchema,
    execute: async (_callId: string, params: unknown) => {
      const p = params as { query?: string; limit?: number };
      const rt = (await runtime()) as { worldFeedCache: unknown; publicFeedDisplay?: PublicFeedDisplay };
      const flags: Record<string, string> = {};
      if (typeof p.limit === 'number' && p.limit > 0) {
        flags['limit'] = String(Math.floor(p.limit));
      }
      const query = (p.query ?? '').trim();
      const args = { positional: query.length > 0 ? [query] : [], flags };
      const reply = await runPopclawSearchCommand(
        args as Parameters<typeof runPopclawSearchCommand>[0],
        rt.worldFeedCache as Parameters<typeof runPopclawSearchCommand>[1],
        rt.publicFeedDisplay,
      );
      return { type: 'text' as const, text: reply.text };
    },
  });
}

/** popclaw_show_recommend. */
export function registerRecommendTool(ctx: ToolsCtx): void {
  const { api, runtime } = ctx;
  api.registerTool({
    name: 'popclaw_show_recommend',
    description:
      'Call this tool when the owner says "any recommendations", "anything worth reading", "pick a few for me". ' +
      'Show a curated digest of recent items scored against user taste + social graph. ' +
      'If the tool fails, tell the owner it failed — never make up a result.',
    parameters: EmptySchema,
    execute: async () => {
      const rt = (await runtime()) as {
        worldFeedCache: unknown; tasteLoader: unknown; cadenceLoader: unknown;
        socialGraph: unknown; scoreCache: unknown;
      };
      const reply = await runPopclawRecommendCommand(
        { positional: [], flags: {} } as Parameters<typeof runPopclawRecommendCommand>[0],
        {
          cache: rt.worldFeedCache,
          tasteLoader: rt.tasteLoader,
          cadenceLoader: rt.cadenceLoader,
          socialGraph: rt.socialGraph,
          llmScore: async () => '[]',
          llmRender: async () => '',
          scoreCache: rt.scoreCache,
        } as Parameters<typeof runPopclawRecommendCommand>[1],
      );
      return { type: 'text' as const, text: reply.text };
    },
  });
}
