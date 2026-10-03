import { describe, it, expect } from 'vitest';
import { emojiFor } from '../../../src/identity/platform-emoji.js';

describe('emojiFor', () => {
  it('maps known platforms to their emojis', () => {
    expect(emojiFor('x')).toBe('🐦');
    expect(emojiFor('twitter')).toBe('🐦');
    expect(emojiFor('instagram')).toBe('📷');
    expect(emojiFor('github')).toBe('🐙');
    expect(emojiFor('youtube')).toBe('▶️');
    expect(emojiFor('tiktok')).toBe('🎵');
    expect(emojiFor('bluesky')).toBe('🦋');
    // S4.1-T3: popclaw-native mapped (matches popclaw-feed's local map).
    expect(emojiFor('popclaw')).toBe('📜');
  });

  it('returns ? for unmapped platforms', () => {
    expect(emojiFor('mastodon')).toBe('❓');
    expect(emojiFor('')).toBe('❓');
  });
});
