/**
 * ADR-0051 S2b — the same-root lifecycle OWNER lease.
 *
 * The resident coordinator per data root is ONE process; the others (CLI
 * one-shots, second host processes) submit through it. Ownership is a
 * PERSISTENT fact with a generation, not a cached boolean:
 *
 * - Every authority check reads the ROW (isOwnerNow), never a local cache —
 *   a SIGSTOPped process that resumes after its TTL expiry finds a new
 *   generation in the row and can no longer commit (review: DutyLease's
 *   isHeld() is a cache; a stalled process misreads itself as holder until
 *   the next timer tick).
 * - Takeover bumps `generation`; captured owner generations (like captured
 *   gates) are compared on every await return and before every final
 *   outbound write — an old PID resumed after a takeover sees a mismatched
 *   generation and aborts instead of committing.
 * - Single-row SQLite table, TTL expiry, polling renewal at TTL/3 — the
 *   DutyLease shape, but with the read-your-write discipline the lifecycle
 *   needs (that lease stays for world-feed ingest duty; this one is for
 *   lifecycle ownership).
 */

import { storageDatabasePathAllowed } from '../../host/storage-maintenance.js';
import type { HostDb } from '../../host/host-db.js';

export interface OwnerRow {
  readonly generation: number;
  readonly holder: string;
  readonly renewed_at: number;
}

export interface OwnerLeaseOptions {
  readonly db: HostDb;
  readonly token: string;
  readonly ttlMs: number;
  readonly now?: () => number;
}

const SCHEMA =
  'CREATE TABLE IF NOT EXISTS house_lifecycle_owner (\n' +
  '  id INTEGER PRIMARY KEY CHECK (id = 1),\n' +
  '  generation INTEGER NOT NULL,\n' +
  '  holder TEXT NOT NULL,\n' +
  '  renewed_at INTEGER NOT NULL\n' +
  ')';

export class OwnerLease {
  private readonly db: HostDb;
  private readonly token: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastKnownGeneration: number | null = null;
  /** The last OWNER GENERATION we told the callbacks about (edge detection
   * for onAcquired/onLost — a generation, not a boolean, so a same-holder
   * epoch advance is visible). Authority itself is always read from the row. */
  private notifiedGeneration: number | null = null;

  constructor(opts: OwnerLeaseOptions) {
    this.db = opts.db;
    this.token = opts.token;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? (() => Date.now());
    this.db.execute(SCHEMA);
  }

  /**
   * Claim or renew ownership. true = this process owns the lifecycle NOW.
   * Takeover cases (nobody held, or the previous holder's TTL expired) bump
   * the generation so every captured generation in any process dies.
   */
  tryAcquire(): boolean {
    if (!storageDatabasePathAllowed(this.db, 'execution')) return false;
    const t = this.now();
    const expiryCutoff = t - this.ttlMs;
    // Renewal keeps the generation ONLY when it is a LIVE renewal: same
    // holder AND the previous lease had not expired. A same-token
    // reacquisition after TTL expiry (or after release() expires the row) is
    // a takeover of a DEAD lease — the generation must advance so old
    // captured generations stay dead (review probes 1+2).
    const changes = this.db.execute(
      `INSERT INTO house_lifecycle_owner (id, generation, holder, renewed_at)
       VALUES (1, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         holder = excluded.holder,
         renewed_at = excluded.renewed_at,
         generation = CASE
           WHEN house_lifecycle_owner.holder = excluded.holder
                AND house_lifecycle_owner.renewed_at >= ?
             THEN house_lifecycle_owner.generation
           ELSE house_lifecycle_owner.generation + 1
         END
       WHERE house_lifecycle_owner.holder = excluded.holder
          OR house_lifecycle_owner.renewed_at < ?`,
      [this.token, t, expiryCutoff, expiryCutoff],
    ).changes;
    if (changes === 1) {
      this.lastKnownGeneration = this.readRow()?.generation ?? null;
      return true;
    }
    return false;
  }

