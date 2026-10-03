/**
 * The seam between "the follow arrived" and "the owner was told", with no poll
 * in it anywhere.
 *
 * Both halves of that seam existed and neither had a test. The bridge
 * (`relation-host.ts`) writes the follower row inside the apply transaction;
 * the sweep a few lines later reads `unannounced()` and hands it to
 * `notifyNewFollowers`. `unannounced()` joined `known_followers_baseline`, and
 * the poll's first successful pass is the only thing that writes that table —
 * so a follow this client already held the signed original for was kept
 * silently until the poll got round to it, and if that first pass happened to
 * find the person in the house's list, `markBaseline` filed them as history
 * and nobody was ever told. On a fresh install that is the first minutes of
 * someone's life on the network.
 *
 * So these drive the REAL functions against a real SQLite database, through
 * the same hooks a resource set calls, with two real subjects: the frame is
 * signed by A and declares B as the followee, and B's client is the one under
 * test. The poll appears only where a case is about the poll, and its house
 * refuses the follower list by default — a pass that cannot read a list
 * cannot be the thing that announced anyone.
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
  type HouseRef,
} from '../../../src/social-graph/followers-sync.js';
import { declaringReadAuthority, grantingReadAuthorityFor } from '../../helpers/read-authority.js';
import { establishHouseTrust } from '../../../src/world/house-trust.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ORIGIN = 'https://witnessed.test';
const SLUG = hostDbSlug(ORIGIN);

/** B, the owner this client belongs to, and A, who follows them. Real keys both. */
const ownerKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const ME = bs58.encode(ownerKp.publicKey);
const followerKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
const FOLLOWER = bs58.encode(followerKp.publicKey);
/** A second person, for the cases that need two separate follower rows. */
const otherKp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(29));
const OTHER = bs58.encode(otherKp.publicKey);

