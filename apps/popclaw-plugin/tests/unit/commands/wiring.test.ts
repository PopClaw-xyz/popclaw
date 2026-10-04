/**
 * ADR-0035 is constitutional: `register()` must be cheap — loading a plugin is
 * not enabling it. `openclaw plugins install` / `plugins list` register without
 * ever starting the service, and any database, socket or file the map touches
 * while being BUILT happens on those paths too.
 *
 * `commands/wiring.ts` took 640 lines of subcommand closures out of index.ts's
 * register() closure; the thing that must survive that move is exactly this
 * property. So: build the map with wiring whose every thunk explodes. If
 * anything is reached eagerly, this test is where it surfaces — not on a real
 * machine, where the symptom is `plugins list` opening the owner's sqlite
 * handles and hanging the process instead of exiting.
 */
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSubcommands,
  SUBCOMMAND_NAMES,
  type SubcommandWiring,
} from '../../../src/commands/wiring.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { BondsStore } from '../../../src/bonds/bonds-store.js';
import { displayNamed, makeNameChain } from '../../../src/identity/person-name.js';
import { deriveSigil } from '../../../src/invite/sigil.js';
import { setOwnerLang } from '../../../src/lexicon/owner-language.js';
import { renderCopy } from '../../../src/lexicon/index.js';
import { makeTestSigner } from '../../helpers/test-signer.js';
import { withOutcomes } from '../../helpers/with-outcomes.js';

function explodingWiring(): SubcommandWiring {
  const boom = (): never => {
    throw new Error('register() must stay cheap (ADR-0035)');
  };
  return {
    runtime: boom,
    paths: boom,
    picksFile: boom,
    warn: boom,
    llmComplete: boom,
    toolsRegisteredCount: boom,
    buildStamp: 'test-build',
  } as unknown as SubcommandWiring;
}

describe('buildSubcommands', () => {
  it('constructs nothing while building the map (ADR-0035)', () => {
    expect(() => buildSubcommands(explodingWiring())).not.toThrow();
  });

  it('returns exactly the declared subcommand set', () => {
    const map = buildSubcommands(explodingWiring());
    expect(Object.keys(map).sort()).toEqual([...SUBCOMMAND_NAMES].sort());
  });

  it('every entry is a handler, and none of them ran yet', () => {
    const map = buildSubcommands(explodingWiring());
    for (const name of SUBCOMMAND_NAMES) {
      expect(typeof map[name], `${name} must be a handler`).toBe('function');
    }
  });

});

