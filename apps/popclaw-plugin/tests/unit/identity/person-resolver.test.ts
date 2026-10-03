import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import bs58 from 'bs58';
import { deriveSigil } from '../../../src/invite/sigil.js';
import type { ResolveCandidate } from '../../../src/identity/follow-resolution.js';
import {
  resolvePerson,
  localCandidates,
  personSourcesFrom,
  localFirst,
  unresolvedText,
  displayPerson,
  type PersonSources,
} from '../../../src/identity/person-resolver.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';

// S3 pilot: displayPerson's '某人' fallback now renders in `ownerLang()`
// (S1 process-wide singleton). Pin zh-CN so this file's pre-lexicon
// assertions stay unchanged (same fix as status.test.ts / mcp-notice.test.ts).
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const ID_A = bs58.encode(new Uint8Array(32).fill(7));
const ID_B = bs58.encode(new Uint8Array(32).fill(9));
const SIGIL_A = deriveSigil(ID_A);
const SIGIL_B = deriveSigil(ID_B);

const cand = (popclawId: string, nickname: string, sigil: string): ResolveCandidate => ({
  popclawId,
  nickname,
  sigil,
  profiles: [],
});

function sources(o: Partial<PersonSources> = {}): PersonSources & { house: ReturnType<typeof vi.fn> } {
  const house = vi.fn(async () => [] as ResolveCandidate[]);
  return {
    known: () => [],
    seen: () => [],
    house,
    ...o,
  } as PersonSources & { house: ReturnType<typeof vi.fn> };
}

describe('resolvePerson — 四种人用形式', () => {
  it('完整 popclaw_id → 直接命中，昵称取自交情本，零往返', async () => {
    const s = sources({ known: () => [{ popclawId: ID_A, nickname: 'Blackfeather' }] });
    const r = await resolvePerson(ID_A, s);
    expect(r).toEqual({ kind: 'resolved', popclawId: ID_A, nickname: 'Blackfeather', sigil: SIGIL_A });
    expect(s.house).not.toHaveBeenCalled();
  });

  it('名号#印信 → 交情本命中，不问灯坊', async () => {
    const s = sources({ known: () => [{ popclawId: ID_A, nickname: 'Blackfeather' }] });
    const r = await resolvePerson(`Blackfeather#${SIGIL_A}`, s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A, sigil: SIGIL_A });
    expect(s.house).not.toHaveBeenCalled();
  });

  it('裸印信（带 # / 不带 #）→ 命中同一人', async () => {
    const s = sources({ known: () => [{ popclawId: ID_A, nickname: 'Blackfeather' }] });
    expect(await resolvePerson(`#${SIGIL_A}`, s)).toMatchObject({ popclawId: ID_A });
    expect(await resolvePerson(SIGIL_A, s)).toMatchObject({ popclawId: ID_A });
    expect(s.house).not.toHaveBeenCalled();
  });

  it('裸名号唯一命中才放行', async () => {
    const s = sources({ known: () => [{ popclawId: ID_A, nickname: 'Blackfeather' }] });
    const r = await resolvePerson('Blackfeather', s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A, nickname: 'Blackfeather' });
    expect(s.house).not.toHaveBeenCalled();
  });
});

describe('resolvePerson — 解析顺序（本地优先）', () => {
  it('② 世界流缓存作者：按 id 现算印信匹配，仍不问灯坊', async () => {
    const s = sources({ seen: () => [ID_A, ID_B] });
    const r = await resolvePerson(`#${SIGIL_B}`, s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_B, sigil: SIGIL_B });
    expect(s.house).not.toHaveBeenCalled();
  });

  it('世界流缓存没有名号列 → 裸名号跳过这一源，落到灯坊', async () => {
    const s = sources({ seen: () => [ID_A] });
    s.house.mockResolvedValue([cand(ID_B, 'Blackfeather', SIGIL_B)]);
    const r = await resolvePerson('白鹭', s);
    expect(s.house).toHaveBeenCalledWith({ name: '白鹭' });
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_B });
  });

  it('③ 本地全不认识 → 落灯坊，唯一候选即命中', async () => {
    const s = sources();
    s.house.mockResolvedValue([cand(ID_A, 'Blackfeather', SIGIL_A)]);
    const r = await resolvePerson(`#${SIGIL_A}`, s);
    expect(s.house).toHaveBeenCalled();
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A, nickname: 'Blackfeather' });
  });
});

