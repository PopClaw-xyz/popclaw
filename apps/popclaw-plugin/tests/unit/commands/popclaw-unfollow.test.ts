import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow';
import { withOutcomes } from '../../helpers/with-outcomes.js';
import { setOwnerLang, failureText } from '../../../src/lexicon/owner-language.js';
import { RelationWriteUnavailableError } from '../../../src/social-graph/social-graph.js';

const fakeSG = withOutcomes({
  revokeFollow: vi.fn().mockResolvedValue(undefined),
  following: vi.fn().mockReturnValue([{ popclawId: 'BBB' }]),
});

// `ownPopclawId` is required so no composition root can forget it (the
// onboarding errand's own followDeps literal did, and nothing complained).
// These fixtures follow OTHER people, so it is a value matching no target here.
const OWNER_ID = 'owner-id-that-is-nobody-here';

describe('runPopclawUnfollowCommand', () => {
  it('usage hint when no target', async () => {
    const out = await runPopclawUnfollowCommand('', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('usage:');
  });

  it('refuses to unfollow someone we are not following', async () => {
    fakeSG.following.mockReturnValueOnce([]);
    const out = await runPopclawUnfollowCommand('BBB', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('Not currently following');
  });

  it('happy path: revokes and confirms', async () => {
    fakeSG.revokeFollow.mockClear();
    const out = await runPopclawUnfollowCommand('BBB', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('Unfollow of BBB sent');
    expect(fakeSG.revokeFollow).toHaveBeenCalledWith('BBB');
  });

  // 卫生债 (spec 2026-07-26): unfollow 必须回写 bonds.followed=false — follow.ts
  // 出手即建档的对称面，之前只在 follow 侧做，unfollow 侧一直没补。
  it('writes bondsStore.setFollowed(id, false) on success', async () => {
    const setFollowed = vi.fn();
    const out = await runPopclawUnfollowCommand('BBB', {
      socialGraph: fakeSG as any,
      ownPopclawId: OWNER_ID,
      bondsStore: { setFollowed },
    });
    expect(out.text).toContain('Unfollow of BBB sent');
    expect(setFollowed).toHaveBeenCalledWith('BBB', false);
  });

  it('does not touch bondsStore when not currently following', async () => {
    fakeSG.following.mockReturnValueOnce([]);
    const setFollowed = vi.fn();
    await runPopclawUnfollowCommand('BBB', {
      socialGraph: fakeSG as any,
      ownPopclawId: OWNER_ID,
      bondsStore: { setFollowed },
    });
    expect(setFollowed).not.toHaveBeenCalled();
  });

  it('works without a bondsStore dep (backward compatible)', async () => {
    const out = await runPopclawUnfollowCommand('BBB', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('Unfollow of BBB sent');
  });
});

// G1-copy (found in real acceptance): the owner asked "how do I know this
// follow happened in world and not in me?" — the unfollow receipt named no
// house either. `outcome.houseSlug` was already on hand; it just wasn't read.
//
// Architect ruling on the fix: name ONLY the house that actually accepted the
// declaration, and only then. A queued or refused outcome must not read as
// success and must not name a house. A missing house value is never guessed
// — it renders neutral wording with no house at all (defensive: in
// production `relation-scope.ts` always resolves a slug). This is a
// visibility fix only; it does not let the owner choose the house.
describe('runPopclawUnfollowCommand — receipt names the house (G1-copy, architect ruling)', () => {
  const following = vi.fn().mockReturnValue([{ popclawId: 'BBB' }]);
  const orderedOutcome = (overrides: Record<string, unknown>) => ({
    mode: 'ordered', transport: 'accepted', domain: 'unknown',
    action: 'revoke', followee: 'BBB', houseKey: 'k', eventId: 'e',
    seq: 1n, anotherEndHasSigned: false, ...overrides,
  });

  // Owner acceptance on package 4d07af17: "取关 CanaryMe-26e2#ccjcbj39 已发出，
  // house-popclaw-me 已收到取关声明" — the same slug leak as follow.ts.
  // `houseDisplayName` resolves `outcome.houseSlug` to a name; the receipt
  // must render what it returns, never the slug itself, and — no resolver
  // supplied at all — must fall back to the no-house wording rather than
  // guess.
  it('accepted by a known house: the receipt names the resolved display name, never the slug', async () => {
    const sg = {
      following,
      revokeFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: 'house-popclaw-me' })),
    };
    const out = await runPopclawUnfollowCommand('BBB', {
      socialGraph: sg as any,
      ownPopclawId: OWNER_ID,
      houseDisplayName: (slug) => (slug === 'house-popclaw-me' ? 'popclaw.me' : undefined),
    });
    expect(out.text).toMatch(/^✓/);
    expect(out.text).toContain('popclaw.me has the unfollow declaration');
    expect(out.text).not.toContain('house-popclaw-me');
    expect(out.house).toBe('popclaw.me');
  });

  // Three fallbacks: same rule as follow.ts — a self-reported name wins, no
  // name for this slug falls to the no-house wording, and no resolver
  // injected at all is the same "unknown" case — never the slug.
  it('houseDisplayName resolves a self-reported name over the slug', async () => {
    const sg = {
      following,
      revokeFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: 'house-popclaw-world' })),
    };
    const out = await runPopclawUnfollowCommand('BBB', {
      socialGraph: sg as any,
      ownPopclawId: OWNER_ID,
      houseDisplayName: () => 'Popclaw World',
    });
    expect(out.text).toContain('Popclaw World has the unfollow declaration');
    expect(out.house).toBe('Popclaw World');
  });

  it('houseDisplayName with no name for this slug (origin-host tier unavailable): falls back to no-house wording', async () => {
    const sg = {
      following,
      revokeFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: 'house-popclaw-me' })),
    };
    const out = await runPopclawUnfollowCommand('BBB', {
      socialGraph: sg as any,
      ownPopclawId: OWNER_ID,
      houseDisplayName: () => undefined,
    });
    expect(out.text).toMatch(/^✓/);
    expect(out.text).not.toContain('has the unfollow declaration');
    expect(out.text).not.toContain('house-popclaw-me');
    expect(out.house).toBeUndefined();
  });

  it('no houseDisplayName resolver injected at all: falls back to no-house wording, never the slug', async () => {
    const sg = {
      following,
      revokeFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: 'house-popclaw-me' })),
    };
    const out = await runPopclawUnfollowCommand('BBB', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
    expect(out.text).toMatch(/^✓/);
    expect(out.text).not.toContain('has the unfollow declaration');
    expect(out.text).not.toContain('house-popclaw-me');
    expect(out.house).toBeUndefined();
  });

  it('queued: does not read as success and does not name a house', async () => {
    const sg = {
      following,
      revokeFollowWithOutcome: vi.fn(async () => orderedOutcome({ transport: 'queued', houseSlug: 'north-house' })),
    };
    const out = await runPopclawUnfollowCommand('BBB', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
    expect(out.text).not.toMatch(/^✓/);
    expect(out.text).not.toContain('north-house');
    expect(out.text).not.toContain('has the unfollow declaration');
    expect(out.house).toBeUndefined();
  });

  it('refused: does not read as success and does not name a house', async () => {
    const sg = {
      following,
      revokeFollowWithOutcome: vi.fn(async () => ({
        mode: 'none', transport: 'intent_recorded', domain: 'unknown',
        action: 'revoke', followee: 'BBB', houseSlug: 'north-house',
        reason: 'HOUSE_UNREACHABLE',
      })),
    };
    const out = await runPopclawUnfollowCommand('BBB', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
    expect(out.text).toMatch(/^⚠️/);
    expect(out.text).not.toContain('north-house');
    expect(out.house).toBeUndefined();
  });

  it('missing house value: accepted but neutral — never guesses the home house', async () => {
    const sg = {
      following,
      revokeFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: undefined })),
    };
    const out = await runPopclawUnfollowCommand('BBB', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
    expect(out.text).toMatch(/^✓/);
    expect(out.text).toContain('Unfollow of BBB sent');
    expect(out.text).not.toContain('has the unfollow declaration');
    expect(out.text).not.toContain('home lore-house');
    expect(out.house).toBeUndefined();
  });

  // Same two negative-reading rules, checked in the zh lane too — the en
  // assertions above would pass for free if the zh templates alone regressed
  // to naming a house on a queued/refused outcome.
  describe('zh lane', () => {
    afterEach(() => setOwnerLang(undefined));

    it('queued: does not read as success and does not name a house (zh)', async () => {
      setOwnerLang('zh-CN', 'config');
      const sg = {
        following,
        revokeFollowWithOutcome: vi.fn(async () => orderedOutcome({ transport: 'queued', houseSlug: 'north-house' })),
      };
      const out = await runPopclawUnfollowCommand('BBB', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
      expect(out.text).not.toMatch(/^✓/);
      expect(out.text).not.toContain('north-house');
      expect(out.text).not.toContain('取关声明');
      expect(out.house).toBeUndefined();
    });

    it('refused: does not read as success and does not name a house (zh)', async () => {
      setOwnerLang('zh-CN', 'config');
      const sg = {
        following,
        revokeFollowWithOutcome: vi.fn(async () => ({
          mode: 'none', transport: 'intent_recorded', domain: 'unknown',
          action: 'revoke', followee: 'BBB', houseSlug: 'north-house',
          reason: 'HOUSE_UNREACHABLE',
        })),
      };
      const out = await runPopclawUnfollowCommand('BBB', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
      expect(out.text).toMatch(/^⚠️/);
      expect(out.text).not.toContain('north-house');
      expect(out.house).toBeUndefined();
    });
  });
});

