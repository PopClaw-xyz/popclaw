/**
 * Complete successful author-history text: short previews or a dated timeline,
 * with one source-link policy for both formats. Resolution, querying, logging
 * and observed post-id registration stay in the world-tool handler.
 */
import { emojiFor } from '../identity/platform-emoji.js';
import { decodeEnvelopeBody, numberOrZero } from '../ingress/feed-item-projection.js';
import { renderCopy, type Lang } from '../lexicon/index.js';
import { timeContext } from '../time/time-context.js';
import { platformLabel } from '../world/summary-format.js';
import type { WorldSnapshotItemLike } from './tools-context.js';

/** Larger requests use the compact dated history format. */
const AUTHOR_LATEST_FULL_RENDER_MAX = 5;
/** Full envelope text is trimmed and sliced in UTF-16 code units. */
const AUTHOR_HISTORY_BODY_CHARS = 500;

export type AuthorHistoryItem = Readonly<Pick<WorldSnapshotItemLike,
  'platform' | 'textPreview' | 'platformPostId' | 'originalUrl' | 'platformPostCreatedAt' | 'envelope'
>>;

export interface AuthorHistoryInput {
  readonly author: { readonly nickname: string; readonly platforms: readonly string[] };
  readonly items: readonly AuthorHistoryItem[];
  /** Already normalized and capped by the query handler. */
  readonly requestedCount: number;
  readonly webBaseUrl: string;
  /** Captured by the handler before fetching sources. */
  readonly lang: Lang;
}

/** Platform suffix is empty for a resolved person with no known feed platforms. */
function platformsSuffix(platforms: readonly string[]): string {
  return platforms.length > 0 ? `（${platforms.map(platformLabel).join('/')}）` : '';
}

function sourceLink(it: AuthorHistoryItem, platform: string, webBaseUrl: string, lang: Lang): string {
  if (platform === 'popclaw') {
    // Native platformPostId is the event_id; mirror ids belong to their source
    // platform and must never be assembled into a local /post/ URL.
    const shortId = (it.platformPostId ?? '').slice(0, 10);
    return `${renderCopy(lang, 'world.author.linkLabel')}${webBaseUrl}/post/${shortId}`;
  }
  return it.originalUrl
    ? `${renderCopy(lang, 'world.author.sourceLinkLabel')}${it.originalUrl}`
    : renderCopy(lang, 'world.author.sourceLinkMissing');
}

/** Synchronous rendering; owner-local dates are resolved while mapping items. */
export function renderAuthorHistory({ author, items, requestedCount, webBaseUrl, lang }: AuthorHistoryInput): string {
  if (requestedCount > AUTHOR_LATEST_FULL_RENDER_MAX) {
    const rendered = items.map((it) => {
      const platform = it.platform ?? 'popclaw';
      const sec = numberOrZero(it.platformPostCreatedAt);
      // The owner's local calendar day (ADR-0045) — the timeline is for the owner to read.
      const day = sec > 0 ? timeContext(sec).ymd : renderCopy(lang, 'world.author.dateUnknown');
      const decoded =
        it.envelope && it.envelope.length > 0 ? decodeEnvelopeBody(it.envelope) : null;
      const fullText = (decoded?.text || it.textPreview || '').trim();
      const body =
        fullText.length > AUTHOR_HISTORY_BODY_CHARS
          ? `${fullText.slice(0, AUTHOR_HISTORY_BODY_CHARS)}…`
          : fullText;
      const lines = [`[${day}] ${emojiFor(platform)} ${platformLabel(platform)}`, body];
      lines.push(sourceLink(it, platform, webBaseUrl, lang));
      return lines.filter((l) => l.length > 0).join('\n');
    });
    const shortfall =
      items.length < requestedCount ? renderCopy(lang, 'world.author.shortfall', { count: String(requestedCount) }) : '';
    const header = renderCopy(lang, 'world.author.longHeader', {
      nickname: author.nickname,
      platforms: platformsSuffix(author.platforms),
      count: String(items.length),
      shortfall,
    });
    const footer = renderCopy(lang, 'world.author.longFooter', { count: String(items.length) });
    return [header, ...rendered, footer].join('\n\n');
  }
  const rendered = items.map((it, i) => {
    const platform = it.platform ?? 'popclaw';
    const itemLines = [
      `${i + 1}. ${emojiFor(platform)} ${platformLabel(platform)}`,
      (it.textPreview ?? '').trim(),
    ];
    itemLines.push(sourceLink(it, platform, webBaseUrl, lang));
    return itemLines.filter((l) => l.length > 0).join('\n');
  });
  const header = renderCopy(lang, 'world.author.shortHeader', {
    nickname: author.nickname,
    platforms: platformsSuffix(author.platforms),
    count: String(items.length),
  });
  return [header, ...rendered].join('\n\n');
}
