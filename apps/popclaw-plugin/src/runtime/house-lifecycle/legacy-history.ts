/** Finite supported in-place writer/retention subset (PC008 frozen contract).
 * This proves local root/origin control history only, never actor-global history.
 * There is no migration, cleanup, or historical-certification write here. */
import type { HostDb } from '../../host/host-db.js';
import { storageInPlaceHistoryKnown } from '../../host/storage-maintenance.js';
import type { ParticipationRow } from './participation-store.js';

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

export function neverControlSubset(db: HostDb, origin: string, row: ParticipationRow | null | undefined): boolean {
  try {
    if (!emptyControlState(row) || row.house_origin !== origin || !storageInPlaceHistoryKnown(db)) return false;
    for (const [table, schema] of Object.entries(SCHEMAS)) {
      const columns = db.queryAll<{name:string;type:string;notnull:number}>(`PRAGMA table_info(${table})`);
      if (columns.length !== Object.keys(schema).length || columns.some(c => schema[c.name] !== c.type)) return false;
      if (table === 'house_participation' && columns.some(c => ['session_id','ack_key_hex','inbox_read_token','house_revision','lease_expires_at'].includes(c.name) && c.notnull !== 1)) return false;
    }
    for (const name of ['034-house-binding-pin.sql','040-house-read-declaration.sql']) {
      if (!db.queryOne('SELECT filename FROM _migrations WHERE filename=?',[name])) return false;
    }
    // ALL leaves are retained proof, including settled/unsupported rows.
    if (db.queryOne('SELECT request_id FROM house_lifecycle_outbox WHERE house_origin=? LIMIT 1',[origin])) return false;
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
