import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializePrivateMessageJournal, clearWorldFeedProjection } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession, readStorageControl, publishStorageJson } from '../../../src/host/storage-maintenance.js';
import { createStorageBackup } from '../../../src/host/storage-backup.js';
import { preparePrivateMessageJournal, PRIVATE_MESSAGE_FEATURE_TABLES } from '../../../src/world/private-message-storage.js';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const origin = 'https://private-protection.example', actorId = '11111111111111111111111111111111';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'private-protection-')); cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb()); cleanup.push(() => db.close());
  const catalog = new ExecutionStoreCatalog({db, paths, actorId}); cleanup.push(() => catalog.close());
  const partition = openUnprovisionedPartition({catalog, db, paths, actorId, origin});
  const maintenance = MaintenanceSession.begin(db, paths, 'test private preparation');
  return {root, paths, db, catalog, partition, maintenance};
}
function seed(f: ReturnType<typeof fixture>) {
  preparePrivateMessageJournal({executionDb: f.partition.db});
  f.partition.db.execute("INSERT INTO world_private_messages_v2 VALUES('b','m','e',x'00ff80',x'80ff00','ed','pd','wd',1)");
}
describe('explicit private message protection', () => {
  it('keeps historical inventory uncertified and preserves bytes during explicit preparation', () => {
    const f = fixture(); seed(f);
    expect(f.catalog.isPrivateMessageJournalCurrent(origin, f.partition)).toBe(false);
    f.catalog.close();
    const catalog = new ExecutionStoreCatalog({db: f.db, paths: f.paths, actorId}); cleanup.push(() => catalog.close());
    const partition = catalog.open(origin);
    expect(catalog.isPrivateMessageJournalCurrent(origin, partition)).toBe(false);
    const held = readStorageControl(f.paths);
    initializePrivateMessageJournal({...f, catalog, origin, failpoint: stage => {
      if (stage !== 'reserved') return;
      const row = f.db.queryOne<{required_tables: string; private_message_feature: string}>('SELECT * FROM execution_store_catalog_v1')!;
      expect(JSON.parse(row.required_tables)).toEqual([...PRIVATE_MESSAGE_FEATURE_TABLES]);
      expect(JSON.parse(row.private_message_feature).state).toBe('reserved');
    }});
    expect(partition.db.queryOne<{bytes:string}>('SELECT hex(envelope_bytes) AS bytes FROM world_private_messages_v2')?.bytes).toBe('00FF80');
    expect(catalog.isPrivateMessageJournalCurrent(origin, partition)).toBe(true);
    expect(readStorageControl(f.paths)).toEqual(held);
  });
  it.each(['reserved', 'prepared', 'verified'] as const)('retains failed %s intent and rejects reopen and backup', async stage => {
    const f = fixture();
    expect(() => initializePrivateMessageJournal({...f, origin, failpoint: at => { if (at === stage) throw new Error('interrupted'); }})).toThrow('interrupted');
    expect(f.catalog.isPrivateMessageJournalCurrent(origin, f.partition)).toBe(false);
    expect(() => f.catalog.open(origin)).toThrow();
    await expect(createStorageBackup({paths: f.paths, actorId, installationId: null, codeVersion: 'test', maintenance: f.maintenance})).rejects.toThrow();
    await expect(clearWorldFeedProjection({...f, origin})).rejects.toThrow();
    f.catalog.close();
    const fresh = new ExecutionStoreCatalog({db: f.db, paths: f.paths, actorId}); cleanup.push(() => fresh.close());
    expect(() => fresh.open(origin)).toThrow();
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  });
  it.each(['missing', 'index', 'unreserved', 'identity'] as const)('rejects active %s damage', damage => {
    const f = fixture(); initializePrivateMessageJournal({...f, origin});
    if (damage === 'missing') f.partition.db.execute('DROP TABLE world_private_states_v2');
    if (damage === 'index') f.partition.db.execute('CREATE INDEX forged ON world_private_messages_v2(message_id)');
    if (damage === 'unreserved') f.db.execute("UPDATE execution_store_catalog_v1 SET required_tables='[]'");
    if (damage === 'identity') f.partition.db.execute("UPDATE execution_partition_identity_v1 SET actor_id='other'");
    expect(f.catalog.isPrivateMessageJournalCurrent(origin, f.partition)).toBe(false);
    expect(() => f.catalog.open(origin)).toThrow();
    f.catalog.close();
    const fresh = new ExecutionStoreCatalog({db: f.db, paths: f.paths, actorId}); cleanup.push(() => fresh.close());
    expect(() => fresh.open(origin)).toThrow();
  });
  it.each(['reserved', 'prepared', 'verified'] as const)('independently detects changed original bytes at %s', at => {
    const f = fixture(); seed(f);
    expect(() => initializePrivateMessageJournal({...f, origin, failpoint: stage => {
      if (stage === at) f.partition.db.execute("UPDATE world_private_messages_v2 SET envelope_bytes=x'01'");
    }})).toThrow('PRIVATE_MESSAGE_ORIGINAL_CONTENT_CHANGED');
    expect(f.catalog.isPrivateMessageJournalCurrent(origin, f.partition)).toBe(false);
  });
  it('rolls back target transaction when existing schema is forged', () => {
    const f = fixture(); f.partition.db.execute('CREATE TABLE world_private_states_v2(forged TEXT PRIMARY KEY)');
    expect(() => initializePrivateMessageJournal({...f, origin})).toThrow('PRIVATE_MESSAGE_SCHEMA_INVALID');
    expect(f.partition.db.queryOne("SELECT 1 FROM sqlite_master WHERE name='world_private_messages_v2'")).toBeNull();
    expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
  });
  it('rejects a forged structural maintenance token and a different root', () => {
    const f = fixture(), other = fixture();
    expect(() => initializePrivateMessageJournal({...f, origin, maintenance: {paths: f.paths, epoch: f.maintenance.epoch, assertCurrent() {}} as MaintenanceSession})).toThrow('PRIVATE_MESSAGE_ROOT_MISMATCH');
    expect(() => initializePrivateMessageJournal({...f, origin, maintenance: other.maintenance})).toThrow('PRIVATE_MESSAGE_ROOT_MISMATCH');
  });
  it.each(['epoch', 'holds', 'live-root', 'forged-schema'] as const)('rechecks %s after reservation', damage => {
    const f = fixture();
    expect(() => initializePrivateMessageJournal({...f, origin, failpoint: stage => {
      if (stage === 'reserved' && damage === 'epoch') f.maintenance.finish({recovery: true, reason: 'epoch ended'});
      if (stage === 'reserved' && damage === 'holds') publishStorageJson(f.paths.storageControlFile(), {...readStorageControl(f.paths), held: []});
      if (stage === 'reserved' && damage === 'live-root') f.db.execute('INSERT INTO storage_runtime_participants_v1 VALUES(?,?)', ['racing-writer', process.pid]);
      if (stage === 'prepared' && damage === 'forged-schema') f.partition.db.execute('CREATE INDEX forged ON world_private_messages_v2(message_id)');
    }})).toThrow();
    expect(f.catalog.isPrivateMessageJournalCurrent(origin, f.partition)).toBe(false);
    if (damage !== 'holds') expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  });
  it('checks the actual partition after reservation', () => {
    const f = fixture();
    expect(() => initializePrivateMessageJournal({...f, origin, failpoint: stage => {
      if (stage === 'reserved') f.partition.db.execute("UPDATE execution_partition_identity_v1 SET origin='other'");
    }})).toThrow('EXECUTION_PARTITION_BINDING_MISMATCH');
    expect(f.partition.db.queryOne("SELECT 1 FROM sqlite_master WHERE name='world_private_messages_v2'")).toBeNull();
  });
});
