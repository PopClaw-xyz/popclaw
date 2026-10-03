import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { RelationAllocator, MAX_RELATION_SEQ } from '../../../src/social-graph/relation-allocator.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const HOUSE = 'HouseKeyA';
const BOB = 'Bob';


/** This end's OWN local high-water, without pretending it observed another end. */
function seedLocalHigh(db: InMemoryHostDb, seq: bigint): void {
  db.execute(
    `INSERT INTO relation_seq (house_key, followee_popclaw_id, reserved, signed, observed)
     VALUES (?, ?, CAST(? AS INTEGER), CAST(? AS INTEGER), 0)`,
    [HOUSE, BOB, seq.toString(), seq.toString()],
  );
}

describe('RelationAllocator (R4 §1.3)', () => {
  let db: InMemoryHostDb;
  let alloc: RelationAllocator;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    alloc = new RelationAllocator(db, () => 1_700_000_000);
  });

  const push = (eventId: string, seq: bigint) => ({
    eventId,
    houseKey: HOUSE,
    followeePopclawId: BOB,
    seq,
    signedPayload: new Uint8Array([1, 2, 3, Number(seq % 251n)]),
  });

  it('counts from 1 and never hands out the same number twice', () => {
    expect(alloc.reserve(HOUSE, BOB).seq).toBe(1n);
    expect(alloc.reserve(HOUSE, BOB).seq).toBe(2n);
    expect(alloc.reserve(HOUSE, BOB).seq).toBe(3n);
  });

  it('keeps a separate counter per edge', () => {
    expect(alloc.reserve(HOUSE, BOB).seq).toBe(1n);
    expect(alloc.reserve(HOUSE, 'Carol').seq).toBe(1n);
    expect(alloc.reserve('HouseKeyB', BOB).seq).toBe(1n);
    expect(alloc.reserve(HOUSE, BOB).seq).toBe(2n);
  });

  /**
   * The case the allocator exists for. Reserve 1, sign it, then have the push
   * time out: the retry must ship the SAME bytes, not a new event at the same
   * position, because two different event_ids at one seq is exactly a fork —
   * self-inflicted, by the owner's own retry.
   */
  it('a timed-out push is retried with the identical original, not re-signed', () => {
    const seq = alloc.reserve(HOUSE, BOB).seq;
    alloc.recordSigned(push('evt-1', seq));

    // ... the network attempt fails and the process restarts.
    const again = new RelationAllocator(db, () => 1_700_000_001);
    const pending = again.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.eventId).toBe('evt-1');
    expect(pending[0]!.seq).toBe(seq);
    expect(Array.from(pending[0]!.signedPayload)).toEqual([1, 2, 3, 1]);

    again.markSent('evt-1');
    expect(again.pending()).toHaveLength(0);
  });

  /**
   * A crash between reserving and signing loses a number. That is fine — §1.2
   * compares seqs, it does not require them to be contiguous — and it is the
   * price of never reusing one.
   */
  it('a crash after reserving skips the number rather than reusing it', () => {
    const lost = alloc.reserve(HOUSE, BOB).seq;
    expect(lost).toBe(1n);

    const rebooted = new RelationAllocator(db, () => 1_700_000_002);
    expect(rebooted.reserve(HOUSE, BOB).seq).toBe(2n);
    expect(rebooted.pending()).toHaveLength(0);
  });

  /**
   * Verified evidence that another end signed higher raises the floor. What may
   * NOT reach observeVerified is a house's bare claim — that is a statement,
   * not an allocation, and a stale or hostile one would walk the author back
   * into their own history.
   */
  it('stops signing once another end has signed above this one', () => {
    alloc.recordSigned(push('evt-1', alloc.reserve(HOUSE, BOB).seq));
    alloc.observeVerified(HOUSE, BOB, 9n);

    // R4 §1.3: resuming at observed+1 would reserve into originals this end has
    // never seen. It may still hold evidence and resend what it already signed.
    expect(() => alloc.reserve(HOUSE, BOB)).toThrow('RELATION_SIGNING_NOT_READY');
    expect(alloc.bound(HOUSE, BOB).high).toBe(9n);
  });

  it('observation only ever raises, and nothing resets an edge to 1', () => {
    alloc.observeVerified(HOUSE, BOB, 9n);
    alloc.observeVerified(HOUSE, BOB, 4n);
    expect(alloc.bound(HOUSE, BOB).high).toBe(9n);
  });

  /**
   * Honesty about what the local counters mean. Once another end has signed
   * above this one, the local numbers are a verified LOWER BOUND and the caller
   * should say so rather than present them as the edge's history.
   */
  it('reports a lower bound, not authority, once another end has signed higher', () => {
    alloc.recordSigned(push('evt-1', alloc.reserve(HOUSE, BOB).seq));
    expect(alloc.bound(HOUSE, BOB).authoritative).toBe(true);

    alloc.observeVerified(HOUSE, BOB, 7n);

    expect(alloc.bound(HOUSE, BOB).authoritative).toBe(false);
    expect(() => alloc.reserve(HOUSE, BOB)).toThrow('RELATION_SIGNING_NOT_READY');
  });

  it('re-recording the same event is idempotent', () => {
    const seq = alloc.reserve(HOUSE, BOB).seq;
    alloc.recordSigned(push('evt-1', seq));
    alloc.recordSigned(push('evt-1', seq));
    expect(alloc.pending()).toHaveLength(1);
  });
});

