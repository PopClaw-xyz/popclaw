/**
 * The DM half of the reliable reception boundary.
 *
 * `makeDmEnqueueWork` is the in-transaction consumer: a verified DM on the
 * personal stream records a DELIVERY's execution eligibility — one row per
 * (event, house, generation) — and nothing slow happens inside the commit.
 * `drainDmTodos` is the slow half: one frame at a time, outside any
 * transaction, under the session that received it, calling the root's
 * existing DM business code.
 *
 * Two distinctions the table's shape exists to keep apart:
 *
 * - **Event dedup is not delivery eligibility.** The bytes exist once
 *   (inbound_frames, and the chat inbox's own event gate); whether a
 *   TRUSTED delivery may still do the slow work is per (house, generation).
 *   The owner logging out with work pending ends that delivery's standing —
 *   it does not swallow the same bytes when a relogin or another authorized
 *   house legitimately delivers them: those get their own rows.
 * - **A failed attempt is not a completed one.** A transient failure (the
 *   inbox write hiccuped) leaves the row recoverable, retried by the
 *   ordinary drain schedule, bounded by an attempt cap that settles into a
 *   visible dead letter rather than retrying forever.
 *
 * What this buys is the contract, not a new DM platform: slow attachments no
 * longer hold a database lock inside the reception transaction, the relation
 * cursor cannot skip past a DM that was not recorded (one cursor, one
 * transaction), and a departed generation's mail produces no business effect
 * — its rows are selected by nobody.
 */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import { verifyInboundEnvelope } from '../ingress/verify-envelope.js';
import type { EnqueueOutcome, EnqueueWork, TrustedSource } from '../ingress/inbound-commit.js';

export interface DmQueueDeps {
  readonly recipientPopclawId: string;
  readonly now?: () => number;
}

/**
 * The queue's commit executor: ONE synchronous BEGIN IMMEDIATE transaction
 * that re-verifies the execution right, runs the caller's business write,
 * and settles — together, or not at all.
 *
 * Constraints (C-BIZ): fn must be synchronous (a thenable is refused, not
 * awaited); the executor is single-use; the tx it hands fn is scoped to the
 * call and dead afterwards. A refusal before fn means fn was NEVER called
 * and the row stays exactly as it was.
 */
export interface CommitExecutor {
  <T>(fn: (tx: HostDb) => T): { committed: boolean; value?: T };
}

/** A claim older than this is a dead process's; the row is reclaimable. */
const CLAIM_STALE_SECS = 60;

