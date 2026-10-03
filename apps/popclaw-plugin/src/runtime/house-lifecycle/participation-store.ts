/**
 * ADR-0051 S2 — per-house participation persistence (HostDb / SQLite).
 *
 * Lifecycle intent and the leave ledger are not deletable caches
 * (ADR-0051 §2). Multiple processes on one data root share this database
 * (WAL + busy_timeout), so every write path carries a CAS condition: a late
 * ACK can only settle ITS OWN request, never overwrite a newer desired/phase.
 *
 * Layout (post S2a review):
 * - house_participation: one row per house, the intent and current
 *   generation. The pending enter (the request reused by same-generation
 *   re-logins) lives on the row; **the leave ledger is a separate table** —
 *   offline logout→login→crash must never drop an unsettled leave.
 * - house_lifecycle_outbox: one row per leave (request_id unique), **pinned
 *   at commit time to the then-current house ack key and installation** —
 *   the retry worker must never trust a later re-keyed board/ACK. Rows settle
 *   independently; confirmed and unsupported are two distinct terminal
 *   states (a legacy house has no trusted ack and never masquerades as
 *   confirmed).
 */

import type { HostDb } from '../../host/host-db.js';

export type Desired = 'enabled' | 'disabled';
export type Phase = 'connecting' | 'connected' | 'reconnecting' | 'disconnecting' | 'disconnected';
export type RemoteStatus = 'none' | 'pending' | 'confirmed' | 'unsupported' | 'error';

export interface ParticipationRow {
  house_origin: string;
  installation_id: string;
  op_seq: number;
  desired: Desired;
  phase: Phase;
  session_id: string;
  house_revision: number;
  /** Server lease deadline (unix secs) for the current session — the
   * connected fastpath must not outlive it. 0 = unknown/expired. */
  lease_expires_at: number;
  /** Latest verified inbox read token minted with the session ack. */
  inbox_read_token: string;
  renew_interval_seconds: number;
  renew_after: number;
  /** House ack public key (hex; empty = unbound/legacy). A key change is
   *   rejected and requires explicit re-confirmation. */
  ack_key_hex: string;
  pending_enter_request_id: string | null;
  remote_status: RemoteStatus;
  remote_error: string;
  updated_at: number;
}

