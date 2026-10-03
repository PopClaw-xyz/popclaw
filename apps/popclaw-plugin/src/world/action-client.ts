import { actionRequestDigest } from './action-request-digest.js';
import { decodeEnvelope } from '../protocol/public-envelope.js';
import { popclaw, isHouseSessionBoard } from '@popclaw/contracts';
import nacl from 'tweetnacl';
import Ajv2020 from 'ajv/dist/2020.js';
import actionSchema from '@popclaw/contracts/world-interaction/first-release-candidate/action-kind.schema.json';
import boardSchema from '@popclaw/contracts/world-interaction/first-release-candidate/board.schema.json';
import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';
import type { Signer } from '../identity/signer.js';
import { signEnvelope } from '../identity/sign-envelope.js';
import { jsonObject, parseWorldJson, parseWorldManifest, selectDeclaredRow } from './json-profile.js';
import { validateWorldPayload } from './schema-validator.js';
import { validateWorldSchema, type TrustedWorldCapabilities } from './world-capabilities.js';
import { canonicalActionJson, isActionReceiptProfile, isNativeActionReceiptProfile, ACTION_RECEIPT_PROFILES, PUBLIC_ENVELOPE_ACTION_RECEIPT_PROFILE, PUBLIC_ENVELOPE_NATIVE_ACTION_RECEIPT_PROFILE, assertActionReceiptJournalSchema, recordActionReceiptEvidence, encodeActionReceiptState, decodeActionReceiptState, type ActionReceiptStateV1, type ActionReceiptPartition } from './action-receipt-journal.js';
import { assertNativeActionJournalSchema } from './native-action-journal.js';
import { canonicalWorldCore, authenticateActionResult, inspectActionWire, extractActionStatusResponse, sameWorldHouse, verifyActionReceipt, verifySubscriptionObservation, worldKind, worldPublicKey, worldSigningInput, worldTime, worldUint64, type WorldSubscriptionQuery } from './action-wire.js';

export const ACTION_SELECTION_PROFILE = 'first-release-1ff7-action-v1' as const;
export type ActionAttachment = 'snapshot' | 'subscription' | 'participation';
export interface ActionSelectionEvidenceV1 {
  profile: typeof ACTION_SELECTION_PROFILE;
  house: { origin: string; houseKey: string; incarnation: string }; actorId: string;
  capabilityRevision: string; manifestBytes: Uint8Array; proofBytes: Uint8Array; guideBytes: Uint8Array; guideDigest: string;
  kind: string; schemaVersion: number; resultAuthorityKey: string;
  paramsSchema: Record<string, unknown>; resultSchema: Record<string, unknown>;
  allowed: ActionAttachment[]; requiredOnSuccess: ActionAttachment[]; consistency: 'none' | 'stream' | 'snapshot_barrier';
}
export interface SelectedActionContext { evidence: ActionSelectionEvidenceV1; assertCurrent(): void }
const contextUtf8 = new TextEncoder(), CONTEXT_MAX = 2097152;
const actionAjv = new Ajv2020({ strict: false, validateSchema: false });
const selectedKindShape = actionAjv.compile(actionSchema);
const selectedActionsShape = actionAjv.compile({ $defs: boardSchema.$defs, $ref: '#/$defs/actions' });
const selectedGuideShape = actionAjv.compile({ $defs: boardSchema.$defs, $ref: '#/$defs/guide' });
const selectedStreamShape = actionAjv.compile({ $defs: boardSchema.$defs, $ref: '#/$defs/public_stream' });
const evidenceKeys = ['actorId', 'allowed', 'capabilityRevision', 'consistency', 'guideBytes', 'guideDigest', 'house', 'kind', 'manifestBytes', 'paramsSchema', 'profile', 'proofBytes', 'requiredOnSuccess', 'resultAuthorityKey', 'resultSchema', 'schemaVersion'].sort();
function bytesBase64(value: Uint8Array): string {
  let text = ''; for (const byte of value) text += String.fromCharCode(byte); return btoa(text);
}
function evidenceObject(value: ActionSelectionEvidenceV1): Record<string, unknown> {
  return { ...value, manifestBytes: bytesBase64(value.manifestBytes), proofBytes: bytesBase64(value.proofBytes), guideBytes: bytesBase64(value.guideBytes) };
}
/** Own and cross-check an immutable interpretation. This is evidence validation,
 * never a currentness or human-authorization source. */
