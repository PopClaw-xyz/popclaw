import { describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { RelationAllocator } from '../../../src/social-graph/relation-allocator.js';
import { signFollowDeclared, signFollowRevoked } from '../../../src/social-graph/sign-event.js';
import { activeRelationHouses } from '../../../src/social-graph/relation-active-houses.js';
import { makeTestSigner } from '../../helpers/test-signer.js';

const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const signer = makeTestSigner('BlackFeather');
const owner = '7LhZ8x6c8Kmw5P9Wtnm4T6E7YcbTpZ7N7tfZcqLRv5cM';
const person = '6EowM7D4wqWmMdMLmhmpoFZ1SeJrPdGK7VNLk2fKswvM';
function setup() {
  const db = new InMemoryHostDb();
  runMigrations(db, migrations);
  const allocator = new RelationAllocator(db);
  async function original(key: string, house: string | undefined, seq: bigint, following = true, ledger = false) {
    const signed = await (following ? signFollowDeclared(signer, { followee: person, followType: 'PUBLIC', tasteSubscribed: false, order: { houseKey: key, seq } })
      : signFollowRevoked(signer, { followee: person, followType: 'PUBLIC', order: { houseKey: key, seq } }));
    allocator.recordSigned({ eventId: signed.eventId, houseKey: key, followeePopclawId: person, seq, houseSlug: house, signedPayload: signed.signedPayloadBytes });
    if (ledger) log(house, following, signed.eventId);
    return signed.eventId;
  }
  function log(house: string | undefined, following = true, id: string | null = null) {
    db.execute("INSERT INTO follow_events (type,followee,follow_type,taste_subscribed,timestamp,signature,house_slug,event_id) VALUES (?,?,'PUBLIC',0,1,'',?,?)",
      [following ? 'FollowDeclared' : 'FollowRevoked', person, house ?? '', id]);
  }
  function edge(key: string, seq: bigint | null, following: boolean, id = 'consumer', follower = owner, conflicted = 0) {
    db.execute('INSERT INTO relation_edges (house_key,follower_popclaw_id,followee_popclaw_id,state,applied_seq,applied_event_id,conflicted,updated_at) VALUES (?,?,?,?,CAST(? AS INTEGER),?,?,1)',
      [key, follower, person, following ? 'following' : 'revoked', seq?.toString() ?? null, id, conflicted]);
  }
  function pin(key: string, origin: string) {
    db.execute("INSERT INTO house_binding_pin (origin,house_key,incarnation,source,first_trusted_at,confirmed_at) VALUES (?,?,'inc','configured',1,1)", [origin, key]);
  }
  return { db, allocator, original, log, edge, pin, active: () => activeRelationHouses(db, person, owner) };
}

describe('activeRelationHouses: local intent and verified ordering', () => {
  it('empty history is known empty without writes', () => {
    const f = setup();
    const write = vi.spyOn(f.db, 'execute');
    expect(f.active()).toEqual({ houses: [] });
    expect(write).not.toHaveBeenCalled();
  });
  it('keeps only the latest public ledger state per house', () => {
    const f = setup(); f.log('house-me'); f.log('house-world'); f.log('house-world', false);
    expect(f.active()).toEqual({ houses: ['house-me'] });
  });
  it('recovers a queued declaration route when its ledger write is absent', async () => {
    const f = setup(); await f.original('world', 'house-world', 1n);
    expect(f.active()).toEqual({ houses: ['house-world'] });
  });
  it('latest own revoke defeats its old declare even without the revoke ledger row', async () => {
    const f = setup(); await f.original('world', 'house-world', 1n, true, true); await f.original('world', 'house-world', 2n, false);
    expect(f.active()).toEqual({ houses: [] });
  });
  it('newer consumer revoke defeats stale own declare and stale ledger', async () => {
    const f = setup(); await f.original('world', 'house-world', 7n, true, true); f.edge('world', 8n, false);
    expect(f.active()).toEqual({ houses: [] });
  });
  it('newer queued local follow can supersede consumer revoke', async () => {
    const f = setup(); await f.original('world', 'house-world', 9n); f.edge('world', 8n, false);
    expect(f.active()).toEqual({ houses: ['house-world'] });
  });
  it('newer queued local revoke can supersede consumer follow', async () => {
    const f = setup(); await f.original('world', 'house-world', 9n, false); f.edge('world', 8n, true);
    expect(f.active()).toEqual({ houses: [] });
  });
  it('does not compare sequence positions across independent houses', async () => {
    const f = setup(); await f.original('me', 'house-me', 100n, false); await f.original('world', 'house-world', 1n);
    expect(f.active()).toEqual({ houses: ['house-world'] });
  });
  it('does not choose a winner between keys attached to the same route', async () => {
    const f = setup(); await f.original('old', 'house-world', 100n); await f.original('new', 'house-world', 1n, false);
    expect(f.active()).toMatchObject({ uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN', uncertainHouses: ['house-world'] });
  });
  it('equal sequence with a different consumer CID is uncertain', async () => {
    const f = setup(); await f.original('world', 'house-world', 7n); f.edge('world', 7n, false, 'different');
    expect(f.active().uncertainHouses).toEqual(['house-world']);
  });
  it('same original and applied projection agree without uncertainty', async () => {
    const f = setup(); const id = await f.original('world', 'house-world', 7n); f.edge('world', 7n, true, id);
    expect(f.active()).toEqual({ houses: ['house-world'] });
  });
  it('higher observed evidence without its effective state is not known zero', async () => {
    const f = setup(); await f.original('world', 'house-world', 7n); f.allocator.observeVerified('world', person, 8n);
    expect(f.active().uncertainHouses).toEqual(['house-world']);
  });
  it('conflicted projection is localized and does not borrow new authority', async () => {
    const f = setup(); await f.original('me', 'house-me', 1n); const id = await f.original('world', 'house-world', 1n); f.edge('world', 1n, true, id, owner, 1);
    expect(f.active()).toMatchObject({ houses: ['house-me'], uncertainHouses: ['house-world'] });
  });
  it('restored consumer-only own edge gets its route from the durable pin', () => {
    const f = setup(); f.pin('world', 'https://house.popclaw.world'); f.edge('world', 8n, true);
    expect(f.active()).toEqual({ houses: ['house-popclaw-world'] });
  });
  it('an incoming other-author edge is not an outgoing follow', () => {
    const f = setup(); f.pin('world', 'https://house.popclaw.world'); f.edge('world', 8n, true, 'other', person);
    expect(f.active()).toEqual({ houses: [] });
  });
  it('unmapped restored own edge reports global uncertainty', () => {
    const f = setup(); f.edge('world', 8n, true);
    expect(f.active()).toEqual({ houses: [], uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN' });
  });
  it('compares exact positions above Number precision', async () => {
    const f = setup(); const high = 9007199254740993n; await f.original('world', 'house-world', high); f.edge('world', high + 1n, false);
    expect(f.active()).toEqual({ houses: [] });
  });
  it('fills an empty original/ledger route only from that namespace pin', async () => {
    const f = setup(); await f.original('world', undefined, 1n, true, true); f.pin('world', 'https://house.popclaw.world');
    expect(f.active()).toEqual({ houses: ['house-popclaw-world'] });
  });
  it('unrelated pin metadata cannot create uncertainty for this followee', () => {
    const f = setup(); f.pin('unrelated', 'not-a-url');
    expect(f.active()).toEqual({ houses: [] });
  });
  it('higher unresolved valid recovery evidence is not known zero', async () => {
    const f = setup(); await f.original('world', 'house-world', 7n);
    f.db.execute("INSERT INTO relation_event_log (house_key,follower_popclaw_id,followee_popclaw_id,event_id,seq,kind,verdict,recorded_at) VALUES ('world',?,?,'recovery',8,'FollowRevoked','pending',1)", [owner, person]);
    expect(f.active().uncertainHouses).toEqual(['house-world']);
  });
  it('cannot derive outgoing edges without a current owner identity', () => {
    const f = setup(); f.log('house-me');
    expect(activeRelationHouses(f.db, person, '')).toEqual({ houses: [], uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN' });
  });
  it('does not overwrite a second original at the same namespace position in damaged storage', async () => {
    const f = setup(); await f.original('world', 'house-world', 7n);
    f.db.execute('DROP INDEX idx_relation_outbox_one_original_per_seq');
    const fork = await signFollowRevoked(signer, { followee: person, followType: 'PUBLIC', order: { houseKey: 'world', seq: 7n } });
    f.db.execute('INSERT INTO relation_outbox (event_id,house_key,followee_popclaw_id,seq,signed_payload,house_slug,created_at) VALUES (?,?,?,7,?,?,1)',
      [fork.eventId, 'world', person, fork.signedPayloadBytes, 'house-world']);
    expect(f.active()).toEqual({ houses: [], uncertain: 'RELATION_ACTIVE_STATE_UNCERTAIN', uncertainHouses: ['house-world'] });
  });
});
