import type { popclaw } from '@popclaw/contracts';
import manifestSchema from '@popclaw/contracts/world-interaction/manifest.schema.json';
import { cidFromCanonical } from '@popclaw/algorithms';
import Ajv2020 from 'ajv/dist/2020.js';
import type { HostDb } from '../host/host-db.js';
import type { WorldActionAuthority } from './action-client.js';
import { sameWorldHouse, worldKind, worldPublicKey, worldTime } from './action-wire.js';
import type { TrustedWorldCapabilities } from './world-capabilities.js';
import type { WorldParticipation, ParticipationInvocation } from './world-participation.js';
import type { WorldReadiness } from './world-readiness.js';
import { jsonObject } from './json-profile.js';

const ajv = new Ajv2020({ strict: false, validateSchema: false });
const boardShape = ajv.compile(manifestSchema);
const intentShape = ajv.compile({ ...manifestSchema, $ref: '#/$defs/intent_kind_entry', properties: undefined, required: undefined, additionalProperties: undefined });
const utf8 = new TextEncoder();
type Attempt = Parameters<WorldActionAuthority['check']>[0];
type CapabilitiesReader = () => TrustedWorldCapabilities | null;
function fail(code: string): never { throw new Error(code); }
function opaque(value: string): void { if (typeof value !== 'string' || !/^[A-Za-z0-9_./:-]{1,128}$/.test(value)) fail('AUTHORITY_ID_INVALID'); }
function requestId(value: string): void { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('REQUEST_ID_INVALID'); }
function revision(value: string): void { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('CAPABILITY_REVISION_MISMATCH'); }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
}
function epoch(timestamp: string): number {
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) fail('TIME_INVALID');
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== timestamp) fail('TIME_INVALID');
  return worldTime(ms / 1000);
}
function timestamp(now: number): string { return new Date(worldTime(now) * 1000).toISOString().replace('.000Z', 'Z'); }
function binding(house: popclaw.world.IHouseBinding, actorId: string): string {
  worldPublicKey(house.houseKey); worldPublicKey(actorId);
  if (typeof house.origin !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(house.origin) || !/^[A-Za-z0-9_-]{1,64}$/.test(house.incarnation ?? '')) fail('HOUSE_BINDING_INVALID');
  return canonical([house.origin, house.houseKey, house.incarnation, actorId]);
}
function sameDatabase(expected: HostDb, actual: HostDb): void { if (actual !== expected) fail('AUTHORITY_DATABASE_MISMATCH'); }

/** The reader must be the trusted capability store (including its active bit).
 * Recheck the complete board and exact guide bytes, never guide presence alone.
 * Manifest signatures/schema activation remain owned by WorldCapabilities. */
function currentCapabilities(read: CapabilitiesReader, house: popclaw.world.IHouseBinding, expectedRevision: string, kind: string): Record<string, unknown> {
  const caps = read();
  if (!caps || !caps.manifest || typeof caps.guide !== 'string') fail('CAPABILITY_CONTEXT_INCOMPLETE');
  if (!sameWorldHouse(caps.house, house) || caps.capabilityRevision !== expectedRevision) fail('CAPABILITY_REVISION_MISMATCH');
  if (!boardShape(caps.manifest.world_interaction)) fail('CAPABILITY_CONTEXT_INCOMPLETE');
  const board = jsonObject(caps.manifest.world_interaction);
  worldPublicKey(board.result_authority_pubkey);
  const guide = utf8.encode(caps.guide);
  if (guide.length > 524288 || cidFromCanonical(guide) !== jsonObject(board.guide).sha256) fail('GUIDE_DIGEST_MISMATCH');
  const entry = worldKind(caps, 'intent_kinds', kind);
  if (!intentShape(entry)) fail('CAPABILITY_CONTEXT_INCOMPLETE');
  return entry;
}
function checkAttempt(attempt: Attempt, kind: string, expiresAt: number, now: number, linkedRequestId?: string): void {
  if (attempt.kind !== kind) fail('ACTION_AUTHORITY_KIND_MISMATCH');
  const until = worldTime(attempt.validUntil);
  if (now >= expiresAt || now >= until || until > expiresAt || until > now + 300) fail('ACTION_EXPIRED');
  if (attempt.requestId !== undefined) {
    requestId(attempt.requestId);
    if (attempt.requestId !== linkedRequestId) fail('ACTION_AUTHORITY_REQUEST_MISMATCH');
  }
}

