/**
 * The RECEIVING side of relation events, including two rounds of
 * independent review fixes:
 *
 * Round 1 — P1-A: house scope is an INJECTED, independently-verified
 * `TrustedSource` (from `ingress/inbound-commit.ts`), never derived from
 * envelope.lorehouse / order.house_key. P1-B: a `resolves`-bearing
 * (recovery) event still runs the same-seq sibling/fork check; only its
 * ACTION is skipped.
 *
 * Round 2 — P1: global CID dedup swallowed a legitimate later source/
 * generation (fixed by splitting `relation_frame_originals`, keyed by
 * event_id alone, from `relation_delivery_attempts`, keyed by the full
 * (event_id, house, incarnation, generation) tuple). P1: a legacy event
 * could clear a KNOWN FORK that had never actually applied anything (fixed
 * by gating legacy on `applied_seq !== NULL OR conflicted`, not
 * `applied_seq` alone). P1: a permanently non-terminal head starved the
 * rest of the queue (fixed by a first-pass / re-judge fairness split).
 *
 * Every fixture here is a REAL signed envelope — tweetnacl +
 * canonicalizeEnvelope/cidFromCanonical, the same path
 * tests/unit/ingress/verify-envelope.test.ts uses — so a fixture that cannot
 * pass verifyInboundEnvelope is not exercising a path production has.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope, cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import {
  makeRelationEnqueueWork,
  drainRelationAttempts,
  type TrustedSource,
  type InboundFrame,
} from '../../../src/social-graph/relation-consumer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');

const alice = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(1));
const mallory = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(2));
const bob = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
const ALICE = bs58.encode(alice.publicKey);
const BOB = bs58.encode(bob.publicKey);

const HOUSE = 'HouseKeyA';
const HOUSE2 = 'HouseKeyB';

/** The verified context a real connection would supply — never read off the envelope. */
function src(houseKey: string, incarnation = 'inc-1', ownerGeneration = 1): TrustedSource {
  return { houseKey, incarnation, ownerGeneration };
}

interface Fixture {
  readonly followee: string;
  readonly ts: number;
  readonly revoked?: boolean;
  readonly order?: { seq: number; houseKey?: string; resolves?: string[] };
  readonly lorehouse?: string;
  readonly key?: nacl.SignKeyPair;
  readonly actorId?: string;
}

/** Sign a FollowDeclared/FollowRevoked envelope the way an author's plugin does. */
function follow(f: Fixture): Uint8Array {
  const key = f.key ?? alice;
  const actorId = f.actorId ?? bs58.encode(key.publicKey);
  const payload: Record<string, unknown> = { followeePopclawId: f.followee };
  if (f.order) {
    const order: Record<string, unknown> = { seq: f.order.seq };
    if (f.order.houseKey !== undefined) order.houseKey = f.order.houseKey;
    if (f.order.resolves) order.resolves = f.order.resolves;
    payload.order = order;
  }
  const env: Record<string, unknown> = {
    actor: { popclawId: actorId },
    timestamp: f.ts,
    ...(f.lorehouse !== undefined ? { lorehouse: f.lorehouse } : {}),
    [f.revoked ? 'followRevoked' : 'followDeclared']: payload,
  };
  const canonical = canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, key.secretKey),
  }).finish();
}

function eventIdOf(bytes: Uint8Array): string {
  return popclaw.event.EventEnvelope.decode(bytes).eventId ?? '';
}

/**
 * Simulates exactly what `commitInboundFrame` does: call the EnqueueWork
 * handler inside its own already-open transaction. This module's enqueue
 * side must never open a transaction of its own — see makeRelationEnqueueWork.
 */
function enqueue(
  db: InMemoryHostDb,
  bytes: Uint8Array,
  recipient: string,
  sourceHouse: TrustedSource,
  opts: {
    stream?: 'personal' | 'world';
    position?: string;
    onRefused?: (frame: InboundFrame, reason: string) => void;
  } = {},
): void {
  const handler = makeRelationEnqueueWork({ recipientPopclawId: recipient, onRefused: opts.onRefused });
  const frame: InboundFrame = {
    eventId: eventIdOf(bytes),
    envelopeBytes: bytes,
    source: sourceHouse,
    stream: opts.stream ?? 'personal',
    ...(opts.position !== undefined ? { position: opts.position } : {}),
  };
  db.transaction((tx) => handler(tx, frame));
}

