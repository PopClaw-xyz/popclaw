/** Explicit preparation, runtime schema assertion and row operations for the
 * recipient-bound private material tables (`world_private_messages_v2`,
 * `world_private_states_v2`).
 *
 * The live first-release path NEVER creates schema lazily: a consumer or reader
 * may only open these tables after G0 ran {@link preparePrivateMessageJournal}
 * inside its offline maintenance transaction, and every use re-asserts the
 * exact physical shape through {@link assertPrivateMessageJournalSchema}.
 *
 * Preparation is one target transaction owned entirely by this module: it
 * rejects an incompatible existing shape instead of repairing it, preserves all
 * original bytes (lossless before/after snapshots), and reports a fixed
 * fingerprint G0 can register in its catalog reservation. */
import { cidFromCanonical } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';
import { canonicalActionJson, snapshotActionJournalTableOriginalContent, type ActionOriginalContent } from './action-receipt-journal.js';
import { privateMessageStateDigest } from './private-message-evidence.js';

export const PRIVATE_MESSAGE_FEATURE_PROFILE = 'first-release-private-messages-v1' as const;
export const PRIVATE_MESSAGE_FEATURE_TABLES = Object.freeze(['world_private_messages_v2', 'world_private_states_v2']);
/** Exact historical v2 schema, byte-for-byte in intent; normalization only
 * removes `IF NOT EXISTS`, casing and whitespace when comparing to SQLite. */
const PRIVATE_MESSAGE_DDL: readonly { readonly name: string; readonly sql: string }[] = Object.freeze([
  {
    name: 'world_private_messages_v2',
    sql: `CREATE TABLE IF NOT EXISTS world_private_messages_v2 (
    binding TEXT NOT NULL, message_id TEXT NOT NULL, event_id TEXT NOT NULL,
    envelope_bytes BLOB NOT NULL, plaintext_bytes BLOB NOT NULL, envelope_digest TEXT NOT NULL,
    plaintext_digest TEXT NOT NULL, wrapper_digest TEXT NOT NULL,
    consumer_pending INTEGER NOT NULL CHECK(consumer_pending IN (0,1)), PRIMARY KEY(binding,message_id))`,
  },
  {
    name: 'world_private_states_v2',
    sql: `CREATE TABLE IF NOT EXISTS world_private_states_v2 (
    binding TEXT NOT NULL, state_ref TEXT NOT NULL, revision TEXT NOT NULL,
    state_digest TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(binding,state_ref))`,
  },
]);

const utf8 = new TextEncoder();
const bytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
function fail(code: string): never { throw new Error(code); }
const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
/** Same normalization family the public journal uses: drop IF NOT EXISTS,
 * collapse whitespace, lowercase — then require exact equality. */
function normalizedSql(sql: string): string {
  return sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/\s+/g, ' ').replace(/\s;$/, '').trim().toLowerCase();
}

export interface PrivateMessageTableShape {
  readonly name: string;
  readonly normalizedSql: string;
}
const PRIVATE_MESSAGE_SHAPE: readonly PrivateMessageTableShape[] = Object.freeze(
  PRIVATE_MESSAGE_DDL.map(table => ({ name: table.name, normalizedSql: normalizedSql(table.sql) })));

export const PRIVATE_MESSAGE_SCHEMA_FINGERPRINT: string = cidFromCanonical(bytes(
  utf8.encode('POPCLAW_PRIVATE_MESSAGE_SCHEMA_V1\n'),
  utf8.encode(canonicalActionJson({ profile: PRIVATE_MESSAGE_FEATURE_PROFILE, shapeVersion: 1, tables: PRIVATE_MESSAGE_SHAPE })),
));

interface ColumnInfo { name: string; type: string; notnull: number; pk: number }
/** Physical inspection: exact stored DDL, column layout, and the absence of
 * triggers, foreign keys, explicit indexes and temp-table shadows. */
