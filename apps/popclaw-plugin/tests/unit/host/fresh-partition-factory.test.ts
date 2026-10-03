import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog, privateMessageFeatureCertification, verifyExecutionPartition, type ExecutionCatalogRow } from '../../../src/host/execution-store.js';
import { initializePrivateMessageJournal } from '../../../src/host/execution-store-migration.js';
import { buildFreshExecutionPartition, persistPartitionFile, FRESH_PARTITION_REQUIRED_TABLES } from '../../../src/host/execution-partition-factory.js';
import { PUBLIC_JOURNAL_TABLES } from '../../../src/host/execution-store-schema.js';
import { MaintenanceSession, readStorageControl } from '../../../src/host/storage-maintenance.js';
import { prepareActionReceiptJournal, ACTION_RECEIPT_SCHEMA_FINGERPRINT } from '../../../src/world/action-receipt-journal.js';
import * as privateMessageStorage from '../../../src/world/private-message-storage.js';
import { assertPrivateMessageJournalSchema, PRIVATE_MESSAGE_FEATURE_TABLES, PRIVATE_MESSAGE_SCHEMA_FINGERPRINT } from '../../../src/world/private-message-storage.js';
import * as scopedStreamJournal from '../../../src/world/scoped-stream-journal.js';
import { verifyPublicStreamJournalSchema } from '../../../src/world/scoped-stream-journal.js';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';

const actorId = '11111111111111111111111111111111';
const origin = 'https://fresh.example';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