/**
 * A non-terminal outcome (forked/pending) is deliberately left open, so it
 * is reconsidered on every later drain — a drain can return more than one
 * outcome. Find THIS frame's own outcome by event_id rather than assuming
 * position.
 */
function outcomeFor<T extends { eventId?: string }>(outcomes: readonly T[], bytes: Uint8Array): T | undefined {
  const id = eventIdOf(bytes);
  return outcomes.find((o) => o.eventId === id);
}

function edgeRow(db: InMemoryHostDb, houseKey: string, followee = BOB) {
  return db.queryOne<{
    state: string;
    applied_seq: number | null;
    conflicted: number;
    source_incarnation: string | null;
    source_owner_generation: number | null;
  }>(
    'SELECT state, applied_seq, conflicted, source_incarnation, source_owner_generation FROM relation_edges WHERE house_key = ? AND follower_popclaw_id = ? AND followee_popclaw_id = ?',
    [houseKey, ALICE, followee],
  );
}

describe('relation-consumer · verification gate', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  it('writes nothing at all for a forged signature, and refuses it back to the commit point', () => {
    const env: Record<string, unknown> = {
      actor: { popclawId: ALICE },
      timestamp: 1_700_000_001,
      followDeclared: { followeePopclawId: BOB },
    };
    const canonical = canonicalizeEnvelope(env);
    const forged = popclaw.event.EventEnvelope.encode({
      ...env,
      eventId: cidFromCanonical(canonical),
      signature: nacl.sign.detached(canonical, mallory.secretKey),
    }).finish();

    const refusals: Array<{ frame: InboundFrame; reason: string }> = [];
    enqueue(db, forged, BOB, src(HOUSE), { onRefused: (frame, reason) => refusals.push({ frame, reason }) });

    expect(refusals).toHaveLength(1);
    expect(refusals[0]!.reason).toBe('SIGNATURE_INVALID');

    const eventId = cidFromCanonical(canonical);
    expect(db.queryOne('SELECT 1 FROM relation_frame_originals WHERE event_id = ?', [eventId])).toBeNull();
    expect(db.queryOne('SELECT 1 FROM relation_delivery_attempts WHERE event_id = ?', [eventId])).toBeNull();
    expect(db.queryOne('SELECT 1 FROM relation_event_log WHERE event_id = ?', [eventId])).toBeNull();
    expect(edgeRow(db, HOUSE)).toBeNull();
  });

  it('does not call onRefused for a frame it accepts', () => {
    const bytes = follow({ followee: BOB, ts: 1 });
    const refusals: string[] = [];
    enqueue(db, bytes, BOB, src(HOUSE), { onRefused: (_f, reason) => refusals.push(reason) });
    expect(refusals).toHaveLength(0);
  });

  it('ignores a frame on the world stream — relations only ride the personal stream', () => {
    const bytes = follow({ followee: BOB, ts: 1 });
    enqueue(db, bytes, BOB, src(HOUSE), { stream: 'world' });
    expect(db.queryOne('SELECT 1 FROM relation_frame_originals WHERE event_id = ?', [eventIdOf(bytes)])).toBeNull();
  });

  it('accepts the echo of my own follow back to me (actor === recipient)', () => {
    const bytes = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, bytes, ALICE, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), bytes);
    expect(outcome!.verdict).toBe('applied');
  });
});

