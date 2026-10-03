import { describe, it, expect, vi, afterEach } from 'vitest';
import bs58 from 'bs58';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFollowCommand, makeErrandFollow, errandFollowFrom } from '../../../src/commands/follow';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { withOutcomes } from '../../helpers/with-outcomes.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { RelationWriteUnavailableError } from '../../../src/social-graph/social-graph.js';

const fakeSG = withOutcomes({ declareFollow: vi.fn().mockResolvedValue(undefined) });

// `ownPopclawId` is required so no composition root can forget it (the
// onboarding errand's own followDeps literal did, and nothing complained).
// These fixtures follow OTHER people, so it is a value matching no target here.
const OWNER_ID = 'owner-id-that-is-nobody-here';

describe('runFollowCommand', () => {
  it('rejects empty target with usage hint', async () => {
    const out = await runFollowCommand('', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('usage:');
  });

  it('rejects platform:handle (Plan 11.1 boundary)', async () => {
    const out = await runFollowCommand('twitter:elon', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('not yet supported');
  });

  it('accepts a base58 popclaw_id and calls declareFollow', async () => {
    fakeSG.declareFollow.mockClear();
    const out = await runFollowCommand('Haf...', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('Following Haf...');
    expect(fakeSG.declareFollow).toHaveBeenCalledWith('Haf...');
  });

  it('surfaces a friendly error if declareFollow throws', async () => {
    fakeSG.declareFollow.mockRejectedValueOnce(new Error('disk full'));
    const out = await runFollowCommand('Haf...', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('disk full');
  });
});

// Follow doorbell (spec §6.5): `confirmed` is written ONLY after declareFollow
// actually succeeded for that person; failures stay pending, so the retry /
// next-day piggyback legs pick them up. Nothing double-counts: the absorbing
// side's followsIn only looks at established follows, never at this status.
describe('runFollowCommand — pending→confirmed chain', () => {
  it('marks the pending row confirmed on success, with the resolved id', async () => {
    const markConfirmed = vi.fn();
    const out = await runFollowCommand('Haf...', {
      socialGraph: fakeSG as any,
      ownPopclawId: OWNER_ID,
      pendingFollows: { markConfirmed },
    });
    expect(out.text).toContain('They can see that you followed them');
    expect(markConfirmed).toHaveBeenCalledTimes(1);
    expect(markConfirmed).toHaveBeenCalledWith('Haf...');
  });

  it('declareFollow failure → stays pending (markConfirmed NOT called)', async () => {
    const markConfirmed = vi.fn();
    fakeSG.declareFollow.mockRejectedValueOnce(new Error('push refused'));
    const out = await runFollowCommand('Haf...', {
      socialGraph: fakeSG as any,
      ownPopclawId: OWNER_ID,
      pendingFollows: { markConfirmed },
    });
    expect(out.text).toContain('push refused');
    expect(markConfirmed).not.toHaveBeenCalled();
  });

  it('absent dep = no-op: the follow still succeeds with no store attached', async () => {
    const out = await runFollowCommand('Haf...', { socialGraph: fakeSG as any, ownPopclawId: OWNER_ID });
    expect(out.text).toContain('They can see that you followed them');
  });

  it('a store hiccup never fails a follow that is already on the wire', async () => {
    const out = await runFollowCommand('Haf...', {
      socialGraph: fakeSG as any,
      ownPopclawId: OWNER_ID,
      pendingFollows: {
        markConfirmed: () => {
          throw new Error('social db locked');
        },
      },
    });
    // The follow succeeded and is on the wire; a missed marking only means
    // the doorbell may re-ask about someone already followed.
    expect(out.text).toContain('They can see that you followed them');
  });
});

// G1-copy (found in real acceptance): the owner asked "how do I know this
// follow happened in world and not in me?" — the receipt named no house at
// all. `outcome.houseSlug` was already on hand; it just wasn't read.
//
// Architect ruling on the fix: name ONLY the house that actually accepted the
// declaration, and only then. A queued or refused outcome must not read as
// success and must not name a house. A missing house value is never guessed
// — it renders neutral wording with no house at all (defensive: in
// production `relation-scope.ts` always resolves a slug). This is a
// visibility fix only; it does not let the owner choose the house.
describe('runFollowCommand — receipt names the house (G1-copy, architect ruling)', () => {
  const orderedOutcome = (overrides: Record<string, unknown>) => ({
    mode: 'ordered', transport: 'accepted', domain: 'unknown',
    action: 'declare', followee: 'Haf...', houseKey: 'k', eventId: 'e',
    seq: 1n, anotherEndHasSigned: false, ...overrides,
  });

  // Owner acceptance on package 4d07af17: the receipt read "house-popclaw-me
  // 已收到关注声明" — the internal slug leaked straight into owner-facing
  // copy. `houseDisplayName` resolves `outcome.houseSlug` to a name; the
  // receipt must render what it returns, never the slug itself, and — no
  // resolver supplied at all — must fall back to the no-house wording rather
  // than guess.
  it('accepted by a known house: the receipt names the resolved display name, never the slug', async () => {
    const sg = {
      declareFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: 'house-popclaw-me' })),
    };
    const out = await runFollowCommand('Haf...', {
      socialGraph: sg as any,
      ownPopclawId: OWNER_ID,
      houseDisplayName: (slug) => (slug === 'house-popclaw-me' ? 'popclaw.me' : undefined),
    });
    expect(out.text).toMatch(/^✓/);
    expect(out.text).toContain('popclaw.me has the follow declaration');
    expect(out.text).not.toContain('house-popclaw-me');
    expect(out.house).toBe('popclaw.me');
  });

  // Three fallbacks: `houseDisplayName` returning a self-reported name wins;
  // returning undefined (no name known, e.g. only the origin host is on
  // hand) falls to the no-house wording; no resolver injected at all is the
  // same "unknown" case — never the slug.
  it('houseDisplayName resolves a self-reported name over the slug', async () => {
    const sg = {
      declareFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: 'house-popclaw-world' })),
    };
    const out = await runFollowCommand('Haf...', {
      socialGraph: sg as any,
      ownPopclawId: OWNER_ID,
      houseDisplayName: () => 'Popclaw World',
    });
    expect(out.text).toContain('Popclaw World has the follow declaration');
    expect(out.house).toBe('Popclaw World');
  });

  it('houseDisplayName with no name for this slug (origin-host tier unavailable): falls back to no-house wording', async () => {
    const sg = {
      declareFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: 'house-popclaw-me' })),
    };
    const out = await runFollowCommand('Haf...', {
      socialGraph: sg as any,
      ownPopclawId: OWNER_ID,
      houseDisplayName: () => undefined,
    });
    expect(out.text).toMatch(/^✓/);
    expect(out.text).not.toContain('has the follow declaration');
    expect(out.text).not.toContain('house-popclaw-me');
    expect(out.house).toBeUndefined();
  });

  it('no houseDisplayName resolver injected at all: falls back to no-house wording, never the slug', async () => {
    const sg = {
      declareFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: 'house-popclaw-me' })),
    };
    const out = await runFollowCommand('Haf...', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
    expect(out.text).toMatch(/^✓/);
    expect(out.text).not.toContain('has the follow declaration');
    expect(out.text).not.toContain('house-popclaw-me');
    expect(out.house).toBeUndefined();
  });

  it('queued: does not read as success and does not name a house', async () => {
    const sg = {
      declareFollowWithOutcome: vi.fn(async () => orderedOutcome({ transport: 'queued', houseSlug: 'north-house' })),
    };
    const out = await runFollowCommand('Haf...', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
    expect(out.text).not.toMatch(/^✓/);
    expect(out.text).not.toContain('north-house');
    expect(out.text).not.toContain('has the follow declaration');
    expect(out.house).toBeUndefined();
  });

  it('refused: does not read as success and does not name a house', async () => {
    const sg = {
      declareFollowWithOutcome: vi.fn(async () => ({
        mode: 'none', transport: 'intent_recorded', domain: 'unknown',
        action: 'declare', followee: 'Haf...', houseSlug: 'north-house',
        reason: 'HOUSE_UNREACHABLE',
      })),
    };
    const out = await runFollowCommand('Haf...', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
    expect(out.text).toMatch(/^⚠️/);
    expect(out.text).not.toContain('north-house');
    expect(out.house).toBeUndefined();
  });

  it('missing house value: accepted but neutral — never guesses the home house', async () => {
    const sg = {
      declareFollowWithOutcome: vi.fn(async () => orderedOutcome({ houseSlug: undefined })),
    };
    const out = await runFollowCommand('Haf...', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
    expect(out.text).toMatch(/^✓/);
    expect(out.text).toContain('Following Haf...');
    expect(out.text).not.toContain('has the follow declaration');
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
        declareFollowWithOutcome: vi.fn(async () => orderedOutcome({ transport: 'queued', houseSlug: 'north-house' })),
      };
      const out = await runFollowCommand('Haf...', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
      expect(out.text).not.toMatch(/^✓/);
      expect(out.text).not.toContain('north-house');
      expect(out.text).not.toContain('关注声明');
      expect(out.house).toBeUndefined();
    });

    it('refused: does not read as success and does not name a house (zh)', async () => {
      setOwnerLang('zh-CN', 'config');
      const sg = {
        declareFollowWithOutcome: vi.fn(async () => ({
          mode: 'none', transport: 'intent_recorded', domain: 'unknown',
          action: 'declare', followee: 'Haf...', houseSlug: 'north-house',
          reason: 'HOUSE_UNREACHABLE',
        })),
      };
      const out = await runFollowCommand('Haf...', { socialGraph: sg as any, ownPopclawId: OWNER_ID });
      expect(out.text).toMatch(/^⚠️/);
      expect(out.text).not.toContain('north-house');
      expect(out.house).toBeUndefined();
    });
  });
});

