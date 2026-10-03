/**
 * A house that answers `200 []` must not empty the owner's follower list.
 *
 * The poll treats the house's answer as the whole truth and deletes anyone it
 * fails to name. That is right for an ordinary unfollow and wrong for every
 * other reason a list can come back short — an emptied or rebuilt house, or
 * one that simply never held this person's data. `fetchFollowers` throws on
 * any non-2xx, so an empty array is a house genuinely saying "nobody", which
 * is exactly the shape a rebuilt house has.
 *
 * The damage outlives the display. `known_followers` is also the dedup for
 * new-follower notifications, so everyone erased is introduced to the owner
 * all over again if they come back.
 *
 * The protection existed and was not connected: `makeVerifiedFollowerGuards`
 * sat exported with no caller in the whole tree, and the poll ran unguarded.
 * These cases go through `houseScopedVerifiedGuards` — the same function the
 * root now passes — with a real database, so the derivation from the pin
 * table is covered and not just the comparison it feeds.
 */
import { describe, it, expect, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db';
import { runMigrations } from '../../../src/host/migrations';
import {
  KnownFollowersStore,
  houseScopedVerifiedGuards,
  syncFollowersOnce,
  type FollowerSyncDeps,
} from '../../../src/social-graph/followers-sync';
import { hostDbSlug } from '../../../src/ingress/host-slug';
import { declaringReadAuthority } from '../../helpers/read-authority.js';
import type { Signer } from '../../../src/identity/signer';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const ME = 'owner-popclaw-id';
const ORIGIN = 'https://h1.example';
const OTHER = 'https://h2.example';
const H1_KEY = 'house-key-one';
const H2_KEY = 'house-key-two';

function fixture() {
  const db = new LocalHostDb(':memory:');
  runMigrations(db, MIGRATIONS);
  db.execute(
    `INSERT INTO house_binding_pin (origin, house_key, incarnation, source, first_trusted_at, confirmed_at, revision)
     VALUES (?, ?, 'inc-1', 'tofu', 1, 1, 1), (?, ?, 'inc-1', 'tofu', 1, 1, 1)`,
    [ORIGIN, H1_KEY, OTHER, H2_KEY],
  );
  const store = new KnownFollowersStore(db);
  // Enough of a signer to mint a credential; what these cases judge is the
  // guards, and the real resolver is used so an unpinned house behaves here
  // exactly as it does in production.
  const signer = { popclawId: async () => ME, sign: async () => new Uint8Array(64) } as unknown as Signer;
  const readAuthorityFor = declaringReadAuthority(db, signer);
  // The wire shape is `[{popclaw_id}]`, not bare strings: a list of strings
  // parses to nothing, which silently turns every case into the empty-list
  // case and hides whatever the test meant to exercise.
  const deps = (ids: readonly string[]): FollowerSyncDeps => ({
    ownerPopclawId: ME,
    store,
    verifiedGuards: houseScopedVerifiedGuards(db, ME, hostDbSlug),
    readAuthorityFor: (house: { baseUrl: string }) => readAuthorityFor(house.baseUrl),
    notifier: { enqueue: vi.fn() },
    fetch: (async () => new Response(JSON.stringify(ids.map((popclaw_id) => ({ popclaw_id }))), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch,
  } as unknown as FollowerSyncDeps);
  const edge = (follower: string, houseKey: string, state: string) =>
    db.execute(
      `INSERT INTO relation_edges
         (house_key, follower_popclaw_id, followee_popclaw_id, state, conflicted, updated_at)
       VALUES (?, ?, ?, ?, 0, 1)`,
      [houseKey, follower, ME, state],
    );
  return { db, store, deps, edge, house: { slug: hostDbSlug(ORIGIN), baseUrl: ORIGIN } };
}

describe('an empty follower list from a house', () => {
  it('does not erase a follower the author verified at that house', async () => {
    const f = fixture();
    f.store.markBaseline(f.house.slug);
    f.store.reconcile(f.house.slug, ['alice']);
    f.edge('alice', H1_KEY, 'following');

    await syncFollowersOnce(f.deps([]), f.house);

    expect(f.store.list(f.house.slug)).toEqual(['alice']);
    f.db.close();
  });

  it('still drops someone with no verified edge — an ordinary unfollow is not blocked', async () => {
    // The guard must not turn the cache into an append-only list; a house is
    // still the source for people it never adjudicated.
    const f = fixture();
    f.store.markBaseline(f.house.slug);
    f.store.reconcile(f.house.slug, ['alice', 'stranger']);
    f.edge('alice', H1_KEY, 'following');

    await syncFollowersOnce(f.deps([]), f.house);

    expect(f.store.list(f.house.slug)).toEqual(['alice']);
    f.db.close();
  });

  it('a follow verified at another house does not protect this one\'s row', async () => {
    // Scoping is the whole reason the guards take a house key. H2's silence
    // about someone must not be overruled by what H1 adjudicated.
    const f = fixture();
    f.store.markBaseline(f.house.slug);
    f.store.reconcile(f.house.slug, ['alice']);
    f.edge('alice', H2_KEY, 'following');

    await syncFollowersOnce(f.deps([]), f.house);

    expect(f.store.list(f.house.slug)).toEqual([]);
    f.db.close();
  });

  it('protects a row at the SECOND pinned house, not just the first', async () => {
    // The discriminating case. Checking only "H1's edge does not protect H1's
    // row" passes even for an implementation that ignores the house entirely
    // and always uses the first pin — both answers come out the same. Polling
    // the second house is what separates them.
    const f = fixture();
    const h2 = { slug: hostDbSlug(OTHER), baseUrl: OTHER };
    f.store.markBaseline(h2.slug);
    f.store.reconcile(h2.slug, ['alice']);
    f.edge('alice', H2_KEY, 'following');

    await syncFollowersOnce(f.deps([]), h2);

    expect(f.store.list(h2.slug)).toEqual(['alice']);
    f.db.close();
  });

  it('a stale list naming someone who signed an unfollow does not bring them back', async () => {
    // The other half of the acceptance, and the one with no coverage
    // anywhere: guards must stop a list from RESURRECTING a relation the
    // author already revoked, not just from erasing one they declared. A
    // house serving a list from before the unfollow landed would otherwise
    // reinstate the row — and, because the row is the notification dedup,
    // announce that person as a new follower all over again.
    const f = fixture();
    f.store.markBaseline(f.house.slug);
    f.edge('alice', H1_KEY, 'revoked');

    await syncFollowersOnce(f.deps(['alice']), f.house);

    expect(f.store.list(f.house.slug)).toEqual([]);
    f.db.close();
  });

  it('a house nobody pinned is not polled at all, so its rows are untouched', async () => {
    // This used to be "polled exactly as before": with no pin there were no
    // guards, and an empty list emptied the row. There is no anonymous poll
    // left — without a verified binding there is no identity to ask as, so
    // the request never happens and nothing is reconciled away on the
    // strength of an answer nobody gave.
    const f = fixture();
    const unpinned = { slug: hostDbSlug('https://h3.example'), baseUrl: 'https://h3.example' };
    f.store.markBaseline(unpinned.slug);
    f.store.reconcile(unpinned.slug, ['alice']);
    f.edge('alice', H1_KEY, 'following');

    await expect(syncFollowersOnce(f.deps([]), unpinned))
      .rejects.toThrow('READ_AUTH_HOUSE_NOT_TRUSTED');

    expect(f.store.list(unpinned.slug)).toEqual(['alice']);
    f.db.close();
  });
});
