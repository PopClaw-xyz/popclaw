import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import bs58 from 'bs58';
import { deriveSigil } from '../../../src/invite/sigil';
import {
  parseFollowTarget,
  resolveFollowTarget,
  verifyPopclawId,
  formatCandidateList,
  type ResolveCandidate,
} from '../../../src/identity/follow-resolution';
import { setOwnerLang } from '../../../src/lexicon/owner-language';

// Rollout slice 1: formatCandidateList now renders in `ownerLang()` (S1
// process-wide singleton). Pin zh-CN so the rest of this file's assertions
// (none of which exercise formatCandidateList directly) stay unaffected.
beforeAll(() => setOwnerLang('zh-CN', 'config'));

const ID32 = bs58.encode(new Uint8Array(32).fill(7));
const cand = (
  nickname: string,
  sigil: string,
  popclawId: string,
): ResolveCandidate => ({ popclawId, nickname, sigil, profiles: [] });

describe('parseFollowTarget', () => {
  it('bare sigil with #', () => {
    expect(parseFollowTarget('#4f68bd')).toEqual({ kind: 'sigil', sigil: '4f68bd' });
  });
  it('bare sigil without #', () => {
    expect(parseFollowTarget('4f68bd')).toEqual({ kind: 'sigil', sigil: '4f68bd' });
  });
  it('uppercase sigil normalizes to lowercase', () => {
    expect(parseFollowTarget('#4F68BD')).toEqual({ kind: 'sigil', sigil: '4f68bd' });
  });
  it('name#sigil keeps the name for disambiguation', () => {
    expect(parseFollowTarget('苍梧居士#4f68bd')).toEqual({
      kind: 'sigil',
      sigil: '4f68bd',
      name: '苍梧居士',
    });
  });
  it('full base58 popclaw_id', () => {
    expect(parseFollowTarget(ID32)).toEqual({ kind: 'popclawId', popclawId: ID32 });
  });
  it('bare name is fuzzy', () => {
    expect(parseFollowTarget('苍梧')).toEqual({ kind: 'name', name: '苍梧' });
  });
});

