import { actionRequestDigest } from './action-request-digest.js';
import { isActionReceiptProfile, isNativeActionReceiptProfile } from './action-receipt-journal.js';
import { decodeEnvelope } from '../protocol/public-envelope.js';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';
import type { NativeWorldExecutionPermit } from '../host/openclaw-world-execution.js';
import { captureWorldCommandInput } from '../commands/popclaw-world.js';
import { WorldExecutionPolicy } from '../config/schema.js';
import { copyActionSelectionEvidence, decodeActionSelectionEvidence, type SelectedActionContext,
  type OriginalActionAccountingInput, type WorldActionAuthority, type WorldInvokeInput } from './action-client.js';
import { canonicalActionJson as canonical, type ActionReceiptPartition } from './action-receipt-journal.js';
import { assertNativeActionJournalSchema } from './native-action-journal.js';
import { canonicalWorldCore, sameWorldHouse, worldPublicKey, worldTime } from './action-wire.js';
import { jsonObject, parseWorldJson } from './json-profile.js';

export interface WorldNativeActionAuthority extends WorldActionAuthority {
  readonly reservationId: string;
  assertInput(input: WorldInvokeInput): void;
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void;
}
interface Reservation {
  binding: string; reservation_id: string; invocation_key: string; principal_json: string;
  policy_source_json: string; policy_revision: string; policy_scope_json: string; input_json: string;
  reserved_at: number; expires_at: number; request_id: string | null;
  status: 'reserved' | 'unknown' | 'succeeded' | 'rejected' | 'cancelled';
}
interface Options {
  db: HostDb; house: popclaw.world.IHouseBinding; actorId: string; expectedPartition: ActionReceiptPartition;
  captureSelectedActionContext(kind: string): SelectedActionContext;
  assertPermit(permit: NativeWorldExecutionPermit): void;
  now(): number;
}
const text = new TextEncoder();
function fail(code: string): never { throw new Error(code); }
function hashId(value: string): void { if (!/^[a-f0-9]{64}$/.test(value)) fail('NATIVE_ACTION_ID_INVALID'); }
const fixedInput = (value: unknown) => captureWorldCommandInput('invoke', value);
const proof = ({ request_id: _request, status: _status, ...value }: Reservation) => canonical(value);