export interface ParticipationActionAuthorityOptions {
  db: HostDb; policy: WorldParticipation; house: popclaw.world.IHouseBinding; actorId: string; participationId: string;
  reservationId: string; jobId: string; invocation: ParticipationInvocation;
  capabilities: CapabilitiesReader; readiness: Pick<WorldReadiness, 'view' | 'assertBinding'>;
  supportsBackgroundTurns(): boolean; now(): number;
}

/** Trusted coordinator seam for manifest intents only. DM and notice egress
 * use their own paths and the exact WorldParticipation gate, not ActionClient.
 * ActionClient still owns captured G0 enabled/session checks around every await. */
export function createParticipationActionAuthority(options: ParticipationActionAuthorityOptions): WorldActionAuthority {
  const { db, policy, actorId, participationId, reservationId, jobId } = options;
  const house = clone(options.house), invocation = clone(options.invocation);
  binding(house, actorId); opaque(participationId); opaque(jobId);
  policy.assertDatabase(db);
  options.readiness.assertBinding(db, house, actorId);
  if (invocation.channel !== 'intent') fail('ACTION_CHANNEL_UNSUPPORTED');
  revision(invocation.expectedCapabilityRevision);
  const expiresAt = epoch(invocation.contextValidUntil);
  const check = (attempt: Attempt): void => {
    options.readiness.assertBinding(db, house, actorId);
    const now = worldTime(options.now());
    currentCapabilities(options.capabilities, house, invocation.expectedCapabilityRevision, invocation.kind);
    if (options.supportsBackgroundTurns() !== true) fail('HOST_BACKGROUND_UNSUPPORTED');
    const ready = options.readiness.view(participationId);
    if (ready.participation_id !== participationId || ready.ready !== true) fail('WORLD_NOT_READY');
    const facts = policy.facts();
    if (!facts || facts.actor_id !== actorId || facts.participation_id !== participationId || !sameWorldHouse({ origin: facts.house.origin, houseKey: facts.house.house_key, incarnation: facts.house.incarnation }, house)) fail('PARTICIPATION_BINDING_MISMATCH');
    const result = policy.authorizeReservation({ reservationId, jobId, invocation }, timestamp(now));
    if (!result.ok) fail(result.code);
    checkAttempt(attempt, invocation.kind, expiresAt, now, result.value.requestId);
  };
  return Object.freeze({ expiresAt, check,
    executionReference: Object.freeze({ kind: 'participation' as const, reservationId, jobId, participationId }),
    assertBinding(actualDb: HostDb, actualHouse: popclaw.world.IHouseBinding, actualActorId: string): void {
      if (actualDb !== db || !sameWorldHouse(actualHouse, house) || actualActorId !== actorId) fail('AUTHORITY_BINDING_MISMATCH');
    }, record(tx: HostDb, id: string): void {
    sameDatabase(db, tx); policy.assertDatabase(tx); requestId(id);
    check({ kind: invocation.kind, validUntil: expiresAt });
    const result = policy.associateRequest(reservationId, id);
    if (!result.ok) fail(result.code);
    check({ kind: invocation.kind, validUntil: expiresAt, requestId: id });
  } });
}

/** Trusted owner input only. Purpose=snapshot makes a kind a candidate; it
 * never creates this permission. The server's registered handler must be
 * read-only under the world contract. No grant is derived from agent JSON. */
