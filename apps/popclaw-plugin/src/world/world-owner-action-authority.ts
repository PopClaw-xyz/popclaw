import { actionRequestDigest } from './action-request-digest.js';
import { isActionReceiptProfile, isNativeActionReceiptProfile } from './action-receipt-journal.js';
import { decodeEnvelope } from '../protocol/public-envelope.js';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';
import { copyActionSelectionEvidence, decodeActionSelectionEvidence, type SelectedActionContext, type OriginalActionAccountingInput, type WorldActionAuthority, type WorldInvokeInput } from './action-client.js';
import { assertActionReceiptJournalSchema, canonicalActionJson, type ActionReceiptPartition } from './action-receipt-journal.js';
import { sameWorldHouse, worldPublicKey, worldTime, canonicalWorldCore } from './action-wire.js';
import { jsonObject, parseWorldJson } from './json-profile.js';
import type { TrustedWorldCapabilities } from './world-capabilities.js';

const utf8 = new TextEncoder();
function fail(code: string): never { throw new Error(code); }
function requestId(id: string): void { if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) fail('REQUEST_ID_INVALID'); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function fixedInput(input: WorldInvokeInput): WorldInvokeInput {
  if (!input || Object.keys(input).sort().join() !== 'expected_capability_revision,house,kind,params' || typeof input.house !== 'string' || typeof input.kind !== 'string' ||
    typeof input.expected_capability_revision !== 'string' || !/^[0-9a-f]{64}$/.test(input.expected_capability_revision)) fail('INVOKE_INPUT_INVALID');
  const params = jsonObject(parseWorldJson(utf8.encode(JSON.stringify(jsonObject(input.params))), 16384));
  return { house: input.house, kind: input.kind, params, expected_capability_revision: input.expected_capability_revision };
}
/** What the owner means by "the same thing they already asked for": this house,
 * this action kind, these parameters. The capability revision is deliberately
 * left out — it is a protocol binding detail, and a house that rotates its
 * capability document between the first ask and the second must not thereby
 * make the earlier request invisible to the duplicate warning. */
function twinKey(input: WorldInvokeInput): string {
  return canonical({ house: input.house, kind: input.kind, params: input.params });
}
export interface WorldOwnerActionAuthorityOptions {
  db: HostDb; house: popclaw.world.IHouseBinding; actorId: string;
  capabilities?(): TrustedWorldCapabilities | null;
  expectedPartition?: ActionReceiptPartition;
  captureSelectedActionContext?(kind: string): SelectedActionContext;
  now(): number;
}
/** Only a separately verified human authorization adapter may reserve. jobId identifies
 * the one explicit human action and must stay stable across command recovery. */
export interface WorldOwnerActionReservationInput { jobId: string; input: WorldInvokeInput; expiresAt: number }
export interface WorldOwnerActionAuthority extends WorldActionAuthority {
  readonly reservationId: string;
  assertInput(input: WorldInvokeInput): void;
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void;
}
interface Reservation {
  reservation_id: string; job_id: string; input_json: string; reserved_at: number; expires_at: number;
  request_id: string | null; status: 'reserved' | 'unknown' | 'succeeded' | 'rejected' | 'cancelled';
}

/** Trusted operator capability, never an agent tool, JSON grant, or sessionKey.
 * The G0 operator entry point alone holds this store; each reserve call represents
 * one explicit human action. No descriptor/manifest auto-creates permission.
 * One stable job permanently occupies one request slot, including unknown or
 * failed attempts. Retry uses the original client SignedPayload and never mints
 * new context. This generic manual path requires no prior participation, so it
 * can join a world; it does not grant autonomous turns or read-state refreshes. */
