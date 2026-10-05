/** Finite supported in-place writer/retention subset (PC008 frozen contract).
 * This proves local root/origin control history only, never actor-global history.
 * There is no migration, cleanup, or historical-certification write here. */
import type { HostDb } from '../../host/host-db.js';
import { storageInPlaceHistoryKnown } from '../../host/storage-maintenance.js';
import type { ParticipationRow } from './participation-store.js';
import type { HouseParticipationSource, HouseParticipationPlan } from './participation-admission.js';
import { entryDigest } from './participation-journal.js';
import { pinnedBinding } from '../../world/house-binding-pin.js';
import { readVerifiedDeclaration } from '../../world/house-read-declaration.js';

export function emptyControlState(row: ParticipationRow | null | undefined): row is ParticipationRow {
  return !!row && row.session_id === '' && row.ack_key_hex === '' && row.inbox_read_token === ''
    && row.house_revision === 0 && row.lease_expires_at === 0
    && typeof row.installation_id === 'string' && row.installation_id.length > 0
    && Number.isSafeInteger(row.op_seq) && row.op_seq >= 0
    && (row.pending_enter_request_id === null || (typeof row.pending_enter_request_id === 'string' && row.pending_enter_request_id.length > 0));
}
const SCHEMAS: Record<string, Record<string, string>> = {
  house_binding_pin: {origin:'TEXT',house_key:'TEXT',incarnation:'TEXT',source:'TEXT',first_trusted_at:'INTEGER',confirmed_at:'INTEGER',blocked_reason:'TEXT',blocked_at:'INTEGER',revision:'INTEGER'},
  house_read_declaration: {origin:'TEXT',house_key:'TEXT',schemes:'TEXT',session_board:'INTEGER',updated_at:'INTEGER',browser_entry:'TEXT'},
  house_participation: {
    house_origin:'TEXT', installation_id:'TEXT', op_seq:'INTEGER', desired:'TEXT', phase:'TEXT', session_id:'TEXT',
    house_revision:'INTEGER', lease_expires_at:'INTEGER', inbox_read_token:'TEXT', renew_interval_seconds:'INTEGER',
    renew_after:'INTEGER', ack_key_hex:'TEXT', pending_enter_request_id:'TEXT', remote_status:'TEXT', remote_error:'TEXT', updated_at:'INTEGER',
  },
  house_lifecycle_outbox: {request_id:'TEXT',house_origin:'TEXT',op:'TEXT',op_seq:'INTEGER',ack_key_hex:'TEXT',installation_id:'TEXT',created_at:'INTEGER',settled_at:'INTEGER'},
  house_lifecycle_commands: {request_id:'TEXT',kind:'TEXT',house_origin:'TEXT',baseline_seq:'INTEGER',state:'TEXT',running_epoch:'INTEGER',result_json:'TEXT',created_at:'INTEGER',payload_bytes:'BLOB',effect_json:'TEXT',session_id:'TEXT',house_revision:'INTEGER',ack_key_hex:'TEXT',installation_id:'TEXT',deadline_at:'INTEGER'},
};
const CONTROL_REFUSALS = new Set(['SESSION_FENCED','LEASE_EXPIRED','EXECUTOR_BUSY','AUTH_INVALID','AUDIENCE_MISMATCH','IDEMPOTENCY_CONFLICT']);
const JOURNAL_SCHEMAS: Record<string, Record<string, string>> = {
  house_initial_setup: {actor_id:'TEXT',installation_id:'TEXT',purpose:'TEXT',eligibility_ref:'TEXT',original_intent_ref:'TEXT',state:'TEXT'},
  house_participation_attempts: {attempt_ref:'TEXT',admission_request_key:'TEXT',original_intent_ref:'TEXT',original_operation_ref:'TEXT',plan_digest:'TEXT',plan_json:'TEXT',state:'TEXT',receipt_json:'TEXT'},
};
const UNSTARTED_CODES = new Set(['HOUSE_CONTROL_HISTORY_UNPROVEN','HOUSE_MANIFEST_UNAVAILABLE','STALE_OPERATION']);

