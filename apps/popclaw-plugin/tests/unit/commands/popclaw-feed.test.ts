import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { popclaw } from '@popclaw/contracts';
import { SIGIL_LEN } from '@popclaw/algorithms';
import { runPopclawFeedCommand } from '../../../src/commands/popclaw-feed';
import { setOwnerLang } from '../../../src/lexicon/owner-language';
import { renderCopy } from '../../../src/lexicon/index';

// S3 pilot: the newspaper nudge line now renders in `ownerLang()` (S1
// process-wide singleton). Pin zh-CN so this file's assertions stay
// deterministic (same fix as status.test.ts / mcp-notice.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

// Crockford base32 alphabet (ADR-0015): digits + a-h,j,k,m,n,p-t,v-z (no i/l/o/u).
const SIGIL_RE_SRC = `[0-9a-hjkm-np-tv-z]{${SIGIL_LEN}}`;

function item(
  platform: string,
  handle: string,
  ageSec: number,
  text: string,
  authorPopclawId = 'FakeId1234567890',
  actorNickname?: string,
): popclaw.event.IWorldFeedItem {
  const now = Math.floor(Date.now() / 1000);
  return {
    platform,
    platformPostId: `post-${platform}-${handle}`,
    platformPostCreatedAt: now - ageSec,
    authorPopclawId,
    actorNickname,
    handle,
    originalUrl: `https://${platform}.example/post`,
    textPreview: text,
  };
}

function fakeClient(items: popclaw.event.IWorldFeedItem[]): any {
  return {
    fetchSnapshot: vi.fn().mockResolvedValueOnce(items),
  };
}

