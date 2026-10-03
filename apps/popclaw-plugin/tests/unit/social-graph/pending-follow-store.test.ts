import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PendingFollowStore } from '../../../src/social-graph/pending-follow-store.js';
import type { FollowIntentRow } from '../../../src/social-graph/pending-follow-store.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const MS = 1_750_000_000_000; // any ms-scale epoch; canvas timestamps are ms
const MIN = 60_000;

/** A production-shaped popclaw id (44-char base58): someone this plugin has
 *  never printed in a paper of its own — the reader met them in a FRIEND's
 *  paper (owner ruling 2026-09-13). */
const FOREIGN_ID = '7xKvGjWntCHSPQoyY2mLBRTDdQFEAqNsZz4fCcrKVJ9u';
const SHARED = 'from a shared paper';

type AuthorMeta = { display_name: string; descriptor: string | null; issue_date: string };

function intent(
  followee: string,
  label: string,
  firstTs: number,
  latestTs = firstTs,
  clickCount = 1,
): FollowIntentRow {
  return {
    owner_popclaw_id: 'owner',
    followee_popclaw_id: followee,
    followee_label: label,
    first_ts: firstTs,
    latest_ts: latestTs,
    click_count: clickCount,
  };
}

function authorsOf(...ids: string[]): Map<string, AuthorMeta> {
  const m = new Map<string, AuthorMeta>();
  for (const id of ids) {
    m.set(id, { display_name: `name-${id}`, descriptor: `desc-${id}`, issue_date: '2026-08-31' });
  }
  return m;
}

