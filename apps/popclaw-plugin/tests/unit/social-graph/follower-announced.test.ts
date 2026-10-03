/**
 * Learning a follower and telling the owner about one are different facts.
 *
 * They were the same fact while the poll was the only source: it learned and
 * announced in one breath, so a row in `known_followers` meant "already told".
 * Relations on the personal stream broke that. Every root on a data root
 * shares the table, and whichever process wins the drain writes the row — so
 * a process that learns is not necessarily one that can tell, and the poll,
 * finding the row already there, then says nothing. The owner stops being
 * told by a mechanism that looks entirely healthy.
 *
 * So the debt lives in the row. These cases are about that debt: that it is
 * created, that it is settled exactly once, that a deliberate silence settles
 * it too, and which rows a house with no baseline yet owes anything for.
 */
import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { KnownFollowersStore } from '../../../src/social-graph/followers-sync.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOUSE = 'house-a';

function store() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  return { db, s: new KnownFollowersStore(db, () => 1000) };
}

describe('the unannounced debt a learned follower leaves', () => {
  it('a follower learned from the stream is owed an announcement', () => {
    const { s } = store();
    s.markBaseline(HOUSE);
    expect(s.noteVerifiedFollow(HOUSE, 'alice')).toBe(true);

    expect(s.unannounced()).toEqual([{ houseSlug: HOUSE, followerId: 'alice' }]);
  });

  it('the debt is settled once, and does not come back', () => {
    const { s } = store();
    s.markBaseline(HOUSE);
    s.noteVerifiedFollow(HOUSE, 'alice');

    s.markAnnounced(HOUSE, 'alice');

    expect(s.unannounced()).toEqual([]);
    // Settling twice must not un-settle: a second sweep finding it again
    // would introduce the same person to the owner a second time.
    s.markAnnounced(HOUSE, 'alice');
    expect(s.unannounced()).toEqual([]);
  });

  it('a house with no baseline owes nothing for a follower it did not witness', () => {
    const { s } = store();
    // No markBaseline, and nothing here was witnessed arriving: this is the
    // catch-up pass filling in cache rows for edges some earlier build had
    // already adjudicated. It saw none of them happen and can vouch for
    // nothing about when they did, so the telling waits for the baseline.
    s.noteVerifiedFollow(HOUSE, 'alice', { witnessed: false });
    s.noteVerifiedFollow(HOUSE, 'bob', { witnessed: false });

    expect(s.unannounced()).toEqual([]);
    // Recorded all the same — the graph is right, only the telling waits.
    expect(s.list(HOUSE).sort()).toEqual(['alice', 'bob']);
  });

  it('a house with no baseline still owes what this client witnessed arriving', () => {
    const { s } = store();
    // The control for the case above, and the reason the poll is no longer
    // the only thing that can introduce anyone: this client took delivery of
    // the signed original, so it knows this is not history from before it
    // ever looked. Requiring a baseline here is what left a brand-new
    // install's first follower unmentioned for up to a poll interval.
    s.noteVerifiedFollow(HOUSE, 'carol');

    expect(s.unannounced()).toEqual([{ houseSlug: HOUSE, followerId: 'carol' }]);
  });

  it('followers known before this existed are not re-introduced', () => {
    const { db, s } = store();
    s.markBaseline(HOUSE);
    // A row as the poll wrote them before `announced_at` existed: the
    // migration backfills these, because they were announced when learned.
    db.execute('INSERT INTO known_followers (house_slug, follower_id, first_seen_at, announced_at) VALUES (?,?,?,?)',
      [HOUSE, 'long-known', 900, 900]);

    expect(s.unannounced()).toEqual([]);
  });
});
