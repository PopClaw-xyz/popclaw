import type { PublicFeedDisplay, PublicDisplayResult } from '../ingress/public-feed-display.js';
import { rememberObservedPostIds } from '../world/post-ref.js';
/**
 * /popclaw feed — slash command to read the popclaw world feed
 * from inside OpenClaw. Fetches `GET /world-feed` from lore-house via
 * `WorldFeedClient`, decodes the protobuf `WorldFeedSnapshot`, formats
 * items as a monospace text table.
 *
 * Syntax:
 *   /popclaw feed                        # latest 20 across all platforms
 *   /popclaw feed 50                     # latest 50
 *   /popclaw feed --author <popclaw_id>  # filter by persona (composite demo)
 *   /popclaw feed --platform <p>         # filter by one platform
 *   /popclaw feed 30 --author <id> --platform tiktok  # all combined
 *   /popclaw feed --include-threads      # also show pure-reply items (default hides them)
 */

import type { popclaw } from '@popclaw/contracts';
import { sigil, SIGIL_LEN } from '@popclaw/algorithms';
import type { SnapshotSource } from '../ingress/world-feed-client.js';
import { emojiFor } from '../identity/platform-emoji.js';
import { formatFollowerCount } from '../identity/format-count.js';
import { relativeTime } from '../time/time-context.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang, failureText } from '../lexicon/owner-language.js';
import { formatHouseReadFailure, houseReadFailure, RemoteHouseReadError } from '../runtime/house-lifecycle/read-failure.js';
import { ActionInactiveError } from '../runtime/house-lifecycle/action-context.js';

/**
 * Compute the canonical popclaw user display string: `@<nickname>#<sigil>`.
 *
 * Priority:
 *   1. actor_nickname from the projection (envelope.actor.nickname).
 *   2. Fallback: `ranger-<first 6 chars of popclaw_id>` matching plugin
 *      bootstrap's default nickname when user has not set one.
 *
 * Sigil is always derived deterministically from popclaw_id (canonical
 * Crockford base32 length, matching ADR-0015).
 */
function formatActor(actorNickname: string | null | undefined, popclawId: string): string {
  if (!popclawId || popclawId.length === 0) {
    return `@unknown#${'?'.repeat(SIGIL_LEN)}`;
  }
  const nick =
    actorNickname && actorNickname.trim().length > 0
      ? actorNickname
      : `ranger-${popclawId.slice(0, 6)}`;
  const sig = sigil(popclawId);
  return `@${nick}#${sig}`;
}

/**
 * Convert internal platform key to a short display label.
 *   'x' → 'X', 'instagram' → 'IG', 'tiktok' → 'TikTok', 'youtube' → 'YT'
 */
function formatPlatformLabel(platform: string): string {
  switch (platform) {
    case 'x': return 'X';
    case 'instagram': return 'IG';
    case 'tiktok': return 'TikTok';
    case 'youtube': return 'YT';
    case 'popclaw': return 'popclaw';
    default: return platform;
  }
}

/**
 * Build the "verified: 🐦 elonmusk · 📷 elon · ..." line for a feed card
 * footer. Returns "" when actor_verified is empty (spec §5.1).
 * Truncates to first 3 + "· ...+N" when more than 3 platforms (spec §4.7).
 *
 * The popclaw-native row (identity anchor) is excluded — the footer lists
 * verified *external* accounts only, matching the spec §4.7 mock and the
 * Passport renderer's §4.6 rule.
 */
function formatVerifiedFooter(actorVerified: ReadonlyArray<{
  platform?: string | null;
  handle?: string | null;
  // pbjs decodes proto int64 as number | Long; coerced at runtime via Number().
  followerCount?: number | { toNumber(): number } | null;
}> | null | undefined): string {
  const list = (actorVerified ?? []).filter((v) => v.platform !== 'popclaw');
  if (list.length === 0) return '';
  const head = list.slice(0, 3).map((v) => {
    const emoji = emojiFor(v.platform ?? '');
    const count = formatFollowerCount(Number(v.followerCount ?? 0));
    return count ? `${emoji} ${v.handle ?? ''} (${count})` : `${emoji} ${v.handle ?? ''}`;
  });
  const extra = list.length > 3 ? ` · ...+${list.length - 3}` : '';
  return `verified: ${head.join(' · ')}${extra}`;
}

