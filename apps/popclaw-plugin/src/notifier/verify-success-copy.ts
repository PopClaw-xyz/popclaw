import { readableUrl } from '../lshow/sources/web-fallback.js';
import { renderCopy, type Lang } from '../lexicon/index.js';

/** Shared success presentation for chat results and verified-account notices. */
export function verifySuccessCopy(lang: Lang, platform: string, handle: string, details: { followerCount?: unknown; profileUrl?: unknown } = {}): string {
  const label = /^(x|twitter)$/i.test(platform) ? 'X' : platform;
  const parts = [renderCopy(lang, 'notify.verifyDone.main', { platform: label, handle: handle.replace(/^@/, '') })];
  const followers = Number(details.followerCount ?? 0);
  if (Number.isFinite(followers) && followers > 0) parts.push(renderCopy(lang, 'notify.verifyDone.followers', { platform: label, followers: String(followers) }));
  if (typeof details.profileUrl === 'string' && details.profileUrl) parts.push(renderCopy(lang, 'notify.verifyDone.profile', { profileUrl: readableUrl(details.profileUrl) }));
  return parts.join('\n\n');
}