// Slash-path twin of the popclaw_follow case in world-tools.test.ts: a first
// follow resolved through the house must leave the resolved name in the bond
// book, so status and DM labels do not fall back to `#sigil`. The name written
// is the house's: never the owner's private alias, and never over a house name
// already stored.
describe('/popclaw follow · a first follow keeps the name', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  const MIGRATIONS_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
  const A_ID = '13gLyDGH237UoVJKDxihmfKxDCUTjxrdrEKzzfRuhLei';
  const A_SIGIL = deriveSigil(A_ID);

  function harness(opts: { followers?: string[]; houseSlug?: string } = {}) {
    setOwnerLang('en', 'config');
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const bondsStore = new BondsStore(db, () => 1000);
    const following: Array<{ popclawId: string; since: number }> = [];
    const socialGraph = withOutcomes({
      declareFollow: vi.fn(async (id: string) => {
        following.push({ popclawId: id, since: 1 });
        return opts.houseSlug;
      }),
      following: () => following,
    });
    const nameOf = makeNameChain({ bond: (id) => bondsStore.get(id) });
    const fetchHouse = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ candidates: [{ popclaw_id: A_ID, nickname: 'Reh8120A-062c', sigil: A_SIGIL, profiles: [] }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const rt = {
      bondsStore,
      socialGraph,
      nameOf,
      knownFollowers: { allFollowerIds: () => opts.followers ?? [] },
      worldFeedCache: { authorIds: () => [] },
      // `north-house` doubles as both `opts.houseSlug` and (via this URL) the
      // origin host the receipt's house-name resolver falls back to, so the
      // pinned wording below is unchanged.
      boot: { popclawId: 'OWNER_B', loreHouseUrl: 'http://house.test', loreHouseUrls: ['http://north-house'] },
      paths: { houseHandshakeFile: () => '/nonexistent/handshake.json' },
      houseRuntime: { fetchHouse, runCommand: <T>(work: () => Promise<T>) => work() },
    };
    const map = buildSubcommands({
      ...explodingWiring(),
      runtime: async () => rt,
    } as unknown as SubcommandWiring);
    const follow = (ref: string) =>
      map.follow({ args: { positional: [ref] } } as unknown as Parameters<typeof map.follow>[0]);
    return { bondsStore, nameOf, fetchHouse, follow };
  }

  it('writes the name the house resolved into the bond book', async () => {
    const h = harness();

    const r = await h.follow('#' + A_SIGIL);

    expect(h.fetchHouse).toHaveBeenCalled();
    expect(r.text).toContain('Reh8120A-062c#' + A_SIGIL);
    // The one follow receipt, not a wording of the slash command's own. No
    // house slug came back, so it's the neutral no-house variant (architect
    // ruling: never guess the home house).
    expect(r.text).toBe(
      `✓ ${renderCopy('en', 'relation.followReceivedNoHouse', { who: 'Reh8120A-062c#' + A_SIGIL })}`,
    );
    expect(h.bondsStore.get(A_ID)?.nickname).toBe('Reh8120A-062c');
    expect(displayNamed(A_ID, h.nameOf)).toBe('Reh8120A-062c#' + A_SIGIL);
  });

  // G1-copy caller carry-over: the CLI's `receipt()` closure re-renders
  // relation.followReceived itself (with the resolved name#sigil), reading
  // reply.house from the command's own receipt. If a caller ever dropped
  // reply.house, only mcp-follow-doorbell would have noticed (it names a
  // real house) — this pins it directly.
  it('house known → receipt names it (equal to the command\'s own text apart from who)', async () => {
    const h = harness({ houseSlug: 'north-house' });

    const r = await h.follow('#' + A_SIGIL);

    expect(r.text).toBe(
      `✓ ${renderCopy('en', 'relation.followReceived', { who: 'Reh8120A-062c#' + A_SIGIL, house: 'north-house' })}`,
    );
    // Same key, same house, only `who` differs: the id runFollowCommand used
    // vs. the resolved name#sigil the CLI substitutes.
    expect(r.text.replace('Reh8120A-062c#' + A_SIGIL, A_ID)).toBe(
      `✓ ${renderCopy('en', 'relation.followReceived', { who: A_ID, house: 'north-house' })}`,
    );
  });

  it('following back a new follower names them in the receipt and the bond book', async () => {
    const h = harness({ followers: [A_ID] });

    const r = await h.follow('Reh8120A-062c#' + A_SIGIL);

    expect(r.text).toContain('Reh8120A-062c#' + A_SIGIL);
    expect(h.bondsStore.get(A_ID)?.nickname).toBe('Reh8120A-062c');
    expect(displayNamed(A_ID, h.nameOf)).toBe('Reh8120A-062c#' + A_SIGIL);
  });

  it("following by the owner's alias never writes the alias as their name", async () => {
    const h = harness();
    h.bondsStore.recordInteraction(A_ID);
    h.bondsStore.setKnowledge(A_ID, { remarkName: 'Bob' });

    await h.follow('Bob#' + A_SIGIL);

    expect(h.bondsStore.get(A_ID)?.followed).toBe(true);
    expect(h.bondsStore.get(A_ID)?.nickname).toBe('Reh8120A-062c');
    expect(h.bondsStore.get(A_ID)?.remarkName).toBe('Bob');
  });

  it('a stored house name is not replaced by the name the follow resolved', async () => {
    const h = harness();
    h.bondsStore.setNickname(A_ID, 'Old House Name');
    h.bondsStore.setKnowledge(A_ID, { remarkName: 'Bob' });

    await h.follow('Bob#' + A_SIGIL);

    expect(h.bondsStore.get(A_ID)?.followed).toBe(true);
    expect(h.bondsStore.get(A_ID)?.nickname).toBe('Old House Name');
  });
});

