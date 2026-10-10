import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';

type Consumer = 'content' | 'task';
type GapReason = 'unknown_scope' | 'cursor_ahead' | 'log_incarnation_changed' | 'history_pruned';
type UInt64 = popclaw.world.IScopeCursor['afterSeq'];
interface BindingRow {
  log_incarnation: string | null; generation: string | null; sealed_h: string | null;
  checkpoint_h: string | null; last_frame_seq: string | null; requested_scopes: string;
  replay_complete: number; stale: number; gap_reason: GapReason | null;
}
interface CursorRow { scope_id: string; after_seq: string }
export interface ScopedPendingEvent {
  eventId: string;
  envelope: Uint8Array;
  /** First durable canonical frame; its projection is relay data, not author authority. */
  frameBytes: Uint8Array;
}
export interface ScopedJournalStatus {
  logIncarnation: string | null;
  sealedHighWater: string | null;
  stale: boolean;
  gapReason: GapReason | null;
  /** Replay evidence only. Business readiness also needs a current trusted snapshot. */
  caughtUp: boolean;
}
export type ValidateScopedEnvelope = (rawBytes: Uint8Array) => { eventId: string; publicScopes: readonly string[] };

function uint64(value: UInt64): string {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('UINT64_INVALID');
  const text = value == null ? '0' : value.toString();
  if (!/^(0|[1-9][0-9]*)$/.test(text) || text.length > 20 || BigInt(text) > 18446744073709551615n) throw new Error('UINT64_INVALID');
  return text;
}
function text(value: string | null | undefined): string {
  if (!value || value.trim() !== value) throw new Error('BINDING_INVALID');
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code <= 31 || (code >= 127 && code <= 159)) throw new Error('BINDING_INVALID');
  }
  return value;
}
function scopeLabel(value: string | null | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{4,64}$/.test(value)) throw new Error('SCOPE_INVALID');
  return value;
}
function logLabel(value: string | null | undefined): string {
  if (!value || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error('LOG_INCARNATION_INVALID');
  return value;
}
function scopes(values: readonly string[] | null | undefined, nonempty = true): string[] {
  if (!values || values.length > 32 || (nonempty && values.length === 0)) throw new Error('SCOPES_INVALID');
  values.forEach(scopeLabel);
  if (new Set(values).size !== values.length) throw new Error('SCOPES_DUPLICATE');
  return [...values].sort();
}
function same(a: readonly string[], b: readonly string[]): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
function houseKey(house: popclaw.world.IHouseBinding): string {
  return JSON.stringify([text(house.origin), text(house.houseKey), text(house.incarnation)]);
}

function createTables(db: HostDb): void {
  db.execute(`CREATE TABLE IF NOT EXISTS world_scoped_bindings (
    binding_id TEXT PRIMARY KEY, origin TEXT NOT NULL, house_key TEXT NOT NULL, house_incarnation TEXT NOT NULL,
    log_incarnation TEXT, generation TEXT, sealed_h TEXT, checkpoint_h TEXT, last_frame_seq TEXT,
    requested_scopes TEXT NOT NULL DEFAULT '[]', replay_complete INTEGER NOT NULL DEFAULT 0,
    stale INTEGER NOT NULL DEFAULT 0, gap_reason TEXT)`);
  db.execute(`CREATE TABLE IF NOT EXISTS world_scoped_descriptors (
    binding_id TEXT NOT NULL, actor_id TEXT NOT NULL, participation_id TEXT NOT NULL,
    revision TEXT NOT NULL, core TEXT NOT NULL, scopes TEXT NOT NULL,
    PRIMARY KEY(binding_id, actor_id, participation_id))`);
  db.execute(`CREATE TABLE IF NOT EXISTS world_scoped_initial_scopes (
    binding_id TEXT PRIMARY KEY, scopes TEXT NOT NULL)`);
  db.execute(`CREATE TABLE IF NOT EXISTS world_scoped_cursors (
    binding_id TEXT NOT NULL, log_incarnation TEXT NOT NULL, scope_id TEXT NOT NULL,
    after_seq TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0, gap_reason TEXT,
    PRIMARY KEY(binding_id,log_incarnation,scope_id))`);
  db.execute(`CREATE TABLE IF NOT EXISTS world_scoped_events (
    binding_id TEXT NOT NULL, event_id TEXT NOT NULL, envelope BLOB NOT NULL, frame_bytes BLOB NOT NULL,
    content_pending INTEGER NOT NULL, task_pending INTEGER NOT NULL, PRIMARY KEY(binding_id,event_id))`);
  db.execute(`CREATE TABLE IF NOT EXISTS world_scoped_log_events (
    binding_id TEXT NOT NULL, log_incarnation TEXT NOT NULL, event_id TEXT NOT NULL, seq TEXT NOT NULL,
    PRIMARY KEY(binding_id,log_incarnation,event_id), UNIQUE(binding_id,log_incarnation,seq))`);
  db.execute(`CREATE TABLE IF NOT EXISTS world_scoped_event_scopes (
    binding_id TEXT NOT NULL, log_incarnation TEXT NOT NULL, scope_id TEXT NOT NULL, event_id TEXT NOT NULL,
    seq TEXT NOT NULL, PRIMARY KEY(binding_id,log_incarnation,scope_id,event_id))`);
  db.execute(`CREATE TABLE IF NOT EXISTS world_scoped_gaps (
    binding_id TEXT NOT NULL, generation TEXT NOT NULL, reason TEXT NOT NULL,
    scope_id TEXT NOT NULL, boundary_bytes BLOB NOT NULL,
    PRIMARY KEY(binding_id,generation,reason,scope_id))`);
}

/** Synchronous durable journal behind an owned, sequential SSE receiver.
 * The injected validator must verify event CID/signature, public scope authority
 * and any required official author. Descriptor authentication belongs to its
 * actor-bound caller. This module grants no action or snapshot authority.
 */
export class ScopedStreamJournal {
  private readonly binding: string;
  private readonly failedGenerations = new Set<string>();
  private activeGeneration: string | null = null;
  constructor(private readonly db: HostDb, house: popclaw.world.IHouseBinding, private readonly validateEnvelope: ValidateScopedEnvelope) {
    this.binding = houseKey(house);
    db.transaction(tx => {
      createTables(tx);
      tx.execute('INSERT OR IGNORE INTO world_scoped_bindings(binding_id,origin,house_key,house_incarnation) VALUES(?,?,?,?)',
        [this.binding, house.origin!, house.houseKey!, house.incarnation!]);
    });
  }

  /** First pin only, supplied by an authenticated descriptor or trusted setup.
   * It deliberately cannot change an existing log incarnation or recover gaps. */
  bootstrapLogIncarnation(logIncarnation: string): void {
    logLabel(logIncarnation);
    this.db.transaction(tx => {
      const old = this.row(tx).log_incarnation;
      if (old && old !== logIncarnation) throw new Error('LOG_INCARNATION_CONFLICT');
      tx.execute('UPDATE world_scoped_bindings SET log_incarnation=? WHERE binding_id=?', [logIncarnation, this.binding]);
      this.addCursors(tx, logIncarnation, this.activeScopes(tx));
    });
  }

  /** Independent public scopes from an already verified capability manifest.
   * Can be recorded before a trusted log incarnation is known; no cursors or
   * network request are then possible until explicit bootstrap. */
  installInitialScopes(scopeIds: readonly string[]): void {
    if (scopeIds.length > 8) throw new Error('INITIAL_SCOPE_LIMIT_EXCEEDED');
    const selected = scopes(scopeIds, false);
    this.db.transaction(tx => {
      const previous = this.activeScopes(tx);
      tx.execute(`INSERT INTO world_scoped_initial_scopes(binding_id,scopes) VALUES(?,?)
        ON CONFLICT(binding_id) DO UPDATE SET scopes=excluded.scopes`, [this.binding, JSON.stringify(selected)]);
      const current = this.activeScopes(tx);
      if (current.length > 32) throw new Error('SCOPE_LIMIT_EXCEEDED');
      const log = this.row(tx).log_incarnation;
      if (log) this.addCursors(tx, log, selected);
      if (!same(previous, current)) tx.execute(
        'UPDATE world_scoped_bindings SET generation=NULL,replay_complete=0 WHERE binding_id=?', [this.binding]);
    });
  }

  /** Caller has already validated the authenticated actor-bound result. */
  installDescriptor(descriptor: popclaw.world.ISubscriptionDescriptor): { status: 'installed' | 'duplicate' | 'old'; scopesChanged: boolean } {
    if (!descriptor.house || houseKey(descriptor.house) !== this.binding) throw new Error('HOUSE_BINDING_MISMATCH');
    const actor = text(descriptor.actorId), participation = text(descriptor.participationId);
    const revision = uint64(descriptor.descriptorRevision), selected = scopes(descriptor.scopes);
    const log = logLabel(descriptor.logIncarnation);
    const core = JSON.stringify([this.binding, actor, participation, revision, log, selected, descriptor.barrierId ? text(descriptor.barrierId) : '']);
    return this.db.transaction(tx => {
      if (this.log(tx) !== log) throw new Error('LOG_INCARNATION_CONFLICT');
      const old = tx.queryOne<{ revision: string; core: string }>(
        'SELECT revision,core FROM world_scoped_descriptors WHERE binding_id=? AND actor_id=? AND participation_id=?', [this.binding, actor, participation]);
      if (old && BigInt(revision) < BigInt(old.revision)) return { status: 'old', scopesChanged: false };
      if (old && revision === old.revision && core !== old.core) throw new Error('DESCRIPTOR_REVISION_CONFLICT');
      if (old && revision === old.revision) return { status: 'duplicate', scopesChanged: false };
      const previousScopes = this.activeScopes(tx);
      tx.execute(`INSERT INTO world_scoped_descriptors(binding_id,actor_id,participation_id,revision,core,scopes)
        VALUES(?,?,?,?,?,?) ON CONFLICT(binding_id,actor_id,participation_id) DO UPDATE SET
        revision=excluded.revision,core=excluded.core,scopes=excluded.scopes`, [this.binding, actor, participation, revision, core, JSON.stringify(selected)]);
      // Preserves all prior cursor and dedupe state, even for temporarily removed scopes.
      this.addCursors(tx, log, selected);
      const currentScopes = this.activeScopes(tx);
      if (currentScopes.length > 32) throw new Error('SCOPE_LIMIT_EXCEEDED');
      const scopesChanged = !same(previousScopes, currentScopes);
      if (scopesChanged) tx.execute(
        'UPDATE world_scoped_bindings SET generation=NULL,replay_complete=0 WHERE binding_id=?', [this.binding]);
      return { status: 'installed', scopesChanged };
    });
  }

  /** Anonymous request material only: no actor/descriptor/participation metadata. */
  cursorVector(scopeIds?: readonly string[]): popclaw.world.ScopeCursor[] {
    const log = this.log(this.db), active = this.activeScopes(this.db);
    const selected = scopeIds ? scopes(scopeIds) : active;
    if (selected.some(scope => !active.includes(scope))) throw new Error('SCOPE_NOT_SUBSCRIBED');
    return selected.map(scope => popclaw.world.ScopeCursor.fromObject({ scopeId: scope, afterSeq: this.cursor(this.db, log, scope) }));
  }

  /** The request vector must be the exact durable vector used for this connection.
   * Returns a new fence even when boundary-first delivery reveals a durable gap. */
  beginReplay(boundary: popclaw.world.IWorldStreamBoundary, requestVector?: readonly popclaw.world.IScopeCursor[]): string {
    const pinnedLog = this.log(this.db);
    const requested = requestVector ?? this.cursorVector();
    const selected = scopes(requested.map(c => text(c.scopeId)));
    if (!same(selected, requested.map(c => c.scopeId!))) throw new Error('VECTOR_NOT_SORTED');
    const served = scopes(boundary.scopes), high = uint64(boundary.highWaterSeq), boundaryLog = logLabel(boundary.logIncarnation);
    if (!same(served, selected)) throw new Error('BOUNDARY_SCOPE_MISMATCH');
    const generation = globalThis.crypto.randomUUID();
    this.db.transaction(tx => {
      const active = this.activeScopes(tx);
      for (const cursor of requested) {
        if (!active.includes(cursor.scopeId!)) throw new Error('SCOPE_NOT_SUBSCRIBED');
        if (this.cursor(tx, pinnedLog, cursor.scopeId!) !== uint64(cursor.afterSeq)) throw new Error('REQUEST_CURSOR_MISMATCH');
      }
      tx.execute(`UPDATE world_scoped_bindings SET generation=?,sealed_h=?,checkpoint_h=NULL,last_frame_seq=NULL,
        requested_scopes=?,replay_complete=0 WHERE binding_id=?`, [generation, high, JSON.stringify(selected), this.binding]);
      if (boundaryLog !== pinnedLog) this.recordGap(tx, generation, 'log_incarnation_changed', '', boundary);
      else for (const cursor of requested) if (BigInt(uint64(cursor.afterSeq)) > BigInt(high)) {
        this.recordGap(tx, generation, 'cursor_ahead', cursor.scopeId!, boundary);
      }
    });
    // The durable new generation fences all older connections, so their local
    // failure markers no longer need to accumulate across repeated reconnects.
    this.failedGenerations.clear();
    this.activeGeneration = generation;
    return generation;
  }

  /** Fence EOF, stop, or validation failures that occur before appendFrame.
   * A late close from an old connection cannot end its replacement. */
  endReplay(generation: string): void {
    if (this.activeGeneration === generation) this.activeGeneration = null;
    this.failedGenerations.add(generation);
    this.db.execute('UPDATE world_scoped_bindings SET generation=NULL,replay_complete=0 WHERE binding_id=? AND generation=?', [this.binding, generation]);
  }

  appendFrame(generation: string, frame: popclaw.event.IWorldStreamFrame): void {
    try {
      this.current(this.db, generation);
      const seq = uint64(frame.seq), covered = scopes(frame.scopes);
      if (seq === '0' || !frame.envelope?.length) throw new Error('FRAME_INVALID');
      const envelope = new Uint8Array(frame.envelope);
      const verified = this.validateEnvelope(new Uint8Array(envelope));
      const eventId = text(verified.eventId), signed = scopes(verified.publicScopes);
      // Real server frames carry every indexed scope, not only the request intersection.
      if (!same(covered, signed)) throw new Error('FRAME_SCOPE_AUTHORITY_MISMATCH');
      const frameBytes = popclaw.event.WorldStreamFrame.encode({ ...frame, envelope }).finish();
      this.db.transaction(tx => {
        const state = this.current(tx, generation), log = state.log_incarnation!;
        const requested = JSON.parse(state.requested_scopes) as string[];
        const relevant = covered.filter(scope => requested.includes(scope));
        if (!relevant.length) throw new Error('FRAME_OUTSIDE_REQUEST');
        if (!state.replay_complete && BigInt(seq) > BigInt(state.sealed_h!)) throw new Error('FRAME_PAST_REPLAY_BOUNDARY');
        if (state.last_frame_seq && BigInt(seq) < BigInt(state.last_frame_seq)) throw new Error('FRAME_ORDER_INVALID');
        const existing = tx.queryOne<{ envelope: Uint8Array }>('SELECT envelope FROM world_scoped_events WHERE binding_id=? AND event_id=?', [this.binding, eventId]);
        if (existing && !sameBytes(existing.envelope, envelope)) throw new Error('EVENT_BYTES_CONFLICT');
        const previousSeq = tx.queryOne<{ seq: string }>('SELECT seq FROM world_scoped_log_events WHERE binding_id=? AND log_incarnation=? AND event_id=?', [this.binding, log, eventId]);
        if (previousSeq && previousSeq.seq !== seq) throw new Error('EVENT_SEQUENCE_CONFLICT');
        tx.execute(`INSERT OR IGNORE INTO world_scoped_events(binding_id,event_id,envelope,frame_bytes,content_pending,task_pending)
          VALUES(?,?,?,?,1,1)`, [this.binding, eventId, envelope, frameBytes]);
        // OR IGNORE must not hide a different event occupying this global sequence.
        if (!previousSeq) tx.execute('INSERT INTO world_scoped_log_events(binding_id,log_incarnation,event_id,seq) VALUES(?,?,?,?)', [this.binding, log, eventId, seq]);
        for (const scope of relevant) {
          const old = this.cursor(tx, log, scope);
          const association = tx.queryOne('SELECT 1 FROM world_scoped_event_scopes WHERE binding_id=? AND log_incarnation=? AND scope_id=? AND event_id=?', [this.binding, log, scope, eventId]);
          if (BigInt(seq) <= BigInt(old) && !association) throw new Error('FRAME_BEHIND_CURSOR');
          tx.execute(`INSERT OR IGNORE INTO world_scoped_event_scopes(binding_id,log_incarnation,scope_id,event_id,seq)
            VALUES(?,?,?,?,?)`, [this.binding, log, scope, eventId, seq]);
          if (BigInt(seq) > BigInt(old)) tx.execute('UPDATE world_scoped_cursors SET after_seq=? WHERE binding_id=? AND log_incarnation=? AND scope_id=?', [seq, this.binding, log, scope]);
        }
        tx.execute('UPDATE world_scoped_bindings SET last_frame_seq=? WHERE binding_id=?', [seq, this.binding]);
      });
    } catch (error) {
      // A caught validation/storage failure can never be followed by a checkpoint
      // skipping that frame. Reconnect must start from the untouched durable vector.
      this.failedGenerations.add(generation);
      try { this.db.execute('UPDATE world_scoped_bindings SET generation=NULL,replay_complete=0 WHERE binding_id=? AND generation=?', [this.binding, generation]); } catch { /* An unavailable DB still has the in-process fence. */ }
      throw error;
    }
  }

  checkpoint(generation: string, checkpoint: popclaw.world.IWorldStreamCheckpoint): void {
    this.db.transaction(tx => {
      const state = this.current(tx, generation), requested = JSON.parse(state.requested_scopes) as string[];
      const marks = checkpoint.scopes ?? [], selected = scopes(marks.map(c => text(c.scopeId)));
      if (!same(selected, requested)) throw new Error('CHECKPOINT_SCOPE_MISMATCH');
      if (checkpoint.phase !== (state.replay_complete ? 'live' : 'replay')) throw new Error('CHECKPOINT_PHASE_INVALID');
      const high = uint64(marks[0]!.throughSeq);
      if (marks.some(mark => uint64(mark.throughSeq) !== high) || (!state.replay_complete && high !== state.sealed_h)) throw new Error('CHECKPOINT_HIGH_WATER_MISMATCH');
      if (state.checkpoint_h && BigInt(high) < BigInt(state.checkpoint_h)) throw new Error('CURSOR_ROLLBACK');
      for (const scope of requested) {
        if (BigInt(high) < BigInt(this.cursor(tx, state.log_incarnation!, scope))) throw new Error('CURSOR_ROLLBACK');
        tx.execute('UPDATE world_scoped_cursors SET after_seq=? WHERE binding_id=? AND log_incarnation=? AND scope_id=?', [high, this.binding, state.log_incarnation!, scope]);
      }
      tx.execute('UPDATE world_scoped_bindings SET checkpoint_h=?,replay_complete=1 WHERE binding_id=?', [high, this.binding]);
    });
  }

  gap(generation: string, gap: popclaw.world.IWorldStreamGap): void {
    const reason = gap.reason;
    if (reason !== 'unknown_scope' && reason !== 'cursor_ahead' && reason !== 'log_incarnation_changed' && reason !== 'history_pruned') throw new Error('GAP_REASON_INVALID');
    if (!gap.boundary) throw new Error('GAP_BOUNDARY_MISSING');
    const boundary = gap.boundary;
    logLabel(boundary.logIncarnation); uint64(boundary.highWaterSeq);
    this.db.transaction(tx => {
      const state = this.current(tx, generation, true), requested = JSON.parse(state.requested_scopes) as string[];
      if (!same(scopes(boundary.scopes), requested)) throw new Error('BOUNDARY_SCOPE_MISMATCH');
      const scope = gap.scopeId ?? '';
      if (scope && !requested.includes(scope)) throw new Error('GAP_SCOPE_MISMATCH');
      if ((reason === 'unknown_scope' || reason === 'cursor_ahead') && !scope) throw new Error('GAP_SCOPE_MISMATCH');
      if (reason === 'log_incarnation_changed' && boundary.logIncarnation === state.log_incarnation) throw new Error('GAP_INCARNATION_MISMATCH');
      if (reason !== 'log_incarnation_changed' && boundary.logIncarnation !== state.log_incarnation) throw new Error('GAP_INCARNATION_MISMATCH');
      this.recordGap(tx, generation, reason, scope, boundary);
    });
  }

  pending(consumer: Consumer, limit = 100, afterEventId?: string): ScopedPendingEvent[] {
    const column = this.pendingColumn(consumer);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('PENDING_LIMIT_INVALID');
    return this.db.queryAll<{ event_id: string; envelope: Uint8Array; frame_bytes: Uint8Array }>(
      `SELECT event_id,envelope,frame_bytes FROM world_scoped_events WHERE binding_id=? AND ${column}=1
       AND rowid > COALESCE((SELECT rowid FROM world_scoped_events WHERE binding_id=? AND event_id=?),0)
       ORDER BY rowid LIMIT ?`, [this.binding, this.binding, afterEventId ?? null, limit])
      .map(row => ({ eventId: row.event_id, envelope: new Uint8Array(row.envelope), frameBytes: new Uint8Array(row.frame_bytes) }));
  }

  /** Call only after that consumer succeeds. Consumers must themselves dedupe by
   * eventId: a crash after their side effect but before this mark retries delivery. */
  markConsumed(eventId: string, consumer: Consumer): void {
    const column = this.pendingColumn(consumer);
    if (!this.db.execute(`UPDATE world_scoped_events SET ${column}=0 WHERE binding_id=? AND event_id=?`, [this.binding, eventId]).changes) throw new Error('EVENT_NOT_FOUND');
  }

  status(): ScopedJournalStatus {
    const state = this.row(this.db), selected = JSON.parse(state.requested_scopes) as string[];
    const caughtUp = !!state.generation && this.activeGeneration === state.generation && !this.failedGenerations.has(state.generation) && !state.stale && !!state.replay_complete &&
      !!state.sealed_h && selected.length > 0 && selected.every(scope => BigInt(this.cursor(this.db, state.log_incarnation!, scope)) >= BigInt(state.sealed_h!));
    return { logIncarnation: state.log_incarnation, sealedHighWater: state.sealed_h, stale: !!state.stale, gapReason: state.gap_reason, caughtUp };
  }

  /** Local evidence token for a refresh started AFTER this completed replay.
   * A reconnect, changed subscription, gap or restart invalidates the token;
   * it is never sent over the anonymous stream or interpreted as authority. */
  replayAnchor(): string | null {
    if (!this.status().caughtUp) return null;
    const state = this.row(this.db);
    return JSON.stringify([state.log_incarnation, state.generation, state.sealed_h, JSON.parse(state.requested_scopes)]);
  }

  /** Cross-module composition must share this exact database and house. */
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding): void {
    if (db !== this.db || houseKey(house) !== this.binding) throw new Error('JOURNAL_BINDING_MISMATCH');
  }

  private row(db: HostDb): BindingRow {
    const row = db.queryOne<BindingRow>('SELECT * FROM world_scoped_bindings WHERE binding_id=?', [this.binding]);
    if (!row) throw new Error('JOURNAL_BINDING_MISSING');
    return row;
  }
  private log(db: HostDb): string { const log = this.row(db).log_incarnation; if (!log) throw new Error('LOG_INCARNATION_UNBOUND'); return log; }
  private current(db: HostDb, generation: string, allowStale = false): BindingRow {
    const state = this.row(db);
    if (this.activeGeneration !== generation || state.generation !== generation || this.failedGenerations.has(generation)) throw new Error('OBSOLETE_GENERATION');
    if (state.stale && !allowStale) throw new Error('STREAM_STALE');
    return state;
  }
  private activeScopes(db: HostDb): string[] {
    const initial = db.queryOne<{ scopes: string }>('SELECT scopes FROM world_scoped_initial_scopes WHERE binding_id=?', [this.binding]);
    const descriptors = db.queryAll<{ scopes: string }>('SELECT scopes FROM world_scoped_descriptors WHERE binding_id=?', [this.binding]);
    return [...new Set([...descriptors, ...(initial ? [initial] : [])].flatMap(row => JSON.parse(row.scopes) as string[]))].sort();
  }
  private addCursors(db: HostDb, log: string, selected: readonly string[]): void {
    for (const scope of selected) db.execute(`INSERT OR IGNORE INTO world_scoped_cursors(binding_id,log_incarnation,scope_id,after_seq)
      VALUES(?,?,?,'0')`, [this.binding, log, scope]);
  }
  private cursor(db: HostDb, log: string, scope: string): string {
    const row = db.queryOne<CursorRow>('SELECT scope_id,after_seq FROM world_scoped_cursors WHERE binding_id=? AND log_incarnation=? AND scope_id=?', [this.binding, log, scope]);
    if (!row) throw new Error('CURSOR_NOT_FOUND');
    return row.after_seq;
  }
  private pendingColumn(consumer: Consumer): string {
    if (consumer === 'content') return 'content_pending';
    if (consumer === 'task') return 'task_pending';
    throw new Error('CONSUMER_INVALID');
  }
  private recordGap(db: HostDb, generation: string, reason: GapReason, scope: string, boundary: popclaw.world.IWorldStreamBoundary): void {
    const state = this.row(db), selected = scope ? [scope] : JSON.parse(state.requested_scopes) as string[];
    db.execute('INSERT OR IGNORE INTO world_scoped_gaps(binding_id,generation,reason,scope_id,boundary_bytes) VALUES(?,?,?,?,?)',
      [this.binding, generation, reason, scope, popclaw.world.WorldStreamBoundary.encode(boundary).finish()]);
    for (const target of selected) db.execute('UPDATE world_scoped_cursors SET stale=1,gap_reason=? WHERE binding_id=? AND log_incarnation=? AND scope_id=?', [reason, this.binding, state.log_incarnation!, target]);
    db.execute('UPDATE world_scoped_bindings SET stale=1,gap_reason=?,replay_complete=0 WHERE binding_id=?', [reason, this.binding]);
  }
}