describe('resolvePerson — 拉丁名号被折成"印信"的坑（crockford fold）', () => {
  // 'blackfeather' 是合法 crockford 输入（o/i/l 折成 0/1/1），parseFollowTarget 判它
  // 是印信 b1ackfeather。本地源必须同时按"折过的名号"比，否则交情本里的拉丁名号
  // 一律漏，灯坊一挂就复现最初那次私信事故。
  it('交情本里的拉丁名号 → 本地命中，零往返', async () => {
    const s = sources({ known: () => [{ popclawId: ID_A, nickname: 'blackfeather' }] });
    const r = await resolvePerson('blackfeather', s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A, nickname: 'blackfeather' });
    expect(s.house).not.toHaveBeenCalled();
  });

  it('灯坊失联也照样命中（本地权威）', async () => {
    const s = sources({ known: () => [{ popclawId: ID_A, nickname: 'BlackFeather' }] });
    s.house.mockResolvedValue(null);
    const r = await resolvePerson('blackfeather', s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A });
    expect(s.house).not.toHaveBeenCalled();
  });
});

describe('resolvePerson — 歧义 / 查无 / 无效', () => {
  it('本地印信撞号 → 列候选，绝不猜', async () => {
    const sigilOf = (id: string) => (id === ID_A || id === ID_B ? 'aaaaaaaa' : 'zzzzzzzz');
    const s = sources({
      known: () => [
        { popclawId: ID_A, nickname: 'Blackfeather' },
        { popclawId: ID_B, nickname: '苍梧居士' },
      ],
      sigilOf,
    });
    const r = await resolvePerson('#aaaaaaaa', s);
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') {
      expect(r.candidates.map((c) => c.popclawId).sort()).toEqual([ID_A, ID_B].sort());
    }
    expect(s.house).not.toHaveBeenCalled();
  });

  it('灯坊多个候选 → 列候选', async () => {
    const s = sources();
    s.house.mockResolvedValue([cand(ID_A, 'Blackfeather', SIGIL_A), cand(ID_B, '白鹭小居士', SIGIL_B)]);
    const r = await resolvePerson('白鹭', s);
    expect(r.kind).toBe('ambiguous');
  });

  it('哪儿都查不到 → 诚实说查无此人', async () => {
    const s = sources();
    const r = await resolvePerson('查无此人', s);
    expect(r).toMatchObject({ kind: 'notFound', ref: '查无此人' });
  });

  it('灯坊失联 → notFound 带 lanternDown，不冒充"查无此人"', async () => {
    const s = sources();
    s.house.mockResolvedValue(null);
    const r = await resolvePerson('白鹭', s);
    expect(r).toMatchObject({ kind: 'notFound', lanternDown: true });
  });

  it('空输入 → invalid 带理由', async () => {
    const s = sources();
    const r = await resolvePerson('   ', s);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason.length).toBeGreaterThan(0);
    expect(s.house).not.toHaveBeenCalled();
  });
});

describe('localCandidates', () => {
  it('同一人多个名号（昵称+备注）只出一个候选', () => {
    const out = localCandidates(
      { sigil: SIGIL_A },
      { known: () => [
        { popclawId: ID_A, nickname: 'Blackfeather' },
        { popclawId: ID_A, nickname: '老天' },
      ], seen: () => [ID_A], house: async () => null },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ popclawId: ID_A, sigil: SIGIL_A });
  });
});

