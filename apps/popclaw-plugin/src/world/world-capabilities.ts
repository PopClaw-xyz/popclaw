import { ensureWorldCapabilitySchema } from '../host/runtime-storage-schema.js';
import { recoveredCapabilityBinding } from './house-recovery-fence.js';
import { houseKeyFromAckHex, verifyManifestProof } from './house-binding.js';
import { popclaw, isHouseSessionBoard } from '@popclaw/contracts';
import boardSchema from '../../../../protocol/packages/contracts/protocol/public-envelope-01/board.schema.json';
import actionSchema from '../../../../protocol/packages/contracts/protocol/public-envelope-01/action-kind.schema.json';
import eventSchema from '../../../../protocol/packages/contracts/protocol/public-envelope-01/interpreted-event-kind.schema.json';
import profileSchema from '@popclaw/contracts/world-interaction/schema-profile.schema.json';
import { cidFromCanonical } from '@popclaw/algorithms';
import Ajv2020 from 'ajv/dist/2020.js';
import bs58 from 'bs58';
import type { ActionSelectionEvidenceV1 } from './action-client.js';
import type { HostDb } from '../host/host-db.js';
import type { PreparedTrustedManifest, TrustedManifestInput } from '../runtime/house-lifecycle/trusted-manifest.js';
import { jsonObject, parseWorldManifest, readBoundedBytes, selectDeclaredRow, validateProfileGrammar } from './json-profile.js';
import { renderCopy } from '../lexicon/index.js';
import { ownerLang } from '../lexicon/owner-language.js';

const ajv = new Ajv2020({ strict: false, validateSchema: false, allErrors: false, unicodeRegExp: true });
const validateProfile = ajv.compile(profileSchema);
const validateAction = ajv.compile(actionSchema);
const validateEvent = ajv.compile(eventSchema);
const blockValidators = Object.fromEntries(Object.keys(boardSchema.$defs).map(name => [name,
  ajv.compile({ $defs: boardSchema.$defs, $ref: `#/$defs/${name}` })]));

/** Historical signed-record context only. Never a live first-release view. */
export interface TrustedWorldCapabilities {
  readonly house: popclaw.world.IHouseBinding;
  readonly capabilityRevision: string;
  readonly manifest: Record<string, unknown>;
  readonly guide: string;
}
export interface CapabilityState {
  readonly validation: 'absent' | 'invalid' | 'valid';
  readonly detail: string;
  readonly support: 'unsupported' | 'supported';
  readonly ready: boolean;
}
export interface SelectedCapabilityState extends CapabilityState {
  readonly kinds: Readonly<Record<string, CapabilityState>>;
  readonly attachmentUnion?: 'valid' | 'unverifiable' | 'mismatch';
  readonly unsupportedAttachments?: readonly string[];
}
export interface VerifiedHouseManifest {
  readonly house: Readonly<{ origin: string; houseKey: string; incarnation: string }>;
  readonly capabilityRevision: string;
  /** Each read owns its byte copies; mutation cannot alter retained evidence. */
  readonly manifestBytes: Uint8Array;
  readonly proofBytes: Uint8Array;
  readonly guideBytes?: Uint8Array;
  readonly pinProvenance: TrustedManifestInput['provenance'];
}
export interface VerifiedPublicStreamCapability {
  readonly house: VerifiedHouseManifest['house'];
  readonly capabilityRevision: string;
  readonly publicStream: Readonly<{ envelope_baseline: 'public-envelope-01'; endpoint: '/v1/world-stream'; mode: 'public-v1'; log_incarnation: string; initial_public_scopes: readonly string[] }>;
}
export interface HouseCapabilityView {
  readonly verified: VerifiedHouseManifest;
  readonly publicStream: CapabilityState;
  readonly actions: SelectedCapabilityState;
  readonly privateMessages: SelectedCapabilityState;
  readonly guide: CapabilityState;
  readonly executionClosure: CapabilityState;
  readonly publicStreamCapability?: VerifiedPublicStreamCapability;
}
type Validation = Pick<HouseCapabilityView, 'publicStream' | 'actions' | 'privateMessages' | 'guide' | 'executionClosure'>;
interface ObservationRow { house_key: string; incarnation: string; capability_revision: string; manifest_bytes: Uint8Array; proof_bytes: Uint8Array; guide_bytes: Uint8Array | null; pin_provenance: TrustedManifestInput['provenance']; validation_json: string }
interface KindRevision { kind: string; direction: string; version: number; digest: string }
const state = (validation: CapabilityState['validation'], detail = ''): CapabilityState => ({ validation, detail, support: 'unsupported', ready: false });
const invalid = (detail: string) => state('invalid', detail);
const errorCode = (error: unknown) => error instanceof Error ? error.message.slice(0, 256) : 'CAPABILITY_INVALID';
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
export { ensureWorldCapabilitySchema } from '../host/runtime-storage-schema.js';

