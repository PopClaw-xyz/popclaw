import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializePrivateMessageJournal } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession } from '../../../src/host/storage-maintenance.js';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const origin = 'https://private-read.example', actorId = '11111111111111111111111111111111';
function fixture(prepared = true) {
  const root = mkdtempSync(join(tmpdir(), 'private-read-')); cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb()); cleanup.push(() => db.close());
  const catalog = new ExecutionStoreCatalog({db, paths, actorId}); cleanup.push(() => catalog.close());
  if (prepared) {
    const maintenance = MaintenanceSession.begin(db, paths, 'read fixture preparation');
    initializePrivateMessageJournal({catalog, origin, maintenance});
    maintenance.finish({recovery: false, reason: 'prepared'});
  }
  return {root, paths, db, catalog};
}
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, {recursive: true}).map(String).filter(name => statSync(join(root, name)).isFile())
    .sort().map(name => [name, name.endsWith('-shm') ? 'SQLite read-lock coordination' : createHash('sha256').update(readFileSync(join(root, name))).digest('hex')]));
}
it('rejects a missing row without writes, new files, cache creation, or DDL', () => {
  const f = fixture(false), before = snapshot(f.root);
  expect(() => f.catalog.capturePrivateMessageRead(origin)).toThrow('PRIVATE_MESSAGE_NOT_PREPARED');
  expect(snapshot(f.root)).toEqual(before);
  expect(f.db.queryAll('SELECT * FROM execution_store_catalog_v1')).toEqual([]);
});
it('rejects historical/unprepared partition without writing its bytes or inventory', () => {
  const f = fixture(false), partition = openUnprovisionedPartition({catalog: f.catalog, db: f.db, paths: f.paths, actorId, origin}), before = snapshot(f.root);
  expect(() => f.catalog.capturePrivateMessageRead(origin)).toThrow('PRIVATE_MESSAGE_NOT_PREPARED');
  expect(snapshot(f.root)).toEqual(before); expect(f.catalog.open(origin)).toBe(partition);
});
it('captures an empty read on a factory-born partition with no offline preparation', () => {
  const f = fixture(false), partition = f.catalog.open(origin);
  const capture = f.catalog.capturePrivateMessageRead(origin); cleanup.push(() => capture.close());
  capture.assertCurrent();
  expect(capture.executionDb).not.toBe(partition.db);
  expect(capture.executionDb.queryAll('SELECT * FROM world_private_messages_v2')).toEqual([]);
  expect(capture.executionDb.queryAll('SELECT * FROM world_private_states_v2')).toEqual([]);
  capture.close();
});
it('reads through an independent read-only handle and closes it without disturbing the resident handle', () => {
  const f = fixture(), partition = f.catalog.open(origin);
  partition.db.execute("INSERT INTO world_private_states_v2 VALUES('b','s','1','d','m')");
  const before = snapshot(f.root), capture = f.catalog.capturePrivateMessageRead(origin); cleanup.push(() => capture.close());
  expect(capture.executionDb).not.toBe(partition.db);
  capture.assertCurrent(); expect(capture.executionDb.queryAll('SELECT * FROM world_private_states_v2')).toHaveLength(1);
  expect(() => capture.executionDb.execute('CREATE TABLE forbidden(id INTEGER)')).toThrow();
  capture.close(); capture.close();
  expect(() => capture.assertCurrent()).toThrow('PRIVATE_MESSAGE_READ_CLOSED');
  expect(snapshot(f.root)).toEqual(before);
  expect(f.catalog.open(origin)).toBe(partition);
});
it.each(['reserved', 'schema', 'required', 'actor', 'catalog-identity', 'partition-identity', 'missing-file'] as const)('rejects %s corruption without repair', damage => {
  const f = fixture(), partition = f.catalog.open(origin), capture = f.catalog.capturePrivateMessageRead(origin); cleanup.push(() => capture.close());
  if (damage === 'reserved') f.db.execute("UPDATE execution_store_catalog_v1 SET private_message_feature=replace(private_message_feature,'certified','reserved')");
  if (damage === 'schema') partition.db.execute('CREATE INDEX forged ON world_private_states_v2(state_ref)');
  if (damage === 'required') f.db.execute("UPDATE execution_store_catalog_v1 SET required_tables='[]'");
  if (damage === 'actor') f.db.execute("UPDATE execution_store_catalog_v1 SET actor_id='other'");
  if (damage === 'catalog-identity') f.db.execute("UPDATE execution_store_identity_v1 SET actor_id='other'");
  if (damage === 'partition-identity') partition.db.execute("UPDATE execution_partition_identity_v1 SET actor_id='other'");
  if (damage === 'missing-file') renameSync(partition.path, partition.path + '.removed');
  expect(() => capture.assertCurrent()).toThrow();
  expect(() => f.catalog.capturePrivateMessageRead(origin)).toThrow();
  if (damage === 'missing-file') expect(existsSync(partition.path)).toBe(false);
});
it('fences an old capture after the selected file is replaced by an identical valid database', () => {
  const f = fixture(), partition = f.catalog.open(origin);
  partition.db.execute('PRAGMA wal_checkpoint(TRUNCATE)');
  const capture = f.catalog.capturePrivateMessageRead(origin); cleanup.push(() => capture.close());
  const replacement = partition.path + '.replacement'; copyFileSync(partition.path, replacement);
  const before = statSync(partition.path).ino; renameSync(replacement, partition.path);
  expect(statSync(partition.path).ino).not.toBe(before);
  expect(() => capture.assertCurrent()).toThrow('PRIVATE_MESSAGE_READ_FILE_CHANGED');
});
it('fences and releases captures when their catalog is closed', () => {
  const f = fixture(), capture = f.catalog.capturePrivateMessageRead(origin); cleanup.push(() => capture.close());
  f.catalog.close();
  expect(() => capture.assertCurrent()).toThrow('EXECUTION_CATALOG_CLOSED');
  expect(() => capture.executionDb.queryAll('SELECT * FROM world_private_states_v2')).toThrow();
  expect(() => f.catalog.capturePrivateMessageRead(origin)).toThrow('EXECUTION_CATALOG_CLOSED');
  capture.close();
});

it('reads a certified partition without mounting a resident writable handle', () => {
  const f = fixture(); f.catalog.close();
  const catalog = new ExecutionStoreCatalog({db: f.db, paths: f.paths, actorId}); cleanup.push(() => catalog.close());
  const before = snapshot(f.root), writes = vi.spyOn(f.db, 'execute');
  const capture = catalog.capturePrivateMessageRead(origin);
  capture.assertCurrent(); capture.close(); catalog.close();
  expect(writes).not.toHaveBeenCalled(); writes.mockRestore();
  const executionName = Object.keys(before).find(name => name.includes('/execution/') && name.endsWith('.db'))!;
  // A real WAL reader creates SQLite coordination sidecars, but no database,
  // schema, row or existing WAL content changes. Deleting these could race a writer.
  expect(snapshot(f.root)).toEqual({...before,
    [executionName + '-shm']: 'SQLite read-lock coordination',
    [executionName + '-wal']: createHash('sha256').update('').digest('hex'),
  });
});

it('does not misclassify a corrupt legacy catalog binding as an absent feature', () => {
  const f = fixture(false);
  openUnprovisionedPartition({catalog: f.catalog, db: f.db, paths: f.paths, actorId, origin});
  f.db.execute("UPDATE execution_store_catalog_v1 SET actor_id='other'");
  expect(() => f.catalog.capturePrivateMessageRead(origin)).toThrow('PRIVATE_MESSAGE_PARTITION_MISMATCH');
});