describe('relation-consumer · P1 (round 1): trusted source house, not the envelope', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  it('scopes a legacy (order-absent) edge by the VERIFIED house, ignoring an absent envelope.lorehouse', () => {
    const bytes = follow({ followee: BOB, ts: 1 });
    enqueue(db, bytes, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), bytes);
    expect(outcome!.verdict).toBe('applied');
    expect(edgeRow(db, HOUSE)?.state).toBe('following');
  });

  it('two houses never collide on a legacy edge, even with no lorehouse at all', () => {
    const a = follow({ followee: BOB, ts: 1 });
    const b = follow({ followee: BOB, ts: 2, revoked: true });
    enqueue(db, a, BOB, src(HOUSE));
    enqueue(db, b, BOB, src(HOUSE2));
    drainRelationAttempts(db, [src(HOUSE), src(HOUSE2)]);

    expect(edgeRow(db, HOUSE)?.state).toBe('following');
    expect(edgeRow(db, HOUSE2)?.state).toBe('revoked');
  });

  it('an attacker-claimed envelope.lorehouse is ignored — the edge is keyed by the verified house', () => {
    const bytes = follow({
      followee: BOB,
      ts: 1,
      lorehouse: 'ATTACKER_CLAIMED_HOUSE',
      order: { seq: 1, houseKey: HOUSE },
    });
    enqueue(db, bytes, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);
    expect(edgeRow(db, HOUSE)?.state).toBe('following');
    expect(edgeRow(db, 'ATTACKER_CLAIMED_HOUSE')).toBeNull();
  });

  it('rejects order.house_key disagreeing with the verified source house (SCOPE_MISMATCH)', () => {
    const bytes = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE2 } });
    enqueue(db, bytes, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), bytes);
    expect(outcome!.verdict).toBe('rejected');
    expect(outcome!.reason).toBe('SCOPE_MISMATCH');
    expect(edgeRow(db, HOUSE)).toBeNull();
  });

  it('persists the verified incarnation and owner generation alongside the edge it touched', () => {
    const bytes = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, bytes, BOB, src(HOUSE, 'inc-7', 3));
    drainRelationAttempts(db, [src(HOUSE, 'inc-7', 3)]);
    const edge = edgeRow(db, HOUSE);
    expect(edge?.source_incarnation).toBe('inc-7');
    expect(edge?.source_owner_generation).toBe(3);
  });
});

describe('relation-consumer · P1 (round 2): dedup does not swallow a legitimate source or generation', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  /**
   * The exact scenario from review: an original first arrives via the WRONG
   * house and is refused on scope; the REAL house then delivers the
   * identical bytes. A single event_id-keyed dedup would make the first
   * rejection permanent. relation_frame_originals (keyed by event_id alone)
   * and relation_delivery_attempts (keyed by the full source tuple) keep
   * them as two independent judgements.
   */
  it('a rejection recorded via the wrong house does not poison the same bytes delivered later via the right house', () => {
    const bytes = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });

    // Wrong house: HOUSE2 claims to deliver an event scoped to HOUSE.
    enqueue(db, bytes, BOB, src(HOUSE2));
    const wrong = outcomeFor(drainRelationAttempts(db, [src(HOUSE2)]), bytes);
    expect(wrong!.verdict).toBe('rejected');
    expect(wrong!.reason).toBe('SCOPE_MISMATCH');
    expect(edgeRow(db, HOUSE)).toBeNull();

    // Right house delivers the SAME bytes later.
    enqueue(db, bytes, BOB, src(HOUSE));
    const right = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), bytes);
    expect(right!.verdict).toBe('applied');
    expect(edgeRow(db, HOUSE)?.state).toBe('following');

    // Only ONE original was ever stored — dedup by CID is exact, not duplicated.
    const originals = db.queryAll('SELECT 1 FROM relation_frame_originals WHERE event_id = ?', [eventIdOf(bytes)]);
    expect(originals).toHaveLength(1);
  });

  /**
   * The other scenario from review: a gen-1 delivery nobody ever drained,
   * followed by logout/login into gen 2. The identical bytes redelivered
   * under gen 2 (a normal reconnect resync) must be independently
   * reachable — not silently owned forever by the un-drained gen-1 row.
   */
  it('a redelivery under a new owner generation is independently reachable, regardless of an old un-drained generation', () => {
    const bytes = follow({ followee: BOB, ts: 1 });

    enqueue(db, bytes, BOB, src(HOUSE, 'inc-1', 1)); // gen 1, never drained

    // Owner logs out, back in as gen 2; the transport resyncs and redelivers.
    enqueue(db, bytes, BOB, src(HOUSE, 'inc-1', 2));

    // Only gen 2 is currently authorised.
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE, 'inc-1', 2)]), bytes);
    expect(outcome!.verdict).toBe('applied');
    expect(edgeRow(db, HOUSE)?.state).toBe('following');

    // Two independent attempt rows exist for the one original.
    const attempts = db.queryAll<{ source_owner_generation: number }>(
      'SELECT source_owner_generation FROM relation_delivery_attempts WHERE event_id = ? ORDER BY source_owner_generation',
      [eventIdOf(bytes)],
    );
    expect(attempts.map((a) => a.source_owner_generation)).toEqual([1, 2]);
  });
});