describe('runPopclawFeedCommand', () => {
  it('no-args defaults to limit=20 across all platforms', async () => {
    const client = fakeClient([item('x', 'elonmusk', 600, 'hello', 'FakeId1234567890', 'elonmusk')]);
    const result = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(client.fetchSnapshot).toHaveBeenCalledWith({ limit: 20, author: undefined, platform: undefined });
    expect(result.text).toContain('world feed');
    // X mirror renders as email-style @handle@X#sigil
    expect(result.text).toContain('@elonmusk@X#');
    expect(result.text).toContain('hello');
  });

  it('positional arg sets limit, clamped to 100', async () => {
    const client = fakeClient([]);
    await runPopclawFeedCommand({ positional: ['300'], flags: {} }, client);
    expect(client.fetchSnapshot).toHaveBeenCalledWith({ limit: 100, author: undefined, platform: undefined });
  });

  it('--author filter is forwarded', async () => {
    const client = fakeClient([]);
    await runPopclawFeedCommand({ positional: [], flags: { author: 'Hafxxx' } }, client);
    expect(client.fetchSnapshot).toHaveBeenCalledWith({ limit: 20, author: 'Hafxxx', platform: undefined });
  });

  it('--platform filter is forwarded', async () => {
    const client = fakeClient([]);
    await runPopclawFeedCommand({ positional: [], flags: { platform: 'tiktok' } }, client);
    expect(client.fetchSnapshot).toHaveBeenCalledWith({ limit: 20, author: undefined, platform: 'tiktok' });
  });

  it('combines limit + author + platform', async () => {
    const client = fakeClient([]);
    await runPopclawFeedCommand({ positional: ['50'], flags: { author: 'A', platform: 'x' } }, client);
    expect(client.fetchSnapshot).toHaveBeenCalledWith({ limit: 50, author: 'A', platform: 'x' });
  });

  it('renders empty with an honest note, never a repository developer command', async () => {
    const client = fakeClient([]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    // Lexicon-routed (this file pins ownerLang to zh-CN — see beforeAll above).
    expect(r.text).toContain(renderCopy('zh-CN', 'feed.local.empty'));
    expect(r.text).not.toContain('just ');
    expect(r.text).not.toContain('run-server');
  });

  it('shows platform emoji and relative time', async () => {
    const client = fakeClient([
      item('x', 'elonmusk', 600, 'tweet #1'),
      item('youtube', 'MrBeast', 3600 * 2, 'video title'),
      item('tiktok', 'mrbeast', 86400, 'tiktok text'),
      item('instagram', 'cristiano', 86400 * 3, 'ig caption'),
    ]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    // Platform emoji is now embedded in the "who" column (email-style @handle@PLATFORM)
    expect(r.text).toContain('🐦');  // X emoji present
    expect(r.text).toContain('▶️');  // YouTube emoji present
    expect(r.text).toContain('🎵');  // TikTok emoji present
    expect(r.text).toContain('📷');  // Instagram emoji present
    // Platform label is embedded in email-style handle format
    expect(r.text).toContain('@elonmusk@X');
    expect(r.text).toContain('@MrBeast@YT');
    expect(r.text).toContain('@mrbeast@TikTok');
    expect(r.text).toContain('@cristiano@IG');
    // platform content is still present
    expect(r.text).toContain('tweet #1');
    expect(r.text).toContain('video title');
    // 台账 #012：这五档此前硬编码英文，本文件把语言钉成 zh-CN 也照样返回英文。
    expect(r.text).toContain('10 分钟前');
    expect(r.text).toContain('2 小时前');
    expect(r.text).toContain('1 天前');
    expect(r.text).toContain('3 天前');
  });

  it('truncates long text_preview', async () => {
    const longText = 'a'.repeat(200);
    const client = fakeClient([item('x', 'h', 60, longText)]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).not.toContain('a'.repeat(200));  // truncated to <=60
    expect(r.text).toContain('…');  // ellipsis marker
  });

  it('falls back to @ranger-<first6>#sigil when actorNickname empty', async () => {
    const client = fakeClient([item('x', '', 60, 'text', 'HafHwSamQUZpTGfSQEqrE39cZqyE4joJJzdvYxNk86hk')]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    // actorNickname not set → ranger- fallback using first 6 chars of popclaw_id
    expect(r.text).toContain('@ranger-HafHwS#');
    expect(r.text).toMatch(new RegExp(`@ranger-HafHwS#${SIGIL_RE_SRC}`));
  });

  it('returns error message on client failure (not throw)', async () => {
    const client = {
      fetchSnapshot: vi.fn().mockRejectedValueOnce(new Error('connection refused')),
    };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).toContain('⚠️');
    expect(r.text).toContain('connection refused');
  });

  it('title mentions author + platform when filtered', async () => {
    const client = fakeClient([item('tiktok', 'mrbeast', 60, 'x')]);
    const r = await runPopclawFeedCommand({ positional: [], flags: { author: 'HafAuthorID12345', platform: 'tiktok' } }, client);
    expect(r.text).toContain('author=');
    expect(r.text).toContain('platform=tiktok');
  });
});

describe('runPopclawFeedCommand quote/reply classification', () => {
  it('shows root post with popclaw 📜 emoji', async () => {
    const client = fakeClient([
      item('popclaw', 'me', 60, 'hello'),
    ]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toContain('📜');
    expect(r.text).toContain('hello');
  });

  it('hides pure reply (replyToPostId set, quotedEventId empty) by default', async () => {
    const now = Math.floor(Date.now() / 1000);
    const replyItem: popclaw.event.IWorldFeedItem = {
      platform: 'popclaw',
      handle: 'me',
      textPreview: 'ack',
      replyToPostId: 'a'.repeat(64),
      platformPostCreatedAt: now - 30,
    };
    const rootItem: popclaw.event.IWorldFeedItem = {
      platform: 'popclaw',
      handle: 'me',
      textPreview: 'root post',
      platformPostCreatedAt: now - 60,
    };
    const client = fakeClient([replyItem, rootItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).not.toContain('ack');
    expect(r.text).toContain('root post');
    expect(r.text).toMatch(/1 pure-reply items hidden/);
  });

  it('shows pure reply when --include-threads', async () => {
    const now = Math.floor(Date.now() / 1000);
    const replyItem: popclaw.event.IWorldFeedItem = {
      platform: 'popclaw',
      handle: 'me',
      textPreview: 'ack',
      replyToPostId: 'a'.repeat(64),
      platformPostCreatedAt: now - 30,
    };
    const client = fakeClient([replyItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: { 'include-threads': '' } }, client);
    expect(r.text).toContain('ack');
  });

  it('shows quote post with embedded ↳ card (locally known target)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteItem: popclaw.event.IWorldFeedItem = {
      platform: 'popclaw',
      handle: 'me',
      actorNickname: 'me',
      textPreview: '城东更便宜',
      replyToPostId: 'a'.repeat(64),
      quotedEventId: 'a'.repeat(64),
      quotedAuthorPopclawId: 'BlackFeatherXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      quotedActorNickname: 'blackfeather',
      quotedAuthorHandle: 'blackfeather',
      quotedTextPreview: '城西西瓜很便宜',
      platformPostCreatedAt: now - 30,
    };
    const client = fakeClient([quoteItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toContain('城东更便宜');
    expect(r.text).toContain('↳ @blackfeather#');
    expect(r.text).toContain('"城西西瓜很便宜"');
  });

  it('shows quote post with fallback when quoted author unknown (cross-lore-house)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteItem: popclaw.event.IWorldFeedItem = {
      platform: 'popclaw',
      handle: 'me',
      textPreview: 'comment',
      quotedEventId: 'f'.repeat(64),
      platformPostCreatedAt: now - 30,
    };
    const client = fakeClient([quoteItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toContain('comment');
    expect(r.text).toContain('other lore-house: ffffffff...');
  });

  it('shows ↳ line without trailing colon when quoted preview is empty', async () => {
    const now = Math.floor(Date.now() / 1000);
    const quoteItem: popclaw.event.IWorldFeedItem = {
      platform: 'popclaw',
      handle: 'me',
      actorNickname: 'me',
      textPreview: 'comment',
      quotedEventId: 'b'.repeat(64),
      quotedAuthorPopclawId: 'ScoutXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      quotedActorNickname: 'scout',
      // quotedTextPreview deliberately omitted
      platformPostCreatedAt: now - 30,
    };
    const client = fakeClient([quoteItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toContain('↳ @scout#');
    expect(r.text).not.toMatch(new RegExp(`↳ @scout#${SIGIL_RE_SRC}:\\s*$`, 'm')); // no trailing colon
  });

  it('shows hidden-reply footer when all items are filtered out (empty visible result)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = fakeClient([
      {
        platform: 'popclaw',
        handle: 'me',
        textPreview: 'reply only',
        replyToPostId: 'a'.repeat(64),
        platformPostCreatedAt: now - 60,
      } as popclaw.event.IWorldFeedItem,
    ]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toMatch(/1 pure-reply items hidden/);
    expect(r.text).not.toContain(renderCopy('zh-CN', 'feed.local.empty'));
  });
});

describe('@nickname#sigil format (CLI polish plan)', () => {
  it('renders main actor as @nickname#sigil when actor_nickname populated', async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = fakeClient([
      {
        platform: 'popclaw',
        authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
        actorNickname: 'BlackFeather',
        textPreview: 'hello',
        platformPostCreatedAt: now - 60,
      } as popclaw.event.IWorldFeedItem,
    ]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toContain('@BlackFeather#');
    // Sigil is a canonical-length Crockford base32 string after the #
    expect(r.text).toMatch(new RegExp(`@BlackFeather#${SIGIL_RE_SRC}`));
  });

  it('renders main actor as @ranger-<6chars>#sigil when actor_nickname empty', async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = fakeClient([
      {
        platform: 'popclaw',
        authorPopclawId: '9A64cAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxZBs',
        actorNickname: '',  // empty triggers ranger- fallback
        textPreview: 'hi',
        platformPostCreatedAt: now - 30,
      } as popclaw.event.IWorldFeedItem,
    ]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toMatch(new RegExp(`@ranger-9A64cA#${SIGIL_RE_SRC}`));
  });

  it('renders quote ↳ card with @nickname#sigil format', async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = fakeClient([
      {
        platform: 'popclaw',
        authorPopclawId: '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM',
        actorNickname: 'Carol',
        textPreview: 'my comment',
        replyToPostId: 'a'.repeat(64),
        quotedEventId: 'a'.repeat(64),
        quotedAuthorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
        quotedActorNickname: 'Bob',
        quotedAuthorHandle: '',
        quotedTextPreview: 'root body',
        platformPostCreatedAt: now - 30,
      } as popclaw.event.IWorldFeedItem,
    ]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toContain('@Carol#');
    expect(r.text).toContain('↳ @Bob#');
    expect(r.text).toMatch(new RegExp(`↳ @Bob#${SIGIL_RE_SRC}: "root body"`));
  });

  it('whitespace-only actor_nickname falls back to ranger-<first6>', async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = fakeClient([
      {
        platform: 'popclaw',
        authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
        actorNickname: '   \t  ',  // whitespace-only — should fall through
        textPreview: 'hi',
        platformPostCreatedAt: now - 30,
      } as popclaw.event.IWorldFeedItem,
    ]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toMatch(new RegExp(`@ranger-7LhZ8x#${SIGIL_RE_SRC}`));
    // Must NOT contain the literal whitespace nickname in the @...# slot
    expect(r.text).not.toMatch(/@\s+#/);
  });

  it('empty popclawId falls back to @unknown#?????? placeholder', async () => {
    const now = Math.floor(Date.now() / 1000);
    const client = fakeClient([
      {
        platform: 'popclaw',
        authorPopclawId: '',  // missing/empty popclaw_id
        actorNickname: 'whatever',
        textPreview: 'hi',
        platformPostCreatedAt: now - 30,
      } as popclaw.event.IWorldFeedItem,
    ]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toContain(`@unknown#${'?'.repeat(SIGIL_LEN)}`);
  });
});

describe('runPopclawFeedCommand footer line', () => {
  const now = Math.floor(Date.now() / 1000);

  it('emits verified footer when actor_verified has entries', async () => {
    const client = {
      fetchSnapshot: vi.fn().mockResolvedValue([
        {
          platform: 'popclaw',
          authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
          actorNickname: 'elonmusk',
          platformPostId: 'a'.repeat(64),
          textPreview: 'hello',
          platformPostCreatedAt: now - 60,
          actorVerified: [
            { platform: 'x', handle: 'elonmusk', profileUrl: 'https://x.com/elonmusk' },
            { platform: 'github', handle: 'elonmusk', profileUrl: 'https://github.com/elonmusk' },
          ],
        } as popclaw.event.IWorldFeedItem,
      ]),
    };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).toContain('verified: 🐦 elonmusk · 🐙 elonmusk');
  });

  it('omits verified footer when actor_verified empty', async () => {
    const client = {
      fetchSnapshot: vi.fn().mockResolvedValue([
        {
          platform: 'popclaw',
          authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
          actorNickname: 'alice',
          platformPostId: 'b'.repeat(64),
          textPreview: 'hi',
          platformPostCreatedAt: now - 30,
        } as popclaw.event.IWorldFeedItem,
      ]),
    };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).not.toContain('verified:');
  });

  it('truncates verified footer with ...+N when > 3 platforms', async () => {
    const client = {
      fetchSnapshot: vi.fn().mockResolvedValue([
        {
          platform: 'popclaw',
          authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
          actorNickname: 'bob',
          platformPostId: 'c'.repeat(64),
          textPreview: 'multi',
          platformPostCreatedAt: now - 30,
          actorVerified: [
            { platform: 'x', handle: 'a' },
            { platform: 'instagram', handle: 'b' },
            { platform: 'github', handle: 'c' },
            { platform: 'youtube', handle: 'd' },
            { platform: 'tiktok', handle: 'e' },
          ],
        } as popclaw.event.IWorldFeedItem,
      ]),
    };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).toMatch(/verified: 🐦 a · 📷 b · 🐙 c · \.\.\.\+2/);
  });

  it('excludes the popclaw-native anchor row from the footer (spec §4.7)', async () => {
    const client = {
      fetchSnapshot: vi.fn().mockResolvedValue([
        {
          platform: 'popclaw',
          authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
          actorNickname: 'elonmusk',
          platformPostId: 'd'.repeat(64),
          textPreview: 'hello',
          platformPostCreatedAt: now - 60,
          actorVerified: [
            // anchor row baked into the JSONB — must NOT appear in the footer.
            { platform: 'popclaw', handle: 'elonmusk' },
            { platform: 'x', handle: 'elonmusk', profileUrl: 'https://x.com/elonmusk' },
          ],
        } as popclaw.event.IWorldFeedItem,
      ]),
    };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).toContain('verified: 🐦 elonmusk');
    // The ❓ popclaw anchor must not leak into the footer.
    expect(r.text).not.toContain('❓');
    expect(r.text).not.toContain('· ...+'); // only 1 external platform after filter
  });

  it('omits footer entirely when only a popclaw anchor row is baked', async () => {
    const client = {
      fetchSnapshot: vi.fn().mockResolvedValue([
        {
          platform: 'popclaw',
          authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
          actorNickname: 'solo',
          platformPostId: 'e'.repeat(64),
          textPreview: 'hi',
          platformPostCreatedAt: now - 30,
          actorVerified: [{ platform: 'popclaw', handle: 'solo' }],
        } as popclaw.event.IWorldFeedItem,
      ]),
    };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).not.toContain('verified:');
  });

  it('appends compact (count) per platform in the footer', async () => {
    const client = {
      fetchSnapshot: vi.fn().mockResolvedValue([
        {
          platform: 'popclaw',
          authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
          actorNickname: 'elonmusk',
          platformPostId: 'f'.repeat(64),
          textPreview: 'hi',
          platformPostCreatedAt: now - 60,
          actorVerified: [
            { platform: 'x', handle: 'elonmusk', profileUrl: 'https://x.com/elonmusk', followerCount: 221_000_000 },
            { platform: 'github', handle: 'elonmusk', followerCount: 35_000 },
          ],
        } as popclaw.event.IWorldFeedItem,
      ]),
    };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).toContain('🐦 elonmusk (221m)');
    expect(r.text).toContain('🐙 elonmusk (35k)');
  });

  it('omits (count) when followerCount is 0 / missing', async () => {
    const client = {
      fetchSnapshot: vi.fn().mockResolvedValue([
        {
          platform: 'popclaw',
          authorPopclawId: '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM',
          actorNickname: 'alice',
          platformPostId: 'g'.repeat(64),
          textPreview: 'hi',
          platformPostCreatedAt: now - 60,
          actorVerified: [{ platform: 'x', handle: 'alice' }],
        } as popclaw.event.IWorldFeedItem,
      ]),
    };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).toContain('verified: 🐦 alice');
    // No compact (count) appended to the verified footer when followerCount is 0/missing.
    // (The title line "🌍 popclaw world feed (1 items)" has its own '(', so assert on the footer line.)
    const footerLine = r.text.split('\n').find((l) => l.includes('verified:')) ?? '';
    expect(footerLine).not.toContain('(');
  });
});