describe('resolveFollowTarget', () => {
  it('verifies a full ID and retains its exact candidate with one lookup', async () => {
    const sigil = deriveSigil(ID32);
    const other = cand('Other person', sigil, bs58.encode(new Uint8Array(32).fill(8)));
    const expected = {
      ...cand('Exact recipient', sigil, ID32),
      profiles: [{ platform: 'x', handle: 'synthetic-recipient', followerCount: 5 }],
    };
    const resolve = vi.fn().mockResolvedValueOnce([other, expected]).mockResolvedValue([]);

    const result = await resolveFollowTarget(ID32, resolve);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({ sigil });
    expect(result).toEqual({ kind: 'follow', popclawId: ID32, candidate: expected });
  });

  it.each([
    ['unknown', []],
    ['offline', null],
    ['unknown', [cand('Different ID', deriveSigil(ID32), bs58.encode(new Uint8Array(32).fill(8)))]],
  ] as const)('preserves %s verification after one full-ID lookup', async (status, candidates) => {
    const resolve = vi.fn().mockResolvedValue(candidates);

    expect(await resolveFollowTarget(ID32, resolve)).toEqual({
      kind: 'follow', popclawId: ID32, unverified: status, sigil: deriveSigil(ID32),
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('full popclaw_id → follow, but now existence-checked via derived sigil', async () => {
    // A raw id is verified by resolving its derived sigil; an unverifiable id
    // is still followed (warn-but-allow) but carries `unverified`.
    const resolve = vi.fn().mockResolvedValue([]);
    const r = await resolveFollowTarget(ID32, resolve);
    expect(r.kind).toBe('follow');
    if (r.kind === 'follow') {
      expect(r.popclawId).toBe(ID32);
      expect(r.unverified).toBe('unknown');
    }
    expect(resolve).toHaveBeenCalled();
  });

  it('unique sigil → follow (precise key auto-acts)', async () => {
    const c = cand('苍梧居士', '4f68bd', 'ID1');
    const resolve = vi.fn().mockResolvedValue([c]);
    const r = await resolveFollowTarget('#4f68bd', resolve);
    expect(resolve).toHaveBeenCalledWith({ sigil: '4f68bd' });
    expect(r).toEqual({ kind: 'follow', popclawId: 'ID1', candidate: c });
  });

  it('sigil collision → choose (never silently pick)', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue([cand('甲', '4f68bd', 'A'), cand('乙', '4f68bd', 'B')]);
    const r = await resolveFollowTarget('#4f68bd', resolve);
    expect(r.kind).toBe('choose');
    expect(r.kind === 'choose' && r.candidates).toHaveLength(2);
  });

  it('name#sigil narrows a collision to one → follow', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue([cand('甲', '4f68bd', 'A'), cand('苍梧居士', '4f68bd', 'B')]);
    const r = await resolveFollowTarget('苍梧居士#4f68bd', resolve);
    // sigil is the lookup key; the name only disambiguates client-side.
    expect(resolve).toHaveBeenCalledWith({ sigil: '4f68bd' });
    expect(r).toMatchObject({ kind: 'follow', popclawId: 'B' });
  });

  it('bare name → always choose, even for a single hit (fuzzy key)', async () => {
    const resolve = vi.fn().mockResolvedValue([cand('苍梧居士', '4f68bd', 'B')]);
    const r = await resolveFollowTarget('苍梧', resolve);
    expect(resolve).toHaveBeenCalledWith({ name: '苍梧' });
    expect(r).toMatchObject({ kind: 'choose' });
    expect(r.kind === 'choose' && r.candidates).toHaveLength(1);
  });

  it('name#sigil whose name matches no candidate → still lists all sigil hits (no false empty)', async () => {
    const resolve = vi
      .fn()
      .mockResolvedValue([cand('甲', '4f68bd', 'A'), cand('乙', '4f68bd', 'B')]);
    const r = await resolveFollowTarget('张三#4f68bd', resolve);
    expect(r).toMatchObject({ kind: 'choose' });
    expect(r.kind === 'choose' && r.candidates).toHaveLength(2);
  });

  it('sigil with no match → empty (honest, not a fake follow)', async () => {
    const resolve = vi.fn().mockResolvedValue([]);
    expect(await resolveFollowTarget('#abcdef', resolve)).toEqual({
      kind: 'empty',
      ref: '#abcdef',
    });
  });

  it('server unreachable (null) → lantern', async () => {
    const resolve = vi.fn().mockResolvedValue(null);
    expect(await resolveFollowTarget('苍梧', resolve)).toEqual({ kind: 'lantern' });
  });

  describe('bare-handle/sigil overlap fallthrough (Crockford regression)', () => {
    // "alice2" has no explicit '#' and Crockford-folds (l→1) into a
    // valid-looking sigil "a11ce2" — this is the regression class from
    // the bug report.
    it('bare handle that folds to a valid sigil but misses → falls through to name search', async () => {
      const c = cand('alice2', 'a11ce2', 'ID1');
      const resolve = vi
        .fn()
        .mockResolvedValueOnce([]) // sigil lookup: no match
        .mockResolvedValueOnce([c]); // name fallback: hit
      const r = await resolveFollowTarget('alice2', resolve);
      expect(resolve).toHaveBeenNthCalledWith(1, { sigil: 'a11ce2' });
      // fallback must search the ORIGINAL text, not the folded sigil.
      expect(resolve).toHaveBeenNthCalledWith(2, { name: 'alice2' });
      // `guessed`: the sigil matched nothing; this is a name lookalike, and
      // downstream must not auto-select it even though it is alone (#287).
      expect(r).toEqual({ kind: 'choose', candidates: [c], guessed: true });
    });

    it('explicit #-prefixed sigil with no match stays empty (no name fallthrough)', async () => {
      const resolve = vi.fn().mockResolvedValue([]);
      const r = await resolveFollowTarget('#a11ce2', resolve);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith({ sigil: 'a11ce2' });
      expect(r).toEqual({ kind: 'empty', ref: '#a11ce2' });
    });

    it('bare sigil that DOES match → still follows directly (no fallthrough)', async () => {
      const c = cand('苍梧居士', 'a11ce2', 'ID1');
      const resolve = vi.fn().mockResolvedValue([c]);
      const r = await resolveFollowTarget('alice2', resolve);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ kind: 'follow', popclawId: 'ID1', candidate: c });
    });

    it('bare token with no sigil match and no name match → empty', async () => {
      const resolve = vi.fn().mockResolvedValue([]);
      const r = await resolveFollowTarget('alice2', resolve);
      expect(resolve).toHaveBeenNthCalledWith(1, { sigil: 'a11ce2' });
      expect(resolve).toHaveBeenNthCalledWith(2, { name: 'alice2' });
      expect(r).toEqual({ kind: 'empty', ref: 'alice2' });
    });
  });
});