describe('relation-consumer · legacy edges (order absent, R4 §6)', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  it('applies a legacy follow to a brand-new edge, applied_seq stays NULL', () => {
    const bytes = follow({ followee: BOB, ts: 1 });
    enqueue(db, bytes, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), bytes);
    expect(outcome!.verdict).toBe('applied');
    expect(edgeRow(db, HOUSE)?.applied_seq).toBeNull();
  });

  it('never re-classifies a terminal event_id — a replayed declare cannot undo a later revoke', () => {
    const declared = follow({ followee: BOB, ts: 1 });
    const revoked = follow({ followee: BOB, ts: 2, revoked: true });
    enqueue(db, declared, BOB, src(HOUSE));
    enqueue(db, revoked, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);
    expect(edgeRow(db, HOUSE)?.state).toBe('revoked');

    // Re-deliver the FIRST event's identical bytes from the SAME source.
    enqueue(db, declared, BOB, src(HOUSE));
    const outcomes = drainRelationAttempts(db, [src(HOUSE)]);
    expect(outcomeFor(outcomes, declared)).toBeUndefined(); // already applied_at-stamped for this source; nothing pending
    expect(edgeRow(db, HOUSE)?.state).toBe('revoked');
  });

  it('a replayed terminal event returns its stored verdict instead of being judged again', () => {
    // R4 §4.1 step 2 — "a terminal verdict is never re-classified" — had no
    // coverage: the rule could be deleted and this whole file stayed green,
    // including the case named after it. What actually kept replays harmless
    // was one layer up, where the drain refuses to re-present an attempt it
    // already stamped done. That is a real defence, but it is not this one,
    // and it does not hold where the attempt is legitimately new.
    //
    // A logout and login is exactly that case: the same original redelivered
    // under a second owner generation is a separate attempt on purpose, so it
    // reaches the decision. What must happen there is that the event is
    // recognised by id and handed back its own earlier verdict — NOT judged
    // afresh against an edge its first judgement already moved.
    const bytes = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, bytes, BOB, src(HOUSE, 'inc-1', 1));
    expect(outcomeFor(drainRelationAttempts(db, [src(HOUSE, 'inc-1', 1)]), bytes)!.verdict).toBe('applied');
    const before = edgeRow(db, HOUSE);
    expect(before).toMatchObject({ state: 'following', applied_seq: 1, conflicted: 0 });

    enqueue(db, bytes, BOB, src(HOUSE, 'inc-1', 2));
    const again = outcomeFor(drainRelationAttempts(db, [src(HOUSE, 'inc-1', 2)]), bytes);

    // `reused` is the guard's own signal: the verdict was recalled, not remade.
    expect(again).toMatchObject({ verdict: 'applied', reused: true });
    expect(edgeRow(db, HOUSE)).toEqual(before);
    // One statement, one row. A second row at seq 1 would also become
    // same-seq evidence for anything that counts rows later.
    const rows = db.queryAll<{ n: number }>(
      'SELECT COUNT(*) AS n FROM relation_event_log WHERE house_key = ? AND follower_popclaw_id = ? AND followee_popclaw_id = ? AND event_id = ?',
      [HOUSE, ALICE, BOB, eventIdOf(bytes)],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('refuses an order-absent event on an edge already in ordered mode (the downgrade path)', () => {
    const ordered = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, ordered, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);
    expect(edgeRow(db, HOUSE)?.state).toBe('following');

    const legacyAfter = follow({ followee: BOB, ts: 2, revoked: true });
    enqueue(db, legacyAfter, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), legacyAfter);
    expect(outcome!.verdict).toBe('rejected');
    expect(outcome!.reason).toBe('LEGACY_EVENT_ON_ORDERED_EDGE');

    const edge = edgeRow(db, HOUSE);
    expect(edge?.state).toBe('following');
    expect(edge?.applied_seq).toBe(1);
  });

  /**
   * P1 (round 2): gating legacy on applied_seq alone let a legacy event
   * clear a fork that had never actually applied anything — R5 (recovery)
   * arrives first (never applies, applied_seq stays NULL), then F5 forks
   * against it (conflicted=1, applied_seq STILL NULL because nothing ever
   * reached apply). A legacy event must still be refused here: "known
   * ordered evidence" is not the same fact as "a seq we once applied".
   */
  it('refuses a legacy event on an edge that is conflicted but has never actually applied anything', () => {
    const recovery = follow({
      followee: BOB,
      ts: 1,
      revoked: true,
      order: { seq: 5, houseKey: HOUSE, resolves: ['evt-a', 'evt-b'] },
    });
    const declare = follow({ followee: BOB, ts: 2, order: { seq: 5, houseKey: HOUSE } });
    enqueue(db, recovery, BOB, src(HOUSE));
    enqueue(db, declare, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);

    const forkedBefore = edgeRow(db, HOUSE);
    expect(forkedBefore?.conflicted).toBe(1);
    expect(forkedBefore?.applied_seq).toBeNull();
    expect(forkedBefore?.state).toBe('unknown');

    const legacy = follow({ followee: BOB, ts: 3, revoked: true });
    enqueue(db, legacy, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), legacy);
    expect(outcome!.verdict).toBe('rejected');
    expect(outcome!.reason).toBe('LEGACY_EVENT_ON_ORDERED_EDGE');

    // Untouched: still conflicted, still nothing ever applied.
    const after = edgeRow(db, HOUSE);
    expect(after?.conflicted).toBe(1);
    expect(after?.applied_seq).toBeNull();
    expect(after?.state).toBe('unknown');
  });

  /**
   * P1 (third round, Codex's exact reproduction): a genuinely signed,
   * correctly-scoped `resolves` event — right house, right actor, right
   * recipient — lands `pending` and creates NO relation_edges row at all
   * (no fork, no sibling, nothing to apply). Gating legacy on the edge's
   * own applied_seq/conflicted columns missed this entirely: with no edge
   * row, `edge && (...)` was false, and a legacy event walked straight
   * through and applied over evidence the edge projection had never even
   * been told about. The fix reads relation_event_log directly, so it does
   * not matter whether relation_edges has a row yet.
   */
  it('refuses a legacy event on an edge whose only ordered evidence is a lone PENDING recovery (no edge row exists yet)', () => {
    const recovery = follow({
      followee: BOB,
      ts: 1,
      revoked: true,
      order: { seq: 5, houseKey: HOUSE, resolves: ['evt-a-this-end-does-not-hold'] },
    });
    enqueue(db, recovery, BOB, src(HOUSE));
    const pending = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), recovery);
    expect(pending!.verdict).toBe('pending');
    expect(pending!.reason).toBe('UNSUPPORTED_RECOVERY');
    expect(edgeRow(db, HOUSE)).toBeNull(); // no edge row at all — nothing to gate on there

    const legacyU = follow({ followee: BOB, ts: 2, revoked: true });
    enqueue(db, legacyU, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), legacyU);
    expect(outcome!.verdict).toBe('rejected');
    expect(outcome!.reason).toBe('LEGACY_EVENT_ON_ORDERED_EDGE');

    // Still no edge row: the legacy event must not have created one either.
    expect(edgeRow(db, HOUSE)).toBeNull();
  });
});