// Public-v1 is separate from the retained historical scoped schema.
import { cidFromCanonical } from '@popclaw/algorithms';
import type { VerifiedPublicStreamCapability } from './world-capabilities.js';
import { verifyPublicEnvelope, decodePublicFrame, decodePublicControl, inspectPublicCarrier } from '../ingress/public-stream-wire.js';
const PUBLIC_DDL = `-- Design artifact only. Not a migration entry point; do not execute before approval.
-- All tables reside in the existing executionDbFor H31 partition, never cache.db.
-- Canonical uint64 TEXT is validated before SQL with BigInt; never JS Number or
-- SQLite lexical ordering. Ordered scans use length(seq), seq COLLATE BINARY.
CREATE TABLE world_public_bindings_v1 (
  binding_id TEXT PRIMARY KEY, origin TEXT NOT NULL, house_key TEXT NOT NULL,
  house_incarnation TEXT NOT NULL, active_log TEXT NOT NULL,
  capability_revision TEXT NOT NULL, generation TEXT,
  selection_json TEXT NOT NULL, cycle_inputs_json TEXT NOT NULL,
  consumer_contracts_json TEXT NOT NULL, -- declared version/descriptor/approved adapter mapping, not JS introspection
  boundary_bytes BLOB, replay_h TEXT, last_frame_seq TEXT, checkpoint_h TEXT,
  checkpoint_bytes BLOB, phase TEXT NOT NULL CHECK(phase IN ('idle','replay','live','unavailable','gap')),
  gap_bytes BLOB, error_code TEXT
);
CREATE TABLE world_public_cursors_v1 (
  binding_id TEXT NOT NULL, log_incarnation TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('public','scope')), scope_id TEXT NOT NULL,
  after_seq TEXT NOT NULL, stale INTEGER NOT NULL DEFAULT 0 CHECK(stale IN (0,1)),
  gap_reason TEXT,
  CHECK((lane='public' AND scope_id='') OR (lane='scope' AND scope_id<>'')),
  PRIMARY KEY(binding_id,log_incarnation,lane,scope_id)
);
CREATE TABLE world_public_events_v1 (
  binding_id TEXT NOT NULL, event_id TEXT NOT NULL, envelope BLOB NOT NULL,
  kind TEXT NOT NULL, current_projection BLOB, projection_log TEXT, projection_seq TEXT,
  CHECK((current_projection IS NULL AND projection_log IS NULL AND projection_seq IS NULL)
     OR (current_projection IS NOT NULL AND projection_log IS NOT NULL AND projection_seq IS NOT NULL)),
  PRIMARY KEY(binding_id,event_id)
);
CREATE TABLE world_public_frames_v1 (
  binding_id TEXT NOT NULL, log_incarnation TEXT NOT NULL, seq TEXT NOT NULL,
  event_id TEXT NOT NULL, frame_bytes BLOB NOT NULL, observed_at INTEGER NOT NULL,
  PRIMARY KEY(binding_id,log_incarnation,seq),
  UNIQUE(binding_id,log_incarnation,event_id),
  FOREIGN KEY(binding_id,event_id) REFERENCES world_public_events_v1(binding_id,event_id)
);
CREATE TABLE world_public_associations_v1 (
  binding_id TEXT NOT NULL, log_incarnation TEXT NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('public','scope')), scope_id TEXT NOT NULL,
  event_id TEXT NOT NULL, seq TEXT NOT NULL,
  CHECK((lane='public' AND scope_id='') OR (lane='scope' AND scope_id<>'')),
  PRIMARY KEY(binding_id,log_incarnation,lane,scope_id,event_id),
  FOREIGN KEY(binding_id,log_incarnation,seq)
    REFERENCES world_public_frames_v1(binding_id,log_incarnation,seq)
);
CREATE TABLE world_public_consumers_v1 (
  binding_id TEXT NOT NULL, event_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','done','unsupported','not_applicable','refused')),
  attempt_token TEXT, resource_generation TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT, completion_source TEXT,
  PRIMARY KEY(binding_id,event_id,consumer_id),
  FOREIGN KEY(binding_id,event_id) REFERENCES world_public_events_v1(binding_id,event_id)
);
CREATE INDEX world_public_consumers_pending_v1
  ON world_public_consumers_v1(binding_id,consumer_id,state,event_id);
CREATE TABLE world_public_imports_v1 (
  binding_id TEXT NOT NULL, source_table TEXT NOT NULL, source_key TEXT NOT NULL,
  source_digest TEXT NOT NULL, event_id TEXT NOT NULL, historical_seq TEXT,
  historical_projection BLOB, source_consumer_flags TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('imported','restricted','conflict')),
  reason_code TEXT,
  PRIMARY KEY(binding_id,source_table,source_key)
);
CREATE TABLE world_public_log_profiles_v1 (
  binding_id TEXT NOT NULL, log_incarnation TEXT NOT NULL,
  envelope_baseline TEXT, capability_revision TEXT,
  retired INTEGER NOT NULL CHECK(retired IN (0,1)),
  CHECK((envelope_baseline IS NULL AND capability_revision IS NULL AND retired=1)
    OR (envelope_baseline IS NOT NULL AND capability_revision IS NOT NULL)),
  PRIMARY KEY(binding_id,log_incarnation)
);
`;
export const PUBLIC_STREAM_TABLES = Object.freeze(['world_public_bindings_v1','world_public_cursors_v1','world_public_events_v1','world_public_frames_v1','world_public_associations_v1','world_public_consumers_v1','world_public_imports_v1','world_public_log_profiles_v1']);
export const PUBLIC_STREAM_INDEX = 'world_public_consumers_pending_v1';
const digest = (value: string) => cidFromCanonical(new TextEncoder().encode(value));
export const EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST = digest('[]');
export type PublicSelection = Readonly<{fullPublic:boolean; scopes:readonly string[]}>;
export interface PublicReceiveGate {readonly origin:string;readonly signal:AbortSignal;isActive():boolean}
export interface VerifiedPublicProducerPolicy {readonly house:VerifiedPublicStreamCapability['house'];readonly capabilityRevision:string;readonly officialActorIds:readonly string[]}
export interface PublicConsumerContract {
  readonly consumerId:string; readonly semanticVersion:string; readonly descriptorDigest:string; readonly adapterEntryPoint:string;
  readonly effectMode:'same-db'|'idempotent-effect'; readonly evidenceReference:string; readonly approvedLegacySourceIds:readonly string[];
}
export interface PublicDelivery {readonly bindingId:string;readonly eventId:string;readonly envelope:Uint8Array;readonly projection?:popclaw.event.IWorldFeedItem;readonly observedAt?:number}
export type PublicConsumer = Readonly<{contract:PublicConsumerContract;select(delivery:PublicDelivery):'accept'|'not_applicable'|'unsupported'}> & (
  Readonly<{mode:'same-db';apply(tx:HostDb,delivery:PublicDelivery):void}> |
  Readonly<{mode:'idempotent-effect';deliver(delivery:PublicDelivery,context:Readonly<{idempotencyKey:string;signal:AbortSignal}>):Promise<void>}>);