function knownControlSchema(db: HostDb, journal = false): boolean {
  for (const [table, schema] of Object.entries(journal ? {...SCHEMAS, ...JOURNAL_SCHEMAS} : SCHEMAS)) {
    const columns = db.queryAll<{name:string;type:string;notnull:number}>(`PRAGMA table_info(${table})`);
    if (columns.length !== Object.keys(schema).length || columns.some(c => schema[c.name] !== c.type)) return false;
    if (table === 'house_participation' && columns.some(c => ['session_id','ack_key_hex','inbox_read_token','house_revision','lease_expires_at'].includes(c.name) && c.notnull !== 1)) return false;
    if (table in JOURNAL_SCHEMAS && columns.some(c => c.notnull !==
      (table === 'house_participation_attempts' && ['attempt_ref','receipt_json'].includes(c.name) ? 0 : 1))) return false;
  }
  for (const name of ['034-house-binding-pin.sql','040-house-read-declaration.sql', ...(journal ? ['044-house-participation-admission.sql'] : [])]) {
    if (!db.queryOne('SELECT filename FROM _migrations WHERE filename=?',[name])) return false;
  }
  return true;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
}
function nativeSource(value: unknown, current: HouseParticipationSource): HouseParticipationSource | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const s = value as Record<string, unknown>;
  const initial = s.reason === 'initial_me_setup';
  if (!initial && s.reason !== 'explicit_owner_join') return undefined;
  if (!exactKeys(s,['reason','origin','actorId','installationId','originalIntentRef','originalOperationRef','authorityRef',...(initial ? ['eligibilityRef'] : [])])
    || s.origin !== current.origin || s.actorId !== current.actorId || s.installationId !== current.installationId
    || ['originalIntentRef','originalOperationRef','authorityRef'].some(key => typeof s[key] !== 'string' || !s[key])) return undefined;
  if (initial) {
    const logical = entryDigest({actorId:current.actorId,installationId:current.installationId,purpose:'initial_me_setup'});
    if (s.eligibilityRef !== logical || s.originalIntentRef !== logical || s.originalOperationRef !== logical) return undefined;
  } else if (s.originalIntentRef !== s.originalOperationRef || s.originalIntentRef !== s.authorityRef) return undefined;
  return s as unknown as HouseParticipationSource;
}
function noCommandControl(c: Record<string, unknown>): boolean {
  return (c.session_id === null || c.session_id === '') && (c.ack_key_hex === null || c.ack_key_hex === '')
    && (c.house_revision === null || c.house_revision === 0) && c.payload_bytes === null
    && c.installation_id === null && c.deadline_at === null;
}

/** Only the known native journal-before-admit writer and complete in-place
 * retention can prove these finished failures never reached admission. Error
 * strings alone cannot: the manager's general catch can return the same code.
 * Rechecking after stage permits ONLY our exact new prepared attempt. */
