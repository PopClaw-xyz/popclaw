import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { relationSigningReadiness } from '../../../src/social-graph/relation-wiring.js';
import { makeRelationEnqueueWork, drainRelationAttempts } from '../../../src/social-graph/relation-consumer.js';
import { signFollowDeclared, signFollowRevoked } from '../../../src/social-graph/sign-event.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { makeRelationScopeResolver } from '../../../src/social-graph/relation-scope.js';
import { SocialGraph } from '../../../src/social-graph/social-graph.js';
import { RelationAllocator } from '../../../src/social-graph/relation-allocator.js';
import { createRelationProducer } from '../../../src/social-graph/relation-producer.js';
import { makeRelationBindingPreparer } from '../../../src/social-graph/relation-binding.js';
import { makeTestSigner } from '../../helpers/test-signer.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const target = '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM';
async function fixture(failFirst = false, real = false) {
  const db = new InMemoryHostDb(); runMigrations(db, migrations);
  const me = mintHouse({ origin: 'https://house.popclaw.me', seed: 7, manifest: { relations: { ordered: 1 } } });
  const world = mintHouse({ origin: 'https://house.popclaw.world', seed: 8, manifest: { relations: { ordered: 1 } } });
  const game = mintHouse({ origin: 'https://game.example.test', seed: 9, manifest: { relations: { ordered: 1 } } });
  const houses = [me, world, game].map((h, i) => ({ slug: ['house-popclaw-me', 'house-popclaw-world', 'game-example-test'][i]!, origin: h.origin }));
  const prepare = makeRelationBindingPreparer({ db });
  for (const h of [me, world, game]) {
    const proof = await prepare({ origin: h.origin, rawBytes: h.bodyBytes, proofHeader: h.proofHeader, signal: new AbortController().signal });
    db.transaction(tx => proof.commit(tx));
  }
  const fetch = vi.fn(async (input: unknown) => new URL(String(input)).origin === me.origin ? me.fetch(input) : new URL(String(input)).origin === world.origin ? world.fetch(input) : game.fetch(input));
  const seen = vi.fn(() => 'house-popclaw-world');
  const scope = makeRelationScopeResolver({ db, houses, houseOf: seen, fetch: fetch as typeof globalThis.fetch });
  const pushes: { slug?: string; bytes: Uint8Array }[] = [];
  const seed = new Uint8Array(32).fill(11), pair = nacl.sign.keyPair.fromSeed(seed);
  const signer = real ? new MasterKeySigner({ seed, publicKey: pair.publicKey, secretKey: pair.secretKey, popclawId: bs58.encode(pair.publicKey) }) : makeTestSigner('BlackFeather');
  const pending = vi.fn();
  const producer = createRelationProducer({ db, signer, resolveScope: scope,
    signingReadiness: real ? relationSigningReadiness(db) : () => 'ready', recordPendingIntent: pending, push: async (bytes, slug) => {
      pushes.push({ slug, bytes: new Uint8Array(bytes) });
      if (failFirst && pushes.length === 1) throw new Error('synthetic transport failure');
      return { status: 200, eventId: popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload).eventId! };
    } });
  const declare = (house?: string) => producer.declare(target, house === undefined ? {} : { house });
  return { db, scope, producer, pushes, pending, seen, declare, signer, me, world };
}

