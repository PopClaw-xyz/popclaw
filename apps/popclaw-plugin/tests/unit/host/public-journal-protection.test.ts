import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { PUBLIC_JOURNAL_TABLES } from '../../../src/host/execution-store-schema.js';
import { MaintenanceSession, readStorageControl } from '../../../src/host/storage-maintenance.js';
import { initializePublicStreamJournal } from '../../../src/host/execution-store-migration.js';
import { createStorageBackup, restoreStorageBackup, tableFingerprint } from '../../../src/host/storage-backup.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { makeWorldManifestPreparer } from '../../../src/world/world-capabilities.js';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'public-journal-protection-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb());
  cleanup.push(() => db.close());
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: 'synthetic-public-owner' });
  cleanup.push(() => catalog.close());
  const origin = 'https://public.example';
  const partition = openUnprovisionedPartition({ catalog, db, paths, actorId: 'synthetic-public-owner', origin });
  const maintenance = MaintenanceSession.begin(db, paths, 'synthetic public initialization');
  return { paths, db, catalog, origin, partition, maintenance };
}
async function observed() {
  const f = fixture(), pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
  ensureHouseLifecycleSchema(f.db);
  const configuredPin = Buffer.from(pair.publicKey).toString('hex');
  async function observe(log = 'log_1') {
  const rawBytes = new TextEncoder().encode(JSON.stringify({ official_ids: [], world_interaction: { version: 1,
    public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: log, envelope_baseline: 'public-envelope-01' as const, initial_public_scopes: [] } } }));
  const core = { house: { origin: f.origin, houseKey: bs58.encode(pair.publicKey), incarnation: 'house_1' }, manifestDigest: cidFromCanonical(rawBytes), signedAt: 1 };
  const bytes = popclaw.world.ManifestProof.encode(core).finish(), prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signing = new Uint8Array(prefix.length + bytes.length); signing.set(prefix); signing.set(bytes, prefix.length);
  f.db.transaction((await makeWorldManifestPreparer()({ origin: f.origin, rawBytes,
    proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core, authoritySignature: nacl.sign.detached(signing, pair.secretKey) }).finish()).toString('base64'),
    ackKeyHex: configuredPin, provenance: 'configured_pin', signal: new AbortController().signal })).commit);
  }
  await observe();
  return { ...f, configuredPin, observe };
}

