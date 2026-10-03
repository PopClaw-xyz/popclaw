/**
 * Author-side seq allocation for ordered relation events.
 *
 * The failure this exists for is not an attack. Sign seq 8, the push times
 * out, re-sign — and the second attempt carries a different event_id at the
 * same position, so the owner's own retry has forked their own edge. The fix is
 * the ordering of durability, not cleverness: the fully-signed original commits
 * to disk **before** the first network attempt, and a retry ships those exact
 * bytes so the CID is unchanged and the house's dedup absorbs it.
 *
 * Two rules that look similar and are not:
 *   - a crash MAY skip a number. Gaps are legal (§1.2 compares, it does not
 *     require contiguity), so skipping costs nothing.
 *   - nothing may REUSE one. That costs a self-inflicted fork.
 * So `reserved` only ever goes up, and it goes up before anything is signed.
 *
 * What this deliberately does NOT do: prevent two devices signing concurrently
 * on the same edge. That is a real fork, it is detected as one, and the author
 * resolves it (§4.3). An allocator on one machine cannot see the other.
 */
import type { HostDb } from '../host/host-db.js';

/** The largest seq the durable column and the protocol both accept. */
export const MAX_RELATION_SEQ = (1n << 63n) - 1n;

export interface ReservedSeq {
  readonly seq: bigint;
  /**
   * True when this end has verified a higher seq than it ever signed itself —
   * i.e. another device of the owner's has been signing on this edge. The
   * number is still safe to use, but the caller should say so rather than
   * present the local count as the edge's authoritative history.
   */
  readonly anotherEndHasSigned: boolean;
}

export interface PendingRelationPush {
  readonly eventId: string;
  readonly houseKey: string;
  readonly followeePopclawId: string;
  readonly seq: bigint;
  readonly signedPayload: Uint8Array;
  readonly houseSlug?: string;
}

/** The three counters and the two facts derived from them, kept apart. */
export interface EdgeBound {
  /** Handed out locally. May never have been signed — a crash between
   *  reserving and signing leaves exactly this. */
  readonly reserved: bigint;
  /** An original exists locally at this number. */
  readonly signed: bigint;
  /** The highest seq VERIFIED from any source, another device included. The
   *  only counter that can carry evidence of someone other than this end. */
  readonly observed: bigint;
  /** Sticky record that originals exist which this end does not hold. */
  readonly lowerBoundOnly: boolean;
  /** The seq through which THIS round has re-established the edge. */
  readonly recoveredThrough: bigint;
  /** The identity round whose coverage `recoveredThrough` reports. */
  readonly recoveredInRound: string | undefined;
  /** How far any round ever got. What the current one has to catch up to. */
  readonly recoveredEver: bigint;
  /** Known history above this end that it has not re-established. */
  readonly historyGapOpen: boolean;
  /** The ceiling of all three. What the next reservation would sit above. */
  readonly high: bigint;
  /** Has this end signed, with no verified evidence of anyone above it? */
  readonly authoritative: boolean;
}

/**
 * Counters come back as decimal STRINGS and are compared as BigInt.
 *
 * Not a style choice. SQLite's INTEGER is 64-bit but the driver hands back a JS
 * Number, and above 2^53 a Number silently stops being able to represent its
 * own successor: `Math.max(...) + 1` returns the SAME value, so the allocator
 * hands out a number it has already handed out. That is the one failure this
 * whole file exists to prevent, inside the protocol's legal domain — not at
 * some exotic boundary. Reading as TEXT and computing in BigInt keeps the chain
 * lossless from the column to the protobuf field, without changing what any
 * other HostDb caller gets back.
 */
interface SeqRowText {
  reserved: string;
  signed: string;
  observed: string;
  /** Sticky: this end has verified a seq it did not sign (migration 027). */
  lower_bound_only: number;
  recovered_through: string;
  recovered_in_round: string | null;
  recovered_ever: string;
}

const SEQ_SELECT =
  'SELECT CAST(reserved AS TEXT) AS reserved, CAST(signed AS TEXT) AS signed, ' +
  'CAST(observed AS TEXT) AS observed, lower_bound_only, ' +
  'CAST(recovered_through AS TEXT) AS recovered_through, recovered_in_round, ' +
  'CAST(recovered_ever AS TEXT) AS recovered_ever FROM relation_seq ' +
  'WHERE house_key = ? AND followee_popclaw_id = ?';