// Every return carries a typed outcome, so callers stop reading success off the
// receipt's first character. The text is unchanged; these cases pin both at once:
// the outcome kind, and that `✓` leads the text exactly when the kind is `accepted`.
describe('runFollowCommand — typed outcome', () => {
  const ordered = (overrides: Record<string, unknown> = {}) => ({
    mode: 'ordered', transport: 'accepted', domain: 'unknown',
    action: 'declare', followee: 'Haf...', houseKey: 'k', eventId: 'e',
    seq: 1n, anotherEndHasSigned: false, houseSlug: 'north-house', ...overrides,
  });
  const graph = (outcome: () => Promise<unknown>) => ({ declareFollowWithOutcome: vi.fn(outcome) }) as any;
  const agrees = (out: { text: string; outcome: { kind: string } }) =>
    expect(out.text.startsWith('✓')).toBe(out.outcome.kind === 'accepted');

  it('accepted by a house', async () => {
    const out = await runFollowCommand('Haf...', { socialGraph: graph(async () => ordered()), ownPopclawId: OWNER_ID });
    expect(out.outcome).toEqual({ kind: 'accepted' });
    agrees(out);
  });

  it('signed but queued for re-send', async () => {
    const out = await runFollowCommand('Haf...', {
      socialGraph: graph(async () => ordered({ transport: 'queued' })), ownPopclawId: OWNER_ID,
    });
    expect(out.outcome).toEqual({ kind: 'queued' });
    agrees(out);
  });

  it.each([
    ['usage', ''],
    ['badTarget', 'twitter:elon'],
    ['self', OWNER_ID],
  ] as const)('refused before signing: %s', async (reason, target) => {
    const sg = graph(async () => ordered());
    const out = await runFollowCommand(target, { socialGraph: sg, ownPopclawId: OWNER_ID });
    expect(out.outcome).toEqual({ kind: 'refused', reason });
    expect(sg.declareFollowWithOutcome).not.toHaveBeenCalled();
    agrees(out);
  });

  it('refused before signing: the house offers no follow', async () => {
    const out = await runFollowCommand('Haf...', {
      socialGraph: graph(async () => ({
        mode: 'none', transport: 'intent_recorded', domain: 'unknown',
        action: 'declare', followee: 'Haf...', reason: 'HOUSE_UNREACHABLE',
      })),
      ownPopclawId: OWNER_ID,
    });
    expect(out.outcome).toEqual({ kind: 'refused', reason: 'house' });
    agrees(out);
  });

  it('refused before signing: no relation writer in this build', async () => {
    const out = await runFollowCommand('Haf...', {
      socialGraph: graph(async () => { throw new RelationWriteUnavailableError('declare', 'Haf...'); }),
      ownPopclawId: OWNER_ID,
    });
    expect(out.outcome).toEqual({ kind: 'refused', reason: 'writeUnavailable' });
    agrees(out);
  });

  it('a throw inside the declare call: failed, and whether it left is unknown', async () => {
    const out = await runFollowCommand('Haf...', {
      socialGraph: graph(async () => { throw new Error('disk full'); }), ownPopclawId: OWNER_ID,
    });
    expect(out.outcome).toEqual({ kind: 'failed', transport: 'unknown' });
    expect(out.text).toContain('disk full');
    agrees(out);
  });

  // Accepted by the house, then a local projection threw. The receipt keeps its
  // failure wording (callers' behaviour is unchanged), but the outcome says what
  // actually happened on the wire, so nothing downstream re-sends it.
  it('accepted, then the bond projection threw: failed with transport accepted', async () => {
    const out = await runFollowCommand('Haf...', {
      socialGraph: graph(async () => ordered()),
      ownPopclawId: OWNER_ID,
      bondsStore: { recordInteraction: () => { throw new Error('bonds locked'); }, setFollowed: () => {} } as any,
    });
    expect(out.outcome).toEqual({ kind: 'failed', transport: 'accepted' });
    expect(out.text).toContain('bonds locked');
    agrees(out);
  });

  it('accepted, then naming the house threw: failed with transport accepted', async () => {
    const out = await runFollowCommand('Haf...', {
      socialGraph: graph(async () => ordered()),
      ownPopclawId: OWNER_ID,
      houseDisplayName: () => { throw new Error('guide unreadable'); },
    });
    expect(out.outcome).toEqual({ kind: 'failed', transport: 'accepted' });
    agrees(out);
  });
});