describe('关注我的人也是认人的本地信源（真机 2026-07-30）', () => {
  // host-c 昨晚 23:40 关注了主人，id 就躺在 `known_followers` 里（通知就是从那张表
  // diff 出来的），可认人时压根不查它 —— 于是本该零往返认出来的人退到灯坊，而
  // 灯坊那边他没名片（名号广播给了旧坊）→ 「认不出 #9b2y5d3f」。
  it('只在 followers 里的人（不在交情本/关注簿）也能按印信认出来', () => {
    const out = localCandidates(
      { sigil: SIGIL_B },
      personSourcesFrom({
        bonds: () => [{ popclawId: ID_A, nickname: 'Blackfeather', remarkName: '' }],
        followers: () => [ID_B],
        house: async () => null,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ popclawId: ID_B, sigil: SIGIL_B, nickname: '' });
  });

  it('followers 与交情本是同一个人时不重复出候选（交情本的名号胜出）', () => {
    const out = localCandidates(
      { sigil: SIGIL_A },
      personSourcesFrom({
        bonds: () => [{ popclawId: ID_A, nickname: 'Blackfeather', remarkName: '' }],
        followers: () => [ID_A],
        house: async () => null,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.nickname).toBe('Blackfeather');
  });
});

describe('灯坊核不出的 id 必须带着 unverified 出来（防人机之间认错人）', () => {
  // 真机 2026-07-30：agent 把 popclaw.world 官方的 id 当成 host-c 那边递进来的，草稿预览
  // 回了个 `—#6q0w4z7r` —— 与「灯坊确认过的收件人」长得一模一样，agent 当成合法
  // 结果，只能自己编解释。resolved 不该把核验状态吞掉。
  it('完整 id + 灯坊查无 → resolved 但标记 unverified=unknown', async () => {
    const r = await resolvePerson(ID_B, {
      known: () => [],
      seen: () => [],
      house: async () => [], // 灯坊在线，明确答"查无此人"
    });
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') {
      expect(r.popclawId).toBe(ID_B);
      expect(r.unverified).toBe('unknown');
    }
  });

  it('灯坊失联 → unverified=offline（与"查无"分开，不冤枉对方不存在）', async () => {
    const r = await resolvePerson(ID_B, { known: () => [], seen: () => [], house: async () => null });
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.unverified).toBe('offline');
  });

  it('灯坊确认过的收件人不带 unverified', async () => {
    const r = await resolvePerson(ID_B, {
      known: () => [],
      seen: () => [],
      house: async () => [cand(ID_B, '素问小待诏', SIGIL_B)],
    });
    expect(r.kind).toBe('resolved');
    if (r.kind === 'resolved') expect(r.unverified).toBeUndefined();
  });
});

describe('unresolvedText', () => {
  it('歧义文案带完整 popclaw_id（机器钥匙）+ 名号#印信（人话）', () => {
    const t = unresolvedText('白鹭', {
      kind: 'ambiguous',
      candidates: [cand(ID_A, 'Blackfeather', SIGIL_A), cand(ID_B, '白鹭小居士', SIGIL_B)],
    });
    expect(t).toContain(`Blackfeather#${SIGIL_A}`);
    expect(t).toContain(ID_A);
    expect(t).toContain('主人');
  });

  it('查无此人文案诚实、不指向 reply', () => {
    const t = unresolvedText('张三', { kind: 'notFound', ref: '张三' });
    expect(t).toContain('张三');
    expect(t).not.toMatch(/reply/i);
  });

  it('灯坊失联单独说', () => {
    const t = unresolvedText('张三', { kind: 'notFound', ref: '张三', lanternDown: true });
    expect(t).toContain('灯坊');
  });
});

// Rollout slice 1: unresolvedText/resolvePerson's invalid reason now render
// in `ownerLang()`. en-lane parity for the zh-CN cases above.
describe('unresolvedText / resolvePerson invalid reason · en lane (rollout slice 1)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  it('ambiguous copy in English', () => {
    setOwnerLang('en', 'config');
    const t = unresolvedText('Tianc', {
      kind: 'ambiguous',
      candidates: [cand(ID_A, 'Tianc the elder', SIGIL_A), cand(ID_B, 'Tianc the younger', SIGIL_B)],
    });
    expect(t).toContain('"Tianc" matches 2 people');
    expect(t).toContain(`Tianc the elder#${SIGIL_A}`);
  });

  it('notFound copy in English, no mention of reply', () => {
    setOwnerLang('en', 'config');
    const t = unresolvedText('Zhang San', { kind: 'notFound', ref: 'Zhang San' });
    expect(t).toContain('No idea who "Zhang San" is');
    expect(t).not.toMatch(/reply/i);
  });

  it('lanternDown copy in English', () => {
    setOwnerLang('en', 'config');
    const t = unresolvedText('Zhang San', { kind: 'notFound', ref: 'Zhang San', lanternDown: true });
    expect(t).toContain('Lore-house unreachable');
  });

  it("resolvePerson's empty-input invalid reason is in English", async () => {
    setOwnerLang('en', 'config');
    const s = sources();
    const r = await resolvePerson('   ', s);
    expect(r.kind).toBe('invalid');
    if (r.kind === 'invalid') expect(r.reason).toBe("You didn't say who — give a name, name#sigil, sigil, or the full popclaw_id");
  });
});