function inspectPrivateMessageTable(db: HostDb, name: string, expectedSql: string): boolean {
  if (db.queryOne('SELECT 1 FROM sqlite_temp_master WHERE name=? COLLATE NOCASE', [name])) fail(`PRIVATE_MESSAGE_TEMP_SHADOW:${name}`);
  const entry = db.queryOne<{ type: string; sql: string }>('SELECT type,sql FROM main.sqlite_master WHERE name=? COLLATE NOCASE', [name]);
  if (!entry) return false;
  if (entry.type !== 'table' || typeof entry.sql !== 'string' || normalizedSql(entry.sql) !== expectedSql) fail(`PRIVATE_MESSAGE_SCHEMA_INVALID:${name}`);
  const columns = db.queryAll<ColumnInfo>(`PRAGMA main.table_xinfo(${quote(name)})`);
  const declared = [...expectedSql.matchAll(/\b([a-z_0-9]+)\s+(?:TEXT|INTEGER|BLOB)\b/gi)].map(match => match[1]!.toLowerCase());
  const actual = columns.map(column => column.name.toLowerCase());
  if (declared.length !== actual.length || declared.some((column, index) => column !== actual[index])) fail(`PRIVATE_MESSAGE_SCHEMA_INVALID:${name}`);
  if (columns.some(column => column.notnull !== 1 && !column.pk)) fail(`PRIVATE_MESSAGE_SCHEMA_INVALID:${name}`);
  if (db.queryAll(`PRAGMA main.foreign_key_list(${quote(name)})`).length) fail(`PRIVATE_MESSAGE_SCHEMA_INVALID:${name}`);
  const triggers = db.queryAll<{ name: string }>(
    "SELECT name FROM main.sqlite_master WHERE type='trigger' AND tbl_name=? COLLATE NOCASE UNION ALL SELECT name FROM sqlite_temp_master WHERE type='trigger' AND tbl_name=? COLLATE NOCASE", [name, name]);
  if (triggers.length) fail(`PRIVATE_MESSAGE_TRIGGER_INVALID:${name}`);
  const explicitIndex = db.queryOne("SELECT 1 FROM main.sqlite_master WHERE type='index' AND tbl_name=? COLLATE NOCASE AND sql IS NOT NULL", [name]);
  if (explicitIndex) fail(`PRIVATE_MESSAGE_INDEX_INVALID:${name}`);
  return true;
}

/** Runtime assertion for every live receive/read path. Throws on any physical
 * deviation; returns the fixed fingerprint on success. */
export function assertPrivateMessageJournalSchema(db: HostDb): { featureProfile: typeof PRIVATE_MESSAGE_FEATURE_PROFILE; schemaFingerprint: string } {
  for (const shape of PRIVATE_MESSAGE_SHAPE) {
    if (!inspectPrivateMessageTable(db, shape.name, shape.normalizedSql)) fail(`PRIVATE_MESSAGE_TABLE_MISSING:${shape.name}`);
  }
  return { featureProfile: PRIVATE_MESSAGE_FEATURE_PROFILE, schemaFingerprint: PRIVATE_MESSAGE_SCHEMA_FINGERPRINT };
}

/** Lossless per-table content snapshot for preparation reports and audits. */
export function snapshotPrivateMessageOriginalContent(db: HostDb): Record<string, ActionOriginalContent> {
  return Object.fromEntries(PRIVATE_MESSAGE_SHAPE.map(shape => [shape.name, snapshotActionJournalTableOriginalContent(db, shape.name)]));
}

export interface PrivateMessagePreparationReport {
  readonly featureProfile: typeof PRIVATE_MESSAGE_FEATURE_PROFILE;
  readonly schemaFingerprint: string;
  readonly createdTables: readonly string[];
  readonly preservedRowCounts: Readonly<Record<string, string>>;
  readonly originalContent: Readonly<Record<string, { before: ActionOriginalContent | null; after: ActionOriginalContent }>>;
}
/** Sole target transaction for this feature (G1 owns it whole; G0 persists its
 * catalog reservation beforehand and applies maintenance holds — there is no
 * cross-database atomicity claim). All-or-nothing; never mutates an existing
 * incompatible shape; existing rows are preserved byte-for-byte. */