// The errand act's five local sources. #438: `known_followers` was the one
// missing here while every other resolution path had it — the same bug the
// 2026-07-30 incident fixed elsewhere (person-resolver's `followers`): someone
// the owner was *notified about* couldn't be named, and onboarding is exactly
// where a fresh 0.1 owner meets that surface.
describe('makeErrandFollow — local sources', () => {
  const BOND = bs58.encode(new Uint8Array(32).fill(1));
  const FOLLOW = bs58.encode(new Uint8Array(32).fill(2));
  const AUTHOR = bs58.encode(new Uint8Array(32).fill(3));
  const FOLLOWER = bs58.encode(new Uint8Array(32).fill(4));

  function errandFollow() {
    const declareFollow = vi.fn().mockResolvedValue(undefined);
    // The lore-house is up and explicitly answers "no such person": a hit can
    // therefore only have come from a local source.
    const house = vi.fn(async () => []);
    const follow = makeErrandFollow({
      bonds: () => [{ popclawId: BOND, nickname: 'bondy', remarkName: '' }],
      follows: () => [{ popclawId: FOLLOW }],
      followers: () => [FOLLOWER],
      feedAuthors: () => [AUTHOR],
      nameOf: (id: string) => id,
      house,
      fillNickname: () => {},
      followDeps: { socialGraph: withOutcomes({ declareFollow }) as any, ownPopclawId: OWNER_ID },
    });
    return { follow, declareFollow, house };
  }

  it('resolves someone present ONLY in known_followers', async () => {
    const { follow, declareFollow } = errandFollow();
    const out = await follow(`#${deriveSigil(FOLLOWER)}`);
    expect(out.kind).toBe('followed');
    expect(declareFollow).toHaveBeenCalledWith(FOLLOWER);
  });

  // Only an accepted follow is `followed`; every other outcome reaches the
  // onboarding card as `unavailable`, carrying the command's own receipt.
  it.each([
    ['queued', { transport: 'queued' }],
    ['refused by the house', { mode: 'none', transport: 'intent_recorded', reason: 'HOUSE_UNREACHABLE' }],
  ] as const)('%s → unavailable with the receipt as the reason', async (_label, overrides) => {
    const follow = makeErrandFollow({
      bonds: () => [{ popclawId: BOND, nickname: 'bondy', remarkName: '' }],
      follows: () => [], followers: () => [], feedAuthors: () => [],
      nameOf: (id: string) => id,
      house: vi.fn(async () => []),
      fillNickname: () => {},
      followDeps: {
        socialGraph: {
          declareFollowWithOutcome: vi.fn(async () => {
            const base: Record<string, unknown> = {
              mode: 'ordered', transport: 'accepted', domain: 'unknown', action: 'declare',
              followee: BOND, houseKey: 'k', eventId: 'e', seq: 1n, anotherEndHasSigned: false,
            };
            return { ...base, ...overrides };
          }),
        } as any,
        ownPopclawId: OWNER_ID,
      },
    });
    const out = await follow(`#${deriveSigil(BOND)}`);
    expect(out.kind).toBe('unavailable');
    expect((out as { reason: string }).reason).toMatch(/^(… |⚠️ )/);
  });

  it('still resolves bond / follow-list / feed-author people', async () => {
    for (const id of [BOND, FOLLOW, AUTHOR]) {
      const { follow, declareFollow } = errandFollow();
      const out = await follow(`#${deriveSigil(id)}`);
      expect(out.kind).toBe('followed');
      expect(declareFollow).toHaveBeenCalledWith(id);
    }
  });
});