describe('verifyPopclawId (existence check by derived sigil)', () => {
  const ID = 'E7fBofpgTqMbNi1CSwJdSkfh9HBHZMVgTa4UgmurJFjJ';
  const cand = (popclawId: string, nickname = 'n', sigil = 's') =>
    ({ popclawId, nickname, sigil, profiles: [] });

  it('verified when a candidate with the derived sigil has exactly this id', async () => {
    const resolve = async () => [cand(ID, '苍梧居士', 'abc123')];
    const v = await verifyPopclawId(ID, resolve, () => 'abc123');
    expect(v).toEqual({ status: 'verified', nickname: '苍梧居士', sigil: 'abc123' });
  });
  it('unknown when candidates exist but none match the id (typo)', async () => {
    const resolve = async () => [cand('SOME_OTHER_ID')];
    expect(await verifyPopclawId(ID, resolve, () => 'abc123')).toEqual({ status: 'unknown', sigil: 'abc123' });
  });
  it('unknown when no candidates', async () => {
    expect(await verifyPopclawId(ID, async () => [], () => 'abc123')).toEqual({ status: 'unknown', sigil: 'abc123' });
  });
  it('offline when resolve returns null', async () => {
    expect(await verifyPopclawId(ID, async () => null, () => 'abc123')).toEqual({ status: 'offline', sigil: 'abc123' });
  });
});

describe('resolveFollowTarget — raw popclaw_id now carries verification', () => {
  const ID = 'E7fBofpgTqMbNi1CSwJdSkfh9HBHZMVgTa4UgmurJFjJ';
  it('verified id → follow with candidate (nickname)', async () => {
    const resolve = async () => [{ popclawId: ID, nickname: '苍梧居士', sigil: 's', profiles: [] }];
    const r = await resolveFollowTarget(ID, resolve);
    expect(r.kind).toBe('follow');
    if (r.kind === 'follow') { expect(r.candidate?.nickname).toBe('苍梧居士'); expect(r.unverified).toBeUndefined(); }
  });
  it('unknown id → follow but unverified:"unknown" + sigil', async () => {
    const r = await resolveFollowTarget(ID, async () => []);
    expect(r.kind).toBe('follow');
    if (r.kind === 'follow') { expect(r.unverified).toBe('unknown'); expect(typeof r.sigil).toBe('string'); }
  });
  it('offline → follow but unverified:"offline"', async () => {
    const r = await resolveFollowTarget(ID, async () => null);
    if (r.kind === 'follow') expect(r.unverified).toBe('offline');
  });
});