export interface WorldReadStateGrant {
  participationId: string; kind: string; expectedCapabilityRevision: string; readOnly: true;
  expiresAt: number; rollingSeconds: number; maxPerRolling: number; maxTotal: number;
}
export interface WorldReadStateAuthority extends WorldActionAuthority {
  readonly reservationId: string; readonly participationId: string; readonly kind: string;
}
export interface WorldReadStateAuthorityOptions {
  db: HostDb; house: popclaw.world.IHouseBinding; actorId: string;
  capabilities: CapabilitiesReader; readiness: Pick<WorldReadiness, 'view' | 'recordRefresh' | 'assertBinding'>; now(): number;
}
interface ReadGrantRow { epoch: number; active: number; grant_json: string }
interface ReadReservationRow {
  reservation_id: string; participation_id: string; kind: string; job_id: string; capability_revision: string;
  grant_epoch: number; reserved_at: number; rolling_at: number; expires_at: number; request_id: string | null;
  status: 'reserved' | 'unknown' | 'succeeded' | 'rejected' | 'cancelled';
}
export interface ReadStateReservationInput { participationId: string; kind: string; jobId: string; expectedCapabilityRevision: string }

/** Explicit, durable housekeeping permission, separate from autonomous world
 * participation/manual controls. Every attempt occupies total and rolling
 * capacity before ActionClient can sign/send. Unknown or rejected attempts are
 * never refunded. Each check claims current rolling capacity for the same fixed
 * attempt, so an old queued job cannot dispatch alongside newly reserved jobs
 * after its first rolling window ages out. Total usage never resets. */
