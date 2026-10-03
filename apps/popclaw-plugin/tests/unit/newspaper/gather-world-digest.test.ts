/**
 * 切片 G — 坊 digest 接进报纸：门楣①级、「值得一逛的家」、家书标头。
 * 素材形状逐字取自 2026-07-31 实拉的 popclaw.world `/api/popclaw/digest`。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { gatherNewspaperMaterials as gatherRaw, type GatherDeps } from '../../../src/newspaper/gather-materials.js';
import type { WorldDigest } from '../../../src/world/digest-client.js';
import { buildIssueFromPicks } from '../../../src/newspaper/pick-issue.js';
import { getIssue, _resetIssuesForTest } from '../../../src/newspaper/issue-store.js';
import { urlsOf } from './_issue-fixture.js';
import type { HomeSection, HouseLetterItem, IssueData, MantleItem } from '../../../src/newspaper/issue.js';
import { setOwnerTz } from '../../../src/time/time-context.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { renderCopy } from '../../../src/lexicon/index.js';

// D8：素材机械槽的断言调同一个渲染函数算预期值（deps 里钉的是 zh-CN 主人）。
const mat = (key: string, vars: Record<string, string> = {}): string =>
  renderCopy('zh-CN', `newspaper.material.${key}`, vars);

const NOW = 100000;

/** 一条 world 坊素材（有它才有 world 叠）。 */
const worldItem = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  platform: 'popclaw', platformPostId: 'w1', eventId: 'wevent1234567890',
  platformPostCreatedAt: 99000, authorPopclawId: 'A', handle: 'a', originalUrl: '',
  textPreview: '', body: '', media: [], replyToAuthorHandle: '', replyCount: 0, markCount: 0,
  houseSlug: 'popclaw-world', kind: 'house:world.encounter',
  houseFields: { place_name: '山塘街' },
  ...over,
});

function deps(over: Partial<GatherDeps> = {}): GatherDeps {
  return {
    cache: { recentForReading: () => [worldItem()] as never },
    inbox: { recent: () => [] as never },
    readContentRules: () => '',
    ownerNickname: 'Yu',
    webBaseUrl: 'https://popclaw.me',
    now: () => NOW,
    mintToken: () => 'tok_test',
    isFollowing: () => false,
    language: 'zh-CN',
    configuredHouseSlugs: ['popclaw-world'],
    ...over,
  };
}

const digest = (over: Partial<WorldDigest> = {}): WorldDigest => ({
  as_of: '2026-07-31T07:04:00.117Z',
  ranking_basis: '按小屋落成时间倒序（世界刚开张，到访数尚无区分度，不以其排序）',
  figures: [
    { figure: '蒂法', state: 'home', visit_url: 'https://popclaw.world/h/7t4k2n9q' },
  ],
  homes: [],
  ...over,
});

const withDigest = (d: WorldDigest, over: Partial<GatherDeps> = {}): GatherDeps =>
  deps({ digestOf: (slug) => (slug === 'popclaw-world' ? d : undefined), ...over });

/**
 * v0.2：门楣与「值得一逛的家」由版面照素材排，不再念给模型听 —— 所以这些断言
 * 落在 gather 存下的那份 issue 上，而不是简报文本上。措辞槽还是同一批词表键。
 */
function issueOf(d: GatherDeps): IssueData {
  const r = gatherNewspaperMaterials(d, { hours: 24 });
  if (r.kind !== 'ready') throw new Error('want ready');
  return getIssue('tok_test')!;
}
const mantleOf = (i: IssueData): MantleItem | undefined => i.mantles?.[0];
/** 「值得一逛的家」第一张卡上的主人称呼 —— 名字链那一串断言全落在这一格上。 */
const ownerOf = (d: GatherDeps): string => homesOf(issueOf(d))!.homes[0]!.owner;
/** 第一封坊来信（世界来信栏的素材）。 */
const letterOf = (d: GatherDeps): HouseLetterItem => issueOf(d).houseLetters![0]!;
const homesOf = (i: IssueData): HomeSection | undefined => i.homeSections?.[0];

