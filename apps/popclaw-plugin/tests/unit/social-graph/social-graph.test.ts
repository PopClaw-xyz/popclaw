import { describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SocialGraph } from '../../../src/social-graph/social-graph';
import { Keystore } from '../../../src/identity/keystore';
import { MasterKeySigner } from '../../../src/identity/master-key-signer';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { fakeRelationProducer } from '../../helpers/fake-relation-producer.js';

// Relation writes now require the ordered producer to be installed; a
// stub declares that dependency. These cases still assert the CURRENT
// write behaviour — the bridge that hands the write to the producer is
// the next unit, and these assertions change with it.

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

async function makeSigner() {
  const host = new InMemoryHostAdapter();
  const key = await new Keystore(host).loadOrGenerate();
  return new MasterKeySigner(key);
}
function makeDb(): InMemoryHostDb {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  return db;
}

describe('SocialGraph', () => {
  it('declareFollow appends to follow_events AND pushes to egress', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    const push = vi.fn().mockResolvedValue(undefined);
    const sg = new SocialGraph({ db, signer, egressPush: push, relationProducer: fakeRelationProducer({ db, egressPush: push }).producer });
    await sg.start();
    await sg.declareFollow('BBB');

    const rows = db.queryAll<{ type: string; followee: string; follow_type: string }>(
      'SELECT type, followee, follow_type FROM follow_events ORDER BY id ASC',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'FollowDeclared', followee: 'BBB', follow_type: 'PUBLIC',
    });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it('revokeFollow appends to follow_events AND pushes', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    const push = vi.fn().mockResolvedValue(undefined);
    const sg = new SocialGraph({ db, signer, egressPush: push, relationProducer: fakeRelationProducer({ db, egressPush: push }).producer });
    await sg.start();
    await sg.declareFollow('BBB');
    await sg.revokeFollow('BBB');

    const rows = db.queryAll<{ type: string; followee: string }>(
      'SELECT type, followee FROM follow_events ORDER BY id ASC',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: 'FollowRevoked', followee: 'BBB' });
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('following() reflects current materialized state', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    const sg = new SocialGraph({ db, signer, egressPush: vi.fn(), relationProducer: fakeRelationProducer({ db }).producer });
    await sg.start();
    await sg.declareFollow('B');
    await sg.declareFollow('C');
    await sg.revokeFollow('B');
    expect(sg.following().map((f) => f.popclawId)).toEqual(['C']);
  });

  it('start() rebuilds state from existing follow_events on the same db', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    const sg1 = new SocialGraph({ db, signer, egressPush: vi.fn(), relationProducer: fakeRelationProducer({ db }).producer });
    await sg1.start();
    await sg1.declareFollow('B');
    // simulate plugin restart against the same DB
    const sg2 = new SocialGraph({ db, signer, egressPush: vi.fn(), relationProducer: fakeRelationProducer({ db }).producer });
    await sg2.start();
    expect(sg2.following().map((f) => f.popclawId)).toEqual(['B']);
  });

  it('a failed push leaves the follow durable and queued, and does not throw', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    const push = vi.fn().mockRejectedValue(new Error('network down'));
    const warns: string[] = [];
    const sg = new SocialGraph({
      relationProducer: fakeRelationProducer({ db, egressPush: push }).producer,
      db, signer, egressPush: push,
      logger: { info: () => {}, warn: (m) => warns.push(m), error: () => {} },
    });
    await sg.start();
    // The contract changed with the producer, and for the better: a signed
    // original that could not be delivered is durable and re-sent, so the
    // network being down is no longer an exception the caller must catch and
    // no longer a reason to lose the owner's intent.
    const outcome = await sg.declareFollowWithOutcome('BBB');
    expect(outcome.mode).toBe('ordered');
    if (outcome.mode === 'ordered') {
      expect(outcome.transport).toBe('queued');
      expect(outcome.failure?.kind).toBe('transport');
    }
    expect(sg.following().map((f) => f.popclawId)).toEqual(['BBB']);
    void warns;
  });

  // ADR-0037: declarations per house, relationship tiers per person. Exercise declare-to-revoke house routing end to end.
  it('一坊取关不动另一坊：followsIn 分坊为真，following() 并集仍在', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    // houseOf chooses the follow's destination house; production derives it from the world-stream cache.
    let house = 'me';
    const sg = new SocialGraph({
      relationProducer: fakeRelationProducer({ db, houseOf: () => house }).producer,
      db, signer, egressPush: vi.fn(), houseOf: () => house,
    });
    await sg.start();
    await sg.declareFollow('B');
    house = 'world';
    await sg.declareFollow('B');
    await sg.revokeFollow('B');            // Return to the house of the original declaration: world.

    expect(sg.followsIn('B', 'me')).toBe(true);
    expect(sg.followsIn('B', 'world')).toBe(false);
    expect(sg.following().map((f) => f.popclawId)).toEqual(['B']);
    expect(sg.followingByHouse().get('me')?.map((f) => f.popclawId)).toEqual(['B']);
  });

  it('primaryHouse 注入 → 空 house_slug 的存量行归一成主坊，不在副坊拿加权（ADR-0037）', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    // Legacy row: follows created before migration 014 have an empty house_slug; they originally reached
    // the primary house through pushRouted(..., undefined, ...).
    db.execute(
      `INSERT INTO follow_events (type, followee, follow_type, taste_subscribed, timestamp, signature, house_slug)
       VALUES ('FollowDeclared', 'B', 'PUBLIC', 0, 100, 's', '')`,
    );
    const sg = new SocialGraph({
      relationProducer: fakeRelationProducer({ db }).producer,
      db, signer, egressPush: vi.fn().mockResolvedValue(undefined), primaryHouse: 'me',
    });
    await sg.start();

    expect(sg.followsIn('B', 'me')).toBe(true);
    expect(sg.followsIn('B', 'world')).toBe(false);   // Cross-house noise is exactly what ADR-0037 removes.
    expect(sg.following().map((f) => f.popclawId)).toEqual(['B']);   // The person-level union is unaffected.
  });

  // The follow doorbell asks "do I already know this person", which is a
  // person-level question (ADR-0037 tier 2), so it must call follows().
  it('follows() is true for someone followed in the primary house, even when the stored event carried an empty house slug', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    db.execute(
      `INSERT INTO follow_events (type, followee, follow_type, taste_subscribed, timestamp, signature, house_slug)
       VALUES ('FollowDeclared', 'B', 'PUBLIC', 0, 100, 's', '')`,
    );
    const sg = new SocialGraph({
      relationProducer: fakeRelationProducer({ db }).producer,
      db, signer, egressPush: vi.fn().mockResolvedValue(undefined), primaryHouse: 'house-popclaw-me',
    });
    await sg.start();

    expect(sg.follows('B')).toBe(true);
    expect(sg.follows('stranger')).toBe(false);
    expect(sg.follows('')).toBe(false);
  });

  it('follows() is true for someone followed only in a secondary house', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    const sg = new SocialGraph({
      relationProducer: fakeRelationProducer({ db, houseOf: () => 'world' }).producer,
      db, signer, egressPush: vi.fn().mockResolvedValue(undefined),
      houseOf: () => 'world', primaryHouse: 'house-popclaw-me',
    });
    await sg.start();
    await sg.declareFollow('B');

    expect(sg.followsIn('B', 'world')).toBe(true);
    expect(sg.followsIn('B', 'house-popclaw-me')).toBe(false);
    expect(sg.follows('B')).toBe(true);
  });

  // Regression pin: followsIn() with no house reads the '' bucket, which
  // normalizeHouse has already emptied. It answers false for someone the owner
  // demonstrably follows — that is why the doorbell must never be wired to it.
  it('followsIn() WITHOUT a house is false even for someone followed in the primary house (the trap)', async () => {
    const db = makeDb();
    const signer = await makeSigner();
    db.execute(
      `INSERT INTO follow_events (type, followee, follow_type, taste_subscribed, timestamp, signature, house_slug)
       VALUES ('FollowDeclared', 'B', 'PUBLIC', 0, 100, 's', '')`,
    );
    const sg = new SocialGraph({
      relationProducer: fakeRelationProducer({ db }).producer,
      db, signer, egressPush: vi.fn().mockResolvedValue(undefined), primaryHouse: 'house-popclaw-me',
    });
    await sg.start();

    expect(sg.followsIn('B', 'house-popclaw-me')).toBe(true);
    expect(sg.followsIn('B')).toBe(false);
  });
});