export function copyActionSelectionEvidence(value: ActionSelectionEvidenceV1): ActionSelectionEvidenceV1 {
  if (!value || typeof value !== 'object' || Reflect.ownKeys(value).some(key => typeof key !== 'string') || Object.keys(value).sort().join() !== evidenceKeys.join()
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d) || !d.enumerable)) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
  if (value.profile !== ACTION_SELECTION_PROFILE) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
  // A guide of zero bytes is a real guide. The house declares its digest in the
  // manifest and world-capabilities fetches it, checks that digest and checks
  // UTF-8 (world-capabilities.ts) — an empty body whose digest matches is an
  // authenticated statement that this house has nothing to say, not a missing
  // one. Refusing it here contradicted the fetch path, which accepts it.
  //
  // manifest and proof keep their floor: neither can be empty and still mean
  // anything, and both are what the digest and signature are computed over.
  for (const [field, limit, mayBeEmpty] of [['manifestBytes', 262144, false], ['proofBytes', 6144, false], ['guideBytes', 524288, true]] as const)
    if (!(value[field] instanceof Uint8Array) || (!mayBeEmpty && !value[field].length) || value[field].length > limit) throw new Error('ACTION_CONTEXT_SIZE_LIMIT');
  const plain = { ...value, manifestBytes: null, proofBytes: null, guideBytes: null };
  const owned = JSON.parse(canonicalActionJson(plain)) as ActionSelectionEvidenceV1;
  owned.manifestBytes = new Uint8Array(value.manifestBytes); owned.proofBytes = new Uint8Array(value.proofBytes); owned.guideBytes = new Uint8Array(value.guideBytes);
  const house = owned.house;
  if (!house || Object.keys(house).sort().join() !== 'houseKey,incarnation,origin' || new URL(house.origin).origin !== house.origin
    || !['https:', 'http:'].includes(new URL(house.origin).protocol) || !house.incarnation || house.incarnation.length > 128) throw new Error('HOUSE_BINDING_INVALID');
  worldPublicKey(house.houseKey); worldPublicKey(owned.actorId); worldPublicKey(owned.resultAuthorityKey);
  if (cidFromCanonical(owned.manifestBytes) !== owned.capabilityRevision) throw new Error('CAPABILITY_REVISION_MISMATCH');
  const sizes = new Map<string, number>();
  const document = parseWorldManifest(owned.manifestBytes, sizes), board = jsonObject(document.world_interaction), actions = jsonObject(board.actions);
  if (board.version !== 1 || !selectedActionsShape(actions) || !selectedGuideShape(board.guide) || !isHouseSessionBoard(document.house_session)) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
  if (!(actions.kinds as string[]).includes(owned.kind)) throw new Error('KIND_NOT_SELECTED');
  // Selection decides jurisdiction: an unselected sibling's oversized or deep
  // schema is outside it and cannot refuse this evidence.
  const selected = selectDeclaredRow(document, 'intent_kinds', owned.kind, sizes);
  if (!selected || !selectedKindShape(selected.row)) throw new Error('CAPABILITY_KIND_INVALID');
  const entry = selected.row, attachments = jsonObject(entry.result_attachments);
  const allowed = attachments.allowed as ActionAttachment[], required = attachments.required_on_success as ActionAttachment[];
  if (required.some(kind => !allowed.includes(kind)) || allowed.some(kind => !(actions.attachments as string[]).includes(kind))) throw new Error('ATTACHMENT_SET_INVALID');
  if ((entry.consistency === 'none' && allowed.includes('subscription')) || (entry.consistency !== 'none' && (!required.includes('subscription') || !selectedStreamShape(board.public_stream)))
    || (entry.consistency === 'snapshot_barrier' && !required.includes('snapshot'))) throw new Error('CONSISTENCY_INVALID');
  for (const key of ['allowed', 'requiredOnSuccess'] as const) {
    if (!Array.isArray(owned[key]) || new Set(owned[key]).size !== owned[key].length) throw new Error('ATTACHMENT_SET_INVALID'); owned[key].sort();
  }
  if (owned.schemaVersion !== entry.schema_version || owned.resultAuthorityKey !== actions.result_authority_pubkey || owned.consistency !== entry.consistency
    || canonicalActionJson(owned.allowed) !== canonicalActionJson([...allowed].sort()) || canonicalActionJson(owned.requiredOnSuccess) !== canonicalActionJson([...required].sort())
    || canonicalActionJson(owned.paramsSchema) !== canonicalActionJson(entry.params_schema) || canonicalActionJson(owned.resultSchema) !== canonicalActionJson(entry.result_schema)) throw new Error('ACTION_CONTEXT_MISMATCH');
  validateWorldSchema(owned.paramsSchema); validateWorldSchema(owned.resultSchema);
  if (owned.guideDigest !== jsonObject(board.guide).sha256 || cidFromCanonical(owned.guideBytes) !== owned.guideDigest) throw new Error('GUIDE_DIGEST_MISMATCH');
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(owned.guideBytes);
  inspectActionWire(owned.proofBytes, 'ManifestProof', 6144);
  const proof = popclaw.world.ManifestProof.decode(owned.proofBytes);
  if (!sameWorldHouse(proof.house, house) || proof.manifestDigest !== owned.capabilityRevision) throw new Error('MANIFEST_PROOF_BINDING_MISMATCH');
  worldTime(proof.signedAt);
  if (proof.authoritySignature.length !== 64 || !nacl.sign.detached.verify(worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1', canonicalWorldCore(popclaw.world.ManifestProof, { house: proof.house, manifestDigest: proof.manifestDigest, signedAt: proof.signedAt })), proof.authoritySignature, worldPublicKey(house.houseKey))) throw new Error('MANIFEST_PROOF_SIGNATURE_INVALID');
  if (contextUtf8.encode(canonicalActionJson(evidenceObject(owned))).length > CONTEXT_MAX) throw new Error('ACTION_CONTEXT_SIZE_LIMIT');
  return owned;
}
export function encodeActionSelectionEvidence(value: ActionSelectionEvidenceV1): Uint8Array {
  return contextUtf8.encode(canonicalActionJson(evidenceObject(copyActionSelectionEvidence(value))));
}
export function decodeActionSelectionEvidence(raw: Uint8Array): ActionSelectionEvidenceV1 {
  if (!(raw instanceof Uint8Array) || raw.length > CONTEXT_MAX) throw new Error('ACTION_CONTEXT_SIZE_LIMIT');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  const value = JSON.parse(text) as ActionSelectionEvidenceV1;
  if (canonicalActionJson(value) !== text) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
  for (const field of ['manifestBytes', 'proofBytes', 'guideBytes'] as const) {
    const encoded: unknown = value[field];
    if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
    const binary = atob(encoded); if (btoa(binary) !== encoded) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
    value[field] = Uint8Array.from(binary, char => char.charCodeAt(0));
  }
  return copyActionSelectionEvidence(value);
}
function evidenceCapabilities(evidence: ActionSelectionEvidenceV1): TrustedWorldCapabilities {
  // Raw-bounded whole document only: historical context, nothing interpreted.
  return { house: evidence.house, capabilityRevision: evidence.capabilityRevision, manifest: parseWorldManifest(evidence.manifestBytes), guide: new TextDecoder('utf-8', {fatal:true}).decode(evidence.guideBytes) };
}

export interface WorldActionGate { readonly origin: string; readonly signal: AbortSignal; isActive(): boolean }
/** Structural seam implemented by G0 captureSessionCommandContext. The captured
 * lease is never extended by a later session renewal. Times are epoch seconds. */
export interface WorldActionSession {
  readonly gate: WorldActionGate; readonly sessionId: string; readonly fence: string;
  readonly leaseExpiresAt: number; readonly installationId: string;
}
/** Trusted command/coordinator capability, never part of agent-facing JSON.
 * Autonomous callers bind checks to a durable reservation; owner commands bind
 * them to their human authorization. record runs in the request's transaction. */
/** Durable lookup identity only; the actual owner must resolve the original row
 * in the same actor/house database and recheck current authority at HTTP egress. */
export type WorldActionExecutionReference =
  | Readonly<{ kind: 'owner_action'; reservationId: string }>
  | Readonly<{ kind: 'native_policy'; reservationId: string }>
  | Readonly<{ kind: 'read_state'; reservationId: string; participationId: string }>
  | Readonly<{ kind: 'participation'; reservationId: string; jobId: string; participationId: string }>;
export interface WorldActionAuthority {
  readonly executionReference: WorldActionExecutionReference;
  readonly expiresAt: number;
  assertBinding?(db: HostDb, house: popclaw.world.IHouseBinding, actorId: string): void;
  assertInput?(input: WorldInvokeInput): void;
  check(attempt: { kind: string; requestId?: string; validUntil: number }): void;
  record(tx: HostDb, requestId: string): void;
}
export interface WorldInvokeInput {
  house: string; kind: string; params: Record<string, unknown>; expected_capability_revision: string;
}
export interface WorldActionView {
  request_id: string; status: 'unknown' | 'accepted' | 'executing' | 'succeeded' | 'rejected' | 'cancelled'; code: string;
  result?: popclaw.world.ActionResult; progress?: popclaw.world.SubscriptionObservation;
  house_status?: string; receipt_durable?: boolean; attachment_contract?: ActionReceiptStateV1['attachmentContract'];
  base_accounting?: ActionReceiptStateV1['baseAccounting']; attachments?: ActionReceiptStateV1['attachments']; installed_readiness?: false;
}
export interface OriginalActionAccountingInput {
  house: popclaw.world.IHouseBinding; actorId: string; requestId: string; requestDigest: string;
  requestBytes: Uint8Array; input: WorldInvokeInput; executionReference: WorldActionExecutionReference;
  result: popclaw.world.ActionResult; semanticDigest: string;
}
export interface OriginalActionAccounting {
  /** Synchronous selected-handle/maintenance/restore/ledger hold check. No grant renewal. */
  assertCurrent(): void;
  settle(tx: HostDb, input: OriginalActionAccountingInput): { outcome: 'applied' | 'already_applied'; reservationId: string };
}
interface Row {
  request_id: string; request_bytes: Uint8Array; request_digest: string; kind: string; schema_version: number;
  receipt_profile: string | null; original_context: Uint8Array | null;
  execution_reference: string | null; capabilities: string; valid_until: number; latest_result: Uint8Array | null; replacement_of: string | null;
}
export interface WorldActionClientOptions {
  db: HostDb; signer: Signer; actorId: string; house: popclaw.world.IHouseBinding;
  capabilities?(): TrustedWorldCapabilities;
  expectedPartition?: ActionReceiptPartition;
  captureSelectedActionContext?(kind: string): SelectedActionContext;
  accounting?: OriginalActionAccounting;
  captureSession(): WorldActionSession;
  /** Existing G0 bus-backed egress. HTTP success alone has no business meaning. */
  push(bytes: Uint8Array, context: { gate: WorldActionGate; requestId: string; executionReference: WorldActionExecutionReference }): Promise<{ signedActionResultBase64?: string }>;
  /** Explicit known-request control read, separately authorized even while the
   * house is disabled. This callback must not grant stream/invoke authority. */
  controlRead(requestId: string): WorldActionGate;
  readStatus(bytes: Uint8Array, context: { gate: WorldActionGate; requestId: string }): Promise<Uint8Array>;
  /** Historical constructor compatibility only; split receipts never call this aggregate consumer. */
  onResult?(result: popclaw.world.ActionResult): Promise<void> | void;
  /** Historical consumer compatibility only; observation installation is not selected. */
  onProgress?(bytes: Uint8Array, query: WorldSubscriptionQuery): Promise<void> | void;
  now?(): number;
}
const statuses = ['unknown', 'accepted', 'executing', 'succeeded', 'rejected', 'cancelled'] as const;
function base64Bytes(value: string): Uint8Array {
  if (value.length > 1398104 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('RESULT_ENCODING_INVALID');
  const raw = atob(value);
  if (btoa(raw) !== value || raw.length > 1048576) throw new Error('RESULT_ENCODING_INVALID');
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function executionReference(value: unknown): WorldActionExecutionReference {
  const invalid = () => { throw new Error('ACTION_EXECUTION_REFERENCE_REQUIRED'); };
  if (!value || typeof value !== 'object') return invalid();
  const fields = Object.getOwnPropertyDescriptors(value), kind = fields.kind?.value;
  const keys = kind === 'owner_action' || kind === 'native_policy' ? ['kind', 'reservationId'] : kind === 'read_state' ? ['kind', 'participationId', 'reservationId'] : kind === 'participation' ? ['jobId', 'kind', 'participationId', 'reservationId'] : null;
  if (!keys || Reflect.ownKeys(value).some(k => typeof k !== 'string') || Object.keys(fields).sort().join() !== keys.join()) return invalid();
  for (const key of keys) if (!('value' in fields[key]!) || typeof fields[key]!.value !== 'string' || !fields[key]!.value.length || fields[key]!.value.length > 16384) return invalid();
  const reservationId = fields.reservationId!.value as string;
  if (kind === 'native_policy' && !/^[0-9a-f]{64}$/.test(reservationId)) return invalid();
  if (kind === 'owner_action' || kind === 'native_policy') return Object.freeze({ kind, reservationId });
  const participationId = fields.participationId!.value as string;
  if (kind === 'read_state') return Object.freeze({ kind, reservationId, participationId });
  return Object.freeze({ kind: 'participation', reservationId, jobId: fields.jobId!.value as string, participationId });
}
function referenceJson(value: unknown): string { return JSON.stringify(executionReference(value)); }

/** Actor/house-bound durable action client. No runtime bootstrap or background
 * sends occur at import/construction. Original SignedPayload is the retry unit. */
export class WorldActionClient {
  private readonly pendingListeners = new Set<() => void>();
  private consumerGate: WorldActionGate | null = null;
  private readonly binding: string;
  private readonly house: popclaw.world.IHouseBinding;
  private readonly partition: ActionReceiptPartition;
  private dispatching: Promise<void> | null = null;
  constructor(private readonly options: WorldActionClientOptions) {
    this.house = clone(options.house);
    worldPublicKey(this.house.houseKey); worldPublicKey(options.actorId);
    const origin = this.house.origin;
    if (!origin || new URL(origin).origin !== origin || !['https:', 'http:'].includes(new URL(origin).protocol) || !this.house.incarnation) throw new Error('HOUSE_BINDING_INVALID');
    this.binding = JSON.stringify([origin, this.house.houseKey, this.house.incarnation, options.actorId]);
    if (!options.expectedPartition || options.expectedPartition.origin !== origin || options.expectedPartition.actorId !== options.actorId) throw new Error('ACTION_RECEIPT_PARTITION_REQUIRED');
    this.partition = {...options.expectedPartition};
    assertActionReceiptJournalSchema(options.db, this.partition);
  }

  private now(): number { return worldTime(this.options.now?.() ?? Math.floor(Date.now() / 1000)); }
  private gate(gate: WorldActionGate): void {
    if (gate.origin !== this.house.origin || gate.signal.aborted || !gate.isActive()) throw new Error('ACTION_GATE_CLOSED');
  }
  private row(requestId: string, db = this.options.db): Row {
    if (!/^[a-f0-9]{64}$/.test(requestId)) throw new Error('REQUEST_ID_INVALID');
    const row = db.queryOne<Row>('SELECT * FROM world_action_client_requests WHERE binding=? AND request_id=?', [this.binding, requestId]);
    if (!row) throw new Error('REQUEST_NOT_KNOWN');
    return row;
  }
  private identity(row: Row) {
    if (!isActionReceiptProfile(row.receipt_profile) || !row.original_context) throw new Error('ACTION_CONTEXT_UNSUPPORTED');
    const reference = row.execution_reference ? executionReference(JSON.parse(row.execution_reference)) : null;
    if (isNativeActionReceiptProfile(row.receipt_profile) !== (reference?.kind === 'native_policy')) throw new Error('ACTION_CONTEXT_MISMATCH');
    const selection = decodeActionSelectionEvidence(row.original_context);
    if (!sameWorldHouse(selection.house, this.house) || selection.actorId !== this.options.actorId || selection.kind !== row.kind || selection.schemaVersion !== row.schema_version) throw new Error('ACTION_CONTEXT_MISMATCH');
    return { receiptProfile: row.receipt_profile, actorId: this.options.actorId, requestId: row.request_id, requestDigest: actionRequestDigest(row),
      kind: row.kind, schemaVersion: row.schema_version, capabilities: evidenceCapabilities(selection), selection };
  }
  private capture(kind: string): SelectedActionContext {
    if (!this.options.captureSelectedActionContext) throw new Error('ACTION_SELECTION_REQUIRED');
    const captured = this.options.captureSelectedActionContext(kind);
    if (!captured || typeof captured.assertCurrent !== 'function') throw new Error('ACTION_SELECTION_REQUIRED');
    captured.assertCurrent();
    const evidence = copyActionSelectionEvidence(captured.evidence);
    if (!sameWorldHouse(evidence.house, this.house) || evidence.actorId !== this.options.actorId || evidence.kind !== kind) throw new Error('ACTION_CONTEXT_MISMATCH');
    // Only this base execution subset is implemented; receipts validate all shapes.
    if (evidence.allowed.length || evidence.requiredOnSuccess.length || evidence.consistency !== 'none') throw new Error('ACTION_KIND_UNSUPPORTED');
    return { evidence, assertCurrent: () => captured.assertCurrent() };
  }
  private assertEvidence(db: HostDb, requestId: string, semanticDigest: string): void {
    const evidence = db.queryAll<{source_kind:string;source_digest:string;source_bytes:Uint8Array;signed_result_bytes:Uint8Array}>('SELECT source_kind,source_digest,source_bytes,signed_result_bytes FROM world_action_client_evidence WHERE binding=? AND request_id=? AND core_digest=?', [this.binding,requestId,semanticDigest]);
    if (!evidence.length) throw new Error('ACTION_RECEIPT_MISSING');
    const identity = this.identity(this.row(requestId,db));
    for (const row of evidence) {
      if (!(row.source_bytes instanceof Uint8Array) || !(row.signed_result_bytes instanceof Uint8Array) || row.source_bytes.length > 1048576 || row.signed_result_bytes.length > 1048576 || cidFromCanonical(row.source_bytes) !== row.source_digest) throw new Error('ACTION_EVIDENCE_CONFLICT');
      const raw = row.source_kind === 'push_result' ? row.source_bytes : row.source_kind === 'status_response' ? extractActionStatusResponse(row.source_bytes).signedResultBytes : null;
      if (!raw || cidFromCanonical(raw) !== cidFromCanonical(row.signed_result_bytes)) throw new Error('ACTION_EVIDENCE_CONFLICT');
      const result = authenticateActionResult(row.signed_result_bytes,identity);
      if (cidFromCanonical(canonicalWorldCore(popclaw.world.ActionResult,result)) !== semanticDigest) throw new Error('ACTION_EVIDENCE_CONFLICT');
    }
  }
  private checkedSigner(check: () => void): Signer {
    const signer = this.options.signer;
    return {
      publicKey: async () => { check(); const key = await signer.publicKey(); check(); return key; },
      popclawId: async () => { check(); const actor = await signer.popclawId(); check(); if (actor !== this.options.actorId) throw new Error('ACTOR_MISMATCH'); return actor; },
      sign: async bytes => { check(); const signature = await signer.sign(bytes); check(); return signature; },
      sealDm: signer.sealDm.bind(signer), openDm: signer.openDm.bind(signer),
      sealDmMedia: signer.sealDmMedia.bind(signer), openDmMedia: signer.openDmMedia.bind(signer),
    };
  }
  private checkAuthority(authority: WorldActionAuthority, gate: WorldActionGate, kind: string, validUntil: number, requestId?: string): void {
    this.gate(gate);
    if (!authority || typeof authority.check !== 'function' || typeof authority.record !== 'function') throw new Error('ACTION_AUTHORITY_REQUIRED');
    if (executionReference(authority.executionReference).kind === 'native_policy') assertNativeActionJournalSchema(this.options.db, this.partition);
    authority.assertBinding?.(this.options.db, this.house, this.options.actorId);
    if (this.now() >= validUntil || this.now() >= worldTime(authority.expiresAt)) throw new Error('ACTION_EXPIRED');
    authority.check({ kind, validUntil, requestId });
  }
  async invoke(input: WorldInvokeInput, authority: WorldActionAuthority, replacementOf?: string): Promise<WorldActionView> {
    if (!input || Object.keys(input).sort().join() !== 'expected_capability_revision,house,kind,params' || input.house !== this.house.origin) throw new Error('INVOKE_INPUT_INVALID');
    if (!authority) throw new Error('ACTION_AUTHORITY_REQUIRED');
    const reference = referenceJson(authority.executionReference);
    const receiptProfile = authority.executionReference.kind === 'native_policy' ? PUBLIC_ENVELOPE_NATIVE_ACTION_RECEIPT_PROFILE : PUBLIC_ENVELOPE_ACTION_RECEIPT_PROFILE;
    const selected = this.capture(input.kind), caps = evidenceCapabilities(selected.evidence), originalContext = encodeActionSelectionEvidence(selected.evidence);
    if (!sameWorldHouse(caps.house, this.house) || input.expected_capability_revision !== caps.capabilityRevision) throw new Error('CAPABILITY_REVISION_MISMATCH');
    const kind = input.kind, entry = worldKind(caps, 'intent_kinds', kind);
    const params = new TextEncoder().encode(JSON.stringify(jsonObject(input.params)));
    jsonObject(parseWorldJson(params, 16384));
    const fixedInput: WorldInvokeInput = { house: this.house.origin!, kind, params: jsonObject(parseWorldJson(params, 16384)), expected_capability_revision: caps.capabilityRevision };
    authority.assertBinding?.(this.options.db, this.house, this.options.actorId);
    authority.assertInput?.(clone(fixedInput));
    const session = this.options.captureSession(), gate = session.gate;
    if (!session.sessionId || !session.fence || !session.installationId) throw new Error('SESSION_CONTEXT_INVALID');
    const validUntil = Math.min(worldTime(session.leaseExpiresAt), worldTime(authority.expiresAt), this.now() + 300);
    const check = () => {
      selected.assertCurrent();
      if (referenceJson(authority.executionReference) !== reference) throw new Error('ACTION_EXECUTION_REFERENCE_MISMATCH');
      this.checkAuthority(authority, gate, kind, validUntil); authority.assertInput?.(clone(fixedInput));
    };
    check();
    await validateWorldPayload(jsonObject(entry.params_schema), params, { maxBytes: 16384, signal: gate.signal });
    check();
    const version = entry.schema_version;
    if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 4294967295) throw new Error('SCHEMA_VERSION_INVALID');
    if (replacementOf) this.row(replacementOf);
    // Re-entering the same native call always reuses its original signed bytes.
    if (isNativeActionReceiptProfile(receiptProfile)) {
      const original = this.options.db.queryOne<Row>('SELECT * FROM world_action_client_requests WHERE binding=? AND execution_reference=?', [this.binding, reference]);
      if (original) return this.send(original, gate, authority, selected);
    }
    let collisionDeadline: number | undefined;
    for (;;) {
      check();
      if (collisionDeadline !== undefined && performance.now() >= collisionDeadline) throw new Error('ACTION_REQUEST_COLLISION_BUSY');
      const timestamp = this.now();
      const built = await signEnvelope(this.checkedSigner(check), {
        actor: { popclawId: this.options.actorId }, timestamp, lorehouse: this.house.origin,
        intent: { lorehouse: this.house.origin, intentKind: kind, params,
          context: { houseOrigin: this.house.origin, houseKey: this.house.houseKey, incarnation: this.house.incarnation,
            sessionId: session.sessionId, fence: session.fence, capabilityRevision: caps.capabilityRevision, schemaVersion: version, validUntil } },
      });
      check();
      const claimed = this.options.db.transaction(tx => {
        check();
        if (collisionDeadline !== undefined && performance.now() >= collisionDeadline) throw new Error('ACTION_REQUEST_COLLISION_BUSY');
        if (isNativeActionReceiptProfile(receiptProfile)) {
          const original = tx.queryOne<Row>('SELECT * FROM world_action_client_requests WHERE binding=? AND execution_reference=?', [this.binding, reference]);
          if (original) return original.request_id;
        }
        const occupied = tx.queryOne<Row>('SELECT * FROM world_action_client_requests WHERE binding=? AND request_id=?', [this.binding, built.eventId]);
        if (occupied && occupied.execution_reference !== reference && isNativeActionReceiptProfile(receiptProfile)) return false;
        tx.execute(`INSERT OR IGNORE INTO world_action_client_requests
          (binding,request_id,request_bytes,request_digest,kind,schema_version,capabilities,valid_until,replacement_of,execution_reference,receipt_profile,original_context) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        [this.binding, built.eventId, built.signedPayloadBytes, cidFromCanonical(built.signedPayloadBytes), kind, version as number, JSON.stringify(caps), validUntil, replacementOf ?? null, reference, receiptProfile, originalContext]);
        if (this.row(built.eventId, tx).request_digest !== cidFromCanonical(built.signedPayloadBytes)) throw new Error('IDEMPOTENCY_CONFLICT');
        if (this.row(built.eventId, tx).receipt_profile !== receiptProfile) throw new Error('ACTION_CONTEXT_MISMATCH');
        if (this.row(built.eventId, tx).execution_reference !== reference) throw new Error('ACTION_EXECUTION_REFERENCE_MISMATCH');
        authority.record(tx, built.eventId);
        check();
        return built.eventId;
      });
      if (claimed) return this.send(this.row(claimed), gate, authority, selected);
      // The current wire format has no invocation nonce. Wait for real protocol
      // time to advance, outside the transaction, without extending the permit.
      collisionDeadline ??= performance.now() + Math.min(5000, Math.max(0, validUntil - this.now()) * 1000);
      do {
        check();
        const remaining = collisionDeadline - performance.now();
        if (remaining <= 0) throw new Error('ACTION_REQUEST_COLLISION_BUSY');
        await new Promise<void>((resolve, reject) => {
          const aborted = () => { clearTimeout(timer); gate.signal.removeEventListener('abort', aborted); reject(new Error('ACTION_GATE_CLOSED')); };
          const timer = setTimeout(() => { gate.signal.removeEventListener('abort', aborted); resolve(); }, Math.min(25, remaining));
          gate.signal.addEventListener('abort', aborted, { once: true });
          if (gate.signal.aborted) aborted();
        });
      } while (this.now() <= timestamp);
      check();
      if (performance.now() >= collisionDeadline) throw new Error('ACTION_REQUEST_COLLISION_BUSY');
    }
  }

  /** Explicit retry; never refresh context, params, timestamp or signatures. */
  async retry(requestId: string, authority: WorldActionAuthority): Promise<WorldActionView> {
    const row = this.row(requestId); this.identity(row);
    const gate = this.options.captureSession().gate;
    if (row.latest_result && (popclaw.world.ActionResult.decode(row.latest_result).status ?? 0) >= 3) return this.view(requestId);
    return this.send(row, gate, authority);
  }
  private async send(row: Row, gate: WorldActionGate, authority: WorldActionAuthority, captured?: SelectedActionContext): Promise<WorldActionView> {
    const original = this.identity(row), selected = captured ?? this.capture(row.kind);
    if (selected.evidence.capabilityRevision !== original.selection.capabilityRevision) throw new Error('CAPABILITY_REVISION_MISMATCH');
    if (!row.execution_reference) throw new Error('ACTION_EXECUTION_REFERENCE_REQUIRED');
    const reference = executionReference(JSON.parse(row.execution_reference));
    const expectedReference = referenceJson(reference);
    const envelope = decodeEnvelope(popclaw.identity.SignedPayload.decode(row.request_bytes).payload);
    if (!envelope.intent?.params) throw new Error('REQUEST_STORAGE_INVALID');
    const fixedInput: WorldInvokeInput = { house: this.house.origin!, kind: row.kind, params: jsonObject(parseWorldJson(envelope.intent.params, 16384)), expected_capability_revision: this.identity(row).capabilities.capabilityRevision };
    const check = () => {
      selected.assertCurrent();
      if (referenceJson(authority.executionReference) !== expectedReference) throw new Error('ACTION_EXECUTION_REFERENCE_MISMATCH');
      this.checkAuthority(authority, gate, row.kind, row.valid_until, row.request_id); authority.assertInput?.(clone(fixedInput));
    };
    check();
    let receipt: string | undefined;
    try {
      const pushed = await this.options.push(new Uint8Array(row.request_bytes), { gate, requestId: row.request_id, executionReference: reference });
      // Execution authorization fences sending, not an already returned fact.
      // Keep storage/session fences while authenticating the original receipt.
      this.gate(gate); receipt = pushed.signedActionResultBase64;
    } catch (error) {
      this.gate(gate);
      // G0 HousePushError preserves its typed result through the durable bus.
      if (error && typeof error === 'object' && 'result' in error && error.result && typeof error.result === 'object' && 'signedActionResultBase64' in error.result) {
        const raw = error.result.signedActionResultBase64; if (typeof raw === 'string') receipt = raw;
      }
      if (!receipt) return this.view(row.request_id);
    }
    if (receipt) await this.acceptResult(row.request_id, base64Bytes(receipt), gate);
    this.gate(gate);
    await this.drainPending(gate);
    return this.view(row.request_id);
  }
  /** A status result can be durably reconciled while disabled, but cannot wake
   * attachment consumers or create another request. Progress is separate and
   * deliberately not asserted until its own signed observation is verified. */
  async status(requestId: string): Promise<WorldActionView> {
    this.row(requestId);
    const gate = this.options.controlRead(requestId), check = () => this.gate(gate);
    check();
    const core = { house: this.house, actorId: this.options.actorId, requestId,
      nonce: globalThis.crypto.randomUUID(), issuedAt: this.now(), expiresAt: this.now() + 60 };
    const signer = this.checkedSigner(check);
    await signer.popclawId();
    const signature = await signer.sign(worldSigningInput('POPCLAW_WORLD_ACTION_STATUS_READ_V1', canonicalWorldCore(popclaw.world.ActionStatusRequest, core)));
    check();
    const bytes = await this.options.readStatus(canonicalWorldCore(popclaw.world.ActionStatusRequest, { ...core, signature }), { gate, requestId });
    check();
    const source = extractActionStatusResponse(bytes);
    await this.acceptResult(requestId, source.signedResultBytes, gate, source.sourceBytes);
    if (source.observationBytes) {
      const progress = source.observationBytes, identity = this.identity(this.row(requestId));
      // An independently invalid observation never retracts the committed base receipt.
      try {
        const result = popclaw.world.SignedActionResult.decode(source.signedResultBytes).result!;
        const observation = verifySubscriptionObservation(progress, { requestId, nonce: core.nonce, result,
          capabilities: identity.capabilities, resultAuthorityKey: identity.selection.resultAuthorityKey });
        const revision = worldUint64(observation.observationRevision);
        const state = contextUtf8.encode(canonicalActionJson({ profile: identity.receiptProfile, nonce: core.nonce,
          resultDigest: cidFromCanonical(canonicalWorldCore(popclaw.world.ActionResult, result)), descriptorDigest: cidFromCanonical(canonicalWorldCore(popclaw.world.SubscriptionDescriptor, result.subscription!)),
          logIncarnation: observation.logIncarnation, revision, disposition: 'not_selected', reason: 'INSTALLER_NOT_SELECTED' }));
        this.options.db.transaction(tx => {
          check();
          const previous = tx.queryOne<{observation_bytes:Uint8Array}>('SELECT observation_bytes FROM world_action_client_progress WHERE binding=? AND request_id=? AND nonce=?', [this.binding,requestId,core.nonce]);
          if (previous && cidFromCanonical(previous.observation_bytes) !== cidFromCanonical(progress)) throw new Error('SUBSCRIPTION_OBSERVATION_CONFLICT');
          if (!previous) tx.execute('INSERT INTO world_action_client_progress(binding,request_id,nonce,response_bytes,observation_bytes,observation_revision,pending,receipt_profile,observation_state) VALUES(?,?,?,?,?,?,0,?,?)',
            [this.binding,requestId,core.nonce,source.sourceBytes,progress,revision,identity.receiptProfile,state]);
          check();
        });
      } catch { check(); }
    }
    this.reconcileAccounting(requestId);
    this.notifyPending();
    return this.view(requestId);
  }
  /** Notification only; subscribers must use their own captured BUSINESS gate.
   * Status reads can persist while disabled and never provide dispatch authority. */
  /** Bind once to the resource that owns attachment consumers. This also
   * fences a pass initially entered through an explicit command's parent gate. */
  bindConsumerGate(gate: WorldActionGate): void {
    if (gate.origin !== this.house.origin) throw new Error('ACTION_GATE_CLOSED');
    if (this.consumerGate && this.consumerGate !== gate) throw new Error('ACTION_CONSUMER_ALREADY_BOUND');
    this.consumerGate = gate;
  }
  onPending(callback: () => void): () => void {
    this.pendingListeners.add(callback); return () => { this.pendingListeners.delete(callback); };
  }
  private notifyPending(): void {
    for (const callback of this.pendingListeners) { try { callback(); } catch { /* Durable evidence is retained for the next drain. */ } }
  }
  hasPending(): boolean {
    if (!this.options.accounting) return false;
    try { this.options.accounting.assertCurrent(); } catch { return false; }
    return this.options.db.queryAll<{request_id:string;receipt_state:Uint8Array}>('SELECT request_id,receipt_state FROM world_action_client_results WHERE binding=? AND receipt_profile IN (?,?,?,?)', [this.binding,...ACTION_RECEIPT_PROFILES])
      .some(row => { try { const identity = this.identity(this.row(row.request_id)), state = decodeActionReceiptState(row.receipt_state); return state.profile === identity.receiptProfile && state.baseAccounting.state === 'pending'; } catch { return false; } });
  }
  async acceptResult(requestId: string, bytes: Uint8Array, gate: WorldActionGate, statusSource?: Uint8Array): Promise<void> {
    if (!(bytes instanceof Uint8Array) || bytes.length > 1048576 || (statusSource && (!(statusSource instanceof Uint8Array) || statusSource.length > 1048576))) throw new Error('RESULT_SIZE_LIMIT');
    const row = this.row(requestId), raw = new Uint8Array(bytes), sourceBytes = statusSource ? new Uint8Array(statusSource) : raw;
    this.gate(gate);
    if (statusSource && cidFromCanonical(extractActionStatusResponse(sourceBytes).signedResultBytes) !== cidFromCanonical(raw)) throw new Error('ACTION_EVIDENCE_CONFLICT');
    const identity = this.identity(row), receiptProfile = identity.receiptProfile;
    const verified = await verifyActionReceipt(raw, identity, gate.signal), result = verified.result;
    this.gate(gate);
    const core = canonicalWorldCore(popclaw.world.ActionResult, result), digest = cidFromCanonical(core);
    this.options.db.transaction(tx => {
      this.gate(gate);
      const current = this.row(requestId, tx), oldBytes = current.latest_result;
      if (this.identity(current).receiptProfile !== receiptProfile) throw new Error('ACTION_CONTEXT_MISMATCH');
      let historical = false;
      if (oldBytes) {
        const old = popclaw.world.ActionResult.decode(oldBytes);
        historical = BigInt(worldUint64(result.statusRevision)) < BigInt(worldUint64(old.statusRevision));
        if (old.status >= 3 && result.status >= 3 && cidFromCanonical(oldBytes) !== digest) throw new Error('RESULT_TERMINAL_CONFLICT');
        if (old.executionId && result.executionId && old.executionId !== result.executionId) throw new Error('RESULT_TRANSITION_INVALID');
        if (!historical && cidFromCanonical(oldBytes) !== digest) {
          if ((old.status ?? 0) >= 3) throw new Error('RESULT_TERMINAL_CONFLICT');
          if (worldUint64(result.statusRevision) === worldUint64(old.statusRevision)) throw new Error('RESULT_REVISION_CONFLICT');
          const allowed = old.status === 1 ? [1,2,3,4,5] : old.status === 2 ? [2,3,4] : [];
          if (!allowed.includes(result.status) || (old.executionId && old.executionId !== result.executionId)) throw new Error('RESULT_TRANSITION_INVALID');
        }
      }
      const previous = tx.queryOne<{receipt_profile:string|null;receipt_state:Uint8Array|null}>('SELECT receipt_profile,receipt_state FROM world_action_client_results WHERE binding=? AND request_id=? AND core_digest=?', [this.binding,requestId,digest]);
      if (previous) {
        if (previous.receipt_profile !== receiptProfile || !previous.receipt_state || (decodeActionReceiptState(previous.receipt_state).profile !== receiptProfile || decodeActionReceiptState(previous.receipt_state).semanticDigest !== digest)) throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
      } else {
        const reference = current.execution_reference ? executionReference(JSON.parse(current.execution_reference)) : null;
        const state: ActionReceiptStateV1 = { profile: receiptProfile, status: result.status, revision: worldUint64(result.statusRevision), semanticDigest: digest,
          attachmentContract: verified.attachmentContract, attachments: verified.attachments,
          baseAccounting: { state: result.status < 3 ? 'not_terminal' : historical || (reference?.kind !== 'owner_action' && reference?.kind !== 'native_policy') ? 'blocked' : 'pending',
            reason: result.status < 3 ? 'RESULT_NOT_TERMINAL' : historical ? 'HISTORICAL_RECEIPT' : (reference?.kind !== 'owner_action' && reference?.kind !== 'native_policy') ? 'ORIGINAL_ACCOUNTING_UNSUPPORTED' : 'ORIGINAL_ACCOUNTING_PENDING', executionReference: reference } };
        tx.execute('INSERT INTO world_action_client_results(binding,request_id,core_digest,result_bytes,pending,receipt_profile,receipt_state) VALUES(?,?,?,?,0,?,?)', [this.binding,requestId,digest,raw,receiptProfile,encodeActionReceiptState(state)]);
      }
      recordActionReceiptEvidence(tx, { binding:this.binding,requestId,coreDigest:digest,sourceKind:statusSource ? 'status_response' : 'push_result',sourceBytes,signedResultBytes:raw,observedAt:this.now() });
      if (!historical) tx.execute('UPDATE world_action_client_requests SET latest_result=? WHERE binding=? AND request_id=?', [core,this.binding,requestId]);
      this.gate(gate);
    });
    this.notifyPending();
  }
  /** A separate transaction permits crash recovery after durable receipt. Exact
   * settlement and the applied marker commit or roll back together. */
  reconcileAccounting(requestId: string): void {
    const accounting = this.options.accounting; if (!accounting) return;
    try { accounting.assertCurrent(); } catch { return; }
    const rows = this.options.db.queryAll<{core_digest:string;receipt_state:Uint8Array;result_bytes:Uint8Array}>('SELECT core_digest,receipt_state,result_bytes FROM world_action_client_results WHERE binding=? AND request_id=? AND receipt_profile IN (?,?,?,?)', [this.binding,requestId,...ACTION_RECEIPT_PROFILES]);
    for (const entry of rows) {
      let initial: ActionReceiptStateV1; try { initial = decodeActionReceiptState(entry.receipt_state); } catch { continue; }
      if (initial.baseAccounting.state !== 'pending') continue;
      try {
        this.options.db.transaction(tx => {
          accounting.assertCurrent();
          const stored = tx.queryOne<{receipt_state:Uint8Array}>('SELECT receipt_state FROM world_action_client_results WHERE binding=? AND request_id=? AND core_digest=?', [this.binding,requestId,entry.core_digest]);
          if (!stored) throw new Error('ACTION_RECEIPT_MISSING');
          const state = decodeActionReceiptState(stored.receipt_state); if (state.baseAccounting.state !== 'pending') return;
          this.assertEvidence(tx,requestId,entry.core_digest);
          const row = this.row(requestId,tx), identity = this.identity(row), reference = row.execution_reference ? executionReference(JSON.parse(row.execution_reference)) : null;
          if ((reference?.kind !== 'owner_action' && reference?.kind !== 'native_policy') || canonicalActionJson(reference) !== canonicalActionJson(state.baseAccounting.executionReference)) throw new Error('ACTION_EXECUTION_REFERENCE_MISMATCH');
          if (state.profile !== identity.receiptProfile) throw new Error('ACTION_CONTEXT_MISMATCH');
          if (reference.kind === 'native_policy') assertNativeActionJournalSchema(tx,this.partition);
          if (!row.latest_result || cidFromCanonical(row.latest_result) !== entry.core_digest) throw new Error('ACCOUNTING_RESULT_NOT_LATEST');
          const result = authenticateActionResult(entry.result_bytes, identity);
          if (!result || cidFromCanonical(canonicalWorldCore(popclaw.world.ActionResult,result)) !== entry.core_digest || result.status < 3) throw new Error('ACCOUNTING_RESULT_INVALID');
          const envelope = decodeEnvelope(popclaw.identity.SignedPayload.decode(row.request_bytes).payload);
          const input: WorldInvokeInput = { house:this.house.origin!,kind:row.kind,params:jsonObject(parseWorldJson(envelope.intent!.params!,16384)),expected_capability_revision:identity.selection.capabilityRevision };
          const settled = accounting.settle(tx, { house:this.house,actorId:this.options.actorId,requestId,requestDigest:identity.requestDigest,requestBytes:new Uint8Array(row.request_bytes),input,executionReference:reference,result:result as popclaw.world.ActionResult,semanticDigest:entry.core_digest });
          if (!settled || !['applied','already_applied'].includes(settled.outcome) || settled.reservationId !== reference.reservationId) throw new Error('ORIGINAL_ACCOUNTING_NOT_APPLIED');
          const ledger = reference.kind === 'native_policy' ? 'world_native_action_reservations' : 'world_owner_action_reservations';
          const actual = tx.queryOne<{request_id:string|null;input_json:string;status:string}>(`SELECT request_id,input_json,status FROM ${ledger} WHERE binding=? AND reservation_id=?`, [this.binding,reference.reservationId]);
          const terminalStatus = result.status === 3 ? 'succeeded' : result.status === 4 ? 'rejected' : 'cancelled';
          if (!actual || actual.request_id !== requestId || actual.input_json !== canonicalActionJson(input) || actual.status !== terminalStatus) throw new Error('ORIGINAL_ACCOUNTING_NOT_APPLIED');
          accounting.assertCurrent();
          state.baseAccounting = { ...state.baseAccounting,state:'applied',reason:'ORIGINAL_ACCOUNTING_APPLIED' };
          const changed = tx.execute('UPDATE world_action_client_results SET receipt_state=? WHERE binding=? AND request_id=? AND core_digest=?', [encodeActionReceiptState(state),this.binding,requestId,entry.core_digest]);
          if (changed.changes !== 1) throw new Error('ACTION_RECEIPT_MISSING');
          accounting.assertCurrent();
        });
      } catch (error) {
        // Permanent missing/conflicting provenance is visible and never a hot retry.
        const reason = error instanceof Error ? error.message : 'ACCOUNTING_RETRY_REQUIRED';
        if (/^(NATIVE_ACTION_(SCHEMA_UNSUPPORTED|RESERVATION_UNKNOWN|REQUEST_MISSING|REQUEST_MISMATCH|INPUT_MISMATCH|RESULT_MISMATCH|BINDING_MISMATCH)|OWNER_ACTION_(RESERVATION_UNKNOWN|REQUEST_MISSING|REQUEST_MISMATCH|INPUT_MISMATCH|RESULT_MISMATCH|BINDING_MISMATCH)|ACTION_EXECUTION_REFERENCE_MISMATCH|ORIGINAL_ACCOUNTING_(NOT_APPLIED|UNSUPPORTED)|ACCOUNTING_RESULT_(NOT_LATEST|INVALID)|RESULT_CONFLICT|ACTION_(CONTEXT_UNSUPPORTED|CONTEXT_MISMATCH|CONTEXT_SIZE_LIMIT|EVIDENCE_CONFLICT|RECEIPT_MISSING)|RESULT_(SIGNATURE_INVALID|BINDING_MISMATCH|WIRE_UNSUPPORTED|WIRE_DUPLICATE|WIRE_INVALID|INVALID|DIGEST_MISMATCH))$/.test(reason)) {
          this.options.db.transaction(tx => {
            const saved = tx.queryOne<{receipt_state:Uint8Array}>('SELECT receipt_state FROM world_action_client_results WHERE binding=? AND request_id=? AND core_digest=?', [this.binding,requestId,entry.core_digest]);
            if (!saved) return;
            const state = decodeActionReceiptState(saved.receipt_state); if (state.baseAccounting.state !== 'pending') return;
            state.baseAccounting = {...state.baseAccounting,state:'blocked',reason};
            tx.execute('UPDATE world_action_client_results SET receipt_state=? WHERE binding=? AND request_id=? AND core_digest=?', [encodeActionReceiptState(state),this.binding,requestId,entry.core_digest]);
          });
        }
        // Other failures roll back completely and retain the pending obligation.
      }
    }
  }
  view(requestId: string): WorldActionView {
    const row = this.row(requestId);
    if (!row.latest_result) return { request_id: requestId, status: 'unknown', code: 'ACTION_RESULT_UNKNOWN' };
    const result = popclaw.world.ActionResult.decode(row.latest_result);
    if (!isActionReceiptProfile(row.receipt_profile)) return { request_id:requestId,status:'unknown',code:'ACTION_CONTEXT_UNSUPPORTED',receipt_durable:false,installed_readiness:false };
    this.identity(row);
    const stored = this.options.db.queryOne<{receipt_state:Uint8Array;result_bytes:Uint8Array}>('SELECT receipt_state,result_bytes FROM world_action_client_results WHERE binding=? AND request_id=? AND core_digest=? AND receipt_profile=?', [this.binding,requestId,cidFromCanonical(row.latest_result),row.receipt_profile]);
    if (!stored) throw new Error('ACTION_RECEIPT_MISSING');
    this.assertEvidence(this.options.db,requestId,cidFromCanonical(row.latest_result));
    const state = decodeActionReceiptState(stored.receipt_state), authenticated = authenticateActionResult(stored.result_bytes,this.identity(row));
    if (state.profile !== row.receipt_profile || canonicalActionJson(state.baseAccounting.executionReference) !== canonicalActionJson(row.execution_reference ? executionReference(JSON.parse(row.execution_reference)) : null)) throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
    if (state.semanticDigest !== cidFromCanonical(row.latest_result) || cidFromCanonical(canonicalWorldCore(popclaw.world.ActionResult,authenticated)) !== state.semanticDigest || state.status !== result.status || state.revision !== worldUint64(result.statusRevision)) throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
    let progress: popclaw.world.SubscriptionObservation | undefined;
    if (result.subscription) {
      const observations = this.options.db.queryAll<{nonce:string;observation_bytes:Uint8Array;observation_state:Uint8Array}>('SELECT nonce,observation_bytes,observation_state FROM world_action_client_progress WHERE binding=? AND request_id=? AND receipt_profile=? ORDER BY length(observation_revision) DESC,observation_revision DESC', [this.binding,requestId,row.receipt_profile]);
      for (const candidate of observations) {
        try {
          if (!(candidate.observation_state instanceof Uint8Array) || candidate.observation_state.length > 32768) continue;
          const observed = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(candidate.observation_state));
          if (Object.keys(observed).sort().join() !== 'descriptorDigest,disposition,logIncarnation,nonce,profile,reason,resultDigest,revision' || observed.profile !== row.receipt_profile || observed.nonce !== candidate.nonce || observed.resultDigest !== state.semanticDigest || observed.descriptorDigest !== cidFromCanonical(canonicalWorldCore(popclaw.world.SubscriptionDescriptor,result.subscription)) || observed.disposition !== 'not_selected') continue;
          const verified = verifySubscriptionObservation(candidate.observation_bytes,{requestId,nonce:candidate.nonce,result,capabilities:this.identity(row).capabilities,resultAuthorityKey:this.identity(row).selection.resultAuthorityKey});
          if (observed.revision !== worldUint64(verified.observationRevision) || observed.logIncarnation !== verified.logIncarnation) continue;
          progress = verified; break;
        } catch { /* Unsupported historical observation cannot establish readiness. */ }
      }
    }
    return { request_id:requestId,status:statuses[result.status]!,house_status:statuses[result.status]!,code:result.code,result,...(progress ? {progress} : {}),
      receipt_durable:true,attachment_contract:state.attachmentContract,base_accounting:state.baseAccounting,attachments:state.attachments,installed_readiness:false };
  }

  /** Root calls after startup and on a bounded retry schedule. Each pass visits
   * each pending row once; failed consumers retain evidence without starving
   * later rows. Delivery/ACK use an active business gate, never a control gate. */
  drainPending(gate: WorldActionGate): Promise<void> {
    if (this.dispatching) return this.dispatching;
    const running = Promise.resolve().then(() => this.dispatch(gate));
    this.dispatching = running;
    void running.finally(() => { if (this.dispatching === running) this.dispatching = null; }).catch(() => {});
    return running;
  }
  private async dispatch(parentGate: WorldActionGate): Promise<void> {
    this.gate(parentGate); if (this.consumerGate) this.gate(this.consumerGate);
    if (!this.options.accounting) return;
    const requests = this.options.db.queryAll<{request_id:string}>('SELECT DISTINCT request_id FROM world_action_client_results WHERE binding=? AND receipt_profile IN (?,?,?,?)', [this.binding,...ACTION_RECEIPT_PROFILES]);
    for (const row of requests) {
      this.gate(parentGate); if (this.consumerGate) this.gate(this.consumerGate);
      try { this.reconcileAccounting(row.request_id); } catch { this.gate(parentGate); }
    }
  }
}

export { prepareActionReceiptJournal, assertActionReceiptJournalSchema, snapshotActionReceiptOriginalContent,
  ACTION_RECEIPT_SCHEMA_FINGERPRINT, ACTION_RECEIPT_FEATURE_PROFILE, ACTION_RECEIPT_TABLES } from './action-receipt-journal.js';
export type { ActionReceiptPreparationReport, ActionReceiptPartition, ActionOriginalContent } from './action-receipt-journal.js';
