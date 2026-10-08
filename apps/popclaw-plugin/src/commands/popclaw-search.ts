import type { PublicFeedDisplay } from '../ingress/public-feed-display.js';
import { formatPublicDisplay } from './popclaw-feed.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
/**
 * /popclaw search <keyword> — keyword search over the LOCAL world-feed cache.
 *
 * Unlike `/popclaw feed` (browse the stream), search answers "what's the
 * latest on <person/topic>?": it finds cached posts whose body-preview /
 * handle / source-url contain the query terms and surfaces, for each match,
 * the body preview AND the original_url — so the answer is served instantly
 * from cache, and deeper detail is one source link away.
 *
 * Surfaces:
 *   - this slash command (manual)
 *   - the `popclaw_search_feed` tool (natural-language path; agent calls it)
 *
 * Syntax:
 *   /popclaw search elon
 *   /popclaw search spacex launch        # AND across terms
 *   /popclaw search elon --limit 20
 */

import { sigil } from '@popclaw/algorithms';
import type { WorldFeedReader, CachedFeedItem } from '../ingress/world-feed-cache.js';
import { relativeTime } from '../time/time-context.js';

export interface PopclawSearchArgs {
  readonly positional: string[];
  readonly flags: Record<string, string>;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const PREVIEW_LEN = 200;

const PLATFORM_EMOJI: Record<string, string> = {
  x: '🐦',
  instagram: '📷',
  tiktok: '🎵',
  youtube: '▶️',
  popclaw: '📜',
};

export async function runPopclawSearchCommand(
  args: PopclawSearchArgs,
  cache: WorldFeedReader,
  publicFeedDisplay?: PublicFeedDisplay,
): Promise<{ text: string }> {
  const query = args.positional.join(' ').trim();
  if (query.length === 0 && publicFeedDisplay) return { text: renderCopy(ownerLang(), 'feed.public.searchUsage') };
  if (query.length === 0) {
    return {
      text:
        'Usage: /popclaw search <keyword>  (e.g. /popclaw search elon)\n' +
        'Searches the cached world feed by keyword (post body / handle) and shows source links.',
    };
  }

  let limit = DEFAULT_LIMIT;
  const limFlag = args.flags['limit'];
  if (limFlag) {
    const n = Number.parseInt(limFlag, 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
  }

  if (publicFeedDisplay) {
    const display=await publicFeedDisplay.prepare();
    return {text:formatPublicDisplay(display.search(query,limit),query)};
  }
  const hits = cache.search(query, limit);
  if (hits.length === 0) {
    return {
      text:
        `🔎 search "${query}" — no matches in the cached feed.\n` +
        '(Try /popclaw feed to see the stream, or /popclaw scrape <handle> to pull more.)',
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const blocks = hits.map((it) => formatHit(it, now));
  const plural = hits.length === 1 ? '' : 'es';
  const title = `🔎 search "${query}" (${hits.length} match${plural})`;
  return { text: `${title}\n\n${blocks.join('\n\n')}` };
}

function formatHit(it: CachedFeedItem, now: number): string {
  const emoji = PLATFORM_EMOJI[it.platform] ?? '·';
  // Followed immediately by `#sigil` — when the handle can't be resolved,
  // padding in an id prefix is pure noise (and can even make two different
  // people look like they share a name). With no handle, let the sigil
  // stand alone as the name (ADR-0032).
  const who = it.handle && it.handle.length > 0 ? `@${it.handle}` : '';
  const sig = sigil(it.authorPopclawId.length > 0 ? it.authorPopclawId : it.handle);
  const when = relativeTime(now - it.platformPostCreatedAt);
  const body = truncate(it.textPreview, PREVIEW_LEN);
  const link = it.originalUrl && it.originalUrl.length > 0 ? `\n   🔗 ${it.originalUrl}` : '';
  return `${emoji} ${who}#${sig} · ${when}\n   ${body}${link}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
