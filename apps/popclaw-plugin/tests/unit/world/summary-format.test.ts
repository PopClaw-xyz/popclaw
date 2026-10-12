/**
 * S4.1-T1: shared world-preview line renderer (summary-format) tests.
 *
 * formatHotPostLine assertions moved from act2-cards.test.ts: act2 cards and world tools
 * share the same implementation and conventions. Line length increased from 60 to 120
 * after owner readability feedback; the server's 200-character preview limit leaves room.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  formatHotPostLine,
  formatNotableAuthorLine,
  formatWorldStateLine,
  formatNotablePersonLine,
  formatFollowers,
  platformLabel,
  LINE_PREVIEW_CHARS,
  NOTABLE_PEOPLE_CAP,
} from '../../../src/world/summary-format.js';
import type { AuthorAggregate } from '../../../src/world/notable-authors.js';
import type { NotablePerson, WorldState } from '../../../src/world/world-summary-client.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S3 pilot: these renderers now default to `ownerLang()` (S1 process-wide
// singleton). Pin zh-CN so this file's pre-lexicon assertions stay
// byte-for-byte unchanged (same fix as status.test.ts / mcp-notice.test.ts).
// The dedicated en-lane block at the bottom passes `lang: 'en'` explicitly.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

describe('formatHotPostLine（规格 2，S4.1 行长 120）', () => {
  it('<n>. [<昵称>] <preview> · <平台徽章> · <回应数>回应', () => {
    const line = formatHotPostLine(3, {
      nickname: 'mrbeast',
      bodyPreview: 'Last to leave wins $100k',
      platform: 'youtube',
      replyCount: 10,
    });
    expect(line).toBe('3. [mrbeast] Last to leave wins $100k · ▶️ · 10回应');
  });

  it('行长上限 120 字', () => {
    expect(LINE_PREVIEW_CHARS).toBe(120);
  });

  it('preview 80 字不再截断（旧 60 上限已放宽）', () => {
    const line = formatHotPostLine(1, {
      nickname: 'n',
      bodyPreview: '很'.repeat(80),
      platform: 'x',
      replyCount: 0,
    });
    expect(line).toContain('很'.repeat(80));
    expect(line).not.toContain('…');
  });

  it('preview 截 120 字 + 省略号 + 折叠换行', () => {
    const line = formatHotPostLine(1, {
      nickname: 'n',
      bodyPreview: `${'很'.repeat(150)}\n第二行`,
      platform: 'x',
      replyCount: 0,
    });
    expect(line).not.toContain('\n');
    expect(line).toContain(`${'很'.repeat(120)}…`);
    expect(line).not.toContain('很'.repeat(121));
  });
});

describe('formatNotableAuthorLine（规格 2，自 act2-cards 抽出）', () => {
  it('多平台标注缝合身份', () => {
    const a: AuthorAggregate = {
      popclawId: 'AAAA',
      nickname: 'mrbeast',
      platforms: ['instagram', 'tiktok', 'x', 'youtube'],
      postCount: 9,
    };
    expect(formatNotableAuthorLine(a)).toBe(
      '  mrbeast — 活跃于 IG/TikTok/X/YT（缝合身份）',
    );
  });

  it('单平台不标缝合', () => {
    const a: AuthorAggregate = {
      popclawId: 'CCCC',
      nickname: 'soloist',
      platforms: ['x'],
      postCount: 3,
    };
    expect(formatNotableAuthorLine(a)).toBe('  soloist — 活跃于 X');
  });
});

describe('formatFollowers（粉丝数中文万/亿缩写，S4.2-T3）', () => {
  it('亿级：220,000,000 → 2.2亿', () => {
    expect(formatFollowers(220_000_000)).toBe('2.2亿');
  });

  it('整亿不带小数：100,000,000 → 1亿', () => {
    expect(formatFollowers(100_000_000)).toBe('1亿');
  });

  it('万级整数：18,000,000 → 1800万', () => {
    expect(formatFollowers(18_000_000)).toBe('1800万');
  });

  it('万级一位小数：15,000 → 1.5万', () => {
    expect(formatFollowers(15_000)).toBe('1.5万');
  });

  it('万级四舍五入到一位小数：1,234,567 → 123.5万', () => {
    expect(formatFollowers(1_234_567)).toBe('123.5万');
  });

  it('万以下原样：9999 → 9999；0 → 0', () => {
    expect(formatFollowers(9_999)).toBe('9999');
    expect(formatFollowers(0)).toBe('0');
  });

  it('恰好一万：10,000 → 1万', () => {
    expect(formatFollowers(10_000)).toBe('1万');
  });
});

describe('formatWorldStateLine（江湖状态行，S4.2-T3）', () => {
  it('江湖：<身份> 身份 · <认证> 认证账号 · <名片> 名片 · 原生帖 <N>', () => {
    const ws: WorldState = {
      identities_total: 56,
      namecards_total: 2,
      verified_accounts_total: 8,
      native_posts_total: 7,
    };
    expect(formatWorldStateLine(ws)).toBe(
      '江湖：56 身份 · 8 认证账号 · 2 名片 · 原生帖 7',
    );
  });
});

describe('formatNotablePersonLine（大名鼎鼎一行，S4.2-T3）', () => {
  it('多账号：<昵称> ✓认证 — X @handle 2.2亿粉 · IG @handle 1800万', () => {
    const p: NotablePerson = {
      popclaw_id: 'ElonPopclawId',
      nickname: 'Elon Musk',
      accounts: [
        { platform: 'x', handle: 'elonmusk', follower_count: 220_000_000 },
        { platform: 'instagram', handle: 'elonmusk', follower_count: 18_000_000 },
      ],
      followers_total: 238_000_000,
    };
    expect(formatNotablePersonLine(p)).toBe(
      '  Elon Musk ✓认证 — X @elonmusk 2.2亿粉 · IG @elonmusk 1800万',
    );
  });

  it('单账号：粉字后缀仍在首账号', () => {
    const p: NotablePerson = {
      popclaw_id: 'PaulGPopclawId',
      nickname: 'paulg',
      accounts: [{ platform: 'x', handle: 'paulg', follower_count: 1_500_000 }],
      followers_total: 1_500_000,
    };
    expect(formatNotablePersonLine(p)).toBe('  paulg ✓认证 — X @paulg 150万粉');
  });

  it('零账号（防御性）：仅昵称 + ✓认证，不渲染空破折号', () => {
    const p: NotablePerson = {
      popclaw_id: 'GhostPopclawId',
      nickname: 'ghost',
      accounts: [],
      followers_total: 0,
    };
    expect(formatNotablePersonLine(p)).toBe('  ghost ✓认证');
  });

  it('大名鼎鼎渲染上限常量 = 5', () => {
    expect(NOTABLE_PEOPLE_CAP).toBe(5);
  });
});

describe('platformLabel（popclaw-feed.ts 同款映射）', () => {
  it('已知平台映射短标签', () => {
    expect(platformLabel('x')).toBe('X');
    expect(platformLabel('instagram')).toBe('IG');
    expect(platformLabel('tiktok')).toBe('TikTok');
    expect(platformLabel('youtube')).toBe('YT');
    expect(platformLabel('popclaw')).toBe('popclaw');
  });

  it('未知平台原样透传', () => {
    expect(platformLabel('mastodon')).toBe('mastodon');
  });
});