export function unstartedSessionlessHistory(db: HostDb, source: HouseParticipationSource, requestId: string,
  ownPlan?: HouseParticipationPlan): boolean {
  try {
    const origin = source.origin;
    if (!nativeSource(source,source) || !storageInPlaceHistoryKnown(db) || !knownControlSchema(db,true)
      || db.queryOne('SELECT 1 FROM house_participation WHERE house_origin=?',[origin])
      || db.queryOne('SELECT 1 FROM house_lifecycle_outbox WHERE house_origin=?',[origin])) return false;
    const binding = pinnedBinding(db,origin);
    if (binding && readVerifiedDeclaration(db,binding)?.sessionBoard) return false;
    const intents = new Set([source.originalIntentRef]);
    let currentFound = false;
    for (const c of db.queryAll<Record<string,unknown>>('SELECT * FROM house_lifecycle_commands WHERE house_origin=?',[origin])) {
      if (!noCommandControl(c)) return false;
      if (c.kind === 'status') {
        const r = c.result_json === null ? undefined : jsonObject(c.result_json);
        if (c.result_json !== null && (!r || (r.sessionId !== undefined && r.sessionId !== '')
          || (r.houseRevision !== undefined && r.houseRevision !== 0) || r.remoteStatus === 'confirmed'
          || (typeof r.errorCode === 'string' && CONTROL_REFUSALS.has(r.errorCode)))) return false;
        continue;
      }
      const effect = jsonObject(c.effect_json);
      const retainedSource = effect && exactKeys(effect,['participationSource']) ? nativeSource(effect.participationSource,source) : undefined;
      if (c.kind !== 'login' || c.baseline_seq !== 0 || !retainedSource) return false;
      intents.add(retainedSource.originalIntentRef);
      if (c.request_id === requestId) {
        if (c.state !== 'running' || c.result_json !== null
          || Object.keys(source).some(key => (retainedSource as unknown as Record<string,unknown>)[key] !== (source as unknown as Record<string,unknown>)[key])) return false;
        currentFound = true;
        continue;
      }
      const r = jsonObject(c.result_json);
      if (c.state !== 'done' || !r || !exactKeys(r,['scope','origin','status','sessionId','errorCode'])
        || r.scope !== 'local_installation' || r.origin !== origin || r.status !== 'connecting'
        || r.sessionId !== '' || typeof r.errorCode !== 'string' || !UNSTARTED_CODES.has(r.errorCode)) return false;
    }
    if (!currentFound) return false;
    const refs = [...intents];
    // Include orphaned same-origin attempts as well as ALL operations of each
    // retained logical intent. Malformed journal JSON fails closed in SQLite.
    const attempts = db.queryAll<Record<string,unknown>>(`SELECT * FROM house_participation_attempts
      WHERE original_intent_ref IN (${refs.map(() => '?').join(',')}) OR json_extract(plan_json,'$.origin')=?`,[...refs,origin]);
    if (!ownPlan) return attempts.length === 0;
    return attempts.length === 1 && attempts.every(a => a.attempt_ref === ownPlan.attemptRef
      && a.admission_request_key === ownPlan.admissionRequestKey && a.plan_digest === ownPlan.planDigest
      && a.original_intent_ref === source.originalIntentRef && a.original_operation_ref === source.originalOperationRef
      && a.plan_json === JSON.stringify(ownPlan) && a.state === 'prepared' && a.receipt_json === null);
  } catch { return false; }
}

export function neverControlSubset(db: HostDb, origin: string, row: ParticipationRow | null | undefined): boolean {
  return sessionlessControlSubset(db, origin, row, false);
}

/** Ordinary configured joins keep their own sessionless leave ledger. Known
 * control facts, unknown schema and unreadable storage still refuse admission. */
export function configuredControlSubset(db: HostDb, origin: string, row: ParticipationRow | null | undefined): boolean {
  return sessionlessControlSubset(db, origin, row, true);
}

function sessionlessControlSubset(db: HostDb, origin: string, row: ParticipationRow | null | undefined, allowLocalLeaves: boolean): boolean {
  try {
    if (!emptyControlState(row) || row.house_origin !== origin || !storageInPlaceHistoryKnown(db) || !knownControlSchema(db)) return false;
    // Local sessionless leaves are durable participation intent, not evidence
    // of a control request. A nonempty ACK pin or another installation refuses.
    if (allowLocalLeaves) {
      if (db.queryOne(`SELECT request_id FROM house_lifecycle_outbox
        WHERE house_origin=? AND (ack_key_hex!='' OR installation_id!=?) LIMIT 1`, [origin, row.installation_id])) return false;
    } else if (db.queryOne('SELECT request_id FROM house_lifecycle_outbox WHERE house_origin=? LIMIT 1',[origin])) return false;
    for (const cmd of db.queryAll<{session_id:unknown;ack_key_hex:unknown;house_revision:unknown;result_json:unknown}>(
      'SELECT session_id,ack_key_hex,house_revision,result_json FROM house_lifecycle_commands WHERE house_origin=?',[origin])) {
      if ((cmd.session_id !== null && cmd.session_id !== '') || (cmd.ack_key_hex !== null && cmd.ack_key_hex !== '')
        || (cmd.house_revision !== null && cmd.house_revision !== 0)) return false;
      if (cmd.result_json !== null) {
        if (typeof cmd.result_json !== 'string') return false;
        const result: unknown = JSON.parse(cmd.result_json);
        if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
        const r = result as Record<string, unknown>;
        if ((r.sessionId !== undefined && r.sessionId !== '') || (r.houseRevision !== undefined && r.houseRevision !== 0)
          || r.remoteStatus === 'confirmed' || (typeof r.errorCode === 'string' && CONTROL_REFUSALS.has(r.errorCode))) return false;
      }
    }
    return true;
  } catch { return false; }
}