export function preparePrivateMessageJournal(input: { executionDb: HostDb; expectedSchemaFingerprint?: string }): PrivateMessagePreparationReport {
  if (input.expectedSchemaFingerprint !== undefined && input.expectedSchemaFingerprint !== PRIVATE_MESSAGE_SCHEMA_FINGERPRINT) fail('PRIVATE_MESSAGE_FINGERPRINT_MISMATCH');
  return input.executionDb.transaction(tx => {
    const createdTables: string[] = [];
    const preservedRowCounts: Record<string, string> = {};
    const originalContent: Record<string, { before: ActionOriginalContent | null; after: ActionOriginalContent }> = {};
    for (const table of PRIVATE_MESSAGE_DDL) {
      const exists = inspectPrivateMessageTable(tx, table.name, normalizedSql(table.sql));
      const before = exists ? snapshotActionJournalTableOriginalContent(tx, table.name) : null;
      if (!exists) tx.execute(table.sql);
      if (!inspectPrivateMessageTable(tx, table.name, normalizedSql(table.sql))) fail(`PRIVATE_MESSAGE_TABLE_MISSING:${table.name}`);
      const after = snapshotActionJournalTableOriginalContent(tx, table.name);
      if (before && before.contentDigest !== after.contentDigest) fail(`PRIVATE_MESSAGE_ORIGINAL_CONTENT_CHANGED:${table.name}`);
      if (before) preservedRowCounts[table.name] = before.rowCount;
      else createdTables.push(table.name);
      originalContent[table.name] = { before, after };
    }
    return {
      featureProfile: PRIVATE_MESSAGE_FEATURE_PROFILE, schemaFingerprint: PRIVATE_MESSAGE_SCHEMA_FINGERPRINT,
      createdTables: Object.freeze([...createdTables].sort()), preservedRowCounts: Object.freeze(preservedRowCounts),
      originalContent: Object.freeze(originalContent),
    };
  });
}

// ─── Row operations (recipient+House binding scoped) ────────────────────────

export interface PrivateMessageRow {
  readonly message_id: string; readonly event_id: string;
  readonly envelope_bytes: Uint8Array; readonly plaintext_bytes: Uint8Array;
  readonly envelope_digest: string; readonly plaintext_digest: string; readonly wrapper_digest: string;
  readonly consumer_pending: number;
}
export interface PrivateStateRow {
  readonly state_ref: string; readonly revision: string; readonly state_digest: string; readonly message_id: string;
}
export type PrivateStateWriteStatus = 'new' | 'updated' | 'duplicate' | 'old' | 'conflict' | 'none';
export type PrivateMessageStoreResult =
  | { readonly status: 'stored'; readonly messageStatus: 'new' | 'duplicate'; readonly stateStatus: PrivateStateWriteStatus }
  | { readonly status: 'conflict'; readonly reason: 'MESSAGE_ID_CONFLICT' };

/** Store one classified structured message with the historical v2 conflict
 * semantics: same message_id must carry the same wrapper digest; re-encrypted
 * duplicates converge to one row; state anchors replace only by strictly higher
 * revision. Call inside the caller's transaction after its currentness check. */
export function storeStructuredPrivateMessage(tx: HostDb, input: {
  readonly binding: string; readonly messageId: string; readonly eventId: string;
  readonly envelopeBytes: Uint8Array; readonly plaintextBytes: Uint8Array; readonly wrapperDigest: string;
  readonly deliveryClass: 'conversation' | 'receipt' | 'state';
  readonly wrapper: Readonly<Record<string, unknown>>;
}): PrivateMessageStoreResult {
  if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(input.messageId)) fail('MESSAGE_ID_INVALID');
  if (!/^[0-9a-f]{64}$/.test(input.eventId)) fail('MESSAGE_EVENT_ID_INVALID');
  const previous = tx.queryOne<{ wrapper_digest: string }>('SELECT wrapper_digest FROM world_private_messages_v2 WHERE binding=? AND message_id=?', [input.binding, input.messageId]);
  if (previous && previous.wrapper_digest !== input.wrapperDigest) return { status: 'conflict', reason: 'MESSAGE_ID_CONFLICT' };
  if (!previous) {
    tx.execute(`INSERT INTO world_private_messages_v2
      (binding,message_id,event_id,envelope_bytes,plaintext_bytes,envelope_digest,plaintext_digest,wrapper_digest,consumer_pending)
      VALUES(?,?,?,?,?,?,?,?,1)`,
      [input.binding, input.messageId, input.eventId, new Uint8Array(input.envelopeBytes), new Uint8Array(input.plaintextBytes),
        cidFromCanonical(new Uint8Array(input.envelopeBytes)), cidFromCanonical(new Uint8Array(input.plaintextBytes)), input.wrapperDigest]);
  }
  let stateStatus: PrivateStateWriteStatus = 'none';
  if (input.deliveryClass === 'state') {
    const stateRef = String(input.wrapper.state_ref), revision = String(input.wrapper.state_revision);
    if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(stateRef) || !/^(0|[1-9][0-9]{0,19})$/.test(revision)) fail('PRIVATE_STATE_ANCHOR_INVALID');
    const digest = privateMessageStateDigest(input.wrapper as Record<string, unknown>);
    const previousState = tx.queryOne<PrivateStateRow>('SELECT * FROM world_private_states_v2 WHERE binding=? AND state_ref=?', [input.binding, stateRef]);
    stateStatus = !previousState ? 'new'
      : BigInt(revision) < BigInt(previousState.revision) ? 'old'
        : BigInt(revision) > BigInt(previousState.revision) ? 'updated'
          : previousState.state_digest === digest ? 'duplicate' : 'conflict';
    // A replayed message never rewrites an anchor it already established.
    if (previous && (stateStatus === 'new' || stateStatus === 'updated')) stateStatus = 'duplicate';
    if (!previous && (stateStatus === 'new' || stateStatus === 'updated')) {
      tx.execute(`INSERT INTO world_private_states_v2(binding,state_ref,revision,state_digest,message_id) VALUES(?,?,?,?,?)
        ON CONFLICT(binding,state_ref) DO UPDATE SET revision=excluded.revision,state_digest=excluded.state_digest,message_id=excluded.message_id`,
        [input.binding, stateRef, revision, digest, input.messageId]);
    }
  }
  return { status: 'stored', messageStatus: previous ? 'duplicate' : 'new', stateStatus };
}

