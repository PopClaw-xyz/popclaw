import { describe, it, expect } from 'vitest';
import { SIGIL_LEN, normalizeSigilInput } from '@popclaw/algorithms';
import { buildAuthorBlock } from '../../../src/newspaper/author-block';
import type { ReadableFeedItem } from '../../../src/ingress/world-feed-cache';

/** A derived sigil round-trips through the resolve-input alphabet unchanged. */
function expectValidSigil(s: string): void {
  expect(s).toHaveLength(SIGIL_LEN);
  expect(normalizeSigilInput(s)).toBe(s);
}

function item(over: Partial<ReadableFeedItem>): ReadableFeedItem {
  return {
    platform: 'x', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 1,
    authorPopclawId: 'AUTHOR', handle: '', originalUrl: '', textPreview: '',
    body: '', media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
    actorNickname: '', actorVerified: [], kind: 'post',
    ...over,
  };
}

describe('buildAuthorBlock', () => {
  it('I2: X author = bare unavatar URL — no `?fallback=` monogram baked in any more', () => {
    const b = buildAuthorBlock(item({ platform: 'x', handle: 'elonmusk', actorNickname: 'Elon Musk' }), 'http://localhost:3000');
    expect(b.name).toBe('Elon Musk');
    expect(b.handle).toBe('elonmusk');
    expect(b.avatarUrl).toBe('https://unavatar.io/twitter/elonmusk');
    expect(b.avatarUrl).not.toContain('fallback='); // The template's onerror now hides the failed image as fallback.
    expectValidSigil(b.sigil);                       // popclaw sigil derived
  });

  it('I2: 中文名不再被双重百分号编码撑爆（60 条素材里头像曾占 29%）', () => {
    const cjk = buildAuthorBlock(item({ platform: 'x', handle: 'cangwu', actorNickname: '苍梧阁大学士' }), 'http://localhost:3000');
    expect(cjk.avatarUrl.length).toBeLessThan(60);
    // Platforms unknown to the provider use our own letter tile: inline SVG rather than another third party.
    // It still renders offline, which is when a fallback is actually needed.
    const mono = buildAuthorBlock(item({ platform: 'popclaw', handle: 'x', actorNickname: '苍梧' }), 'http://localhost:3000');
    expect(mono.avatarUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(mono.avatarUrl).not.toContain('unavatar.io');
    expect(mono.avatarUrl).not.toContain('ui-avatars.com');
    const svg = Buffer.from(mono.avatarUrl.split(',')[1]!, 'base64').toString('utf-8');
    expect(svg).toContain('>苍<'); // Take the first code point so emoji and surrogate pairs are not split.
    expect(mono.avatarUrl.length).toBeLessThan(600);
  });

  it('falls back to actor_verified for author + real avatar when the handle column is empty (sim-persona mirror)', () => {
    const b = buildAuthorBlock(item({
      platform: 'popclaw', handle: '', actorNickname: '',
      actorVerified: [{ platform: 'x', handle: 'SpaceX', profileUrl: '', followerCount: 0 }],
    }), 'http://localhost:3000');
    expect(b.name).toBe('SpaceX');
    expect(b.handle).toBe('SpaceX');
    expect(b.avatarUrl).toContain('https://unavatar.io/twitter/SpaceX'); // real X avatar via the verified binding
    expect(b.platformProfileUrl).toBe('https://x.com/SpaceX');
    expect(b.verified).toBe(true);
    expectValidSigil(b.sigil);
  });

  it('uses the verified profile_url + follower_count when present', () => {
    const b = buildAuthorBlock(item({
      platform: 'x', handle: 'elonmusk',
      actorVerified: [{ platform: 'x', handle: 'elonmusk', profileUrl: 'https://x.com/elonmusk', followerCount: 21000000 }],
    }), 'http://localhost:3000');
    expect(b.platformProfileUrl).toBe('https://x.com/elonmusk');
    expect(b.followerCount).toBe(21000000);
    expect(b.verified).toBe(true);
  });

  it('derives the platform profile URL when there is no verified binding', () => {
    const b = buildAuthorBlock(item({ platform: 'x', handle: 'someone' }), 'http://localhost:3000');
    expect(b.platformProfileUrl).toBe('https://x.com/someone');
    expect(b.verified).toBe(false);
  });

  it('popclaw-native author: monogram only (no unavatar) + popclaw.me-style profile', () => {
    const b = buildAuthorBlock(item({ platform: 'popclaw', handle: 'blackfeather' }), 'http://localhost:3000');
    expect(b.avatarUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(b.avatarUrl).not.toContain('unavatar');
    // A popclaw profile carries the sigil in a PATH segment (ADR-0032 `/<nickname>/<sigil>`).
    expect(b.profileUrl).toMatch(new RegExp(`^http://localhost:3000/blackfeather/.{${SIGIL_LEN}}$`));
  });

  it('unattributed item (no name/handle) → empty block, no fabricated avatar/author', () => {
    const b = buildAuthorBlock(item({ handle: '', actorNickname: '' }), 'http://localhost:3000');
    expect(b).toEqual({
      name: '', handle: '', sigil: '', avatarUrl: '', profileUrl: '', platformProfileUrl: '',
      followerCount: 0, verified: false,
    });
  });

  // Issue #476: a checkmark denotes real verification, never a synthetic attribution binding.

  it('#476: 镜像帖不打 ✓ —— actor_verified 是灯坊为归属造的绑定,不是本人验过的凭据', () => {
    const b = buildAuthorBlock(item({
      platform: 'popclaw', handle: 'TheEconomist', originalUrl: 'https://x.com/TheEconomist/status/1',
      actorVerified: [{ platform: 'x', handle: 'TheEconomist', profileUrl: 'https://x.com/TheEconomist', followerCount: 0 }],
    }), 'http://localhost:3000');
    // Real-device issue on 2026-08-26: 239/254 were true; only authorless entries were false, providing no distinction.
    expect(b.verified).toBe(false);
    expect(b.handle).toBe('TheEconomist'); // Attribution stays the same but no longer masquerades as verification.
  });

  it('#476: 本坊原生帖仍认 ✓ —— 那条绑定是本人走邀约流程验出来的', () => {
    const b = buildAuthorBlock(item({
      platform: 'popclaw', handle: 'blackfeather', originalUrl: '',
      actorVerified: [{ platform: 'x', handle: 'blackfeather_ai', profileUrl: 'https://x.com/blackfeather_ai', followerCount: 30281 }],
    }), 'http://localhost:3000');
    expect(b.verified).toBe(true);
  });

  // E2 (ADR-0032): all card-header home links use popclaw.me `/<nickname>/<sigil>`; platform home links have a separate slot.

  it('E2: 镜像帖的卡头主页是 popclaw.me 路径段,x.com 只作平台主页', () => {
    const b = buildAuthorBlock(item({ platform: 'x', handle: 'elonmusk', actorNickname: 'Elon Musk' }), 'https://popclaw.me/');
    expect(b.profileUrl).toBe(`https://popclaw.me/elonmusk/${b.sigil}`); // Path segment, not #sigil.
    expect(b.profileUrl).not.toContain('#');
    expect(b.platformProfileUrl).toBe('https://x.com/elonmusk');
  });

  it('E2: 没有 handle 只有名号 → 走名号路径（灯坊 /v1/resolve 认名号,ADR-0028）', () => {
    const b = buildAuthorBlock(item({ platform: 'popclaw', handle: '', actorNickname: 'Blackfeather' }), 'https://popclaw.me');
    expect(b.profileUrl).toBe(`https://popclaw.me/${encodeURIComponent('Blackfeather')}/${b.sigil}`);
    expect(b.platformProfileUrl).toBe(''); // The local popclaw house has no platform homepage.
  });

  // The feed stamps the owner's rows with the handle they had when indexed —
  // the registration-time auto name — so the owner's own byline used to link
  // to `/ranger-xxxxxx/<sigil>` after a rename. Same rule as status.
  it("owner's own post: byline name and address carry the declared name", () => {
    const b = buildAuthorBlock(
      item({ platform: 'popclaw', handle: 'ranger-3gkVcd', actorNickname: 'ranger-3gkVcd', authorPopclawId: 'ME' }),
      'https://popclaw.me',
      { popclawId: 'ME', nickname: 'CanaryMe-26e2' },
    );
    expect(b.name).toBe('CanaryMe-26e2');
    expect(b.profileUrl).toBe(`https://popclaw.me/CanaryMe-26e2/${b.sigil}`);
  });

  it("someone else's post keeps the feed handle in the address", () => {
    const b = buildAuthorBlock(
      item({ platform: 'popclaw', handle: 'cangwu', actorNickname: '苍梧居士', authorPopclawId: 'PEER' }),
      'https://popclaw.me',
      { popclawId: 'ME', nickname: 'CanaryMe-26e2' },
    );
    expect(b.name).toBe('苍梧居士');
    expect(b.profileUrl).toBe(`https://popclaw.me/cangwu/${b.sigil}`);
  });

  it('E2: 没有 popclaw_id（拼不出印信）→ 不给 popclaw.me 主页,绝不自拼', () => {
    const b = buildAuthorBlock(item({ platform: 'x', handle: 'someone', authorPopclawId: '' }), 'https://popclaw.me');
    expect(b.profileUrl).toBe('');
    expect(b.platformProfileUrl).toBe('https://x.com/someone');
  });
});