describe('displayPerson — 主人可见的称呼里绝不出现裸 id 前缀', () => {
  it('有名号 → 名号#印信', () => {
    expect(displayPerson(ID_A, '苍梧小居士')).toBe(`苍梧小居士#${SIGIL_A}`);
  });

  it('查无名号 → 只报印信（印信本身是合法称呼）', () => {
    expect(displayPerson(ID_A)).toBe(`#${SIGIL_A}`);
    expect(displayPerson(ID_A, '')).toBe(`#${SIGIL_A}`);
    expect(displayPerson(ID_A, '   ')).toBe(`#${SIGIL_A}`);
  });

  it('绝不给出 id 的前 8 位', () => {
    expect(displayPerson(ID_A)).not.toContain(ID_A.slice(0, 8));
  });

  it('连 id 都没有时不编印信（空串的印信是个谎）', () => {
    expect(displayPerson('', '老张')).toBe('老张');
    expect(displayPerson('')).toBe('某人');
  });

  // S3 pilot: explicit lang overrides the file-wide zh-CN default.
  it('en lane: falls back to "someone" instead of 某人', () => {
    expect(displayPerson('', undefined, 'en')).toBe('someone');
    expect(displayPerson('', 'Steve', 'en')).toBe('Steve');
  });
});

// 真机 2026-07-29：私信认得出「苍梧小居士」全靠灯坊 /v1/resolve，认完就扔，
// 交情本那一行的 nickname 一直空着 → 所有通知退回 #印信 兜底。
describe('localFirst — 灯坊认出来的名号写回交情本', () => {
  it('第③级（灯坊）命中 → learn 收到 id + 名号', async () => {
    const learn = vi.fn();
    const s = sources({ house: vi.fn(async () => [cand(ID_A, '苍梧小居士', SIGIL_A)]), learn });
    await localFirst(s)({ sigil: SIGIL_A });
    expect(learn).toHaveBeenCalledWith(ID_A, '苍梧小居士');
  });

  it('第①级本地命中 → 既不问灯坊也不写回（已经有了）', async () => {
    const learn = vi.fn();
    const s = sources({ known: () => [{ popclawId: ID_A, nickname: 'Blackfeather' }], learn });
    await localFirst(s)({ sigil: SIGIL_A });
    expect(s.house).not.toHaveBeenCalled();
    expect(learn).not.toHaveBeenCalled();
  });

  it('灯坊失联（null）/ 查无（[]）/ 候选没名号 → 不写回', async () => {
    const learn = vi.fn();
    await localFirst(sources({ house: vi.fn(async () => null), learn }))({ sigil: SIGIL_A });
    await localFirst(sources({ house: vi.fn(async () => []), learn }))({ sigil: SIGIL_A });
    await localFirst(sources({ house: vi.fn(async () => [cand(ID_A, '', SIGIL_A)]), learn }))({
      sigil: SIGIL_A,
    });
    expect(learn).not.toHaveBeenCalled();
  });

  it('写回抛异常 → 认人照常返回候选（写回是旁路）', async () => {
    const s = sources({
      house: vi.fn(async () => [cand(ID_A, '苍梧小居士', SIGIL_A)]),
      learn: () => {
        throw new Error('db locked');
      },
    });
    await expect(localFirst(s)({ sigil: SIGIL_A })).resolves.toEqual([
      cand(ID_A, '苍梧小居士', SIGIL_A),
    ]);
  });

  it('端到端：resolvePerson 走完第③级后，名号已经交给交情本', async () => {
    const book = new Map<string, string>([[ID_A, '']]);
    const s = sources({
      house: vi.fn(async () => [cand(ID_A, '苍梧小居士', SIGIL_A)]),
      // fillNickname 的行为契约：只填空、不建行。
      learn: (id, nickname) => {
        if (book.get(id) === '') book.set(id, nickname);
      },
    });
    const r = await resolvePerson(`#${SIGIL_A}`, s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A });
    expect(book.get(ID_A)).toBe('苍梧小居士');
  });
});