describe('relation-consumer · ordered edges (R4 §1.2 magnitude)', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  it('a legacy edge adopts ordered mode on its first order-bearing event, applied_seq = seq', () => {
    const legacy = follow({ followee: BOB, ts: 1 });
    enqueue(db, legacy, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);

    const adopts = follow({ followee: BOB, ts: 2, revoked: true, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, adopts, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);

    const edge = edgeRow(db, HOUSE);
    expect(edge?.state).toBe('revoked');
    expect(edge?.applied_seq).toBe(1);
  });

  it('a stale, lower-seq event is superseded on arrival and changes nothing (not an error)', () => {
    const seq1 = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    const seq3 = follow({ followee: BOB, ts: 2, revoked: true, order: { seq: 3, houseKey: HOUSE } });
    const seq2 = follow({ followee: BOB, ts: 3, order: { seq: 2, houseKey: HOUSE } });

    enqueue(db, seq1, BOB, src(HOUSE));
    enqueue(db, seq3, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);

    enqueue(db, seq2, BOB, src(HOUSE));
    const stale = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), seq2);
    expect(stale!.verdict).toBe('superseded');
    expect(stale!.reason).toBe('STALE');

    const edge = edgeRow(db, HOUSE);
    expect(edge?.state).toBe('revoked');
    expect(edge?.applied_seq).toBe(3);

    const seq1Log = db.queryOne<{ verdict: string }>('SELECT verdict FROM relation_event_log WHERE event_id = ?', [
      eventIdOf(seq1),
    ]);
    expect(seq1Log?.verdict).toBe('superseded');
  });

  it('a gap in seq is not an error — seq 5 applies over nothing even though seq 4 was never seen', () => {
    const seq5 = follow({ followee: BOB, ts: 1, order: { seq: 5, houseKey: HOUSE } });
    enqueue(db, seq5, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);
    expect(edgeRow(db, HOUSE)?.applied_seq).toBe(5);
  });
});