function followFrame(houseKey: string, seq: string, who = { kp: followerKp, id: FOLLOWER }): Uint8Array {
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

/** The sweep is started from the tick and not awaited by it; this joins it. */
const settle = (): Promise<void> => new Promise((done) => { setImmediate(done); });

async function world() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const minted = mintHouse({ origin: ORIGIN, manifest: { relations: { ordered: 1 } } });
  const logs: string[] = [];
  const notifier = new SqliteNotifier(db, () => 1000);
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;

  // The house's own follower list. Refused until a case says otherwise: a poll
  // that cannot read a list cannot be what announced anybody, so every case
  // below that does not arrange one is proving the event path on its own.
  let served: readonly string[] | undefined;
  const followerDeps: FollowerSyncDeps = {
    ownerPopclawId: ME,
    store: new KnownFollowersStore(db, () => 1000),
    notifier,
    socialGraph: { following: () => [] },
    fetch: (async () => (served === undefined
      ? new Response('unavailable', { status: 503 })
      : new Response(JSON.stringify(served.map((popclaw_id) => ({ popclaw_id }))), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))) as unknown as typeof globalThis.fetch,
    readAuthorityFor: grantingReadAuthorityFor,
    // The external standing lookup the announce pass awaits for every
    // follower BEFORE anything is marked. In production it is an HTTP read;
    // here a test can hold it open to stand where a slow one stands.
    verifiedFollowers: {
      refresh: async () => { if (held !== undefined) await held; },
      getFresh: () => undefined,
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  };

  const open = async (): Promise<RelationReception> => openRelationReception({
    db,
    recipientPopclawId: ME,
    signer: {} as never,
    readAuthorityFor: declaringReadAuthority(db, {} as never),
    onMessage: () => {},
    fetch: minted.fetch as unknown as typeof globalThis.fetch,
    notifyNewFollowers: (news) => announceVerifiedFollowers(followerDeps, news, () => ORIGIN),
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    // Far longer than any case here lasts. `start()` runs one tick by hand, so
    // what the sweep does is decided by the test and never by a clock.
    drainIntervalMs: 600_000,
  });

  let r = await open();
  const first = await establishHouseTrust(db, ORIGIN, { fetch: minted.fetch as never });
  if (!first.ok) throw new Error(`fixture could not establish trust: ${first.refusal}`);
  r.host.wiring.login({ houseKey: minted.houseKey, incarnation: minted.incarnation, houseSlug: SLUG });
  const house = { slug: SLUG, baseUrl: ORIGIN } as never;
  const houseRef: HouseRef = { slug: SLUG, baseUrl: ORIGIN };

  return {
    db, minted, house, houseRef, logs, followerDeps,
    store: new KnownFollowersStore(db, () => 1000),
    get reception() { return r; },
    serve: (ids: readonly string[]) => { served = ids; },
    attach: () => r.hooks.attachRelations!(house, {} as never),
    frame: (seq = '1', position = '1.1') =>
      r.hooks.onFrame!(house, {} as never, followFrame(minted.houseKey, seq), position),
    frameFromOther: (seq = '9', position = '1.9') =>
      r.hooks.onFrame!(house, {} as never, followFrame(minted.houseKey, seq, { kp: otherKp, id: OTHER }), position),
    /** Make every standing lookup hang until the returned function is called. */
    holdEnrichment: () => {
      held = new Promise<void>((done) => { release = () => done(); });
      return () => { release?.(); held = undefined; };
    },
    settle,
    /** Commit boundary → projection, with nothing announced: the drain's first half. */
    apply: () => { r.host.wiring.drain(20); },
    /** One production drain tick: apply, then sweep what is owed. */
    tick: async () => { r.host.start(); await settle(); },
    /** This process ends and another on the same data root takes over. */
    restart: async () => { r.stop(); r = await open(); },
    poll: () => syncFollowers(followerDeps, [houseRef]),
    edges: () => db.queryAll<{ follower_popclaw_id: string; state: string }>(
      'SELECT follower_popclaw_id, state FROM relation_edges'),
    announced: () => db.queryAll<{ kind: string; payload_json: string }>(
      'SELECT kind, payload_json FROM notification_queue ORDER BY id',
    ).map((row) => ({
      kind: row.kind,
      follower: String((JSON.parse(row.payload_json) as { followerPopclawId?: string }).followerPopclawId ?? ''),
    })),
    stop: () => { r.stop(); db.close(); },
  };
}

const ONE_ANNOUNCEMENT = [{ kind: 'followed_you', follower: FOLLOWER }];

describe('a follow that arrives on the relation stream', () => {
  it('is announced on the next drain although no poll pass has ever run', async () => {
    const t = await world();
    await t.attach();
    await t.frame();

    // The state a fresh install is actually in: nothing has written a
    // baseline for this house, and until now that alone kept the owner in
    // the dark for up to a whole poll interval.
    expect(t.store.hasBaseline(SLUG)).toBe(false);

    await t.tick();

    expect(t.edges()).toEqual([{ follower_popclaw_id: FOLLOWER, state: 'following' }]);
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);
    // Still no baseline: the poll had no hand in this.
    expect(t.store.hasBaseline(SLUG)).toBe(false);

    // Exactly once — the row is settled, so the next tick owes nothing.
    await t.tick();
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);
    t.stop();
  });

  it('is not settled away by the first poll pass that finds the same person listed', async () => {
    const t = await world();
    await t.attach();
    await t.frame();
    // The projection and the follower row land; nothing has been told yet.
    t.apply();
    expect(t.store.list(SLUG)).toEqual([FOLLOWER]);
    expect(t.announced()).toEqual([]);

    // Now the first successful poll pass — and the house's list names exactly
    // the person whose declaration this client just witnessed. The baseline it
    // establishes used to file them as history and end the matter.
    t.serve([FOLLOWER]);
    expect(await t.poll()).toBe(0);
    expect(t.store.hasBaseline(SLUG)).toBe(true);
    expect(t.announced()).toEqual([]);

    await t.tick();
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);

    await t.tick();
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);
    t.stop();
  });

  it('leaves alone the followers a house listed before this client ever looked — the control', async () => {
    const t = await world();
    await t.attach();
    // No frame: this client has witnessed nothing. The same person is simply
    // in the house's list when the very first pass reads it.
    t.serve([FOLLOWER]);

    expect(await t.poll()).toBe(0);
    expect(t.store.hasBaseline(SLUG)).toBe(true);
    expect(t.store.list(SLUG)).toEqual([FOLLOWER]);

    await t.tick();
    expect(t.announced()).toEqual([]);
    expect(t.store.unannounced()).toEqual([]);
    t.stop();
  });

  it('is announced once when the event comes first and the poll then lists them', async () => {
    const t = await world();
    await t.attach();
    await t.frame();
    await t.tick();
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);

    // The backstop runs its first pass afterwards and sees them in the list.
    t.serve([FOLLOWER]);
    expect(await t.poll()).toBe(0);
    await t.tick();

    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);
    t.stop();
  });

  it('is announced once when the poll gets there first and the event follows', async () => {
    const t = await world();
    await t.attach();
    // A baseline from a pass that found nobody, then a pass that finds A: the
    // ordinary poll path, which announces them itself.
    t.serve([]);
    expect(await t.poll()).toBe(0);
    t.serve([FOLLOWER]);
    expect(await t.poll()).toBe(1);
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);

    // The signed original arrives afterwards — the same edge, said twice by
    // two sources. The owner hears about it once.
    await t.frame();
    await t.tick();

    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);
    t.stop();
  });

  it('is announced once however many times the house replays the same frame', async () => {
    const t = await world();
    await t.attach();
    await t.frame('1', '1.1');
    await t.frame('1', '1.1');
    await t.tick();
    await t.frame('1', '1.1');
    await t.tick();

    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);
    t.stop();
  });

  it('is announced once even when the enrichment it waits on outlives several ticks', async () => {
    const t = await world();
    await t.attach();
    await t.frame();

    // The announce pass awaits an external standing lookup for EVERY follower
    // before it marks anybody. The row is the record, but it is written at the
    // END of the pass — so while one pass is still out there, the next tick
    // reads the same unannounced row from the table and, with no fence,
    // introduces the same person a second time.
    const finishEnrichment = t.holdEnrichment();
    await t.tick();
    await t.tick();
    await t.tick();
    expect(t.announced()).toEqual([]); // still in flight; nothing settled yet

    finishEnrichment();
    await t.settle();
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);

    // And the fence is a fence, not a wedge: the leg is free again, so the
    // next person through it is introduced normally.
    await t.frameFromOther();
    await t.tick();
    expect(t.announced()).toEqual([
      ...ONE_ANNOUNCEMENT,
      { kind: 'followed_you', follower: OTHER },
    ]);
    t.stop();
  });

  it('is announced once when the process ends between learning it and telling it', async () => {
    const t = await world();
    await t.attach();
    await t.frame();
    // Learned and committed, nobody told — then this process ends.
    t.apply();
    expect(t.store.list(SLUG)).toEqual([FOLLOWER]);
    expect(t.announced()).toEqual([]);

    await t.restart();
    // The debt lives in the row, so the next process on this data root pays
    // it without having seen the frame at all.
    await t.tick();
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);

    await t.tick();
    expect(t.announced()).toEqual(ONE_ANNOUNCEMENT);
    t.stop();
  });
});