// The errand writes the name through the same follow command as the tool and
// the slash command: the house's name, never the owner's private alias.
describe('errandFollowFrom — the name it writes', () => {
  const MIGRATIONS_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
  const A_ID = '13gLyDGH237UoVJKDxihmfKxDCUTjxrdrEKzzfRuhLei';
  const A_SIGIL = deriveSigil(A_ID);

  function errand(bondsStore: BondsStore, followers: string[] = []) {
    return errandFollowFrom({
      bondsStore,
      socialGraph: withOutcomes({ declareFollow: vi.fn(async () => undefined), following: () => [] }) as any,
      knownFollowers: { allFollowerIds: () => followers },
      worldFeedCache: { authorIds: () => [] },
      nameOf: (_id: string, fallback?: string) => fallback ?? '',
      loreHouseUrl: 'http://lh.example',
      ownPopclawId: OWNER_ID,
      fetch: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ popclaw_id: A_ID, nickname: 'Reh8120A-062c', sigil: A_SIGIL, profiles: [] }] }),
      })) as any,
    });
  }

  function store() {
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    return new BondsStore(db, () => 1000);
  }

  it('following back a new follower names them in the reply and the bond book', async () => {
    const bondsStore = store();

    const out = await errand(bondsStore, [A_ID])('Reh8120A-062c#' + A_SIGIL);

    expect(out).toMatchObject({ kind: 'followed', display: 'Reh8120A-062c#' + A_SIGIL });
    expect(bondsStore.get(A_ID)?.nickname).toBe('Reh8120A-062c');
  });

  it("following by the owner's alias writes the house name, never the alias", async () => {
    const bondsStore = store();
    bondsStore.recordInteraction(A_ID);
    bondsStore.setKnowledge(A_ID, { remarkName: 'Bob' });

    const out = await errand(bondsStore)('Bob#' + A_SIGIL);

    expect(out.kind).toBe('followed');
    expect(bondsStore.get(A_ID)?.nickname).toBe('Reh8120A-062c');
    expect(bondsStore.get(A_ID)?.remarkName).toBe('Bob');
  });
});
