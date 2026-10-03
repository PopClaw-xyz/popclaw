import { afterEach, describe, expect, it } from 'vitest';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { ACTION_RECEIPT_SCHEMA_FINGERPRINT, prepareActionReceiptJournal, assertActionReceiptJournalSchema, snapshotActionOriginalContent } from '../../../src/world/action-receipt-journal.js';
const partition = { origin: 'https://house.test', actorId: 'actor', storeId: 'store', layoutVersion: 1 as const };
const opened: HostDb[] = [];
function db(): HostDb {
  const value = new LocalHostDb(':memory:'); opened.push(value);
  value.execute(`CREATE TABLE execution_partition_identity_v1(singleton INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, origin TEXT NOT NULL, store_id TEXT NOT NULL, layout_version INTEGER NOT NULL)`);
  value.execute('INSERT INTO execution_partition_identity_v1 VALUES(1,?,?,?,?)', [partition.actorId, partition.origin, partition.storeId, 1]); return value;
}
function prepare(executionDb: HostDb) { return prepareActionReceiptJournal({ executionDb, expectedPartition: partition, expectedSchemaFingerprint: ACTION_RECEIPT_SCHEMA_FINGERPRINT }); }
afterEach(() => { for (const value of opened.splice(0)) value.close(); });
describe('explicit action receipt preparation on real SQLite', () => {
  it('requires selected identity and leaves an unprepared normal open unchanged', () => {
    const value = db(); expect(() => assertActionReceiptJournalSchema(value, partition)).toThrow();
    expect(value.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_%'")).toEqual([]);
    expect(() => prepareActionReceiptJournal({ executionDb: value, expectedPartition: { ...partition, actorId: 'other' }, expectedSchemaFingerprint: ACTION_RECEIPT_SCHEMA_FINGERPRINT })).toThrow();
    expect(value.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_%'")).toEqual([]);
  });
  it('derives the fixed fingerprint from five actual tables and is idempotent', () => {
    const value = db(), report = prepare(value); expect(report.createdTables).toHaveLength(5);
    expect(report.schemaFingerprint).toBe('b646c295f9197eb641251c42abdcab6efa20b271bb716c5bf329a845123cf6c6');
    expect(assertActionReceiptJournalSchema(value, partition).schemaFingerprint).toBe(report.schemaFingerprint);
    for (const item of Object.values(report.originalContent)) { expect(item.before).toBeNull(); expect(item.after.rowCount).toBe('0'); }
    expect(prepare(value).createdTables).toEqual([]);
  });
  it.each(['world_action_client_requests','world_action_client_results','world_action_client_evidence','world_action_client_progress','world_owner_action_reservations'].flatMap(name=>['','TEMP '].flatMap(storage=>[name,name.toUpperCase()].map(table=>[table,storage] as const))))('rejects attached triggers on main protected table %s (%s)',(name,storage)=>{
    const value=db();prepare(value);
    value.execute(`CREATE ${storage}TRIGGER attached_trigger AFTER INSERT ON main.${name} BEGIN SELECT 1; END`);
    expect(()=>assertActionReceiptJournalSchema(value,partition)).toThrow('ACTION_RECEIPT_SCHEMA_UNSUPPORTED');
    expect(()=>prepare(value)).toThrow('ACTION_RECEIPT_SCHEMA_UNSUPPORTED');
  });
  it.each(['CREATE INDEX extra ON world_action_client_results(pending)', 'CREATE TRIGGER extra AFTER INSERT ON world_action_client_results BEGIN SELECT 1; END', 'ALTER TABLE world_action_client_results ADD COLUMN surprise TEXT', 'DROP TABLE world_action_client_evidence', 'CREATE TEMP TABLE world_action_client_evidence(x TEXT)'])('rejects incompatible actual shape without repair: %s', sql => {
    const value = db(); prepare(value); value.execute(sql); const before = value.queryAll('SELECT * FROM sqlite_master ORDER BY name');
    expect(() => assertActionReceiptJournalSchema(value, partition)).toThrow(); expect(value.queryAll('SELECT * FROM sqlite_master ORDER BY name')).toEqual(before);
  });
  it.each(['CHECK(pending>=0)', 'DEFAULT 0', 'COLLATE NOCASE', 'ON CONFLICT REPLACE'])('rejects hidden DDL behavior: %s', suffix => {
    const value = db(); prepare(value); const original = value.queryOne<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='world_action_client_results'")!.sql;
    value.execute('DROP TABLE world_action_client_results');
    const sql = suffix === 'ON CONFLICT REPLACE' ? original.replace('NOT NULL', `NOT NULL ${suffix}`) : original.replace('"pending" INTEGER NOT NULL', `"pending" INTEGER NOT NULL ${suffix}`);
    value.execute(sql); expect(() => assertActionReceiptJournalSchema(value, partition)).toThrow(); expect(() => prepare(value)).toThrow();
  });
  it('preserves original bytes and lossless integer storage across additive preparation', () => {
    const value = db(); value.execute(`CREATE TABLE world_action_client_results(binding TEXT NOT NULL,request_id TEXT NOT NULL,core_digest TEXT NOT NULL,result_bytes BLOB NOT NULL,pending INTEGER NOT NULL,PRIMARY KEY(binding,request_id,core_digest))`);
    value.execute("INSERT INTO world_action_client_results VALUES('a','r','c',x'00ff80',9223372036854775807)"); value.execute("INSERT INTO world_action_client_results VALUES('z','r','c',x'fe',-9223372036854775808)");
    const before = snapshotActionOriginalContent(value, 'world_action_client_results'), report = prepare(value);
    expect(report.originalContent.world_action_client_results!.before).toEqual(before); expect(report.originalContent.world_action_client_results!.after).toEqual(before); expect(report.preservedLegacyCounts.world_action_client_results).toBe('2');
  });
  it('rolls back all DDL when preparation fails midway', () => {
    const value = db(); let writes = 0;
    const fault: HostDb = { queryOne: value.queryOne.bind(value), queryAll: value.queryAll.bind(value), close() {}, execute(sql, params) { if (++writes === 3) throw new Error('injected DDL crash'); return value.execute(sql, params); }, transaction(fn) { return value.transaction(() => fn(fault)); } };
    expect(() => prepare(fault)).toThrow('injected DDL crash'); expect(value.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_%'")).toEqual([]); expect(prepare(value).createdTables).toHaveLength(5);
  });
});

it('matches an independent original-column digest vector with raw TEXT/BLOB and lossless integer cells', async () => {
  const {createHash}=await import('node:crypto');const value=db();
  value.execute('CREATE TABLE world_action_client_results(binding TEXT NOT NULL,request_id TEXT NOT NULL,core_digest TEXT NOT NULL,result_bytes BLOB NOT NULL,pending INTEGER NOT NULL,PRIMARY KEY(binding,request_id,core_digest))');
  value.execute("INSERT INTO world_action_client_results VALUES('a','r','c',CAST(x'ff80' AS TEXT),9223372036854775807)");
  value.execute("INSERT INTO world_action_client_results VALUES('b','r','c',x'ff80',-9223372036854775808)");
  const columns=['binding','request_id','core_digest','result_bytes','pending'], primaryKey=['binding','request_id','core_digest'];
  const header=JSON.stringify({columns,primaryKey,table:'world_action_client_results'});
  const hash=createHash('sha256').update('POPCLAW_ACTION_ORIGINAL_COLUMNS_V1\n').update(header).update('\n');
  for(const [key,payload,integer] of [['61','text','9223372036854775807'],['62','blob','-9223372036854775808']]) {
    const pk=[['text',key],['text','72'],['text','63']];
    const record=Buffer.from(JSON.stringify([pk,[...pk,[payload,'ff80'],['integer',integer]]]));
    const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(record.length));hash.update(length).update(record);
  }
  expect(snapshotActionOriginalContent(value,'world_action_client_results').contentDigest).toBe(hash.digest('hex'));
  const report=prepare(value);expect(report.originalContent.world_action_client_results!.after).toEqual(report.originalContent.world_action_client_results!.before);
});

it('separates native and manual receipt profiles without changing manual bytes', async () => {
  const {encodeActionReceiptState,decodeActionReceiptState,canonicalActionJson}=await import('../../../src/world/action-receipt-journal.js');
  const base={profile:'first-release-1ff7-action-v1' as const,status:3,revision:'1',semanticDigest:'a'.repeat(64),attachmentContract:{outcome:'valid' as const,reason:'VALID'},attachments:[],baseAccounting:{state:'applied' as const,reason:'APPLIED',executionReference:{kind:'owner_action' as const,reservationId:'b'.repeat(64)}}};
  expect(new TextDecoder().decode(encodeActionReceiptState(base))).toBe(canonicalActionJson(base));
  const native={...base,profile:'first-release-1ff7-native-action-v1' as const,baseAccounting:{...base.baseAccounting,executionReference:{kind:'native_policy' as const,reservationId:'b'.repeat(64)}}};
  expect(decodeActionReceiptState(new TextEncoder().encode(canonicalActionJson(native)))).toEqual(native);
  for(const changed of [{...native,profile:base.profile},{...base,profile:native.profile},{...native,baseAccounting:{...native.baseAccounting,executionReference:null}}]) {
    expect(()=>decodeActionReceiptState(new TextEncoder().encode(canonicalActionJson(changed)))).toThrow('ACTION_RECEIPT_STATE_UNSUPPORTED');
  }
});