const ZERO: SeqRowText = {
  reserved: '0',
  signed: '0',
  observed: '0',
  lower_bound_only: 0,
  recovered_through: '0',
  recovered_in_round: null,
  recovered_ever: '0',
};

/**
 * Is there known history above this edge that this end has not re-established?
 *
 * `lower_bound_only` alone used to answer this, which made the refusal
 * permanent: an end that once verified someone else's signature could never
 * sign on that edge again, whatever it subsequently recovered. The flag stays
 * sticky — it records something that happened — and the question asked at the
 * gate becomes whether the gap it opened is still open.
 */
function historyGapOpen(cur: SeqRowText): boolean {
  return cur.lower_bound_only !== 0 && BigInt(cur.recovered_through) < BigInt(cur.observed);
}

function high(row: SeqRowText): bigint {
  const r = BigInt(row.reserved);
  const s = BigInt(row.signed);
  const o = BigInt(row.observed);
  return r > s ? (r > o ? r : o) : s > o ? s : o;
}

export class RelationAllocator {
  constructor(
    private readonly db: HostDb,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  private row(houseKey: string, followee: string): SeqRowText {
    return this.db.queryOne<SeqRowText>(SEQ_SELECT, [houseKey, followee]) ?? ZERO;
  }

  /**
   * Take the next seq for this edge. Bumps `reserved` in the same statement
   * that reads it, so two concurrent callers in one process cannot be handed
   * the same number.
   *
   * The next number is one above the highest of all three counters. Notably it
   * is **never** derived from what a house reports: `applied_seq` from a house
   * is a claim, and a stale or hostile one would walk the author straight into
   * colliding with their own history.
   */
  reserve(houseKey: string, followee: string): ReservedSeq {
    return this.db.transaction((tx) => {
      const cur = tx.queryOne<SeqRowText>(SEQ_SELECT, [houseKey, followee]) ?? ZERO;
      // An end that has seen signing it did not do must not resume at
      // observed+1. Originals may exist above what it observed, and reserving
      // into them is a fork it inflicts on its owner. It can still hold
      // evidence and resend originals it already has — it just cannot allocate.
      if (historyGapOpen(cur)) throw new Error('RELATION_SIGNING_NOT_READY');
      const next = high(cur) + 1n;
      // Exhaustion stops signing; it does not wrap. A counter that starts over
      // is indistinguishable from one deliberately reusing a number, which is
      // precisely the fork this file exists to avoid.
      if (next > MAX_RELATION_SEQ) throw new Error('RELATION_SEQ_EXHAUSTED');
      tx.execute(
        `INSERT INTO relation_seq (house_key, followee_popclaw_id, reserved, signed, observed)
         VALUES (?, ?, ?, 0, 0)
         ON CONFLICT (house_key, followee_popclaw_id) DO UPDATE SET reserved = CAST(? AS INTEGER)`,
        [houseKey, followee, next.toString(), next.toString()],
      );
      return { seq: next, anotherEndHasSigned: BigInt(cur.observed) > BigInt(cur.signed) };
    });
  }

  /**
   * Commit the signed original and its send todo, and record that this end has
   * now signed at `seq`. One transaction: after this returns, a crash costs at
   * most a resend, never a re-sign.
   */
  recordSigned(push: PendingRelationPush): void {
    this.db.transaction((tx) => {
      // A retry of the SAME original is idempotent; a DIFFERENT original at a
      // seq already taken is two event_ids at one position — a fork, on the
      // sending side, where it is still preventable. So the second case fails
      // loudly rather than quietly queueing a second event (migration 028).
      const taken = tx.queryOne<{ event_id: string }>(
        'SELECT event_id FROM relation_outbox WHERE house_key = ? AND followee_popclaw_id = ? AND seq = CAST(? AS INTEGER)',
        [push.houseKey, push.followeePopclawId, push.seq.toString()],
      );
      if (taken && taken.event_id !== push.eventId) {
        throw new Error('RELATION_SEQ_ALREADY_SIGNED');
      }
      tx.execute(
        `INSERT OR IGNORE INTO relation_outbox
           (event_id, house_key, followee_popclaw_id, seq, signed_payload, house_slug, created_at)
         VALUES (?, ?, ?, CAST(? AS INTEGER), ?, ?, ?)`,
        [
          push.eventId,
          push.houseKey,
          push.followeePopclawId,
          push.seq.toString(),
          push.signedPayload,
          push.houseSlug ?? null,
          this.now(),
        ],
      );
      tx.execute(
        `INSERT INTO relation_seq (house_key, followee_popclaw_id, reserved, signed, observed)
         VALUES (?, ?, ?, ?, 0)
         ON CONFLICT (house_key, followee_popclaw_id)
         DO UPDATE SET signed = MAX(signed, CAST(? AS INTEGER)),
                       reserved = MAX(reserved, CAST(? AS INTEGER))`,
        [
          push.houseKey,
          push.followeePopclawId,
          push.seq.toString(),
          push.seq.toString(),
          push.seq.toString(),
          push.seq.toString(),
        ],
      );
    });
  }

  /** Everything signed but not yet confirmed sent, oldest first. */
  pending(): PendingRelationPush[] {
    return this.db
      .queryAll<{
        event_id: string;
        house_key: string;
        followee_popclaw_id: string;
        seq: string;
        signed_payload: Uint8Array;
        house_slug: string | null;
      }>(
        `SELECT event_id, house_key, followee_popclaw_id, CAST(seq AS TEXT) AS seq,
                signed_payload, house_slug
         FROM relation_outbox WHERE sent_at IS NULL ORDER BY created_at, seq`,
        [],
      )
      .map((r) => ({
        eventId: r.event_id,
        houseKey: r.house_key,
        followeePopclawId: r.followee_popclaw_id,
        seq: BigInt(r.seq),
        signedPayload: r.signed_payload,
        ...(r.house_slug ? { houseSlug: r.house_slug } : {}),
      }));
  }

  /**
   * The latest original THIS end signed on one edge, sent or not.
   *
   * `pending()` answers "what still owes a push"; this answers "what did I
   * already say here", which is a different question and the one a repeated
   * command has to ask. Without it every re-run of `follow` mints a fresh
   * statement — and the two are not interchangeable: re-sending the same
   * bytes is absorbed by the house's dedup, while a new sequence number is a
   * new fact that the followee's machine has to take seriously.
   *
   * Scoped by `house_key` on purpose. The same person followed at a second
   * house is a separate edge with its own numbering, and must stay one.
   */
  latestAt(houseKey: string, followee: string): PendingRelationPush & { readonly sentAt: number | null } | undefined {
    const r = this.db.queryOne<{
      event_id: string; house_key: string; followee_popclaw_id: string;
      seq: string; signed_payload: Uint8Array; house_slug: string | null; sent_at: number | null;
    }>(
      `SELECT event_id, house_key, followee_popclaw_id, CAST(seq AS TEXT) AS seq,
              signed_payload, house_slug, sent_at
         FROM relation_outbox WHERE house_key = ? AND followee_popclaw_id = ?
        ORDER BY seq DESC LIMIT 1`,
      [houseKey, followee],
    );
    if (r === null) return undefined;
    return {
      eventId: r.event_id,
      houseKey: r.house_key,
      followeePopclawId: r.followee_popclaw_id,
      seq: BigInt(r.seq),
      signedPayload: r.signed_payload,
      sentAt: r.sent_at,
      ...(r.house_slug ? { houseSlug: r.house_slug } : {}),
    };
  }

  markSent(eventId: string): void {
    this.db.execute('UPDATE relation_outbox SET sent_at = ? WHERE event_id = ?', [
      this.now(),
      eventId,
    ]);
  }

  /**
   * Raise the verified high-water for this edge.
   *
   * **Only author-verified evidence may reach this.** A house saying "your
   * applied_seq is 3" is a claim; passing that in would let a stale or hostile
   * house steer the next allocation down into the author's own history. What
   * belongs here is a seq read off an event whose author signature and CID this
   * end has checked.
   *
   * It only ever raises. There is no path that resets an edge to 1, because a
   * quiet reset is indistinguishable from deliberate reuse.
   */
  observeVerified(houseKey: string, followee: string, seq: bigint): void {
    this.db.execute(
      `INSERT INTO relation_seq
         (house_key, followee_popclaw_id, reserved, signed, observed, lower_bound_only)
       VALUES (?, ?, 0, 0, ?, 1)
       ON CONFLICT (house_key, followee_popclaw_id)
       DO UPDATE SET observed = MAX(observed, CAST(? AS INTEGER)),
                     -- Sticky once set: it records that history exists which
                     -- this end does not hold, and that never stops being true.
                     lower_bound_only = CASE
                       WHEN CAST(? AS INTEGER) > signed THEN 1
                       ELSE lower_bound_only
                     END`,
      [houseKey, followee, seq.toString(), seq.toString(), seq.toString()],
    );
  }

  /**
   * Re-establish this edge's history through `throughSeq`.
   *
   * The only thing that closes the gap `observeVerified` opens. It is a
   * deliberate, explicit act — a resync that fetched this edge's originals and
   * verified them — and nothing in the ordinary signing path may reach it:
   * reserving, committing a signature and observing evidence all leave it
   * alone, and a house reporting a low number must never arrive here at all.
   *
   * It raises `observed` too, because re-establishing history through N is
   * itself verified knowledge that N exists. It does not touch `signed`: this
   * end knows those originals, it did not produce them.
   */
  markIssuanceRecovered(
    houseKey: string,
    followee: string,
    throughSeq: bigint,
    roundId: string,
  ): void {
    this.db.transaction((tx) => {
      // A callback from a round that has since ended stamps nothing. It did its
      // work honestly, but it was working on a history this identity no longer
      // claims, and letting it sign off on the current round would be the same
      // defect as accepting the backup's own proof.
      const current =
        tx.queryOne<{ round_id: string }>('SELECT round_id FROM identity_round WHERE singleton = 1')
          ?.round_id ?? '';
      if (roundId !== current) return;
      tx.execute(
      `INSERT INTO relation_seq
           (house_key, followee_popclaw_id, reserved, signed, observed,
            lower_bound_only, recovered_through, recovered_ever, recovered_in_round)
         VALUES (?, ?, 0, 0, ?, 0, ?, ?, ?)
         ON CONFLICT (house_key, followee_popclaw_id)
         DO UPDATE SET observed = MAX(observed, CAST(? AS INTEGER)),
                       -- History, and only ever forward.
                       recovered_ever = MAX(recovered_ever, CAST(? AS INTEGER)),
                       -- THIS round's coverage. Forward within a round — a
                       -- later, smaller recovery must not re-open a gap the
                       -- same round already closed — but it starts again when a
                       -- new round stamps it, because a new round has
                       -- re-established nothing yet.
                       recovered_through = CASE
                         WHEN recovered_in_round = ?
                         THEN MAX(recovered_through, CAST(? AS INTEGER))
                         ELSE CAST(? AS INTEGER) END,
                       recovered_in_round = ?`,
        [
          houseKey,
          followee,
          throughSeq.toString(),
          throughSeq.toString(),
          throughSeq.toString(),
          roundId,
          throughSeq.toString(),
          throughSeq.toString(),
          roundId,
          throughSeq.toString(),
          throughSeq.toString(),
          roundId,
        ],
      );
    });
  }

  /**
   * What this end can honestly say about the edge's history.
   *
   * The three counters are returned apart because the one thing this file
   * exists to prevent is a caller collapsing them. `reserved` is this end's own
   * bookkeeping, `signed` is its own work, and only `observed` can carry
   * evidence of someone else — so only `observed` can answer "did another end
   * sign above me". A gate that tested the maximum instead once refused a fresh
   * root forever because it had reserved 1 and crashed before signing it.
   *
   * `authoritative` is false when another end has signed above what this one
   * did: the local counters are then a verified LOWER BOUND, not the whole
   * story. The residual limit worth naming: a restored old backup that has
   * observed nothing cannot detect its own staleness at all — nothing local
   * distinguishes "I am up to date" from "originals exist above me that I have
   * never seen". That is stated here rather than solved; `rootOrigin` is how
   * the caller supplies what this table cannot know.
   */
  bound(houseKey: string, followee: string): EdgeBound {
    const cur = this.row(houseKey, followee);
    return {
      reserved: BigInt(cur.reserved),
      signed: BigInt(cur.signed),
      observed: BigInt(cur.observed),
      lowerBoundOnly: cur.lower_bound_only !== 0,
      recoveredThrough: BigInt(cur.recovered_through),
      recoveredInRound: cur.recovered_in_round ?? undefined,
      recoveredEver: BigInt(cur.recovered_ever),
      historyGapOpen: historyGapOpen(cur),
      high: high(cur),
      // Authority is a fact about history, not a comparison of maxima. A fresh
      // root has signed nothing; an end that once verified signing it did not
      // do never recovers authority by signing something higher.
      authoritative: BigInt(cur.signed) > 0n && !cur.lower_bound_only,
    };
  }
}