describe('RelationAllocator · the counter stays lossless past 2^53', () => {
  let db: InMemoryHostDb;
  let alloc: RelationAllocator;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    alloc = new RelationAllocator(db, () => 1_700_000_000);
  });

  /**
   * Codex's diagnostic, turned into a regression. A JS Number above 2^53 cannot
   * represent its own successor, so `Math.max(...) + 1` returned the SAME value
   * twice: the allocator handed out a number it had already handed out, inside
   * the protocol's legal domain. Reuse is the one thing it exists to prevent.
   */
  it('does not hand out the same number twice above 2^53', () => {
    seedLocalHigh(db, BigInt(Number.MAX_SAFE_INTEGER));

    const a = alloc.reserve(HOUSE, BOB).seq;
    const b = alloc.reserve(HOUSE, BOB).seq;

    expect(a).toBe(9007199254740992n);
    expect(b).toBe(9007199254740993n);
    expect(a).not.toBe(b);
  });

  it('survives a round trip through the database at that size', () => {
    seedLocalHigh(db, 9_007_199_254_740_993n);
    const reopened = new RelationAllocator(db, () => 1_700_000_001);

    expect(reopened.bound(HOUSE, BOB).high).toBe(9_007_199_254_740_993n);
    expect(reopened.reserve(HOUSE, BOB).seq).toBe(9_007_199_254_740_994n);
  });

  it('carries a large seq through the outbox unchanged', () => {
    const seq = 9_007_199_254_740_997n;
    seedLocalHigh(db, seq - 1n);
    const taken = alloc.reserve(HOUSE, BOB).seq;
    expect(taken).toBe(seq);

    alloc.recordSigned({
      eventId: 'evt-big',
      houseKey: HOUSE,
      followeePopclawId: BOB,
      seq: taken,
      signedPayload: new Uint8Array([9]),
    });
    expect(alloc.pending()[0]!.seq).toBe(seq);
  });

  /**
   * Exhaustion stops signing rather than wrapping. A counter that starts over
   * is indistinguishable from one deliberately reusing a number.
   */
  it('stops signing at the top of the domain instead of wrapping', () => {
    seedLocalHigh(db, MAX_RELATION_SEQ);
    expect(() => alloc.reserve(HOUSE, BOB)).toThrow('RELATION_SEQ_EXHAUSTED');
  });

  /**
   * A fresh root has signed nothing, so it is a lower bound of nothing rather
   * than authority over everything — and signing one number above what it
   * observed does not teach it what it never saw.
   */
  it('does not call a fresh root authoritative, and a later signature does not restore it', () => {
    expect(alloc.bound(HOUSE, BOB).authoritative).toBe(false);

    alloc.observeVerified(HOUSE, BOB, 7n);
    expect(alloc.bound(HOUSE, BOB).authoritative).toBe(false);
    // And it cannot sign its way back to authority: the flag records that
    // history exists here which this end does not hold.
    expect(() => alloc.reserve(HOUSE, BOB)).toThrow('RELATION_SIGNING_NOT_READY');
  });
});

describe('RelationAllocator · one reservation binds one original', () => {
  let db: InMemoryHostDb;
  let alloc: RelationAllocator;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
    alloc = new RelationAllocator(db, () => 1_700_000_000);
  });

  const at = (eventId: string, seq: bigint, byte: number) => ({
    eventId,
    houseKey: HOUSE,
    followeePopclawId: BOB,
    seq,
    signedPayload: new Uint8Array([byte]),
  });

  /**
   * Two different originals at one seq is a fork — and unlike a fork between
   * two devices, this one happens on the sending side where it can still be
   * refused. event_id uniqueness alone did not catch it: the ids differ, which
   * is exactly the problem.
   */
  it('refuses a second, different original at a seq already signed', () => {
    const seq = alloc.reserve(HOUSE, BOB).seq;
    alloc.recordSigned(at('evt-a', seq, 1));

    expect(() => alloc.recordSigned(at('evt-b', seq, 2))).toThrow(
      'RELATION_SEQ_ALREADY_SIGNED',
    );
    const pending = alloc.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.eventId).toBe('evt-a');
  });

  it('still lets the same original be recorded again', () => {
    const seq = alloc.reserve(HOUSE, BOB).seq;
    alloc.recordSigned(at('evt-a', seq, 1));
    alloc.recordSigned(at('evt-a', seq, 1));
    expect(alloc.pending()).toHaveLength(1);
  });
});
