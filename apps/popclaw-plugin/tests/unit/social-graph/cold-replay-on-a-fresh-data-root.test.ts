/**
 * What a cold personal stream actually costs on a brand-new data root — pinned
 * as a known limitation rather than left to be discovered.
 *
 * A follow whose signed original this client verified may be announced without
 * waiting for the follower poll's baseline. That is deliberate and it is what
 * makes a new user's first follower arrive in seconds. The price is here: a
 * data root that is fresh while the IDENTITY is not — a machine move, a vault
 * restored without its database — reads a stream that replays from the house's
 * retention floor, verifies every one of those old declarations exactly as it
 * verifies a new one, and introduces those people once.
 *
 * Nothing in the row can separate the two. The client deliberately does not
 * guess from the follower's signed timestamp: that is the follower's clock,
 * and one running minutes fast would file a genuinely new follow as history
 * and leave it unmentioned for ever, which is the defect being fixed. The
 * separator that would work is the HOUSE'S own published order, and that is
 * later work.
 *
 * So this file states the cost exactly, and bounds it: ONCE per follower, and
 * never again — not on the next drain, not after a restart, and not when the
 * poll finally reads the house's list. When the house-order boundary is built,
 * this is the test to flip.
 *
 * Documented for users in `docs/known-limitations.md`.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { openRelationReception, type RelationReception } from '../../../src/social-graph/relation-reception.js';
import {
  KnownFollowersStore,
  announceVerifiedFollowers,
  syncFollowers,
  type FollowerSyncDeps,
} from '../../../src/social-graph/followers-sync.js';
import { grantingReadAuthorityFor } from '../../helpers/read-authority.js';
import { establishHouseTrust } from '../../../src/world/house-trust.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ORIGIN = 'https://cold-replay.test';
const SLUG = hostDbSlug(ORIGIN);

const ownerKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const ME = bs58.encode(ownerKp.publicKey);

/** Four people who followed this owner long before this database existed. */
const HISTORY = [41, 42, 43, 44].map((seed) => {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
  return { kp, id: bs58.encode(kp.publicKey) };
});

function followFrame(who: typeof HISTORY[0], houseKey: string, seq: string): Uint8Array {
  const env = {
    actor: { popclawId: who.id },
    target: {},
    lorehouse: houseKey,
    timestamp: 1_713_657_600,
    followDeclared: { followeePopclawId: ME, order: { seq, houseKey } },
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, who.kp.secretKey),
  }).finish();
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((done) => { setImmediate(done); });
};

async function freshDataRoot() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const minted = mintHouse({ origin: ORIGIN, manifest: { relations: { ordered: 1 } } });
  const logs: string[] = [];
  let served: readonly string[] | undefined;

  const followerDeps: FollowerSyncDeps = {
    ownerPopclawId: ME,
    store: new KnownFollowersStore(db, () => 1000),
    notifier: new SqliteNotifier(db, () => 1000),
    socialGraph: { following: () => [] },
    fetch: (async () => (served === undefined
      ? new Response('unavailable', { status: 503 })
      : new Response(JSON.stringify(served.map((popclaw_id) => ({ popclaw_id }))), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))) as unknown as typeof globalThis.fetch,
    readAuthorityFor: grantingReadAuthorityFor,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  };

  const open = async (): Promise<RelationReception> => openRelationReception({
    db,
    recipientPopclawId: ME,
    signer: {} as never,
    readAuthorityFor: grantingReadAuthorityFor,
    onMessage: () => {},
    fetch: minted.fetch as unknown as typeof globalThis.fetch,
    notifyNewFollowers: (news) => announceVerifiedFollowers(followerDeps, news),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    drainIntervalMs: 600_000,
  });

  let r = await open();
  const first = await establishHouseTrust(db, ORIGIN, { fetch: minted.fetch as never });
  if (!first.ok) throw new Error(`fixture could not establish trust: ${first.refusal}`);
  r.host.wiring.login({ houseKey: minted.houseKey, incarnation: minted.incarnation, houseSlug: SLUG });
  const house = { slug: SLUG, baseUrl: ORIGIN } as never;

  return {
    db,
    store: new KnownFollowersStore(db, () => 1000),
    attach: () => r.hooks.attachRelations!(house, {} as never),
    /** The house hands its whole retained log to a client it has never met. */
    replayHistory: async () => {
      for (const [i, who] of HISTORY.entries()) {
        await r.hooks.onFrame!(house, {} as never, followFrame(who, minted.houseKey, String(i + 1)), `1.${i + 1}`);
      }
    },
    tick: async () => { r.host.start(); await settle(); },
    restart: async () => { r.stop(); r = await open(); },
    serve: (ids: readonly string[]) => { served = ids; },
    poll: () => syncFollowers(followerDeps, [{ slug: SLUG, baseUrl: ORIGIN }]),
    announced: () => db.queryAll<{ payload_json: string }>(
      "SELECT payload_json FROM notification_queue WHERE kind = 'followed_you' ORDER BY id",
    ).map((row) => String((JSON.parse(row.payload_json) as { followerPopclawId?: string }).followerPopclawId ?? '')),
    stop: () => { r.stop(); db.close(); },
  };
}

describe('a cold replay of an existing identity on a brand-new data root', () => {
  it('introduces each old follower exactly once, and never again', async () => {
    const t = await freshDataRoot();
    expect(await t.attach()).toEqual({ ok: true });
    await t.replayHistory();
    await t.tick();

    // The documented cost, stated plainly: four people the owner has had all
    // along are introduced. This is the limitation, not a passing accident —
    // when the house-order boundary lands, this expectation becomes `[]`.
    expect(t.announced().sort()).toEqual(HISTORY.map((h) => h.id).sort());

    // And now the bound, which is the part that makes it liveable. Another
    // drain owes nothing.
    await t.tick();
    expect(t.announced()).toHaveLength(HISTORY.length);

    // The house replays the identical log again on the next reconnect.
    await t.replayHistory();
    await t.tick();
    expect(t.announced()).toHaveLength(HISTORY.length);

    // A restart does not start the introductions over: the decision lives in
    // the row, not in a process.
    await t.restart();
    await t.replayHistory();
    await t.tick();
    expect(t.announced()).toHaveLength(HISTORY.length);

    // Nor does the poll, whose first pass now finds all four in the house's
    // list and settles a baseline over rows that are already decided.
    t.serve(HISTORY.map((h) => h.id));
    expect(await t.poll()).toBe(0);
    await t.tick();
    expect(t.announced()).toHaveLength(HISTORY.length);

    expect(t.store.list(SLUG).sort()).toEqual(HISTORY.map((h) => h.id).sort());
    expect(t.store.unannounced()).toEqual([]);
    t.stop();
  });
});
