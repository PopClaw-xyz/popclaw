import { beforeAll, describe, it, expect } from 'vitest';
import { renderPassport } from '../../../src/identity/passport-renderer.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S13 slice: renderPassport now renders in `ownerLang()` (default en-US)
// instead of hardcoded zh — pin zh-CN so the existing assertions stay meaningful.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

describe('renderPassport', () => {
  it('renders header + verified block for N > 0', () => {
    const lines = renderPassport({
      popclawId: 'Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2',
      sigil: '5R57pV',
      handle: 'elonmusk',
      profiles: [
        {
          platform: 'x',
          handle: 'elonmusk',
          verified_at: '2026-04-12T00:00:00Z',
          profile_url: 'https://x.com/elonmusk',
        },
        {
          platform: 'github',
          handle: 'elonmusk',
          verified_at: '2026-04-20T00:00:00Z',
          profile_url: 'https://github.com/elonmusk',
        },
      ],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('  popclaw  @elonmusk#5R57pV');
    expect(joined).toContain('Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2');
    // ADR-0032: the sigil is a PATH segment. The `#` form this line used to
    // pin is a fragment — it never reaches a server, so it yields no link
    // preview and no server-side disambiguation, and it was the one address
    // on the plugin side that did not come from `profileUrl`.
    expect(joined).toContain('popclaw.me/elonmusk/5R57pV');
    expect(joined).not.toContain('popclaw.me/elonmusk#5R57pV');
    expect(joined).toContain('已认证 (2):');
    expect(joined).toContain('🐦 X');
    expect(joined).toContain('@elonmusk');
    expect(joined).toContain('verified 2026-04-12');
    expect(joined).toContain('https://x.com/elonmusk');
    expect(joined).toContain('🐙 GitHub');
  });

  // 认证的价值在于"你能自己去核"。ranger 说了不算，
  // 那条公开的回帖才算，所以它的链接必须摆出来（ADR-0034 proof_url）。
  it('shows the proof link so anyone can go check the post themselves', () => {
    const lines = renderPassport({
      popclawId: 'somelongbase58id',
      sigil: '5R57pV',
      handle: 'rayfeld',
      profiles: [
        {
          platform: 'x',
          handle: 'rayfeld',
          verified_at: '2026-08-24T00:00:00Z',
          profile_url: 'https://x.com/rayfeld',
          proof_url: 'https://x.com/rayfeld/status/1234567890',
        },
      ],
    }).join('\n');
    expect(lines).toContain('https://x.com/rayfeld/status/1234567890');
    expect(lines).toContain('https://x.com/rayfeld'); // 账号链接还在，proof 是**另加**一行
    // 链接永远显示、从不探活，所以这一行在"帖还在"和
    // "帖已被作者删掉"两种世界里都必须为真 —— 删帖是允许的，✓ 不跟着掉。
    expect(lines).toContain('删帖不撤销认证');
  });

  // 021 之前的老认证、以及让 ranger 自己去搜帖的申请人，proof_url 是空串。
  // 诚实降级：宁可不说，也绝不拿 (platform, handle) 拼一个指向账号的假 proof。
  it('says nothing about proof when none is on file', () => {
    const lines = renderPassport({
      popclawId: 'somelongbase58id',
      sigil: '5R57pV',
      handle: 'oldtimer',
      profiles: [
        {
          platform: 'x',
          handle: 'oldtimer',
          verified_at: '2026-04-12T00:00:00Z',
          profile_url: 'https://x.com/oldtimer',
          proof_url: '',
        },
      ],
    }).join('\n');
    expect(lines).toContain('https://x.com/oldtimer');
    expect(lines).not.toMatch(/proof|凭证|自行核/i);
  });

  it('omits 已认证 block when no verified profiles', () => {
    const lines = renderPassport({
      popclawId: 'somelongbase58id',
      sigil: 'abc123',
      handle: 'newuser',
      profiles: [],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('  popclaw  @newuser#abc123');
    expect(joined).not.toContain('已认证');
    expect(joined).not.toContain('─────────────');
  });

  it('preserves input order (caller passes verified_at ASC)', () => {
    const lines = renderPassport({
      popclawId: 'id',
      sigil: 'sss123',
      handle: 'h',
      profiles: [
        {
          platform: 'github',
          handle: 'h',
          verified_at: '2026-01-01T00:00:00Z',
          profile_url: 'https://github.com/h',
        },
        {
          platform: 'x',
          handle: 'h',
          verified_at: '2026-02-01T00:00:00Z',
          profile_url: 'https://x.com/h',
        },
      ],
    });
    const joined = lines.join('\n');
    const githubIdx = joined.indexOf('🐙 GitHub');
    const xIdx = joined.indexOf('🐦 X');
    expect(githubIdx).toBeGreaterThan(0);
    expect(xIdx).toBeGreaterThan(githubIdx);
  });

  it('shows ? emoji + (no canonical URL) for unmapped platform', () => {
    const lines = renderPassport({
      popclawId: 'id',
      sigil: 'sss123',
      handle: 'h',
      profiles: [
        {
          platform: 'mastodon',
          handle: 'alice@e.social',
          verified_at: '2026-01-01T00:00:00Z',
          profile_url: '',
        },
      ],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('❓ mastodon');
    expect(joined).toContain('@alice@e.social');
    expect(joined).toContain('(no canonical URL)');
  });

  it('omits verified date when verified_at is null', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'sss123', handle: 'h',
      profiles: [
        { platform: 'x', handle: 'h', verified_at: null, profile_url: 'https://x.com/h' },
      ],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('🐦 X');
    expect(joined).toContain('@h');
    expect(joined).not.toContain('verified');
  });

  it('excludes the popclaw-native anchor row from 已认证 (spec §4.6)', () => {
    const lines = renderPassport({
      popclawId: 'Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2',
      sigil: '9e27fb',
      handle: 'elonmusk',
      profiles: [
        // popclaw anchor row is the by-handle lookup key — must NOT render.
        { platform: 'popclaw', handle: 'elonmusk', verified_at: '2026-04-10T00:00:00Z', profile_url: '' },
        { platform: 'x', handle: 'elonmusk', verified_at: '2026-04-12T00:00:00Z', profile_url: 'https://x.com/elonmusk' },
        { platform: 'github', handle: 'elonmusk', verified_at: '2026-04-20T00:00:00Z', profile_url: 'https://github.com/elonmusk' },
      ],
    });
    const joined = lines.join('\n');
    // Header still shows the popclaw-native handle.
    expect(joined).toContain('  popclaw  @elonmusk#9e27fb');
    // Count reflects the 2 external platforms, NOT 3.
    expect(joined).toContain('已认证 (2):');
    expect(joined).toContain('🐦 X');
    expect(joined).toContain('🐙 GitHub');
    // No leaked anchor row.
    expect(joined).not.toContain('❓ popclaw');
    expect(joined).not.toContain('(no canonical URL)');
  });

  it('omits 已认证 block entirely when only a popclaw anchor row exists', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'solo',
      profiles: [
        { platform: 'popclaw', handle: 'solo', verified_at: '2026-04-10T00:00:00Z', profile_url: '' },
      ],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('  popclaw  @solo#abc123');
    expect(joined).not.toContain('已认证');
  });

  it('shows the follower snapshot before the detailed verified date', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'elonmusk',
      profiles: [
        { platform: 'x', handle: 'elonmusk', verified_at: '2026-04-12T00:00:00Z', profile_url: 'https://x.com/elonmusk', follower_count: 1_300_000 },
      ],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('认证时粉丝数：约1.3m');
    expect(joined).toContain('verified 2026-04-12');
    expect(joined.indexOf('认证时粉丝数：约1.3m')).toBeLessThan(joined.indexOf('verified 2026-04-12'));
  });

  it('shows the follower snapshot without inventing a verified date when it is null', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'h',
      profiles: [{ platform: 'x', handle: 'h', verified_at: null, profile_url: '', follower_count: 67_000 }],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('认证时粉丝数：约67k');
    expect(joined).not.toContain('verified');
    expect(joined).not.toContain('·');
  });

  it('labels a historical zero follower snapshot as unconfirmed', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'h',
      profiles: [{ platform: 'x', handle: 'h', verified_at: '2026-04-12T00:00:00Z', profile_url: '', follower_count: 0 }],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('verified 2026-04-12');
    expect(joined).not.toContain('👥');
    expect(joined).toContain('认证时粉丝数：未确认');
  });

  it('renders the card block (nickname · role / intro / tags) between header and 已认证', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'elonmusk',
      card: { nickname: 'Elon', one_line_intro: '把人类变成跨行星物种。', taste_tags: ['space', 'ai'], role_persona: 'pioneer', location_hint: '', avatar_uri: '', declared_at: 0 },
      profiles: [{ platform: 'x', handle: 'elonmusk', verified_at: '2026-04-12T00:00:00Z', profile_url: 'https://x.com/elonmusk' }],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('Elon · 先锋');
    expect(joined).toContain('把人类变成跨行星物种。');
    expect(joined).toContain('🏷 space · ai');
    expect(joined.indexOf('Elon · 先锋')).toBeLessThan(joined.indexOf('已认证'));
  });

  it('renders the role label in the owner language (en owner gets "pioneer", not 先锋)', () => {
    setOwnerLang('en-US', 'config');
    try {
      const lines = renderPassport({
        popclawId: 'id', sigil: 'abc123', handle: 'elonmusk',
        card: { nickname: 'Elon', one_line_intro: '', taste_tags: [], role_persona: 'pioneer', location_hint: '', avatar_uri: '', declared_at: 0 },
        profiles: [],
      });
      expect(lines.join('\n')).toContain('Elon · pioneer');
    } finally {
      setOwnerLang('zh-CN', 'config');
    }
  });

  it('omits the card block entirely when card is null', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'h', card: null,
      profiles: [{ platform: 'x', handle: 'h', verified_at: null, profile_url: '' }],
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('🏷');
    expect(joined).toContain('🐦 X');
  });

  it('omits empty card lines (no intro / no tags / no role)', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'h',
      card: { nickname: 'Solo', one_line_intro: '', taste_tags: [], role_persona: '', location_hint: '', avatar_uri: '', declared_at: 0 },
      profiles: [],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('Solo');
    expect(joined).not.toContain(' · ');
    expect(joined).not.toContain('🏷');
  });

  it('omits the card block when nickname is whitespace-only', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'h',
      card: { nickname: '   ', one_line_intro: 'x', taste_tags: ['t'], role_persona: '', location_hint: '', avatar_uri: '', declared_at: 0 },
      profiles: [],
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('🏷'); // no card block at all
    expect(joined).not.toContain('x');  // intro not rendered
  });

  // ADR-0025 §3.2 — verified accounts must come from the proven lane (profiles
  // arg, sourced from verified_profiles via lore-house), NOT from the
  // self-declared card payload. A card with no matching proven profiles must
  // produce zero 已认证 entries; a proven profile must appear regardless of
  // what the card says.
  it('(ADR-0025 §3.2) 已认证 block is sourced from proven profiles, not from self-declared card', () => {
    // Card has no verified account info (correct: card is nickname/intro/tags
    // only). Proven lane provides the single X account.
    const lines = renderPassport({
      popclawId: 'Fo1Potk3v4qL45UmEDmnkRj2K5QEMctPKVAPjN9j1VS2',
      sigil: '5a57bf',
      handle: 'alice',
      card: {
        nickname: 'Alice',
        one_line_intro: '写诗的人',
        taste_tags: ['poetry', 'art'],
        role_persona: 'seeker',
        location_hint: 'Shanghai',
        avatar_uri: '',
        declared_at: 0,
      },
      profiles: [
        {
          platform: 'x',
          handle: 'alice_writes',
          verified_at: '2026-06-01T00:00:00Z',
          profile_url: 'https://x.com/alice_writes',
          follower_count: 8_500,
        },
      ],
    });
    const joined = lines.join('\n');

    // Proven lane account appears in 已认证 block.
    expect(joined).toContain('已认证 (1):');
    expect(joined).toContain('🐦 X');
    expect(joined).toContain('@alice_writes');
    expect(joined).toContain('https://x.com/alice_writes');
    expect(joined).toContain('verified 2026-06-01');

    // Self-declared card values appear ONLY in the card block (nickname/intro/tags),
    // NOT in the 已认证 section.
    expect(joined).toContain('Alice · 求知者');
    expect(joined).toContain('写诗的人');
    expect(joined).toContain('🏷 poetry · art');

    // The card block appears BEFORE the 已认证 block (layout order).
    expect(joined.indexOf('Alice · 求知者')).toBeLessThan(joined.indexOf('已认证'));
  });

  // house_follower_count (spec 2026-07-26): local per-house follower count,
  // rendered distinctly from — never summed with — external follower_count.
  it('renders 本坊 N 人关注 alongside an external follower_count, unmixed', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'elonmusk',
      houseFollowerCount: 12,
      profiles: [
        { platform: 'x', handle: 'elonmusk', verified_at: '2026-04-12T00:00:00Z', profile_url: 'https://x.com/elonmusk', follower_count: 3_400_000 },
      ],
    });
    const joined = lines.join('\n');
    // Local count rendered explicitly, on its own line.
    expect(joined).toContain('👥 本灯坊 12 人关注');
    // External snapshot remains distinct from the local House count.
    expect(joined).toContain('认证时粉丝数：约3.4m');
    // Never concatenated/summed into a single combined number.
    expect(joined).not.toContain('3400012');
    expect(joined).not.toContain('12 · 3.4m');
  });

  it('renders 本坊 0 人关注 explicitly (0 is a real signal, not "unknown")', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'newuser',
      houseFollowerCount: 0,
      profiles: [],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('👥 本灯坊 0 人关注');
  });

  // R17-D2: house_follower_count is how many people follow this person here.
  // The English line called it "following" — the opposite direction.
  it('labels the house follower count as followers in English, never "following"', () => {
    setOwnerLang('en', 'config');
    try {
      const joined = renderPassport({
        popclawId: 'id', sigil: 'abc123', handle: 'newuser',
        houseFollowerCount: 1,
        profiles: [],
      }).join('\n');
      expect(joined).toContain('👥 followed by 1 in this lore-house');
      expect(joined).not.toContain('following');
    } finally {
      setOwnerLang('zh-CN', 'config');
    }
  });

  it('omits the 本坊...人关注 line when houseFollowerCount is absent', () => {
    const lines = renderPassport({
      popclawId: 'id', sigil: 'abc123', handle: 'newuser',
      profiles: [],
    });
    const joined = lines.join('\n');
    expect(joined).not.toContain('本灯坊');
  });

  it('(ADR-0025 §3.2) empty proven profiles → no 已认证 block even when card is populated', () => {
    // If no accounts are proven, the card data alone cannot produce a 已认证
    // block — the endorsement is not forgeable by self-declaring it.
    const lines = renderPassport({
      popclawId: 'id',
      sigil: 'abc123',
      handle: 'bob',
      card: {
        nickname: 'Bob',
        one_line_intro: '只有名片，没有认证账号',
        taste_tags: ['music'],
        role_persona: '',
        location_hint: '',
        avatar_uri: '',
        declared_at: 0,
      },
      // proven lane: no verified external accounts
      profiles: [],
    });
    const joined = lines.join('\n');
    expect(joined).toContain('Bob');
    expect(joined).toContain('只有名片，没有认证账号');
    // Zero proven profiles → 已认证 block must be absent
    expect(joined).not.toContain('已认证');
  });
});