describe('relation-consumer · fork detection and blocking (R4 §1.2, §4.3)', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  it('a same-seq sibling forks the edge and leaves the prior applied effect standing', () => {
    const declare = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    const revoke = follow({ followee: BOB, ts: 2, revoked: true, order: { seq: 1, houseKey: HOUSE } });

    enqueue(db, declare, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);
    enqueue(db, revoke, BOB, src(HOUSE));
    const forked = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), revoke);
    expect(forked!.verdict).toBe('forked');

    const edge = edgeRow(db, HOUSE);
    expect(edge?.state).toBe('following'); // declare's effect stands
    expect(edge?.applied_seq).toBe(1);
    expect(edge?.conflicted).toBe(1);

    const declareLog = db.queryOne<{ verdict: string }>(
      'SELECT verdict FROM relation_event_log WHERE event_id = ?',
      [eventIdOf(declare)],
    );
    expect(declareLog?.verdict).toBe('fork_branch');
  });

  it('a higher-seq ordinary event on a forked edge changes nothing', () => {
    const declare = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    const revoke = follow({ followee: BOB, ts: 2, revoked: true, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, declare, BOB, src(HOUSE));
    enqueue(db, revoke, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);

    const higher = follow({ followee: BOB, ts: 3, order: { seq: 2, houseKey: HOUSE } });
    enqueue(db, higher, BOB, src(HOUSE));
    const blocked = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), higher);
    expect(blocked!.verdict).toBe('pending');
    expect(blocked!.reason).toBe('FORK_BLOCKED');

    const edge = edgeRow(db, HOUSE);
    expect(edge?.state).toBe('following');
    expect(edge?.applied_seq).toBe(1);
    expect(edge?.conflicted).toBe(1);
  });

  it('more evidence at an already-forked seq is still recorded as a fork, not as FORK_BLOCKED', () => {
    const a = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    const b = follow({ followee: BOB, ts: 2, revoked: true, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, a, BOB, src(HOUSE));
    enqueue(db, b, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);

    const c = follow({ followee: BOB, ts: 3, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, c, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), c);
    expect(outcome!.verdict).toBe('forked');
  });

  it('two houses starting the same edge at seq 1 do not conflict each other (R4 §5 namespace isolation)', () => {
    const houseA = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    const houseB = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE2 } });

    enqueue(db, houseA, BOB, src(HOUSE));
    enqueue(db, houseB, BOB, src(HOUSE2));
    drainRelationAttempts(db, [src(HOUSE), src(HOUSE2)]);

    expect(edgeRow(db, HOUSE)?.conflicted).toBe(0);
    expect(edgeRow(db, HOUSE2)?.conflicted).toBe(0);
  });
});

describe('relation-consumer · P1-B (round 1): a recovery is a branch until something covers it', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  function f5() {
    return follow({ followee: BOB, ts: 1, order: { seq: 5, houseKey: HOUSE } });
  }
  function r5() {
    return follow({
      followee: BOB,
      ts: 2,
      revoked: true,
      order: { seq: 5, houseKey: HOUSE, resolves: ['evt-a', 'evt-b'] },
    });
  }

  it('F5 then R5: the recovery still triggers the same-seq fork check and conflicts the edge', () => {
    enqueue(db, f5(), BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);

    enqueue(db, r5(), BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), r5());
    expect(outcome!.verdict).toBe('forked');

    const edge = edgeRow(db, HOUSE);
    expect(edge?.conflicted).toBe(1);
    expect(edge?.state).toBe('following'); // F5's effect stands
    expect(edge?.applied_seq).toBe(5);
  });

  it('R5 then F5 (reverse arrival order): the fork is still detected', () => {
    const recovery = r5();
    enqueue(db, recovery, BOB, src(HOUSE));
    const pending = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), recovery);
    expect(pending!.verdict).toBe('pending');
    expect(pending!.reason).toBe('UNSUPPORTED_RECOVERY');
    expect(edgeRow(db, HOUSE)).toBeNull(); // recovery never applies on its own

    const declare = f5();
    enqueue(db, declare, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), declare);
    expect(outcome!.verdict).toBe('forked');
    expect(edgeRow(db, HOUSE)?.conflicted).toBe(1);
  });

  it('an ordinary F6 must not cross the F5/R5 fork', () => {
    enqueue(db, f5(), BOB, src(HOUSE));
    enqueue(db, r5(), BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);
    expect(edgeRow(db, HOUSE)?.conflicted).toBe(1);

    const f6 = follow({ followee: BOB, ts: 3, order: { seq: 6, houseKey: HOUSE } });
    enqueue(db, f6, BOB, src(HOUSE));
    const blocked = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), f6);
    expect(blocked!.verdict).toBe('pending');
    expect(blocked!.reason).toBe('FORK_BLOCKED');
    expect(edgeRow(db, HOUSE)?.applied_seq).toBe(5); // not moved to 6
  });

  it('a resolves frame with seq 0 is malformed, not a normal pending', () => {
    const bad = follow({ followee: BOB, ts: 1, order: { seq: 0, houseKey: HOUSE, resolves: ['evt-a'] } });
    enqueue(db, bad, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), bad);
    expect(outcome!.verdict).toBe('rejected');
    expect(outcome!.reason).toBe('ILLEGAL_ORDER_SEQ');
  });

  it('a resolves frame with the wrong scope is malformed, not a normal pending', () => {
    const bad = follow({ followee: BOB, ts: 1, order: { seq: 5, houseKey: HOUSE2, resolves: ['evt-a'] } });
    enqueue(db, bad, BOB, src(HOUSE));
    const outcome = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), bad);
    expect(outcome!.verdict).toBe('rejected');
    expect(outcome!.reason).toBe('SCOPE_MISMATCH');
  });
});