export class WorldReadStateAuthorityStore {
  private readonly db: HostDb;
  private readonly house: popclaw.world.IHouseBinding;
  private readonly actorId: string;
  private readonly scope: string;
  constructor(private readonly options: WorldReadStateAuthorityOptions) {
    this.db = options.db; this.house = clone(options.house); this.actorId = options.actorId; this.scope = binding(this.house, this.actorId);
    options.readiness.assertBinding(this.db, this.house, this.actorId);
    this.db.transaction(tx => {
      tx.execute(`CREATE TABLE IF NOT EXISTS world_read_state_grants (
        binding TEXT NOT NULL, participation_id TEXT NOT NULL, kind TEXT NOT NULL, epoch INTEGER NOT NULL,
        active INTEGER NOT NULL, grant_json TEXT NOT NULL, PRIMARY KEY(binding,participation_id,kind))`);
      tx.execute(`CREATE TABLE IF NOT EXISTS world_read_state_reservations (
        binding TEXT NOT NULL, reservation_id TEXT NOT NULL, participation_id TEXT NOT NULL, kind TEXT NOT NULL,
        job_id TEXT NOT NULL, capability_revision TEXT NOT NULL, grant_epoch INTEGER NOT NULL, reserved_at INTEGER NOT NULL, rolling_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL,
        PRIMARY KEY(binding,reservation_id), UNIQUE(binding,participation_id,kind,job_id), UNIQUE(binding,request_id))`);
    });
  }
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void {
    if (db !== this.db || !sameWorldHouse(house, this.house) || actorId !== this.actorId) fail('READ_STATE_BINDING_MISMATCH');
  }
  hasRequest(id: string): boolean {
    requestId(id);
    return this.db.queryOne('SELECT 1 FROM world_read_state_reservations WHERE binding=? AND request_id=?', [this.scope, id]) !== null;
  }
  private now(): number { return worldTime(this.options.now()); }
  private row(id: string, db = this.db): ReadReservationRow {
    const row = db.queryOne<ReadReservationRow>('SELECT * FROM world_read_state_reservations WHERE binding=? AND reservation_id=?', [this.scope, id]);
    if (!row) fail('READ_STATE_RESERVATION_UNKNOWN');
    return row;
  }
  private grantRow(participationId: string, kind: string, db = this.db): ReadGrantRow | null {
    return db.queryOne<ReadGrantRow>('SELECT epoch,active,grant_json FROM world_read_state_grants WHERE binding=? AND participation_id=? AND kind=?', [this.scope, participationId, kind]);
  }
  private candidate(kind: string, expectedRevision: string): void {
    revision(expectedRevision);
    if (currentCapabilities(this.options.capabilities, this.house, expectedRevision, kind).purpose !== 'snapshot') fail('READ_STATE_KIND_NOT_READ_ONLY');
  }
  grant(grant: WorldReadStateGrant): void {
    const fixed = clone(grant); opaque(fixed.participationId); this.candidate(fixed.kind, fixed.expectedCapabilityRevision);
    if (fixed.readOnly !== true || worldTime(fixed.expiresAt) <= this.now() || !Number.isSafeInteger(fixed.rollingSeconds) || fixed.rollingSeconds < 1 || fixed.rollingSeconds > 31536000) fail('READ_STATE_GRANT_INVALID');
    for (const count of [fixed.maxPerRolling, fixed.maxTotal]) if (!Number.isSafeInteger(count) || count < 0 || count > 1000000) fail('READ_STATE_GRANT_INVALID');
    this.db.transaction(tx => {
      const previous = this.grantRow(fixed.participationId, fixed.kind, tx);
      tx.execute(`INSERT INTO world_read_state_grants(binding,participation_id,kind,epoch,active,grant_json) VALUES(?,?,?,?,1,?)
        ON CONFLICT(binding,participation_id,kind) DO UPDATE SET epoch=excluded.epoch,active=1,grant_json=excluded.grant_json`,
      [this.scope, fixed.participationId, fixed.kind, (previous?.epoch ?? 0) + 1, JSON.stringify(fixed)]);
    });
  }
  revoke(participationId: string, kind: string): void {
    opaque(participationId);
    this.db.execute('UPDATE world_read_state_grants SET active=0,epoch=epoch+1 WHERE binding=? AND participation_id=? AND kind=?', [this.scope, participationId, kind]);
  }
  private allowed(participationId: string, kind: string, expectedRevision: string, now: number, db = this.db): { row: ReadGrantRow; grant: WorldReadStateGrant } {
    this.options.readiness.assertBinding(db, this.house, this.actorId);
    this.candidate(kind, expectedRevision);
    const row = this.grantRow(participationId, kind, db);
    if (!row?.active) fail('READ_STATE_GRANT_MISSING');
    const grant = JSON.parse(row.grant_json) as WorldReadStateGrant;
    if (grant.expectedCapabilityRevision !== expectedRevision || grant.readOnly !== true || now >= grant.expiresAt) fail('READ_STATE_GRANT_MISSING');
    const readiness = this.options.readiness.view(participationId);
    if (readiness.participation_id !== participationId || readiness.canRefresh !== true) fail('WORLD_REFRESH_NOT_READY');
    return { row, grant };
  }
  private budget(participationId: string, kind: string, grant: WorldReadStateGrant, units: number, now: number, db = this.db, claimReservationId?: string): void {
    const used = db.queryOne<{ total: number; rolling: number }>(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN rolling_at>? AND (? IS NULL OR reservation_id<>?) THEN 1 ELSE 0 END),0) AS rolling
      FROM world_read_state_reservations WHERE binding=? AND participation_id=? AND kind=?`,
    [now - grant.rollingSeconds, claimReservationId ?? null, claimReservationId ?? null, this.scope, participationId, kind])!;
    if (used.total + units > grant.maxTotal || used.rolling + (claimReservationId ? 1 : units) > grant.maxPerRolling) fail('READ_STATE_BUDGET_EXHAUSTED');
  }
  reserve(input: ReadStateReservationInput): WorldReadStateAuthority {
    const fixed = clone(input); opaque(fixed.participationId); opaque(fixed.jobId); revision(fixed.expectedCapabilityRevision);
    const id = canonical([this.scope, fixed.participationId, fixed.kind, fixed.jobId]);
    this.db.transaction(tx => {
      const now = this.now();
      const { row, grant } = this.allowed(fixed.participationId, fixed.kind, fixed.expectedCapabilityRevision, now, tx);
      const existing = tx.queryOne<ReadReservationRow>('SELECT * FROM world_read_state_reservations WHERE binding=? AND reservation_id=?', [this.scope, id]);
      if (existing) {
        if (existing.capability_revision !== fixed.expectedCapabilityRevision) fail('JOB_ID_CONFLICT');
        return;
      }
      this.budget(fixed.participationId, fixed.kind, grant, 1, now, tx);
      tx.execute(`INSERT INTO world_read_state_reservations(binding,reservation_id,participation_id,kind,job_id,capability_revision,grant_epoch,reserved_at,rolling_at,expires_at,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,'reserved')`, [this.scope, id, fixed.participationId, fixed.kind, fixed.jobId, fixed.expectedCapabilityRevision, row.epoch, now, now, Math.min(grant.expiresAt, now + 300)]);
    });
    return this.authority(id);
  }
  /** Recover the same attempt after restart; this does not allocate another unit. */
  authority(reservationId: string): WorldReadStateAuthority {
    const fixed = this.row(reservationId);
    const check = (attempt: Attempt): void => {
      this.db.transaction(tx => {
        const now = this.now(), reservation = this.row(reservationId, tx);
        const { row, grant } = this.allowed(fixed.participation_id, fixed.kind, fixed.capability_revision, now, tx);
        if (reservation.grant_epoch !== row.epoch) fail('READ_STATE_RESERVATION_CANCELLED');
        if (!['reserved', 'unknown'].includes(reservation.status)) fail('READ_STATE_RESERVATION_TERMINAL');
        this.budget(fixed.participation_id, fixed.kind, grant, 0, now, tx, reservationId);
        checkAttempt(attempt, fixed.kind, fixed.expires_at, now, reservation.request_id ?? undefined);
        tx.execute('UPDATE world_read_state_reservations SET rolling_at=? WHERE binding=? AND reservation_id=?', [now, this.scope, reservationId]);
      });
    };
    return Object.freeze({ reservationId, participationId: fixed.participation_id, kind: fixed.kind, expiresAt: fixed.expires_at, check,
      executionReference: Object.freeze({ kind: 'read_state' as const, reservationId, participationId: fixed.participation_id }),
      assertBinding: (db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void => this.assertBinding(db, house, actorId),
      record: (tx: HostDb, id: string): void => {
        sameDatabase(this.db, tx); requestId(id);
        check({ kind: fixed.kind, validUntil: fixed.expires_at });
        const current = this.row(reservationId, tx);
        if (current.request_id && current.request_id !== id) fail('ACTION_AUTHORITY_REQUEST_MISMATCH');
        const other = tx.queryOne<{ reservation_id: string }>('SELECT reservation_id FROM world_read_state_reservations WHERE binding=? AND request_id=?', [this.scope, id]);
        if (other && other.reservation_id !== reservationId) fail('ACTION_AUTHORITY_REQUEST_MISMATCH');
        tx.execute('UPDATE world_read_state_reservations SET request_id=? WHERE binding=? AND reservation_id=?', [id, this.scope, reservationId]);
        this.options.readiness.recordRefresh(tx, fixed.participation_id, id);
        check({ kind: fixed.kind, validUntil: fixed.expires_at, requestId: id });
      },
    });
  }
  /** Caller authenticates terminal results. No status refunds total/frequency usage. */
  settle(id: string, status: 'unknown' | 'succeeded' | 'rejected' | 'cancelled'): void {
    requestId(id);
    if (!['unknown', 'succeeded', 'rejected', 'cancelled'].includes(status)) fail('RESULT_INVALID');
    this.db.transaction(tx => {
      const row = tx.queryOne<ReadReservationRow>('SELECT * FROM world_read_state_reservations WHERE binding=? AND request_id=?', [this.scope, id]);
      if (!row) fail('READ_STATE_RESERVATION_UNKNOWN');
      if (!['reserved', 'unknown'].includes(row.status) && row.status !== status) fail('RESULT_CONFLICT');
      tx.execute('UPDATE world_read_state_reservations SET status=? WHERE binding=? AND reservation_id=?', [status, this.scope, row.reservation_id]);
    });
  }
  reservations(participationId: string): ReadonlyArray<ReadReservationRow> {
    opaque(participationId);
    return this.db.queryAll<ReadReservationRow>('SELECT * FROM world_read_state_reservations WHERE binding=? AND participation_id=? ORDER BY reserved_at,reservation_id', [this.scope, participationId]);
  }
}