function root() {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-partition-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return new PopclawPaths(dir);
}
function catalogOn(paths: PopclawPaths) {
  const db = new LocalHostDb(paths.socialDb());
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId });
  cleanup.push(() => { catalog.close(); db.close(); });
  return { db, catalog };
}
/** Every table in the global database with its row count. */
function globalShape(db: LocalHostDb): Record<string, number> {
  const names = db.queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row => row.name);
  return Object.fromEntries(names.map(name => [name, db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`)!.n]));
}

describe('fresh execution partition factory', () => {
  it('publishes the complete reservation only after the built ledgers verify and the file is durable', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = catalog.open(origin);
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
    expect(JSON.parse(row.required_tables!).sort()).toEqual([...FRESH_PARTITION_REQUIRED_TABLES]);
    for (const table of FRESH_PARTITION_REQUIRED_TABLES) {
      expect(partition.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`)?.n).toBe(0);
    }
    // H is persisted before G publishes: the partition's own write-ahead log
    // has already been folded into the file the catalog row names.
    expect(statSync(partition.path + '-wal').size).toBe(0);
    expect(() => catalog.verifySelected(origin, partition)).not.toThrow();
    // Storage readiness only. The public tables exist, but no selection-bearing
    // record is invented here: a binding, a log profile and a cursor are what a
    // subscription is made of, and all three stay empty.
    for (const table of ['world_public_bindings_v1', 'world_public_log_profiles_v1', 'world_public_cursors_v1'] as const) {
      expect(partition.db.queryAll(`SELECT * FROM "${table}"`)).toEqual([]);
    }
  });

  it('publishes the eight public-stream names and their verified empty schema with the first catalog row', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = catalog.open(origin);
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
    expect(JSON.parse(row.required_tables!)).toEqual(expect.arrayContaining([...PUBLIC_JOURNAL_TABLES]));
    expect(() => verifyPublicStreamJournalSchema(partition.db)).not.toThrow();
    for (const table of PUBLIC_JOURNAL_TABLES) {
      expect(partition.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`)?.n).toBe(0);
    }
    // The fence every receive frame consults now passes on a house that was
    // only ever joined, with no offline initializer behind it.
    expect(catalog.isPublicJournalCurrent(origin, partition)).toBe(true);
  });

  it('lets the offline reservation short-circuit on a factory-born partition instead of demanding maintenance', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = catalog.open(origin);
    const required = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables;
    const maintenance = MaintenanceSession.begin(db, paths, 'offline public reservation after the factory');
    // All eight names are already reserved, so the offline entrance verifies and
    // returns without a legacy upgrade and without rewriting the reservation.
    expect(catalog.reservePublicJournal(origin, partition, maintenance)).toEqual({ upgradeLegacyLogProfiles: false });
    expect(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables).toBe(required);
    maintenance.finish({ recovery: false, reason: 'reserved' });
  });

  it('publishes no row claiming the public names when the built public schema fails to verify', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const build = scopedStreamJournal.createPublicStreamSchema;
    const spy = vi.spyOn(scopedStreamJournal, 'createPublicStreamSchema')
      .mockImplementation(tx => { build(tx); tx.execute('DROP INDEX world_public_consumers_pending_v1'); });
    try { expect(() => catalog.open(origin)).toThrow('PUBLIC_JOURNAL_SCHEMA_INVALID:world_public_consumers_pending_v1'); }
    finally { spy.mockRestore(); }
    expect(db.queryAll('SELECT * FROM execution_store_catalog_v1')).toEqual([]);
    // Control group: the same call with the real builder does publish the names,
    // so the refusal above is about the verification, not about open() being inert.
    const partition = catalog.open(origin);
    expect(JSON.parse(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables!))
      .toEqual(expect.arrayContaining([...PUBLIC_JOURNAL_TABLES]));
    expect(catalog.isPublicJournalCurrent(origin, partition)).toBe(true);
  });

  it('neither builds nor reserves the public schema on an existing published partition, and its offline entrance still works', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = openUnprovisionedPartition({ catalog, db, paths, actorId, origin });
    const untouched = () => {
      expect(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables).toBe('[]');
      for (const table of PUBLIC_JOURNAL_TABLES) {
        expect(partition.db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table])).toBeNull();
      }
    };
    untouched();
    expect(catalog.isPublicJournalCurrent(origin, partition)).toBe(false);
    catalog.close();
    // A restart does not reconsider either: the early return for a published row
    // runs before any factory code.
    const restarted = new ExecutionStoreCatalog({ db, paths, actorId });
    cleanup.push(() => restarted.close());
    const reopened = restarted.open(origin);
    expect(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables).toBe('[]');
    // The offline maintenance entrance for such a partition is unchanged: it
    // reserves all eight names in the catalog and leaves the DDL to its own
    // separate transaction.
    const maintenance = MaintenanceSession.begin(db, paths, 'offline public reservation on a legacy partition');
    expect(restarted.reservePublicJournal(origin, reopened, maintenance)).toEqual({ upgradeLegacyLogProfiles: false });
    expect(JSON.parse(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables!))
      .toEqual([...PUBLIC_JOURNAL_TABLES].sort());
    expect(reopened.db.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_public_%'")).toEqual([]);
    maintenance.finish({ recovery: false, reason: 'reserved' });
  });

  it('publishes the private message tables and their certified marker with the first catalog row', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = catalog.open(origin);
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
    // The marker is a schema credential published with the row, not a later repair.
    expect(row.private_message_feature).toBe(privateMessageFeatureCertification('certified'));
    expect(JSON.parse(row.required_tables!)).toEqual(expect.arrayContaining([...PRIVATE_MESSAGE_FEATURE_TABLES]));
    expect(assertPrivateMessageJournalSchema(partition.db).schemaFingerprint).toBe(PRIVATE_MESSAGE_SCHEMA_FINGERPRINT);
    for (const table of PRIVATE_MESSAGE_FEATURE_TABLES) {
      expect(partition.db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table}"`)?.n).toBe(0);
    }
    expect(catalog.isPrivateMessageJournalCurrent(origin, partition)).toBe(true);
  });

  it('publishes no row at all when the private credential fails to verify before publication', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const spy = vi.spyOn(privateMessageStorage, 'assertPrivateMessageJournalSchema')
      .mockImplementation(() => { throw new Error('PRIVATE_MESSAGE_SCHEMA_INVALID:test'); });
    try { expect(() => catalog.open(origin)).toThrow('PRIVATE_MESSAGE_SCHEMA_INVALID'); }
    finally { spy.mockRestore(); }
    // The orphan the failed creation left is never adopted, and no certified row exists.
    expect(db.queryAll('SELECT * FROM execution_store_catalog_v1')).toEqual([]);
    const partition = catalog.open(origin);
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
    expect(row.store_id).toBe(partition.storeId);
    expect(row.private_message_feature).toBe(privateMessageFeatureCertification('certified'));
  });

  it('does not certify an existing published partition by opening it', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = openUnprovisionedPartition({ catalog, db, paths, actorId, origin });
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
    expect(row.private_message_feature ?? null).toBeNull();
    expect(catalog.isPrivateMessageJournalCurrent(origin, partition)).toBe(false);
    expect(() => catalog.capturePrivateMessageRead(origin)).toThrow('PRIVATE_MESSAGE_NOT_PREPARED');
    catalog.close();
    const restarted = new ExecutionStoreCatalog({ db, paths, actorId });
    cleanup.push(() => restarted.close());
    restarted.open(origin);
    expect(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.private_message_feature ?? null).toBeNull();
    expect(() => restarted.capturePrivateMessageRead(origin)).toThrow('PRIVATE_MESSAGE_NOT_PREPARED');
  });

  it('still lets the offline entrance certify an existing published partition', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = openUnprovisionedPartition({ catalog, db, paths, actorId, origin });
    const maintenance = MaintenanceSession.begin(db, paths, 'offline private preparation after the factory');
    initializePrivateMessageJournal({ catalog, origin, maintenance });
    maintenance.finish({ recovery: false, reason: 'prepared' });
    expect(catalog.isPrivateMessageJournalCurrent(origin, partition)).toBe(true);
    const capture = catalog.capturePrivateMessageRead(origin);
    try { expect(capture.executionDb.queryAll('SELECT * FROM world_private_messages_v2')).toEqual([]); }
    finally { capture.close(); }
  });

  it('writes nothing but the catalog row — no request, grant or relationship record', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const before = globalShape(db);
    catalog.open(origin);
    const after = globalShape(db);
    const changed = Object.keys(after).filter(name => after[name] !== before[name]);
    expect(changed).toEqual(['execution_store_catalog_v1']);
    expect(after.execution_store_catalog_v1! - before.execution_store_catalog_v1!).toBe(1);
  });

  it('refuses to treat a published empty reservation as a permit to build', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = openUnprovisionedPartition({ catalog, db, paths, actorId, origin });
    expect(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables).toBe('[]');
    for (const table of FRESH_PARTITION_REQUIRED_TABLES) {
      expect(partition.db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table])).toBeNull();
    }
    // A restart does not reconsider: eligibility came from the creation, and
    // this row was published without one.
    catalog.close();
    const restarted = new ExecutionStoreCatalog({ db, paths, actorId });
    cleanup.push(() => restarted.close());
    restarted.open(origin);
    expect(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables).toBe('[]');
  });

  it('never adopts the orphan a failed creation leaves behind, and still creates the next one', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    // Exactly the crash window: H fully persisted, G never published.
    const orphan = buildFreshExecutionPartition({ paths, actorId, origin, storeId: 'a'.repeat(32) });
    orphan.db.close();
    const image = readFileSync(orphan.path);
    const partition = catalog.open(origin);
    expect(partition.path).not.toBe(orphan.path);
    expect(partition.storeId).not.toBe('a'.repeat(32));
    expect(existsSync(orphan.path)).toBe(true);
    expect(readFileSync(orphan.path)).toEqual(image);
    expect(db.queryAll('SELECT store_id FROM execution_store_catalog_v1')).toHaveLength(1);
  });

  it('refuses by name while a recovery hold or a missing control file stands', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const maintenance = MaintenanceSession.begin(db, paths, 'fresh factory hold test');
    maintenance.finish({ recovery: true, reason: 'held' });
    expect(readStorageControl(paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
    expect(() => catalog.open(origin)).toThrow('FRESH_PARTITION_STORAGE_HELD: execution');
    expect(db.queryAll('SELECT origin FROM execution_store_catalog_v1')).toEqual([]);

    const other = root(), second = catalogOn(other);
    second.db.execute('CREATE TABLE storage_control_required_v1(id INTEGER PRIMARY KEY CHECK(id=1))');
    expect(() => second.catalog.open(origin)).toThrow('FRESH_PARTITION_STORAGE_CONTROL_MISSING');
    expect(second.db.queryAll('SELECT origin FROM execution_store_catalog_v1')).toEqual([]);
  });

  it('keeps the maintenance-token entrance open while holds are in force', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const maintenance = MaintenanceSession.begin(db, paths, 'fresh factory maintenance entrance');
    const partition = catalog.open(origin, { maintenance });
    expect(JSON.parse(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables!).sort())
      .toEqual([...FRESH_PARTITION_REQUIRED_TABLES]);
    expect(catalog.open(origin, { maintenance })).toBe(partition);
    // Nothing here released a hold.
    expect(readStorageControl(paths)?.mode).toBe('maintenance');
    const foreign = MaintenanceSession.begin(new LocalHostDb(root().socialDb()), root(), 'foreign root');
    expect(() => catalog.open('https://other.example', { maintenance: foreign })).toThrow('FRESH_PARTITION_ROOT_MISMATCH');
  });

  it('refuses a mis-bound partition instead of rebuilding it', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = openUnprovisionedPartition({ catalog, db, paths, actorId, origin });
    catalog.close();
    const handle = new LocalHostDb(partition.path);
    try { handle.execute('UPDATE execution_partition_identity_v1 SET origin=?', ['https://somewhere-else.example']); }
    finally { handle.close(); }
    const restarted = new ExecutionStoreCatalog({ db, paths, actorId });
    cleanup.push(() => restarted.close());
    expect(() => restarted.open(origin)).toThrow('EXECUTION_PARTITION_BINDING_MISMATCH');
  });

  it('gives two roots racing for one origin a single published partition', () => {
    const paths = root();
    const first = catalogOn(paths), second = catalogOn(paths);
    const a = first.catalog.open(origin);
    const b = second.catalog.open(origin);
    expect(b.storeId).toBe(a.storeId);
    expect(b.path).toBe(a.path);
    expect(first.db.queryAll('SELECT store_id FROM execution_store_catalog_v1')).toHaveLength(1);
    expect(existsSync(a.path)).toBe(true);
  });

  it('does not let closing a handle launder an unregistered protected feature', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = openUnprovisionedPartition({ catalog, db, paths, actorId, origin });
    // A feature that appeared with no controlled reservation behind it.
    prepareActionReceiptJournal({ executionDb: partition.db,
      expectedPartition: { origin, actorId, storeId: partition.storeId, layoutVersion: 1 },
      expectedSchemaFingerprint: ACTION_RECEIPT_SCHEMA_FINGERPRINT });
    catalog.close();
    expect(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!.required_tables).toBe('[]');
    const restarted = new ExecutionStoreCatalog({ db, paths, actorId });
    cleanup.push(() => restarted.close());
    expect(() => restarted.open(origin)).toThrow('ACTION_RECEIPT_RECOVERY_REQUIRED');
    // Control group: an ordinary durable table that no feature protects is
    // still recorded, so the refusal above is about protection, not about
    // close() having stopped writing anything at all.
    const plain = openUnprovisionedPartition({ catalog: restarted, db, paths, actorId, origin: 'https://plain.example' });
    plain.db.execute('CREATE TABLE world_participation_policy(binding TEXT PRIMARY KEY, state TEXT)');
    restarted.close();
    expect(JSON.parse(db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', ['https://plain.example'])!.required_tables!))
      .toEqual(['world_participation_policy']);
  });

  it('verifies the published partition exactly as every later reader does', () => {
    const paths = root(), { db, catalog } = catalogOn(paths);
    const partition = catalog.open(origin);
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
    const probe = new LocalHostDb(partition.path, { readOnly: true });
    try { expect(() => verifyExecutionPartition(probe, row, actorId)).not.toThrow(); }
    finally { probe.close(); }
  });

  it('refuses to call a partition durable when the checkpoint could not finish', () => {
    // `wal_checkpoint` reports `busy` rather than throwing. Since the
    // checkpoint is now the only thing that moves committed frames into the
    // partition file, taking busy for success would publish a catalog row
    // naming a store whose content is still only in a log. A reader that will
    // not let go is enough to produce it.
    const paths = root();
    const path = paths.executionDb('b'.repeat(32));
    const writer = new LocalHostDb(path);
    cleanup.push(() => writer.close());
    writer.execute('CREATE TABLE t(a)');
    writer.execute('INSERT INTO t VALUES(1)');
    expect(() => persistPartitionFile(writer, path)).not.toThrow();

    const reader = new LocalHostDb(path, { readOnly: true });
    cleanup.push(() => reader.close());
    reader.execute('BEGIN');
    reader.queryAll('SELECT * FROM t');
    writer.execute('INSERT INTO t VALUES(2)');
    // Shorten only the WAIT. A blocked checkpoint reports busy either way; the
    // production 5s would just make this test spend five seconds proving it.
    writer.execute('PRAGMA busy_timeout = 200');
    try {
      expect(() => persistPartitionFile(writer, path)).toThrow('EXECUTION_PARTITION_CHECKPOINT_BUSY');
    } finally { reader.execute('COMMIT'); writer.execute('PRAGMA busy_timeout = 5000'); }
    // Once the reader lets go the same call succeeds, so the refusal is about
    // the busy result and not about this fixture being broken.
    expect(() => persistPartitionFile(writer, path)).not.toThrow();
    expect(statSync(`${path}-wal`).size).toBe(0);
  });
});