type ManifestHouse = VerifiedHouseManifest['house'];
interface ManifestLogObservation { log: string; baseline: string }
interface ManifestLogRow { baseline_key: string; retired: number; conflicted: number }
const manifestHouseParams = (house: ManifestHouse) => [house.origin, house.houseKey, house.incarnation];
function hasManifestLogTables(db: HostDb): boolean {
  return ['world_public_manifest_logs_v1', 'world_public_manifest_log_evidence_v1'].every(name =>
    !!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]));
}
/** Observation is independent of capability interpretation. An unsupported mode,
 * baseline or board cannot erase an authenticated declaration of an actual log. */
function manifestLogObservation(document: Record<string, unknown>): ManifestLogObservation | null {
  const world = document.world_interaction;
  if (!world || typeof world !== 'object' || Array.isArray(world)) return null;
  const stream = (world as Record<string, unknown>).public_stream;
  if (!stream || typeof stream !== 'object' || Array.isArray(stream)) return null;
  const raw = stream as Record<string, unknown>, log = raw.log_incarnation;
  if (typeof log !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(log) || log.trim() !== log) return null;
  return { log, baseline: Object.hasOwn(raw, 'envelope_baseline')
    ? stableJson(['value', raw.envelope_baseline]) : '["missing"]' };
}
function retainedUncoveredManifests(db: HostDb, house: ManifestHouse): ObservationRow[] {
  return db.queryAll<ObservationRow>(`SELECT v.* FROM world_capability_views_v1 v
    LEFT JOIN world_public_manifest_log_evidence_v1 e ON e.origin=v.origin AND e.house_key=v.house_key
      AND e.incarnation=v.incarnation AND e.capability_revision=v.capability_revision
    LEFT JOIN world_public_manifest_logs_v1 l ON l.origin=e.origin AND l.house_key=e.house_key
      AND l.incarnation=e.incarnation AND l.log_incarnation=e.log_incarnation
    WHERE v.origin=? AND v.house_key=? AND v.incarnation=?
      AND (e.capability_revision IS NULL OR (e.log_incarnation IS NOT NULL AND l.log_incarnation IS NULL))`, manifestHouseParams(house));
}
function retainManifestLogEvidence(tx: HostDb, house: ManifestHouse, revision: string, observation: ManifestLogObservation | null): void {
  tx.execute(`INSERT INTO world_public_manifest_log_evidence_v1(origin,house_key,incarnation,capability_revision,log_incarnation,baseline_key)
    VALUES(?,?,?,?,?,?) ON CONFLICT(origin,house_key,incarnation,capability_revision) DO NOTHING`,
  [...manifestHouseParams(house), revision, observation?.log ?? null, observation?.baseline ?? null]);
}
/** Flags only accumulate. A conflicting replay cannot restore an earlier profile,
 * or undo retirement of the log that was observed immediately before it. */
function retainManifestLog(tx: HostDb, house: ManifestHouse, revision: string, observation: ManifestLogObservation): void {
  const identity = manifestHouseParams(house);
  tx.execute(`UPDATE world_public_manifest_logs_v1 SET retired=1,retired_by_revision=COALESCE(retired_by_revision,?)
    WHERE origin=? AND house_key=? AND incarnation=? AND log_incarnation<>?`, [revision, ...identity, observation.log]);
  tx.execute(`INSERT INTO world_public_manifest_logs_v1(origin,house_key,incarnation,log_incarnation,baseline_key,first_revision,retired,conflicted)
    VALUES(?,?,?,?,?,?,0,0) ON CONFLICT(origin,house_key,incarnation,log_incarnation) DO NOTHING`,
  [...identity, observation.log, observation.baseline, revision]);
  tx.execute(`UPDATE world_public_manifest_logs_v1 SET conflicted=1,conflict_revision=COALESCE(conflict_revision,?)
    WHERE origin=? AND house_key=? AND incarnation=? AND log_incarnation=? AND baseline_key<>?`,
  [revision, ...identity, observation.log, observation.baseline]);
}
/** Old trusted manifests have exact values but no complete cutover chronology.
 * Preserve them as retired evidence; re-observation cannot label them fresh. */
