import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';

export const ACTION_RECEIPT_FEATURE_PROFILE = 'action-receipts-v1' as const;
export const ACTION_RECEIPT_SCHEMA_FINGERPRINT = 'b646c295f9197eb641251c42abdcab6efa20b271bb716c5bf329a845123cf6c6';
export interface ActionReceiptPartition { origin: string; actorId: string; storeId: string; layoutVersion: 1 }
interface Column { name: string; type: string; notNull: boolean; defaultSql: string | null; primaryKeyOrdinal: number; hidden: number }
interface Index { origin: string; unique: boolean; partial: boolean; keys: { name: string; collation: string; descending: boolean }[] }
interface Table { name: string; kind: string; strict: boolean; withoutRowid: boolean; ddlProfile: string; columns: Column[]; indexes: Index[]; foreignKeys: unknown[]; triggers: unknown[]; checks: unknown[] }
const utf8 = new TextEncoder();
/** Canonical local JSON. Accessors, holes and non-JSON values are unsupported. */
export function canonicalActionJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(item: unknown): string {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('ACTION_JSON_UNSUPPORTED');
    seen.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(item).some(key => typeof key !== 'string')) throw new Error('ACTION_JSON_UNSUPPORTED');
      if (Array.isArray(item)) {
        if (Object.keys(descriptors).length !== item.length + 1) throw new Error('ACTION_JSON_UNSUPPORTED');
        return '[' + Array.from({ length: item.length }, (_, i) => {
          const field = descriptors[String(i)]; if (!field || !('value' in field)) throw new Error('ACTION_JSON_UNSUPPORTED'); return encode(field.value);
        }).join(',') + ']';
      }
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('ACTION_JSON_UNSUPPORTED');
      return '{' + Object.keys(descriptors).sort().map(key => {
        const field = descriptors[key]!; if (!('value' in field) || !field.enumerable) throw new Error('ACTION_JSON_UNSUPPORTED');
        return JSON.stringify(key) + ':' + encode(field.value);
      }).join(',') + '}';
    } finally { seen.delete(item); }
  }
  return encode(value);
}
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function bytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
function quote(name: string): string { return '"' + name.replace(/"/g, '""') + '"'; }
function fail(): never { throw new Error('ACTION_RECEIPT_SCHEMA_UNSUPPORTED'); }
function definition(name: string, fields: string, pk: string[], unique: string[][] = []): Table {
  const columns = fields.split(',').map(field => {
    const [column, type, optional] = field.split(':');
    return { name: column!, type: type!, notNull: optional !== '?', defaultSql: null, primaryKeyOrdinal: pk.indexOf(column!) + 1, hidden: 0 };
  });
  const indexes = [pk, ...unique].map((names, i) => ({ origin: i ? 'u' : 'pk', unique: true, partial: false,
    keys: names.map(column => ({ name: column, collation: 'BINARY', descending: false })) }));
  indexes.sort((a, b) => compare(canonicalActionJson(a), canonicalActionJson(b)));
  return { name, kind: 'table', strict: false, withoutRowid: false, ddlProfile: 'plain-columns-pk-unique-v1', columns, indexes, foreignKeys: [], triggers: [], checks: [] };
}
const TABLES: Table[] = [
  definition('world_action_client_evidence', 'binding:TEXT,request_id:TEXT,source_kind:TEXT,source_digest:TEXT,core_digest:TEXT,source_bytes:BLOB,signed_result_bytes:BLOB,observed_at:INTEGER', ['binding', 'request_id', 'source_kind', 'source_digest']),
  definition('world_action_client_progress', 'binding:TEXT,request_id:TEXT,nonce:TEXT,response_bytes:BLOB,observation_bytes:BLOB,observation_revision:TEXT,pending:INTEGER,receipt_profile:TEXT:?,observation_state:BLOB:?', ['binding', 'request_id', 'nonce']),
  definition('world_action_client_requests', 'binding:TEXT,request_id:TEXT,request_bytes:BLOB,request_digest:TEXT,kind:TEXT,schema_version:INTEGER,capabilities:TEXT,valid_until:INTEGER,latest_result:BLOB:?,replacement_of:TEXT:?,execution_reference:TEXT:?,receipt_profile:TEXT:?,original_context:BLOB:?', ['binding', 'request_id']),
  definition('world_action_client_results', 'binding:TEXT,request_id:TEXT,core_digest:TEXT,result_bytes:BLOB,pending:INTEGER,receipt_profile:TEXT:?,receipt_state:BLOB:?', ['binding', 'request_id', 'core_digest']),
  definition('world_owner_action_reservations', 'binding:TEXT,reservation_id:TEXT,job_id:TEXT,input_json:TEXT,reserved_at:INTEGER,expires_at:INTEGER,request_id:TEXT:?,status:TEXT', ['binding', 'reservation_id'], [['binding', 'job_id'], ['binding', 'request_id']]),
];
export const ACTION_RECEIPT_TABLES: readonly string[] = Object.freeze(TABLES.map(table => table.name));
function columns(db: HostDb, table: string): Column[] {
  return db.queryAll<{name:string;type:string;notnull:number;dflt_value:string|null;pk:number;hidden:number}>(`PRAGMA main.table_xinfo(${quote(table)})`).map(c => ({ name: c.name, type: c.type.toUpperCase(), notNull: c.notnull === 1, defaultSql: c.dflt_value, primaryKeyOrdinal: c.pk, hidden: c.hidden }));
}
/** Recognize a deliberately bounded CREATE TABLE grammar, including all tokens.
 * Metadata cannot reveal CHECK, ON CONFLICT and similar declaration behavior. */
function guardDeclaration(sql: string, table: string, actual: Column[]): void {
  const token = /\s*("(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[(),;.])/gy;
  const tokens: string[] = []; let offset = 0;
  while (offset < sql.length) {
    if (!sql.slice(offset).trim()) break;
    token.lastIndex = offset; const match = token.exec(sql); if (!match) fail(); tokens.push(match[1]!); offset = token.lastIndex;
  }
  let at = 0;
  const keyword = (word: string) => tokens[at]?.toUpperCase() === word;
  const take = (word: string) => { if (!keyword(word)) fail(); at++; };
  const identifier = (): string => {
    const value = tokens[at++]; if (!value) return fail();
    if (value.startsWith('"')) return value.slice(1, -1).replace(/""/g, '"');
    if (value.startsWith('`')) return value.slice(1, -1).replace(/``/g, '`');
    if (value.startsWith('[')) return value.slice(1, -1);
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(value)) return fail(); return value;
  };
  take('CREATE'); take('TABLE');
  if (keyword('IF')) { take('IF'); take('NOT'); take('EXISTS'); }
  let name = identifier(); if (keyword('.')) { if (name.toLowerCase() !== 'main') fail(); take('.'); name = identifier(); }
  if (name !== table) fail(); take('(');
  const declared: {name:string;type:string;notNull:boolean}[] = []; let primaryKeys = 0;
  while (true) {
    if (keyword('PRIMARY') || keyword('UNIQUE')) {
      if (keyword('PRIMARY')) { take('PRIMARY'); take('KEY'); primaryKeys++; } else take('UNIQUE');
      take('('); identifier(); while (keyword(',')) { take(','); identifier(); } take(')');
    } else {
      const column = identifier(), type = identifier().toUpperCase(); if (!['TEXT', 'INTEGER', 'BLOB'].includes(type)) fail();
      let notNull = false; if (keyword('NOT')) { take('NOT'); take('NULL'); notNull = true; }
      declared.push({ name: column, type, notNull });
    }
    if (!keyword(',')) break; take(',');
  }
  take(')'); if (keyword(';')) take(';');
  if (at !== tokens.length || primaryKeys !== 1 || canonicalActionJson(declared) !== canonicalActionJson(actual.map(({name,type,notNull}) => ({name,type,notNull})))) fail();
}
function inspect(db: HostDb, name: string): Table | null {
  if (db.queryOne('SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE', [name])) fail();
  const entry = db.queryOne<{type:string;sql:string}>('SELECT type,sql FROM main.sqlite_master WHERE name=? COLLATE NOCASE', [name]);
  if (!entry) return null; if (entry.type !== 'table' || typeof entry.sql !== 'string') fail();
  const actual = columns(db, name); guardDeclaration(entry.sql, name, actual);
  const foreignKeys = db.queryAll(`PRAGMA main.foreign_key_list(${quote(name)})`);
  const triggers = db.queryAll("SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name=? COLLATE NOCASE UNION ALL SELECT name FROM sqlite_temp_master WHERE type='trigger' AND tbl_name=? COLLATE NOCASE", [name, name]);
  if (foreignKeys.length || triggers.length) fail();
  const indexes = db.queryAll<{name:string;origin:string;unique:number;partial:number}>(`PRAGMA main.index_list(${quote(name)})`).map(index => {
    if (!['pk', 'u'].includes(index.origin)) fail();
    const keys = db.queryAll<{key:number;name:string;cid:number;coll:string;desc:number}>(`PRAGMA main.index_xinfo(${quote(index.name)})`)
      .filter(term => term.key === 1).map(term => { if (term.cid < 0 || !term.name) return fail(); return { name: term.name, collation: term.coll, descending: term.desc === 1 }; });
    return { origin: index.origin, unique: index.unique === 1, partial: index.partial === 1, keys };
  }).sort((a, b) => compare(canonicalActionJson(a), canonicalActionJson(b)));
  return { name, kind: 'table', strict: false, withoutRowid: false, ddlProfile: 'plain-columns-pk-unique-v1', columns: actual, indexes, foreignKeys, triggers, checks: [] };
}
function identity(db: HostDb, expected: ActionReceiptPartition): ActionReceiptPartition {
  if (!db.queryOne("SELECT 1 FROM main.sqlite_master WHERE name='execution_partition_identity_v1' AND type='table'")) throw new Error('ACTION_RECEIPT_PARTITION_MISMATCH');
  if (expected.layoutVersion !== 1 || !expected.origin || !expected.actorId || !expected.storeId || db.queryOne("SELECT 1 FROM sqlite_temp_master WHERE name='execution_partition_identity_v1' COLLATE NOCASE")) throw new Error('ACTION_RECEIPT_PARTITION_MISMATCH');
  const rows = db.queryAll<{singleton:number;origin:string;actor_id:string;store_id:string;layout_version:number}>('SELECT * FROM main.execution_partition_identity_v1');
  const row = rows[0];
  if (rows.length !== 1 || !row || row.singleton !== 1 || row.origin !== expected.origin || row.actor_id !== expected.actorId || row.store_id !== expected.storeId || row.layout_version !== 1) throw new Error('ACTION_RECEIPT_PARTITION_MISMATCH');
  return { ...expected };
}
export function assertActionReceiptJournalSchema(executionDb: HostDb, expectedPartition: ActionReceiptPartition) {
  const partition = identity(executionDb, expectedPartition);
  const tables = TABLES.map(table => { const actual = inspect(executionDb, table.name); if (!actual || canonicalActionJson(actual) !== canonicalActionJson(table)) fail(); return actual; });
  const schemaFingerprint = cidFromCanonical(bytes(utf8.encode('POPCLAW_ACTION_RECEIPT_SCHEMA_V1\n'), utf8.encode(canonicalActionJson({ profile: ACTION_RECEIPT_FEATURE_PROFILE, shapeVersion: 1, tables }))));
  if (schemaFingerprint !== ACTION_RECEIPT_SCHEMA_FINGERPRINT) fail();
  return { featureProfile: ACTION_RECEIPT_FEATURE_PROFILE, schemaFingerprint, partition };
}
export interface ActionOriginalContent { columns: string[]; primaryKey: string[]; rowCount: string; contentDigest: string }
type Cell = [string] | [string, string];
/** SQL casts bypass JS integer rounding and preserve even malformed TEXT bytes. */
function snapshotTableOriginalContent(db: HostDb, name: string, projection?: Pick<ActionOriginalContent, 'columns' | 'primaryKey'>): ActionOriginalContent {
  const actual = columns(db, name);
  const selected = projection?.columns ?? actual.map(c => c.name);
  const primaryKey = projection?.primaryKey ?? actual.filter(c => c.primaryKeyOrdinal > 0).sort((a,b) => a.primaryKeyOrdinal - b.primaryKeyOrdinal).map(c => c.name);
  if (!primaryKey.length || !selected.length || selected.some(c => !actual.some(a => a.name === c)) || primaryKey.some(c => !selected.includes(c))) fail();
  const expressions = selected.flatMap((c,i) => [
    `typeof(${quote(c)}) AS t${i}`,
    `CASE typeof(${quote(c)}) WHEN 'integer' THEN CAST(${quote(c)} AS TEXT) WHEN 'text' THEN lower(hex(CAST(${quote(c)} AS BLOB))) WHEN 'blob' THEN lower(hex(${quote(c)})) WHEN 'real' THEN ${quote(c)} ELSE NULL END AS v${i}`,
  ]);
  const rows = db.queryAll<Record<string,unknown>>(`SELECT ${expressions.join(',')} FROM main.${quote(name)}`).map(row => {
    const cells: Cell[] = selected.map((_,i) => {
      const type = row['t'+i], value = row['v'+i];
      if (type === 'null') return ['null'];
      if (type === 'integer' && typeof value === 'string' && /^-?(0|[1-9][0-9]*)$/.test(value)) return ['integer', value];
      if ((type === 'text' || type === 'blob') && typeof value === 'string' && /^(?:[0-9a-f]{2})*$/.test(value)) return [type, value];
      if (type === 'real' && typeof value === 'number' && !Number.isNaN(value)) {
        const buffer = new Uint8Array(8); new DataView(buffer.buffer).setFloat64(0, value, false); return ['real', Array.from(buffer, b => b.toString(16).padStart(2,'0')).join('')];
      }
      throw new Error('ACTION_ORIGINAL_CELL_UNSUPPORTED');
    });
    const key = primaryKey.map(c => cells[selected.indexOf(c)]!); if (key.some(cell => cell[0] === 'null')) fail();
    return { key: canonicalActionJson(key), record: utf8.encode(canonicalActionJson([key, cells])) };
  }).sort((a,b) => compare(a.key,b.key));
  if (rows.some((row,i) => i > 0 && rows[i-1]!.key === row.key)) fail();
  const records = rows.flatMap(row => { const length = new Uint8Array(8); new DataView(length.buffer).setBigUint64(0, BigInt(row.record.length), false); return [length, row.record]; });
  return { columns: [...selected], primaryKey: [...primaryKey], rowCount: String(rows.length), contentDigest: cidFromCanonical(bytes(
    utf8.encode('POPCLAW_ACTION_ORIGINAL_COLUMNS_V1\n'), utf8.encode(canonicalActionJson({ table: name, columns: selected, primaryKey })), utf8.encode('\n'), ...records)) };
}
/** Keep the original five-table public snapshot boundary unchanged. */
export function snapshotActionOriginalContent(db: HostDb, name: string, projection?: Pick<ActionOriginalContent, 'columns' | 'primaryKey'>): ActionOriginalContent {
  if (!ACTION_RECEIPT_TABLES.includes(name)) fail();
  return snapshotTableOriginalContent(db, name, projection);
}
/** Shared physical inspection and lossless snapshot primitives. Callers bind
 * these to their own frozen table descriptor before using them as evidence. */
export { definition as defineActionJournalTable, inspect as inspectActionJournalTable,
  snapshotTableOriginalContent as snapshotActionJournalTableOriginalContent };

export interface ActionReceiptPreparationReport {
  featureProfile: typeof ACTION_RECEIPT_FEATURE_PROFILE; schemaFingerprint: string; partition: ActionReceiptPartition;
  createdTables: string[]; addedColumns: {table:string;column:string}[]; preservedLegacyCounts: Record<string,string>;
  originalContent: Record<string,{before:ActionOriginalContent|null;after:ActionOriginalContent}>;
}
export function prepareActionReceiptJournal(input: {executionDb:HostDb;expectedPartition:ActionReceiptPartition;expectedSchemaFingerprint:string}): ActionReceiptPreparationReport {
  if (input.expectedSchemaFingerprint !== ACTION_RECEIPT_SCHEMA_FINGERPRINT) fail();
  return input.executionDb.transaction(tx => {
    identity(tx, input.expectedPartition);
    // Preflight every existing shape and content before the first mutation.
    const planned = TABLES.map(expected => {
      const actual = inspect(tx, expected.name);
      if (!actual) return { expected, actual, before: null, missing: [] as Column[] };
      const missing = expected.columns.slice(actual.columns.length);
      const permitted = expected.name === 'world_action_client_requests' ? ['execution_reference', 'receipt_profile', 'original_context']
        : expected.name === 'world_action_client_results' ? ['receipt_profile', 'receipt_state']
        : expected.name === 'world_action_client_progress' ? ['receipt_profile', 'observation_state'] : [];
      if (missing.some(c => c.notNull || !permitted.includes(c.name)) || canonicalActionJson(actual) !== canonicalActionJson({ ...expected, columns: expected.columns.slice(0, actual.columns.length) })) fail();
      return { expected, actual, missing, before: snapshotActionOriginalContent(tx, expected.name) };
    });
    const createdTables: string[] = [], addedColumns: {table:string;column:string}[] = [];
    const originalContent: ActionReceiptPreparationReport['originalContent'] = {}, preservedLegacyCounts: Record<string,string> = {};
    for (const {expected, actual, missing} of planned) {
      if (!actual) {
        const fields = expected.columns.map(c => `${quote(c.name)} ${c.type}${c.notNull ? ' NOT NULL' : ''}`);
        for (const index of expected.indexes) fields.push(`${index.origin === 'pk' ? 'PRIMARY KEY' : 'UNIQUE'}(${index.keys.map(k => quote(k.name)).join(',')})`);
        tx.execute(`CREATE TABLE ${quote(expected.name)} (${fields.join(',')})`); createdTables.push(expected.name);
      } else for (const column of missing) {
        tx.execute(`ALTER TABLE ${quote(expected.name)} ADD COLUMN ${quote(column.name)} ${column.type}`); addedColumns.push({table:expected.name,column:column.name});
      }
    }
    const verified = assertActionReceiptJournalSchema(tx, input.expectedPartition);
    for (const {expected,before} of planned) {
      const after = snapshotActionOriginalContent(tx, expected.name, before ?? undefined);
      if (before ? canonicalActionJson(before) !== canonicalActionJson(after) : after.rowCount !== '0') throw new Error('ACTION_ORIGINAL_CONTENT_CHANGED');
      if (before) preservedLegacyCounts[expected.name] = before.rowCount;
      originalContent[expected.name] = { before, after };
    }
    return { ...verified, createdTables, addedColumns, originalContent, preservedLegacyCounts };
  });
}

export const MANUAL_ACTION_RECEIPT_PROFILE = 'first-release-1ff7-action-v1' as const;
export const NATIVE_ACTION_RECEIPT_PROFILE = 'first-release-1ff7-native-action-v1' as const;
export const PUBLIC_ENVELOPE_ACTION_RECEIPT_PROFILE = 'public-envelope-01.3-action-v1' as const;
export const PUBLIC_ENVELOPE_NATIVE_ACTION_RECEIPT_PROFILE = 'public-envelope-01.3-native-action-v1' as const;
export const ACTION_RECEIPT_PROFILES = [MANUAL_ACTION_RECEIPT_PROFILE, NATIVE_ACTION_RECEIPT_PROFILE, PUBLIC_ENVELOPE_ACTION_RECEIPT_PROFILE, PUBLIC_ENVELOPE_NATIVE_ACTION_RECEIPT_PROFILE] as const;
export function isNativeActionReceiptProfile(value: unknown): boolean {
  return value === NATIVE_ACTION_RECEIPT_PROFILE || value === PUBLIC_ENVELOPE_NATIVE_ACTION_RECEIPT_PROFILE;
}
export function isActionReceiptProfile(value: unknown): value is ActionReceiptStateV1['profile'] {
  return ACTION_RECEIPT_PROFILES.some(profile => profile === value);
}
export interface ActionReceiptStateV1 {
  profile: typeof ACTION_RECEIPT_PROFILES[number]; status: number; revision: string; semanticDigest: string;
  attachmentContract: import('./action-wire.js').VerifiedActionReceipt['attachmentContract'];
  attachments: import('./action-wire.js').ActionAttachmentDisposition[];
  baseAccounting: { state: 'not_terminal' | 'pending' | 'applied' | 'blocked'; reason: string; executionReference: import('./action-client.js').WorldActionExecutionReference | null };
}
export function encodeActionReceiptState(state: ActionReceiptStateV1): Uint8Array {
  const encoded = utf8.encode(canonicalActionJson(state)); decodeActionReceiptState(encoded); return encoded;
}
export function decodeActionReceiptState(raw: Uint8Array): ActionReceiptStateV1 {
  if (!(raw instanceof Uint8Array) || raw.length > 32768) throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw));
  const state = value as ActionReceiptStateV1;
  const keys = (object: unknown, expected: string) => !!object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join() === expected;
  const digest = (s: unknown) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
  const reason = (s: unknown) => typeof s === 'string' && s.length > 0 && s.length <= 256;
  if (!keys(state, 'attachmentContract,attachments,baseAccounting,profile,revision,semanticDigest,status') || !isActionReceiptProfile(state.profile)
    || ![1,2,3,4,5].includes(state.status) || typeof state.revision !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(state.revision) || BigInt(state.revision) > 18446744073709551615n || !digest(state.semanticDigest)
    || !keys(state.attachmentContract, 'outcome,reason') || !['valid','violated','unsupported'].includes(state.attachmentContract.outcome) || !reason(state.attachmentContract.reason)
    || !keys(state.baseAccounting, 'executionReference,reason,state') || !['not_terminal','pending','applied','blocked'].includes(state.baseAccounting.state) || !reason(state.baseAccounting.reason)
    || !Array.isArray(state.attachments) || state.attachments.length > 3 || new Set(state.attachments.map(a => a.kind)).size !== state.attachments.length) throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
  const reference = state.baseAccounting.executionReference;
  if (reference !== null) {
    const expected = reference.kind === 'owner_action' || reference.kind === 'native_policy' ? 'kind,reservationId' : reference.kind === 'read_state' ? 'kind,participationId,reservationId' : reference.kind === 'participation' ? 'jobId,kind,participationId,reservationId' : '';
    if (!expected || !keys(reference, expected) || Object.values(reference).some(v => typeof v !== 'string' || !v.length || v.length > 16384)) throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
  }
  if (isNativeActionReceiptProfile(state.profile) ? reference?.kind !== 'native_policy' || !digest(reference.reservationId) : reference?.kind === 'native_policy') throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
  for (const attachment of state.attachments) {
    if (!keys(attachment, 'dependencyGroup,digest,idempotencyIdentity,install,kind,reason,retry,selection,validation') || !['snapshot','subscription','participation'].includes(attachment.kind)
      || !digest(attachment.digest) || !['valid','invalid','unsupported'].includes(attachment.validation) || !['not_selected','pending','applied','failed','blocked'].includes(attachment.install)
      || !reason(attachment.reason) || attachment.selection !== null || (attachment.dependencyGroup !== null && !digest(attachment.dependencyGroup))
      || typeof attachment.idempotencyIdentity !== 'string' || attachment.idempotencyIdentity.length > 256 || !keys(attachment.retry, 'attempts,nextAt')
      || !Number.isSafeInteger(attachment.retry.attempts) || attachment.retry.attempts < 0 || attachment.retry.attempts > 1000 || (attachment.retry.nextAt !== null && (!Number.isSafeInteger(attachment.retry.nextAt) || attachment.retry.nextAt < 0))) throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
    // This implementation has no installer or serializable live selection.
    if (attachment.install === 'pending' || attachment.install === 'applied') throw new Error('ACTION_RECEIPT_INSTALLER_UNSUPPORTED');
  }
  if (state.baseAccounting.state === 'applied' && (state.status < 3 || (isNativeActionReceiptProfile(state.profile) ? reference?.kind !== 'native_policy' : reference?.kind !== 'owner_action'))) throw new Error('ACTION_RECEIPT_STATE_UNSUPPORTED');
  return state;
}
/** Must run inside the caller's receipt transaction after semantic validation. */
export function recordActionReceiptEvidence(tx: HostDb, input: {binding:string;requestId:string;coreDigest:string;sourceKind:'push_result'|'status_response';sourceBytes:Uint8Array;signedResultBytes:Uint8Array;observedAt:number}): void {
  if (input.sourceBytes.length > 1048576 || input.signedResultBytes.length > 1048576 || !input.sourceBytes.length || !input.signedResultBytes.length) throw new Error('RESULT_SIZE_LIMIT');
  const sourceDigest = cidFromCanonical(input.sourceBytes);
  const previous = tx.queryOne<{core_digest:string;source_bytes:Uint8Array;signed_result_bytes:Uint8Array}>('SELECT * FROM world_action_client_evidence WHERE binding=? AND request_id=? AND source_kind=? AND source_digest=?', [input.binding,input.requestId,input.sourceKind,sourceDigest]);
  const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte,i) => byte === b[i]);
  if (previous) {
    if (previous.core_digest !== input.coreDigest || !equal(previous.source_bytes,input.sourceBytes) || !equal(previous.signed_result_bytes,input.signedResultBytes)) throw new Error('ACTION_EVIDENCE_CONFLICT'); return;
  }
  tx.execute('INSERT INTO world_action_client_evidence(binding,request_id,source_kind,source_digest,core_digest,source_bytes,signed_result_bytes,observed_at) VALUES(?,?,?,?,?,?,?,?)',
    [input.binding,input.requestId,input.sourceKind,sourceDigest,input.coreDigest,input.sourceBytes,input.signedResultBytes,input.observedAt]);
}

/** G0 independently calls this before and after sole preparation on its selected
 * handle. Saved projections keep additive columns out of the comparison. */
export function snapshotActionReceiptOriginalContent(executionDb: HostDb, saved?: Record<string, ActionOriginalContent | null>): Record<string, ActionOriginalContent | null> {
  return Object.fromEntries(TABLES.map(table => {
    const present = executionDb.queryOne('SELECT 1 FROM main.sqlite_master WHERE type=\'table\' AND name=?', [table.name]);
    return [table.name, present ? snapshotActionOriginalContent(executionDb, table.name, saved?.[table.name] ?? undefined) : null];
  }));
}