describe('new follow default and explicit house', () => {
  it('ordinary new follow uses me despite a world discovery', async () => {
    const f = await fixture();
    expect(await f.declare()).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-me' });
    expect(f.pushes.map(p => p.slug)).toEqual(['house-popclaw-me']);
    expect(f.seen).not.toHaveBeenCalled();
  });
  it.each(['house-popclaw-world', 'https://house.popclaw.world'])('explicit %s signs and pushes only world', async house => {
    const f = await fixture();
    expect(await f.declare(house)).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-world' });
    const env = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(f.pushes[0]!.bytes).payload);
    expect(env.followDeclared?.order?.houseKey).toBe(f.world.houseKey);
    expect(f.pushes.map(p => p.slug)).toEqual(['house-popclaw-world']);
  });
  it.each(['unknown', 'http://house.popclaw.world', 'https://u:p@house.popclaw.world', 'https://house.popclaw.world/path', 'https://house.popclaw.world?x=1', 'https://house.popclaw.world:444', '//house.popclaw.world'])('does not substitute a default for %s', async house => {
    const f = await fixture();
    expect(await f.declare(house)).toMatchObject({ mode: 'none', reason: 'HOUSE_BINDING_UNPROVEN' });
    expect(f.pushes).toEqual([]);
    expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toEqual([]);
  });
  it('explicit joined permission must remain active', async () => {
    const f = await fixture();
    f.db.execute('UPDATE relation_participation SET active=0 WHERE house_key=?', [f.world.houseKey]);
    expect(await f.declare('house-popclaw-world')).toMatchObject({ mode: 'none', reason: 'HOUSE_BINDING_UNPROVEN' });
    expect(f.pushes).toEqual([]);
  });
  it('a repeated old-world declaration retries its original without migrating to me', async () => {
    const f = await fixture(true);
    const first = await f.declare('house-popclaw-world');
    const again = await f.declare();
    expect(again).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-world', restated: true, eventId: (first as { eventId: string }).eventId });
    expect(f.pushes[1]).toEqual(f.pushes[0]);
    expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toHaveLength(1);
  });
  it('retains the original house when a crash lost the declaration ledger', async () => {
    const f = await fixture(true);
    const first = await f.declare('house-popclaw-world');
    f.db.execute('DELETE FROM follow_events');
    expect(await f.declare()).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-world', restated: true, eventId: (first as { eventId: string }).eventId });
    expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toHaveLength(1);
  });
  it('an explicit second-house follow creates a distinct edge and preserves the first', async () => {
    const f = await fixture();
    await f.declare('house-popclaw-world');
    await f.declare('house-popclaw-me');
    expect(f.pushes.map(p => p.slug)).toEqual(['house-popclaw-world', 'house-popclaw-me']);
    expect(f.db.queryAll('SELECT house_key FROM relation_outbox')).toHaveLength(2);
  });
});

describe('house-scoped active follow and unfollow', () => {
  it('prefers the existing home edge when ordinary follow has multiple edges', async () => {
    const f = await fixture();
    await f.declare('house-popclaw-world');
    const home = await f.declare('house-popclaw-me');
    expect(await f.declare()).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-me', restated: true, eventId: (home as {eventId:string}).eventId });
    expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toHaveLength(2);
  });
  it('requires an explicit house when multiple active edges exclude home', async () => {
    const f = await fixture();
    await f.declare('house-popclaw-world'); await f.declare('game-example-test');
    expect(await f.declare()).toMatchObject({ mode: 'none', transport: 'unchanged', reason: 'HOUSE_SELECTION_REQUIRED' });
    expect(f.pending).not.toHaveBeenCalled();
    expect(f.pushes).toHaveLength(2);
    expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toHaveLength(2);
  });
  it('ordinary unfollow requires house for multiple edges, including home', async () => {
    const f = await fixture();
    await f.declare('house-popclaw-world'); await f.declare('house-popclaw-me');
    expect(await f.producer.revoke(target)).toMatchObject({ mode: 'none', transport: 'unchanged', reason: 'HOUSE_SELECTION_REQUIRED' });
    expect(f.pending).not.toHaveBeenCalled();
    expect(f.pushes).toHaveLength(2);
  });
  it('an explicit unfollow revokes only that edge; the remaining edge can be restated', async () => {
    const f = await fixture();
    const world = await f.declare('house-popclaw-world'); await f.declare('house-popclaw-me');
    expect(await f.producer.revoke(target, { house: 'https://house.popclaw.me' })).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-me' });
    expect(await f.declare()).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-world', restated: true, eventId: (world as {eventId:string}).eventId });
    expect(f.pushes.map(p=>p.slug)).toEqual(['house-popclaw-world','house-popclaw-me','house-popclaw-me']);
  });
  it('zero active unfollow is an idempotent no-op; the next new follow uses home', async () => {
    const f = await fixture();
    expect(await f.producer.revoke(target)).toMatchObject({ mode: 'none', reason: 'RELATION_NOT_FOLLOWING' });
    await f.declare('house-popclaw-world'); await f.producer.revoke(target);
    expect(await f.producer.revoke(target)).toMatchObject({ mode: 'none', reason: 'RELATION_NOT_FOLLOWING' });
    expect(await f.declare()).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-me' });
    expect(f.pushes.map(p=>p.slug)).toEqual(['house-popclaw-world','house-popclaw-world','house-popclaw-me']);
  });
  it('a lost revoke ledger does not resurrect the old world declaration', async () => {
    const f = await fixture();
    await f.declare('house-popclaw-world'); await f.producer.revoke(target);
    f.db.execute("DELETE FROM follow_events WHERE type='FollowRevoked'");
    expect(await f.declare()).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-me' });
  });
});