describe('formatCandidateList (rollout slice 1: bilingual)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  it('zh (default): header + example + numbered candidates', () => {
    const t = formatCandidateList([
      cand('苍梧居士', '4f68bd', 'ID1'),
      cand('苍梧小居士', '4f68be', 'ID2'),
    ]);
    expect(t).toContain('找到 2 个相近的——挑一个，用「名号#印信」关注');
    expect(t).toContain('（如 关注 苍梧居士#4f68bd）');
    expect(t).toContain('1. 苍梧居士#4f68bd');
    expect(t).toContain('2. 苍梧小居士#4f68be');
  });

  it('en lane: natural English header + example', () => {
    setOwnerLang('en', 'config');
    const t = formatCandidateList([cand('Elon Musk', '4f68bd', 'ID1')]);
    expect(t).toContain('Found 1 close matches — pick one, follow with "name#sigil"');
    expect(t).toContain('(e.g. follow Elon Musk#4f68bd)');
    expect(t).toContain('1. Elon Musk#4f68bd');
  });

  it('no candidates → no example clause', () => {
    const t = formatCandidateList([]);
    expect(t).toContain('找到 0 个相近的');
    expect(t).not.toContain('如 关注');
  });
});

// N2 regression (found in acceptance): unfollow's candidate prompt must read
// with the unfollow verb, not follow's — the owner reading the follow example
// back while trying to unfollow someone would re-follow them instead.
describe('formatCandidateList action="unfollow" (N2 regression)', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  it('zh, single candidate: unfollow verb in header + example, no follow verb', () => {
    const t = formatCandidateList([cand('苍梧居士', '4f68bd', 'ID1')], undefined, 'unfollow');
    expect(t).toContain('找到 1 个相近的——挑一个，用「名号#印信」取消关注');
    expect(t).toContain('（如 取消关注 苍梧居士#4f68bd）');
    expect(t).not.toContain('用「名号#印信」关注');
    expect(t).not.toContain('如 关注 苍梧居士#4f68bd');
  });

  it('zh, multiple candidates: unfollow verb in header + example, no follow verb', () => {
    const t = formatCandidateList(
      [cand('苍梧居士', '4f68bd', 'ID1'), cand('苍梧小居士', '4f68be', 'ID2')],
      undefined,
      'unfollow',
    );
    expect(t).toContain('找到 2 个相近的——挑一个，用「名号#印信」取消关注');
    expect(t).toContain('（如 取消关注 苍梧居士#4f68bd）');
    expect(t).not.toContain('用「名号#印信」关注');
    expect(t).not.toContain('如 关注 苍梧居士#4f68bd');
    expect(t).toContain('1. 苍梧居士#4f68bd');
    expect(t).toContain('2. 苍梧小居士#4f68be');
  });

  it('en, single candidate: unfollow verb in header + example, no follow verb', () => {
    const t = formatCandidateList([cand('Elon Musk', '4f68bd', 'ID1')], 'en', 'unfollow');
    expect(t).toContain('Found 1 close matches — pick one, unfollow with "name#sigil"');
    expect(t).toContain('(e.g. unfollow Elon Musk#4f68bd)');
    expect(t).not.toContain('pick one, follow with "name#sigil"');
    expect(t).not.toContain('(e.g. follow Elon Musk#4f68bd)');
  });

  it('en, multiple candidates: unfollow verb in header + example, no follow verb', () => {
    const t = formatCandidateList(
      [cand('Elon Musk', '4f68bd', 'ID1'), cand('Elon Musketeer', '4f68be', 'ID2')],
      'en',
      'unfollow',
    );
    expect(t).toContain('Found 2 close matches — pick one, unfollow with "name#sigil"');
    expect(t).toContain('(e.g. unfollow Elon Musk#4f68bd)');
    expect(t).not.toContain('pick one, follow with "name#sigil"');
    expect(t).not.toContain('(e.g. follow Elon Musk#4f68bd)');
    expect(t).toContain('1. Elon Musk#4f68bd');
    expect(t).toContain('2. Elon Musketeer#4f68be');
  });

  it('default action is still "follow" (byte-identical to prior behavior)', () => {
    const t = formatCandidateList([cand('苍梧居士', '4f68bd', 'ID1')]);
    expect(t).toContain('用「名号#印信」关注');
    expect(t).toContain('如 关注 苍梧居士#4f68bd');
  });
});
