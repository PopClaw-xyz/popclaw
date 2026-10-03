import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { ACTION_RECEIPT_FEATURE_TABLES, NATIVE_ACTION_FEATURE_TABLES, inspectLegacySchema } from '../../../src/host/execution-store-schema.js';
import { initializeActionReceiptJournal, initializeNativeActionJournal } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession, readStorageControl } from '../../../src/host/storage-maintenance.js';
import { createStorageBackup } from '../../../src/host/storage-backup.js';
import { ACTION_RECEIPT_SCHEMA_FINGERPRINT } from '../../../src/world/action-receipt-journal.js';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';
import { NATIVE_ACTION_SCHEMA_FINGERPRINT } from '../../../src/world/native-action-journal.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const origin = 'https://action-protection.example', actorId = '11111111111111111111111111111111';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'action-protection-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb());
  cleanup.push(() => db.close());
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId });
  cleanup.push(() => catalog.close());
  // The offline entry point exists for partitions published before the fresh
  // factory: an empty reservation on a published row is never a permit.
  const partition = openUnprovisionedPartition({ catalog, db, paths, actorId, origin });
  const maintenance = MaintenanceSession.begin(db, paths, 'test action receipt preparation');
  return { root, paths, db, catalog, partition, maintenance };
}
describe('native action feature protection on real SQLite', () => {
  it('requires the original feature and reserves native intent before the separate preparation', () => {
    const f = fixture(), held = readStorageControl(f.paths);
    expect(() => initializeNativeActionJournal({ ...f, origin })).toThrow();
    expect(f.partition.db.queryOne("SELECT 1 FROM sqlite_master WHERE name='world_native_action_reservations'")).toBeNull();
    initializeActionReceiptJournal({ ...f, origin });
    const report = initializeNativeActionJournal({ ...f, origin, failpoint: stage => {
      if (stage !== 'reserved') return;
      const row = f.db.queryOne<{required_tables:string}>('SELECT required_tables FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
      expect(JSON.parse(row.required_tables)).toEqual([...ACTION_RECEIPT_FEATURE_TABLES, ...NATIVE_ACTION_FEATURE_TABLES].sort());
      expect(f.partition.db.queryOne("SELECT 1 FROM sqlite_master WHERE name='world_native_action_reservations'")).toBeNull();
    } });
    expect(report.schemaFingerprint).toBe(NATIVE_ACTION_SCHEMA_FINGERPRINT);
    expect(report.addedColumns).toEqual([]); expect(report.createdTables).toEqual([...NATIVE_ACTION_FEATURE_TABLES]);
    expect(readStorageControl(f.paths)).toEqual(held); expect(f.catalog.open(origin)).toBe(f.partition);
  });
  it('keeps interrupted native intent and prevents cached, fresh and backup downgrade', async () => {
    const f = fixture(); initializeActionReceiptJournal({ ...f, origin });
    expect(() => initializeNativeActionJournal({ ...f, origin, failpoint: stage => {
      if (stage === 'reserved') throw new Error('native preparation interrupted');
    } })).toThrow('interrupted');
    expect(() => f.catalog.open(origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
    f.catalog.close();
    const fresh = new ExecutionStoreCatalog({ db: f.db, paths: f.paths, actorId }); cleanup.push(() => fresh.close());
    expect(() => fresh.open(origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
    await expect(createStorageBackup({ paths: f.paths, actorId, installationId: null, codeVersion: 'test', maintenance: f.maintenance })).rejects.toThrow();
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  });
  it.each(['missing', 'extra-index', 'unreserved'] as const)('rejects native %s state without repairing it', damage => {
    const f = fixture(); initializeActionReceiptJournal({ ...f, origin }); initializeNativeActionJournal({ ...f, origin });
    if (damage === 'missing') f.partition.db.execute('DROP TABLE world_native_action_reservations');
    if (damage === 'extra-index') f.partition.db.execute('CREATE INDEX native_unapproved ON world_native_action_reservations(status)');
    if (damage === 'unreserved') f.db.execute('UPDATE execution_store_catalog_v1 SET required_tables=? WHERE origin=?', [JSON.stringify(ACTION_RECEIPT_FEATURE_TABLES), origin]);
    expect(() => f.catalog.open(origin)).toThrow();
    f.catalog.close();
    const fresh = new ExecutionStoreCatalog({ db: f.db, paths: f.paths, actorId }); cleanup.push(() => fresh.close());
    expect(() => fresh.open(origin)).toThrow();
  });
  it('verifies original manual contents independently after native preparation', () => {
    const f = fixture(); initializeActionReceiptJournal({ ...f, origin });
    f.partition.db.execute("INSERT INTO world_owner_action_reservations VALUES('manual','r','j','{}',1,2,NULL,'unknown')");
    expect(() => initializeNativeActionJournal({ ...f, origin, failpoint: stage => {
      if (stage === 'prepared') f.partition.db.execute("UPDATE world_owner_action_reservations SET status='succeeded'");
    } })).toThrow('ACTION_ORIGINAL_CONTENT_CHANGED');
    expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
  });
});
describe('action receipt feature protection on real file SQLite', () => {
  it('reserves every name before DDL, verifies the real schema and leaves all holds unchanged', () => {
    const f = fixture(), held = readStorageControl(f.paths);
    const report = initializeActionReceiptJournal({ ...f, origin, failpoint: stage => {
      if (stage !== 'reserved') return;
      const row = f.db.queryOne<{required_tables: string}>('SELECT required_tables FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
      expect(JSON.parse(row!.required_tables).sort()).toEqual([...ACTION_RECEIPT_FEATURE_TABLES].sort());
      expect(f.partition.db.queryOne("SELECT name FROM sqlite_master WHERE name='world_action_client_evidence'")).toBeNull();
    } });
    expect(report.schemaFingerprint).toBe(ACTION_RECEIPT_SCHEMA_FINGERPRINT);
    expect(report.createdTables.sort()).toEqual([...ACTION_RECEIPT_FEATURE_TABLES].sort());
    expect(readStorageControl(f.paths)).toEqual(held);
    expect(f.catalog.open(origin)).toBe(f.partition);
  });
  it('keeps interrupted reservation durable and refuses cached, fresh and backup downgrade', async () => {
    const f = fixture();
    expect(() => initializeActionReceiptJournal({ ...f, origin, failpoint: stage => {
      if (stage === 'reserved') throw new Error('simulated crash before DDL');
    } })).toThrow('simulated crash');
    expect(() => f.catalog.open(origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
    f.catalog.close();
    const fresh = new ExecutionStoreCatalog({ db: f.db, paths: f.paths, actorId }); cleanup.push(() => fresh.close());
    expect(() => fresh.open(origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
    await expect(createStorageBackup({ paths: f.paths, actorId, installationId: null, codeVersion: 'test', maintenance: f.maintenance })).rejects.toThrow();
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  });
  it.each(['table', 'column', 'index'] as const)('refuses cached and fresh %s damage after preparation', damage => {
    const f = fixture(); initializeActionReceiptJournal({ ...f, origin });
    if (damage === 'table') f.partition.db.execute('DROP TABLE world_action_client_evidence');
    if (damage === 'column') f.partition.db.execute('ALTER TABLE world_action_client_requests DROP COLUMN original_context');
    if (damage === 'index') f.partition.db.execute('CREATE INDEX unapproved_receipt_index ON world_action_client_evidence(request_id)');
    expect(() => f.catalog.open(origin)).toThrow();
    f.catalog.close();
    const fresh = new ExecutionStoreCatalog({ db: f.db, paths: f.paths, actorId }); cleanup.push(() => fresh.close());
    expect(() => fresh.open(origin)).toThrow();
  });
  it('checks selected identity again between durable intent and H31 DDL', () => {
    const f = fixture();
    expect(() => initializeActionReceiptJournal({ ...f, origin, failpoint: stage => {
      if (stage === 'reserved') f.db.execute('UPDATE execution_store_catalog_v1 SET actor_id=? WHERE origin=?', ['different-actor', origin]);
    } })).toThrow('ACTION_RECEIPT_PARTITION_MISMATCH');
    expect(f.partition.db.queryOne("SELECT name FROM sqlite_master WHERE name='world_action_client_evidence'")).toBeNull();
    expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
  });
  it('independently detects content changed after preparation and preserves the hold', () => {
    const f = fixture();
    f.partition.db.execute(`CREATE TABLE world_owner_action_reservations (
      binding TEXT NOT NULL, reservation_id TEXT NOT NULL, job_id TEXT NOT NULL, input_json TEXT NOT NULL,
      reserved_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, request_id TEXT, status TEXT NOT NULL,
      PRIMARY KEY(binding,reservation_id), UNIQUE(binding,job_id), UNIQUE(binding,request_id))`);
    f.partition.db.execute("INSERT INTO world_owner_action_reservations VALUES('other-binding','r','j','{}',9223372036854775807,42,NULL,'unknown')");
    expect(() => initializeActionReceiptJournal({ ...f, origin, failpoint: stage => {
      if (stage === 'prepared') f.partition.db.execute("UPDATE world_owner_action_reservations SET status='succeeded'");
    } })).toThrow('ACTION_ORIGINAL_CONTENT_CHANGED');
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  });
  it('classifies evidence as durable and rejects an unreserved partial feature', () => {
    const f = fixture();
    f.partition.db.execute('CREATE TABLE world_action_client_evidence(saved BLOB)');
    expect(() => f.catalog.open(origin)).toThrow('ACTION_RECEIPT_RECOVERY_REQUIRED');
    const legacy = new LocalHostDb(join(f.root, 'legacy.db')); cleanup.push(() => legacy.close());
    legacy.execute('CREATE TABLE world_action_client_evidence(saved BLOB)');
    expect(inspectLegacySchema(legacy)).toEqual({ durable: ['world_action_client_evidence'], cache: [] });
  });
});