describe('PendingFollowStore (DB-backed, migration 023)', () => {
  let db: InMemoryHostDb;
  let s: PendingFollowStore;

  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    s = new PendingFollowStore(db, () => 777);
  });

  const absorbAll = (
    intents: FollowIntentRow[],
    authors: Map<string, AuthorMeta>,
    opts: { follows?: string[]; cap?: number; foreignDescriptor?: string } = {},
  ) =>
    s.absorb(intents, {
      authors,
      followsIn: (id) => (opts.follows ?? []).includes(id),
      foreignDescriptor: opts.foreignDescriptor ?? SHARED,
      ...(opts.cap === undefined ? {} : { cap: opts.cap }),
    });

  const rawStatus = (followee: string): string | null =>
    db.queryOne<{ status: string }>('SELECT status FROM pending_follows WHERE followee_popclaw_id = ?', [
      followee,
    ])?.status ?? null;

  // Owner ruling 2026-09-13: a ➕ is credited to the READER who clicked, so the
  // intents this plugin pulls can name people who were never in ITS papers —
  // they were in a friend's. The author set is no longer the gate; the reader
  // pass is (the canvas credits paired clicks only). Junk still goes in the bin.
  it('absorbs a followee from someone else\'s paper: label becomes the display name, descriptor says where it came from', () => {
    const r = absorbAll([intent(FOREIGN_ID, '云舟#3m8v', MS)], authorsOf('B'));
    expect(r).toEqual({ absorbed: 1, droppedFollowed: [], overflow: 0 });
    expect(db.queryOne<Record<string, unknown>>('SELECT * FROM pending_follows')).toMatchObject({
      followee_popclaw_id: FOREIGN_ID,
      display_name: '云舟#3m8v',
      descriptor: SHARED,
      source_issue_date: null,
      first_ts: MS,
      status: 'pending',
    });
  });

  it('a foreign followee the reader already follows still lands as dropped_followed, named by the label', () => {
    const r = absorbAll([intent(FOREIGN_ID, '云舟#3m8v', MS)], authorsOf('B'), { follows: [FOREIGN_ID] });
    expect(r).toEqual({ absorbed: 0, droppedFollowed: ['云舟#3m8v'], overflow: 0 });
    expect(rawStatus(FOREIGN_ID)).toBe('dropped_followed');
  });

  it('the local author set still wins where it has the followee: its name and issue beat the label', () => {
    const r = absorbAll([intent('B', 'stranger-supplied label', MS)], authorsOf('B'));
    expect(r).toEqual({ absorbed: 1, droppedFollowed: [], overflow: 0 });
    expect(s.listPending()[0]).toMatchObject({ display_name: 'name-B', descriptor: 'desc-B' });
  });

  it('junk is still junk: a followee id that is not popclaw-id-shaped never lands', () => {
    const r = absorbAll(
      [intent('X', 'stranger', MS), intent('not a base58 id', 'stranger', MS), intent('', 'stranger', MS)],
      authorsOf('B'),
    );
    expect(r).toEqual({ absorbed: 0, droppedFollowed: [], overflow: 0 });
    expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM pending_follows')?.n).toBe(0);
  });

  it('junk is still junk: an oversized, blank or control-character label never lands', () => {
    const r = absorbAll(
      [
        intent(FOREIGN_ID, 'x'.repeat(200), MS),
        intent(FOREIGN_ID, '   ', MS),
        intent(FOREIGN_ID, 'two\nlines', MS),
      ],
      authorsOf('B'),
    );
    expect(r).toEqual({ absorbed: 0, droppedFollowed: [], overflow: 0 });
    expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM pending_follows')?.n).toBe(0);
  });

  it('already-followed followee lands as dropped_followed, visible to hasDroppedUnreported, never pending', () => {
    const r = absorbAll([intent('B', 'yun #3m8v', MS)], authorsOf('B'), { follows: ['B'] });
    expect(r).toEqual({ absorbed: 0, droppedFollowed: ['name-B'], overflow: 0 });
    expect(rawStatus('B')).toBe('dropped_followed');
    expect(s.hasDroppedUnreported()).toEqual([{ display_name: 'name-B' }]);
    expect(s.listPending()).toEqual([]);
  });

  it('absorbs a valid intent as pending; display fields come from the plugin-side author set, never the intent label', () => {
    const r = absorbAll([intent('B', 'stranger-supplied label', MS + 100, MS + 200, 3)], authorsOf('B'));
    expect(r).toEqual({ absorbed: 1, droppedFollowed: [], overflow: 0 });
    expect(db.queryOne<Record<string, unknown>>('SELECT * FROM pending_follows')).toMatchObject({
      followee_popclaw_id: 'B',
      display_name: 'name-B',
      descriptor: 'desc-B',
      source_issue_date: '2026-08-31',
      first_ts: MS + 100,
      latest_ts: MS + 200,
      first_surfaced_ts: null,
      status: 'pending',
    });
    expect(s.listPending()).toHaveLength(1);
    expect(s.listPending()[0]).toMatchObject({
      followee_popclaw_id: 'B',
      followee_label: 'name-B', // FollowIntentRow-shape alias of the plugin-side display_name
      first_ts: MS + 100,
      latest_ts: MS + 200,
      first_surfaced_ts: null,
      display_name: 'name-B',
      descriptor: 'desc-B',
    });
  });

  it('re-absorbing the same followee keeps the first first_ts, refreshes latest_ts, keeps the surfaced anchor', () => {
    absorbAll([intent('B', 'yun #3m8v', MS)], authorsOf('B'));
    expect(s.claimSurface(500)).toBe(1);
    const r = absorbAll([intent('B', 'yun #3m8v', MS, MS + 9 * MIN, 2)], authorsOf('B'));
    expect(r).toEqual({ absorbed: 1, droppedFollowed: [], overflow: 0 });
    expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM pending_follows')?.n).toBe(1);
    expect(s.listPending()[0]).toMatchObject({
      first_ts: MS,
      latest_ts: MS + 9 * MIN,
      first_surfaced_ts: 500,
    });
  });

  // Live regression 2026-09-13: a re-click on a ➕ the owner had already
  // honoured flipped the row confirmed → pending and re-offered the follow.
  it('a confirmed row survives re-absorption: stays confirmed, refreshes latest_ts, counts as neither absorbed nor dropped', () => {
    absorbAll([intent('B', 'yun #3m8v', MS)], authorsOf('B'));
    s.markConfirmed('B');

    const r = absorbAll([intent('B', 'yun #3m8v', MS, MS + 9 * MIN, 2)], authorsOf('B'));
    expect(r).toEqual({ absorbed: 0, droppedFollowed: [], overflow: 0 });
    expect(rawStatus('B')).toBe('confirmed');
    expect(s.listPending()).toEqual([]);
    expect(s.hasDroppedUnreported()).toEqual([]);
    expect(db.queryOne<{ latest_ts: number }>(
      'SELECT latest_ts FROM pending_follows WHERE followee_popclaw_id = ?', ['B'],
    )?.latest_ts).toBe(MS + 9 * MIN);
  });

  it('a confirmed row stays confirmed on re-absorption even once the follow set reports the followee', () => {
    absorbAll([intent('B', 'yun #3m8v', MS)], authorsOf('B'));
    s.markConfirmed('B');

    // The declared follow has landed in the social graph by now, so followsIn
    // says true — that must not turn the settled row into a dropped record.
    const r = absorbAll([intent('B', 'yun #3m8v', MS, MS + MIN, 2)], authorsOf('B'), { follows: ['B'] });
    expect(r).toEqual({ absorbed: 0, droppedFollowed: [], overflow: 0 });
    expect(rawStatus('B')).toBe('confirmed');
    expect(s.hasDroppedUnreported()).toEqual([]);
  });

  // The other half of the same regression: with a house-agnostic followsIn,
  // a first-ever intent for an already-followed author never looks pending.
  it('a fresh intent for an author the owner already follows lands as dropped_followed, never pending', () => {
    const r = absorbAll([intent('B', 'yun #3m8v', MS)], authorsOf('B'), { follows: ['B'] });
    expect(r).toEqual({ absorbed: 0, droppedFollowed: ['name-B'], overflow: 0 });
    expect(rawStatus('B')).toBe('dropped_followed');
    expect(s.listPending()).toEqual([]);
  });

  it('cap overflow deletes the oldest pending rows by first_ts and reports the overflow count', () => {
    const ids = ['B', 'C', 'D', 'E', 'F'];
    const r = absorbAll(
      ids.map((id, i) => intent(id, `name-${id}`, MS + i * MIN)),
      authorsOf(...ids),
      { cap: 3 },
    );
    expect(r).toEqual({ absorbed: 5, droppedFollowed: [], overflow: 2 });
    expect(s.listPending().map((p) => p.followee_popclaw_id)).toEqual(['D', 'E', 'F']);
    expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM pending_follows')?.n).toBe(3);
  });

  it('dropped_followed rows do not occupy the cap', () => {
    const r = absorbAll(
      [intent('B', 'yun #3m8v', MS), intent('C', 'ahe #k2f0', MS + MIN), intent('A', 'lev #9xqe', MS + 2 * MIN)],
      authorsOf('A', 'B', 'C'),
      { follows: ['A'], cap: 1 },
    );
    // pending B+C = 2 > cap 1 → oldest (B) evaporates; dropped A survives.
    expect(r).toEqual({ absorbed: 2, droppedFollowed: ['name-A'], overflow: 1 });
    expect(rawStatus('A')).toBe('dropped_followed');
    expect(s.listPending().map((p) => p.followee_popclaw_id)).toEqual(['C']);
    expect(s.hasDroppedUnreported()).toEqual([{ display_name: 'name-A' }]);
  });

  it('cap counts pre-existing pending rows from before this batch', () => {
    absorbAll(
      ['P1', 'P2', 'P3'].map((id, i) => intent(id, `n-${id}`, MS + i * MIN)),
      authorsOf('P1', 'P2', 'P3', ...Array.from({ length: 18 }, (_, i) => `Q${i}`)),
    );
    const r = absorbAll(
      Array.from({ length: 18 }, (_, i) => intent(`Q${i}`, `n-Q${i}`, MS + (3 + i) * MIN)),
      authorsOf('P1', 'P2', 'P3', ...Array.from({ length: 18 }, (_, i) => `Q${i}`)),
    );
    expect(r.overflow).toBe(1);
    expect(s.listPending()).toHaveLength(20);
    expect(rawStatus('P1')).toBeNull(); // oldest of 21 evaporates
  });

  it('default cap is 20', () => {
    const ids = Array.from({ length: 21 }, (_, i) => `X${i}`);
    const r = absorbAll(
      ids.map((id, i) => intent(id, `n-${id}`, MS + i * MIN)),
      authorsOf(...ids),
    );
    expect(r.overflow).toBe(1);
    expect(s.listPending()).toHaveLength(20);
    expect(rawStatus('X0')).toBeNull();
  });

  it('claimSurface claims the un-surfaced batch (pending and dropped alike) exactly once', () => {
    absorbAll(
      [intent('B', 'yun #3m8v', MS), intent('C', 'ahe #k2f0', MS + MIN), intent('A', 'lev #9xqe', MS + 2 * MIN)],
      authorsOf('A', 'B', 'C'),
      { follows: ['A'] },
    );
    expect(s.claimSurface(500)).toBe(3);
    expect(
      db.queryAll<{ first_surfaced_ts: number }>('SELECT first_surfaced_ts FROM pending_follows'),
    ).toEqual([{ first_surfaced_ts: 500 }, { first_surfaced_ts: 500 }, { first_surfaced_ts: 500 }]);
    expect(s.claimSurface(600)).toBe(0);
    expect(s.hasDroppedUnreported()).toEqual([]);
  });

  it('claimSurface called bare uses the injected now clock', () => {
    absorbAll([intent('B', 'yun #3m8v', MS)], authorsOf('B'));
    expect(s.claimSurface()).toBe(1);
    expect(s.listPending()[0]?.first_surfaced_ts).toBe(777);
  });

  it('markConfirmed moves a pending row to confirmed and out of listPending', () => {
    absorbAll([intent('B', 'yun #3m8v', MS), intent('C', 'ahe #k2f0', MS + MIN)], authorsOf('B', 'C'));
    s.markConfirmed('B');
    expect(rawStatus('B')).toBe('confirmed');
    expect(s.listPending().map((p) => p.followee_popclaw_id)).toEqual(['C']);
  });

  it('unreportedFirstTs is the min first_ts over pending and dropped alike; surfaced/expired/confirmed rows and empties give null', () => {
    expect(s.unreportedFirstTs()).toBeNull();
    absorbAll(
      [
        intent('B', 'yun #3m8v', MS + 10 * MIN),
        intent('C', 'ahe #k2f0', MS),
        intent('A', 'lev #9xqe', MS + 5 * MIN),
        intent('D', 'old #oldd', MS),
      ],
      authorsOf('A', 'B', 'C', 'D'),
      { follows: ['A'] },
    );
    expect(s.unreportedFirstTs()).toBe(MS); // C (pending) and D (dropped) share the oldest click
    s.markConfirmed('C');
    s.expireOlderThan(MS / 1000 + 60); // D's first click is now past the cutoff
    expect(s.unreportedFirstTs()).toBe(MS + 5 * MIN); // only A (dropped) and B (pending) remain unreported
    expect(s.claimSurface(500)).toBe(2); // A + B
    expect(s.unreportedFirstTs()).toBeNull();
  });

  it('expireOlderThan expires pending and dropped rows older than the cutoff (seconds), leaving others alone', () => {
    absorbAll(
      [
        intent('B', 'n-B', MS), // old pending
        intent('C', 'n-C', MS + 10 * 60 * MIN), // fresh pending
        intent('D', 'n-D', MS), // old dropped
        intent('E', 'n-E', MS), // old, but confirmed before the sweep
      ],
      authorsOf('B', 'C', 'D', 'E'),
      { follows: ['D'] },
    );
    s.markConfirmed('E');
    const expired = s.expireOlderThan(MS / 1000 + 5 * 60 * 60);
    expect(expired).toBe(2);
    expect(rawStatus('B')).toBe('expired');
    expect(rawStatus('D')).toBe('expired');
    expect(rawStatus('C')).toBe('pending');
    expect(rawStatus('E')).toBe('confirmed');
    expect(s.listPending().map((p) => p.followee_popclaw_id)).toEqual(['C']);
    expect(s.hasDroppedUnreported()).toEqual([]);
  });
});