/**
 * Format the "who" column for a feed row.
 *
 * Cross-platform mirrors (X / IG / TikTok / YouTube) with a verified handle
 * render as `<emoji> @handle@<PLATFORM>#sigil` (email-style, platform visible).
 *
 * Popclaw-native posts render as `<emoji> @nickname#sigil` (unchanged).
 */
function formatWho(it: popclaw.event.IWorldFeedItem): string {
  const popclawId = it.authorPopclawId ?? '';
  const platform = it.platform ?? '';
  const emoji = PLATFORM_EMOJI[platform] ?? '·';

  // Cross-platform mirror with verified handle → email-style display
  if (platform && platform !== 'popclaw' && it.handle && it.handle.length > 0) {
    const sig = sigil(popclawId.length > 0 ? popclawId : it.handle);
    const platformLabel = formatPlatformLabel(platform);
    return `${emoji} @${it.handle}@${platformLabel}#${sig}`;
  }

  // Popclaw-native or unverified mirror → existing @nick#sigil
  return `${emoji} ${formatActor(it.actorNickname, popclawId)}`;
}

export interface PopclawFeedArgs {
  readonly positional: string[];
  readonly flags: Record<string, string>;
}

export interface FeedCacheLike {
  /** Optional: the cross-house catalog doesn't have this method — the snapshot is already recorded per-house inside fetchSnapshot. */
  record?(item: popclaw.event.IWorldFeedItem): void;
  recent(n: number): { platformPostCreatedAt: number }[];
}
export interface PopclawFeedOpts {
  publicFeedDisplay?: PublicFeedDisplay;
  cache?: FeedCacheLike;
  now?: () => number;
  /**
   * One line per mounted house saying when its last frame landed (#588),
   * appended **only to an UNFILTERED empty result** so the agent can tell a
   * house outage from a genuinely quiet world.
   *
   * Unfiltered is the whole point: "what did X post lately" with nothing from
   * X is the most common benign empty there is, and the filter already
   * explains it. Framing that as "a silent house is an outage" would send the
   * agent hunting a fault that isn't there. Cache-only and lazy — never
   * evaluated unless it will actually be shown. A throw here is swallowed: the
   * feed is the deliverable, the outage note is the footnote.
   */
  silence?: () => string;
}
const NUDGE_MIN = 5;
const NUDGE_SCAN = 1000;
const NUDGE_WINDOW_SEC = 86400;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const PLATFORM_EMOJI: Record<string, string> = {
  x: '🐦',
  instagram: '📷',
  tiktok: '🎵',
  youtube: '▶️',
  popclaw: '📜',
};

export async function runPopclawFeedCommand(
  args: PopclawFeedArgs,
  client: SnapshotSource,
  opts: PopclawFeedOpts = {},
): Promise<{ text: string }> {
  // Positional N (parsed as integer). --author, --platform flags.
  let limit = DEFAULT_LIMIT;
  if (args.positional[0]) {
    const n = Number.parseInt(args.positional[0], 10);
    if (Number.isFinite(n) && n > 0) limit = Math.min(n, MAX_LIMIT);
  }
  const author = args.flags['author'];
  const platform = args.flags['platform'];
  const includeThreads = 'include-threads' in args.flags || 'include_threads' in args.flags;

  if (opts.publicFeedDisplay) {
    const display = await opts.publicFeedDisplay.prepare({limit,author,platform,includeThreads});
    const result = display.read({ limit, author, platform, includeThreads });
    return { text: formatPublicDisplay(result) };
  }

  let items: popclaw.event.IWorldFeedItem[];
  try {
    items = await client.fetchSnapshot({ limit, author, platform });
  } catch (err) {
    // Preserve the typed local/remote cause; nullable legacy consumers remain separate.
    if (err instanceof ActionInactiveError || err instanceof RemoteHouseReadError) return { text: formatHouseReadFailure(ownerLang(),houseReadFailure(err)) };
    return { text: failureText('/popclaw feed', err) };
  }

  // Classify each item:
  //   isQuote = quotedEventId set
  //   isReply = replyToPostId set AND NOT isQuote (quote takes precedence)
  //   isRoot  = !isReply AND !isQuote
  // Default: hide isReply unless --include-threads.
  const visible = items.filter((it) => {
    const isQuote = (it.quotedEventId ?? '').length > 0;
    const isReply = (it.replyToPostId ?? '').length > 0 && !isQuote;
    if (isReply && !includeThreads) return false;
    return true;
  });
  const hiddenReplies = items.length - visible.length;

  // Record into cache (catches what SSE missed) + compute the 24h count for
  // the daily-paper nudge. Skipped entirely when there's no cache (backward compat).
  let nudge = '';
  if (opts.cache) {
    // When catalog is passed in there's no record() (persisting per-house is
    // already done inside fetchSnapshot, so attribution doesn't get crossed).
    for (const it of items) opts.cache.record?.(it);
    const nowSec = Math.floor((opts.now ?? Date.now)() / 1000);
    const cutoff = nowSec - NUDGE_WINDOW_SEC;
    const count24h = opts.cache.recent(NUDGE_SCAN).filter((i) => i.platformPostCreatedAt >= cutoff).length;
    if (count24h >= NUDGE_MIN) {
      nudge = `\n\n${renderCopy(ownerLang(), 'feed.nudge', { shown: String(visible.length), total: String(count24h) })}`;
    }
  }
  // `items`, not `visible`: frames that arrived and were merely hidden by the
  // default thread filter still prove every house is talking to us.
  const unexplainedEmpty = items.length === 0 && !author && !platform;
  return {
    text: formatFeed(visible, { author, platform, includeThreads, hiddenReplies }) + nudge + silenceNote(unexplainedEmpty, opts),
  };
}

