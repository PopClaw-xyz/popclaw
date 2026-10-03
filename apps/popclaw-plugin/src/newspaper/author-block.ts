/**
 * Per-author header data for the newspaper (v2): avatar + name + followers +
 * clickable profile. Lets the agent render "WHO said this" at the front of each
 * item — the owner's core ask. Pure derivation from a ReadableFeedItem; no I/O.
 *
 * Avatar strategy: real photo via unavatar (`unavatar.io/<provider>/<handle>`);
 * no upstream provider (or no handle) → a monogram we draw ourselves, inline.
 *
 * The monogram used to be a `ui-avatars.com` url, and before that it was baked into
 * unavatar's own `?fallback=` (owner decision 2026-06-20). The `?fallback=` went in
 * slice I2 because the whole url had to be percent-encoded inside a query string and a
 * CJK display name double-encoded — 5 characters became 90 bytes, with avatars at 29%
 * of the materials section. **That accounting died with v0.2**: the materials carry no
 * avatar urls at all now, the renderer builds them. So the fallback comes back — as a
 * ~250-byte inline SVG, which needs no second third-party and, unlike a url, still
 * works when the network is the thing that failed.
 *
 * The real photo is still a remote url here. `newspaper/avatar-inline.ts` bakes it into
 * the page at publish time, so the reader makes no third-party request; this module
 * stays pure derivation, no I/O (P-003: we do not rehost, and nothing is stored here).
 */
import type { ReadableFeedItem } from '../ingress/world-feed-cache.js';
import { deriveSigil } from '../invite/sigil.js';
import { profileUrl as profileUrlOf } from '../lshow/sources/web-fallback.js';

/** popclaw platform → unavatar provider slug. Platforms not here (e.g. popclaw)
 * have no upstream avatar → monogram only. */
const UNAVATAR_PROVIDER: Record<string, string> = {
  x: 'twitter',
  twitter: 'twitter',
  youtube: 'youtube',
  instagram: 'instagram',
  tiktok: 'tiktok',
  github: 'github',
};

/** Muted, broadsheet-friendly tints for the monogram fallback (ui-avatars `background`,
 * hex without '#'). Picked deterministically per author so the same person keeps a
 * stable color. */