/** Durable local-policy accounting, separate from manual owner actions. No constructor creates schema or grants. */
export class WorldNativeActionAuthorityStore {
  private readonly house: popclaw.world.IHouseBinding;
  private readonly binding: string;
  constructor(private readonly options: Options) {
    this.house = JSON.parse(canonical(options.house));
    worldPublicKey(options.actorId); worldPublicKey(this.house.houseKey);
    if (options.expectedPartition.origin !== this.house.origin || options.expectedPartition.actorId !== options.actorId) fail('NATIVE_ACTION_BINDING_MISMATCH');
    assertNativeActionJournalSchema(options.db, options.expectedPartition);
    this.binding = canonical([this.house.origin, this.house.houseKey, this.house.incarnation, options.actorId]);
  }
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void {
    if (db !== this.options.db || actorId !== this.options.actorId || !sameWorldHouse(house, this.house)) fail('NATIVE_ACTION_BINDING_MISMATCH');
  }
  private row(id: string, db = this.options.db): Reservation {
    hashId(id);
    const row = db.queryOne<Reservation>('SELECT * FROM world_native_action_reservations WHERE binding=? AND reservation_id=?', [this.binding, id]);
    if (!row) fail('NATIVE_ACTION_RESERVATION_UNKNOWN'); return row;
  }
  private selected(input: WorldInvokeInput): void {
    const selected = this.options.captureSelectedActionContext(input.kind); selected.assertCurrent();
    const evidence = copyActionSelectionEvidence(selected.evidence);
    if (!sameWorldHouse(evidence.house, this.house) || evidence.actorId !== this.options.actorId || input.house !== this.house.origin
      || evidence.kind !== input.kind || evidence.capabilityRevision !== input.expected_capability_revision) fail('CAPABILITY_REVISION_MISMATCH');
    if (evidence.allowed.length || evidence.requiredOnSuccess.length || evidence.consistency !== 'none') fail('ACTION_KIND_UNSUPPORTED');
    selected.assertCurrent();
  }
  reserve(permit: NativeWorldExecutionPermit): WorldNativeActionAuthority {
    this.options.assertPermit(permit);
    const input = fixedInput(permit.input), policy = WorldExecutionPolicy.parse(permit.policyScope);
    const now = worldTime(this.options.now());
    hashId(permit.invocationKey); hashId(permit.policyRevision);
    if (permit.principal.kind !== 'openclaw_agent' || permit.principal.actorId !== this.options.actorId
      || permit.principal.agentId !== policy.agentId || policy.actorId !== this.options.actorId || policy.house !== this.house.origin
      || !policy.kinds.includes(input.kind) || (policy.houseKey !== undefined && policy.houseKey !== this.house.houseKey)
      || permit.policySource.kind !== 'openclaw_runtime_config' || permit.policySource.path !== 'plugins.entries.popclaw.config.worldExecution') fail('NATIVE_POLICY_SCOPE_MISMATCH');
    if (worldTime(permit.reservedAt) > now || worldTime(permit.expiresAt) <= now || permit.expiresAt > permit.reservedAt + 300
      || permit.reservedAt < Date.parse(policy.authorizedAt) / 1000 || permit.expiresAt > Date.parse(policy.expiresAt) / 1000) fail('NATIVE_POLICY_EXPIRED');
    this.selected(input);
    const reservationId = cidFromCanonical(text.encode(canonical([this.binding, permit.invocationKey])));
    const initial: Reservation = { binding: this.binding, reservation_id: reservationId, invocation_key: permit.invocationKey,
      principal_json: canonical(permit.principal), policy_source_json: canonical(permit.policySource), policy_revision: permit.policyRevision,
      policy_scope_json: canonical(policy), input_json: canonical(input), reserved_at: permit.reservedAt, expires_at: permit.expiresAt,
      request_id: null, status: 'reserved' };
    this.options.db.transaction(tx => {
      this.options.assertPermit(permit); this.selected(input);
      const latest = tx.queryOne<{last: number | null}>('SELECT MAX(reserved_at) AS last FROM world_native_action_reservations');
      if (latest?.last !== null && latest?.last !== undefined && worldTime(latest.last) > permit.reservedAt) fail('NATIVE_CLOCK_ROLLBACK');
      const old = tx.queryOne<Reservation>('SELECT * FROM world_native_action_reservations WHERE binding=? AND reservation_id=?', [this.binding, reservationId]);
      if (old) {
        if (proof(old) !== proof(initial)) fail('NATIVE_INVOCATION_CONFLICT');
        if (!['reserved', 'unknown'].includes(old.status)) fail('NATIVE_ACTION_RESERVATION_TERMINAL');
      } else tx.execute(`INSERT INTO world_native_action_reservations
        (binding,reservation_id,invocation_key,principal_json,policy_source_json,policy_revision,policy_scope_json,input_json,reserved_at,expires_at,request_id,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,NULL,'reserved')`, [initial.binding, initial.reservation_id, initial.invocation_key, initial.principal_json,
        initial.policy_source_json, initial.policy_revision, initial.policy_scope_json, initial.input_json, initial.reserved_at, initial.expires_at]);
    });
    return this.authority(reservationId, permit);
  }
  /** A stored ID cannot recover authority without its still-live, genuinely issued permit. */
  authority(reservationId: string, permit: NativeWorldExecutionPermit): WorldNativeActionAuthority {
    this.options.assertPermit(permit);
    const saved = this.row(reservationId), input = fixedInput(JSON.parse(saved.input_json));
    if (saved.invocation_key !== permit.invocationKey || saved.policy_revision !== permit.policyRevision
      || saved.input_json !== canonical(fixedInput(permit.input)) || saved.principal_json !== canonical(permit.principal)
      || saved.policy_source_json !== canonical(permit.policySource) || saved.policy_scope_json !== canonical(permit.policyScope)
      || saved.reserved_at !== permit.reservedAt || saved.expires_at !== permit.expiresAt) fail('NATIVE_ACTION_PERMIT_MISMATCH');
    const check: WorldActionAuthority['check'] = attempt => {
      this.options.assertPermit(permit); this.selected(input);
      const current = this.row(reservationId), now = worldTime(this.options.now()), until = worldTime(attempt.validUntil);
      if (proof(current) !== proof(saved)) fail('NATIVE_ACTION_PROVENANCE_CHANGED');
      if (!['reserved', 'unknown'].includes(current.status)) fail('NATIVE_ACTION_RESERVATION_TERMINAL');
      if (attempt.kind !== input.kind) fail('ACTION_AUTHORITY_KIND_MISMATCH');
      if (now < saved.reserved_at || now >= until || until > saved.expires_at || until > now + 300) fail('NATIVE_POLICY_EXPIRED');
      if (attempt.requestId !== undefined && attempt.requestId !== current.request_id) fail('ACTION_AUTHORITY_REQUEST_MISMATCH');
    };
    return Object.freeze({ reservationId, expiresAt: saved.expires_at,
      executionReference: Object.freeze({ kind: 'native_policy' as const, reservationId }),
      assertBinding: this.assertBinding.bind(this),
      assertInput(candidate: WorldInvokeInput) { if (canonical(fixedInput(candidate)) !== saved.input_json) fail('NATIVE_ACTION_INPUT_MISMATCH'); },
      check,
      record: (tx: HostDb, id: string) => {
        this.assertBinding(tx, this.house, this.options.actorId); hashId(id); check({ kind: input.kind, validUntil: saved.expires_at });
        const row = this.row(reservationId, tx);
        if (row.request_id && row.request_id !== id) fail('ACTION_AUTHORITY_REQUEST_MISMATCH');
        tx.execute('UPDATE world_native_action_reservations SET request_id=? WHERE binding=? AND reservation_id=?', [id, this.binding, reservationId]);
      },
    });
  }
  settleOriginal(tx: HostDb, input: OriginalActionAccountingInput): { outcome: 'applied' | 'already_applied'; reservationId: string } {
    this.assertBinding(tx, input.house, input.actorId);
    const ref = input.executionReference;
    if (ref.kind !== 'native_policy') fail('ORIGINAL_ACCOUNTING_UNSUPPORTED');
    const row = this.row(ref.reservationId, tx);
    if (row.request_id !== input.requestId || row.input_json !== canonical(fixedInput(input.input))) fail('NATIVE_ACTION_INPUT_MISMATCH');
    const request = tx.queryOne<{ request_bytes: Uint8Array; request_digest: string; execution_reference: string | null;
      original_context: Uint8Array | null; receipt_profile: string | null }>('SELECT * FROM world_action_client_requests WHERE binding=? AND request_id=?', [this.binding, input.requestId]);
    if (!request?.original_context || !isActionReceiptProfile(request.receipt_profile) || !isNativeActionReceiptProfile(request.receipt_profile) || !request.execution_reference) fail('NATIVE_ACTION_REQUEST_MISSING');
    if (canonical(JSON.parse(request.execution_reference)) !== canonical(ref) || cidFromCanonical(input.requestBytes) !== request.request_digest
      || actionRequestDigest(request) !== input.requestDigest) fail('NATIVE_ACTION_REQUEST_MISMATCH');
    const evidence = decodeActionSelectionEvidence(request.original_context);
    const envelope = decodeEnvelope(popclaw.identity.SignedPayload.decode(request.request_bytes).payload);
    const intent = envelope.intent, context = intent?.context;
    if (envelope.eventId !== input.requestId || envelope.actor?.popclawId !== this.options.actorId || !intent?.params || !context
      || intent.intentKind !== evidence.kind || context.capabilityRevision !== evidence.capabilityRevision || context.schemaVersion !== evidence.schemaVersion
      || context.houseOrigin !== this.house.origin || context.houseKey !== this.house.houseKey || context.incarnation !== this.house.incarnation
      || canonical(jsonObject(parseWorldJson(intent.params, 16384))) !== canonical(input.input.params)) fail('NATIVE_ACTION_REQUEST_MISMATCH');
    const result = input.result;
    if (!sameWorldHouse(result.house, this.house) || result.actorId !== this.options.actorId || result.audienceId !== this.options.actorId
      || result.requestId !== input.requestId || result.requestDigest !== input.requestDigest || result.capabilityRevision !== evidence.capabilityRevision
      || result.kind !== evidence.kind || result.schemaVersion !== evidence.schemaVersion || ![3, 4, 5].includes(result.status)
      || cidFromCanonical(canonicalWorldCore(popclaw.world.ActionResult, result)) !== input.semanticDigest) fail('NATIVE_ACTION_RESULT_MISMATCH');
    const status = result.status === 3 ? 'succeeded' : result.status === 4 ? 'rejected' : 'cancelled';
    if (row.status === status) return { outcome: 'already_applied', reservationId: ref.reservationId };
    if (!['reserved', 'unknown'].includes(row.status)) fail('RESULT_CONFLICT');
    if (tx.execute('UPDATE world_native_action_reservations SET status=? WHERE binding=? AND reservation_id=? AND request_id=?',
      [status, this.binding, ref.reservationId, input.requestId]).changes !== 1) fail('NATIVE_ACTION_RESERVATION_UNKNOWN');
    return { outcome: 'applied', reservationId: ref.reservationId };
  }
}
