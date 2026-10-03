/**
 * Central mapping from platform key → emoji. Shared between the Passport
 * renderer (status / profile) and the feed footer line renderer
 * (popclaw-feed). Adding a new platform: add a key here AND the matching
 * Rust match arm in apps/lore-house/src/projections/profile_url.rs.
 *
 * Unmapped platforms get '?' (questionmark) — they're shown but visually
 * flagged as "we don't know the canonical icon."
 */

const PLATFORM_EMOJI: Record<string, string> = {
  x: '🐦',
  twitter: '🐦',
  instagram: '📷',
  github: '🐙',
  youtube: '▶️',
  tiktok: '🎵',
  bluesky: '🦋',
  // popclaw-native (matches popclaw-feed.ts's local PLATFORM_EMOJI map);
  // S4.1-T3: world tools + act2 summary lines render native posts with 📜.
  popclaw: '📜',
};

export function emojiFor(platform: string): string {
  return PLATFORM_EMOJI[platform] ?? '❓';
}