/** The closed set of reasons a stored consumer row may be retired without
 * ever having succeeded. A row parked under one of these is never claimed
 * again, so the code has to name the refusal a person could act on — a
 * generic "it failed" would repeat the mistake of reporting a storage gap as
 * an authentication failure. Adding a member is a deliberate edit here, not
 * something a consumer can do by inventing a string. */
export const PUBLIC_CONSUMER_REFUSALS = Object.freeze(['PUBLIC_RELATION_REFUSED'] as const);
export type PublicConsumerRefusalCode = typeof PUBLIC_CONSUMER_REFUSALS[number];
/** The only way a consumer declares its own failure permanent. The journal
 * never infers permanence from a caught error: a message is free text, not a
 * taxonomy, and a transient fault read as permanent would retire a row that
 * could still have succeeded. An unrecognized code is treated as an ordinary
 * failure and retried, so a forged or stale code cannot retire anything. */
export class PublicConsumerRefusal extends Error {
  readonly code:PublicConsumerRefusalCode;
  constructor(code:PublicConsumerRefusalCode){super(code);this.name='PublicConsumerRefusal';this.code=code;}
}
export interface PublicReceiveStatus {
  bindingId:string;logIncarnation:string;phase:'idle'|'replay'|'live'|'unavailable'|'gap';connected:boolean;caughtUp:boolean;
  publicAfter:string|null;scopes:readonly {scopeId:string;afterSeq:string;stale:boolean;gapReason:string|null}[];
  checkpointHighWater:string|null;replayHighWater:string|null;gapReason:string|null;errorCode:string|null;
}
export interface PublicConsumerStatus {consumerId:string;supported:boolean;pending:number;running:number;done:number;unsupported:number;notApplicable:number;refused:number}
export interface PublicStreamRequest {incarnation:string;publicAfter?:string;cursors:readonly {scopeId:string;afterSeq:string}[]}
export interface PublicJournalPreparation {
  executionDb:HostDb;capability:VerifiedPublicStreamCapability;producerPolicy:VerifiedPublicProducerPolicy;
  selection:PublicSelection;consumerContracts:readonly PublicConsumerContract[];approvedConsumerMappingDigest:string;
  /** Only the explicit maintenance reservation may authorize the exact seven-table upgrade. */
  upgradeLegacyLogProfiles?:boolean;
}
export interface PublicJournalOptions extends PublicJournalPreparation {gate:PublicReceiveGate}
interface PublicBindingRow {
  binding_id:string;origin:string;house_key:string;house_incarnation:string;active_log:string;capability_revision:string;
  generation:string|null;selection_json:string;cycle_inputs_json:string;consumer_contracts_json:string;
  boundary_bytes:Uint8Array|null;replay_h:string|null;last_frame_seq:string|null;checkpoint_h:string|null;checkpoint_bytes:Uint8Array|null;
  phase:PublicReceiveStatus['phase'];gap_bytes:Uint8Array|null;error_code:string|null;
}
interface PublicCursorRow {lane:'public'|'scope';scope_id:string;after_seq:string;stale:number;gap_reason:string|null}
const publicStatements = PUBLIC_DDL.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean);
const publicProfileStatement = publicStatements.find(s=>s.startsWith('CREATE TABLE world_public_log_profiles_v1'))!;
const legacyPublicStatements = publicStatements.filter(s=>s!==publicProfileStatement);
const normalizedSql = (s:string) => s.replace(/\bIF\s+NOT\s+EXISTS\b/gi,'').replace(/\s+/g,'').replace(/;$/,'').toLowerCase();
/** Read-only: missing or structurally changed protected evidence is never repaired. */
export function verifyPublicStreamJournalSchema(db:HostDb):void {
  verifyPublicStatements(db,publicStatements);
}
/** Exact predecessor validation for the explicit maintenance reservation only. */
export function verifyLegacyPublicStreamJournalSchema(db:HostDb):void {
  if(tableExists(db,'world_public_log_profiles_v1'))throw new Error('PUBLIC_LOG_PROFILE_ALREADY_PRESENT');
  verifyPublicStatements(db,legacyPublicStatements);
}
function verifyPublicStatements(db:HostDb,statements:readonly string[]):void {
  for (const statement of statements) {
    const name = /^CREATE (?:TABLE|INDEX) (\w+)/.exec(statement)![1]!;
    const row = db.queryOne<{sql:string}>("SELECT sql FROM sqlite_master WHERE name=? AND type IN ('table','index')",[name]);
    if (!row || normalizedSql(row.sql)!==normalizedSql(statement)) throw new Error(`PUBLIC_JOURNAL_SCHEMA_INVALID:${name}`);
  }
}
function publicSelection(s:PublicSelection):PublicSelection {
  if (!s || typeof s.fullPublic!=='boolean') throw new Error('PUBLIC_SELECTION_INVALID');
  const selected=scopes(s.scopes,!s.fullPublic); return Object.freeze({fullPublic:s.fullPublic,scopes:Object.freeze(selected)});
}
const legacyIds = ['legacy-public-content:v1','legacy-public-task:v1','legacy-scoped-content:v1','legacy-scoped-combined-task:v1'];
function contractsJson(contracts:readonly PublicConsumerContract[]):string {
  const ids=new Set<string>();
  const records=contracts.map(c=>{
    if (ids.has(text(c.consumerId))) throw new Error('PUBLIC_CONSUMER_DUPLICATE'); ids.add(c.consumerId);
    if (!['same-db','idempotent-effect'].includes(c.effectMode)) throw new Error('PUBLIC_CONSUMER_MODE_INVALID');
    const aliases=[...c.approvedLegacySourceIds].sort();
    if (new Set(aliases).size!==aliases.length || aliases.some(id=>!legacyIds.includes(id))) throw new Error('PUBLIC_CONSUMER_ALIAS_INVALID');
    return {consumerId:c.consumerId,semanticVersion:text(c.semanticVersion),descriptorDigest:text(c.descriptorDigest),adapterEntryPoint:text(c.adapterEntryPoint),effectMode:c.effectMode,evidenceReference:text(c.evidenceReference),approvedLegacySourceIds:aliases};
  }).sort((a,b)=>a.consumerId<b.consumerId?-1:a.consumerId>b.consumerId?1:0);
  return JSON.stringify(records);
}
function checkedPreparation(o:PublicJournalPreparation) {
  const capability=o.capability, policy=o.producerPolicy;
  const binding=houseKey(capability.house),selection=publicSelection(o.selection), mapping=contractsJson(o.consumerContracts);
  if (!policy || houseKey(policy.house)!==binding || policy.capabilityRevision!==text(capability.capabilityRevision) || !Array.isArray(policy.officialActorIds)) throw new Error('PUBLIC_PRODUCER_POLICY_INVALID');
  policy.officialActorIds.forEach(text);
  if (new Set(policy.officialActorIds).size!==policy.officialActorIds.length) throw new Error('PUBLIC_PRODUCER_POLICY_INVALID');
  if (capability.publicStream.mode!=='public-v1'||capability.publicStream.endpoint!=='/v1/world-stream') throw new Error('PUBLIC_CAPABILITY_INVALID');
  if (capability.publicStream.envelope_baseline!=='public-envelope-02') throw new Error('PUBLIC_BASELINE_UNSUPPORTED');
  logLabel(capability.publicStream.log_incarnation);
  if (digest(mapping)!==o.approvedConsumerMappingDigest) throw new Error('PUBLIC_CONSUMER_MAPPING_DIGEST_MISMATCH');
  return {binding,selection,mapping};
}
function mergeContracts(previous:string,next:string):string {
  const old=JSON.parse(previous) as PublicConsumerContract[], incoming=JSON.parse(next) as PublicConsumerContract[];
  // Revalidate stored declarations; a corrupted record is not an empty mapping.
  if (contractsJson(old)!==previous) throw new Error('PUBLIC_CONSUMER_STORED_MAPPING_INVALID');
  for(const c of incoming){const existing=old.find(x=>x.consumerId===c.consumerId);if(existing && contractsJson([existing])!==contractsJson([c]))throw new Error('PUBLIC_CONSUMER_IDENTITY_CONFLICT');if(!existing)old.push(c);}
  return contractsJson(old);
}
function bindPublic(tx:HostDb,o:PublicJournalPreparation,activate:boolean):string {
  const {binding,selection,mapping}=checkedPreparation(o),c=o.capability;
  const old=tx.queryOne<PublicBindingRow>('SELECT * FROM world_public_bindings_v1 WHERE binding_id=?',[binding]);
  if(old && (old.origin!==c.house.origin||old.house_key!==c.house.houseKey||old.house_incarnation!==c.house.incarnation)) throw new Error('PUBLIC_HOUSE_BINDING_CONFLICT');
  const profile=tx.queryOne<{envelope_baseline:string|null;retired:number}>('SELECT envelope_baseline,retired FROM world_public_log_profiles_v1 WHERE binding_id=? AND log_incarnation=?',[binding,c.publicStream.log_incarnation]);
  if(profile?.retired)throw new Error('PUBLIC_LOG_RETIRED');
  if(profile && profile.envelope_baseline!==c.publicStream.envelope_baseline)throw new Error('PUBLIC_LOG_BASELINE_CONFLICT');
  if(!profile){
    // Existing evidence without a profile is unknown history, never a fresh log.
    if(usedPublicLogs(tx,binding).some(log=>log===c.publicStream.log_incarnation))throw new Error('PUBLIC_LOG_PROFILE_UNPROVEN');
    tx.execute('INSERT INTO world_public_log_profiles_v1(binding_id,log_incarnation,envelope_baseline,capability_revision,retired) VALUES(?,?,?,?,0)',[binding,c.publicStream.log_incarnation,c.publicStream.envelope_baseline,c.capabilityRevision]);
  }
  if(old && !tx.queryOne('SELECT 1 FROM world_public_log_profiles_v1 WHERE binding_id=? AND log_incarnation=?',[binding,old.active_log]))throw new Error('PUBLIC_LOG_PROFILE_UNPROVEN');
  if(activate)tx.execute('UPDATE world_public_log_profiles_v1 SET retired=1 WHERE binding_id=? AND log_incarnation<>?',[binding,c.publicStream.log_incarnation]);
  const stored=mergeContracts(old?.consumer_contracts_json??'[]',mapping);
  if(!old)tx.execute(`INSERT INTO world_public_bindings_v1(binding_id,origin,house_key,house_incarnation,active_log,capability_revision,selection_json,cycle_inputs_json,consumer_contracts_json,phase) VALUES(?,?,?,?,?,?,?,?,?,'idle')`,[binding,c.house.origin,c.house.houseKey,c.house.incarnation,c.publicStream.log_incarnation,c.capabilityRevision,JSON.stringify(selection),'{}',stored]);
  else if(activate)tx.execute(`UPDATE world_public_bindings_v1 SET active_log=?,capability_revision=?,selection_json=?,consumer_contracts_json=?,generation=NULL,phase='idle',cycle_inputs_json='{}',boundary_bytes=NULL,replay_h=NULL,last_frame_seq=NULL,checkpoint_h=NULL,checkpoint_bytes=NULL,gap_bytes=NULL,error_code=NULL WHERE binding_id=?`,[c.publicStream.log_incarnation,c.capabilityRevision,JSON.stringify(selection),stored,binding]);
  else tx.execute('UPDATE world_public_bindings_v1 SET consumer_contracts_json=? WHERE binding_id=?',[stored,binding]);
  const lanes=[...(selection.fullPublic?[{lane:'public',scope:''}]:[]),...selection.scopes.map(scope=>({lane:'scope',scope}))];
  for(const lane of lanes)tx.execute(`INSERT OR IGNORE INTO world_public_cursors_v1(binding_id,log_incarnation,lane,scope_id,after_seq) VALUES(?,?,?,?,'0')`,[binding,c.publicStream.log_incarnation,lane.lane,lane.scope]);
  return binding;
}
function tableExists(db:HostDb,name:string):boolean{return !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[name]);}
function assertCurrentPublicLogProfile(db:HostDb,binding:string,capability:VerifiedPublicStreamCapability):void {
  const profile=db.queryOne<{envelope_baseline:string|null;retired:number}>('SELECT envelope_baseline,retired FROM world_public_log_profiles_v1 WHERE binding_id=? AND log_incarnation=?',[binding,capability.publicStream.log_incarnation]);
  if(!profile||profile.retired||profile.envelope_baseline!==capability.publicStream.envelope_baseline)throw new Error('PUBLIC_LOG_PROFILE_UNPROVEN');
}
function usedPublicLogs(db:HostDb,binding:string):string[]{
  return db.queryAll<{log_incarnation:string}>(`SELECT active_log AS log_incarnation FROM world_public_bindings_v1 WHERE binding_id=?
    UNION SELECT log_incarnation FROM world_public_cursors_v1 WHERE binding_id=?
    UNION SELECT log_incarnation FROM world_public_frames_v1 WHERE binding_id=?
    UNION SELECT log_incarnation FROM world_public_associations_v1 WHERE binding_id=?
    UNION SELECT projection_log AS log_incarnation FROM world_public_events_v1 WHERE binding_id=? AND projection_log IS NOT NULL`,[binding,binding,binding,binding,binding]).map(row=>logLabel(row.log_incarnation));
}
function presentPublicStatements(tx:HostDb):readonly string[] {
  return publicStatements.filter(statement=>tx.queryOne('SELECT name FROM sqlite_master WHERE name=?',[/^CREATE (?:TABLE|INDEX) (\w+)/.exec(statement)![1]!]));
}
function preparePublicSchema(tx:HostDb,upgradeLegacyLogProfiles:boolean):void {
  const present=presentPublicStatements(tx);
  if(!present.length){for(const statement of publicStatements)tx.execute(statement);return;}
  if(!tableExists(tx,'world_public_log_profiles_v1')){
    if(!upgradeLegacyLogProfiles)throw new Error('PUBLIC_LOG_PROFILE_MAINTENANCE_REQUIRED');
    verifyLegacyPublicStreamJournalSchema(tx);
    tx.execute(publicProfileStatement);
    // Neither an old selection nor a historical cursor proves its former baseline.
    const bindings=tx.queryAll<{binding_id:string}>(`SELECT binding_id FROM world_public_bindings_v1
      UNION SELECT binding_id FROM world_public_cursors_v1 UNION SELECT binding_id FROM world_public_frames_v1
      UNION SELECT binding_id FROM world_public_associations_v1 UNION SELECT binding_id FROM world_public_events_v1`);
    for(const {binding_id} of bindings)for(const log of usedPublicLogs(tx,binding_id))tx.execute(
      'INSERT INTO world_public_log_profiles_v1(binding_id,log_incarnation,envelope_baseline,capability_revision,retired) VALUES(?,?,NULL,NULL,1)',[binding_id,log]);
  }
  verifyPublicStreamJournalSchema(tx);
}
/**
 * Pure schema entry for a fresh-partition factory: create and verify the
 * public-stream tables only, callable inside the factory's own
 * pre-publication transaction. Deliberately never writes a binding, a
 * log-profile, or a cursor row: a log-profile row is what proves a log
 * incarnation was ever bound and offline-verified, and writing one here
 * (even to "fix" a legacy install missing that table) would authorize
 * history the factory never checked, and would push an already-healthy
 * existing binding into maintenance behind the factory's back. Any repair
 * of a partial or legacy install still goes through the explicit
 * maintenance reservation (preparePublicSchema's upgradeLegacyLogProfiles).
 */
