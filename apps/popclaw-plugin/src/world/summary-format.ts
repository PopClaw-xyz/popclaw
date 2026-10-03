/**
 * S4.1-T1 — Shared pure functions for rendering world-digest lines.
 *
 * Digest formatting is consumed jointly by the onboarding lantern act and the
 * world-capability tools (popclaw_world_summary etc.) — same source, same
 * conventions; a second rendering path is forbidden.
 * Tone follows soul.ts: say "got the most replies," not "hottest/most popular"
 * (anti fake-engagement).
 *
 * S3 pilot: section headings go through `copy` (whole-sentence, lane B);
 * inline terms (replies / active on / stitched identity / ✓verified / followers /
 * identities / …) go through `terms.worldSummary` (lane A); the layout skeleton
 * (numbering / brackets / middot separators / emoji) stays untouched. Follower-count
 * abbreviation branches by language: on the zh side, the 亿 (100M) / 万 (10K)
 * abbreviation bytes are unchanged; on the en side it uses `Intl.NumberFormat`'s
 * compact notation (K/M) — zero custom logic.
 */
import type { AuthorAggregate } from './notable-authors.js';
import type { NotablePerson, WorldState } from './world-summary-client.js';
import { emojiFor } from '../identity/platform-emoji.js';
import { lexiconFor, renderCopy, type Lang } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

/**
 * Truncation length for a single digest-list-line preview.
 * S4.1 line length went 60 → 120 (owner readability feedback; server preview
 * cap of 200 leaves plenty of headroom).
 */
export const LINE_PREVIEW_CHARS = 120;

/** Rendering cap for notable people (server gives top 10; the card only shows the top 5). */
export const NOTABLE_PEOPLE_CAP = 5;

/** Notable-people section heading (shared by the act2 card and the world_summary tool — same source, same conventions). */
export function notablePeopleHeading(lang: Lang = ownerLang()): string {
  return renderCopy(lang, 'world.notablePeopleHeading');
}

/**
 * Heading for the "active mirrored handles" section (renamed from the original
 * client-side aggregation section "important people").
 * Labeled separately from notable people (verified) — never pass off a mirrored
 * handle as a verified big account (constitutional rule).
 */
export function mirrorAuthorsHeading(lang: Lang = ownerLang()): string {
  return renderCopy(lang, 'world.mirrorAuthorsHeading');
}

/** Fallback heading for the highlights section (used when the old server has no summary_note). */
export function hotPostsFallbackHeading(lang: Lang = ownerLang()): string {
  return renderCopy(lang, 'world.hotPostsFallbackHeading');
}

/** Short platform label (for display; a local copy of the same mapping used in popclaw-feed.ts). */
export function platformLabel(platform: string): string {
  switch (platform) {
    case 'x': return 'X';
    case 'instagram': return 'IG';
    case 'tiktok': return 'TikTok';
    case 'youtube': return 'YT';
    case 'popclaw': return 'popclaw';
    default: return platform;
  }
}

function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export interface HotPostLineArgs {
  readonly nickname: string;
  readonly bodyPreview: string;
  readonly platform: string;
  readonly replyCount: number;
}

/**
 * Digest list line: `<n>. [<nickname>] <preview ≤120 chars> · <platform badge> · <reply count><replies unit>`.
 *
 * This line is the linkage anchor for contextIndex / learned / marks (they
 * archive against the same summaryLine) — all three consume the same rendered
 * output, so a line-length change is a uniform length shift; linkage semantics
 * don't change.
 */
export function formatHotPostLine(n: number, e: HotPostLineArgs, lang: Lang = ownerLang()): string {
  const repliesUnit = lexiconFor(lang).terms.worldSummary.repliesUnit;
  return (
    `${n}. [${e.nickname}] ${truncateOneLine(e.bodyPreview, LINE_PREVIEW_CHARS)}` +
    ` · ${emojiFor(e.platform)} · ${e.replyCount}${repliesUnit}`
  );
}

/** Active mirrored handles line: `<nickname> — active on X/IG/YT/TikTok (stitched identity)`. */
export function formatNotableAuthorLine(a: AuthorAggregate, lang: Lang = ownerLang()): string {
  const W = lexiconFor(lang).terms.worldSummary;
  const platforms = a.platforms.map(platformLabel).join('/');
  const stitched = a.platforms.length > 1 ? W.stitchedSuffix : '';
  return `  ${a.nickname} — ${W.activeAt} ${platforms}${stitched}`;
}

/**
 * Follower-count abbreviation: on the zh side, ≥1 亿 (100M) → `2.2亿`; ≥1 万
 * (10K) → `1800万`/`1.5万`; below 万, left as-is, at most one decimal place,
 * with `.0` dropped for whole values. On the en side it goes through
 * `Intl.NumberFormat` compact notation (K/M) — not a literal translation of
 * 万/亿 — this is the same TODO S4 flagged early for the daily paper (decision
 * doc §4); world_summary lands it here first.
 */
export function formatFollowers(n: number, lang: Lang = ownerLang()): string {
  if (lang === 'zh-CN') {
    if (n >= 100_000_000) return `${trimOneDecimal(n / 100_000_000)}亿`;
    if (n >= 10_000) return `${trimOneDecimal(n / 10_000)}万`;
    return String(n);
  }
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Keep one decimal place (rounded), dropping `.0` for whole values. */
function trimOneDecimal(v: number): string {
  const fixed = v.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/**
 * World-state line (summary v2 world_state):
 * `World: 56 identities · 8 verified accounts · 2 namecards · native posts N`.
 */
export function formatWorldStateLine(ws: WorldState, lang: Lang = ownerLang()): string {
  const W = lexiconFor(lang).terms.worldSummary;
  return (
    `${W.worldLabel}：${ws.identities_total}${W.identitiesUnit} · ${ws.verified_accounts_total}${W.verifiedAccountsUnit} · ` +
    `${ws.namecards_total}${W.namecardsUnit} · ${W.nativePostsLabel} ${ws.native_posts_total}`
  );
}

/**
 * Notable-person line (summary v2 notable_people, verified-only):
 * `<nickname> ✓verified — X @handle 2.2亿 followers · IG @handle 1800万`.
 * The followers-unit word is only appended to the first account (the one with
 * the highest follower count); subsequent accounts just get the number.
 */
export function formatNotablePersonLine(p: NotablePerson, lang: Lang = ownerLang()): string {
  const W = lexiconFor(lang).terms.worldSummary;
  const accounts = p.accounts
    .map(
      (a, i) =>
        `${platformLabel(a.platform)} @${a.handle} ` +
        `${formatFollowers(a.follower_count, lang)}${i === 0 ? W.followerUnit : ''}`,
    )
    .join(' · ');
  return accounts.length > 0
    ? `  ${p.nickname} ${W.verifiedBadge} — ${accounts}`
    : `  ${p.nickname} ${W.verifiedBadge}`;
}