  /**
   * AUTHORITATIVE ownership check — reads the row, never a cache. A process
   * that stalled past its TTL sees the new holder here even before its
   * renewal timer fires.
   */
  isOwnerNow(): boolean {
    if (!storageDatabasePathAllowed(this.db, 'execution')) return false;
    const row = this.readRow();
    return row?.holder === this.token && row.renewed_at >= this.now() - this.ttlMs;
  }

  /**
   * Whether THIS process's captured generation is still the owner's current
   * one. Called on every await return and before every final outbound write:
   * a resumed-after-takeover process aborts instead of committing.
   */
  isGenerationCurrent(captured: number): boolean {
    if (!storageDatabasePathAllowed(this.db, 'execution')) return false;
    const row = this.readRow();
    return row?.holder === this.token && row.generation === captured && row.renewed_at >= this.now() - this.ttlMs;
  }

  /** The current owner generation as persisted (null = no owner row). */
  currentGeneration(): number | null {
    return this.readRow()?.generation ?? null;
  }

  /** The generation this process last knew (for capture at start-of-work). */
  knownGeneration(): number | null {
    return this.lastKnownGeneration;
  }

  /**
   * Polling renewal at TTL/3. Losing ownership (stall past TTL + takeover)
   * fires onLost so the caller tears its coordinator work down; regaining
   * fires onAcquired. A SAME-HOLDER reacquisition whose EPOCH advanced (the
   * single-holder stall case: TTL expired, nobody else took over, the next
   * renewal reacquires at generation+1) fires onLost THEN onAcquired — the
   * old epoch's captured resources must be torn down and rebuilt even though
   * ownership never changed hands (review probe: a boolean notified flag
   * cannot express "still mine, but a new epoch").
   */
  start(cb: { onAcquired?: () => void; onLost?: () => void } = {}): void {
    if (this.timer) return;
    // Seed the edge from the CURRENT truth so a takeover that already
    // happened before start() still notifies exactly once.
    this.notifiedGeneration = this.isOwnerNow() ? this.currentGeneration() : null;
    this.timer = setInterval(() => {
      // Authority: tryAcquire attempts renewal and reports this tick's
      // truth; the NOTIFICATION edge compares against the last generation we
      // told the callbacks about (review probe 3: comparing two fresh reads
      // after a takeover yields false/false and never fires; the epoch probe:
      // a boolean cannot see a same-holder generation advance).
      const ownerNow = this.tryAcquire();
      if (ownerNow) {
        const gen = this.currentGeneration();
        if (gen !== this.notifiedGeneration) {
          // Epoch changed while (nominally) held — including the very first
          // acquisition (notifiedGeneration === null → only onAcquired).
          if (this.notifiedGeneration !== null) cb.onLost?.();
          cb.onAcquired?.();
          this.notifiedGeneration = gen;
        }
      } else if (this.notifiedGeneration !== null) {
        this.notifiedGeneration = null;
        cb.onLost?.();
      }
    }, Math.max(1000, Math.floor(this.ttlMs / 3)));
    this.timer.unref?.();
  }

  /** Stop renewing and hand ownership back (next taker bumps the generation). */
  release(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Hand back by EXPIRING our row (bump the generation so any captured
    // generation dies immediately — a plain DELETE lets the next taker's
    // INSERT land at generation 1 and resurrect stale captured generations).
    this.db.execute(
      'UPDATE house_lifecycle_owner SET renewed_at = ? WHERE id = 1 AND holder = ?',
      [this.now() - this.ttlMs - 1, this.token],
    );
    this.lastKnownGeneration = null;
    this.notifiedGeneration = null;
  }

  private readRow(): OwnerRow | null {
    const row = this.db.queryOne<{ generation: number; holder: string; renewed_at: number }>(
      'SELECT generation, holder, renewed_at FROM house_lifecycle_owner WHERE id = 1',
    );
    return row ?? null;
  }
}