beforeEach(() => {
  _resetIssuesForTest();
  setOwnerTz('Asia/Shanghai');
});
afterEach(() => setOwnerTz(undefined));


/** 两步协议壳：候选页 → 全选 → 素材页（见 gather-materials.test.ts 里的同名壳）。 */
function gatherNewspaperMaterials(
  d: GatherDeps,
  o: { hours?: number } = {},
): { kind: 'empty'; message: string } | { kind: 'ready'; payload: string; publishToken: string } {
  const r = gatherRaw(d, o);
  if (r.kind !== 'candidates') return r;
  const all = getIssue(r.candidateToken)!.pulse.map((_, i) => i + 1);
  const picked = buildIssueFromPicks(r.candidateToken, all, {
    mintToken: d.mintToken,
    contentRules: d.readContentRules?.() ?? '',
    leadMax: d.readStyle?.().leadMax ?? 3,
    perAuthorMax: Number.MAX_SAFE_INTEGER,
    // This harness hands every candidate straight through; no top-up should interfere.
    floor: 0,
    topUpTo: 0,
  });
  if (picked.kind !== 'ready') throw new Error(picked.message);
  return { kind: 'ready', payload: picked.payload, publishToken: picked.publishToken };
}

describe('G2 门楣①级 — 坊 digest 的实况', () => {
  it('home → 「在家」+ 门牌，必带 as_of，压过②级', () => {
    const i = issueOf(
      withDigest(digest(), {
        // ②级的素材同时在场：①级取到就该把它压下去。
        cache: { recentForReading: () => [
          worldItem({ kind: 'house:world.trip', houseFields: { phase: 'returned', place_name: '苏州' } }),
        ] as never },
      }),
    );
    expect(mantleOf(i)?.level).toBe(1); // ①级压过②级
    expect(mantleOf(i)?.asOf).toBe('15:04'); // 07:04Z = 上海 15:04
    expect(mantleOf(i)?.text).toBe(`蒂法 · ${mat('figure.atHome')}`);
    expect(mantleOf(i)?.url).toBe('https://popclaw.world/h/7t4k2n9q');
    expect(mantleOf(i)?.houseSlug).toBe('popclaw-world');
    expect(urlsOf(getIssue('tok_test')!).has('https://popclaw.world/h/7t4k2n9q')).toBe(true);
  });

  it('away → guide §2 的真实字段（city / day / postcards_sent / postcards_total / return_at）', () => {
    const i = issueOf(
      withDigest(
        digest({
          figures: [{
            figure: '小蓝', state: 'away', city: '苏州', day: 2,
            postcards_sent: 2, postcards_total: 4,
            return_at: new Date((NOW + 7200) * 1000).toISOString(),
            visit_url: 'https://popclaw.world/h/abc',
          }],
        }),
      ),
    );
    // dueBack's `time` is `${date} ${time}` in the owner's tz/language — same
    // two Intl calls gather-materials.ts's stampOf(mode:'datetime') makes.
    const returnAtMs = (NOW + 7200) * 1000;
    const dueBackTime =
      `${new Date(returnAtMs).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric' })} ` +
      new Date(returnAtMs).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
    expect(mantleOf(i)?.text).toBe(
      [
        '小蓝',
        mat('figure.in', { city: '苏州' }),
        mat('figure.day', { day: '2' }),
        mat('figure.postcardsOf', { sent: '2', total: '4' }),
        mat('figure.dueBack', { time: dueBackTime }),
      ].join(' · '),
    );
    expect(mantleOf(i)?.text).not.toContain(mat('figure.onWayHome'));
  });

  it('归期已过 → guide 的「在回家路上」口径，不说它还在目的地', () => {
    const i = issueOf(
      withDigest(
        digest({
          figures: [{
            figure: '小蓝', state: 'away', city: '苏州', day: 3,
            return_at: new Date((NOW - 3600) * 1000).toISOString(),
          }],
        }),
      ),
    );
    const text = mantleOf(i)!.text;
    expect(text).toContain(`小蓝 · ${mat('figure.onWayHomeFrom', { city: '苏州' })}`);
    // 归期那一格：时刻随时区格式化，这里只核「归期已过」那个记号确实印了出来
    const overdueMark = mat('figure.dueBackOverdue', { time: 'T' }).replace(
      mat('figure.dueBack', { time: 'T' }),
      '',
    );
    expect(text).toContain(overdueMark);
    expect(text).not.toContain(`${mat('figure.in', { city: '苏州' })} ·`);
  });

  it('多只公仔一只一段，按 guide 口径各说各的', () => {
    const i = issueOf(
      withDigest(
        digest({
          figures: [
            { figure: '蒂法', state: 'home', city: '杭州' },
            { figure: '小蓝', state: 'away', city: '苏州', day: 1 },
          ],
        }),
      ),
    );
    expect(mantleOf(i)?.text).toBe(
      [
        `蒂法 · ${mat('figure.atHomeIn', { city: '杭州' })}`,
        `小蓝 · ${mat('figure.in', { city: '苏州' })} · ${mat('figure.day', { day: '1' })}`,
      ].join('; '),
    );
  });

  it('digest 拿不到 / figures 空 → 门楣照旧退②-⑤级（绝不掀翻报纸）', () => {
    const i = issueOf(
      withDigest(digest({ figures: [] }), {
        cache: { recentForReading: () => [
          worldItem({ kind: 'house:world.trip', houseFields: { phase: 'returned', place_name: '苏州' } }),
        ] as never },
      }),
    );
    expect(mantleOf(i)?.level).toBe(2);
  });
});