it('repeating an explicit revoked edge is a no-op even with retained signed history', async () => {
  const f = await fixture();
  await f.declare('house-popclaw-world');
  await f.producer.revoke(target, { house: 'house-popclaw-world' });
  expect(await f.producer.revoke(target, { house: 'house-popclaw-world' })).toMatchObject({ mode: 'none', reason: 'RELATION_NOT_FOLLOWING' });
  expect(f.pushes).toHaveLength(2);
});

it('does not resend an old declaration that verified newer revoke superseded', async () => {
  const f = await fixture();
  await f.declare('house-popclaw-world');
  const owner = await makeTestSigner('BlackFeather').popclawId();
  f.db.execute(`INSERT INTO relation_edges (house_key,follower_popclaw_id,followee_popclaw_id,state,applied_seq,applied_event_id,updated_at)
    VALUES (?,?,?,'revoked',2,'synthetic-verified-revoke',1)`, [f.world.houseKey, owner, target]);
  const allocator = new RelationAllocator(f.db);
  allocator.observeVerified(f.world.houseKey, target, 2n);
  allocator.markIssuanceRecovered(f.world.houseKey, target, 2n, '');
  const result = await f.declare('house-popclaw-world');
  expect(result).toMatchObject({ mode: 'ordered', seq: 3n });
  expect(result).not.toHaveProperty('restated');
  expect(f.pushes).toHaveLength(2);
});

it('the active union retains a consumer-only follow after revoking another house', async () => {
  const f = await fixture();
  await f.declare('house-popclaw-me');
  const signer = makeTestSigner('BlackFeather'), owner = await signer.popclawId();
  f.db.execute(`INSERT INTO relation_edges (house_key,follower_popclaw_id,followee_popclaw_id,state,applied_seq,applied_event_id,updated_at)
    VALUES (?,?,?,'following',5,'synthetic-verified-follow',1)`, [f.world.houseKey, owner, target]);
  const graph = new SocialGraph({ db: f.db, signer, relationProducer: f.producer, primaryHouse: 'house-popclaw-me' });
  await graph.start();
  expect(await graph.revokeFollowWithOutcome(target, { house: 'house-popclaw-me' })).toMatchObject({ mode: 'ordered', transport: 'accepted' });
  // The ledger-only view is empty; the authoritative per-house read retains world.
  expect(graph.following()).toEqual([]);
  expect(await graph.activeFollowHouses(target)).toEqual({ houses: ['house-popclaw-world'] });
});

it('unknown original state blocks implicit routing but an explicit independent house stays usable', async () => {
  const f = await fixture();
  const allocator = new RelationAllocator(f.db);
  allocator.observeVerified(f.world.houseKey, target, 4n);
  expect(await f.declare()).toMatchObject({ mode: 'none', reason: 'RELATION_SIGNING_NOT_READY' });
  expect(await f.declare('house-popclaw-world')).toMatchObject({ mode: 'none', reason: 'RELATION_SIGNING_NOT_READY' });
  expect(f.pushes).toEqual([]);
  expect(await f.declare('house-popclaw-me')).toMatchObject({ mode: 'ordered', houseSlug: 'house-popclaw-me' });
  expect(f.pushes.map(p=>p.slug)).toEqual(['house-popclaw-me']);
});
it('an unlocatable original namespace cannot be bypassed by explicit home', async () => {
  const f = await fixture();
  new RelationAllocator(f.db).observeVerified('unknown-synthetic-house-key', target, 4n);
  expect(await f.declare('house-popclaw-me')).toMatchObject({ mode: 'none', reason: 'RELATION_SIGNING_NOT_READY' });
  expect(f.pushes).toEqual([]);
  expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toEqual([]);
});

