/**
 * The owner is a person to READ about, never a person to WRITE at.
 *
 * Making self a local resolution candidate is what lets "show my namecard"
 * work, but the same sources feed every tool that takes a person — so the
 * owner's own name now reaches popclaw_follow, popclaw_unfollow,
 * popclaw_draft_message and the bond-book writers. Each of those signs an
 * event and pushes it, or writes a local row asserting a relation with
 * oneself. Refuse at the boundary: nothing signed, nothing pushed, no row.
 *
 * Every assertion here measures the write itself — the spy on the signing /
 * pushing call, or the row count in the store — not the absence of an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { _draftsForTest } from '../../../src/tools/draft-store.js';
import { runPopclawMessageCommand } from '../../../src/commands/popclaw-message.js';
import { errandFollowFrom, runFollowCommand } from '../../../src/commands/follow.js';
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow.js';
import { runBondCommand } from '../../../src/commands/popclaw-bond.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import type { MasterKey } from '../../../src/identity/keystore.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { ownerLang } from '../../../src/lexicon/owner-language.js';
import { withOutcomes } from '../../helpers/with-outcomes.js';
import type { ResolveCandidate } from '../../../src/identity/follow-resolution.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const OWNER = bs58.encode(new Uint8Array(32).fill(13));
const OWNER_NAME = 'blackfeather_ai';
const OWNER_SIGIL = deriveSigil(OWNER);
const OTHER = bs58.encode(new Uint8Array(32).fill(21));
const OTHER_NAME = 'Elon';
const OTHER_SIGIL = deriveSigil(OTHER);

const refusal = (): string => renderCopy(ownerLang(), 'person.thatIsYou');

/** The three forms every person-taking surface accepts. A guard has to hold on all of them. */
const LANES = [OWNER_NAME, `${OWNER_NAME}#${OWNER_SIGIL}`, OWNER];

type Tool = { name: string; execute: (c: string, p: unknown) => Promise<{ type: string; text: string }> };

function makeSigner(fill: number): MasterKeySigner {
  const seed = new Uint8Array(32).fill(fill);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const key: MasterKey = { seed, publicKey: kp.publicKey, secretKey: kp.secretKey, popclawId: bs58.encode(kp.publicKey) };
  return new MasterKeySigner(key);
}