function retainUncoveredManifestHistory(tx: HostDb, house: ManifestHouse): void {
  for (const row of retainedUncoveredManifests(tx, house)) {
    if (cidFromCanonical(row.manifest_bytes) !== row.capability_revision) throw new Error('PUBLIC_LOG_HISTORY_INVALID');
    const observation = manifestLogObservation(parseWorldManifest(row.manifest_bytes, new Map()));
    if (observation) {
      retainManifestLog(tx, house, row.capability_revision, observation);
      tx.execute(`UPDATE world_public_manifest_logs_v1 SET retired=1,retired_by_revision=COALESCE(retired_by_revision,?)
        WHERE origin=? AND house_key=? AND incarnation=? AND log_incarnation=?`,
      [row.capability_revision, ...manifestHouseParams(house), observation.log]);
    }
    retainManifestLogEvidence(tx, house, row.capability_revision, observation);
  }
}
function publicManifestLogFailure(db: HostDb, house: ManifestHouse, revision: string, document: Record<string, unknown>): string | null {
  const observation = manifestLogObservation(document);
  if (!observation) return null;
  if (!hasManifestLogTables(db)) return 'PUBLIC_LOG_BINDING_SELECTION_REQUIRED';
  // An older executable may have appended trusted views without recording log
  // transitions. Cached validation cannot conceal those uncovered observations.
  for (const row of retainedUncoveredManifests(db, house)) {
    if (cidFromCanonical(row.manifest_bytes) !== row.capability_revision
      || manifestLogObservation(parseWorldManifest(row.manifest_bytes, new Map()))) return 'PUBLIC_LOG_BINDING_SELECTION_REQUIRED';
  }
  const identity = manifestHouseParams(house);
  const evidence = db.queryOne<{ log_incarnation: string | null; baseline_key: string | null }>(
    'SELECT log_incarnation,baseline_key FROM world_public_manifest_log_evidence_v1 WHERE origin=? AND house_key=? AND incarnation=? AND capability_revision=?',
    [...identity, revision]);
  const profile = db.queryOne<ManifestLogRow>('SELECT baseline_key,retired,conflicted FROM world_public_manifest_logs_v1 WHERE origin=? AND house_key=? AND incarnation=? AND log_incarnation=?', [...identity, observation.log]);
  if (!evidence || evidence.log_incarnation !== observation.log || evidence.baseline_key !== observation.baseline || !profile)
    return 'PUBLIC_LOG_BINDING_SELECTION_REQUIRED';
  if (profile.conflicted || profile.baseline_key !== observation.baseline) return 'PUBLIC_LOG_BASELINE_CONFLICT';
  return profile.retired ? 'PUBLIC_LOG_RETIRED' : null;
}
function restrictPublicDependencies(document: Record<string, unknown>, validation: Validation, publicState: CapabilityState): Validation {
  if (publicState.validation === 'valid') return { ...validation, publicStream: publicState };
  const kinds = { ...validation.actions.kinds };
  for (const entry of Array.isArray(document.intent_kinds) ? document.intent_kinds : []) {
    const row = jsonObject(entry);
    if (typeof row.kind === 'string' && kinds[row.kind]?.validation === 'valid' && row.consistency !== 'none')
      kinds[row.kind] = invalid('PUBLIC_STREAM_REQUIRED');
  }
  return { ...validation, publicStream: publicState, actions: { ...validation.actions, kinds },
    executionClosure: validation.executionClosure.validation === 'valid' && Object.values(kinds).some(kind => kind.validation !== 'valid')
      ? invalid('ACTIONS_REQUIRED') : validation.executionClosure };
}
export function revokeHouseCapabilityView(tx: HostDb, origin: string, detail: string): void {
  if (tx.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_capability_current_v1'"))
    tx.execute('UPDATE world_capability_current_v1 SET active=0,detail=? WHERE origin=?', [detail, origin]);
  if (tx.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_capabilities'"))
    tx.execute('UPDATE world_capabilities SET active=0,detail=? WHERE origin=?', [detail, origin]);
}
export function readHouseCapabilityView(db: HostDb, origin: string): HouseCapabilityView | null {
  if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_capability_current_v1'")) return null;
  let row = db.queryOne<ObservationRow>(`SELECT v.*,c.validation_json FROM world_capability_views_v1 v
    JOIN world_capability_current_v1 c USING(origin,capability_revision) WHERE c.origin=? AND c.active=1`, [origin]);
  if (db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_recovery_fences_v1'")) {
    const recovery = db.queryOne<{house_key:string;new_incarnation:string}>("SELECT * FROM house_recovery_fences_v1 WHERE origin=? AND state='complete'",[origin]);
    if (recovery && !db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_capability_recovery_views_v1'")) return null;
    if (recovery) row = db.queryOne<ObservationRow>(`SELECT v.*,c.validation_json FROM world_capability_recovery_views_v1 v
      JOIN world_capability_current_v1 c USING(origin,capability_revision)
      WHERE c.origin=? AND c.active=1 AND v.house_key=? AND v.incarnation=?`,[origin,recovery.house_key,recovery.new_incarnation]);
  }
  if (!row) return null;
  const verified: VerifiedHouseManifest = { house: { origin, houseKey: row.house_key, incarnation: row.incarnation },
    capabilityRevision: row.capability_revision, get manifestBytes() { return new Uint8Array(row.manifest_bytes); },
    get proofBytes() { return new Uint8Array(row.proof_bytes); },
    get guideBytes() { return row.guide_bytes ? new Uint8Array(row.guide_bytes) : undefined; }, pinProvenance: row.pin_provenance };
  let validation = JSON.parse(row.validation_json, (_key, value: unknown) => {
    if (value && typeof value === 'object' && 'validation' in value) return { ...value, support: 'unsupported', ready: false };
    return value;
  }) as Validation;
  const document = parseWorldManifest(row.manifest_bytes, new Map()), board = jsonObject(document.world_interaction);
  // Persisted validation is an observation by an older executable, not a support grant.
  const publicState = block(board, 'public_stream'), logFailure = publicManifestLogFailure(db, verified.house, verified.capabilityRevision, document);
  validation = restrictPublicDependencies(document, validation, logFailure ? invalid(logFailure)
    : publicState.validation === 'valid' ? validation.publicStream : publicState);
  const publicStreamCapability = validation.publicStream.validation === 'valid' ? { house: verified.house,
    capabilityRevision: verified.capabilityRevision, publicStream: board.public_stream as VerifiedPublicStreamCapability['publicStream'] } : undefined;
  return freeze({ verified, ...validation, ...(publicStreamCapability ? { publicStreamCapability } : {}) });
}
export type ActionEvidenceSelection =
  | { available: true; evidence: ActionSelectionEvidenceV1 }
  | { available: false; reason: string };

/** Interpretation only. Neither valid evidence nor a selected kind grants invocation authority. */
export function selectActionEvidence(view: HouseCapabilityView | null, actorId: string, kind: string): ActionEvidenceSelection {
  if (!view || view.actions.validation !== 'valid' || view.actions.kinds[kind]?.validation !== 'valid')
    return { available: false, reason: 'ACTION_KIND_UNAVAILABLE' };
  if (view.guide.validation !== 'valid') return { available: false, reason: 'GUIDE_REQUIRED' };
  try {
    keyBytes(actorId);
    const manifestBytes = new Uint8Array(view.verified.manifestBytes), proofBytes = new Uint8Array(view.verified.proofBytes);
    const sourceGuide = view.verified.guideBytes;
    if (!sourceGuide) return { available: false, reason: 'GUIDE_REQUIRED' };
    const sizes = new Map<string, number>();
    const guideBytes = new Uint8Array(sourceGuide), document = parseWorldManifest(manifestBytes, sizes);
    const board = jsonObject(document.world_interaction), actions = jsonObject(board.actions);
    if (board.version !== 1 || !blockValidators.actions!(actions) || !blockValidators.guide!(board.guide) || !(actions.kinds as string[]).includes(kind))
      return { available: false, reason: 'ACTION_KIND_UNAVAILABLE' };
    const selected = selectDeclaredRow(document, 'intent_kinds', kind, sizes);
    if (!selected || !validateAction(selected.row)) return { available: false, reason: 'CAPABILITY_KIND_INVALID' };
    const row = selected.row, attachments = jsonObject(row.result_attachments);
    const guideDigest = cidFromCanonical(guideBytes);
    if (guideDigest !== jsonObject(board.guide).sha256 || cidFromCanonical(manifestBytes) !== view.verified.capabilityRevision)
      return { available: false, reason: 'ACTION_EVIDENCE_CHANGED' };
    const evidence: ActionSelectionEvidenceV1 = {
      profile: 'first-release-1ff7-action-v1', house: { ...view.verified.house }, actorId,
      capabilityRevision: view.verified.capabilityRevision, manifestBytes, proofBytes, guideBytes, guideDigest,
      kind, schemaVersion: row.schema_version as number, resultAuthorityKey: actions.result_authority_pubkey as string,
      paramsSchema: jsonObject(row.params_schema), resultSchema: jsonObject(row.result_schema),
      allowed: [...attachments.allowed as ActionSelectionEvidenceV1['allowed']].sort(),
      requiredOnSuccess: [...attachments.required_on_success as ActionSelectionEvidenceV1['requiredOnSuccess']].sort(),
      consistency: row.consistency as ActionSelectionEvidenceV1['consistency'],
    };
    return { available: true, evidence: freeze(evidence) };
  } catch (error) { return { available: false, reason: errorCode(error) }; }
}

function keyBytes(value: unknown): Uint8Array {
  if (typeof value !== 'string') throw new Error('HOUSE_KEY_INVALID');
  const bytes = bs58.decode(value);
  if (bytes.length !== 32) throw new Error('HOUSE_KEY_INVALID');
  return bytes;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
export function validateWorldSchema(value: unknown): void {
  const schema = jsonObject(value);
  if (new TextEncoder().encode(JSON.stringify(schema)).length > 32768) throw new Error('SCHEMA_SIZE_LIMIT');
  if (!validateProfile(schema)) throw new Error('SCHEMA_PROFILE_INVALID');
  validateProfileGrammar(schema);
  // Compilation and execution of a house-supplied schema occur only in the
  // bounded worker in schema-validator.ts; JS regex execution may backtrack.
}


function envelope(document: Record<string, unknown>): Record<string, unknown> | null {
  try {
    const board = jsonObject(document.world_interaction);
    if (board.version !== 1 || Object.keys(board).some(key => !['version', ...Object.keys(boardSchema.$defs)].includes(key))
      || !['public_stream', 'actions', 'private_messages'].some(key => Object.hasOwn(board, key))) return null;
    return board;
  } catch { return null; }
}
function block(board: Record<string, unknown>, name: string): CapabilityState {
  if (board[name] === undefined) return state('absent');
  if (name === 'public_stream' && !manifestLogObservation({ world_interaction: board })) return invalid('CAPABILITY_BLOCK_INVALID');
  return blockValidators[name]!(board[name]) ? state('valid') : invalid('CAPABILITY_BLOCK_INVALID');
}
function interpret(document: Record<string, unknown>, board: Record<string, unknown>, sizes: Map<string, number>, guideState: CapabilityState, publicFailure: string | null = null): { validation: Validation; revisions: KindRevision[] } {
  const publicStream = publicFailure ? invalid(publicFailure) : block(board, 'public_stream');
  let actionState = block(board, 'actions'), privateState = block(board, 'private_messages');
  let closure = block(board, 'execution_closure');
  const actionKinds: Record<string, CapabilityState> = Object.create(null), privateKinds: Record<string, CapabilityState> = Object.create(null);
  const revisions: KindRevision[] = [];
  if (actionState.validation === 'valid') {
    try { keyBytes(jsonObject(board.actions).result_authority_pubkey);
      if (!isHouseSessionBoard(document.house_session)) throw new Error('ACTION_AUTHORITY_INVALID'); }
    catch { actionState = invalid('ACTION_AUTHORITY_INVALID'); }
  }
  if (privateState.validation === 'valid') {
    try {
      if (!Array.isArray(document.official_ids) || !document.official_ids.length) throw new Error('OFFICIAL_IDS_INVALID');
      document.official_ids.forEach(keyBytes);
    } catch { privateState = invalid('OFFICIAL_IDS_INVALID'); }
  }
  const selectedCount = (actionState.validation === 'valid' ? (jsonObject(board.actions).kinds as string[]).length * 2 : 0)
    + (privateState.validation === 'valid' ? (jsonObject(board.private_messages).kinds as string[]).length : 0);
  let union: 'valid' | 'unverifiable' | 'mismatch' = 'valid';
  const allowedUnion = new Set<string>();
  for (const [name, property, shared, target, validator, schemaNames] of [
    ['actions', 'intent_kinds', actionState, actionKinds, validateAction, ['params_schema', 'result_schema']],
    ['private_messages', 'event_kinds', privateState, privateKinds, validateEvent, ['body_schema']],
  ] as const) {
    if (shared.validation !== 'valid') continue;
    const declaration = jsonObject(board[name]);
    for (const kind of declaration.kinds as string[]) {
      try {
        // Selection first, then this row's own profile: a sibling the board did
        // not select can neither be counted here nor break this kind.
        const selected = selectDeclaredRow(document, property, kind, sizes);
        if (!selected) throw new Error('CAPABILITY_KIND_AMBIGUOUS');
        const row = selected.row;
        if (!validator(row)) throw new Error('CAPABILITY_KIND_INVALID');
        // Structural attachment sets are known even if the schema is unusable.
        if (name === 'actions') {
          const attachments = jsonObject(row.result_attachments), allowed = attachments.allowed as string[], required = attachments.required_on_success as string[];
          allowed.forEach(item => allowedUnion.add(item));
          if (allowed.some(item => !(declaration.attachments as string[]).includes(item)) || required.some(item => !allowed.includes(item))) throw new Error('ATTACHMENT_SET_INVALID');
          if (row.consistency === 'none' && allowed.includes('subscription')) throw new Error('CONSISTENCY_INVALID');
          if (row.consistency !== 'none' && (!required.includes('subscription') || publicStream.validation !== 'valid')) throw new Error('PUBLIC_STREAM_REQUIRED');
          if (row.consistency === 'snapshot_barrier' && !required.includes('snapshot')) throw new Error('SNAPSHOT_REQUIRED');
        }
        if (selectedCount > 64) throw new Error('SCHEMA_COUNT_LIMIT');
        for (const schemaName of schemaNames) validateWorldSchema(row[schemaName]);
        const revision = { kind, direction: property, version: row.schema_version as number,
          digest: cidFromCanonical(new TextEncoder().encode(stableJson(schemaNames.map(schemaName => row[schemaName])))) };
        // A missing guide is recoverable for this exact immutable observation.
        if (guideState.validation !== 'valid') throw new Error('GUIDE_REQUIRED');
        target[kind] = state('valid'); revisions.push(revision);
      } catch (error) {
        if (!/^(SCHEMA_[A-Z_]+|JSON_(OBJECT_REQUIRED|DEPTH_LIMIT)|CAPABILITY_KIND_(AMBIGUOUS|INVALID)|ATTACHMENT_SET_INVALID|CONSISTENCY_INVALID|PUBLIC_STREAM_REQUIRED|SNAPSHOT_REQUIRED|GUIDE_REQUIRED)$/.test(errorCode(error))) throw error;
        target[kind] = invalid(errorCode(error));
        if (name === 'actions' && ['CAPABILITY_KIND_AMBIGUOUS', 'CAPABILITY_KIND_INVALID'].includes(errorCode(error))) union = 'unverifiable';
      }
    }
  }
  const extras = actionState.validation === 'valid' && union !== 'unverifiable'
    ? (jsonObject(board.actions).attachments as string[]).filter(item => !allowedUnion.has(item)) : [];
  if (extras.length) union = 'mismatch';
  if (actionState.validation === 'valid' && guideState.validation !== 'valid') actionState = invalid('GUIDE_REQUIRED');
  if (privateState.validation === 'valid' && guideState.validation !== 'valid') privateState = invalid('GUIDE_REQUIRED');
  if (closure.validation === 'valid' && (actionState.validation !== 'valid' || Object.values(actionKinds).some(kind => kind.validation !== 'valid'))) closure = invalid('ACTIONS_REQUIRED');
  return { validation: { publicStream, actions: { ...actionState, kinds: actionKinds, attachmentUnion: union, unsupportedAttachments: extras },
    privateMessages: { ...privateState, kinds: privateKinds }, guide: guideState, executionClosure: closure }, revisions };
}

/** Capture and verify outside the lock; select only inside G0's owner/op CAS. */
export function makeWorldManifestPreparer(options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}) {
  return async (input: TrustedManifestInput): Promise<PreparedTrustedManifest> => {
    const origin = input.origin, rawBytes = new Uint8Array(input.rawBytes), sizes = new Map<string, number>();
    const document = parseWorldManifest(rawBytes, sizes);
    if (input.signal.aborted) throw new Error('CAPABILITY_ABORTED');
    // `detail` is the machine code committed to storage, unchanged by this;
    // `reason` is the sentence a person actually reads, and it names the
    // house's own notice board as the cause rather than the owner's setup
    // (see house.world.unsupported — a real incident once let this surface
    // as an authentication failure instead).
    const disabled = (detail: string): PreparedTrustedManifest => ({
      reason: detail === 'WORLD_UNSUPPORTED' ? renderCopy(ownerLang(), 'house.world.unsupported', { origin }) : undefined,
      commit(tx) {
        if (input.signal.aborted) throw new Error('CAPABILITY_ABORTED');
        revokeHouseCapabilityView(tx, origin, detail);
      },
    });
    if (document.world_interaction === undefined) return disabled('WORLD_UNSUPPORTED');
    // The pin is a re-spelling of the ACK key; the PROOF is what makes this
    // manifest this house's word. One verifier for both, so the world and
    // relation readings can never disagree about whether a house is who it
    // says it is.
    const pinId = houseKeyFromAckHex(input.ackKeyHex);
    if (document.house_session !== undefined && jsonObject(document.house_session).ack_pubkey !== input.ackKeyHex) throw new Error('HOUSE_PIN_MISMATCH');
    const binding = verifyManifestProof({ origin, rawBytes, proofHeader: input.proofHeader, pinnedHouseKey: pinId });
    const revision = binding.manifestDigest, incarnation = binding.incarnation, proofBytes = binding.proofBytes;
    const board = envelope(document);
    let guideBytes: Uint8Array | null = null, guideState = board ? block(board, 'guide') : state('absent');
    if (board && (board.actions !== undefined || board.private_messages !== undefined) && guideState.validation === 'valid') {
      try {
        const signal = AbortSignal.any([input.signal, AbortSignal.timeout(options.timeoutMs ?? 10_000)]);
        const fetchGuide = options.fetch ?? globalThis.fetch;
        if (typeof fetchGuide !== 'function') throw new Error('GUIDE_TRANSPORT_RESPONSE_INVALID');
        const response = await fetchGuide(origin + '/v1/guide.md', { redirect: 'error', signal, headers: { accept: 'text/markdown' } }).catch(error => {
          if (error instanceof ReferenceError || error instanceof SyntaxError) throw error;
          throw new Error('GUIDE_UNAVAILABLE');
        });
        if (!(response instanceof Response)) throw new Error('GUIDE_TRANSPORT_RESPONSE_INVALID');
        if (response.redirected || (response.url && response.url !== origin + '/v1/guide.md')) throw new Error('GUIDE_REDIRECT');
        if (!response.ok) throw new Error('GUIDE_UNAVAILABLE');
        const bytes = await readBoundedBytes(response, 524288).catch(error => {
          if (errorCode(error) === 'RESPONSE_SIZE_LIMIT' || error instanceof ReferenceError || error instanceof SyntaxError) throw error;
          throw new Error('GUIDE_UNAVAILABLE');
        });
        if (input.signal.aborted) throw new Error('CAPABILITY_ABORTED');
        if (signal.aborted) throw new Error('GUIDE_UNAVAILABLE');
        if (cidFromCanonical(bytes) !== jsonObject(board.guide).sha256) throw new Error('GUIDE_DIGEST_MISMATCH');
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('GUIDE_UTF8_INVALID'); }
        guideBytes = bytes;
      } catch (error) {
        if (!['GUIDE_REDIRECT', 'GUIDE_UNAVAILABLE', 'GUIDE_DIGEST_MISMATCH', 'GUIDE_UTF8_INVALID', 'RESPONSE_SIZE_LIMIT'].includes(errorCode(error))) throw error;
        guideState = invalid(errorCode(error));
      }
    } else if (guideState.validation === 'valid') guideState = invalid('GUIDE_NOT_FETCHED');
    if (input.signal.aborted) throw new Error('CAPABILITY_ABORTED');
    return { commit(tx) {
      if (input.signal.aborted) throw new Error('CAPABILITY_ABORTED');
      ensureWorldCapabilitySchema(tx);
      const old = tx.queryOne<{ house_key: string; incarnation: string }>('SELECT house_key,incarnation FROM world_capability_views_v1 WHERE origin=? LIMIT 1', [origin])
        ?? (tx.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_capabilities'") ? tx.queryOne<{ house_key: string; incarnation: string }>('SELECT house_key,incarnation FROM world_capabilities WHERE origin=?', [origin]) : null);
      if (old && (old.house_key !== pinId || old.incarnation !== incarnation)
        && !recoveredCapabilityBinding(tx, origin, pinId, incarnation)) throw new Error('HOUSE_BINDING_CHANGED');
      const verifiedHouse = { origin, houseKey: pinId, incarnation };
      retainUncoveredManifestHistory(tx, verifiedHouse);
      const logObservation = manifestLogObservation(document);
      if (logObservation) retainManifestLog(tx, verifiedHouse, revision, logObservation);
      retainManifestLogEvidence(tx, verifiedHouse, revision, logObservation);
      const previousObservation = tx.queryOne<{ guide_bytes: Uint8Array | null }>('SELECT guide_bytes FROM world_capability_views_v1 WHERE origin=? AND capability_revision=?', [origin, revision]);
      const retainedGuide = guideBytes ?? previousObservation?.guide_bytes ?? null;
      const interpreted = board ? interpret(document, board, sizes, retainedGuide ? state('valid') : guideState,
        publicManifestLogFailure(tx, verifiedHouse, revision, document)) : null;
      // Preflight every revision before writing any high-water mark or selection.
      const accepted: KindRevision[] = [];
      for (const row of interpreted?.revisions ?? []) {
        const previous = tx.queryOne<{ version: number; schema_digest: string }>('SELECT version,schema_digest FROM world_kind_revisions WHERE origin=? AND direction=? AND kind=?', [origin, row.direction, row.kind]);
        if (previous && (row.version < previous.version || (row.version === previous.version && row.digest !== previous.schema_digest))) {
          const kinds = (row.direction === 'intent_kinds' ? interpreted!.validation.actions : interpreted!.validation.privateMessages).kinds as Record<string, CapabilityState>;
          kinds[row.kind] = invalid('SCHEMA_REVISION_CONFLICT');
          if (row.direction === 'intent_kinds' && interpreted!.validation.executionClosure.validation === 'valid') interpreted!.validation = { ...interpreted!.validation, executionClosure: invalid('ACTIONS_REQUIRED') };
        } else accepted.push(row);
      }
      for (const row of accepted) tx.execute(`INSERT INTO world_kind_revisions(origin,direction,kind,version,schema_digest) VALUES(?,?,?,?,?)
        ON CONFLICT(origin,direction,kind) DO UPDATE SET version=excluded.version,schema_digest=excluded.schema_digest`, [origin, row.direction, row.kind, row.version, row.digest]);
      tx.execute(`INSERT INTO world_capability_views_v1(origin,capability_revision,house_key,incarnation,manifest_bytes,proof_bytes,pin_provenance,guide_bytes)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(origin,capability_revision) DO NOTHING`, [origin, revision, pinId, incarnation, rawBytes, proofBytes, input.provenance, retainedGuide]);
      if (recoveredCapabilityBinding(tx,origin,pinId,incarnation)) tx.execute(`INSERT INTO world_capability_recovery_views_v1
        (origin,capability_revision,house_key,incarnation,manifest_bytes,proof_bytes,pin_provenance,guide_bytes)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(origin,house_key,incarnation,capability_revision) DO UPDATE SET guide_bytes=COALESCE(excluded.guide_bytes,guide_bytes)`,
        [origin,revision,pinId,incarnation,rawBytes,proofBytes,input.provenance,retainedGuide]);
      if (guideBytes) tx.execute('UPDATE world_capability_views_v1 SET guide_bytes=? WHERE origin=? AND capability_revision=? AND guide_bytes IS NULL', [guideBytes, origin, revision]);
      revokeHouseCapabilityView(tx, origin, 'FIRST_RELEASE_SELECTION');
      tx.execute(`INSERT INTO world_capability_current_v1(origin,capability_revision,active,detail,validation_json) VALUES(?,?,?,?,?)
        ON CONFLICT(origin) DO UPDATE SET capability_revision=excluded.capability_revision,active=excluded.active,detail=excluded.detail,validation_json=excluded.validation_json`,
      [origin, revision, interpreted ? 1 : 0, interpreted ? '' : 'CAPABILITY_BOARD_INVALID', JSON.stringify(interpreted?.validation ?? {}, (key, value) => key === 'support' || key === 'ready' ? undefined : value)]);
    } };
  };
}