export function createPublicStreamSchema(tx:HostDb):void {
  const present=presentPublicStatements(tx);
  if(!present.length){for(const statement of publicStatements)tx.execute(statement);}
  else if(!tableExists(tx,'world_public_log_profiles_v1'))throw new Error('PUBLIC_LOG_PROFILE_MAINTENANCE_REQUIRED');
  verifyPublicStreamJournalSchema(tx);
}
interface HistoricalRow {source:string;key:string;eventId:string;bytes:Uint8Array;projection:Uint8Array|null;seq:string|null;flags:Record<string,number>;bindingValid:boolean;evidence:string;wireError?:string}
function historicalRows(db:HostDb,binding:string):HistoricalRow[] {
  const rows:HistoricalRow[]=[];
  if(tableExists(db,'world_stream'))for(const r of db.queryAll<{seq:string;event_id:string;kind:string;received_at:number;envelope:Uint8Array;projection:Uint8Array|null;content_done:number;task_done:number}>("SELECT CAST(seq AS TEXT) AS seq,event_id,kind,received_at,envelope,projection,content_done,task_done FROM world_stream ORDER BY length(CAST(seq AS TEXT)),seq")) rows.push({source:'world_stream',key:String(r.seq),eventId:r.event_id,bytes:r.envelope,projection:r.projection,seq:String(r.seq),flags:{'legacy-public-content:v1':r.content_done,'legacy-public-task:v1':r.task_done},bindingValid:true,evidence:JSON.stringify([r.kind,r.received_at])});
  if(tableExists(db,'world_scoped_events'))for(const r of db.queryAll<{binding_id:string;event_id:string;envelope:Uint8Array;frame_bytes:Uint8Array;content_pending:number;task_pending:number}>('SELECT * FROM world_scoped_events ORDER BY binding_id,event_id')) {
    const sourceBinding=tableExists(db,'world_scoped_bindings')?db.queryOne<{origin:string;house_key:string;house_incarnation:string}>('SELECT origin,house_key,house_incarnation FROM world_scoped_bindings WHERE binding_id=?',[r.binding_id]):null;
    let projection:Uint8Array|null=null,wireError:string|undefined;
    try{inspectPublicCarrier(r.frame_bytes,'frame');const frame=popclaw.event.WorldStreamFrame.decode(r.frame_bytes);if(frame.projection)projection=popclaw.event.WorldFeedItem.encode(frame.projection).finish();}catch{wireError='PUBLIC_IMPORT_CARRIER_INVALID';}
    rows.push({source:'world_scoped_events',key:JSON.stringify([r.binding_id,r.event_id]),eventId:r.event_id,bytes:r.envelope,projection,seq:null,flags:{'legacy-scoped-content:v1':1-r.content_pending,'legacy-scoped-combined-task:v1':1-r.task_pending},bindingValid:r.binding_id===binding&&!!sourceBinding&&JSON.stringify([sourceBinding.origin,sourceBinding.house_key,sourceBinding.house_incarnation])===binding,evidence:JSON.stringify([Buffer.from(r.frame_bytes).toString('base64'),sourceBinding]),wireError});
  }
  return rows;
}
/** Sole target transaction; the caller reserves these names in G before entry. */
export function preparePublicStreamJournal(o:PublicJournalPreparation):{bindingId:string;tables:readonly string[];mappingDigest:string;imported:number;restricted:number} {
  checkedPreparation(o);
  return o.executionDb.transaction(tx=>{
    preparePublicSchema(tx,o.upgradeLegacyLogProfiles===true);
    verifyPublicStreamJournalSchema(tx);
    const binding=bindPublic(tx,o,false);let imported=0,restricted=0;
    for(const r of historicalRows(tx,binding)){
      const sourceDigest=digest(JSON.stringify([r.eventId,Buffer.from(r.bytes).toString('base64'),r.projection?Buffer.from(r.projection).toString('base64'):null,r.seq,r.flags,r.bindingValid,r.evidence]));
      const prior=tx.queryOne<{source_digest:string}>('SELECT source_digest FROM world_public_imports_v1 WHERE binding_id=? AND source_table=? AND source_key=?',[binding,r.source,r.key]);
      if(prior){if(prior.source_digest!==sourceDigest)throw new Error('PUBLIC_IMPORT_SOURCE_MUTATED');continue;}
      let disposition:'imported'|'restricted'|'conflict'='imported',reason:string|null=null,kind='';
      try{if(r.wireError)throw new Error(r.wireError);if(r.projection)inspectPublicCarrier(r.projection,'projection',true);if(!r.bindingValid)throw new Error('PUBLIC_IMPORT_BINDING_UNPROVEN');if(Object.values(r.flags).some(v=>v!==0&&v!==1))throw new Error('PUBLIC_IMPORT_FLAGS_INVALID');const verified=verifyPublicEnvelope(new Uint8Array(r.bytes),o.producerPolicy);if(verified.eventId!==r.eventId)throw new Error('PUBLIC_IMPORT_CID_MISMATCH');kind=verified.kind;}catch(e){disposition='restricted';reason=e instanceof Error?e.message.slice(0,256):'PUBLIC_IMPORT_UNSAFE';}
      if(disposition==='imported'){
        const old=tx.queryOne<{envelope:Uint8Array}>('SELECT envelope FROM world_public_events_v1 WHERE binding_id=? AND event_id=?',[binding,r.eventId]);
        if(old&&!sameBytes(old.envelope,r.bytes)){disposition='conflict';reason='PUBLIC_IMPORT_BYTES_CONFLICT';tx.execute("UPDATE world_public_consumers_v1 SET state='unsupported',attempt_token=NULL,error_code=? WHERE binding_id=? AND event_id=?",[reason,binding,r.eventId]);}
        else{
          if(!old)tx.execute('INSERT INTO world_public_events_v1(binding_id,event_id,envelope,kind) VALUES(?,?,?,?)',[binding,r.eventId,r.bytes,kind]);
          for(const [id,done] of Object.entries(r.flags))tx.execute(`INSERT OR IGNORE INTO world_public_consumers_v1(binding_id,event_id,consumer_id,state,completion_source) VALUES(?,?,?,?,?)`,[binding,r.eventId,id,done?'done':'pending',JSON.stringify([r.source,r.key])]);
          imported++;
        }
      }
      if(disposition!=='imported')restricted++;
      tx.execute(`INSERT INTO world_public_imports_v1(binding_id,source_table,source_key,source_digest,event_id,historical_seq,historical_projection,source_consumer_flags,disposition,reason_code) VALUES(?,?,?,?,?,?,?,?,?,?)`,[binding,r.source,r.key,sourceDigest,r.eventId,r.seq,r.projection,JSON.stringify(r.flags),disposition,reason]);
    }
    return {bindingId:binding,tables:PUBLIC_STREAM_TABLES,mappingDigest:o.approvedConsumerMappingDigest,imported,restricted};
  });
}
const publicInstances = new WeakMap<HostDb,PublicStreamJournal>();
export class PublicStreamJournal {
  readonly bindingId:string;
  private readonly opts:PublicJournalOptions;
  private generation:string|null=null;
  private activated=false;
  private failed=false;
  private running:Promise<void>|null=null;
  constructor(options:PublicJournalOptions){
    const checked=checkedPreparation(options);verifyPublicStreamJournalSchema(options.executionDb);
    if(options.gate.origin!==options.capability.house.origin)throw new Error('PUBLIC_GATE_BINDING_MISMATCH');
    this.bindingId=checked.binding;
    this.opts={...options,capability:structuredClone(options.capability),producerPolicy:structuredClone(options.producerPolicy),selection:checked.selection,consumerContracts:JSON.parse(checked.mapping)};
  }
  private active():boolean{return this.activated&&!this.opts.gate.signal.aborted&&this.opts.gate.isActive()&&publicInstances.get(this.opts.executionDb)===this;}
  private assertGate():void{if(this.opts.gate.signal.aborted||!this.opts.gate.isActive())throw new Error('PUBLIC_GATE_INACTIVE');}
  activate():void{
    this.assertGate();verifyPublicStreamJournalSchema(this.opts.executionDb);
    // The resource owner must join the previous socket before replacement. A
    // persisted generation alone may be crash residue; a live local owner is not.
    const previous=publicInstances.get(this.opts.executionDb);
    if(previous?.generation!==null && previous?.generation!==undefined)throw new Error('PUBLIC_RECEIVER_JOIN_REQUIRED');
    this.opts.executionDb.transaction(tx=>{this.assertGate();bindPublic(tx,this.opts,true);this.assertGate();});
    this.generation=null;this.failed=false;this.activated=true;publicInstances.set(this.opts.executionDb,this);
    // Claims belong to a joined, replaced resource. Effects retry using stable keys.
    this.opts.executionDb.transaction(tx=>{this.current(tx);tx.execute("UPDATE world_public_consumers_v1 SET state='pending',attempt_token=NULL,resource_generation=NULL WHERE binding_id=? AND state='running'",[this.bindingId]);for(const row of tx.queryAll<{event_id:string}>('SELECT event_id FROM world_public_events_v1 WHERE binding_id=?',[this.bindingId]))this.addConsumers(tx,row.event_id);});
  }
  private row(db:HostDb):PublicBindingRow{
    const row=db.queryOne<PublicBindingRow>('SELECT * FROM world_public_bindings_v1 WHERE binding_id=?',[this.bindingId]);
    if(!row)throw new Error('PUBLIC_BINDING_MISSING');return row;
  }
  private current(db:HostDb,generation?:string):PublicBindingRow{
    if(!this.active())throw new Error('PUBLIC_GATE_INACTIVE');const row=this.row(db),c=this.opts.capability;
    if(row.active_log!==c.publicStream.log_incarnation||row.capability_revision!==c.capabilityRevision||row.selection_json!==JSON.stringify(this.opts.selection))throw new Error('PUBLIC_CAPTURE_OBSOLETE');
    assertCurrentPublicLogProfile(db,this.bindingId,c);
    if(generation!==undefined&&(this.failed||this.generation!==generation||row.generation!==generation||!['replay','live'].includes(row.phase)))throw new Error('PUBLIC_GENERATION_OBSOLETE');
    return row;
  }
  private lanes(db:HostDb):PublicCursorRow[]{return db.queryAll<PublicCursorRow>('SELECT lane,scope_id,after_seq,stale,gap_reason FROM world_public_cursors_v1 WHERE binding_id=? AND log_incarnation=?',[this.bindingId,this.opts.capability.publicStream.log_incarnation]).filter(r=>r.lane==='public'?this.opts.selection.fullPublic:this.opts.selection.scopes.includes(r.scope_id));}
  request():PublicStreamRequest{
    this.current(this.opts.executionDb);const rows=this.lanes(this.opts.executionDb),s=this.opts.selection;
    const cursor=(lane:string,scope:string)=>{const row=rows.find(r=>r.lane===lane&&r.scope_id===scope);if(!row)throw new Error('PUBLIC_CURSOR_MISSING');return uint64(row.after_seq);};
    return {incarnation:this.opts.capability.publicStream.log_incarnation,...(s.fullPublic?{publicAfter:cursor('public','')}:{}),cursors:s.scopes.map(scopeId=>({scopeId,afterSeq:cursor('scope',scopeId)}))};
  }
  private checkedBoundary(b:popclaw.world.IPublicStreamBoundary,request:PublicStreamRequest,allowLogChange=false):string{
    const high=uint64(b.highWaterSeq);
    if(!same(b.scopes??[],this.opts.selection.scopes)||!!b.fullPublic!==this.opts.selection.fullPublic)throw new Error('PUBLIC_BOUNDARY_SELECTION_MISMATCH');
    if(!allowLogChange&&b.logIncarnation!==request.incarnation)throw new Error('PUBLIC_BOUNDARY_LOG_MISMATCH');
    logLabel(b.logIncarnation);return high;
  }
  private requestMatches(request:PublicStreamRequest):void{if(JSON.stringify(request)!==JSON.stringify(this.request()))throw new Error('PUBLIC_REQUEST_CURSOR_MISMATCH');}
  begin(boundary:popclaw.world.IPublicStreamBoundary,raw:Uint8Array,request:PublicStreamRequest):string{
    const b=decodePublicControl('public_boundary',raw);
    if(!sameBytes(popclaw.world.PublicStreamBoundary.encode(b).finish(),popclaw.world.PublicStreamBoundary.encode(boundary).finish()))throw new Error('PUBLIC_CONTROL_BYTES_MISMATCH');
    const high=this.checkedBoundary(b,request),generation=globalThis.crypto.randomUUID();
    this.opts.executionDb.transaction(tx=>{
      this.current(tx);this.requestMatches(request);
      tx.execute(`UPDATE world_public_bindings_v1 SET generation=?,cycle_inputs_json=?,boundary_bytes=?,replay_h=?,last_frame_seq=NULL,checkpoint_h=NULL,checkpoint_bytes=NULL,phase='replay',gap_bytes=NULL,error_code=NULL WHERE binding_id=?`,[generation,JSON.stringify(request),new Uint8Array(raw),high,this.bindingId]);
      this.assertGate();
    });this.generation=generation;this.failed=false;return generation;
  }
  append(generation:string,rawFrame:Uint8Array):void{
    try{
      this.current(this.opts.executionDb,generation);const verified=decodePublicFrame(rawFrame,this.opts.producerPolicy),f=verified.frame,seq=uint64(f.seq);
      this.opts.executionDb.transaction(tx=>{
        const row=this.current(tx,generation),inputs=JSON.parse(row.cycle_inputs_json) as PublicStreamRequest;
        if(row.phase==='replay'&&BigInt(seq)>BigInt(row.replay_h!))throw new Error('PUBLIC_FRAME_PAST_REPLAY_BOUNDARY');
        if(row.last_frame_seq&&BigInt(seq)<BigInt(row.last_frame_seq))throw new Error('PUBLIC_FRAME_ORDER_INVALID');
        const lanes=this.lanes(tx).filter(lane=>{
          const input=lane.lane==='public'?inputs.publicAfter:inputs.cursors.find(c=>c.scopeId===lane.scope_id)?.afterSeq;
          return input!==undefined&&BigInt(seq)>BigInt(input)&&(lane.lane==='public'||verified.publicScopes.includes(lane.scope_id));
        });
        if(!lanes.length)throw new Error('PUBLIC_FRAME_OUTSIDE_REQUEST');
        const old=tx.queryOne<{envelope:Uint8Array;current_projection:Uint8Array|null;projection_log:string|null;projection_seq:string|null}>('SELECT envelope,current_projection,projection_log,projection_seq FROM world_public_events_v1 WHERE binding_id=? AND event_id=?',[this.bindingId,verified.eventId]);
        if(old&&!sameBytes(old.envelope,f.envelope))throw new Error('PUBLIC_EVENT_BYTES_CONFLICT');
        const bySeq=tx.queryOne<{event_id:string;frame_bytes:Uint8Array}>('SELECT event_id,frame_bytes FROM world_public_frames_v1 WHERE binding_id=? AND log_incarnation=? AND seq=?',[this.bindingId,row.active_log,seq]);
        const byId=tx.queryOne<{seq:string}>('SELECT seq FROM world_public_frames_v1 WHERE binding_id=? AND log_incarnation=? AND event_id=?',[this.bindingId,row.active_log,verified.eventId]);
        if(bySeq&&bySeq.event_id!==verified.eventId)throw new Error('PUBLIC_SEQUENCE_EVENT_CONFLICT');
        if(byId&&byId.seq!==seq)throw new Error('PUBLIC_EVENT_SEQUENCE_CONFLICT');
        if(!old)tx.execute('INSERT INTO world_public_events_v1(binding_id,event_id,envelope,kind) VALUES(?,?,?,?)',[this.bindingId,verified.eventId,new Uint8Array(f.envelope),verified.kind]);
        if(!bySeq)tx.execute('INSERT INTO world_public_frames_v1(binding_id,log_incarnation,seq,event_id,frame_bytes,observed_at) VALUES(?,?,?,?,?,?)',[this.bindingId,row.active_log,seq,verified.eventId,new Uint8Array(rawFrame),Math.floor(Date.now()/1000)]);
        if(f.projection&&(!old?.current_projection||old.projection_log!==row.active_log))tx.execute('UPDATE world_public_events_v1 SET current_projection=?,projection_log=?,projection_seq=? WHERE binding_id=? AND event_id=?',[popclaw.event.WorldFeedItem.encode(f.projection).finish(),row.active_log,seq,this.bindingId,verified.eventId]);
        for(const lane of lanes){
          const association=tx.queryOne<{seq:string}>('SELECT seq FROM world_public_associations_v1 WHERE binding_id=? AND log_incarnation=? AND lane=? AND scope_id=? AND event_id=?',[this.bindingId,row.active_log,lane.lane,lane.scope_id,verified.eventId]);
          if(association&&association.seq!==seq)throw new Error('PUBLIC_ASSOCIATION_CONFLICT');
          if(!association)tx.execute('INSERT INTO world_public_associations_v1(binding_id,log_incarnation,lane,scope_id,event_id,seq) VALUES(?,?,?,?,?,?)',[this.bindingId,row.active_log,lane.lane,lane.scope_id,verified.eventId,seq]);
          if(BigInt(seq)>BigInt(lane.after_seq))tx.execute('UPDATE world_public_cursors_v1 SET after_seq=? WHERE binding_id=? AND log_incarnation=? AND lane=? AND scope_id=?',[seq,this.bindingId,row.active_log,lane.lane,lane.scope_id]);
        }
        this.addConsumers(tx,verified.eventId);
        tx.execute('UPDATE world_public_bindings_v1 SET last_frame_seq=? WHERE binding_id=?',[seq,this.bindingId]);this.current(tx,generation);
      });
    }catch(e){this.end(generation,e instanceof Error?e.message:'PUBLIC_INGEST_FAILED');throw e;}
  }
  checkpoint(generation:string,checkpoint:popclaw.world.IPublicStreamCheckpoint,raw:Uint8Array):void{
    try{
      const c=decodePublicControl('public_checkpoint',raw);
      if(!sameBytes(popclaw.world.PublicStreamCheckpoint.encode(c).finish(),popclaw.world.PublicStreamCheckpoint.encode(checkpoint).finish()))throw new Error('PUBLIC_CONTROL_BYTES_MISMATCH');
      this.opts.executionDb.transaction(tx=>{
        const row=this.current(tx,generation),marks=c.scopes??[],s=this.opts.selection;
        if(c.phase!==(row.phase==='replay'?'replay':'live')||!same(marks.map(m=>m.scopeId!),s.scopes))throw new Error('PUBLIC_CHECKPOINT_SELECTION_PHASE_MISMATCH');
        const hasPublic=Object.prototype.hasOwnProperty.call(c,'publicThroughSeq')&&c.publicThroughSeq!=null;
        if(hasPublic!==s.fullPublic)throw new Error('PUBLIC_CHECKPOINT_PUBLIC_PRESENCE_MISMATCH');
        const high=uint64(hasPublic?c.publicThroughSeq:marks[0]?.throughSeq);
        if(marks.some(m=>uint64(m.throughSeq)!==high)||(row.phase==='replay'&&high!==row.replay_h))throw new Error('PUBLIC_CHECKPOINT_HIGH_WATER_MISMATCH');
        if((row.checkpoint_h&&BigInt(high)<BigInt(row.checkpoint_h))||(row.last_frame_seq&&BigInt(high)<BigInt(row.last_frame_seq)))throw new Error('PUBLIC_CHECKPOINT_BEHIND_FRAME');
        for(const lane of this.lanes(tx)){
          if(BigInt(high)<BigInt(lane.after_seq))throw new Error('PUBLIC_CURSOR_ROLLBACK');
          tx.execute('UPDATE world_public_cursors_v1 SET after_seq=?,stale=0,gap_reason=NULL WHERE binding_id=? AND log_incarnation=? AND lane=? AND scope_id=?',[high,this.bindingId,row.active_log,lane.lane,lane.scope_id]);
        }
        const inputs:PublicStreamRequest={incarnation:row.active_log,...(s.fullPublic?{publicAfter:high}:{}),cursors:s.scopes.map(scopeId=>({scopeId,afterSeq:high}))};
        tx.execute("UPDATE world_public_bindings_v1 SET checkpoint_h=?,checkpoint_bytes=?,phase='live',last_frame_seq=NULL,cycle_inputs_json=? WHERE binding_id=?",[high,new Uint8Array(raw),JSON.stringify(inputs),this.bindingId]);this.current(tx,generation);
      });
    }catch(e){this.end(generation,e instanceof Error?e.message:'PUBLIC_CHECKPOINT_FAILED');throw e;}
  }
  private recordGap(generation:string|null,gap:popclaw.world.IPublicStreamGap,raw:Uint8Array,request:PublicStreamRequest,startup:boolean):void{
    const decoded=decodePublicControl('public_gap',raw);
    if(!sameBytes(popclaw.world.PublicStreamGap.encode(decoded).finish(),popclaw.world.PublicStreamGap.encode(gap).finish()))throw new Error('PUBLIC_CONTROL_BYTES_MISMATCH');
    const g=decoded,reason=g.reason,lane=g.lane,scope=g.scopeId??'';
    if(!g.boundary)throw new Error('PUBLIC_GAP_BOUNDARY_MISSING');
    this.checkedBoundary(g.boundary,request,reason==='log_incarnation_changed');
    if(startup&&(reason!=='log_incarnation_changed'||lane!=='connection'))throw new Error('PUBLIC_STARTUP_GAP_INVALID');
    if(reason==='log_incarnation_changed'&&g.boundary.logIncarnation===request.incarnation)throw new Error('PUBLIC_GAP_LOG_UNCHANGED');
    if((lane==='scope'&&(!scope||!this.opts.selection.scopes.includes(scope)))||(lane!=='scope'&&scope)||(lane==='public'&&!this.opts.selection.fullPublic))throw new Error('PUBLIC_GAP_SELECTION_MISMATCH');
    const allowed:Record<string,readonly string[]>={unknown_scope:['scope'],cursor_ahead:['public','scope'],history_pruned:['public','scope'],log_incarnation_changed:['connection'],public_log_invalid:['public','scope','connection'],publication_index_inconsistent:['scope','connection']};
    if(!allowed[reason]?.includes(lane))throw new Error('PUBLIC_GAP_REASON_LANE_INVALID');
    this.opts.executionDb.transaction(tx=>{
      const row=this.current(tx,generation??undefined);if(startup)this.requestMatches(request);
      for(const target of this.lanes(tx).filter(l=>lane==='connection'||l.lane===lane&&(lane!=='scope'||l.scope_id===scope)))tx.execute('UPDATE world_public_cursors_v1 SET stale=1,gap_reason=? WHERE binding_id=? AND log_incarnation=? AND lane=? AND scope_id=?',[reason,this.bindingId,row.active_log,target.lane,target.scope_id]);
      tx.execute("UPDATE world_public_bindings_v1 SET generation=NULL,phase='gap',gap_bytes=?,error_code=? WHERE binding_id=?",[new Uint8Array(raw),reason,this.bindingId]);this.assertGate();
    });this.generation=null;this.failed=true;
  }
  startupGap(gap:popclaw.world.IPublicStreamGap,raw:Uint8Array,request:PublicStreamRequest):void{this.recordGap(null,gap,raw,request,true);}
  gap(generation:string,gap:popclaw.world.IPublicStreamGap,raw:Uint8Array):void{const row=this.current(this.opts.executionDb,generation);const inputs=JSON.parse(row.cycle_inputs_json) as PublicStreamRequest;this.recordGap(generation,gap,raw,inputs,false);}
  end(generation:string|null,errorCode='PUBLIC_STREAM_UNAVAILABLE'):void{
    if(generation!==this.generation)return;this.generation=null;this.failed=true;
    // Fence memory immediately. An obsolete owner never writes through a released handle.
    if(!this.active())return;
    try{this.opts.executionDb.transaction(tx=>{this.current(tx);tx.execute("UPDATE world_public_bindings_v1 SET generation=NULL,phase=CASE WHEN phase='gap' THEN 'gap' ELSE 'unavailable' END,error_code=CASE WHEN phase='gap' THEN error_code ELSE ? END WHERE binding_id=? AND (generation=? OR generation IS NULL)",[errorCode.slice(0,256),this.bindingId,generation]);});}catch{/* A failing store cannot restore this instance's live evidence. */}
  }
  receiveStatus():PublicReceiveStatus{
    const row=this.opts.executionDb.queryOne<PublicBindingRow>('SELECT * FROM world_public_bindings_v1 WHERE binding_id=?',[this.bindingId]);
    const lanes=this.lanes(this.opts.executionDb),live=this.active()&&!this.failed&&!!this.generation&&row?.generation===this.generation;
    return {bindingId:this.bindingId,logIncarnation:this.opts.capability.publicStream.log_incarnation,phase:live?row!.phase:row?.phase==='gap'?'gap':this.activated?'unavailable':'idle',connected:!!live,caughtUp:!!live&&row?.phase==='live'&&lanes.every(l=>!l.stale),publicAfter:lanes.find(l=>l.lane==='public')?.after_seq??null,scopes:lanes.filter(l=>l.lane==='scope').sort((a,b)=>a.scope_id<b.scope_id?-1:1).map(l=>({scopeId:l.scope_id,afterSeq:l.after_seq,stale:!!l.stale,gapReason:l.gap_reason})),checkpointHighWater:row?.checkpoint_h??null,replayHighWater:row?.replay_h??null,gapReason:row?.phase==='gap'?row.error_code:null,errorCode:row?.error_code??null};
  }
  consumerStatus(id:string):PublicConsumerStatus{
    const result:PublicConsumerStatus={consumerId:id,supported:this.opts.consumerContracts.some(c=>c.consumerId===id),pending:0,running:0,done:0,unsupported:0,notApplicable:0,refused:0};
    for(const row of this.opts.executionDb.queryAll<{state:string;count:number}>('SELECT state,COUNT(*) AS count FROM world_public_consumers_v1 WHERE binding_id=? AND consumer_id=? GROUP BY state',[this.bindingId,id])){const key=row.state==='not_applicable'?'notApplicable':row.state;if(key in result)(result as unknown as Record<string,unknown>)[key]=row.count;}
    return result;
  }
  private addConsumers(tx:HostDb,eventId:string):void{
    const restricted=tx.queryOne("SELECT 1 FROM world_public_imports_v1 WHERE binding_id=? AND event_id=? AND disposition='conflict'",[this.bindingId,eventId]);
    for(const c of this.opts.consumerContracts){
      const aliases=c.approvedLegacySourceIds.map(id=>tx.queryOne<{state:string}>('SELECT state FROM world_public_consumers_v1 WHERE binding_id=? AND event_id=? AND consumer_id=?',[this.bindingId,eventId,id]));
      const done=aliases.length>0&&aliases.every(r=>r?.state==='done');
      tx.execute('INSERT OR IGNORE INTO world_public_consumers_v1(binding_id,event_id,consumer_id,state,error_code,completion_source) VALUES(?,?,?,?,?,?)',[this.bindingId,eventId,c.consumerId,restricted?'unsupported':done?'done':'pending',restricted?'PUBLIC_IMPORT_BYTES_CONFLICT':null,done?'approved-legacy-alias':null]);
    }
  }
  private delivery(tx:HostDb,eventId:string):PublicDelivery{
    const row=tx.queryOne<{envelope:Uint8Array;current_projection:Uint8Array|null;projection_log:string|null;projection_seq:string|null}>('SELECT * FROM world_public_events_v1 WHERE binding_id=? AND event_id=?',[this.bindingId,eventId]);
    if(!row)throw new Error('PUBLIC_EVENT_MISSING');
    const verified=verifyPublicEnvelope(new Uint8Array(row.envelope),this.opts.producerPolicy);if(verified.eventId!==eventId)throw new Error('PUBLIC_STORED_CID_MISMATCH');
    const current=row.projection_log===this.opts.capability.publicStream.log_incarnation&&row.current_projection;
    const frame=current?tx.queryOne<{observed_at:number;frame_bytes:Uint8Array}>('SELECT observed_at,frame_bytes FROM world_public_frames_v1 WHERE binding_id=? AND log_incarnation=? AND seq=? AND event_id=?',[this.bindingId,row.projection_log,row.projection_seq,eventId]):null;
    if(current&&frame){inspectPublicCarrier(frame.frame_bytes,'frame');inspectPublicCarrier(current,'projection',true);}
    return {bindingId:this.bindingId,eventId,envelope:new Uint8Array(row.envelope),...(current&&frame?{projection:popclaw.event.WorldFeedItem.decode(current),observedAt:frame.observed_at}:{})};
  }
  runConsumers(consumers:readonly PublicConsumer[],signal:AbortSignal):Promise<void>{
    if(this.running)return this.running;
    if(contractsJson(consumers.map(c=>c.contract))!==contractsJson(this.opts.consumerContracts)||consumers.some(c=>c.mode!==c.contract.effectMode))return Promise.reject(new Error('PUBLIC_CONSUMER_MAPPING_MISMATCH'));
    const run=this.consumerPass(consumers,signal);this.running=run;void run.finally(()=>{if(this.running===run)this.running=null;}).catch(()=>{});return run;
  }
  private async consumerPass(consumers:readonly PublicConsumer[],signal:AbortSignal):Promise<void>{
    // Per-consumer keyset scanning lets later rows progress after an earlier failure.
    await Promise.all(consumers.map(async consumer=>{
      let after='';
      while(this.active()&&!signal.aborted){
        const rows=this.opts.executionDb.queryAll<{event_id:string}>("SELECT event_id FROM world_public_consumers_v1 WHERE binding_id=? AND consumer_id=? AND state='pending' AND event_id>? ORDER BY event_id LIMIT 64",[this.bindingId,consumer.contract.consumerId,after]);
        if(!rows.length)return;
        for(const row of rows){
          after=row.event_id;if(!this.active()||signal.aborted)return;
          const token=globalThis.crypto.randomUUID(),resource=this.generation??'idle';
          try{
            let delivery:PublicDelivery|undefined;
            this.opts.executionDb.transaction(tx=>{
              this.current(tx);if(signal.aborted)throw new Error('PUBLIC_CONSUMER_ABORTED');
              const pending=tx.queryOne<{state:string}>('SELECT state FROM world_public_consumers_v1 WHERE binding_id=? AND event_id=? AND consumer_id=?',[this.bindingId,row.event_id,consumer.contract.consumerId]);if(pending?.state!=='pending')return;
              delivery=this.delivery(tx,row.event_id);const selected=consumer.select(delivery);
              this.current(tx);if(signal.aborted)throw new Error('PUBLIC_CONSUMER_ABORTED');
              if(selected!=='accept'){
                if(selected!=='unsupported'&&selected!=='not_applicable')throw new Error('PUBLIC_CONSUMER_SELECTION_INVALID');
                tx.execute('UPDATE world_public_consumers_v1 SET state=? WHERE binding_id=? AND event_id=? AND consumer_id=?',[selected,this.bindingId,row.event_id,consumer.contract.consumerId]);delivery=undefined;return;
              }
              tx.execute("UPDATE world_public_consumers_v1 SET state='running',attempt_token=?,resource_generation=?,attempts=attempts+1,error_code=NULL WHERE binding_id=? AND event_id=? AND consumer_id=?",[token,resource,this.bindingId,row.event_id,consumer.contract.consumerId]);
              if(consumer.mode==='same-db'){
                const result:unknown=consumer.apply(tx,delivery);if(result&&typeof (result as unknown as {then?:unknown}).then==='function')throw new Error('PUBLIC_CONSUMER_ASYNC_SQL_FORBIDDEN');
                this.current(tx);if(signal.aborted)throw new Error('PUBLIC_CONSUMER_ABORTED');this.done(tx,row.event_id,consumer.contract.consumerId,token);delivery=undefined;
              }
            });
            if(delivery&&consumer.mode==='idempotent-effect'){
              this.current(this.opts.executionDb);if(signal.aborted)throw new Error('PUBLIC_CONSUMER_ABORTED');
              await consumer.deliver(delivery,{idempotencyKey:JSON.stringify([this.bindingId,row.event_id,consumer.contract.consumerId]),signal});
              this.opts.executionDb.transaction(tx=>{this.current(tx);if(signal.aborted)throw new Error('PUBLIC_CONSUMER_ABORTED');if(this.generation!==resource&&!(resource==='idle'&&this.generation===null))throw new Error('PUBLIC_CONSUMER_GENERATION_OBSOLETE');this.done(tx,row.event_id,consumer.contract.consumerId,token);});
            }
          }catch(e){
            if(!this.active())return;
            // A declared refusal leaves the retry here, under its own name.
            // Every other failure takes the unchanged pending statement.
            const refused=e instanceof PublicConsumerRefusal&&(PUBLIC_CONSUMER_REFUSALS as readonly string[]).includes(e.code)?e.code:null;
            this.opts.executionDb.transaction(tx=>{this.current(tx);tx.execute(refused
              ?"UPDATE world_public_consumers_v1 SET state='refused',attempt_token=NULL,resource_generation=NULL,error_code=? WHERE binding_id=? AND event_id=? AND consumer_id=? AND (attempt_token=? OR state='pending')"
              :"UPDATE world_public_consumers_v1 SET state='pending',attempt_token=NULL,resource_generation=NULL,error_code=? WHERE binding_id=? AND event_id=? AND consumer_id=? AND (attempt_token=? OR state='pending')",
              [refused??(e instanceof Error?e.message.slice(0,256):'PUBLIC_CONSUMER_FAILED'),this.bindingId,row.event_id,consumer.contract.consumerId,token]);});
          }
        }
      }
    }));
  }
  private done(tx:HostDb,eventId:string,consumerId:string,token:string):void{
    if(!tx.execute("UPDATE world_public_consumers_v1 SET state='done',attempt_token=NULL,error_code=NULL,completion_source='current-consumer' WHERE binding_id=? AND event_id=? AND consumer_id=? AND state='running' AND attempt_token=?",[this.bindingId,eventId,consumerId,token]).changes)throw new Error('PUBLIC_CONSUMER_CLAIM_OBSOLETE');
  }
}

