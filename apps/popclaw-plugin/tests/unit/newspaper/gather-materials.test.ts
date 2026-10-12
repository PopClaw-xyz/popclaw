import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  gatherNewspaperMaterials as gatherRaw,
  weightedChars,
  type GatherDeps,
} from '../../../src/newspaper/gather-materials.js';
import { tierLabel, type BondTier } from '../../../src/bonds/bond-tier.js';
import { renderCopy } from '../../../src/lexicon/index.js';

// D8: compute expected material-slot output with the shared renderer rather than duplicating literals.
const mat = (key: string, vars: Record<string, string> = {}): string =>
  renderCopy('zh-CN', `newspaper.material.${key}`, vars);
/**
 * `作者: <称呼>`: used to count occurrences, without the `[N] ` line number.
 */
const authorOf = (who: string): string => mat('pulse.author', { i: '1', who }).replace('[1] ', '');
/** The fixed literal text before a template's first `{var}` — a block-presence/count check independent of which value fills it in. */
const matPrefix = (key: string): string => mat(key).split('{')[0]!;
import { getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { readNewspaperDocument } from '../../../src/newspaper/reading-page.js';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { urlsOf } from './_issue-fixture.js';
import type { IssueData } from '../../../src/newspaper/issue.js';

/** The issue gather stored for this token. v0.2: the brief carries the words, the issue carries the material. */
const stored = (): IssueData => getIssue('tok_test')!;
import { setOwnerTz } from '../../../src/time/time-context.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';


function deps(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    cache: {
      recentForReading: () =>
        [
          {
            handle: 'elonmusk',
            textPreview: 'ship it',
            body: 'ship it',
            media: [],
            replyToAuthorHandle: '',
            replyCount: 0,
            platform: 'x',
            platformPostCreatedAt: 99000, // within now(100000) − 24h
            eventId: '',
            platformPostId: '',
            originalUrl: 'https://x.com/elonmusk/1',
          },
        ] as never,
    },
    inbox: { recent: () => [] as never },
    readContentRules: () => '',
    ownerNickname: 'Yu',
    webBaseUrl: 'https://popclaw.me',
    now: () => 100000,
    mintToken: () => 'tok_test',
    isFollowing: () => false,
    ...over,
  };
}


/**
 * A one-step wrapper around the two-step protocol: candidate page, select all, material page.
 * Existing assertions cover material invariants (numbers, author headers, house distribution) that
 * survive the protocol change. The wrapper preserves those assertions; selection limits and picks
 * validation have separate tests.
 */
function gatherNewspaperMaterials(d: GatherDeps, o: { hours?: number } = {}): GatherResult {
  const r = gatherRaw(d, o);
  if (r.kind !== 'candidates') return r;
  const all = getIssue(r.candidateToken)!.pulse.map((_, i) => i + 1);
  const picked = buildIssueFromPicks(r.candidateToken, all, {
    mintToken: d.mintToken,
    contentRules: d.readContentRules?.() ?? '',
    leadMax: d.readStyle?.().leadMax ?? 3,
    perAuthorMax: Number.MAX_SAFE_INTEGER, // These tests do not measure the limit.
    // Return all candidates unchanged in this fixture; do not involve popularity-based top-up.
    floor: 0,
    topUpTo: 0,
  });
  if (picked.kind !== 'ready') throw new Error(picked.message);
  return { kind: 'ready', payload: picked.payload, publishToken: picked.publishToken };
}
type GatherResult =
  | { kind: 'empty'; message: string }
  | { kind: 'ready'; payload: string; publishToken: string };

