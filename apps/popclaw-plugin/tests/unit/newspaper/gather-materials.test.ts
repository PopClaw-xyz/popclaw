import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  gatherNewspaperMaterials as gatherRaw,
  weightedChars,
  type GatherDeps,
} from '../../../src/newspaper/gather-materials.js';
import { tierLabel, type BondTier } from '../../../src/bonds/bond-tier.js';
import { renderCopy } from '../../../src/lexicon/index.js';

// D8：素材机械槽的断言调同一个渲染函数算预期值，不抄字面量。
const mat = (key: string, vars: Record<string, string> = {}): string =>
  renderCopy('zh-CN', `newspaper.material.${key}`, vars);
/** `作者: <称呼>` —— 数出现次数时用，不带 `[N] ` 的行号。 */
const authorOf = (who: string): string => mat('pulse.author', { i: '1', who }).replace('[1] ', '');
/** The fixed literal text before a template's first `{var}` — a block-presence/count check independent of which value fills it in. */
const matPrefix = (key: string): string => mat(key).split('{')[0]!;
import { getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
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
 * 两步协议下的「一步」壳：候选页 → 全选 → 素材页。
 * 旧断言量的都是素材页的内容（编号、作者头、灯坊分布…），协议变了但那些不变量没变，
 * 所以用这个壳把两步并回一步，逐条断言原样保留。挑选本身（每人上限、picks 校验）
 * 有自己的用例，不在这批里。
 */
function gatherNewspaperMaterials(d: GatherDeps, o: { hours?: number } = {}): GatherResult {
  const r = gatherRaw(d, o);
  if (r.kind !== 'candidates') return r;
  const all = getIssue(r.candidateToken)!.pulse.map((_, i) => i + 1);
  const picked = buildIssueFromPicks(r.candidateToken, all, {
    mintToken: d.mintToken,
    contentRules: d.readContentRules?.() ?? '',
    leadMax: d.readStyle?.().leadMax ?? 3,
    perAuthorMax: Number.MAX_SAFE_INTEGER, // 这批用例量的不是上限
    // 这个夹具把全部候选原样交回,不该让"挑不够按热闹补齐"那条掺进来。
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
  // build-newspaper-prompt.ts 的 bondLines() 档位标签走 tierLabel()，默认
  // ownerLang() —— 钉死 zh-CN，这批断言检查的是迁移前的产线中文原文（零回归）。
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

  // ——— 改版切片 A：P0 坊/kind 透传 + P1 交情本 ———

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
    expect(r.payload).toContain('**1 items** gathered'); // totalCount 也只算进了报纸的
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
    // v0.2：不再另存一份 stats —— 社交日志那本账直接从 issue 推，两处不可能对不上。
    const issue = stored();
    expect(issue.totalCount).toBe(1);
    expect(issue.pings).toHaveLength(1);
    expect(issue.byHouse).toEqual({ 'popclaw.me': 1 });
    expect(issue.dateLabel).toContain('1970');
  });

  // ——— 改版切片 B+C：P4 荐因素材 / P5 新人标 / P1 尾巴近况 / P2 告示牌 / P3 出场人物 ———

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
        // 已关注的 F 回了 A 的帖 → A 那条应出荐因
        { platform: 'popclaw', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 99100,
          authorPopclawId: 'F', handle: 'f', originalUrl: '', textPreview: 't', body: '回帖',
          media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
          replyToPostId: 'p1', replyToAuthorPopclawId: 'A' },
        // 未关注的 U 回了 B 的帖 → 不算路径
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
    expect(r.payload).toContain(mat('cast.newcomer', { days: '3' })); // 98→100 天 = 第 3 天
    // OLD 不出：数的是新人标前缀的出现次数，不绑死某一个具体天数
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
    expect(r.payload).toContain(`recent: ${'长'.repeat(60)}…`);
    expect(r.payload).not.toContain('长'.repeat(61));
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

  // ——— 切片 E：真机四修（同人回填 / popclaw.me 卡头 / 信内链接 / 订阅坊零素材） ———

  it('E1: 同一 popclaw_id 的无名条目按 id 回填名字与头像,绝不跨 id', () => {
    const d = deps({
      cache: { recentForReading: () => [
        // 主帖：有名字、有 handle、有认证绑定（信息最全的一条）
        { platform: 'x', platformPostId: 'p1', eventId: 'e1', platformPostCreatedAt: 99000,
          authorPopclawId: 'MUSK', handle: 'elonmusk', actorNickname: 'Elon Musk',
          actorVerified: [{ platform: 'x', handle: 'elonmusk', profileUrl: 'https://x.com/elonmusk', followerCount: 21000000 }],
          originalUrl: '', textPreview: 't', body: '主帖', media: [], replyToAuthorHandle: '',
          replyCount: 0, markCount: 0 },
        // 回帖：ingest 把作者名整列丢了 → 只有 id
        { platform: 'x', platformPostId: 'p2', eventId: 'e2', platformPostCreatedAt: 99100,
          authorPopclawId: 'MUSK', handle: '', actorNickname: '', actorVerified: [],
          originalUrl: '', textPreview: 't', body: '回帖', media: [], replyToAuthorHandle: '',
          replyCount: 0, markCount: 0 },
        // 另一个人的无名条目：映射里没有他 → 照旧「(无署名)」
        { platform: 'x', platformPostId: 'p3', eventId: 'e3', platformPostCreatedAt: 99200,
          authorPopclawId: 'GHOST', handle: '', actorNickname: '', actorVerified: [],
          originalUrl: '', textPreview: 't', body: '幽灵帖', media: [], replyToAuthorHandle: '',
          replyCount: 0, markCount: 0 },
      ] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    expect(r.payload.split(authorOf('Elon Musk')).length - 1).toBe(2); // 主帖 + 回帖都署上名
    // I3：粉丝属于人 → 只在作者名录里出现一次（回填照旧，两条素材都署得上名）
    expect(r.payload.match(/2100 万粉/g)!.length).toBe(1);
    // 头像 v0.2 起连名录都不印了 —— 版面自己去 issue 里取
    expect(r.payload).not.toContain('unavatar.io');
    expect(stored().pulse.filter((x) => x.avatarUrl.includes('unavatar.io/twitter/elonmusk'))).toHaveLength(2);
    // GHOST 回填不到 → 照旧「(无署名)」，绝不借别人的名字
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
    // v0.2：主页/平台主页都只在素材里，版面自己取；简报一个 URL 都不给
    expect(r.payload).not.toContain('platform page: ');
    const issue = getIssue('tok_test')!;
    const urls = urlsOf(issue);
    expect(urls.has(home)).toBe(true);
    expect(urls.has('https://x.com/elonmusk')).toBe(true); // 「↗ 查看原文」类出口也放行
    expect(issue.pulse[0]!.handle).toBe('elonmusk'); // 名录仍报 handle(新人小传要用「平台 + 粉丝」)
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
    expect(withLinks).toHaveLength(1); // 没链接的那封不带 links
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

  // ——— 切片 F：world 叠零依赖五修 ———

  /** 一条坊事件素材（字段名逐字取自实拉的 world 告示牌 schema）。 */
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
    expect(JSON.stringify(fields)).not.toContain('OWNER_B'); // 裸 id 不上版面
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
    expect(pages).not.toContain('https://popclaw.me/post/wevent1234'); // world 的 id 在主坊不存在
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
    // 世界来信由版面排，不进简报 —— 它的坊归属、图、链接都在 issue 上
    const letter = stored().houseLetters![0]!;
    expect(letter.houseSlug).toBe('popclaw-world');
    expect(letter.imageLinks).toEqual(['https://cdn.example/pc.jpg']);
    expect(letter.links).toEqual(['https://popclaw.world/h/3m8v5x1p']);
    expect(letter.body).toContain('记'.repeat(100)); // 80 字预览之外的正文也在
    // 分流不许变成漏账：两个数各归各位，版面两处照它印
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
    // v0.2：门楣这一行直接上版面了,所以它必须是一句话 —— 版式法典 §八 明写
    // 「内部字段名不上版面」。素材仍是 `phase=returned · place_name=…`,成句在这里做。
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
      // 窗口外（now=100000，窗口 24h）的一封老信：只有门楣够得着它。
      inbox: { recent: () => [
        { ts: 1000, fromPopclawId: 'STAGE', toPopclawId: 'me', body: '小家伙从女木岛回来了', receivedAtMs: 0 },
      ] as never },
      cache: { recentForReading: () => [houseItem({ houseFields: { place_name: '山塘街' } })] as never },
    });
    const r = gatherNewspaperMaterials(d, { hours: 24 });
    if (r.kind !== 'ready') throw new Error('want ready');
    const mantle = stored().mantles![0]!;
    expect(mantle.level).toBe(3);
    expect(mantle.dateLabel).toBeTruthy(); // 跨窗口的素材必带日期
    expect(mantle.text).toContain('小家伙从女木岛回来了');
    expect(r.payload).not.toContain(mat('letters.head', { count: '1' })); // 窗口外的信不进栏目，只够门楣
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
    expect(stored().mantles).toBeUndefined(); // ⑤ 级 = 门楣整行不出
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
    // 简报给的是正文本身而不是那 280 字预览（v0.2 的简讯档预算是 400 字，仍宽于预览）。
    if (res.kind === 'ready') expect(res.payload).toContain(longBody);
  });
});

/** B1/B2（ADR-0045）：报头日期与「今天」的窗口都按主人本地日历日。 */
describe('gatherNewspaperMaterials — 主人本地日切', () => {
  beforeEach(() => {
    _resetIssuesForTest();
    setOwnerTz(undefined);
  });
  afterEach(() => setOwnerTz(undefined));

  /** 2026-07-30T20:30:00Z —— 上海已是 7/31 04:30，洛杉矶还是 7/30 13:30。 */
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
    setOwnerTz('Asia/Shanghai'); // 本地 7/31 00:00 = 2026-07-30T16:00Z
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
    // 措辞跟着窗口走：滚动窗不许再自称「今天」。
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
  /** Where the material page's closing sentinel starts (`newspaper.material.batch.sentinel`). */
  const SENTINEL_HEAD = '[popclaw] END OF MATERIAL PAGE';
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
    const tail = r.payload.slice(r.payload.lastIndexOf(`    ${mat('pulse.body', { text: '' })}`));
    // Only the body. Since 2026-09-13 the page closes with a batch sentinel, which is the
    // page's own tail marker and has nothing to do with how a body renders — the thing
    // every assertion in this block is about.
    const closing = tail.indexOf(SENTINEL_HEAD);
    return (closing < 0 ? tail : tail.slice(0, closing)).replace(/\n+$/, '');
  }

  // v0.2：预算跟着密度档走 —— 简讯只写一两句,喂它 1200 字是上一版的形状,
  // 那时模型还兼排版、可能自己把一条提档。现在档位由 gather 定、版面照排,两边同一个决定。
  it('简讯档砍到 400 字并带省略号', () => {
    const text = one({});
    expect(text).toContain('…');
    expect(text.match(/字/g)!.length).toBe(400);
  });

  it('有配图 / 计数显著 / 交情好友以上 → 人物卡档 1600 字', () => {
    expect(one({ media: [{ url: 'https://img/a.jpg' }] }).match(/字/g)!.length).toBe(1600);
    expect(one({ markCount: 4, replyCount: 1 }).match(/字/g)!.length).toBe(1600);
    expect(one({ bondTier: 'friend' }).match(/字/g)!.length).toBe(1600);
  });

  it('短正文原样,不加省略号', () => {
    expect(one({ body: '就这一句' })).toBe(`    ${mat('pulse.body', { text: '就这一句' })}`);
  });

  it('读取不设上限：窗口里有多少条,候选页就摆多少条', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      handle: `u${i}`, textPreview: 't', body: 'b', media: [], replyToAuthorHandle: '',
      replyCount: 0, markCount: 0, platform: 'x', platformPostCreatedAt: 99000 + i,
      eventId: `e${i}`, platformPostId: `p${i}`, authorPopclawId: `A${i}`, originalUrl: '',
    }));
    const r = gatherRaw(deps({ cache: { recentForReading: () => many as never } }), { hours: 24 });
    if (r.kind !== 'candidates') throw new Error('want candidates');
    // 100 条一条不落 —— 旧行为是 slice(0, 80)，主人 2026-08-26 否掉了「读了多少就放多少」。
    expect(getIssue(r.candidateToken)!.pulse.length).toBe(100);
    // 但候选页本身要塞得进宿主一条消息（≥200k 模型 64,000 加权）。
    expect(weightedChars(r.payload) * 1.013).toBeLessThan(64_000);
  });

  // ——— Host tool-result budget (2026-08-25 真机)：payload 超过宿主单条工具返回上限，
  // 宿主会**砍中间**且不通知工具。这一组测的是「我们永远不递超预算的东西」这一侧的契约。
  describe('payload budget', () => {
    /** N 条素材，每条正文都是长中文 —— 中文每字算 4 个单位，几条就能顶穿预算。 */
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
    /** payload 里真实出现的素材条目数（`[N] 作者: …` 那些行）。 */
    const itemCount = (payload: string): number => payload.match(/\n\[\d+\] /g)?.length ?? 0;

    it('加权字符：ASCII 一个算一个，中文一个算四个', () => {
      expect(weightedChars('abcd')).toBe(4);
      expect(weightedChars('中文')).toBe(8);
      expect(weightedChars('a中')).toBe(5);
      expect(weightedChars('')).toBe(0);
    });

    it('素材撑爆预算时砍条目，payload 落回预算内', () => {
      const r = gather(80);
      if (r.kind !== 'ready') throw new Error('want ready');
      // 单页塞得进宿主一条消息的上限（≥200k 模型是 64,000，量到多少用多少）。
      // ⚠️ 这是「一口给多少」不是「一顿吃多少」——条数由挑选阶梯定，不由这个数定。
      expect(weightedChars(r.payload) * 1.013).toBeLessThan(64_000);
      // 砍过了，而且素材段头那句「共 N 条」与真实条目数对得上（不许砍了却还报 80）。
      const n = itemCount(r.payload);
      expect(n).toBeGreaterThanOrEqual(12); // MIN_PULSE
      expect(n).toBeLessThan(80);
      expect(r.payload).toContain(mat('pulse.head', { count: String(n) }));
    });

    it('砍的时候先砍无署名的 —— 有人的条目留到最后（铁律②：不许有没有人的新闻）', () => {
      // 200 条无署名在前（更新）、20 条有署名在后（更旧）—— 纯按新旧砍会把有人的全砍光。
      // （候选页一行只放 80 字预览，所以要够多条才撑爆一页。）
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
      expect(getIssue(r.candidateToken)!.pulse.length).toBeLessThan(220); // 候选页放不下,砍过了
      // 顺序不变：无署名的先走光，剩下的全是有人的条目。
      // （预算比从前紧，条目又是 600 字的大块头，所以有署名的也会被砍到——
      //  但永远是无署名的先死光，这条铁律没让。）
      // 20 个有署名的一个不少；被砍掉的全是无署名的。
      for (let i = 0; i < 20; i += 1) expect(r.payload).toContain(`star${i}`);
      expect(weightedChars(r.payload) * 1.013).toBeLessThan(64_000);
    });

    it('素材不多时一条都不砍', () => {
      const r = gather(3);
      if (r.kind !== 'ready') throw new Error('want ready');
      expect(weightedChars(r.payload) * 1.013).toBeLessThan(16_000);
      expect(itemCount(r.payload)).toBe(3);
      expect(r.payload).toContain(mat('pulse.head', { count: '3' }));
    });
  });
});