export class WorldOwnerActionAuthorityStore {
  private readonly db: HostDb;
  private readonly house: popclaw.world.IHouseBinding;
  private readonly actorId: string;
  private readonly scope: string;
  private readonly captureSelected: WorldOwnerActionAuthorityOptions['captureSelectedActionContext'];
  private readonly clock: WorldOwnerActionAuthorityOptions['now'];
  constructor(options: WorldOwnerActionAuthorityOptions) {
    this.db = options.db; this.house = JSON.parse(JSON.stringify(options.house)); this.actorId = options.actorId;
    this.captureSelected = options.captureSelectedActionContext; this.clock = options.now;
    worldPublicKey(this.house.houseKey); worldPublicKey(this.actorId);
    if (typeof this.house.origin !== 'string' || !/^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(this.house.origin) || !/^[A-Za-z0-9_-]{1,64}$/.test(this.house.incarnation ?? '')) fail('HOUSE_BINDING_INVALID');
    this.scope = canonical([this.house.origin, this.house.houseKey, this.house.incarnation, this.actorId]);
    if (!options.expectedPartition || options.expectedPartition.origin !== this.house.origin || options.expectedPartition.actorId !== this.actorId) fail('ACTION_RECEIPT_PARTITION_REQUIRED');
    assertActionReceiptJournalSchema(this.db, options.expectedPartition);
  }

  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void {
    if (db !== this.db || !sameWorldHouse(house, this.house) || actorId !== this.actorId) fail('OWNER_ACTION_BINDING_MISMATCH');
  }
  private now(): number { return worldTime(this.clock()); }
  private current(input: WorldInvokeInput): void {
    if (input.house !== this.house.origin) fail('OWNER_ACTION_BINDING_MISMATCH');
    if (!this.captureSelected) fail('ACTION_SELECTION_REQUIRED');
    const selected = this.captureSelected(input.kind); selected.assertCurrent();
    const evidence = copyActionSelectionEvidence(selected.evidence);
    if (!sameWorldHouse(evidence.house, this.house) || evidence.actorId !== this.actorId || evidence.capabilityRevision !== input.expected_capability_revision || evidence.kind !== input.kind) fail('CAPABILITY_REVISION_MISMATCH');
    if (evidence.allowed.length || evidence.requiredOnSuccess.length || evidence.consistency !== 'none') fail('ACTION_KIND_UNSUPPORTED');
    selected.assertCurrent();
  }
  private row(id: string, db = this.db): Reservation {
    requestId(id);
    const row = db.queryOne<Reservation>('SELECT * FROM world_owner_action_reservations WHERE binding=? AND reservation_id=?', [this.scope, id]);
    if (!row) fail('OWNER_ACTION_RESERVATION_UNKNOWN');
    return row;
  }
  reserve(input: WorldOwnerActionReservationInput): WorldOwnerActionAuthority {
    if (typeof input.jobId !== 'string' || !/^[A-Za-z0-9_./:-]{1,128}$/.test(input.jobId)) fail('OWNER_ACTION_JOB_INVALID');
    const fixed = fixedInput(input.input), text = canonical(fixed), jobId = input.jobId, expiresAt = worldTime(input.expiresAt), now = this.now();
    if (expiresAt <= now || expiresAt > now + 300) fail('ACTION_EXPIRED');
    this.current(fixed);
    const id = cidFromCanonical(utf8.encode(canonical([this.scope, jobId])));
    this.db.transaction(tx => {
      const previous = tx.queryOne<Reservation>('SELECT * FROM world_owner_action_reservations WHERE binding=? AND reservation_id=?', [this.scope, id]);
      if (previous) {
        if (previous.input_json !== text || previous.expires_at !== expiresAt) fail('OWNER_ACTION_JOB_CONFLICT');
        if (!['reserved', 'unknown'].includes(previous.status)) fail('OWNER_ACTION_RESERVATION_TERMINAL');
        return;
      }
      tx.execute(`INSERT INTO world_owner_action_reservations(binding,reservation_id,job_id,input_json,reserved_at,expires_at,status)
        VALUES(?,?,?,?,?,?,'reserved')`, [this.scope, id, jobId, text, now, expiresAt]);
    });
    return this.authority(id);
  }
  authority(reservationId: string): WorldOwnerActionAuthority {
    const fixed = this.row(reservationId), input = JSON.parse(fixed.input_json) as WorldInvokeInput;
    const check: WorldActionAuthority['check'] = attempt => {
      const row = this.row(reservationId), now = this.now(), until = worldTime(attempt.validUntil);
      this.current(input);
      if (!['reserved', 'unknown'].includes(row.status)) fail('OWNER_ACTION_RESERVATION_TERMINAL');
      if (attempt.kind !== input.kind) fail('ACTION_AUTHORITY_KIND_MISMATCH');
      if (now >= fixed.expires_at || now >= until || until > fixed.expires_at || until > now + 300) fail('ACTION_EXPIRED');
      if (attempt.requestId !== undefined) {
        requestId(attempt.requestId);
        if (attempt.requestId !== row.request_id) fail('ACTION_AUTHORITY_REQUEST_MISMATCH');
      }
    };
    return Object.freeze({ reservationId, expiresAt: fixed.expires_at,
      executionReference: Object.freeze({ kind: 'owner_action' as const, reservationId }),
      assertBinding: (db: HostDb, house: popclaw.world.IHouseBinding, actorId: string) => this.assertBinding(db, house, actorId),
      assertInput(candidate: WorldInvokeInput): void {
        if (canonical(fixedInput(candidate)) !== fixed.input_json) fail('OWNER_ACTION_INPUT_MISMATCH');
      }, check,
      record: (tx: HostDb, id: string): void => {
        if (tx !== this.db) fail('OWNER_ACTION_BINDING_MISMATCH');
        requestId(id);
        check({ kind: input.kind, validUntil: fixed.expires_at });
        const row = this.row(reservationId, tx);
        if (row.request_id && row.request_id !== id) fail('ACTION_AUTHORITY_REQUEST_MISMATCH');
        const other = tx.queryOne<{ reservation_id: string }>('SELECT reservation_id FROM world_owner_action_reservations WHERE binding=? AND request_id=?', [this.scope, id]);
        if (other && other.reservation_id !== reservationId) fail('ACTION_AUTHORITY_REQUEST_MISMATCH');
        tx.execute('UPDATE world_owner_action_reservations SET request_id=? WHERE binding=? AND reservation_id=?', [id, this.scope, reservationId]);
      },
    });
  }
  hasRequest(id: string): boolean {
    requestId(id);
    return this.db.queryOne('SELECT 1 FROM world_owner_action_reservations WHERE binding=? AND request_id=?', [this.scope, id]) !== null;
  }
  /** Request ids of earlier reservations for the same action that have not
   * reached a terminal status, oldest first. Read-only: it reserves nothing,
   * sends nothing and grants nothing — the owner confirmation dialog asks it so
   * that a second ask can say it is a second action.
   * "The same action" is `twinKey`: house, kind and parameters, deliberately
   * NOT the capability revision. Scoping to this house binding and this actor
   * stays where it was, in the SQL `binding` column.
   * A reservation with no request id never occupied a request slot, so nothing
   * was ever sent for it and there is nothing to query; it is not an unresolved
   * REQUEST and is left out. */
  unresolvedRequests(input: WorldInvokeInput): readonly string[] {
    const wanted = twinKey(fixedInput(input));
    return this.reservations()
      .filter(row => ['reserved', 'unknown'].includes(row.status) && row.request_id
        && twinKey(JSON.parse(row.input_json) as WorldInvokeInput) === wanted)
      .map(row => row.request_id!);
  }
  settle(id: string, status: Reservation['status']): void {
    requestId(id);
    if (!['unknown', 'succeeded', 'rejected', 'cancelled'].includes(status)) fail('RESULT_INVALID');
    this.db.transaction(tx => {
      const row = tx.queryOne<Reservation>('SELECT * FROM world_owner_action_reservations WHERE binding=? AND request_id=?', [this.scope, id]);
      if (!row) fail('OWNER_ACTION_RESERVATION_UNKNOWN');
      if (!['reserved', 'unknown'].includes(row.status) && row.status !== status) fail('RESULT_CONFLICT');
      tx.execute('UPDATE world_owner_action_reservations SET status=? WHERE binding=? AND reservation_id=?', [status, this.scope, row.reservation_id]);
    });
  }
  /** Called inside the receipt owner's transaction, under G0's original-accounting
   * hold checks. Expiry is irrelevant to settling this existing immutable fact. */
  settleOriginal(tx: HostDb, input: OriginalActionAccountingInput): {outcome:'applied'|'already_applied';reservationId:string} {
    this.assertBinding(tx, input.house, input.actorId);
    const reference = input.executionReference;
    if (reference.kind !== 'owner_action') fail('ORIGINAL_ACCOUNTING_UNSUPPORTED');
    const reservation = this.row(reference.reservationId, tx);
    if (reservation.request_id !== input.requestId || canonical(fixedInput(input.input)) !== reservation.input_json) fail('OWNER_ACTION_INPUT_MISMATCH');
    const request = tx.queryOne<{request_bytes:Uint8Array;request_digest:string;execution_reference:string|null;original_context:Uint8Array|null;receipt_profile:string|null}>(
      'SELECT * FROM world_action_client_requests WHERE binding=? AND request_id=?', [this.scope,input.requestId]);
    if (!request?.original_context || !isActionReceiptProfile(request.receipt_profile) || isNativeActionReceiptProfile(request.receipt_profile) || !request.execution_reference) fail('OWNER_ACTION_REQUEST_MISSING');
    if (canonicalActionJson(JSON.parse(request.execution_reference)) !== canonicalActionJson(reference) || cidFromCanonical(input.requestBytes) !== request.request_digest
      || actionRequestDigest(request) !== input.requestDigest) fail('OWNER_ACTION_REQUEST_MISMATCH');
    const evidence = decodeActionSelectionEvidence(request.original_context);
    const envelope = decodeEnvelope(popclaw.identity.SignedPayload.decode(request.request_bytes).payload);
    const intent = envelope.intent, context = intent?.context;
    if (envelope.eventId !== input.requestId || envelope.actor?.popclawId !== this.actorId || !intent?.params || !context
      || intent.intentKind !== evidence.kind || context.capabilityRevision !== evidence.capabilityRevision || context.schemaVersion !== evidence.schemaVersion
      || context.houseOrigin !== this.house.origin || context.houseKey !== this.house.houseKey || context.incarnation !== this.house.incarnation
      || canonicalActionJson(jsonObject(parseWorldJson(intent.params,16384))) !== canonicalActionJson(input.input.params)) fail('OWNER_ACTION_REQUEST_MISMATCH');
    const result = input.result;
    if (!sameWorldHouse(result.house,this.house) || result.actorId !== this.actorId || result.audienceId !== this.actorId || result.requestId !== input.requestId
      || result.requestDigest !== input.requestDigest || result.capabilityRevision !== evidence.capabilityRevision || result.kind !== evidence.kind || result.schemaVersion !== evidence.schemaVersion
      || cidFromCanonical(canonicalWorldCore(popclaw.world.ActionResult,result)) !== input.semanticDigest || ![3,4,5].includes(result.status)) fail('OWNER_ACTION_RESULT_MISMATCH');
    const status = result.status === 3 ? 'succeeded' : result.status === 4 ? 'rejected' : 'cancelled';
    if (reservation.status === status) return {outcome:'already_applied',reservationId:reference.reservationId};
    if (!['reserved','unknown'].includes(reservation.status)) fail('RESULT_CONFLICT');
    const changed = tx.execute('UPDATE world_owner_action_reservations SET status=? WHERE binding=? AND reservation_id=? AND request_id=?', [status,this.scope,reference.reservationId,input.requestId]);
    if (changed.changes !== 1) fail('OWNER_ACTION_RESERVATION_UNKNOWN');
    return {outcome:'applied',reservationId:reference.reservationId};
  }
  reservations(): ReadonlyArray<Reservation> {
    return this.db.queryAll<Reservation>('SELECT * FROM world_owner_action_reservations WHERE binding=? ORDER BY reserved_at,reservation_id', [this.scope]);
  }
}