describe('gatherNewspaperMaterials', () => {
  // bondLines() in build-newspaper-prompt.ts uses tierLabel(), which defaults to
  // ownerLang(). Pin zh-CN because these assertions preserve the production Chinese text from before migration.
  beforeAll(() => setOwnerLang('zh-CN', 'config'));
  afterAll(() => setOwnerLang(undefined));
  beforeEach(() => _resetIssuesForTest());

  it('returns ready payload + token, and stores a manifest of the item URLs', () => {
    const r = gatherNewspaperMaterials(deps(), { hours: 24 });
    expect(r.kind).toBe('ready');
    if (r.kind !== 'ready') return;
    expect(r.publishToken).toBe('tok_test');
    expect(r.payload).toContain('popclaw_publish_newspaper'); // tells agent to publish
    expect(r.payload).toContain(mat('pulse.author', { i: '1', who: 'elonmusk' })); // v2: author header
    expect(stored().pulse[0]!.avatarUrl).toContain('unavatar.io/twitter/elonmusk'); // v2: avatar wired
    expect(r.payload).not.toContain('http'); // v0.2: the agent is handed no URL at all
    expect(urlsOf(getIssue('tok_test')!).has('https://x.com/elonmusk/1')).toBe(true);
    // v2: author profile URL (derived) is whitelisted for the fidelity check
    expect(urlsOf(getIssue('tok_test')!).has('https://x.com/elonmusk')).toBe(true);
  });

  it('returns empty (honest, no manifest) when nothing is in window', () => {
    const r = gatherNewspaperMaterials(deps({ cache: { recentForReading: () => [] as never } }), { hours: 24 });
    expect(r.kind).toBe('empty');
    if (r.kind !== 'empty') return;
    expect(r.message).toBe(renderCopy('zh-CN', 'newspaper.empty.window', { hours: '24' }));
  });

  it('carries per-item interaction fields (eventId/author/mark/reply/isFollowing)', () => {
    const d = deps({
      isFollowing: (id: string) => id === 'A',
      cache: { recentForReading: () => [
        { platform: 'x', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'h', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 3, markCount: 5,
          actorNickname: '', actorVerified: [] },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(mat('pulse.marks', { count: '5' }));
    expect(r.payload).toContain(mat('pulse.replies', { count: '3' }));
    expect(r.payload).toContain('follow state: following'); // A is followed → no follow button
  });

  it('derives the 围观 link with the SHORT event id (10-hex prefix) and whitelists it for F2', () => {
    const d = deps({
      cache: { recentForReading: () => [
        { platform: 'x', platformPostId: 'p1', eventId: 'abcdef1234567890feed', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'elonmusk', originalUrl: 'https://x.com/elonmusk/1', textPreview: 't',
          body: 't', media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    // 10-hex prefix
    expect(stored().pulse[0]!.postPageUrl).toBe('https://popclaw.me/post/abcdef1234');
    expect(r.payload).not.toContain('/post/abcdef1234567890feed'); // never the full id in a link
    expect(urlsOf(getIssue('tok_test')!).has('https://popclaw.me/post/abcdef1234')).toBe(true);
  });

  it('headline fallback link (no originalUrl) also uses the SHORT id, not 64-hex', () => {
    const full = 'a'.repeat(64);
    const d = deps({
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: '', eventId: full, platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'blackfeather', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(stored().pulse[0]!.url).toBe(`https://popclaw.me/post/${'a'.repeat(10)}`);
    expect(r.payload).not.toContain(full); // raw 64-hex never leaks into the materials
  });

  // Redesign slice A: P0 house/kind passthrough and P1 bond book.

  it('P0: passes houseSlug + kind through and prints the 坊分布 line', () => {
    const d = deps({
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'a', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
          houseSlug: 'popclaw.world', kind: 'house:Postcard' },
        { platform: 'popclaw', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 99000,
          authorPopclawId: 'B', handle: 'b', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
          houseSlug: 'popclaw.me', kind: 'post' },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(mat('pulse.house', { house: 'popclaw.world' }));
    expect(r.payload).toContain(mat('pulse.kind', { kind: 'house:Postcard' }));
    expect(r.payload).toContain(mat('pulse.house', { house: 'popclaw.me' }));
    expect(r.payload).toContain(mat('pulse.kind', { kind: 'post' }));
    // The distribution line joins each house's count with ' · ', in the order
    // houses first appeared in `pulse` — check the whole joined+ordered line,
    // not each piece independently (which wouldn't catch a swapped order or
    // a broken join separator).
    const counts = [
      mat('houseCount', { slug: 'popclaw.world', count: '1' }),
      mat('houseCount', { slug: 'popclaw.me', count: '1' }),
    ].join(' · ');
    expect(r.payload).toContain(mat('houseDistribution', { counts }));
  });

  it('P1: 交情档 + 备注名 出现在素材行（tier 映射成中文）', () => {
    const d = deps({
      bondOf: (id: string) => (id === 'A' ? { tier: 'close', remarkName: '老龙' } : null),
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'a', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(`bond: ${tierLabel('close')}`);
    expect(r.payload).toContain('alias "老龙"');
  });

  it('P1: blocked / reject 档的作者一条都不进报纸（pulse）', () => {
    const d = deps({
      bondOf: (id: string) =>
        id === 'BAD' ? { tier: 'blocked', remarkName: '' } : id === 'WORSE' ? { tier: 'reject', remarkName: '' } : null,
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'BAD', handle: 'bad', originalUrl: '', textPreview: 'x', body: '拉黑的人说的话',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
        { platform: 'popclaw', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 99000,
          authorPopclawId: 'WORSE', handle: 'worse', originalUrl: '', textPreview: 'y', body: '拒收的人说的话',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
        { platform: 'popclaw', platformPostId: 'p3', eventId: 'e3', platformPostCreatedAt: 99000,
          authorPopclawId: 'OK', handle: 'ok', originalUrl: '', textPreview: 'z', body: '正常人说的话',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).not.toContain('拉黑的人说的话');
    expect(r.payload).not.toContain('拒收的人说的话');
    expect(r.payload).toContain('正常人说的话');
    expect(r.payload).toContain('**1 items** gathered'); // totalCount also counts only items included in the newspaper.
  });

  it('P1: blocked / reject 档的来信也不进待回', () => {
    const d = deps({
      bondOf: (id: string) => (id === 'BAD' ? { tier: 'blocked', remarkName: '' } : null),
      inbox: { recent: () => [
        { ts: 99500, fromPopclawId: 'BAD', body: '拉黑的人来信', receivedAtMs: 0, toPopclawId: 'me' },
        { ts: 99500, fromPopclawId: 'OK', body: '正常来信', receivedAtMs: 0, toPopclawId: 'me' },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).not.toContain('拉黑的人来信');
    expect(r.payload).toContain('正常来信');
  });

  it('P1: 待回按交情档排序（至交在前）', () => {
    const tiers: Record<string, BondTier> = { P: 'acquaintance', Q: 'close_plus', R: 'friend' };
    const d = deps({
      bondOf: (id: string) => {
        const tier = tiers[id];
        return tier ? { tier, remarkName: '' } : null;
      },
      inbox: { recent: () => [
        { ts: 99500, fromPopclawId: 'P', body: '认识的人', receivedAtMs: 0, toPopclawId: 'me' },
        { ts: 99500, fromPopclawId: 'Q', body: '至交的人', receivedAtMs: 0, toPopclawId: 'me' },
        { ts: 99500, fromPopclawId: 'R', body: '好友的人', receivedAtMs: 0, toPopclawId: 'me' },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    const [top, mid, low] = ['至交的人', '好友的人', '认识的人'].map((s) => r.payload.indexOf(s));
    expect(top).toBeGreaterThan(-1);
    expect(top).toBeLessThan(mid!);
    expect(mid).toBeLessThan(low!);
  });

  it('P7: 把一期概况存进 manifest,供 publish 落社交日志', () => {
    const d = deps({
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'a', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0, houseSlug: 'popclaw.me' },
      ] as never },
      inbox: { recent: () => [
        { ts: 99500, fromPopclawId: 'Z', body: '在吗', receivedAtMs: 0, toPopclawId: 'me' },
      ] as never },
    });
    gatherNewspaperMaterials(d, { hours: 24 });
    // v0.2 no longer stores separate stats: social-log figures derive directly from the issue and cannot disagree.
    const issue = stored();
    expect(issue.totalCount).toBe(1);
    expect(issue.pings).toHaveLength(1);
    expect(issue.byHouse).toEqual({ 'popclaw.me': 1 });
    expect(issue.dateLabel).toContain('1970');
  });

  // Redesign slices B+C: P4 recommendation reasons / P5 newcomer marks / P1 recent-activity footer / P2 manifests / P3 participants.

  const one = (over: Record<string, unknown> = {}) => ({
    cache: {
      recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'a', originalUrl: '', textPreview: 't',
          body: '今天读了一首译诗', media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
          ...over },
      ] as never,
    },
  });

  it('P4: taste 标签命中正文 → 荐因素材行（大小写不敏感）', () => {
    const r = gatherNewspaperMaterials(
      deps({ ...one(), tasteTags: ['译诗', 'Rust'] }),
      { hours: 24 },
    );
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(mat('pulse.reasons', { reasons: mat('reason.taste', { tag: '译诗' }) }));
    expect(r.payload).not.toContain('Rust');
  });

  it('P4: 大小写不敏感 + 没命中就整行不出', () => {
    const hit = gatherNewspaperMaterials(
      deps({ ...one({ body: 'shipping RUST today' }), tasteTags: ['rust'] }),
      { hours: 24 },
    );
    if (hit.kind !== 'ready') throw new Error('want ready');
    expect(hit.payload).toContain(mat('reason.taste', { tag: 'rust' }));

    const miss = gatherNewspaperMaterials(deps({ ...one(), tasteTags: ['围棋'] }), { hours: 24 });
    if (miss.kind !== 'ready') throw new Error('want ready');
    expect(miss.payload).not.toContain(mat('pulse.reasons', { reasons: '' }));
  });

  it('P4: 关系路径 — 你关注的人回过他', () => {
    const d = deps({
      isFollowing: (id: string) => id === 'F',
      nameOf: (id: string, fallback?: string) => (id === 'F' ? '卡帕西' : (fallback ?? '')),
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'a', originalUrl: '', textPreview: 't', body: '原帖',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
        // Followed F replied to A's post: A's item should include a recommendation reason.
        { platform: 'popclaw', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 99100,
          authorPopclawId: 'F', handle: 'f', originalUrl: '', textPreview: 't', body: '回帖',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
          replyToPostId: 'p1', replyToAuthorPopclawId: 'A' },
        // Unfollowed U replied to B's post: this does not form a recommendation path.
        { platform: 'popclaw', platformPostId: 'p3', eventId: 'e3', platformPostCreatedAt: 99200,
          authorPopclawId: 'U', handle: 'u', originalUrl: '', textPreview: 't', body: '路人回帖',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
          replyToPostId: 'p4', replyToAuthorPopclawId: 'B' },
        { platform: 'popclaw', platformPostId: 'p4', eventId: 'e4', platformPostCreatedAt: 99300,
          authorPopclawId: 'B', handle: 'b', originalUrl: '', textPreview: 't', body: 'B 的原帖',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(
      mat('pulse.reasons', { reasons: mat('reason.relation', { who: '卡帕西' }) }),
    );
    expect(r.payload).not.toContain(mat('reason.relation', { who: 'u' }));
  });

  it('P5: 本机首见 ≤14 天出新人标，更早的不出', () => {
    const day = 86400;
    const d = deps({
      now: () => 100 * day,
      cache: {
        recentForReading: () => [
          { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 100 * day - 60,
            authorPopclawId: 'NEW', handle: 'n', originalUrl: '', textPreview: 't', body: '新人说话',
            media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
          { platform: 'popclaw', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 100 * day - 60,
            authorPopclawId: 'OLD', handle: 'o', originalUrl: '', textPreview: 't', body: '老人说话',
            media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
        ] as never,
        authorFirstSeen: () => new Map([['NEW', 98 * day], ['OLD', 50 * day]]),
      },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(mat('cast.newcomer', { days: '3' })); // Day 98 to day 100 means the third day.
    // OLD is excluded: count newcomer-prefix occurrences without coupling to a specific day count.
    expect(r.payload.split(matPrefix('cast.newcomer')).length - 1).toBe(1);
  });

  it('P1 尾巴: 交情近况进素材行,超 60 字截断', () => {
    const long = '长'.repeat(80);
    const d = deps({
      ...one(),
      bondOf: () => ({ tier: 'friend' as const, remarkName: '', dynamic: long }),
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(`recent: ${long}`);
  });

  it('P2: 坊告示牌 voice 一坊一行,拿不到的坊不出行', () => {
    const d = deps({
      houseVoiceOf: (slug: string) => (slug === 'popclaw.world' ? '走出去看看的地方' : ''),
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'a', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0, houseSlug: 'popclaw.world' },
        { platform: 'popclaw', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 99000,
          authorPopclawId: 'B', handle: 'b', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0, houseSlug: 'popclaw.me' },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(stored().houseVoices).toEqual({ 'popclaw.world': '走出去看看的地方' });
  });

  // Slice E: four real-device fixes (same-person backfill / popclaw.me card headers / message links / subscribed houses with no material).

  it('E1: 同一 popclaw_id 的无名条目按 id 回填名字与头像,绝不跨 id', () => {
    const d = deps({
      cache: { recentForReading: () => [
        // Main post: nickname, handle and verified binding provide the most complete record.
        { platform: 'x', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'MUSK', handle: 'elonmusk', actorNickname: 'Elon Musk',
          actorVerified: [{ platform: 'x', handle: 'elonmusk', profileUrl: 'https://x.com/elonmusk', followerCount: 21000000 }],
          originalUrl: '', textPreview: 't', body: '主帖', media: [], replyToAuthorHandle: '',
          replyCount: 0, markCount: 0 },
        // Reply: ingest dropped the entire author-name column, leaving only the ID.
        { platform: 'x', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 99100,
          authorPopclawId: 'MUSK', handle: '', actorNickname: '', actorVerified: [],
          originalUrl: '', textPreview: 't', body: '回帖', media: [], replyToAuthorHandle: '',
          replyCount: 0, markCount: 0 },
        // Another person's unnamed item: absent from the mapping, so retain the unnamed label.
        { platform: 'x', platformPostId: 'p3', eventId: 'e3', platformPostCreatedAt: 99200,
          authorPopclawId: 'GHOST', handle: '', actorNickname: '', actorVerified: [],
          originalUrl: '', textPreview: 't', body: '幽灵帖', media: [], replyToAuthorHandle: '',
          replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload.split(authorOf('Elon Musk')).length - 1).toBe(2); // Both main post and reply are attributed.
    // I3: followers belong to people and appear once in the author directory; backfill still credits both items.
    expect(r.payload.match(/2100 万粉/g)!.length).toBe(1);
    // Since v0.2 even the directory omits avatars; the layout reads them from the issue.
    expect(r.payload).not.toContain('unavatar.io');
    expect(stored().pulse.filter((x) => x.avatarUrl.includes('unavatar.io/twitter/elonmusk'))).toHaveLength(2);
    // GHOST cannot be backfilled: retain the unnamed label and never borrow another person's name.
    expect(
      r.payload.split(authorOf(mat('pulse.unattributed', { platform: 'x' }))).length - 1,
    ).toBe(1);
  });

  it('E1: 备注名（唯一名字链）仍然盖过回填来的名字', () => {
    const d = deps({
      nameOf: (id: string, fallback?: string) => (id === 'MUSK' ? '老马' : (fallback ?? '')),
      cache: { recentForReading: () => [
        { platform: 'x', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'MUSK', handle: 'elonmusk', actorNickname: 'Elon Musk',
          originalUrl: '', textPreview: 't', body: '主帖', media: [], replyToAuthorHandle: '',
          replyCount: 0, markCount: 0 },
        { platform: 'x', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 99100,
          authorPopclawId: 'MUSK', handle: '', actorNickname: '',
          originalUrl: '', textPreview: 't', body: '回帖', media: [], replyToAuthorHandle: '',
          replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload.split(authorOf('老马')).length - 1).toBe(2);
    expect(r.payload).not.toContain(authorOf('Elon Musk'));
  });

  it('E1: 待回也用同一张映射兜底（只报印信 → 名号#印信）', () => {
    const d = deps({
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'ZHU', handle: '', actorNickname: '朱雀', originalUrl: '', textPreview: 't',
          body: '帖', media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
      ] as never },
      inbox: { recent: () => [
        { ts: 99500, fromPopclawId: 'ZHU', body: '在吗', receivedAtMs: 0, toPopclawId: 'me' },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toMatch(/\[1\] 朱雀#\w+: 在吗/);
  });

  it('E2: 卡头主页是 popclaw.me 路径段(名录里),平台主页不再印但仍进白名单', () => {
    const d = deps({
      cache: { recentForReading: () => [
        { platform: 'x', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'MUSK', handle: 'elonmusk', actorNickname: 'Elon Musk',
          originalUrl: 'https://x.com/elonmusk/1', textPreview: 't', body: 't', media: [],
          replyToAuthorHandle: '', replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    const home = stored().pulse[0]!.profileUrl;
    expect(home).toMatch(/^https:\/\/popclaw\.me\/elonmusk\/\w+$/);
    // v0.2: home/platform URLs remain in material for the layout to read; the briefing contains no URLs.
    expect(r.payload).not.toContain('platform page: ');
    const issue = getIssue('tok_test')!;
    const urls = urlsOf(issue);
    expect(urls.has(home)).toBe(true);
    expect(urls.has('https://x.com/elonmusk')).toBe(true); // Links such as the view-original exit are also allowed.
    expect(issue.pulse[0]!.handle).toBe('elonmusk'); // The directory still reports handles (newcomer bios need platform plus followers).
  });

  it('E3: 待回正文里的 http(s) 链接单独成行并进白名单', () => {
    const d = deps({
      inbox: { recent: () => [
        { ts: 99500, fromPopclawId: 'Z', receivedAtMs: 0, toPopclawId: 'me',
          body: '来这儿看看 https://popclaw.world/%E8%92%82%E6%B3%95 还有 http://a.example/x。' },
        { ts: 99400, fromPopclawId: 'Y', body: '没有链接', receivedAtMs: 0, toPopclawId: 'me' },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    const withLinks = stored().pings.filter((x) => x.links?.length);
    expect(withLinks).toHaveLength(1); // A message without links has no links field.
    expect(withLinks[0]!.links).toEqual(['https://popclaw.world/%E8%92%82%E6%B3%95', 'http://a.example/x']);
    const urls = urlsOf(getIssue('tok_test')!);
    expect(urls.has('https://popclaw.world/%E8%92%82%E6%B3%95')).toBe(true);
    expect(urls.has('http://a.example/x')).toBe(true);
  });

  it('E4: 订阅了却零素材的坊也进坊分布(0 条),告示牌照取', () => {
    const d = deps({
      configuredHouseSlugs: ['popclaw-me', 'popclaw-world'],
      houseVoiceOf: (slug: string) => (slug === 'popclaw-world' ? '走出去看看的地方' : ''),
      cache: { recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'A', handle: 'a', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0, houseSlug: 'popclaw-me' },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(
      mat('houseDistribution', {
        counts: [
          mat('houseCount', { slug: 'popclaw-me', count: '1' }),
          mat('houseCount', { slug: 'popclaw-world', count: '0' }),
        ].join(' · '),
      }),
    );
    expect(stored().houseVoices).toEqual({ 'popclaw-world': '走出去看看的地方' });
    expect(stored().byHouse).toEqual({ 'popclaw-me': 1, 'popclaw-world': 0 });
  });

  it('E4: 完全无坊字段的降级不变（不凭配置凭空造坊分布）', () => {
    const d = deps({ configuredHouseSlugs: ['popclaw-me', 'popclaw-world'] });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).not.toContain(mat('houseDistribution', { counts: '' }));
  });

  // Slice F: five fixes for the world section with no new dependencies.

  /**
   * One house-event material item; field names match the fetched world manifest schema verbatim.
   */
  const houseItem = (
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    platform: 'popclaw', platformPostId: 'w1', eventId: 'wevent1234567890',
    platformPostCreatedAt: 99000, authorPopclawId: 'A', handle: 'a', originalUrl: '',
    textPreview: '', body: '', media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
    houseSlug: 'popclaw-world', kind: 'house:world.encounter',
    houseFields: {
      place_name: '山塘街',
      'present.1.figure_name': '小蓝',
      'present.2.owner_popclaw_id': 'OWNER_B',
      scene: '两只在桥头蹲了一会儿',
    },
    ...over,
  });

  it('F1: 坊事件字段原样进素材行，同框者的裸 id 换成名号#印信,url 值进白名单', () => {
    const d = deps({
      nameOf: (id: string) => (id === 'OWNER_B' ? '杜工部' : ''),
      cache: { recentForReading: () => [
        houseItem({ houseFields: {
          place_name: '山塘街',
          'present.2.owner_popclaw_id': 'OWNER_B',
          home_url: 'https://popclaw.world/h/3m8v5x1p',
        } }),
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    const fields = stored().pulse[0]!.houseFields!;
    expect(fields.place_name).toBe('山塘街');
    expect(fields['present.2.owner_popclaw_id']).toMatch(/^杜工部#/);
    expect(JSON.stringify(fields)).not.toContain('OWNER_B'); // Raw IDs must not appear in the layout.
    expect(urlsOf(getIssue('tok_test')!).has('https://popclaw.world/h/3m8v5x1p')).toBe(true);
  });

  it('F1: 没有坊字段的条目一行都不出（不猜、不占位）', () => {
    const r = gatherNewspaperMaterials(deps(), { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(stored().pulse[0]!.houseFields).toBeUndefined();
  });

  it('F2: 非主坊的条目不给围观 url（宁缺勿死链），主坊照旧', () => {
    const d = deps({
      primaryHouseSlug: 'popclaw-me',
      cache: { recentForReading: () => [
        houseItem(),
        { platform: 'popclaw', platformPostId: 'm1', eventId: 'meevent123456', platformPostCreatedAt: 99000,
          authorPopclawId: 'B', handle: 'b', originalUrl: '', textPreview: 't', body: 't', media: [],
          replyToAuthorHandle: '', replyCount: 0, markCount: 0, houseSlug: 'popclaw-me', kind: 'post' },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    const pages = stored().pulse.map((x) => x.postPageUrl);
    expect(pages).toContain('https://popclaw.me/post/meevent123');
    expect(pages).not.toContain('https://popclaw.me/post/wevent1234'); // The world ID does not exist in the primary house.
    expect(urlsOf(getIssue('tok_test')!).has('https://popclaw.me/post/wevent1234')).toBe(false);
  });

  it('F3: 坊官方来信从待回分流成【世界来信】,正文放宽到 400 字、图与链接分列', () => {
    const body = `小家伙从「苏州」回来啦 ${'记'.repeat(200)} 图 https://cdn.example/pc.jpg 背面 https://popclaw.world/h/3m8v5x1p`;
    const d = deps({
      configuredHouseSlugs: ['popclaw-world'],
      houseOfficialIds: (slug: string) => (slug === 'popclaw-world' ? ['STAGE'] : []),
      inbox: { recent: () => [
        { ts: 99500, fromPopclawId: 'STAGE', toPopclawId: 'me', body, receivedAtMs: 0 },
        { ts: 99400, fromPopclawId: 'HUMAN', toPopclawId: 'me', body: '在？', receivedAtMs: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(
      mat('pings.head', { count: '1', letters: mat('pings.letters', { count: '1' }) }),
    );
    // World correspondence is handled by the layout, not the briefing; house attribution, images and links are on the issue.
    const letter = stored().houseLetters![0]!;
    expect(letter.houseSlug).toBe('popclaw-world');
    expect(letter.imageLinks).toEqual(['https://cdn.example/pc.jpg']);
    expect(letter.links).toEqual(['https://popclaw.world/h/3m8v5x1p']);
    expect(letter.body).toContain('记'.repeat(100)); // The body beyond the 80-character preview is also present.
    // Splitting routes must not lose accounting: each count stays in its own place, and both layout sections use it.
    expect([stored().pings.length, stored().houseLetters!.length]).toEqual([1, 1]);
    expect(urlsOf(getIssue('tok_test')!).has('https://cdn.example/pc.jpg')).toBe(true);
  });

  it('F3: 不注入 official_ids = 老行为（坊来信照旧占待回）', () => {
    const d = deps({
      inbox: { recent: () => [
        { ts: 99500, fromPopclawId: 'STAGE', toPopclawId: 'me', body: '迎新信', receivedAtMs: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain(mat('pings.head', { count: '1', letters: '' }));
    expect(stored().houseLetters ?? []).toHaveLength(0);
  });

  it('F4②: 当日一程 → 门楣二级,门牌取素材里坊自报的 home_url', () => {
    const d = deps({
      configuredHouseSlugs: ['popclaw-world'],
      cache: { recentForReading: () => [
        houseItem({ kind: 'house:world.trip', houseFields: {
          'figure.figure_name': '小蓝', phase: 'returned', place_name: '苏州',
        } }),
        houseItem({ platformPostId: 'w2', eventId: 'w2', kind: 'house:world.embodiment',
          houseFields: { home_url: 'https://popclaw.world/h/3m8v5x1p' } }),
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    // v0.2: this masthead line goes directly into the layout and must be a sentence; layout rules section 8 explicitly
    // prohibit internal field names on the page. Material stays `phase=returned · place_name=...`; sentence construction happens here.
    expect(stored().mantles).toEqual([
      {
        houseSlug: 'popclaw-world',
        level: 2,
        text: mat('trip.returned', { who: '小蓝', place: '苏州' }),
        url: 'https://popclaw.world/h/3m8v5x1p',
      },
    ]);
  });

  it('F4③: 没有当日一程 → 退到最近一封坊来信（跨窗口,必带日期）', () => {
    const d = deps({
      language: 'zh-CN',
      configuredHouseSlugs: ['popclaw-world'],
      houseOfficialIds: () => ['STAGE'],
      // An old message outside the 24-hour window (now=100000): only the masthead can use it.
      inbox: { recent: () => [
        { ts: 1000, fromPopclawId: 'STAGE', toPopclawId: 'me', body: '小家伙从女木岛回来了', receivedAtMs: 0 },
      ] as never },
      cache: { recentForReading: () => [houseItem({ houseFields: { place_name: '山塘街' } })] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    const mantle = stored().mantles![0]!;
    expect(mantle.level).toBe(3);
    expect(mantle.dateLabel).toBeTruthy(); // Material from outside the window must include a date.
    expect(mantle.text).toContain('小家伙从女木岛回来了');
    expect(r.payload).not.toContain(mat('letters.head', { count: '1' })); // Out-of-window messages do not enter the section, only the masthead.
  });

  it('F4④: 什么都没有 → 退到坊门卡；⑤ 连门卡都没有 → 门楣整行不出', () => {
    const withEntry = deps({
      configuredHouseSlugs: ['popclaw-world'],
      houseEntryOf: (slug: string) =>
        slug === 'popclaw-world'
          ? { headline: '捏一个你自己的公仔，它替你去旅行', home: 'https://popclaw.world/', firstMove: '带我进世界' }
          : undefined,
      cache: { recentForReading: () => [houseItem({ houseFields: { place_name: '山塘街' } })] as never },
    });
    const r = gatherNewspaperMaterials(withEntry, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(stored().mantles).toEqual([
      {
        houseSlug: 'popclaw-world',
        level: 4,
        text: `捏一个你自己的公仔，它替你去旅行 · ${mat('doorCard.firstMove', { phrase: '带我进世界' })}`,
        url: 'https://popclaw.world/',
      },
    ]);
    expect(urlsOf(getIssue('tok_test')!).has('https://popclaw.world/')).toBe(true);

    _resetIssuesForTest();
    const bare = gatherNewspaperMaterials(
      deps({ cache: { recentForReading: () => [houseItem({ houseFields: { place_name: '山塘街' } })] as never } }),
      { hours: 24 },
    );
    if (bare.kind !== 'ready') throw new Error('want ready');
    expect(stored().mantles).toBeUndefined(); // Level 5 omits the whole masthead line.
  });

  it('feeds the original body, not the 280 preview, into the materials', () => {
    const longBody = '城西西瓜很便宜，' + 'A'.repeat(300);
    const d = deps({
      cache: {
        recentForReading: () => [
          { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
            authorPopclawId: 'A', handle: 'blackfeather', originalUrl: '', textPreview: longBody.slice(0, 280),
            body: longBody, media: [], replyToAuthorHandle: '', replyCount: 0 },
        ] as never,
      },
    });
    const res = gatherNewspaperMaterials(d, { hours: 24 });
    expect(res.kind).toBe('ready');
    // The briefing receives the body itself, not the 280-character preview (the v0.2 brief budget is 400 characters, still larger).
    if (res.kind === 'ready') expect(res.payload).toContain(longBody);
  });
});

/**
 * B1/B2 (ADR-0045): masthead dates and today's window both use the owner's local calendar day.
 */
describe('gatherNewspaperMaterials — 主人本地日切', () => {
  beforeEach(() => {
    _resetIssuesForTest();
    setOwnerTz(undefined);
  });
  afterEach(() => setOwnerTz(undefined));

  /**
   * 2026-07-30T20:30:00Z: Shanghai is already 7/31 04:30; Los Angeles is still 7/30 13:30.
   */
  const NOW = Math.floor(Date.UTC(2026, 6, 30, 20, 30) / 1000);
  const at = (ts: number): Partial<GatherDeps> => ({
    now: () => NOW,
    cache: {
      recentForReading: () => [
        { platform: 'popclaw', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: ts,
          authorPopclawId: 'A', handle: 'a', originalUrl: '', textPreview: 't', body: 't',
          media: [], replyToAuthorHandle: '', replyCount: 0 },
      ] as never,
    },
  });

  it('报头日期用主人时区 + cadence 的语言（不再写死 zh-CN/Asia/Shanghai）', () => {
    setOwnerTz('America/Los_Angeles');
    const r = gatherNewspaperMaterials(deps({ ...at(NOW - 60), language: 'en-US' }), {});
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain('July 30, 2026');

    _resetIssuesForTest();
    setOwnerTz('Asia/Shanghai');
    const zh = gatherNewspaperMaterials(deps({ ...at(NOW - 60), language: 'zh-CN' }), {});
    if (zh.kind !== 'ready') throw new Error('want ready');
    expect(zh.payload).toContain('2026年7月31日');
  });

  it('不传 hours = 真日切：本地 0 点之前的东西不算今天', () => {
    setOwnerTz('Asia/Shanghai'); // Local 7/31 00:00 equals 2026-07-30T16:00Z.
    const beforeMidnight = Math.floor(Date.UTC(2026, 6, 30, 15, 50) / 1000);
    expect(gatherNewspaperMaterials(deps(at(beforeMidnight)), {}).kind).toBe('empty');

    _resetIssuesForTest();
    const afterMidnight = Math.floor(Date.UTC(2026, 6, 30, 16, 10) / 1000);
    expect(gatherNewspaperMaterials(deps(at(afterMidnight)), {}).kind).toBe('ready');
  });

  it('显式 hours = 滚动窗逃生门（本地 0 点之前的照样收）', () => {
    setOwnerTz('Asia/Shanghai');
    const beforeMidnight = Math.floor(Date.UTC(2026, 6, 30, 15, 50) / 1000);
    const r = gatherNewspaperMaterials(deps(at(beforeMidnight)), { hours: 24 });
    expect(r.kind).toBe('ready');
    // Wording follows the window: a rolling window must not call itself today.
    if (r.kind === 'ready') expect(r.payload).toContain('gathered in the last 24 hours');
  });

  it('日切窗口的措辞才是「今天」', () => {
    setOwnerTz('Asia/Shanghai');
    const r = gatherNewspaperMaterials(deps(at(NOW - 60)), {});
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload).toContain('gathered today');
  });

  it('空素材的措辞也跟着窗口走', () => {
    const empty = { cache: { recentForReading: () => [] as never } };
    const day = gatherNewspaperMaterials(deps(empty), {});
    const roll = gatherNewspaperMaterials(deps(empty), { hours: 48 });
    if (day.kind !== 'empty' || roll.kind !== 'empty') throw new Error('want empty');
    expect(day.message).toBe(renderCopy('en', 'newspaper.empty.today'));
    expect(roll.message).toBe(renderCopy('en', 'newspaper.empty.window', { hours: '48' }));
  });
});

describe('I5: 正文预算与条数上限', () => {
  beforeAll(() => setOwnerLang('zh-CN', 'config'));
  afterAll(() => setOwnerLang(undefined));
  beforeEach(() => _resetIssuesForTest());

  const long = (n: number): string => '字'.repeat(n);
  function one(over: Record<string, unknown>): string {
    const d = deps({
      cache: { recentForReading: () => [{
        handle: 'elonmusk', textPreview: 't', body: long(4000), media: [],
        replyToAuthorHandle: '', replyCount: 0, markCount: 0, platform: 'x',
        platformPostCreatedAt: 99000, eventId: 'e1', platformPostId: 'p1',
        authorPopclawId: 'A', originalUrl: 'https://x.com/elonmusk/1',
        ...over,
      }] as never },
      ...(over.bondTier ? { bondOf: () => ({ tier: over.bondTier as BondTier, remarkName: '' }) } : {}),
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    return stored().pulse[0]!.text;
  }

  // v0.2: budgets follow density tiers. Brief items need only a sentence or two; 1200 characters belonged to the prior version,
  // when the model also handled layout and could promote an item. Now gather chooses the tier and layout follows the same decision.
  it('简讯档保留完整写作原文', () => {
    const text = one({});
    expect(text).not.toContain('…');
    expect(text.match(/字/g)!.length).toBe(4000);
  });

  it('人物卡也保留完整写作原文', () => {
    expect(one({ media: [{ url: 'https://img/a.jpg' }] }).match(/字/g)!.length).toBe(4000);
    expect(one({ markCount: 4, replyCount: 1 }).match(/字/g)!.length).toBe(4000);
    expect(one({ bondTier: 'friend' }).match(/字/g)!.length).toBe(4000);
  });

  it('短正文原样,不加省略号', () => {
    expect(one({ body: '就这一句' })).toBe('就这一句');
  });

  it('读取不设上限：窗口里有多少条,候选页就摆多少条', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      handle: `u${i}`, textPreview: 't', body: 'b', media: [], replyToAuthorHandle: '',
      replyCount: 0, markCount: 0, platform: 'x', platformPostCreatedAt: 99000 + i,
      eventId: `e${i}`, platformPostId: `p${i}`, authorPopclawId: `A${i}`, originalUrl: '',
    }));
    const r = gatherRaw(deps({ cache: { recentForReading: () => many as never } }), { hours: 24 });
    if (r.kind !== 'candidates') throw new Error('want candidates');
    // Keep all 100 items. Old behavior used slice(0, 80); on 2026-08-26 the owner rejected making output count depend on how much was read.
    expect(getIssue(r.candidateToken)!.pulse.length).toBe(100);
    // The candidate page must still fit one host message (64,000 weighted units for models with context >=200k).
    expect(weightedChars(r.payload) * 1.013).toBeLessThan(64_000);
  });

  // Host tool-result budget (real device, 2026-08-25): if payload exceeds the single-result limit,
  // the host truncates the middle without notifying the tool. These tests enforce our side: never return an over-budget payload.
  describe('payload budget', () => {
    /**
     * N material items with long Chinese bodies; each Chinese character costs four units, so a few
     * can exceed the budget.
     */
    const bulky = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        handle: `u${i}`, textPreview: 't', body: '甲'.repeat(600), media: [],
        replyToAuthorHandle: '', replyCount: 0, markCount: 0, platform: 'x',
        platformPostCreatedAt: 99000 + i, eventId: `e${i}`, platformPostId: `p${i}`,
        authorPopclawId: `A${i}`, originalUrl: '',
      }));
    const gather = (n: number) =>
      gatherNewspaperMaterials(
        deps({ cache: { recentForReading: () => bulky(n) as never } }),
        { hours: 24 },
      );
    /**
     * Actual number of material items in the payload (the `[N] 作者: ...` lines).
     */
    const itemCount = (payload: string): number => payload.match(/\n\[\d+\] /g)?.length ?? 0;

    it('加权字符：ASCII 一个算一个，中文一个算四个', () => {
      expect(weightedChars('abcd')).toBe(4);
      expect(weightedChars('中文')).toBe(8);
      expect(weightedChars('a中')).toBe(5);
      expect(weightedChars('')).toBe(0);
    });

    it('素材撑爆单页预算时保留完整一期并给续读位置', () => {
      const r = gather(80);
      if (r.kind !== 'ready') throw new Error('want ready');
      // One page must fit the host's measured message limit (64,000 for context >=200k).
      // This controls each serving, not the whole issue; selection tiers determine item counts.
      expect(weightedChars(r.payload) * 1.013).toBeLessThan(64_000);
      // All 80 originals stay in the ledger; this source weight gives five complete bodies in the current packet.
      expect(stored().pulse).toHaveLength(80);
      expect(r.payload).toContain('page_cursor=');
      expect(stored().pulse.every(p => p.text === '甲'.repeat(600))).toBe(true);
      expect(r.payload).toContain('[Current writing packet: [1] [2] [3] [4] [5]]');
      const document = readNewspaperDocument('tok_test').text;
      expect(document).toContain(mat('pulse.head', { count: '5' }));
      expect(document).not.toContain(mat('pulse.head', { count: '80' }));
      expect(document).toContain(mat('pulse.author', { i: '80', who: 'u79' }));
    });

    it('砍的时候先砍无署名的 —— 有人的条目留到最后（铁律②：不许有没有人的新闻）', () => {
      // 200 newer unnamed items precede 20 older named items; recency-only trimming would remove every named author.
      // Candidate rows show only 80-character previews, so many rows are needed to exceed one page.
      const feed = [
        ...Array.from({ length: 200 }, (_, i) => ({
          handle: '', textPreview: 't', body: '甲'.repeat(600), media: [],
          replyToAuthorHandle: '', replyCount: 0, markCount: 0, platform: 'x',
          platformPostCreatedAt: 99900 - i, eventId: `n${i}`, platformPostId: `n${i}`,
          authorPopclawId: '', originalUrl: '',
        })),
        ...Array.from({ length: 20 }, (_, i) => ({
          handle: `star${i}`, textPreview: 't', body: '甲'.repeat(600), media: [],
          replyToAuthorHandle: '', replyCount: 0, markCount: 0, platform: 'x',
          platformPostCreatedAt: 99000 - i, eventId: `s${i}`, platformPostId: `s${i}`,
          authorPopclawId: `S${i}`, originalUrl: '',
        })),
      ];
      const r = gatherRaw(deps({ cache: { recentForReading: () => feed as never } }), { hours: 24 });
      if (r.kind !== 'candidates') throw new Error('want candidates');
      expect(getIssue(r.candidateToken)!.pulse.length).toBe(220);
      // Ordering stays fixed: exhaust unnamed items first, leaving named items.
      // The tighter budget and 600-character items can also require trimming named items,
      // but only after all unnamed items are gone; that invariant is unchanged.
      // All 20 named items remain; every removed item is unnamed.
      for (let i = 0; i < 20; i += 1) expect(getIssue(r.candidateToken)!.pulse.some(p => p.author === `star${i}`)).toBe(true);
      expect(r.payload).toContain('page_cursor=');
      expect(weightedChars(r.payload) * 1.013).toBeLessThan(64_000);
    });

    it('素材不多时一条都不砍', () => {
      const r = gather(3);
      if (r.kind !== 'ready') throw new Error('want ready');
      expect(weightedChars(r.payload) * 1.013).toBeLessThan(64_000);
      expect(itemCount(r.payload)).toBe(3);
      expect(r.payload).toContain(mat('pulse.head', { count: '3' }));
    });
  });
});