export interface OutboxRow {
  request_id: string;
  house_origin: string;
  op: 'leave';
  op_seq: number;
  /** House ack key pinned at commit time (empty = legacy house, no control plane). */
  ack_key_hex: string;
  installation_id: string;
  created_at: number;
  settled_at: number | null;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS house_participation (
     house_origin              TEXT PRIMARY KEY,
     installation_id           TEXT NOT NULL,
     op_seq                    INTEGER NOT NULL DEFAULT 0,
     desired                   TEXT NOT NULL DEFAULT 'disabled',
     phase                     TEXT NOT NULL DEFAULT 'disconnected',
     session_id                TEXT NOT NULL DEFAULT '',
     house_revision            INTEGER NOT NULL DEFAULT 0,
     lease_expires_at          INTEGER NOT NULL DEFAULT 0,
     inbox_read_token          TEXT NOT NULL DEFAULT '',
     renew_interval_seconds    INTEGER NOT NULL DEFAULT 30,
     renew_after               INTEGER NOT NULL DEFAULT 0,
     ack_key_hex               TEXT NOT NULL DEFAULT '',
     pending_enter_request_id  TEXT,
     remote_status             TEXT NOT NULL DEFAULT 'none',
     remote_error              TEXT NOT NULL DEFAULT '',
     updated_at                INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS house_lifecycle_outbox (
     request_id      TEXT PRIMARY KEY,
     house_origin    TEXT NOT NULL,
     op              TEXT NOT NULL,
     op_seq          INTEGER NOT NULL,
     ack_key_hex     TEXT NOT NULL DEFAULT '',
     installation_id TEXT NOT NULL DEFAULT '',
     created_at      INTEGER NOT NULL,
     settled_at      INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS idx_house_lifecycle_outbox_open
     ON house_lifecycle_outbox (house_origin, settled_at)`,
];

export function ensureHouseLifecycleSchema(db: HostDb): void {
  for (const stmt of SCHEMA_STATEMENTS) db.execute(stmt);
  // Upgrade pre-renewal participation databases without replacing intent.
  db.transaction(tx => {
    const columns = new Set(tx.queryAll<{ name: string }>('PRAGMA table_info(house_participation)').map(c => c.name));
    if (!columns.has('renew_interval_seconds')) tx.execute('ALTER TABLE house_participation ADD COLUMN renew_interval_seconds INTEGER NOT NULL DEFAULT 30');
    if (!columns.has('renew_after')) tx.execute('ALTER TABLE house_participation ADD COLUMN renew_after INTEGER NOT NULL DEFAULT 0');
  });
}

/** Keep retries comfortably inside even a short server lease. */
export function nextRenewalAt(now: number, leaseExpiresAt: number, interval = 30): number {
  return now + Math.max(1, Math.min(Math.max(1, Math.floor(interval)), Math.floor((leaseExpiresAt - now) / 3)));
}

export function readParticipation(db: HostDb, houseOrigin: string): ParticipationRow | null {
  const row = db.queryOne<Record<string, unknown>>(
    'SELECT * FROM house_participation WHERE house_origin = ?',
    [houseOrigin],
  );
  return row ? (row as unknown as ParticipationRow) : null;
}

export function listParticipation(db: HostDb): ParticipationRow[] {
  return db.queryAll<Record<string, unknown>>(
    'SELECT * FROM house_participation ORDER BY house_origin',
  ) as unknown as ParticipationRow[];
}

export function readOutboxRow(db: HostDb, requestId: string): OutboxRow | null {
  const row = db.queryOne<Record<string, unknown>>(
    'SELECT * FROM house_lifecycle_outbox WHERE request_id = ?',
    [requestId],
  );
  return row ? (row as unknown as OutboxRow) : null;
}

export function listOpenOutbox(db: HostDb, houseOrigin?: string): OutboxRow[] {
  const rows = houseOrigin
    ? db.queryAll<Record<string, unknown>>(
        'SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NULL AND house_origin = ? ORDER BY op_seq',
        [houseOrigin],
      )
    : db.queryAll<Record<string, unknown>>(
        'SELECT * FROM house_lifecycle_outbox WHERE settled_at IS NULL ORDER BY house_origin, op_seq',
      );
  return rows as unknown as OutboxRow[];
}

/**
 * Login intent (CAS semantics):
 * - already enabled: a plain repeated login **does not advance op_seq and
 *   sends no new enter** — connected reuses the current generation entirely;
 *   an unsettled pending reuses the same request.
 * - re-login from disabled: allocate a new op_seq and pending enter; the
 *   **leave ledger is untouched** (the outbox settles independently and is
 *   never lost to a re-login).
 */
export function commitLocalLogin(
  db: HostDb,
  houseOrigin: string,
  installationId: string,
  requestId: string,
  now: number,
  /** Trusted discovery result: the control-plane public key ('' = probed
   * legacy). Persisted in the SAME transaction as the intent, BEFORE the
   * ENTER is sent — a lost ack must not lose control capability (else a
   * later logout is misjudged legacy, skips the leave, and strands a live
   * server-side session). */
  discoveredAckKeyHex: string,
  /** Pre-await baseline (review counter-example 1): the login call only
   * commits when the row still matches this snapshot — a logout that landed
   * during discovery/signing aborts the login instead of being re-enabled. */
  expected?: { opSeq: number; desired: 'enabled' | 'disabled' },
): { opSeq: number; mode: 'fresh' | 'reuse-pending' | 'reuse-connected' | 'aborted'; ackKeyHex: string; pendingEnterRequestId: string | null } {
  return db.transaction((tx) => {
    const row = upsert(tx, houseOrigin, installationId, now);
    if (expected && (row.op_seq !== expected.opSeq || row.desired !== expected.desired)) {
      return { opSeq: row.op_seq, mode: 'aborted' as const, ackKeyHex: row.ack_key_hex, pendingEnterRequestId: null };
    }
    if (row.desired === 'enabled') {
      // Lease-aware: a durable "connected" row whose server lease has passed
      // is NOT reused (probe 2) — the client takes the fresh-login path with
      // a new op_seq; the server will not resurrect the dead session.
      if (row.phase === 'connected' && row.session_id && row.lease_expires_at > now) {
        return { opSeq: row.op_seq, mode: 'reuse-connected' as const, ackKeyHex: row.ack_key_hex, pendingEnterRequestId: null };
      }
      if (row.pending_enter_request_id) {
        // Backfill the trusted discovery key missed while an ack was lost.
        if (!row.ack_key_hex && discoveredAckKeyHex) {
          tx.execute('UPDATE house_participation SET ack_key_hex = ? WHERE house_origin = ?', [discoveredAckKeyHex, houseOrigin]);
        }
        // Report the key this transaction actually bound, not the value read
        // before the backfill — same as the fresh path below. The caller uses
        // this to decide whether to verify the manifest, and reading back an
        // empty string made it revoke the house's capability view as
        // `HOUSE_PIN_UNAVAILABLE` in the very round the pin was established.
        const boundKey = row.ack_key_hex || discoveredAckKeyHex;
        return { opSeq: row.op_seq, mode: 'reuse-pending' as const, ackKeyHex: boundKey, pendingEnterRequestId: row.pending_enter_request_id };
      }
    }
    const opSeq = row.op_seq + 1;
    // Key binding is sticky: an existing binding is never overwritten by a
    // new discovery (a key change is an explicit rejection); this round's
    // trusted discovery is written only into an EMPTY binding (first login /
    // previously unknown). The OLD binding is returned for comparison.
    tx.execute(
      `UPDATE house_participation
       SET op_seq = ?, desired = 'enabled', phase = 'connecting', remote_status = 'none', remote_error = '',
           ack_key_hex = CASE WHEN ack_key_hex = '' THEN ? ELSE ack_key_hex END,
           pending_enter_request_id = ?, updated_at = ?
       WHERE house_origin = ?`,
      [opSeq, discoveredAckKeyHex, requestId, now, houseOrigin],
    );
    const boundKey = row.ack_key_hex || discoveredAckKeyHex;
    return { opSeq, mode: 'fresh' as const, ackKeyHex: boundKey, pendingEnterRequestId: requestId };
  });
}

/**
 * Local-first logout: in one transaction, op_seq+1, disabled, and an outbox
 * leave row appended — **pinned to the then-current house ack key and
 * installation** (the retry worker trusts only that pinned key).
 */
export function commitLocalLogout(
  db: HostDb,
  houseOrigin: string,
  installationId: string,
  requestId: string,
  now: number,
  ackKeyHex: string,
): { opSeq: number } {
  return db.transaction((tx) => {
    const row = upsert(tx, houseOrigin, installationId, now);
    const opSeq = row.op_seq + 1;
    // Resolve the trusted key IN the transaction (review follow-up): an
    // existing binding wins; the resolved key (configured pin fills an empty
    // binding) is persisted on the ROW in the same commit — so the outbox pin
    // and the durable binding never diverge, and the worker's unknown-key
    // branch is not relied on to backfill. The binding survives restarts,
    // keeping the original logout's trust binding.
    const resolvedKey = row.ack_key_hex || ackKeyHex;
    tx.execute(
      `UPDATE house_participation
       SET op_seq = ?, desired = 'disabled', phase = 'disconnected', session_id = '',
           pending_enter_request_id = NULL, remote_status = 'pending', remote_error = '',
           ack_key_hex = CASE WHEN ack_key_hex = '' THEN ? ELSE ack_key_hex END,
           updated_at = ?
       WHERE house_origin = ?`,
      [opSeq, ackKeyHex, now, houseOrigin],
    );
    tx.execute(
      `INSERT INTO house_lifecycle_outbox (request_id, house_origin, op, op_seq, ack_key_hex, installation_id, created_at)
       VALUES (?, ?, 'leave', ?, ?, ?, ?)
       ON CONFLICT(request_id) DO NOTHING`,
      [requestId, houseOrigin, opSeq, resolvedKey, installationId, now],
    );
    return { opSeq };
  });
}

/**
 * Enter outcome (CAS): connected is written only while the row is still
 * enabled AND its op_seq matches this request — after another same-root
 * process logged out (larger op_seq), a late enter ack must not revive the
 * house. Returns whether the write actually applied.
 */
export function markEnterOutcome(
  db: HostDb,
  houseOrigin: string,
  opSeq: number,
  outcome: {
    sessionId: string;
    houseRevision: number;
    phase: Phase;
    ackKeyHex: string;
    /** Lease deadline + read token from the verified ack (persisted so the
     * connected fastpath can lease-check and later roots can read the
     * private stream without re-entering). */
    leaseExpiresAt?: number;
    inboxReadToken?: string;
    renewIntervalSeconds?: number;
    now: number;
  },
): boolean {
  const res = db.execute(
    `UPDATE house_participation
     SET session_id = ?, house_revision = ?, phase = ?, ack_key_hex = ?,
         lease_expires_at = ?, inbox_read_token = ?, renew_interval_seconds = ?, renew_after = ?,
         pending_enter_request_id = NULL, remote_status = 'confirmed', remote_error = '',
         updated_at = ?
     WHERE house_origin = ? AND desired = 'enabled' AND op_seq = ?`,
    [
      outcome.sessionId,
      outcome.houseRevision,
      outcome.phase,
      outcome.ackKeyHex,
      outcome.leaseExpiresAt ?? 0,
      outcome.inboxReadToken ?? '',
      outcome.renewIntervalSeconds ?? 30,
      nextRenewalAt(outcome.now, outcome.leaseExpiresAt ?? 0, outcome.renewIntervalSeconds),
      outcome.now,
      houseOrigin,
      opSeq,
    ],
  );
  return res.changes > 0;
}

/**
 * Enter failure/untrusted. Same CAS (enabled + same seq) plus two review
 * refinements:
 * - `settled` (a VERIFIED rejection — the request got a definitive answer):
 *   also clears the pending enter, so an explicit retry takes a NEW
 *   request/seq instead of replaying a decided BUSY forever. Network
 *   failures keep the pending (the request is undecided; a retry may still
 *   re-deliver the same semantics).
 * - The WHERE pins `pending_enter_request_id IS NOT NULL`: once a duplicate
 *   same-seq ENTER succeeded (the outcome cleared the pending), a LATE
 *   network failure from its twin cannot demote connected back to
 *   connecting.
 */
/**
 * Put a legacy lane back the way an explicit login found it.
 *
 * A house with no `house_session` board has no control plane, and saying so
 * is correct. Taking its working lane away in order to say it is not: the
 * login allocates a new op_seq and writes `phase='connecting'`, the gate reads
 * that row and closes, and nothing puts it back — the resident's re-seed pass
 * is `INSERT … ON CONFLICT DO NOTHING`, so it cannot repair a row that
 * already exists. Every configured house starts in exactly this shape, and
 * both deployed houses serve no board, so one login used to end their
 * streams permanently.
 *
 * `remote_status` keeps the honest verdict: the control plane IS unsupported.
 * Only the phase goes back, so what the owner is told and what the house can
 * still do stop contradicting each other.
 *
 * CAS on `desired = 'enabled'` and this round's op_seq: a logout that landed
 * while the manifest was in flight leaves the house closed, and this can
 * never revive it.
 */
export function restoreLegacyLane(
  db: HostDb,
  houseOrigin: string,
  opSeq: number,
  now: number,
): void {
  db.execute(
    `UPDATE house_participation
     SET phase = 'connected', session_id = '', pending_enter_request_id = NULL, updated_at = ?
     WHERE house_origin = ? AND desired = 'enabled' AND op_seq = ? AND session_id = ''`,
    [now, houseOrigin, opSeq],
  );
}

export function markEnterFailure(
  db: HostDb,
  houseOrigin: string,
  opSeq: number,
  remoteStatus: 'error' | 'unsupported',
  error: string,
  now: number,
  settled = false,
): void {
  db.execute(
    `UPDATE house_participation
     SET phase = 'connecting', remote_status = ?, remote_error = ?,
         pending_enter_request_id = CASE WHEN ? THEN NULL ELSE pending_enter_request_id END,
         updated_at = ?
     WHERE house_origin = ? AND desired = 'enabled' AND op_seq = ?
       AND pending_enter_request_id IS NOT NULL`,
    [remoteStatus, error, settled ? 1 : 0, now, houseOrigin, opSeq],
  );
}

/**
 * Settle ONE leave outbox row (only its own):
 * - 'confirmed': a trusted ack verified under the PINNED key
 *   (CLOSED/ALREADY_CLOSED/SUPERSEDED).
 * - 'unsupported': the house had no control plane when this leave was
 *   committed (legacy) — the semantic endpoint is "the remote lacks this
 *   capability", NOT "the remote confirmed". Two distinct terminal states.
 */
export function settleOutboxRow(
  db: HostDb,
  requestId: string,
  mode: 'confirmed' | 'unsupported',
  now: number,
): void {
  db.transaction((tx) => {
    const row = tx.queryOne<{ house_origin: string }>(
      'SELECT house_origin FROM house_lifecycle_outbox WHERE request_id = ?',
      [requestId],
    );
    if (!row) return;
    tx.execute(
      'UPDATE house_lifecycle_outbox SET settled_at = ? WHERE request_id = ?',
      [now, requestId],
    );
    if (mode === 'unsupported') {
      tx.execute(
        `UPDATE house_participation SET remote_status = 'unsupported', updated_at = ?
         WHERE house_origin = ? AND desired = 'disabled' AND remote_status = 'pending'`,
        [now, row.house_origin],
      );
    } else {
      refreshRemoteStatus(tx);
    }
  });
}

/**
 * remote_status of disabled rows: any unsettled leave => pending; otherwise
 * pending flips to confirmed. **unsupported is a sticky terminal state** —
 * it never participates in the pending↔confirmed derivation; a legacy
 * house's logout never masquerades as a trusted ack.
 */
function refreshRemoteStatus(tx: HostDb): void {
  const rows = tx.queryAll<{ house_origin: string }>(
    `SELECT DISTINCT house_origin FROM house_lifecycle_outbox WHERE settled_at IS NULL`,
  );
  const openHouses = new Set(rows.map((r) => r.house_origin));
  tx.execute(
    `UPDATE house_participation SET remote_status = 'confirmed'
     WHERE desired = 'disabled' AND remote_status = 'pending'`,
  );
  for (const origin of openHouses) {
    tx.execute(
      `UPDATE house_participation SET remote_status = 'pending'
       WHERE house_origin = ? AND desired = 'disabled'`,
      [origin],
    );
  }
}

function upsert(tx: HostDb, houseOrigin: string, installationId: string, now: number): ParticipationRow {
  tx.execute(
    `INSERT INTO house_participation (house_origin, installation_id, op_seq, desired, phase, updated_at)
     VALUES (?, ?, 0, 'disabled', 'disconnected', ?)
     ON CONFLICT(house_origin) DO NOTHING`,
    [houseOrigin, installationId, now],
  );
  return readParticipation(tx, houseOrigin)!;
}
