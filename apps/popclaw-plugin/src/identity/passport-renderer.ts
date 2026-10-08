/** Namecard presentation: identity and account snapshots first, complete
 * public evidence afterwards. Status reuses the per-account summary directly.
 */

import { mapVerifiedProfiles, renderVerifiedProfileSummary, platformLabel, snapshotText, safeAvatarUrl, type VerifiedProfileInput } from './profile-snapshot.js';
import { lexiconFor, renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';
import { timeContext } from '../time/time-context.js';
import { profileLinkText } from '../lshow/sources/web-fallback.js';

export type { VerifiedProfileInput } from './profile-snapshot.js';
export { platformLabel } from './profile-snapshot.js';

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

export interface NamecardDetails {
  readonly popclaw_id: string;
  readonly sigil: string;
  readonly nickname: string;
  readonly house_follower_count: number | null;
  readonly card: ProfileCardInput | null;
  readonly profiles: VerifiedProfileInput[];
}

export function namecardDetails(input: PassportInput): NamecardDetails {
  return {popclaw_id: input.popclawId, sigil: input.sigil, nickname: input.handle,
    house_follower_count: input.houseFollowerCount ?? null,
    card: input.card ?? null, profiles: mapVerifiedProfiles(input.profiles)};
}

export function renderPassport(input: PassportInput): string[] {
  const lang = ownerLang();
  const lines: string[] = [TOP, `  popclaw  ${input.handle ? `@${snapshotText(input.handle)}` : ''}#${snapshotText(input.sigil)}`];
  const card = input.card;
  const nick = card?.nickname?.trim() ?? '';
  if (card && nick) {
    const role = card.role_persona ? roleLabelFor(card.role_persona) : '';
    lines.push(role ? `  ${snapshotText(nick)} · ${role}` : `  ${snapshotText(nick)}`);
    if (card.one_line_intro?.trim()) lines.push(`  ${snapshotText(card.one_line_intro)}`);
    if (card.taste_tags?.length) lines.push(`  🏷 ${card.taste_tags.map(t => snapshotText(t)).join(' · ')}`);
  }
  const displayed = mapVerifiedProfiles(input.profiles).filter(p => p.platform !== 'popclaw');
  if (displayed.length) {
    lines.push(MIDDLE, renderCopy(lang, 'passport.verifiedHeader', {count: String(displayed.length)}));
    for (const p of displayed) lines.push(...renderVerifiedProfileSummary(p, lang).map(line => `  ${line}`));
  }
  if (input.houseFollowerCount !== undefined && input.houseFollowerCount !== null) {
    lines.push(renderCopy(lang, 'passport.houseFollowerCount', {count: String(input.houseFollowerCount)}));
  }
  // Full source material follows the readable card; no fake expansion controls.
  lines.push('', renderCopy(lang, 'passport.detailsHeader'));
  lines.push(`  popclaw_id  ${snapshotText(input.popclawId)}`);
  lines.push(`  popclaw.me  ${profileLinkText(input.handle || input.popclawId, input.sigil, input.webBaseUrl)}`);
  for (const p of displayed) {
    lines.push(`  ${snapshotText(platformLabel(p.platform))} @${snapshotText(p.handle)} ${formatVerifiedDate(p.verified_at)}`.trimEnd());
    lines.push(`  ${p.profile_url || '(no canonical URL)'}`);
    if (p.bio?.trim()) lines.push(renderCopy(lang, 'passport.snapshotBioFull', {platform: snapshotText(platformLabel(p.platform)), bio: snapshotText(p.bio)}));
    const avatar = safeAvatarUrl(p.avatar_url);
    if (avatar) lines.push(renderCopy(lang, 'passport.snapshotAvatar', {url: avatar}));
    if (p.proof_url) lines.push(renderCopy(lang, 'passport.proofLine', {url: p.proof_url}));
  }
  lines.push(TOP);
  return lines;
}
