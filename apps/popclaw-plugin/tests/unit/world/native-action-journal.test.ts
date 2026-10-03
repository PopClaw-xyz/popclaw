import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { ACTION_RECEIPT_SCHEMA_FINGERPRINT, prepareActionReceiptJournal, assertActionReceiptJournalSchema, snapshotActionReceiptOriginalContent } from '../../../src/world/action-receipt-journal.js';
import { NATIVE_ACTION_SCHEMA_FINGERPRINT, NATIVE_ACTION_FEATURE_PROFILE, prepareNativeActionJournal, assertNativeActionJournalSchema, snapshotNativeActionOriginalContent } from '../../../src/world/native-action-journal.js';
const partition = { origin:'https://house.test', actorId:'actor', storeId:'store', layoutVersion:1 as const };
const opened: HostDb[] = [], dirs: string[] = [];
function db(path = ':memory:', old = true): LocalHostDb {
  const value = new LocalHostDb(path); opened.push(value);
  value.execute('CREATE TABLE execution_partition_identity_v1(singleton INTEGER PRIMARY KEY,actor_id TEXT NOT NULL,origin TEXT NOT NULL,store_id TEXT NOT NULL,layout_version INTEGER NOT NULL)');
  value.execute('INSERT INTO execution_partition_identity_v1 VALUES(1,?,?,?,1)',[partition.actorId,partition.origin,partition.storeId]);
  if (old) prepareActionReceiptJournal({executionDb:value,expectedPartition:partition,expectedSchemaFingerprint:ACTION_RECEIPT_SCHEMA_FINGERPRINT});
  return value;
}
const prepare = (executionDb:HostDb) => prepareNativeActionJournal({executionDb,expectedPartition:partition,expectedSchemaFingerprint:NATIVE_ACTION_SCHEMA_FINGERPRINT});
afterEach(() => { for (const value of opened.splice(0)) value.close(); for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
describe('independent native action feature on actual SQLite', () => {
  it('requires prepared old feature and never creates schema in assertion', () => {
    const value = db(':memory:',false);
    expect(() => prepare(value)).toThrow(); expect(() => assertNativeActionJournalSchema(value,partition)).toThrow();
    expect(value.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_%'")).toEqual([]);
    expect(snapshotNativeActionOriginalContent(value)).toEqual({world_native_action_reservations:null});
  });
  it('checks the partition and expected fingerprint before any mutation', () => {
    const value=db(), before=value.queryAll('SELECT * FROM sqlite_master ORDER BY name');
    expect(() => prepareNativeActionJournal({executionDb:value,expectedPartition:{...partition,actorId:'other'},expectedSchemaFingerprint:NATIVE_ACTION_SCHEMA_FINGERPRINT})).toThrow();
    expect(() => prepareNativeActionJournal({executionDb:value,expectedPartition:partition,expectedSchemaFingerprint:'0'.repeat(64)})).toThrow();
    expect(value.queryAll('SELECT * FROM sqlite_master ORDER BY name')).toEqual(before);
  });
  it('derives the frozen actual fingerprint with one transaction and preserves old content', () => {
    const value=db(); value.execute("INSERT INTO world_owner_action_reservations VALUES('binding','reservation','human-job','{}',1,2,NULL,'reserved')");
    const old=snapshotActionReceiptOriginalContent(value);let count=0;
    const wrapped:HostDb={queryOne:value.queryOne.bind(value),queryAll:value.queryAll.bind(value),execute:value.execute.bind(value),close(){},transaction(fn){if(++count>1)throw new Error('nested transaction');return value.transaction(()=>fn(wrapped));}};
    const report=prepare(wrapped);
    expect(count).toBe(1); expect(report.featureProfile).toBe(NATIVE_ACTION_FEATURE_PROFILE);
    expect(report.schemaFingerprint).toBe('3d23995264d66b5e82d5089daeb6c7ca6b231a1ea7e2ebb34a16a05fa6633219');
    expect(assertNativeActionJournalSchema(wrapped,partition).schemaFingerprint).toBe(NATIVE_ACTION_SCHEMA_FINGERPRINT);
    expect(report.createdTables).toEqual(['world_native_action_reservations']); expect(report.addedColumns).toEqual([]);
    expect(report.originalContent.world_native_action_reservations!.before).toBeNull();
    for(const [name,content] of Object.entries(old))expect(report.oldActionOriginalContent[name]).toEqual({before:content,after:content});
    expect(assertActionReceiptJournalSchema(value,partition).schemaFingerprint).toBe(ACTION_RECEIPT_SCHEMA_FINGERPRINT);
  });
  it.each(['','TEMP '].flatMap(storage=>['world_native_action_reservations','WORLD_NATIVE_ACTION_RESERVATIONS'].map(name=>[name,storage] as const)))('rejects an attached trigger on %s (%s) without altering data',(name,storage)=>{
    const value=db();prepare(value);value.execute(`CREATE ${storage}TRIGGER native_trigger AFTER INSERT ON main.${name} BEGIN SELECT 1; END`);
    const before=value.queryAll('SELECT * FROM sqlite_master ORDER BY name');
    expect(()=>assertNativeActionJournalSchema(value,partition)).toThrow('NATIVE_ACTION_SCHEMA_UNSUPPORTED');
    expect(()=>prepare(value)).toThrow('NATIVE_ACTION_SCHEMA_UNSUPPORTED');
    expect(value.queryAll('SELECT * FROM sqlite_master ORDER BY name')).toEqual(before);
  });
  it('rejects case-insensitive TEMP table shadowing but permits unrelated triggers',()=>{
    const value=db();prepare(value);
    value.execute('CREATE TABLE unrelated_table(x TEXT)');
    value.execute('CREATE TEMP TRIGGER unrelated_trigger AFTER INSERT ON main.unrelated_table BEGIN SELECT 1; END');
    expect(assertNativeActionJournalSchema(value,partition).schemaFingerprint).toBe(NATIVE_ACTION_SCHEMA_FINGERPRINT);
    value.execute('CREATE TEMP TABLE WORLD_NATIVE_ACTION_RESERVATIONS(x TEXT)');
    expect(()=>assertNativeActionJournalSchema(value,partition)).toThrow('NATIVE_ACTION_SCHEMA_UNSUPPORTED');
  });
  it.each(['CREATE INDEX extra ON world_native_action_reservations(status)','CREATE TRIGGER extra AFTER INSERT ON world_native_action_reservations BEGIN SELECT 1; END','ALTER TABLE world_native_action_reservations ADD COLUMN extra TEXT','CREATE TEMP TABLE world_native_action_reservations(x TEXT)'])('rejects additional actual behavior without repair: %s',sql=>{
    const value=db();prepare(value);value.execute(sql);const before=value.queryAll('SELECT * FROM sqlite_master ORDER BY name');
    expect(()=>assertNativeActionJournalSchema(value,partition)).toThrow();expect(()=>prepare(value)).toThrow();expect(value.queryAll('SELECT * FROM sqlite_master ORDER BY name')).toEqual(before);
  });
  it.each(['DEFAULT 0','CHECK(expires_at>0)','COLLATE NOCASE','ON CONFLICT REPLACE'])('rejects hidden native DDL: %s',suffix=>{
    const value=db();prepare(value);const sql=value.queryOne<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='world_native_action_reservations'")!.sql;
    value.execute('DROP TABLE world_native_action_reservations');
    value.execute(sql.replace('"expires_at" INTEGER NOT NULL',`"expires_at" INTEGER NOT NULL ${suffix}`));
    expect(()=>assertNativeActionJournalSchema(value,partition)).toThrow();expect(()=>prepare(value)).toThrow();
  });
  it('preserves malformed original TEXT and full-width integer cells on idempotent preparation',()=>{
    const value=db();prepare(value);
    value.execute("INSERT INTO world_native_action_reservations VALUES('binding','r','i','{}',CAST(x'ff80' AS TEXT),'revision','{}','{}',9223372036854775807,-9223372036854775808,NULL,'reserved')");
    const before=snapshotNativeActionOriginalContent(value), report=prepare(value);
    expect(report.createdTables).toEqual([]);expect(report.preservedLegacyCounts.world_native_action_reservations).toBe('1');
    expect(report.originalContent.world_native_action_reservations).toEqual({before:before.world_native_action_reservations,after:before.world_native_action_reservations});
    expect(value.queryOne<{raw:string}>("SELECT hex(CAST(policy_source_json AS BLOB)) AS raw FROM world_native_action_reservations")!.raw).toBe('FF80');
  });
  it('rolls back new DDL and any old-content change before returning evidence',()=>{
    const value=db();value.execute("INSERT INTO world_owner_action_reservations VALUES('b','r','j','{}',1,2,NULL,'reserved')");const old=snapshotActionReceiptOriginalContent(value);
    const wrapped:HostDb={queryOne:value.queryOne.bind(value),queryAll:value.queryAll.bind(value),close(){},execute(sql,params){const result=value.execute(sql,params);if(sql.startsWith('CREATE TABLE'))value.execute("UPDATE world_owner_action_reservations SET status='succeeded'");return result;},transaction(fn){return value.transaction(()=>fn(wrapped));}};
    expect(()=>prepare(wrapped)).toThrow('ACTION_ORIGINAL_CONTENT_CHANGED');
    expect(snapshotNativeActionOriginalContent(value).world_native_action_reservations).toBeNull();expect(snapshotActionReceiptOriginalContent(value)).toEqual(old);
  });
  it('reopens a file snapshot with native and manual original bytes unchanged',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'native-journal-'));dirs.push(dir);const value=db(join(dir,'live.sqlite'));prepare(value);
    value.execute("INSERT INTO world_native_action_reservations VALUES('b','r','i','{}','{}','rev','{}','{}',1,2,NULL,'reserved')");
    const before=snapshotNativeActionOriginalContent(value);await value.snapshotTo(join(dir,'backup.sqlite'));
    const restored=new LocalHostDb(join(dir,'backup.sqlite'));opened.push(restored);
    expect(assertNativeActionJournalSchema(restored,partition).schemaFingerprint).toBe(NATIVE_ACTION_SCHEMA_FINGERPRINT);
    expect(snapshotNativeActionOriginalContent(restored)).toEqual(before);
    restored.execute('DROP TABLE world_native_action_reservations');expect(()=>assertNativeActionJournalSchema(restored,partition)).toThrow();
    expect(snapshotNativeActionOriginalContent(restored).world_native_action_reservations).toBeNull();
  });
});