// #287: a bare string that folds into a valid sigil, misses every sigil, and
// then happens to hit ONE person as a name substring must not become that
// person silently — the downstream caller is send_draft as often as follow.
describe('sigil miss → name lookalike needs confirmation (#287)', () => {
  const lookalike = cand(ID_B, 'alice2', SIGIL_B);

  /** House: nothing matches the sigil; the name retry finds exactly one person. */
  function houseWithOneNameLookalike() {
    return vi.fn(async (q: { sigil?: string; name?: string }) =>
      q.name ? [lookalike] : [],
    );
  }

  it('a lone lookalike comes back ambiguous, not resolved', async () => {
    const house = houseWithOneNameLookalike();
    const r = await resolvePerson('alice2', sources({ house } as Partial<PersonSources>));
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') throw new Error('unreachable');
    expect(r.guessed).toBe(true);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]!.popclawId).toBe(ID_B);
  });

  it('the owner is told these are lookalikes, not matches on what was typed', async () => {
    const house = houseWithOneNameLookalike();
    const r = await resolvePerson('alice2', sources({ house } as Partial<PersonSources>));
    const text = unresolvedText('alice2', r);
    expect(text).toContain('名号像');
    expect(text).not.toContain('对得上 1 个人');
  });

  it('a real sigil hit still passes through without confirmation', async () => {
    const house = vi.fn(async (q: { sigil?: string; name?: string }) =>
      q.sigil ? [cand(ID_A, 'blackfeather', SIGIL_A)] : [],
    );
    const r = await resolvePerson(`#${SIGIL_A}`, sources({ house } as Partial<PersonSources>));
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') throw new Error('unreachable');
    expect(r.popclawId).toBe(ID_A);
  });
});

/**
 * The owner is a person too.
 *
 * Status hands the owner their own `name#sigil` and their own popclaw_id, and
 * the very next lookup denied them: the resolution sources were bonds ∪ follows
 * ∪ followers ∪ feed authors ∪ the house, and self was in none of them. The
 * house cannot fill the gap either — a placeholder-named identity that never
 * posted has no row in profile_cards, verified_profiles or world_feed_items, by
 * design (announce-namecard deliberately publishes nothing for `ranger-xxxxxx`).
 * So it has to be answered locally, from the identity this machine holds.
 */
describe('the owner resolves as a local candidate', () => {
  const self = () => ({ popclawId: ID_A, nickname: 'ranger-Apopqk' });

  function selfSources(): PersonSources & { house: ReturnType<typeof vi.fn> } {
    const house = vi.fn(async () => [] as ResolveCandidate[]);
    return personSourcesFrom({ self, house }) as PersonSources & { house: typeof house };
  }

  it('resolves the owner by their own name, with no network call', async () => {
    const s = selfSources();
    const r = await resolvePerson('ranger-Apopqk', s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A, nickname: 'ranger-Apopqk', sigil: SIGIL_A });
    expect(s.house).not.toHaveBeenCalled();
  });

  it('resolves the owner by name#sigil, with no network call', async () => {
    const s = selfSources();
    const r = await resolvePerson(`ranger-Apopqk#${SIGIL_A}`, s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A, sigil: SIGIL_A });
    expect(s.house).not.toHaveBeenCalled();
  });

  it('resolves the owner by their full popclaw_id, with no network call', async () => {
    const s = selfSources();
    const r = await resolvePerson(ID_A, s);
    expect(r).toMatchObject({ kind: 'resolved', popclawId: ID_A, sigil: SIGIL_A });
    // Not flagged unverified: the house was never the authority on who the
    // owner is, so its silence proves nothing about this id.
    expect(r).not.toHaveProperty('unverified');
    expect(s.house).not.toHaveBeenCalled();
  });

  // Control group: without the self source, the very same three lookups are
  // exactly the failure the acceptance run hit.
  it('is a miss when self is not a source', async () => {
    const s = sources();
    expect(await resolvePerson('ranger-Apopqk', s)).toMatchObject({ kind: 'notFound' });
    expect(await resolvePerson(ID_A, s)).toMatchObject({ kind: 'resolved', unverified: 'unknown' });
    expect(s.house).toHaveBeenCalled();
  });

  // Self is knowledge this machine already has, not something learned from a
  // house — the bond book is for other people.
  it('never writes the owner into the bond book', async () => {
    const learn = vi.fn();
    const s = personSourcesFrom({ self, learn, house: async () => [] });
    await resolvePerson('ranger-Apopqk', s);
    await resolvePerson(ID_A, s);
    expect(learn).not.toHaveBeenCalled();
  });

  // A bond row wins over the self row for the same id: an alias the owner set
  // for themselves is still the name they chose.
  it('does not shadow a name the bond book already has for that id', () => {
    const out = localCandidates(
      { sigil: SIGIL_A },
      personSourcesFrom({
        bonds: () => [{ popclawId: ID_A, nickname: 'Blackfeather', remarkName: '' }],
        self: () => ({ popclawId: ID_A, nickname: '' }),
        house: async () => null,
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.nickname).toBe('Blackfeather');
  });
});
