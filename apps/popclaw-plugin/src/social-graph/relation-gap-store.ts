/**
 * The durable gap marker for a house whose stream cursor was reset —
 * "this house's relation projection is unknown since the house said so".
 *
 * `relation_edges` are deliberately NOT touched by a reset: the safe half of
 * the contract is that nothing clears author-proven relations (an
 * edge missing from a snapshot is not a deletion). What a reset invalidates is
 * the COMPLETENESS of what this end has seen, and that is a fact about the
 * reading position, not about any edge. This table is where that fact lives
 * until the recovery consumer has reconciled a snapshot checkpoint and clears
 * it.
 *
 * Writers: the reset handler marks; the recovery consumer (the slice that
 * pages /v1/relation-snapshot and re-verifies evidence through the ordinary
 * commit boundary) is the ONLY thing that clears. Readers: the resume path
 * (a gap suppresses the dead cursor so reconnects stop re-earning the reset)
 * and anyone reporting reconciliation state.
 */
import type { HostDb } from '../host/host-db.js';

export interface RelationStreamGap {
  readonly houseKey: string;
  readonly incarnation: string;
  readonly reason: string;
  readonly logGeneration: string;
  readonly floor: string;
  readonly markedAt: number;
}

/** What the reset handler hands `mark`: the house's word plus a timestamp. */
export interface MarkGapInput {
  readonly houseKey: string;
  readonly incarnation: string;
  readonly reason: string;
  readonly logGeneration: string;
  readonly floor: string;
  /** Unix seconds — the moment this end heard the reset. */
  readonly at: number;
}

export class RelationGapStore {
  constructor(private readonly db: HostDb) {}

  /**
   * Record (or update) the gap for one (house, incarnation). Idempotent for
   * the same reset; a NEWER reset — a higher log generation, or the same
   * generation with a higher floor — overwrites, because what must be
   * reconciled is the deepest hole. An older reset arriving after a newer one
   * changes nothing.
   */
  mark(gap: MarkGapInput): void {
    this.db.execute(
      `INSERT INTO relation_stream_gaps
         (house_key, incarnation, reason, log_generation, floor, marked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(house_key, incarnation) DO UPDATE SET
         reason = excluded.reason,
         log_generation = excluded.log_generation,
         floor = excluded.floor,
         marked_at = excluded.marked_at
       WHERE CAST(excluded.log_generation AS INTEGER) > CAST(relation_stream_gaps.log_generation AS INTEGER)
          OR (CAST(excluded.log_generation AS INTEGER) = CAST(relation_stream_gaps.log_generation AS INTEGER)
              AND CAST(excluded.floor AS INTEGER) > CAST(relation_stream_gaps.floor AS INTEGER))`,
      [gap.houseKey, gap.incarnation, gap.reason, gap.logGeneration, gap.floor, gap.at],
    );
  }

  /** The open gap for exactly this (house, incarnation), or undefined. */
  openFor(houseKey: string, incarnation: string): RelationStreamGap | undefined {
    const row = this.db.queryOne<{
      house_key: string;
      incarnation: string;
      reason: string;
      log_generation: string;
      floor: string;
      marked_at: number;
    }>(
      'SELECT * FROM relation_stream_gaps WHERE house_key = ? AND incarnation = ?',
      [houseKey, incarnation],
    );
    return row
      ? {
          houseKey: row.house_key,
          incarnation: row.incarnation,
          reason: row.reason,
          logGeneration: row.log_generation,
          floor: row.floor,
          markedAt: row.marked_at,
        }
      : undefined;
  }

  /**
   * Close the gap. The recovery consumer's move ONLY: a checkpoint has been
   * reconciled, so the projection behind the cursor is complete again and the
   * resume read may carry a position. Returns whether a gap was open.
   */
  clear(houseKey: string, incarnation: string): boolean {
    return (
      this.db.execute(
        'DELETE FROM relation_stream_gaps WHERE house_key = ? AND incarnation = ?',
        [houseKey, incarnation],
      ).changes > 0
    );
  }

  /**
   * The completion transaction: adopt the reconciled cursor and
   * close the gap as ONE atomic step, and only if the gap is STILL the one
   * this recovery set out to pay. A newer reset landing mid-recovery — G5's
   * sweep parked, the owner logged out, G6's reset marked a deeper hole —
   * makes the old checkpoint's watermark describe a world that has moved on;
   * adopting it or clearing the NEW gap on G5's say-so is exactly the race.
   *
   * `superseded` leaves everything alone: the newer gap stands, no cursor is
   * written, and the next sweep reconciles against the world that now is.
   * `writeCursor` runs INSIDE the transaction so the adopt and the clear
   * land together or not at all.
   */
  completeIfUnchanged(
    houseKey: string,
    incarnation: string,
    expected: { readonly logGeneration: string; readonly floor: string },
    writeCursor: (tx: HostDb) => void,
    verify?: (tx: HostDb) => boolean,
  ): 'completed' | 'superseded' | 'no-gap' | 'unauthorized' {
    return this.db.transaction((tx) => {
      const row = tx.queryOne<{ log_generation: string; floor: string }>(
        'SELECT log_generation, floor FROM relation_stream_gaps WHERE house_key = ? AND incarnation = ?',
        [houseKey, incarnation],
      );
      if (row === undefined || row === null) return 'no-gap' as const;
      if (row.log_generation !== expected.logGeneration || row.floor !== expected.floor) {
        return 'superseded' as const;
      }
      // The CURRENT authorization, checked INSIDE the completion transaction:
      // a logout or a pin block landing in another
      // process while an empty-complete page was in flight must stop the
      // cursor write and the clear even though the gap itself never moved.
      if (verify !== undefined && !verify(tx)) return 'unauthorized' as const;
      writeCursor(tx);
      tx.execute('DELETE FROM relation_stream_gaps WHERE house_key = ? AND incarnation = ?', [
        houseKey,
        incarnation,
      ]);
      return 'completed' as const;
    });
  }
}