export function readPrivateMessageRow(db: HostDb, binding: string, messageId: string): PrivateMessageRow | null {
  if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(messageId)) return null;
  const row = db.queryOne<PrivateMessageRow>('SELECT * FROM world_private_messages_v2 WHERE binding=? AND message_id=?', [binding, messageId]);
  return row ? { ...row, envelope_bytes: new Uint8Array(row.envelope_bytes), plaintext_bytes: new Uint8Array(row.plaintext_bytes) } : null;
}

/** Wrapper plaintext ceiling (the receive path never stores more). */
export const PRIVATE_MESSAGE_MAX_PLAINTEXT = 65536;
/** Per-call envelope scan cap from the reader contract. */
export const PRIVATE_MESSAGE_SCAN_BYTES_MAX = 8 * 1024 * 1024;
export interface PrivateMessageRowPlan {
  readonly message_id: string; readonly envelopeBytes: number; readonly plaintextBytes: number;
}
/** BLOB-length planning query: sizes only, no envelope/plaintext bytes move. */
export function planPrivateMessageRows(db: HostDb, binding: string, afterMessageId: string, limit: number): PrivateMessageRowPlan[] {
  return db.queryAll<PrivateMessageRowPlan>(
    'SELECT message_id, length(envelope_bytes) AS envelopeBytes, length(plaintext_bytes) AS plaintextBytes FROM world_private_messages_v2 WHERE binding=? AND message_id>? ORDER BY message_id LIMIT ?',
    [binding, afterMessageId, limit]);
}
/** Fetch EXACTLY the planned ids (never position-based: an unplanned row can
 * never appear in the result, so oversized BLOBs are never materialized). */
export function pagePrivateMessageRowsByIds(db: HostDb, binding: string, ids: readonly string[]): PrivateMessageRow[] {
  if (!ids.length || ids.length > 64) throw new Error('PRIVATE_ID_PAGE_INVALID');
  const placeholders = ids.map(() => '?').join(',');
  return db.queryAll<PrivateMessageRow>(
    `SELECT * FROM world_private_messages_v2 WHERE binding=? AND message_id IN (${placeholders})
      AND typeof(envelope_bytes)='blob' AND length(envelope_bytes)<=${PRIVATE_MESSAGE_SCAN_BYTES_MAX}
      AND typeof(plaintext_bytes)='blob' AND length(plaintext_bytes)<=${PRIVATE_MESSAGE_MAX_PLAINTEXT} ORDER BY message_id`,
    [binding, ...ids])
    .map(row => ({ ...row, envelope_bytes: new Uint8Array(row.envelope_bytes), plaintext_bytes: new Uint8Array(row.plaintext_bytes) }));
}
export type BoundedPrivateMessageRow =
  | { readonly row: PrivateMessageRow }
  | { readonly oversized: 'PRIVATE_ROW_OVER_SCAN_BUDGET' | 'PRIVATE_ROW_PLAINTEXT_OVER_SIZE' };
/** Single-row read with the same pre-materialization guards as list: both
 * BLOB lengths are checked through SQLite `length()` before any SELECT *. */