// R5-A1 characterization: every branch of the command, pinned at the base
// (7e63b1e3) — the reply text in both lanes, which side effects ran, and in
// what order. The outcome refactor must leave all of this byte-identical.
describe('runPopclawUnfollowCommand — branch characterization (R5-A1)', () => {
  afterEach(() => setOwnerLang(undefined));

  type Branch =
    | 'usage' | 'self' | 'notFollowing' | 'acceptedHouse' | 'acceptedNoHouse' | 'queued'
    | 'house' | 'writeUnavailable' | 'thrown' | 'acceptedThenBondsThrow' | 'acceptedThenHouseNameThrows';

  /** Runs one branch with every collaborator recording into one ordered `calls` list. */
  async function run(branch: Branch) {
    const calls: string[] = [];
    const ordered = (over: Record<string, unknown> = {}) => ({
      mode: 'ordered', transport: 'accepted', domain: 'unknown', action: 'revoke', followee: 'BBB',
      houseKey: 'k', eventId: 'e', seq: 1n, anotherEndHasSigned: false, houseSlug: 'north-house', ...over,
    });
    const sg = {
      following: () => {
        calls.push('following');
        return branch === 'notFollowing' ? [] : [{ popclawId: 'BBB' }];
      },
      revokeFollowWithOutcome: async (id: string) => {
        calls.push(`revoke:${id}`);
        if (branch === 'writeUnavailable') throw new RelationWriteUnavailableError('revoke', id);
        if (branch === 'thrown') throw new Error('boom');
        if (branch === 'queued') return ordered({ transport: 'queued' });
        if (branch === 'house') {
          return {
            mode: 'none', transport: 'intent_recorded', domain: 'unknown', action: 'revoke',
            followee: id, houseSlug: 'north-house', reason: 'HOUSE_UNREACHABLE',
          };
        }
        return ordered();
      },
    };
    const out = await runPopclawUnfollowCommand(
      branch === 'usage' ? '' : branch === 'self' ? OWNER_ID : 'BBB',
      {
        socialGraph: sg as any,
        ownPopclawId: OWNER_ID,
        bondsStore: {
          setFollowed: (id, v) => {
            calls.push(`setFollowed:${id}:${v}`);
            if (branch === 'acceptedThenBondsThrow') throw new Error('bonds down');
          },
        },
        socialLog: { record: (e) => calls.push(`log:${e.kind}:${e.house_slug ?? ''}`) },
        houseDisplayName: (slug) => {
          calls.push(`houseName:${slug}`);
          if (branch === 'acceptedThenHouseNameThrows') throw new Error('handshake unreadable');
          return branch === 'acceptedNoHouse' ? undefined : 'North House';
        },
      },
    );
    return { out, calls };
  }

  const ACCEPTED_CALLS = ['following', 'revoke:BBB', 'setFollowed:BBB:false', 'log:follow_removed:north-house', 'houseName:north-house'];

  it('usage: nothing consulted', async () => {
    const { out, calls } = await run('usage');
    expect(out.text).toBe('usage: /popclaw unfollow <popclaw_id>');
    expect(calls).toEqual([]);
  });

  it('self: refused before the following list is read', async () => {
    const { out, calls } = await run('self');
    expect(calls).toEqual([]);
    expect(out.house).toBeUndefined();
  });

  it('notFollowing: only the following list is read', async () => {
    const { calls } = await run('notFollowing');
    expect(calls).toEqual(['following']);
  });

  it('accepted with a house name: full projection order, house carried', async () => {
    const { out, calls } = await run('acceptedHouse');
    expect(calls).toEqual(ACCEPTED_CALLS);
    expect(out.house).toBe('North House');
  });

  it('accepted without a house name: same order, no house', async () => {
    const { out, calls } = await run('acceptedNoHouse');
    expect(calls).toEqual(ACCEPTED_CALLS);
    expect(out.house).toBeUndefined();
    expect('house' in out).toBe(true);
  });

  it.each(['queued', 'house', 'writeUnavailable', 'thrown'] as const)(
    '%s: revoked but no bonds / log / house-name projection',
    async (branch) => {
      const { out, calls } = await run(branch);
      expect(calls).toEqual(['following', 'revoke:BBB']);
      expect(out.house).toBeUndefined();
    },
  );

  it('accepted, then bonds projection throws: stops there, reported as failure', async () => {
    const { out, calls } = await run('acceptedThenBondsThrow');
    expect(calls).toEqual(['following', 'revoke:BBB', 'setFollowed:BBB:false']);
    expect(out.text).toBe(failureText('unfollow', new Error('bonds down')));
  });

  it('accepted, then house-name read throws: projections ran, reported as failure', async () => {
    const { out, calls } = await run('acceptedThenHouseNameThrows');
    expect(calls).toEqual(ACCEPTED_CALLS);
    expect(out.text).toBe(failureText('unfollow', new Error('handshake unreadable')));
  });

  it('the following query sits outside the catch: its throw propagates', async () => {
    const revoke = vi.fn();
    const sg = { following: () => { throw new Error('ledger unreadable'); }, revokeFollowWithOutcome: revoke };
    await expect(runPopclawUnfollowCommand('BBB', { socialGraph: sg as any, ownPopclawId: OWNER_ID }))
      .rejects.toThrow('ledger unreadable');
    expect(revoke).not.toHaveBeenCalled();
  });

  const BRANCHES: Branch[] = [
    'usage', 'self', 'notFollowing', 'acceptedHouse', 'acceptedNoHouse', 'queued', 'house',
    'writeUnavailable', 'thrown', 'acceptedThenBondsThrow', 'acceptedThenHouseNameThrows',
  ];

  it('reply text, en lane, byte-identical to base', async () => {
    setOwnerLang('en', 'config');
    const texts: Record<string, string> = {};
    for (const b of BRANCHES) texts[b] = (await run(b)).out.text;
    expect(texts).toMatchInlineSnapshot(`
      {
        "acceptedHouse": "✓ Unfollow of BBB sent — North House has the unfollow declaration. Nobody has to approve it.",
        "acceptedNoHouse": "✓ Unfollow of BBB sent. Nobody has to approve it.",
        "acceptedThenBondsThrow": "⚠️ unfollow failed: Error: bonds down",
        "acceptedThenHouseNameThrows": "⚠️ unfollow failed: Error: handshake unreadable",
        "house": "⚠️ Following is unavailable in this build: ordered relations are not wired up yet, and the older format is not written any more. Nothing was signed or sent, and nobody was followed.",
        "notFollowing": "⚠️ Not currently following BBB, so there is nothing to undo.",
        "queued": "… Signed and saved, but the unfollow of BBB has not reached the lore-house yet — it will be re-sent. Nothing is lost; it is not confirmed either.",
        "self": "That's you — nothing was sent. This one is for other people; your own card is popclaw_check_status.",
        "thrown": "⚠️ unfollow failed: Error: boom",
        "usage": "usage: /popclaw unfollow <popclaw_id>",
        "writeUnavailable": "⚠️ Following is unavailable in this build: ordered relations are not wired up yet, and the older format is not written any more. Nothing was signed or sent, and nobody was followed.",
      }
    `);
  });

  it('reply text, zh lane, byte-identical to base', async () => {
    setOwnerLang('zh-CN', 'config');
    const texts: Record<string, string> = {};
    for (const b of BRANCHES) texts[b] = (await run(b)).out.text;
    expect(texts).toMatchInlineSnapshot(`
      {
        "acceptedHouse": "✓ 取关 BBB 已发出，North House 已收到取关声明。不需要谁同意。",
        "acceptedNoHouse": "✓ 取关 BBB 已发出。不需要谁同意。",
        "acceptedThenBondsThrow": "⚠️ unfollow 没跑成：Error: bonds down",
        "acceptedThenHouseNameThrows": "⚠️ unfollow 没跑成：Error: handshake unreadable",
        "house": "⚠️ 这个版本暂时不能关注：有序关系还没接上，而旧格式已经不再写了。没有签名、没有发出，也没有关注成功。",
        "notFollowing": "⚠️ 现在并没有关注 BBB，没有可取消的。",
        "queued": "… 已签名存好，但取关 BBB 还没送到灯坊，会自动重发。东西没丢，但也还没确认。",
        "self": "这是你自己——什么都没发出去。这条是用在别人身上的；看自己的名帖用 popclaw_check_status。",
        "thrown": "⚠️ unfollow 没跑成：Error: boom",
        "usage": "usage: /popclaw unfollow <popclaw_id>",
        "writeUnavailable": "⚠️ 这个版本暂时不能关注：有序关系还没接上，而旧格式已经不再写了。没有签名、没有发出，也没有关注成功。",
      }
    `);
  });
});