describe('G3 值得一逛的家', () => {
  const home = (over: Record<string, unknown> = {}) => ({
    name: '伊芙',
    visit_url: 'https://popclaw.world/h/3m8v5x1p',
    cover_img: 'https://cdn.example/room.jpg',
    voice: '一间宽敞开阔的圆弧形宇宙飞船舱内卧室',
    built_at: '2026-07-29T07:41:07.280Z',
    visits_today: 0,
    owner: { sigil: '3m8v5x1p', display: '3m8v5x1p' },
    ...over,
  });

  it('坊自己写的英文版排序依据优先于原文(它替自己说话,胜过任何转译)', () => {
    const d = digest({
      homes: [home() as never],
      ranking_basis_i18n: { en: 'Newest home first; visit counts are not yet meaningful.' },
    });
    // 主人读英文 → 印坊自己的英文
    expect(homesOf(issueOf(withDigest(d, { language: 'en-US' })))!.rankingBasis).toBe(
      'Newest home first; visit counts are not yet meaningful.',
    );
    // 主人读中文 → 坊没给 zh，回落原文（原文本来就是中文）
    expect(homesOf(issueOf(withDigest(d)))!.rankingBasis).toContain('按小屋落成时间倒序');
  });

  it('整栏出：家名/门牌/自述/封面/落成 + ranking_basis 原文 + as_of，url 进白名单', () => {
    const section = homesOf(issueOf(withDigest(digest({ homes: [home() as never] }))))!;
    expect(section.houseSlug).toBe('popclaw-world');
    expect(section.asOf).toBe('15:04');
    expect(section.rankingBasis).toBe('按小屋落成时间倒序（世界刚开张，到访数尚无区分度，不以其排序）');
    expect(section.homes).toEqual([
      {
        name: '伊芙',
        visitUrl: 'https://popclaw.world/h/3m8v5x1p',
        owner: '#3m8v5x1p',
        voice: '一间宽敞开阔的圆弧形宇宙飞船舱内卧室',
        coverImg: 'https://cdn.example/room.jpg',
        builtAt: '2026年7月29日',
      },
    ]);
    const urls = urlsOf(getIssue('tok_test')!);
    expect(urls.has('https://popclaw.world/h/3m8v5x1p')).toBe(true);
    expect(urls.has('https://cdn.example/room.jpg')).toBe(true);
  });

  it('visits_today = 0 省略（v5 规则：0 不印）；>0 照印', () => {
    expect(homesOf(issueOf(withDigest(digest({ homes: [home() as never] }))))!.homes[0]!.visitsToday)
      .toBeUndefined();
    _resetIssuesForTest();
    expect(
      homesOf(issueOf(withDigest(digest({ homes: [home({ visits_today: 3 }) as never] }))))!.homes[0]!.visitsToday,
    ).toBe(3);
  });

  it('homes 空 → 整栏不出；坊没给 digest → 整栏不出', () => {
    expect(issueOf(withDigest(digest())).homeSections).toBeUndefined();
    _resetIssuesForTest();
    expect(issueOf(deps()).homeSections).toBeUndefined();
  });

  it('名字链：sigil 本地反查得到 → 走 nameOf（备注名盖过坊给的自报名号）', () => {
    const id = 'OWNER_B';
    const keeper = ownerOf(
      withDigest(
        digest({
          homes: [home({ owner: { nickname: '苏小小', sigil: deriveSigil(id), display: `苏小小#${deriveSigil(id)}` } }) as never],
        }),
        {
          knownPopclawIds: [id],
          nameOf: (who: string, server?: string) => (who === id ? '老苏' : (server ?? '')),
        },
      ),
    );
    expect(keeper).toBe(`老苏#${deriveSigil(id)}`);
    expect(keeper).not.toContain('苏小小');
  });

  it('名字链：反查得到但无备注名 → 用坊给的自报名号；世界流作者也在反查表里', () => {
    const id = 'FEEDAUTHOR';
    const keeper = ownerOf(
      withDigest(
        digest({
          homes: [home({ owner: { nickname: '苏小小', sigil: deriveSigil(id), display: `苏小小#${deriveSigil(id)}` } }) as never],
        }),
        {
          cache: {
            recentForReading: () => [worldItem({ authorPopclawId: id })] as never,
            authorFirstSeen: () => new Map([[id, NOW - 86400]]),
          },
          nameOf: (_who: string, server?: string) => server ?? '',
        },
      ),
    );
    expect(keeper).toBe(`苏小小#${deriveSigil(id)}`);
  });

  it('名字链：反查不到 → 用坊给的 display，绝不编名字', () => {
    const keeper = ownerOf(
      withDigest(
        digest({ homes: [home({ owner: { nickname: '苏小小', sigil: 'zzzzzzzz', display: '苏小小#zzzzzzzz' } }) as never] }),
      ),
    );
    expect(keeper).toBe('苏小小#zzzzzzzz');
  });

  it('owner.popclaw_id 给了 + sigil 与之自洽 + 本机交情本有备注名 → 显示备注名#印信（popclaw_id 优先于印信反查；两者匹配=现有行为不变，回归）', () => {
    const id = 'OWNER_WITH_ID';
    const keeper = ownerOf(
      withDigest(
        digest({
          // sigil 特意给成 deriveSigil(id)——两者自洽，才轮到验证 popclaw_id 那条优先路径。
          homes: [
            home({
              owner: { nickname: '苏小小', sigil: deriveSigil(id), popclaw_id: id, display: `苏小小#${deriveSigil(id)}` },
            }) as never,
          ],
        }),
        { nameOf: (who: string, server?: string) => (who === id ? '老苏' : (server ?? '')) },
      ),
    );
    expect(keeper).toBe(`老苏#${deriveSigil(id)}`);
    expect(keeper).not.toContain('苏小小');
  });

  it('owner.popclaw_id 给了但本机完全不认识 → 走名字链现有兜底（自报名号#由 id 推导的印信）', () => {
    const id = 'OWNER_UNKNOWN_LOCALLY';
    const keeper = ownerOf(
      withDigest(
        digest({
          homes: [
            home({
              owner: { nickname: '苏小小', sigil: deriveSigil(id), popclaw_id: id, display: `苏小小#${deriveSigil(id)}` },
            }) as never,
          ],
        }),
        // 没注入 nameOf → 名字链缺省不认得任何人，退到 displayNamed 的老兜底（serverName=nickname）。
      ),
    );
    expect(keeper).toBe(`苏小小#${deriveSigil(id)}`);
  });

  it('popclaw_id 与 sigil 不自洽（互相推不出）→ 弃用 popclaw_id、退回印信反查——显示 sigil 那个人，绝不是 popclaw_id 那个人的备注名', () => {
    const idClaimed = 'OWNER_MISMATCH_CLAIMED'; // digest 声称的 popclaw_id，本机把它备注为「老李」
    const idActual = 'OWNER_MISMATCH_ACTUAL'; // sigil 反查出来的真主人，本机把它备注为「老王」
    const keeper = ownerOf(
      withDigest(
        digest({
          homes: [
            home({
              // sigil 是 idActual 的印信，popclaw_id 却报成 idClaimed —— 两者互相推不出，digest 自身矛盾。
              owner: { nickname: '苏小小', sigil: deriveSigil(idActual), popclaw_id: idClaimed, display: '苏小小#假印信' },
            }) as never,
          ],
        }),
        {
          knownPopclawIds: [idActual],
          nameOf: (who: string, server?: string) =>
            who === idClaimed ? '老李' : who === idActual ? '老王' : (server ?? ''),
        },
      ),
    );
    expect(keeper).toBe(`老王#${deriveSigil(idActual)}`);
    expect(keeper).not.toContain('老李'); // 绝不把 idClaimed 的备注名安到 idActual 头上——认错人比不认得更糟
  });

  // 没给 owner.popclaw_id 时的老路（sigil 反查 / display 兜底）已由上面「名字链：sigil
  // 本地反查得到」「名字链：反查不到」两条覆盖 —— 那两条的素材本就不带 popclaw_id，
  // 这次改动没碰这条分支，回归照旧绿。
});