/** The whole registration, over a runtime that knows who the owner is. */
function setup(extraRuntime: Record<string, unknown> = {}) {
  const tools: Tool[] = [];
  const api = {
    registerTool: (tool: unknown) => {
      const t = (typeof tool === 'function' ? (tool as (c: unknown) => unknown)({}) : tool) as Tool;
      if (t?.name && typeof t.execute === 'function') tools.push(t);
    },
    logger: { info: vi.fn() },
  } as Parameters<typeof registerPopclawTools>[0]['api'];

  const declareFollow = vi.fn(async () => undefined);
  const revokeFollow = vi.fn(async () => undefined);
  const socialGraph = withOutcomes({
    declareFollow,
    revokeFollow,
    following: () => [{ popclawId: OWNER }, { popclawId: OTHER }],
  });
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const bondsStore = new BondsStore(db, () => 1000);

  registerPopclawTools({
    api,
    runtime: (async () => ({
      boot: { popclawId: OWNER, nickname: OWNER_NAME, loreHouseUrl: 'http://lh.example', webBaseUrl: 'https://popclaw.me', signer: {} },
      socialGraph,
      bondsStore,
      inboxStore: { houseOf: () => undefined },
      worldFeedCache: { lookup: () => null },
      ...extraRuntime,
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
    getWorldDeps: (async () => ({
      guideClient: { fetchGuideText: async () => '' },
      summaryClient: { fetchSummary: async () => ({}) },
      snapshotClient: { fetchSnapshot: async () => [] },
      // The house knows the other person; it has never heard of the owner.
      resolveClient: {
        resolve: vi.fn(async (q: { sigil?: string; name?: string }) =>
          (q.sigil === OTHER_SIGIL || q.name === OTHER_NAME
            ? [{ popclawId: OTHER, nickname: OTHER_NAME, sigil: OTHER_SIGIL, profiles: [] }]
            : []) as ResolveCandidate[],
        ),
      },
      webBaseUrl: 'https://popclaw.me',
    })) as unknown as Parameters<typeof registerPopclawTools>[0]['getWorldDeps'],
  });

  const find = (name: string): Tool => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`tool not found: ${name}`);
    return t;
  };
  return { find, declareFollow, revokeFollow, bondsStore, db };
}

beforeEach(() => _draftsForTest.clear());

describe('popclaw_follow refuses the owner', () => {
  it('signs and pushes nothing on any of the three lanes', async () => {
    const { find, declareFollow } = setup();
    for (const ref of LANES) {
      const r = await find('popclaw_follow').execute('c1', { name: ref });
      expect(r.text).toBe(refusal());
      // The measurement that matters: the only call that signs a
      // FollowDeclared and hands it to egress was never made.
      expect(declareFollow).not.toHaveBeenCalled();
    }
  });

  // Control group: the guard is not a blanket refusal.
  it('still follows somebody else', async () => {
    const { find, declareFollow } = setup();
    const ok = await find('popclaw_follow').execute('c1', { name: `#${OTHER_SIGIL}` });
    expect(declareFollow).toHaveBeenCalledWith(OTHER);
    expect(ok.text).not.toBe(refusal());
  });
});

describe('popclaw_unfollow refuses the owner', () => {
  it('revokes nothing on any of the three lanes', async () => {
    const { find, revokeFollow } = setup();
    for (const ref of LANES) {
      const r = await find('popclaw_unfollow').execute('c1', { name: ref });
      expect(r.text).toBe(refusal());
      expect(revokeFollow).not.toHaveBeenCalled();
    }
  });

  it('still unfollows somebody else', async () => {
    const { find, revokeFollow } = setup();
    await find('popclaw_unfollow').execute('c1', { name: `#${OTHER_SIGIL}` });
    expect(revokeFollow).toHaveBeenCalledWith(OTHER);
  });
});

describe('the DM lane refuses the owner', () => {
  it('issues no draft on any of the three lanes', async () => {
    const { find } = setup();
    for (const ref of LANES) {
      const r = await find('popclaw_draft_message').execute('c1', { recipient: ref, body: 'hello me' });
      expect(r.text).toBe(refusal());
      // No draft_id was minted, so popclaw_send_draft has nothing to confirm.
      expect(r.text).not.toMatch(/message-/);
    }
  });

  it('still drafts a message to somebody else', async () => {
    const { find } = setup();
    const r = await find('popclaw_draft_message').execute('c1', { recipient: `#${OTHER_SIGIL}`, body: 'hello you' });
    expect(r.text).not.toBe(refusal());
    expect(r.text).toMatch(/message-/);
  });

  // The deeper guard, measured where the push happens: even called directly,
  // with a real signer, nothing reaches egress.
  it('signs and pushes nothing at the command layer either', async () => {
    const signer = makeSigner(13);
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    const out = await runPopclawMessageCommand(
      { positional: [await signer.popclawId(), 'talking', 'to', 'myself'] },
      { signer, egress, nickname: OWNER_NAME },
    );
    expect(out.text).toBe(refusal());
    expect(egress.push).not.toHaveBeenCalled();
  });

  it('still signs and pushes a message to somebody else', async () => {
    const signer = makeSigner(13);
    const other = makeSigner(21);
    const egress = { push: vi.fn().mockResolvedValue(undefined) };
    const out = await runPopclawMessageCommand(
      { positional: [await other.popclawId(), 'talking', 'to', 'you'] },
      { signer, egress, nickname: OWNER_NAME },
    );
    expect(out.text).not.toBe(refusal());
    expect(egress.push).toHaveBeenCalledTimes(1);
  });
});

describe('the bond book refuses the owner', () => {
  // The full-id lane is the one that got through: runBondCommand's remark path
  // short-circuits person resolution for a full popclaw_id, so a guard that
  // lived in the injected resolver was never consulted and a row WAS written.
  it('writes no row when an alias is set on the owner, on any of the three lanes', async () => {
    for (const ref of LANES) {
      const { find, bondsStore } = setup();
      const r = await find('popclaw_set_remark_name').execute('c1', { person: ref, remark_name: 'me' });
      expect(r.text).toBe(refusal());
      expect(bondsStore.list()).toHaveLength(0);
    }
  });

  it('writes no row when a tier is set on the owner', async () => {
    const { find, bondsStore } = setup();
    const r = await find('popclaw_set_bond_tier').execute('c1', { popclaw_id: OWNER, tier: 'close' });
    expect(r.text).toBe(refusal());
    expect(bondsStore.list()).toHaveLength(0);
  });

  // Control group: both writers still work on anybody else.
  it('still writes a row for somebody else', async () => {
    const { find, bondsStore } = setup();
    await find('popclaw_set_bond_tier').execute('c1', { popclaw_id: OTHER, tier: 'close' });
    expect(bondsStore.list()).toHaveLength(1);
    expect(bondsStore.list()[0]!.popclawId).toBe(OTHER);
  });
});

// The whole point of making self resolvable: the READ side keeps working.
describe('the read side still answers about the owner', () => {
  it('shows the owner their own namecard', async () => {
    const houseFetch = vi.fn(async () => ({ ok: true, status: 200, text: async () => '', json: async () => ({}) }));
    vi.stubGlobal('fetch', houseFetch);
    const { find } = setup();
    const r = await find('popclaw_show_namecard').execute('c1', { person: OWNER_NAME });
    vi.unstubAllGlobals();

    expect(r.text).not.toBe(refusal());
    expect(r.text).toContain(`@${OWNER_NAME}#${OWNER_SIGIL}`);
  });
});

/**
 * The non-tool entrances.
 *
 * `/popclaw follow`, `/popclaw unfollow`, `/popclaw bond` and the dev CLI do
 * not go through the tools at all — they call the same commands directly. A
 * guard that lived only at the tool layer left `/popclaw follow <own id>`
 * signing and pushing a self-follow, and the owner's own id is printed in
 * every status report. The check belongs in the commands, where every
 * entrance passes through.
 */
describe('the command layer refuses the owner', () => {
  it('runFollowCommand signs nothing for the owner', async () => {
    const declareFollow = vi.fn(async () => undefined);
    const r = await runFollowCommand(OWNER, {
      socialGraph: withOutcomes({ declareFollow }),
      ownPopclawId: OWNER,
    } as never);
    expect(r.text).toBe(refusal());
    expect(declareFollow).not.toHaveBeenCalled();
  });

  it('runPopclawUnfollowCommand revokes nothing for the owner', async () => {
    const revokeFollow = vi.fn(async () => undefined);
    const r = await runPopclawUnfollowCommand(OWNER, {
      socialGraph: withOutcomes({ revokeFollow, following: () => [{ popclawId: OWNER }] }),
      ownPopclawId: OWNER,
    } as never);
    expect(r.text).toBe(refusal());
    expect(revokeFollow).not.toHaveBeenCalled();
  });

  it('runBondCommand writes no row for the owner, by id or by name', async () => {
    for (const verb of [['remark', OWNER, 'me'], ['friend', OWNER], ['remark', OWNER_NAME, 'me']]) {
      const db = new InMemoryHostDb();
      runMigrations(db, MIGRATIONS);
      const bondsStore = new BondsStore(db, () => 1000);
      const r = await runBondCommand(
        { positional: verb },
        {
          bondsStore,
          ownPopclawId: OWNER,
          resolvePerson: async () => ({ kind: 'resolved' as const, popclawId: OWNER, nickname: OWNER_NAME, sigil: OWNER_SIGIL }),
        } as never,
      );
      expect(r.text).toBe(refusal());
      expect(bondsStore.list()).toHaveLength(0);
    }
  });

  // Control group: the commands still write for anybody else.
  it('still declares, revokes and records for somebody else', async () => {
    const declareFollow = vi.fn(async () => undefined);
    await runFollowCommand(OTHER, { socialGraph: withOutcomes({ declareFollow }), ownPopclawId: OWNER } as never);
    expect(declareFollow).toHaveBeenCalledWith(OTHER);

    const revokeFollow = vi.fn(async () => undefined);
    await runPopclawUnfollowCommand(OTHER, {
      socialGraph: withOutcomes({ revokeFollow, following: () => [{ popclawId: OTHER }] }),
      ownPopclawId: OWNER,
    } as never);
    expect(revokeFollow).toHaveBeenCalledWith(OTHER);

    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const bondsStore = new BondsStore(db, () => 1000);
    await runBondCommand({ positional: ['friend', OTHER] }, { bondsStore, ownPopclawId: OWNER } as never);
    expect(bondsStore.list()).toHaveLength(1);
  });

  // An unknown owner id must never block a legitimate write.
  it('refuses nothing when the owner id is unknown', async () => {
    const declareFollow = vi.fn(async () => undefined);
    await runFollowCommand(OWNER, { socialGraph: withOutcomes({ declareFollow }) } as never);
    expect(declareFollow).toHaveBeenCalledWith(OWNER);
  });
});

/**
 * Self is matched EXACTLY, never by substring.
 *
 * Every other local row is somebody the owner chose to know; self is on every
 * install, so matching it the way the name lane matches a bond row let the
 * owner's own name swallow a stranger whose name it merely contains — and the
 * house was never asked, because a local hit short-circuits it.
 */
describe('the owner does not shadow a stranger whose name is a prefix', () => {
  const STRANGER = bs58.encode(new Uint8Array(32).fill(33));
  const STRANGER_NAME = 'blackfeather'; // OWNER_NAME is 'blackfeather_ai'

  function shadowSetup() {
    const houseResolve = vi.fn(async (q: { sigil?: string; name?: string }) =>
      (q.name === STRANGER_NAME
        ? [{ popclawId: STRANGER, nickname: STRANGER_NAME, sigil: deriveSigil(STRANGER), profiles: [] }]
        : []) as ResolveCandidate[],
    );
    const tools: Tool[] = [];
    const api = {
      registerTool: (tool: unknown) => {
        const t = (typeof tool === 'function' ? (tool as (c: unknown) => unknown)({}) : tool) as Tool;
        if (t?.name && typeof t.execute === 'function') tools.push(t);
      },
      logger: { info: vi.fn() },
    } as Parameters<typeof registerPopclawTools>[0]['api'];
    const declareFollow = vi.fn(async () => undefined);
    registerPopclawTools({
      api,
      runtime: (async () => ({
        boot: { popclawId: OWNER, nickname: OWNER_NAME, loreHouseUrl: 'http://lh.example', webBaseUrl: 'https://popclaw.me' },
        socialGraph: withOutcomes({ declareFollow, following: () => [] }),
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['runtime'],
      getWorldDeps: (async () => ({
        guideClient: { fetchGuideText: async () => '' },
        summaryClient: { fetchSummary: async () => ({}) },
        snapshotClient: { fetchSnapshot: async () => [] },
        resolveClient: { resolve: houseResolve },
        webBaseUrl: 'https://popclaw.me',
      })) as unknown as Parameters<typeof registerPopclawTools>[0]['getWorldDeps'],
    });
    const find = (name: string): Tool => tools.find((x) => x.name === name)!;
    return { find, houseResolve, declareFollow };
  }

  it('asks the house for the stranger and offers them, instead of answering "that’s you"', async () => {
    const { find, houseResolve, declareFollow } = shadowSetup();
    const r = await find('popclaw_follow').execute('c1', { name: STRANGER_NAME });

    expect(r.text).not.toBe(refusal());
    // The measurement: the house lane was actually consulted for this name.
    expect(houseResolve).toHaveBeenCalled();
    expect(r.text).toContain(STRANGER_NAME);
    // A fuzzy name still lists rather than follows — unchanged rule.
    expect(declareFollow).not.toHaveBeenCalled();
  });

  // Control group: the owner's WHOLE name is still the owner.
  it('still refuses the owner’s own full name', async () => {
    const { find } = shadowSetup();
    const r = await find('popclaw_follow').execute('c1', { name: OWNER_NAME });
    expect(r.text).toBe(refusal());
  });
});

/**
 * The onboarding errand — the entrance that stayed open for a round.
 *
 * `errandFollowFrom` is the shared wiring BOTH composition roots hold (index.ts
 * and mcp.ts): it assembles its own followDeps literal, and that literal simply
 * did not set the owner id, so the errand happily followed the owner. The field
 * is required now, so neither root can omit it — and this pins the behaviour of
 * the wiring itself, which is the one copy they share.
 */
describe('the onboarding errand refuses the owner', () => {
  function errand(ownPopclawId: string) {
    const declareFollow = vi.fn(async () => undefined);
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    const follow = errandFollowFrom({
      bondsStore: new BondsStore(db, () => 1000),
      socialGraph: withOutcomes({ declareFollow, following: () => [] }) as never,
      knownFollowers: { allFollowerIds: () => [OWNER, OTHER] },
      worldFeedCache: { authorIds: () => [] },
      nameOf: (_id: string, fallback?: string) => fallback ?? '',
      loreHouseUrl: 'http://lh.example',
      ownPopclawId,
      fetch: (async () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }) })) as never,
    });
    return { follow, declareFollow };
  }

  it('signs nothing when the errand is pointed at the owner', async () => {
    const { follow, declareFollow } = errand(OWNER);
    const out = await follow(`#${OWNER_SIGIL}`);
    expect(out.kind).not.toBe('followed');
    expect(out).toMatchObject({ reason: refusal() });
    expect(declareFollow).not.toHaveBeenCalled();
  });

  // Control group: the errand is the onboarding happy path and must still work.
  it('still follows somebody else', async () => {
    const { follow, declareFollow } = errand(OWNER);
    const out = await follow(`#${OTHER_SIGIL}`);
    expect(out.kind).toBe('followed');
    expect(declareFollow).toHaveBeenCalledWith(OTHER);
  });
});