it('reserves all seven durable names before DDL and refuses cached or restarted incomplete selections', () => {
  const f = fixture();
  f.catalog.reservePublicJournal(f.origin, f.partition, f.maintenance);
  const required = JSON.parse(f.db.queryOne<{ required_tables: string }>('SELECT required_tables FROM execution_store_catalog_v1')!.required_tables);
  expect(required).toEqual([...PUBLIC_JOURNAL_TABLES].sort());
  expect(f.partition.db.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_public_%'")).toEqual([]);
  expect(() => f.catalog.open(f.origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
  expect(() => f.catalog.reservePublicJournal(f.origin, f.partition, MaintenanceSession.resume(f.paths, f.maintenance.epoch)))
    .toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
  f.catalog.close();
  const restarted = new ExecutionStoreCatalog({ db: f.db, paths: f.paths, actorId: 'synthetic-public-owner' });
  cleanup.push(() => restarted.close());
  expect(() => restarted.open(f.origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
  expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
});

it('does not reserve a foreign handle, stale maintenance epoch, or pre-existing unreserved journal', () => {
  const f = fixture();
  const other = openUnprovisionedPartition({ catalog: f.catalog, db: f.db, paths: f.paths, actorId: 'synthetic-public-owner', origin: 'https://other.example' });
  expect(() => f.catalog.reservePublicJournal(f.origin, other, f.maintenance)).toThrow('PUBLIC_JOURNAL_PARTITION_MISMATCH');
  f.partition.db.execute('CREATE TABLE world_public_events_v1(value TEXT)');
  expect(() => f.catalog.reservePublicJournal(f.origin, f.partition, f.maintenance)).toThrow('PUBLIC_JOURNAL_RECOVERY_REQUIRED');
  expect(f.db.queryOne<{required_tables: string}>('SELECT required_tables FROM execution_store_catalog_v1 WHERE origin=?', [f.origin])?.required_tables).toBe('[]');
  f.maintenance.finish({ recovery: true, reason: 'preserve synthetic hold' });
  expect(() => f.catalog.reservePublicJournal(f.origin, f.partition, f.maintenance)).toThrow('STORAGE_MAINTENANCE_TOKEN_STALE');
});

it('initializes and verifies the real seven-table journal without releasing prior recovery holds', async () => {
  const f = await observed();
  f.maintenance.finish({ recovery: true, reason: 'synthetic earlier recovery' });
  const maintenance = MaintenanceSession.begin(f.db, f.paths, 'public ledger provisioning');
  const stages: string[] = [];
  const result = initializePublicStreamJournal({ ...f, maintenance, failpoint: stage => { stages.push(stage); } });
  expect(stages).toEqual(['reserved', 'prepared', 'verified']);
  expect([...result.tables].sort()).toEqual([...PUBLIC_JOURNAL_TABLES].sort());
  expect(f.partition.db.queryAll('SELECT * FROM world_public_events_v1')).toEqual([]);
  expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
  maintenance.finish({ recovery: false, reason: 'initialization completed' });
  expect(readStorageControl(f.paths)).toMatchObject({ mode: 'recovery', held: ['execution', 'consumers', 'notifications'] });
  expect(f.catalog.open(f.origin).db).toBe(f.partition.db);
});

it('retains the reservation after a cross-database interruption and cannot recreate on resume', async () => {
  const f = await observed();
  expect(() => initializePublicStreamJournal({ ...f, failpoint: stage => { if (stage === 'reserved') throw new Error('synthetic power loss'); } }))
    .toThrow('synthetic power loss');
  expect(f.partition.db.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_public_%'")).toEqual([]);
  expect(() => initializePublicStreamJournal({ ...f, maintenance: MaintenanceSession.resume(f.paths, f.maintenance.epoch) }))
    .toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
  expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
});

it('prepares a new authenticated log without activating it or reusing the old log cursor', async () => {
  const f = await observed();
  initializePublicStreamJournal(f);
  f.partition.db.execute("UPDATE world_public_cursors_v1 SET after_seq='19' WHERE log_incarnation='log_1'");
  const previous = f.partition.db.queryOne('SELECT active_log,capability_revision,selection_json FROM world_public_bindings_v1');
  await f.observe('log_2');
  initializePublicStreamJournal(f);
  expect(f.partition.db.queryOne('SELECT active_log,capability_revision,selection_json FROM world_public_bindings_v1')).toEqual(previous);
  expect(f.partition.db.queryAll('SELECT log_incarnation,after_seq FROM world_public_cursors_v1 ORDER BY log_incarnation'))
    .toEqual([{ log_incarnation: 'log_1', after_seq: '19' }, { log_incarnation: 'log_2', after_seq: '0' }]);
  expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
});

it('rolls back target initialization failure while retaining G protection and prior source rows', async () => {
  const f = await observed();
  // A malformed historical source cannot be silently treated as an empty journal.
  f.partition.db.execute('CREATE TABLE world_stream(unrecognized TEXT)');
  f.partition.db.execute("INSERT INTO world_stream VALUES('preserve original')");
  expect(() => initializePublicStreamJournal(f)).toThrow();
  expect(f.partition.db.queryAll("SELECT name FROM sqlite_master WHERE name LIKE 'world_public_%'")).toEqual([]);
  expect(f.partition.db.queryAll('SELECT * FROM world_stream')).toEqual([{ unrecognized: 'preserve original' }]);
  expect(() => f.catalog.open(f.origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
  expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
});

it('preserves the exact protected journal through a real backup and held restore', async () => {
  const f = await observed();
  initializePublicStreamJournal(f);
  const hashes = Object.fromEntries(PUBLIC_JOURNAL_TABLES.map(name => [name, tableFingerprint(f.partition.db, name)]));
  const backup = await createStorageBackup({ paths: f.paths, actorId: f.catalog.options.actorId, installationId: null, codeVersion: 'unit-b-test', maintenance: f.maintenance });
  const destination = new PopclawPaths(mkdtempSync(join(tmpdir(), 'public-journal-restore-')));
  cleanup.push(() => rmSync(destination.rootDir(), { recursive: true, force: true }));
  await restoreStorageBackup({ backupDirectory: backup.directory, destination, operation: 'restore', expectedActorId: f.catalog.options.actorId });
  const global = new LocalHostDb(destination.socialDb()); cleanup.push(() => global.close());
  const restored = new ExecutionStoreCatalog({ db: global, paths: destination, actorId: f.catalog.options.actorId }); cleanup.push(() => restored.close());
  const selected = restored.open(f.origin);
  expect(Object.fromEntries(PUBLIC_JOURNAL_TABLES.map(name => [name, tableFingerprint(selected.db, name)]))).toEqual(hashes);
  expect(readStorageControl(destination)?.held).toEqual(['execution', 'consumers', 'notifications']);
});