/** The outage note (#588), or '' when the emptiness is already explained (or there is none). */
function silenceNote(applies: boolean, opts: PopclawFeedOpts): string {
  if (!applies || !opts.silence) return '';
  try {
    const text = opts.silence();
    return text ? `\n\n${text}` : '';
  } catch {
    return '';
  }
}

function formatFeed(
  items: popclaw.event.IWorldFeedItem[],
  filter: { author?: string; platform?: string; includeThreads: boolean; hiddenReplies: number },
): string {
  const title = buildTitle(items.length, filter);
  if (items.length === 0) {
    const hint =
      filter.hiddenReplies > 0
        ? `(${filter.hiddenReplies} pure-reply items hidden; use --include-threads to show)`
        : renderCopy(ownerLang(), 'feed.local.empty');
    return `${title}\n\n${hint}`;
  }
  const now = Math.floor(Date.now() / 1000);
  const rows: Array<{ who: string; id: string; time: string; text: string; verifiedFooter?: string; quoted?: string; viewOriginal?: string }> = items.map(
    (it) => {
      const row: (typeof rows)[number] = {
        who: formatWho(it),
        id: `#${(it.platformPostId ?? '').slice(0, 10)}`,
        time: relativeTime(now - Number(it.platformPostCreatedAt ?? 0)),
        text: truncate(it.textPreview ?? '', 60),
      };
      const footer = formatVerifiedFooter(it.actorVerified);
      if (footer) row.verifiedFooter = footer;
      const quotedId = it.quotedEventId ?? '';
      if (quotedId.length > 0) {
        const qAuthor =
          it.quotedAuthorPopclawId && it.quotedAuthorPopclawId.length > 0
            ? formatActor(it.quotedActorNickname, it.quotedAuthorPopclawId)
            : `(other lore-house: ${quotedId.slice(0, 8)}...)`;
        const qPreview =
          it.quotedTextPreview && it.quotedTextPreview.length > 0
            ? `"${truncate(it.quotedTextPreview, 60)}"`
            : '';
        row.quoted = qPreview ? `↳ ${qAuthor}: ${qPreview}` : `↳ ${qAuthor}`;
      }
      // ADR-0025 task 4.1: mirror provenance — "view original" link.
      // Key off it.origin (the structured signal), not the overloaded platform string.
      const originUrl = it.origin?.url ?? '';
      if (originUrl.length > 0) {
        row.viewOriginal = originUrl;
      }
      return row;
    },
  );
  const whoW  = Math.max(15, ...rows.map((r) => r.who.length));
  const idW   = Math.max(12, ...rows.map((r) => r.id.length));
  const timeW = Math.max(7,  ...rows.map((r) => r.time.length));
  const header = pad('who', whoW) + '  ' + pad('id', idW) + '  ' + pad('time', timeW) + '  ' + 'text';
  const sep = '─'.repeat(Math.min(100, header.length));
  const body = rows
    .map((r) => {
      const indent = ' '.repeat(whoW + idW + timeW + 8);
      const main = pad(r.who, whoW) + '  ' + pad(r.id, idW) + '  ' + pad(r.time, timeW) + '  ' + r.text;
      const parts = [main];
      if (r.verifiedFooter) parts.push(`${indent}${r.verifiedFooter}`);
      if (r.quoted) parts.push(`${indent}${r.quoted}`);
      if (r.viewOriginal) parts.push(`${indent}↗ ${r.viewOriginal}`);
      return parts.join('\n');
    })
    .join('\n');
  const footer =
    filter.hiddenReplies > 0 && !filter.includeThreads
      ? `\n(${filter.hiddenReplies} pure-reply items hidden; use --include-threads to show)`
      : '';
  return `${title}\n\n${header}\n${sep}\n${body}${footer}\n\nTip: /popclaw feed --author <popclaw_id>  to filter a persona`;
}