/** Supplied only by the existing held maintenance owner. It checks the current
 * verified pin/view before and after synchronous cache writes, without granting
 * a receive, action or session gate. The caller owns the cache transaction. */
export type PublicProjectionRebuildOptions =
  | Readonly<{mode:'legacy'}>
  | Readonly<{mode:'public-v1';capability:VerifiedPublicStreamCapability;producerPolicy:VerifiedPublicProducerPolicy;assertCurrent():void}>;
export function rebuildPublicJournalProjection(
  db:HostDb,
  cache:Pick<import('../ingress/world-feed-cache.js').WorldFeedCache,'record'>,
  options?:PublicProjectionRebuildOptions,
):boolean {
  if(options?.mode==='legacy')return false;
  const exists=tableExists(db,'world_public_bindings_v1');
  if(!options){if(exists)throw new Error('PUBLIC_REBUILD_MODE_REQUIRED');return false;}
  if(options.mode!=='public-v1'||typeof options.assertCurrent!=='function')throw new Error('PUBLIC_REBUILD_TRUST_REQUIRED');
  const capability=structuredClone(options.capability),policy=structuredClone(options.producerPolicy);
  options.assertCurrent();verifyPublicStreamJournalSchema(db);
  const {binding}=checkedPreparation({executionDb:db,capability,producerPolicy:policy,selection:{fullPublic:true,scopes:[]},consumerContracts:[],approvedConsumerMappingDigest:EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST});
  const row=db.queryOne<PublicBindingRow>('SELECT * FROM world_public_bindings_v1 WHERE binding_id=?',[binding]);
  if(!row||row.origin!==capability.house.origin||row.house_key!==capability.house.houseKey||row.house_incarnation!==capability.house.incarnation||row.active_log!==capability.publicStream.log_incarnation||row.capability_revision!==capability.capabilityRevision)throw new Error('PUBLIC_REBUILD_CAPTURE_MISMATCH');
  assertCurrentPublicLogProfile(db,binding,capability);
  const newest=new Map<string,PublicDelivery>();
  const snapshots=db.queryAll<{event_id:string;envelope:Uint8Array;current_projection:Uint8Array;projection_seq:string}>(
    `SELECT event_id,envelope,current_projection,projection_seq FROM world_public_events_v1
     WHERE binding_id=? AND projection_log=? AND current_projection IS NOT NULL
     ORDER BY length(projection_seq),projection_seq COLLATE BINARY`,[binding,row.active_log]);
  for(const snapshot of snapshots){
    options.assertCurrent();
    const frame=db.queryOne<{frame_bytes:Uint8Array;observed_at:number}>('SELECT frame_bytes,observed_at FROM world_public_frames_v1 WHERE binding_id=? AND log_incarnation=? AND seq=? AND event_id=?',[binding,row.active_log,uint64(snapshot.projection_seq),snapshot.event_id]);
    if(!frame||!Number.isSafeInteger(frame.observed_at)||frame.observed_at<0)throw new Error('PUBLIC_REBUILD_FRAME_MISSING');
    const original=decodePublicFrame(new Uint8Array(frame.frame_bytes),policy);
    if(original.eventId!==snapshot.event_id||uint64(original.frame.seq)!==snapshot.projection_seq||!sameBytes(original.frame.envelope,snapshot.envelope))throw new Error('PUBLIC_REBUILD_FRAME_CONFLICT');
    // The first frame can omit a projection. A later checked non-null snapshot
    // may fill it, but cannot replace an already selected first snapshot.
    inspectPublicCarrier(snapshot.current_projection,'projection',true);
    const projection=popclaw.event.WorldFeedItem.decode(snapshot.current_projection);
    if(original.frame.projection&&!sameBytes(popclaw.event.WorldFeedItem.encode(original.frame.projection).finish(),popclaw.event.WorldFeedItem.encode(projection).finish()))throw new Error('PUBLIC_REBUILD_PROJECTION_CONFLICT');
    decodePublicFrame(popclaw.event.WorldStreamFrame.encode({...original.frame,projection}).finish(),policy);
    if(!projection.platform||!projection.platformPostId)throw new Error('PUBLIC_REBUILD_PROJECTION_INVALID');
    newest.set(JSON.stringify([projection.platform,projection.platformPostId]),{bindingId:binding,eventId:snapshot.event_id,envelope:new Uint8Array(snapshot.envelope),projection,observedAt:frame.observed_at});
  }
  // Validate all source rows before touching the cache. The held caller prevents
  // other writers; assertCurrent also catches reentrant invalidation at record.
  options.assertCurrent();
  for(const delivery of newest.values()){
    options.assertCurrent();cache.record({...delivery.projection!,envelope:delivery.envelope},undefined,delivery.observedAt);options.assertCurrent();
  }
  return true;
}