/** Record a delivery's eligibility; verdicts for everything else are not this consumer's. */
export function makeDmEnqueueWork(deps: DmQueueDeps): EnqueueWork {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  return (tx, frame): EnqueueOutcome => {
    if (frame.stream !== 'personal') {
      return { status: 'not-applicable', reason: 'not the personal stream' };
    }
    let env: popclaw.event.EventEnvelope;
    try {
      env = verifyInboundEnvelope(frame.envelopeBytes, {
        recipientPopclawId: deps.recipientPopclawId,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { status: 'refused', reason };
    }
    if (!env.directMessage) {
      // Not this consumer's mail — the relation consumer (or a future one)
      // decides. Declining jurisdiction writes nothing and vetoes nothing.
      return { status: 'not-applicable', reason: 'not a DM' };
    }
    // One row per delivery. A same-source redelivery is a no-op (already
    // eligible or already done); a NEW trusted delivery — relogin, another
    // house — inserts its own row and is not swallowed by the old one.
    tx.execute(
      `INSERT OR IGNORE INTO dm_inbound_todo
         (event_id, house_key, incarnation, owner_generation, position, queued_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        frame.eventId,
        frame.source.houseKey,
        frame.source.incarnation,
        frame.source.ownerGeneration,
        frame.position ?? null,
        now(),
      ],
    );
    return { status: 'accepted' };
  };
}

interface TodoWithBytes {
  readonly event_id: string;
  readonly house_key: string;
  readonly incarnation: string;
  readonly owner_generation: number;
  readonly attempts: number;
  readonly envelope: Uint8Array;
}

/**
 * Take the execution right for one row — atomically, with a fresh token and
 * a participation re-check in the same conditional UPDATE.
 *
 * The participation check is not decoration: the caller's source list is a
 * snapshot, and a logout or relogin that landed after it must stop the claim
 * itself, not merely a later drain round. `changes === 0` means someone else
 * holds the claim, the row is done, or the participation moved — in every
 * case, not this caller's to do.
 */
/** Thrown inside commit for a RIGHT that no longer holds — rolls the
 * transaction back WITHOUT taking the caller's error path. */
class NotCommitted extends Error {}

/** Fence tokens need uniqueness, not secrecy — a local counter plus the
 * claim timestamp cannot collide between processes on one data root within
 * the claim window, and Math.random breaks same-tick ties. */
let claimCounter = 0;
function newClaimToken(at: number): string {
  claimCounter += 1;
  return `${at}-${claimCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

function claimTodo(
  db: HostDb,
  row: { event_id: string; house_key: string; owner_generation: number },
  now: () => number,
): string | undefined {
  const at = now();
  const token = newClaimToken(at);
  const res = db.execute(
    `UPDATE dm_inbound_todo
        SET claimed_at = ?, claim_token = ?
      WHERE event_id = ? AND house_key = ? AND owner_generation = ?
        AND drained_at IS NULL
        AND (claimed_at IS NULL OR claimed_at < ?)
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
        AND EXISTS (
          SELECT 1 FROM relation_participation p
           WHERE p.house_key = ? AND p.active = 1 AND p.owner_generation = ?
        )`,
    [at, token, row.event_id, row.house_key, row.owner_generation, at - CLAIM_STALE_SECS, at, row.house_key, row.owner_generation],
  );
  return res.changes === 1 ? token : undefined;
}

/**
 * Settle the claim this token holds: handed over, or failed (recoverable, or
 * dead-letter). A CAS on the token — an executor whose stale claim was taken
 * over settles nothing, not the new claimant's row and not the counts.
 */
function settleTodo(
  db: HostDb,
  row: { event_id: string; house_key: string; owner_generation: number; attempts: number },
  token: string,
  outcome: { ok: true } | { ok: false; error: string },
  now: () => number,
): boolean {
  if (outcome.ok) {
    const res = db.execute(
      `UPDATE dm_inbound_todo
          SET drained_at = ?, failed = NULL, claimed_at = NULL, claim_token = NULL,
              attempts = attempts + 1, next_retry_at = NULL
        WHERE event_id = ? AND house_key = ? AND owner_generation = ? AND claim_token = ?`,
      [now(), row.event_id, row.house_key, row.owner_generation, token],
    );
    return res.changes === 1;
  }
  // The backoff is computed from the CURRENT row's attempts, inside the same
  // UPDATE — a row selected before another claimant's failure settle must not
  // schedule its next retry from a stale count.
  const res = db.execute(
    `UPDATE dm_inbound_todo
        SET attempts = attempts + 1, failed = ?, claimed_at = NULL, claim_token = NULL,
            next_retry_at = ? + CASE attempts + 1
              WHEN 1 THEN 60 WHEN 2 THEN 120 WHEN 3 THEN 240 WHEN 4 THEN 480
              WHEN 5 THEN 960 ELSE 3600 END
      WHERE event_id = ? AND house_key = ? AND owner_generation = ? AND claim_token = ?`,
    [outcome.error, now(), row.event_id, row.house_key, row.owner_generation, token],
  );
  return res.changes === 1;
}

export interface DmDrainResult {
  readonly eventId: string;
  readonly ok: boolean;
  readonly settled?: 'drained';
  readonly error?: string;
}

/**
 * Do the slow DM work for the sessions that are still live.
 *
 * `process` is the root's DM business code, called with the raw envelope
 * bytes OUTSIDE any transaction — slow work may not hold a database lock. A
 * throw is a transient failure: the row stays recoverable (attempts + 1,
 * the failure recorded for observability) and the ordinary schedule retries
 * it, until the cap settles it as a visible dead letter. Nothing here revives
 * a departed generation: only rows matching a LIVE source are selected.
 */
export function drainDmTodos(
  db: HostDb,
  sources: readonly TrustedSource[],
  process: (
    envelopeBytes: Uint8Array,
    source: TrustedSource,
    commit: CommitExecutor,
  ) => void,
  limit = 50,
  now: () => number = () => Math.floor(Date.now() / 1000),
): DmDrainResult[] {
  const results: DmDrainResult[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const pair = `${source.houseKey}\0${source.ownerGeneration}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    const at = now();
    const rows = db.queryAll<TodoWithBytes>(
      `SELECT t.event_id, t.house_key, t.incarnation, t.owner_generation, t.attempts, f.envelope
         FROM dm_inbound_todo t
         JOIN inbound_frames f ON f.event_id = t.event_id
        WHERE t.drained_at IS NULL
          AND (t.next_retry_at IS NULL OR t.next_retry_at <= ?)
          AND t.house_key = ? AND t.owner_generation = ?
        ORDER BY t.rowid LIMIT ?`,
      [at, source.houseKey, source.ownerGeneration, limit],
    );
    for (const row of rows) {
      const todoSource: TrustedSource = {
        houseKey: row.house_key,
        incarnation: row.incarnation,
        ownerGeneration: row.owner_generation,
      };
      // An active participation is not a right to consume, and the snapshot
      // this list came from is already old: the claim re-checks participation
      // atomically and mints this attempt's own token. Only the winner runs.
      const token = claimTodo(db, row, now);
      if (token === undefined) continue;
      let committed = false;
      let commitUsed = false;
      // Expires when the processor's call ends (return or throw) — distinct
      // from `commitUsed`: a FIRST late call after the processor returned is
      // refused even though it was never used. A saved executor is not a
      // lease on the row.
      let commitExpired = false;
      // One transaction per row: the right re-verified live, then the
      // caller's business write, then the settle — together or not at all.
      // Single-use BY THE GUARD, not by convention: a saved executor called
      // again is a no-op refusal. The tx handed to fn is a scoped facade —
      // query/execute only, dead after the transaction ends — so a saved
      // handle cannot write after a rollback (the raw connection never
      // leaves this closure).
      const commit: CommitExecutor = <T>(fn: (tx: HostDb) => T) => {
        if (commitUsed || commitExpired) return { committed: false };
        commitUsed = true;
        try {
          const out = db.transaction((rawTx) => {
            // The scoped facade: reads and writes only, and dead the moment
            // this transaction ends (its `live` flag flips in the finally).
            let live = true;
            const tx: HostDb = {
              queryOne: (sql, params) => {
                if (!live) throw new Error('commit tx used after its transaction ended');
                return rawTx.queryOne(sql, params);
              },
              queryAll: (sql, params) => {
                if (!live) throw new Error('commit tx used after its transaction ended');
                return rawTx.queryAll(sql, params);
              },
              execute: (sql, params) => {
                if (!live) throw new Error('commit tx used after its transaction ended');
                return rawTx.execute(sql, params);
              },
              transaction: (inner) => {
                if (!live) throw new Error('commit tx used after its transaction ended');
                // The nested callback gets the SAME scoped facade, not the
                // raw connection: `tx.transaction(raw => saved = raw)` must
                // not re-escape. (The facade handed down here is a fresh
                // wrapper sharing this transaction's liveness — nested saves
                // die with the same end.)
                return rawTx.transaction((_nestedRaw) => {
                  if (!live) throw new Error('commit tx used after its transaction ended');
                  return inner(tx);
                });
              },
            } as HostDb;
            try {
            const stillOurs = tx.queryOne<{ x: number }>(
              `SELECT 1 AS x FROM dm_inbound_todo
                WHERE event_id = ? AND house_key = ? AND owner_generation = ?
                  AND claim_token = ? AND drained_at IS NULL`,
              [row.event_id, row.house_key, row.owner_generation, token],
            );
            if (stillOurs === null) {
              throw new NotCommitted('execution right lost before the business write');
            }
            const part = tx.queryOne<{ owner_generation: number; active: number }>(
              'SELECT owner_generation, active FROM relation_participation WHERE house_key = ?',
              [row.house_key],
            );
            if (part === null || part.active !== 1 || part.owner_generation !== row.owner_generation) {
              throw new NotCommitted('participation ended before the business write');
            }
            const value = fn(tx);
            if (
              value !== null &&
              typeof value === 'object' &&
              typeof (value as { then?: unknown }).then === 'function'
            ) {
              throw new Error('commit(fn): fn returned a thenable — the business write must be synchronous');
            }
              // The settle is part of THIS transaction: a missed settle CAS
              // takes the business write down with it (536 §1) — never a
              // committed business effect with an unsettled row.
              const settledHere = settleTodo(tx, row, token, { ok: true }, now);
              if (!settledHere) {
                throw new NotCommitted('settle missed inside the business transaction');
              }
              return value;
            } finally {
              live = false; // the facade dies with its transaction
            }
          });
          committed = true;
          return { committed: true, value: out as T };
        } catch (err) {
          if (!(err instanceof NotCommitted)) throw err;
          return { committed: false };
        }
      };
      // The processor's authority ends with the processor: a commit SAVED
      // but never called is dead the moment process returns — the executor's
      // expiry guard flips here, before the receipt is written.
      try {
        const returned = process(row.envelope, todoSource, commit) as unknown;
        commitExpired = true;
        // An ASYNC processor cannot satisfy this contract, and the failure is
        // invisible: the call returns at its first await, authority is revoked
        // while the real work is still queued, and the row then reads exactly
        // like a caller that chose not to commit. `=> void` does not stop one
        // being passed — a Promise is a valid void expression — so say it here
        // instead of losing the message quietly. The hand-over is persisted
        // synchronously; the slow part belongs to the consumer, after it.
        if (typeof (returned as { then?: unknown } | null)?.then === 'function') {
          void Promise.resolve(returned).catch(() => undefined); // never an unhandled rejection
          const error =
            'DM_PROCESSOR_MUST_BE_SYNCHRONOUS: the processor returned a promise, so its commit ' +
            'authority expired before the work ran; persist the hand-over synchronously and do ' +
            'the slow part on the drain';
          const settled = settleTodo(db, row, token, { ok: false, error }, now);
          results.push(
            settled
              ? { eventId: row.event_id, ok: false, error }
              : { eventId: row.event_id, ok: false, error: `execution right lost before settle (work failed: ${error})` },
          );
          continue;
        }
        results.push(
          committed
            ? { eventId: row.event_id, ok: true, settled: 'drained' }
            // The caller never committed: no business hand-over, no settle —
            // and no auto-success either.
            : { eventId: row.event_id, ok: false, error: 'not committed (no business hand-over)' },
        );
      } catch (err) {
        commitExpired = true;
        const error = err instanceof Error ? err.message : String(err);
        if (committed) {
          // The business write LANDED and the row is settled; what threw is a
          // POST-COMMIT failure. Reporting it as failed work would invert the
          // facts (and a failure settle here would just miss) — the receipt
          // keeps the delivery and names what failed after it.
          results.push({
            eventId: row.event_id,
            ok: true,
            settled: 'drained',
            error: `delivered; post-commit step failed: ${error}`,
          });
          continue;
        }
        // The business write FAILED (threw before or inside commit): the
        // failure settle is its own small transaction — the claim is
        // released, the backoff is written, nothing was handed over.
        const settled = settleTodo(db, row, token, { ok: false, error }, now);
        results.push(
          settled
            ? { eventId: row.event_id, ok: false, error }
            : { eventId: row.event_id, ok: false, error: `execution right lost before settle (work failed: ${error})` },
        );
      }
    }
  }
  return results;
}