function buildTitle(n: number, filter: { author?: string; platform?: string }): string {
  const parts: string[] = [`🌍 popclaw world feed (${n} items`];
  if (filter.author) parts.push(`author=${shortenId(filter.author)}`);
  if (filter.platform) parts.push(`platform=${filter.platform}`);
  return parts.join(', ') + ')';
}

function shortenId(id: string): string {
  if (id.length <= 10) return id;
  return `${id.slice(0, 6)}…${id.slice(-3)}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

/** Shared by the four selected local display surfaces. Relay metadata is an
 * observation, never a claim about current counts or author verification. */
export function formatPublicDisplay(result: PublicDisplayResult, query?: string): string {
  const lang = ownerLang();
  const ordinary=result.sources.some(s=>s.protocol==='ordinary-snapshot');
  const lines = [ordinary ? renderCopy(lang, 'feed.ordinary.title', { count: String(result.items.length) })
    : renderCopy(lang, 'feed.public.title', { count: String(result.items.length) })];
  if (query) lines.push(renderCopy(lang, 'feed.public.query', { query }));
  if (!result.sources.length) lines.push(renderCopy(lang, 'feed.public.unavailable'));
  for (const source of result.sources) {
    const state = source.unavailable ? 'unavailable' : source.history ? 'history' : 'local';
    lines.push(`${source.origin} — ${source.protocol === 'ordinary-snapshot'
      ? (source.unavailable ? renderCopy(lang, 'feed.ordinary.unavailable')
        : renderCopy(lang, 'feed.ordinary.bounded'))
      : renderCopy(lang, `feed.public.${state}`)}`);
    if (source.incomplete && !source.unavailable && source.protocol!=='ordinary-snapshot') lines.push(renderCopy(lang, 'feed.public.incomplete'));
  }
  if (!result.items.length) lines.push(ordinary ? renderCopy(lang, 'feed.ordinary.empty') : renderCopy(lang, 'feed.public.empty'));
  if (result.truncated) lines.push(renderCopy(lang, 'feed.public.truncated'));
  rememberObservedPostIds(result.items.map(hit => ({...hit.item,houseSlug:hit.source.slug})));
  for (const hit of result.items) {
    const item = hit.item;
    const actor = formatActor(item.actorNickname, item.authorPopclawId ?? '');
    const who = hit.mirrorSigner ? (item.authorPopclawId ? renderCopy(lang, 'feed.public.sharedBy', { actor }) : `${item.platform ?? ''} · ${item.originalUrl ?? ''}`) : formatWho(item);
    lines.push('', `${who} · ${item.platform ?? ''}`, `${item.platformPostId ?? item.eventId ?? ''}`, hit.body);
    if (hit.kind !== 'post' && hit.kind !== 'reply') lines.push(renderCopy(lang, 'feed.public.eventKind', { kind: hit.kind }));
    if (hit.bodyUnavailable) lines.push(renderCopy(lang, 'feed.public.opaqueBody'));
    for (const media of hit.media ?? []) lines.push(`↗ ${media.url}`);
    if (item.originalUrl) lines.push(`↗ ${item.originalUrl}`);
    lines.push(renderCopy(lang, 'feed.public.observed', { source: hit.source.origin,
      time: new Date(hit.source.observedAt * 1000).toISOString() }));
    if (hit.relaySnapshot) lines.push(renderCopy(lang, 'feed.public.metadataObserved'));
    if (hit.alsoInHouses?.length) lines.push(renderCopy(lang, 'feed.public.also', { houses: hit.alsoInHouses.join(', ') }));
  }
  return lines.join('\n');
}