describe('relation-consumer · P1 (round 2): authorised sources, per-house watermark, no silent swallow', () => {
  let db: InMemoryHostDb;
  beforeEach(() => {
    db = new InMemoryHostDb();
    runMigrations(db, MIGRATIONS);
  });

  it('a drain scoped to house B never touches house A backlog ("keep the data, stop the effects")', () => {
    const forA = follow({ followee: BOB, ts: 1 });
    enqueue(db, forA, BOB, src(HOUSE));

    const outcomesForB = drainRelationAttempts(db, [src(HOUSE2)]);
    expect(outcomesForB).toHaveLength(0);
    expect(edgeRow(db, HOUSE)).toBeNull();

    const outcomesForA = drainRelationAttempts(db, [src(HOUSE)]);
    expect(outcomesForA).toHaveLength(1);
    expect(edgeRow(db, HOUSE)?.state).toBe('following');
  });

  it('a non-terminal outcome (FORK_BLOCKED) is not stamped done and is reconsidered on the next drain', () => {
    const declare = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    const revoke = follow({ followee: BOB, ts: 2, revoked: true, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, declare, BOB, src(HOUSE));
    enqueue(db, revoke, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]);

    const blockedBytes = follow({ followee: BOB, ts: 3, order: { seq: 2, houseKey: HOUSE } });
    enqueue(db, blockedBytes, BOB, src(HOUSE));
    const first = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), blockedBytes);
    expect(first!.verdict).toBe('pending');

    const stillOpen = db.queryOne(
      'SELECT applied_at FROM relation_delivery_attempts WHERE event_id = ?',
      [eventIdOf(blockedBytes)],
    );
    expect(stillOpen).toEqual({ applied_at: null });

    const second = outcomeFor(drainRelationAttempts(db, [src(HOUSE)]), blockedBytes);
    expect(second!.verdict).toBe('pending');
    expect(second!.reason).toBe('FORK_BLOCKED');
  });

  it('the watermark is per house_key, not a single process-wide counter', () => {
    const forA = follow({ followee: BOB, ts: 1 });
    const forB = follow({ followee: BOB, ts: 2 });
    enqueue(db, forA, BOB, src(HOUSE));
    enqueue(db, forB, BOB, src(HOUSE2));
    drainRelationAttempts(db, [src(HOUSE)]);

    const wmA = db.queryOne<{ last_attempt_rowid: number }>(
      'SELECT last_attempt_rowid FROM relation_applied_watermark WHERE house_key = ?',
      [HOUSE],
    );
    const wmB = db.queryOne('SELECT 1 FROM relation_applied_watermark WHERE house_key = ?', [HOUSE2]);
    expect(wmA?.last_attempt_rowid).toBeGreaterThan(0);
    expect(wmB).toBeNull(); // house B was never authorised in this drain call
  });

  /**
   * P2 (third round, Codex's exact reproduction): a permanently non-terminal
   * attempt (H, FORK_BLOCKED forever) must not be starved by CONTINUOUS new
   * traffic — one brand-new event enqueued every round, limit 1 throughout.
   * Codex measured H's last_attempted_at staying at the same value across
   * five such rounds under the old "first pass always goes first, re-judge
   * gets only the leftover budget" split, because first pass always had
   * something (that round's own new arrival) and so never left any budget
   * for re-judgement. The rotation in `relation_drain_state.favor_retry`
   * guarantees re-judgement a turn at least every other call, regardless of
   * how much new traffic keeps arriving — proven here by H's `attempt_seq`
   * actually advancing partway through continuous new arrivals, not just by
   * a fixed two-round script.
   */
  it('a permanently non-terminal attempt is not starved by continuous new traffic (rotation, limit 1)', () => {
    // Set up H: an edge forked before H itself ever arrives.
    const hDeclare = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    const hRevoke = follow({ followee: BOB, ts: 2, revoked: true, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, hDeclare, BOB, src(HOUSE));
    enqueue(db, hRevoke, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]); // establishes the fork (unlimited: both get their first attempt)

    const h = follow({ followee: BOB, ts: 3, order: { seq: 2, houseKey: HOUSE } }); // FORK_BLOCKED forever
    enqueue(db, h, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)]); // H's own first attempt, deterministically, before the limit-1 loop starts

    const attemptSeqOf = (bytes: Uint8Array): number | null =>
      db.queryOne<{ attempt_seq: number | null }>(
        'SELECT attempt_seq FROM relation_delivery_attempts WHERE event_id = ?',
        [eventIdOf(bytes)],
      )?.attempt_seq ?? null;

    const seqAfterFirstAttempt = attemptSeqOf(h);
    expect(seqAfterFirstAttempt).not.toBeNull();

    // Continuous new traffic: a brand-new edge (BOB's own echo, so it's
    // authorised regardless of followee) enqueued every round, drained at
    // limit 1 — the exact shape Codex used to reproduce the starvation.
    let hReconsidered = false;
    let someNewArrivalApplied = false;
    for (let i = 0; i < 8; i++) {
      const ei = follow({ followee: `unrelated-${i}`, ts: 100 + i, key: bob });
      enqueue(db, ei, BOB, src(HOUSE));
      const outcomes = drainRelationAttempts(db, [src(HOUSE)], undefined, 1);
      if (outcomeFor(outcomes, h)) hReconsidered = true;
      if (outcomeFor(outcomes, ei)?.verdict === 'applied') someNewArrivalApplied = true;
    }

    // H got its turn again amid continuous new traffic — not stuck like the
    // counter-example — proven by the strict counter actually advancing,
    // not merely a wall-clock field that could tie.
    expect(hReconsidered).toBe(true);
    expect(attemptSeqOf(h)).toBeGreaterThan(seqAfterFirstAttempt!);
    // And the rotation does not simply invert the starvation onto new
    // arrivals either — at least one of them got through too.
    expect(someNewArrivalApplied).toBe(true);
  });

  /**
   * The tie-break Codex flagged directly: relation_delivery_attempts stores
   * whole-second timestamps, so two attempts processed within the same
   * second (routine, and guaranteed under a fixed test clock) tie on
   * last_attempted_at. attempt_seq is a separate, strictly increasing
   * counter with no ties possible, and it is what orders the re-judge pass.
   */
  it('orders the re-judge pass by a strict counter, not a wall clock that can tie', () => {
    const fixedClock = () => 1_700_000_000; // every attempt lands on the identical second
    const a = follow({ followee: BOB, ts: 1, order: { seq: 1, houseKey: HOUSE } });
    const b = follow({ followee: BOB, ts: 2, revoked: true, order: { seq: 1, houseKey: HOUSE } });
    enqueue(db, a, BOB, src(HOUSE));
    enqueue(db, b, BOB, src(HOUSE));
    drainRelationAttempts(db, [src(HOUSE)], fixedClock); // forks; both a and b are now open, same last_attempted_at

    const seqA = db.queryOne<{ attempt_seq: number }>('SELECT attempt_seq FROM relation_delivery_attempts WHERE event_id = ?', [eventIdOf(a)])?.attempt_seq;
    const seqB = db.queryOne<{ attempt_seq: number }>('SELECT attempt_seq FROM relation_delivery_attempts WHERE event_id = ?', [eventIdOf(b)])?.attempt_seq;
    expect(seqA).not.toBe(seqB); // distinguishable even though the wall clock is not
  });
});