describe('G4 家书 [homeletter/v1] 标头', () => {
  const letter = (body: string): Partial<GatherDeps> => ({
    houseOfficialIds: (slug: string) => (slug === 'popclaw-world' ? ['STAGE'] : []),
    inbox: { recent: () => [{ ts: 99500, fromPopclawId: 'STAGE', toPopclawId: 'me', body, receivedAtMs: 0 }] as never },
  });

  it('首行标头字段单列，正文里整行去掉（guide 明写：不要念出来）', () => {
    const l = letterOf(
      deps(letter('[homeletter/v1] kind=postcard place=京都雨夜 view=https://w/p/a1\n📮 寄来一张明信片\n在鸭川边躲了雨')),
    );
    expect(l.header).toBe('kind=postcard · place=京都雨夜 · view=https://w/p/a1');
    expect(l.body).not.toContain('[homeletter/v1]');
    expect(l.body).toContain('📮 寄来一张明信片');
  });

  it('地点带空格照样解得开（值取到下一个 key= 为止）', () => {
    const l = letterOf(deps(letter('[homeletter/v1] kind=return place=Kyoto in the rain\n🏠 回来啦')));
    expect(l.header).toBe('kind=return · place=Kyoto in the rain');
  });

  it('没有标头的信一字不动（老坊照常）', () => {
    const l = letterOf(deps(letter('🏮 欢迎来到这个世界')));
    expect(l.header).toBeUndefined();
    expect(l.body).toBe('🏮 欢迎来到这个世界');
  });
});