const TINTS = ['9b1c1c', '1a4d6e', '2e6e4d', '6e4d8e', '8a5a1e', '4a4a63', '6e2e4d'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * The stand-in face, drawn here rather than fetched: a tinted circle with the
 * person's first character in it, as a data URI of about 250 bytes.
 *
 * This used to be a `ui-avatars.com` url. Drawing it ourselves removes the second
 * third-party from the page, makes the fallback work with no network at all
 * (which is the whole point of a fallback), and costs less than the url did.
 */
export function monogramDataUri(label: string, seed: string): string {
  const tint = TINTS[hash(seed || label) % TINTS.length]!;
  // One character is enough at 40px, and taking it by code point keeps an emoji or
  // a surrogate pair whole instead of splitting it into mojibake.
  const ch = [...label][0] ?? '?';
  const glyph = ch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
    `<rect width="128" height="128" rx="64" fill="#${tint}"/>` +
    `<text x="64" y="64" fill="#fff" font-family="Georgia,serif" font-size="64" font-weight="700" ` +
    `text-anchor="middle" dominant-baseline="central">${glyph}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`;
}

export interface AuthorBlock {
  /** Display name (nickname → handle → verified-platform handle). '' when no attributable author. */
  name: string;
  /** Platform handle, no '@'. '' if unknown. */
  handle: string;
  /** popclaw sigil — short fingerprint of the author's popclaw_id, our identity marker. '' if no author. */
  sigil: string;
  /** Avatar image URL (real photo, else a monogram). '' when there's no author. */
  avatarUrl: string;
  /**
   * The profile page the card header links to — **always popclaw.me**
   * (ADR-0032 `/<name>/<sigil>`; sigil is a **path segment**, not a `#`
   * fragment — fragments never reach the server, breaking both OG cards and 404s).
   * Name segment uses the handle, or the name if no handle
   * (lore-house `/v1/resolve` matches on name ∪ verified handle, ADR-0028).
   * '' = can't be built (no popclaw_id → no sigil, or neither a name nor a handle) → no link given.
   */
  profileUrl: string;
  /**
   * The person's profile page on the verified platform (`x.com/…`). **Not** the
   * card header link — only used as a "view original" source-return exit. '' = none.
   */
  platformProfileUrl: string;
  /** Follower count snapshot; 0 = unknown (hide). */
  followerCount: number;
  /**
   * Whether the author proved this account themselves (invite flow: they posted
   * their sigil and the house reached quorum). **Never true for a mirror post**:
   * a mirrored author's `actor_verified` row exists so lore-house can attribute
   * the mirror at all (`mirror_attribution.rs` resolves origin handle →
   * popclaw_id through `verified_profiles`), so reading it as a credential
   * marked every single mirrored item ✓ — 239/254 on the 2026-08-26 issue, the
   * other 15 being items with no author at all. A tick that is always on says
   * nothing. Mirrors of a genuinely-verified citizen lose their ✓ too: the wire
   * carries no "this binding was earned" bit, and guessing is worse than an
   * honest omission (issue #476).
   */
  verified: boolean;
}

const EMPTY: AuthorBlock = {
  name: '',
  handle: '',
  sigil: '',
  avatarUrl: '',
  profileUrl: '',
  platformProfileUrl: '',
  followerCount: 0,
  verified: false,
};

/** Build the author header data. Returns an all-empty block for unattributed items
 * (no name/handle) so the renderer omits the author header instead of inventing one
 * (fidelity iron rule: never fabricate an author). */
export function buildAuthorBlock(
  item: ReadableFeedItem,
  webBaseUrl: string,
  /** The owner. Their own rows carry the handle the feed indexed them under —
   *  often the registration-time auto name — so their byline and address use
   *  the name they declared instead (the same rule status follows). */
  self?: { readonly popclawId: string; readonly nickname: string },
): AuthorBlock {
  const verifiedList = item.actorVerified ?? [];
  // Author source: top-level handle if present, else the primary verified-platform
  // binding. Sim-persona mirror posts carry their real X identity (handle + real
  // avatar) in actor_verified even when the popclaw-handle column is empty — so we
  // can still attribute "SpaceX / WIRED / …" with a real photo.
  const vPrimary =
    (item.handle ? verifiedList.find((x) => x.platform === item.platform) : undefined) ??
    verifiedList.find((x) => x.handle) ??
    verifiedList[0];
  const handle = item.handle || vPrimary?.handle || '';
  const ownName =
    self && item.authorPopclawId && item.authorPopclawId === self.popclawId ? self.nickname.trim() : '';
  const name = ownName || item.actorNickname || handle;
  if (!name && !handle) return EMPTY;

  // The platform that owns this author (avatar provider + profile URL): the verified
  // binding's platform when we fell back to it, else the item's own platform.
  const authorPlatform = item.handle ? item.platform : vPrimary?.platform || item.platform;
  const followerCount = vPrimary?.followerCount ?? 0;
  const sigil = item.authorPopclawId ? deriveSigil(item.authorPopclawId) : '';

  const mono = monogramDataUri(name || handle || '?', name || handle || item.authorPopclawId);
  const provider = UNAVATAR_PROVIDER[authorPlatform];
  const avatarUrl =
    provider && handle ? `https://unavatar.io/${provider}/${encodeURIComponent(handle)}` : mono;

  // Card header profile: popclaw.me's `/<name>/<sigil>`. No link if the sigil can't be built (no popclaw_id).
  const nameSeg = ownName || handle || name;
  const profileUrl = sigil && nameSeg ? profileUrlOf(nameSeg, sigil, webBaseUrl) : '';

  // Platform profile: use whatever the verified binding gives us, else derive by platform. The popclaw lore-house itself has no "platform profile" of its own.
  let platformProfileUrl = vPrimary?.profileUrl ?? '';
  if (!platformProfileUrl && handle) {
    platformProfileUrl =
      authorPlatform === 'x' ? `https://x.com/${handle}`
      : authorPlatform === 'youtube' ? `https://youtube.com/@${handle}`
      : authorPlatform === 'instagram' ? `https://instagram.com/${handle}`
      : authorPlatform === 'github' ? `https://github.com/${handle}`
      : '';
  }

  return {
    name, handle, sigil, avatarUrl, profileUrl, platformProfileUrl, followerCount,
    // A non-empty originalUrl IS Origin.url (ADR-0025) — i.e. this item is a
    // mirror of a post that lives on another platform. See `verified` above.
    verified: verifiedList.length > 0 && !item.originalUrl,
  };
}
