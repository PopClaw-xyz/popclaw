/** Public House snapshot mapping and short per-account presentation.
 * Reading a namecard never refreshes an external provider.
 */
import { formatFollowerCount } from './format-count.js';
import { emojiFor } from './platform-emoji.js';
import { renderCopy, type Lang } from '../lexicon/index.js';

export interface VerifiedProfileInput {
  readonly platform: string;
  readonly handle: string;
  readonly verified_at: string | null | undefined;
  readonly source_task_id?: string;
  readonly profile_url?: string | null;
  readonly proof_url?: string | null;
  readonly follower_count?: number | null;
  /** Explicit House evidence presence. Historical zero alone is ambiguous. */
  readonly follower_count_observed?: boolean;
  readonly avatar_url?: string;
  readonly bio?: string;
}

const text = (v: unknown): string => typeof v === 'string' ? v : '';
export function safeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || /\s/u.test(value) || [...value].some(char => char <= '\u001f' || char === '\u007f')) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

export function mapVerifiedProfiles(value: unknown): VerifiedProfileInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p: unknown) => {
    if (!p || typeof p !== 'object') return [];
    const row = p as Record<string, unknown>;
    const platform = text(row.platform), handle = text(row.handle);
    if (!platform || !handle) return [];
    const n = row.follower_count;
    const avatar = safeAvatarUrl(row.avatar_url);
    return [{
      platform, handle, verified_at: text(row.verified_at),
      ...(typeof row.source_task_id === 'string' ? {source_task_id: row.source_task_id} : {}),
      ...(typeof row.profile_url === 'string' ? {profile_url: row.profile_url} : {}),
      ...(typeof row.proof_url === 'string' ? {proof_url: row.proof_url} : {}),
      follower_count: typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null,
      ...(typeof row.follower_count_observed === 'boolean' ? {follower_count_observed: row.follower_count_observed} : {}),
      ...(avatar ? {avatar_url: avatar} : {}),
      bio: text(row.bio),
    }];
  });
}

/** Public strings are data, never Markdown layout or executable HTML. */
export function snapshotText(value: string, limit?: number): string {
  const flat = value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  const shown = limit && chars.length > limit ? chars.slice(0, limit).join('') + '…' : flat;
  return shown.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*{}[\]()#!|]/g, '\\$&');
}

export function platformLabel(platform: string): string {
  switch (platform) {
    case 'x': case 'twitter': return 'X';
    case 'instagram': return 'Instagram';
    case 'github': return 'GitHub';
    case 'youtube': return 'YouTube';
    case 'tiktok': return 'TikTok';
    case 'bluesky': return 'Bluesky';
    default: return platform;
  }
}

export function renderVerifiedProfileSummary(p: VerifiedProfileInput, lang: Lang, prefix = emojiFor(p.platform)): string[] {
  const label = snapshotText(platformLabel(p.platform));
  const n = p.follower_count;
  const valid = typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const count = valid && n > 0 ? renderCopy(lang, 'passport.snapshotApprox', {count: formatFollowerCount(n)})
    : valid && n === 0 && p.follower_count_observed === true ? '0'
    : renderCopy(lang, 'passport.snapshotUnconfirmed');
  const lines = [`${prefix} ${label} @${snapshotText(p.handle)}`, renderCopy(lang, 'passport.snapshotFollowers', {count})];
  if (p.bio?.trim()) lines.push(renderCopy(lang, 'passport.snapshotBio', {platform: label, bio: snapshotText(p.bio, 120)}));
  return lines;
}