export function readPrivateMessageRowBounded(db: HostDb, binding: string, messageId: string,
  planned?: Pick<PrivateMessageRowPlan, 'envelopeBytes' | 'plaintextBytes'>): BoundedPrivateMessageRow | null {
  if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(messageId)) return null;
  const plan = planned ?? db.queryOne<{ envelopeBytes: number; plaintextBytes: number }>(
    'SELECT length(envelope_bytes) AS envelopeBytes, length(plaintext_bytes) AS plaintextBytes FROM world_private_messages_v2 WHERE binding=? AND message_id=?',
    [binding, messageId]);
  if (!plan) return null;
  if (plan.plaintextBytes > PRIVATE_MESSAGE_MAX_PLAINTEXT) return { oversized: 'PRIVATE_ROW_PLAINTEXT_OVER_SIZE' };
  if (plan.envelopeBytes > PRIVATE_MESSAGE_SCAN_BYTES_MAX) return { oversized: 'PRIVATE_ROW_OVER_SCAN_BUDGET' };
  if (!Number.isSafeInteger(plan.envelopeBytes) || plan.envelopeBytes < 0
    || !Number.isSafeInteger(plan.plaintextBytes) || plan.plaintextBytes < 0) return null;
  // Guard selection itself, not a later JS copy: this remains bounded if a
  // concurrent writer changes a row after length planning. List supplies each
  // row's original bounds, preserving its aggregate per-call byte reservation.
  const row = db.queryOne<PrivateMessageRow>(
    `SELECT * FROM world_private_messages_v2 WHERE binding=? AND message_id=?
      AND typeof(envelope_bytes)='blob' AND length(envelope_bytes)<=?
      AND typeof(plaintext_bytes)='blob' AND length(plaintext_bytes)<=?`,
    [binding, messageId, plan.envelopeBytes, plan.plaintextBytes]);
  return row ? { row: { ...row, envelope_bytes: new Uint8Array(row.envelope_bytes), plaintext_bytes: new Uint8Array(row.plaintext_bytes) } } : null;
}

/** One bounded keyset page in message_id order (scan bound enforced by caller). */
export function pagePrivateMessageRows(db: HostDb, binding: string, afterMessageId: string, limit: number): PrivateMessageRow[] {
  return db.queryAll<PrivateMessageRow>(
    `SELECT * FROM world_private_messages_v2 WHERE binding=? AND message_id>? ORDER BY message_id LIMIT ?`,
    [binding, afterMessageId, limit])
    .map(row => ({ ...row, envelope_bytes: new Uint8Array(row.envelope_bytes), plaintext_bytes: new Uint8Array(row.plaintext_bytes) }));
}

export function pendingPrivateMessageRows(db: HostDb, binding: string, limit: number, afterMessageId = ''): PrivateMessageRow[] {
  return pagePrivateMessageRowsAfter(db, binding, afterMessageId, limit, true);
}
function pagePrivateMessageRowsAfter(db: HostDb, binding: string, afterMessageId: string, limit: number, pendingOnly: boolean): PrivateMessageRow[] {
  return db.queryAll<PrivateMessageRow>(
    `SELECT * FROM world_private_messages_v2 WHERE binding=? AND message_id>? ${pendingOnly ? 'AND consumer_pending=1' : ''} ORDER BY message_id LIMIT ?`,
    [binding, afterMessageId, limit])
    .map(row => ({ ...row, envelope_bytes: new Uint8Array(row.envelope_bytes), plaintext_bytes: new Uint8Array(row.plaintext_bytes) }));
}

export function hasPendingPrivateMessages(db: HostDb, binding: string): boolean {
  return !!db.queryOne('SELECT 1 FROM world_private_messages_v2 WHERE binding=? AND consumer_pending=1 LIMIT 1', [binding]);
}

export function isPrivateMessagePending(db: HostDb, binding: string, messageId: string): boolean {
  if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(messageId)) fail('MESSAGE_ID_INVALID');
  return db.queryOne<{ consumer_pending: number }>('SELECT consumer_pending FROM world_private_messages_v2 WHERE binding=? AND message_id=?', [binding, messageId])?.consumer_pending === 1;
}

/** Acknowledge durable local completion only (never user/peer read). Returns
 * false when the row is absent or already complete. */
export function markPrivateMessageHandled(db: HostDb, binding: string, messageId: string): boolean {
  if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(messageId)) fail('MESSAGE_ID_INVALID');
  return db.execute('UPDATE world_private_messages_v2 SET consumer_pending=0 WHERE binding=? AND message_id=? AND consumer_pending=1', [binding, messageId]).changes > 0;
}

export function readPrivateStateRow(db: HostDb, binding: string, stateRef: string): PrivateStateRow | null {
  if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(stateRef)) return null;
  return db.queryOne<PrivateStateRow>('SELECT * FROM world_private_states_v2 WHERE binding=? AND state_ref=?', [binding, stateRef]);
}