describe('feed display: cross-platform handle + event_id column', () => {
  const now = Math.floor(Date.now() / 1000);

  function mockClient(items: popclaw.event.IWorldFeedItem[]): any {
    return { fetchSnapshot: vi.fn().mockResolvedValueOnce(items) };
  }

  it('renders X mirror with 🐦 @handle@X#sigil format', async () => {
    const client = mockClient([{
      platform: 'x',
      handle: 'elonmusk',
      authorPopclawId: 'somePopclawId1234567890123456789012345678901234',
      platformPostId: '1234567890',
      textPreview: 'Starship Rising',
      platformPostCreatedAt: now - 60,
    } as popclaw.event.IWorldFeedItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toMatch(new RegExp(`🐦 @elonmusk@X#${SIGIL_RE_SRC}`));
    // Must NOT have "@popclaw" style suffix for X mirror
    expect(r.text).not.toMatch(/@X@popclaw/);
  });

  it('renders popclaw-native with 📜 @nickname#sigil format (no platform suffix)', async () => {
    const client = mockClient([{
      platform: 'popclaw',
      authorPopclawId: 'someOtherPopclawId1234567890123456789012345678',
      actorNickname: 'alice',
      platformPostId: 'a'.repeat(64),
      textPreview: 'hi from popclaw',
      platformPostCreatedAt: now - 60,
    } as popclaw.event.IWorldFeedItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toMatch(new RegExp(`📜 @alice#${SIGIL_RE_SRC}`));
    // NO @popclaw / @POPCLAW suffix — platform implicit in 📜 emoji
    expect(r.text).not.toMatch(/@popclaw/i);
  });

  it('feed lists event_id 10-hex in dedicated id column', async () => {
    const longId = 'abcdef1234' + '0'.repeat(54);  // 64-char hex, first 10 = 'abcdef1234'
    const client = mockClient([{
      platform: 'popclaw',
      authorPopclawId: 'somePopclawId1234567890123456789012345678901234',
      actorNickname: 'bob',
      platformPostId: longId,
      textPreview: 'check id col',
      platformPostCreatedAt: now - 30,
    } as popclaw.event.IWorldFeedItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    // The 10-hex short id is shown in the id column
    expect(r.text).toContain('#abcdef1234');
    // The header row contains the 'id' column label
    expect(r.text).toContain('id');
    // The full 64-char id string is NOT in the table (column is short prefix only)
    expect(r.text).not.toContain('0'.repeat(54));
  });
});

describe('feed → cache record + newspaper nudge', () => {
  function item24(ageSec: number): popclaw.event.IWorldFeedItem {
    const now = Math.floor(Date.now() / 1000);
    return {
      platform: 'x', platformPostId: `pp${ageSec}`, platformPostCreatedAt: now - ageSec,
      authorPopclawId: 'A', handle: 'a', originalUrl: 'u', textPreview: 'hi',
    } as popclaw.event.IWorldFeedItem;
  }

  it('records every fetched item into the cache', async () => {
    const fetched = [item24(10), item24(20)];
    const client = { fetchSnapshot: vi.fn().mockResolvedValueOnce(fetched) };
    const cache = { record: vi.fn(), recent: vi.fn().mockReturnValue([]) };
    await runPopclawFeedCommand({ positional: [], flags: {} }, client as any, { cache });
    expect(cache.record).toHaveBeenCalledTimes(2);
  });

  it('appends the newspaper nudge when 24h count >= 5', async () => {
    const now = Math.floor(Date.now() / 1000);
    const within = Array.from({ length: 6 }, (_, i) => ({ platformPostCreatedAt: now - i * 60 }));
    const client = { fetchSnapshot: vi.fn().mockResolvedValueOnce([item24(10)]) };
    const cache = { record: vi.fn(), recent: vi.fn().mockReturnValue(within) };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any, { cache });
    expect(r.text).toContain('/popclaw newspaper');
    expect(r.text).toContain('24h');
  });

  it('omits the nudge when fewer than 5 in the last 24h', async () => {
    const now = Math.floor(Date.now() / 1000);
    const within = [{ platformPostCreatedAt: now - 60 }];
    const client = { fetchSnapshot: vi.fn().mockResolvedValueOnce([item24(10)]) };
    const cache = { record: vi.fn(), recent: vi.fn().mockReturnValue(within) };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any, { cache });
    expect(r.text).not.toContain('/popclaw newspaper');
  });

  it('still works with no opts (backward compatible — no record, no nudge)', async () => {
    const client = { fetchSnapshot: vi.fn().mockResolvedValueOnce([item24(10)]) };
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client as any);
    expect(r.text).toContain('world feed');
    expect(r.text).not.toContain('/popclaw newspaper');
  });

  // S3 pilot: exact nudge text, zh (pre-lexicon original) vs en.
  it('nudge text: zh lane matches the pre-lexicon original byte-for-byte', async () => {
    setOwnerLang('zh-CN', 'config');
    const now = Math.floor(Date.now() / 1000);
    const within = Array.from({ length: 6 }, (_, i) => ({ platformPostCreatedAt: now - i * 60 }));
    const client = { fetchSnapshot: vi.fn().mockResolvedValueOnce([item24(10)]) };
    const cache = { record: vi.fn(), recent: vi.fn().mockReturnValue(within) };
    const r = await runPopclawFeedCommand(
      { positional: [], flags: {} },
      client as unknown as Parameters<typeof runPopclawFeedCommand>[1],
      { cache },
    );
    expect(r.text).toContain('📰 本页只列最近 1 条 · 今日江湖 24h 内共 6 条 · 想看图文全貌 → /popclaw newspaper');
  });

  it('nudge text: en lane', async () => {
    setOwnerLang('en', 'config');
    const now = Math.floor(Date.now() / 1000);
    const within = Array.from({ length: 6 }, (_, i) => ({ platformPostCreatedAt: now - i * 60 }));
    const client = { fetchSnapshot: vi.fn().mockResolvedValueOnce([item24(10)]) };
    const cache = { record: vi.fn(), recent: vi.fn().mockReturnValue(within) };
    const r = await runPopclawFeedCommand(
      { positional: [], flags: {} },
      client as unknown as Parameters<typeof runPopclawFeedCommand>[1],
      { cache },
    );
    expect(r.text).toContain(
      '📰 Showing the latest 1 · 6 across the world in the last 24h · for the full picture → /popclaw newspaper',
    );
    setOwnerLang('zh-CN', 'config'); // restore file default for tests after this one
  });
});

describe('feed: mirror provenance — source badge + view-original (ADR-0025 task 4.1)', () => {
  const now = Math.floor(Date.now() / 1000);

  function mockClient(items: popclaw.event.IWorldFeedItem[]): any {
    return { fetchSnapshot: vi.fn().mockResolvedValueOnce(items) };
  }

  it('mirror row: shows source platform badge (🐦 @handle@X#sigil) from it.platform', async () => {
    // Phase 3 already sets it.platform = "x" for X mirrors; this verifies that
    // the existing badge path still works alongside the new origin affordance.
    const client = mockClient([{
      platform: 'x',
      handle: 'elonmusk',
      authorPopclawId: 'MirrorPopclawId12345678901234567890123456789012',
      platformPostId: 'abc123',
      textPreview: 'Starship update',
      platformPostCreatedAt: now - 120,
      origin: {
        platform: 'x',
        postId: 'abc123',
        url: 'https://x.com/elonmusk/status/abc123',
        createdAt: now - 120,
        replyToId: '',
      },
    } as popclaw.event.IWorldFeedItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    // Source platform badge present
    expect(r.text).toMatch(new RegExp(`🐦 @elonmusk@X#${SIGIL_RE_SRC}`));
    // View-original affordance present
    expect(r.text).toContain('↗ https://x.com/elonmusk/status/abc123');
  });

  it('mirror row (IG): shows 📷 badge + view-original url', async () => {
    const client = mockClient([{
      platform: 'instagram',
      handle: 'cristiano',
      authorPopclawId: 'IGPopclawId12345678901234567890123456789012345',
      platformPostId: 'ig001',
      textPreview: 'Champions',
      platformPostCreatedAt: now - 60,
      origin: {
        platform: 'instagram',
        postId: 'ig001',
        url: 'https://www.instagram.com/p/ig001/',
        createdAt: now - 60,
        replyToId: '',
      },
    } as popclaw.event.IWorldFeedItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toMatch(new RegExp(`📷 @cristiano@IG#${SIGIL_RE_SRC}`));
    expect(r.text).toContain('↗ https://www.instagram.com/p/ig001/');
  });

  it('native post (no origin): unchanged 📜 format, no ↗ line', async () => {
    const client = mockClient([{
      platform: 'popclaw',
      authorPopclawId: 'NativePopclawId1234567890123456789012345678901',
      actorNickname: 'alice',
      platformPostId: 'n001',
      textPreview: 'hello world',
      platformPostCreatedAt: now - 30,
      // no origin field
    } as popclaw.event.IWorldFeedItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toMatch(new RegExp(`📜 @alice#${SIGIL_RE_SRC}`));
    // No view-original for native posts
    expect(r.text).not.toContain('↗');
  });

  it('mirror with empty origin.url: skips the ↗ line gracefully', async () => {
    const client = mockClient([{
      platform: 'x',
      handle: 'ghost',
      authorPopclawId: 'GhostPopclawId1234567890123456789012345678901',
      platformPostId: 'g001',
      textPreview: 'no url here',
      platformPostCreatedAt: now - 45,
      origin: {
        platform: 'x',
        postId: 'g001',
        url: '',  // empty url — do not render ↗
        createdAt: now - 45,
        replyToId: '',
      },
    } as popclaw.event.IWorldFeedItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).not.toContain('↗');
  });

  it('mirror row: view-original indented consistent with verifiedFooter/quoted style', async () => {
    // Both verifiedFooter and view-original appear on the same item; both indented.
    const client = mockClient([{
      platform: 'x',
      handle: 'jack',
      authorPopclawId: 'JackPopclawId12345678901234567890123456789012',
      platformPostId: 'j001',
      textPreview: 'tweet text',
      platformPostCreatedAt: now - 200,
      actorVerified: [{ platform: 'x', handle: 'jack' }],
      origin: {
        platform: 'x',
        postId: 'j001',
        url: 'https://x.com/jack/status/j001',
        createdAt: now - 200,
        replyToId: '',
      },
    } as popclaw.event.IWorldFeedItem]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client);
    expect(r.text).toContain('verified: 🐦 jack');
    expect(r.text).toContain('↗ https://x.com/jack/status/j001');
    // Both extra lines must be preceded by whitespace indentation (column alignment)
    const lines = r.text.split('\n');
    const viewOrigLine = lines.find((l) => l.includes('↗'));
    expect(viewOrigLine).toBeDefined();
    // Indented: starts with at least one space
    expect(viewOrigLine!.startsWith(' ')).toBe(true);
  });
});

it('public display shows full signed content and local provenance without snapshot, cache or nudge work', async () => {
  const id = 'a'.repeat(64), client = fakeClient([]), record = vi.fn(), recent = vi.fn();
  const read = vi.fn(() => ({ items: [{ item: { platform: 'popclaw', platformPostId: id, authorPopclawId: 'signer' },
    body: 'Complete signed body beyond preview', kind: 'post', relaySnapshot: false, mirrorSigner: false,
    source: { origin: 'https://source.invalid', slug: 'source', observedAt: 100, sequence: '1', logIncarnation: 'private-log-detail' } }],
    sources: [{ origin: 'https://source.invalid', slug: 'source', history: true, incomplete: true, unavailable: false, truncated: true }], truncated: true }));
  const result = await runPopclawFeedCommand({ positional: ['7'], flags: { author: 'signer', platform: 'popclaw' } }, client,
    { cache: { record, recent }, publicFeedDisplay: { read } as never });
  expect(read).toHaveBeenCalledWith({ limit: 7, author: 'signer', platform: 'popclaw', includeThreads: false });
  expect(result.text).toContain(id); expect(result.text).toContain('Complete signed body beyond preview');
  expect(result.text).toContain('本地历史'); expect(result.text).toContain('接收尚不完整'); expect(result.text).toContain('并非完整搜索');
  expect(result.text).toContain('1970-01-01T00:01:40.000Z'); expect(result.text).not.toContain('private-log-detail');
  expect(client.fetchSnapshot).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled(); expect(recent).not.toHaveBeenCalled();
});
it('labels opaque HouseEvent content by its signed kind without rendering an empty unexplained card', async () => {
  const { formatPublicDisplay } = await import('../../../src/commands/popclaw-feed');
  const text = formatPublicDisplay({ items: [{ item: { platform: 'popclaw', platformPostId: 'c'.repeat(64) }, body: '',
    kind: 'custom.notice', bodyUnavailable: true, relaySnapshot: false, mirrorSigner: false,
    source: { origin: 'https://house.invalid', slug: 'house', observedAt: 100, sequence: '1', logIncarnation: 'log' } }], sources: [], truncated: false });
  expect(text).toContain('事件类型：custom.notice'); expect(text).toContain('原始内容仍保留在本地');
});

// #588: an empty feed and a house outage are the same two lines of output
// unless the result itself says when each house last delivered a frame.
describe('runPopclawFeedCommand — empty results name the silent house', () => {
  it('appends the outage line when nothing came back', async () => {
    const client = fakeClient([]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client, {
      silence: () => 'no frames from popclaw-me since 2023-11-14 22:13',
    });
    expect(r.text).toContain('no frames from popclaw-me since');
  });

  it('stays silent when there is something to show — the world is simply not quiet', async () => {
    const client = fakeClient([item('x', 'elonmusk', 600, 'hello')]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client, {
      silence: () => 'no frames from popclaw-me since 2023-11-14 22:13',
    });
    expect(r.text).not.toContain('no frames from');
  });

  // "What did X post lately" with nothing from X is the most common benign
  // empty. Telling the agent to suspect an outage there is worse than saying
  // nothing: the filter explains the emptiness, the houses do not.
  it('stays silent on a zero-result AUTHOR query — the filter explains the emptiness', async () => {
    const client = fakeClient([]);
    const r = await runPopclawFeedCommand({ positional: [], flags: { author: 'id_elon' } }, client, {
      silence: () => 'no frames from popclaw-me since 2023-11-14 22:13',
    });
    expect(r.text).not.toContain('no frames from');
  });

  it('stays silent on a zero-result PLATFORM query', async () => {
    const client = fakeClient([]);
    const r = await runPopclawFeedCommand({ positional: [], flags: { platform: 'tiktok' } }, client, {
      silence: () => 'no frames from popclaw-me since 2023-11-14 22:13',
    });
    expect(r.text).not.toContain('no frames from');
  });

  it('stays silent when frames DID arrive and only the thread filter hid them', async () => {
    // Pure replies, hidden by default. The house is plainly alive.
    const reply = item('popclaw', 'someone', 60, 'a reply');
    const client = fakeClient([{ ...reply, replyToPostId: 'parent-1' }]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client, {
      silence: () => 'no frames from popclaw-me since 2023-11-14 22:13',
    });
    expect(r.text).not.toContain('no frames from');
  });

  it('a silence probe that throws must not take the feed down', async () => {
    const client = fakeClient([]);
    const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client, {
      silence: () => {
        throw new Error('cache closed');
      },
    });
    expect(r.text).toContain('world feed');
  });

  // The empty-feed line must never suggest a repository developer command,
  // no matter which of the three honest silence states (never / since /
  // unreadable — house-silence.ts readLastFrameAt) accompanies it, and it
  // must not contradict them by claiming the house has no posts.
  for (const [label, silenceText] of [
    ['never received a frame', renderCopy('zh-CN', 'world.silence.never', { house: 'popclaw-me' })],
    ['no frames since a time', renderCopy('zh-CN', 'world.silence.since', { house: 'popclaw-me', when: '2023-11-14', ago: '2天前' })],
    ['cache unreadable', renderCopy('zh-CN', 'world.silence.unreadable', { house: 'popclaw-me' })],
  ] as const) {
    it(`never suggests a developer command — silence state: ${label}`, async () => {
      const client = fakeClient([]);
      const r = await runPopclawFeedCommand({ positional: [], flags: {} }, client, {
        silence: () => silenceText,
      });
      expect(r.text).not.toContain('just ');
      expect(r.text).not.toContain('run-server');
      expect(r.text).not.toContain('no posts');
      expect(r.text).toContain(silenceText);
    });
  }
});