async function receiveOwnRelation(f: Awaited<ReturnType<typeof fixture>>, declared: boolean, seq: bigint) {
  const signer = f.signer, owner = await signer.popclawId();
  const signed = await (declared ? signFollowDeclared(signer, { followee: target, followType: 'PUBLIC', tasteSubscribed: false, order: { houseKey: f.world.houseKey, seq } })
    : signFollowRevoked(signer, { followee: target, followType: 'PUBLIC', order: { houseKey: f.world.houseKey, seq } }));
  const source = { houseKey: f.world.houseKey, incarnation: f.world.incarnation, ownerGeneration: 1, houseSlug: 'house-popclaw-world' };
  const result = f.db.transaction(tx => makeRelationEnqueueWork({ recipientPopclawId: owner })(tx, {
    stream: 'personal', source, eventId: signed.eventId, envelopeBytes: popclaw.identity.SignedPayload.decode(signed.signedPayloadBytes).payload,
  }));
  expect(result).toMatchObject({ status: 'accepted' });
  expect(drainRelationAttempts(f.db, [source])).toContainEqual(expect.objectContaining({ eventId: signed.eventId, verdict: 'applied' }));
}
it('real consumer advancement cannot cause a new CID to reuse the verified sequence', async () => {
  const f = await fixture(false, true);
  expect(await f.declare('house-popclaw-world')).toMatchObject({ mode: 'ordered', seq: 1n });
  await receiveOwnRelation(f, false, 2n);
  const allocator = new RelationAllocator(f.db);
  expect(allocator.bound(f.world.houseKey, target).observed).toBe(0n);
  expect(await f.declare('https://house.popclaw.world')).toMatchObject({ mode: 'none', reason: 'RELATION_SIGNING_NOT_READY' });
  expect(f.db.queryAll('SELECT seq FROM relation_outbox')).toEqual([{ seq: 1 }]);
  expect(f.pushes).toHaveLength(1);
  expect(allocator.bound(f.world.houseKey, target).observed).toBe(0n);
});
it('consumer-only own follow cannot be revoked below its verified position', async () => {
  const f = await fixture(false, true);
  await receiveOwnRelation(f, true, 5n);
  expect(await f.producer.revoke(target, { house: 'house-popclaw-world' })).toMatchObject({ mode: 'none', reason: 'RELATION_SIGNING_NOT_READY' });
  expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toEqual([]);
  expect(f.pushes).toEqual([]);
});
it('normal fresh follow, unfollow and new follow use distinct increasing signed positions', async () => {
  const f = await fixture(false, true);
  expect(await f.declare()).toMatchObject({ mode: 'ordered', seq: 1n, houseSlug: 'house-popclaw-me' });
  expect(await f.producer.revoke(target)).toMatchObject({ mode: 'ordered', seq: 2n, houseSlug: 'house-popclaw-me' });
  expect(await f.declare()).toMatchObject({ mode: 'ordered', seq: 3n, houseSlug: 'house-popclaw-me' });
});
it('an ordered original without a route or same-key pin cannot silently become current home', async () => {
  const f = await fixture();
  await f.declare('house-popclaw-world');
  f.db.execute('DELETE FROM follow_events');
  f.db.execute('UPDATE relation_outbox SET house_slug=NULL');
  f.db.execute('DELETE FROM house_binding_pin WHERE house_key=?', [f.world.houseKey]);
  expect(await f.declare()).toMatchObject({ mode: 'none', reason: 'RELATION_SIGNING_NOT_READY' });
  expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toHaveLength(1);
  expect(f.pushes).toHaveLength(1);
});
it('an original missing route metadata safely stops before retry or incorrect ledger repair', async () => {
  const f = await fixture(true);
  await f.declare('house-popclaw-world');
  f.db.execute('DELETE FROM follow_events');
  f.db.execute('UPDATE relation_outbox SET house_slug=NULL');
  expect(await f.declare()).toMatchObject({ mode: 'none', reason: 'ORDERED_EDGE_NEEDS_BINDING' });
  expect(f.db.queryAll('SELECT house_slug FROM follow_events')).toEqual([]);
  expect(f.db.queryAll('SELECT event_id FROM relation_outbox')).toHaveLength(1);
  expect(f.pushes).toHaveLength(1);
});
it.each(['https://house.popclaw.world/.', 'https://house.popclaw.world/%2e', 'https://house.popclaw.world/a/..'])('explicit origin rejects a raw path before URL folding: %s', async house => {
  const f = await fixture();
  expect(await f.declare(house)).toMatchObject({ mode: 'none', reason: 'HOUSE_BINDING_UNPROVEN' });
  expect(f.pushes).toEqual([]);
});
