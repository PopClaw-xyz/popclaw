/**
 * First sight establishes; every sight after that confirms; a re-key refuses.
 *
 * These are the existing house-trust rules, but nothing had ever reached them
 * from a login, so nothing had ever checked them from there. The middle case
 * is the one worth the most: a login that confirms must leave the
 * participation generation exactly where it was, because every mounted
 * relation handle dies when that number moves. A rule that bumped on each
 * login would look completely healthy — a follow would still be written, the
 * owner would still see their graph — while a house-less user quietly lost
 * their live connection on every `popclaw login`.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { makeRelationBindingPreparer } from '../../../src/social-graph/relation-binding.js';
import { pinnedBinding } from '../../../src/world/house-binding-pin.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ORIGIN = 'https://binding.test';

function fixture(house = mintHouse({ origin: ORIGIN, manifest: { relations: { ordered: 1 } } })) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const prepare = makeRelationBindingPreparer({ db });
  // What the manager does: prepare outside the transaction, commit inside it.
  const login = async (serving = house) => {
    const p = await prepare({
      origin: ORIGIN, rawBytes: serving.bodyBytes, proofHeader: serving.proofHeader,
      signal: new AbortController().signal,
    });
    db.transaction((tx) => { p.commit(tx); });
  };
  return { db, house, login,
    participation: () => db.queryOne<{ owner_generation: number; active: number }>(
      'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?', [house.houseKey]) };
}

describe('the relation binding a login leaves behind', () => {
  it('first sight of a board-less house establishes the pin and the participation', async () => {
    const t = fixture();
    expect(pinnedBinding(t.db, ORIGIN)).toBeUndefined();

    await t.login();

    expect(pinnedBinding(t.db, ORIGIN)?.houseKey).toBe(t.house.houseKey);
    expect(t.participation()).toMatchObject({ active: 1 });
  });

  it('logging in again confirms, and leaves the generation where it was', async () => {
    const t = fixture();
    await t.login();
    const first = t.participation()!.owner_generation;

    await t.login();
    await t.login();

    // Not "close enough" — the same number. Every handle mounted against the
    // first login is still valid, which is the entire point.
    expect(t.participation()!.owner_generation).toBe(first);
    expect(pinnedBinding(t.db, ORIGIN)?.houseKey).toBe(t.house.houseKey);
  });

  it('a house serving a different key is refused, and the old binding stands', async () => {
    const t = fixture();
    await t.login();
    const before = pinnedBinding(t.db, ORIGIN);

    // Same origin, same preparer, different identity on the wire — a re-key,
    // whether by accident or not. Feeding the impostor's bytes to the SAME
    // preparer is the real shape of this: the bytes decide, and they are the
    // bytes the login was served.
    const impostor = mintHouse({ origin: ORIGIN, seed: 77, manifest: { relations: { ordered: 1 } } });
    await expect(t.login(impostor)).rejects.toThrow();

    // Running `login` again is not authorization to re-key a house.
    expect(pinnedBinding(t.db, ORIGIN)).toEqual(before);
  });

  it('leaving and coming back is allowed, and starts a new generation', async () => {
    const t = fixture();
    await t.login();
    const joined = t.participation()!.owner_generation;

    // What a leave leaves behind: the pin outlives it, the participation ends.
    t.db.execute('UPDATE relation_participation SET active = 0 WHERE house_key = ?', [t.house.houseKey]);

    await t.login();

    // Reachable at all — this used to refuse for ever, because the confirm
    // path demanded a live participation and a rejoin is precisely the case
    // that has none. The owner was locked out of a house they had asked to
    // return to, with no way back.
    expect(t.participation()).toMatchObject({ active: 1 });
    // And it IS a rejoin, not a refresh: a new generation, because anything
    // still holding a handle from before the leave is holding a dead one.
    expect(t.participation()!.owner_generation).toBeGreaterThan(joined);
    // Same house, same key — rejoining is not re-keying.
    expect(pinnedBinding(t.db, ORIGIN)?.houseKey).toBe(t.house.houseKey);
  });

  it('a proof signed by a key other than the one it names never establishes', async () => {
    const liar = mintHouse({
      origin: ORIGIN, seed: 88,
      signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99)).secretKey,
    });
    const t = fixture(liar);

    await expect(t.login()).rejects.toThrow();
    expect(pinnedBinding(t.db, ORIGIN)).toBeUndefined();
    expect(t.participation()).toBeNull();
  });
});