// Review follow-up 2026-09-26: the two `resolution.unverified` branches
// (`unknownId` / `offline`) had no test — a precise popclaw_id the house
// cannot vouch for still gets followed, but the receipt has to say so.
describe('/popclaw follow · unverified id branches', () => {
  afterEach(() => setOwnerLang('zh-CN', 'config'));

  const MIGRATIONS_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
  // A syntactically valid popclaw_id (32-byte base58) — precise-key shaped —
  // that no fixture below ever has the house actually vouch for.
  const RAW_ID = '13gLyDGH237UoVJKDxihmfKxDCUTjxrdrEKzzfRuhLei';

  function harness(fetchHouse: () => Promise<Response>) {
    setOwnerLang('en', 'config');
    const db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS_DIR);
    const bondsStore = new BondsStore(db, () => 1000);
    const socialGraph = withOutcomes({ declareFollow: vi.fn(async () => {}), following: () => [] });
    const nameOf = makeNameChain({ bond: (id) => bondsStore.get(id) });
    const rt = {
      bondsStore,
      socialGraph,
      nameOf,
      knownFollowers: { allFollowerIds: () => [] },
      worldFeedCache: { authorIds: () => [] },
      boot: { popclawId: 'OWNER_B', loreHouseUrl: 'http://house.test' },
      houseRuntime: { fetchHouse, runCommand: <T>(work: () => Promise<T>) => work() },
    };
    const map = buildSubcommands({
      ...explodingWiring(),
      runtime: async () => rt,
    } as unknown as SubcommandWiring);
    return (ref: string) => map.follow({ args: { positional: [ref] } } as unknown as Parameters<typeof map.follow>[0]);
  }

  it('house up, no match → the unknownId warning ahead of the one follow receipt', async () => {
    const fetchHouse = vi.fn(
      async () =>
        new Response(JSON.stringify({ candidates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const follow = harness(fetchHouse);

    const r = await follow(RAW_ID);

    // No house slug came back, so it's the neutral no-house variant
    // (architect ruling: never guess the home house).
    expect(r.text).toBe(
      `${renderCopy('en', 'follow.cli.unknownId', { sigil: deriveSigil(RAW_ID), id: RAW_ID })}\n` +
        `✓ ${renderCopy('en', 'relation.followReceivedNoHouse', { who: RAW_ID })}`,
    );
  });

  it('house unreachable → the one follow receipt plus the unchecked note', async () => {
    const fetchHouse = vi.fn(async (): Promise<Response> => {
      throw new Error('ECONNREFUSED');
    });
    const follow = harness(fetchHouse);

    const r = await follow(RAW_ID);

    // No house slug came back, so it's the neutral no-house variant
    // (architect ruling: never guess the home house).
    expect(r.text).toBe(
      `✓ ${renderCopy('en', 'relation.followReceivedNoHouse', { who: RAW_ID })} ` +
        `${renderCopy('en', 'follow.cli.uncheckedNote')}`,
    );
  });
});


describe('ordinary slash DM house routing', () => {
  it('uses configured home even when the recipient last wrote from another house', async () => {
    const recipient = '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM';
    const pushTo = vi.fn(async (_house: string, _bytes: Uint8Array) => ({ status: 200, eventId: 'a'.repeat(64) }));
    const history = vi.fn(() => 'house-world');
    const rt = {
      boot: { signer: makeTestSigner('BlackFeather'), nickname: 'Owner', loreHouseUrl: 'https://home.invalid', loreHouseUrls: ['https://home.invalid'] },
      egress: { home: { slug: 'house-me' }, pushTo },
      inboxStore: { houseOf: history },
      bondsStore: { list: () => [{ popclawId: recipient, nickname: 'Recipient', remarkName: '' }] },
      socialGraph: { following: () => [] },
      knownFollowers: { allFollowerIds: () => [] },
      worldFeedCache: { authorIds: () => [] },
    };
    const map = buildSubcommands({ ...explodingWiring(), runtime: async () => rt } as unknown as SubcommandWiring);
    const result = await map.message({ args: { positional: ['Recipient', 'hello'] } } as unknown as Parameters<typeof map.message>[0]);
    expect(result.text).toContain('✉');
    expect(pushTo).toHaveBeenCalledOnce();
    expect(pushTo.mock.calls[0]?.[0]).toBe('house-me');
    expect(history).not.toHaveBeenCalled();
  });
});
