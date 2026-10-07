/**
 * Shared Passport renderer — turns a ProfileResponse (own or other) into
 * an array of lines for TUI display. Used by:
 *   - /popclaw status (own profile, plugin-side signer + identity fetch)
 *   - /popclaw profile <handle>#<sigil> (other profile via by-handle endpoint)
 *
 * Rules (spec §4.6, §5.1, §5.2, §5.4):
 *   - 0 verified → only header (popclaw_id / sigil / popclaw.me URL); omit
 *     the entire Verified (N) block.
 *   - N > 0 → header + Verified (N): block, one platform per indented entry,
 *     emoji + capitalized-platform-label + handle + verified date + URL.
 *   - Order: same as input (caller passes verified_at ASC).
 *   - Unknown platform: emoji='?', show URL block as "(no canonical URL)" if empty.
 */

import { emojiFor } from './platform-emoji.js';
import { formatFollowerCount } from './format-count.js';
import { lexiconFor, renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { timeContext } from '../time/time-context.js';
import { profileLinkText } from '../lshow/sources/web-fallback.js';

export interface VerifiedProfileInput {
  readonly platform: string;
  readonly handle: string;
  readonly verified_at: string | null | undefined;
  readonly profile_url?: string | null;
  readonly follower_count?: number | null;
  /**
   * ADR-0034: the public URL of the post the applicant put the binding string
   * in — the proof anyone can open and check. "" / absent = none on file
   * (verified before migration 021, or the ranger found the post by search).
   */
  readonly proof_url?: string | null;
}

export interface ProfileCardInput {
  readonly nickname: string;
  readonly one_line_intro?: string | null;
  readonly taste_tags?: readonly string[] | null;
  readonly role_persona?: string | null;
  readonly location_hint?: string | null;
  readonly avatar_uri?: string | null;
  readonly declared_at?: number | null;
}

// Single source: src/lexicon/*.ts `terms.roles`, resolved per call so the
// label follows the owner's language.
const roleLabelFor = (role: string): string => {
  const roles = lexiconFor(ownerLang()).terms.roles;
  return role in roles ? roles[role as keyof typeof roles] : '';
};

export interface PassportInput {
  readonly popclawId: string;
  readonly sigil: string;
  readonly handle: string; // canonical popclaw-native handle (matches /<handle>#<sigil> URL)
  readonly card?: ProfileCardInput | null;
  readonly profiles: readonly VerifiedProfileInput[];
  /**
   * Active follows on THIS lore-house only (spec 2026-07-26
   * house_follower_count) — a per-house local truth, never aggregated
   * across houses. Distinct from each VerifiedProfileInput.follower_count
   * (an external platform's snapshot at verification time): the two are
   * never summed, always rendered on separate lines. Omitted (not 0) when
   * the caller has no house_follower_count to show (e.g. lore-house
   * unreachable) — 0 renders as "0 人关注" (0 followers), which IS a meaningful signal.
   */
  readonly houseFollowerCount?: number | null;
  /**
   * The configured web base (`config.web_base_url` → env → popclaw.me). The
   * address printed below is built by `profileLinkText`, the one builder every
   * surface uses (ADR-0032), so this card and status can never hand the owner
   * two different links for the same person. Omitted → the process default.
   */
  readonly webBaseUrl?: string | null;
}

const TOP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
const MIDDLE = '─────────────────────────────────────────────────────────';

export function platformLabel(platform: string): string {
  switch (platform) {
    case 'x':
    case 'twitter':
      return 'X';
    case 'instagram':
      return 'Instagram';
    case 'github':
      return 'GitHub';
    case 'youtube':
      return 'YouTube';
    case 'tiktok':
      return 'TikTok';
    case 'bluesky':
      return 'Bluesky';
    default:
      return platform;
  }
}

function formatVerifiedDate(iso: string | null | undefined): string {
  if (!iso) return '';
  // The lore-house hands over a UTC ISO string; the date the owner sees must
  // be **their local** day (ADR-0045). If it can't be parsed, fall back to a
  // raw truncation — the date is a nice-to-have, never worth throwing over.
  const ms = Date.parse(iso);
  if (Number.isFinite(ms)) return `verified ${timeContext(Math.floor(ms / 1000)).ymd}`;
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(iso);
  return m && m[1] ? `verified ${m[1]}` : '';
}

export function renderPassport(input: PassportInput): string[] {
  const lines: string[] = [];
  lines.push(TOP);
  lines.push(`  popclaw  ${input.handle ? `@${input.handle}` : ''}#${input.sigil}`);
  lines.push(`  popclaw_id  ${input.popclawId}`);
  lines.push(`  popclaw.me  ${profileLinkText(input.handle || input.popclawId, input.sigil, input.webBaseUrl)}`);
  // This house's follower count (house_follower_count): the local follower
  // count on this lore-house, semantically distinct from the verified
  // accounts' external follower-count snapshot below — never summed, each
  // gets its own line.
  if (input.houseFollowerCount !== undefined && input.houseFollowerCount !== null) {
    lines.push(
      renderCopy(ownerLang(), 'passport.houseFollowerCount', { count: String(input.houseFollowerCount) }),
    );
  }

  // jianghu namecard block (ProfilePayload): nickname · role / intro / tags.
  // Omitted entirely when no card. The header @handle above is the addressing
  // username; this nickname is the display name (spec §4.4, intentionally distinct).
  const card = input.card;
  const nick = card?.nickname?.trim() ?? '';
  if (card && nick) {
    lines.push(MIDDLE);
    const roleLabel = card.role_persona ? roleLabelFor(card.role_persona) : '';
    lines.push(roleLabel ? `  ${nick} · ${roleLabel}` : `  ${nick}`);
    const intro = card.one_line_intro?.trim() ?? '';
    if (intro.length > 0) {
      lines.push(`  ${intro}`);
    }
    const tags = card.taste_tags ?? [];
    if (tags.length > 0) {
      lines.push(`  🏷 ${tags.join(' · ')}`);
    }
  }

  // The popclaw-native row is the identity anchor, already shown in the header
  // (`popclaw @handle#sigil`). It is NOT a verified *external* account, so it is
  // excluded from the Verified list per spec §4.6 (mock shows only X/IG/GitHub/…).
  const displayed = input.profiles.filter((p) => p.platform !== 'popclaw');

  if (displayed.length > 0) {
    lines.push(MIDDLE);
    lines.push(renderCopy(ownerLang(), 'passport.verifiedHeader', { count: String(displayed.length) }));
    // Compute label column width: longest platformLabel.
    const labels = displayed.map((p) => platformLabel(p.platform));
    const labelW = labels.reduce((a, b) => Math.max(a, b.length), 0);
    for (const p of displayed) {
      const emoji = emojiFor(p.platform);
      const label = platformLabel(p.platform).padEnd(labelW, ' ');
      const handle = `@${p.handle}`;
      const followerStr = formatFollowerCount(Number(p.follower_count ?? 0));
      const followerSeg = followerStr ? `👥 ${followerStr}` : '';
      const dateSeg = formatVerifiedDate(p.verified_at);
      const tail = [followerSeg, dateSeg].filter(Boolean).join(' · ');
      lines.push(`    ${emoji} ${label} ${handle.padEnd(20, ' ')} ${tail}`);
      const rawUrl = p.profile_url ?? '';
      const url = rawUrl.length > 0 ? rawUrl : '(no canonical URL)';
      lines.push(`       ${' '.repeat(labelW)}  ${url}`);
      // The point of a verification is that you don't have to take our word
      // for it — so when the proof post is on file, show where to go look.
      // Nothing at all when it isn't: never dress the account URL up as proof.
      //
      // The link is shown unconditionally and its liveness is never probed. The
      // author is free to delete the post afterwards — the ✓ does not depend on
      // it — so a 404 here is an allowed ending, not a broken link, and the copy
      // says so up front. Probing would cost a paid fetch per render and still
      // be wrong five minutes later; the verified-on date printed on the line
      // above is the anchor a reader needs to make sense of a gone post.
      const proof = p.proof_url ?? '';
      if (proof.length > 0) {
        lines.push(`       ${' '.repeat(labelW)}  ${renderCopy(ownerLang(), 'passport.proofLine', { url: proof })}`);
      }
    }
  }

  lines.push(TOP);
  return lines;
}