// R5-A1: the same branches, now named by a typed outcome a caller can branch
// on without reading the receipt. Reuses the characterization runner's inputs.
describe('runPopclawUnfollowCommand — typed outcome (R5-A1)', () => {
  const ordered = (over: Record<string, unknown> = {}) => ({
    mode: 'ordered', transport: 'accepted', domain: 'unknown', action: 'revoke', followee: 'BBB',
    houseKey: 'k', eventId: 'e', seq: 1n, anotherEndHasSigned: false, houseSlug: 'north-house', ...over,
  });
  const sgWith = (revoke: () => Promise<unknown>, following = [{ popclawId: 'BBB' }]) =>
    ({ following: () => following, revokeFollowWithOutcome: vi.fn(revoke) }) as any;

  it.each([
    ['usage', '', sgWith(async () => ordered()), { kind: 'refused', reason: 'usage' }],
    ['self', OWNER_ID, sgWith(async () => ordered()), { kind: 'refused', reason: 'self' }],
    ['notFollowing', 'BBB', sgWith(async () => ordered(), []), { kind: 'refused', reason: 'notFollowing' }],
    ['accepted, house named', 'BBB', sgWith(async () => ordered()), { kind: 'accepted' }],
    ['accepted, no house', 'BBB', sgWith(async () => ordered({ houseSlug: undefined })), { kind: 'accepted' }],
    ['queued', 'BBB', sgWith(async () => ordered({ transport: 'queued' })), { kind: 'queued' }],
    ['house refusal', 'BBB', sgWith(async () => ({ mode: 'none', transport: 'intent_recorded', reason: 'HOUSE_UNREACHABLE' })),
      { kind: 'refused', reason: 'house' }],
    ['writeUnavailable', 'BBB', sgWith(async () => { throw new RelationWriteUnavailableError('revoke', 'BBB'); }),
      { kind: 'refused', reason: 'writeUnavailable' }],
    ['general throw', 'BBB', sgWith(async () => { throw new Error('boom'); }), { kind: 'failed', transport: 'unknown' }],
  ] as const)('%s', async (_name, target, sg, outcome) => {
    const out = await runPopclawUnfollowCommand(target, {
      socialGraph: sg, ownPopclawId: OWNER_ID, houseDisplayName: () => 'North House',
    });
    expect(out.outcome).toEqual(outcome);
  });

  it('accepted by the house, then a local projection throws: failed with transport accepted, never success', async () => {
    const out = await runPopclawUnfollowCommand('BBB', {
      socialGraph: sgWith(async () => ordered()),
      ownPopclawId: OWNER_ID,
      bondsStore: { setFollowed: () => { throw new Error('bonds down'); } },
    });
    expect(out.outcome).toEqual({ kind: 'failed', transport: 'accepted' });
    expect(out.text).not.toMatch(/^✓/);
  });
});
