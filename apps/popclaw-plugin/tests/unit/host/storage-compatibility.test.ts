import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostAdapter } from '../../../src/host/local-host-adapter.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { registerStorageRuntime, MaintenanceSession, readStorageControl } from '../../../src/host/storage-maintenance.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { inspectStorageCompatibility } from '../../../src/host/storage-compatibility.js';
import { bootstrapPlugin } from '../../../src/runtime/plugin-bootstrap.js';
import { createOpenClawHostAdapter } from '../../../src/host/openclaw-host-adapter.js';
import { claimRoot } from '../../../src/setup/identity.js';
import { tableFingerprint, createStorageBackup, restoreStorageBackup } from '../../../src/host/storage-backup.js';
import { buildMcpRuntime } from '../../../src/host/mcp-runtime-ports.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { ensureWorldCapabilitySchema } from '../../../src/world/world-capabilities.js';
import { ensureHouseCommandSchema } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { ensureOwnerLeaseSchema } from '../../../src/runtime/house-lifecycle/owner-lease.js';
import { ensureHouseRecoverySchema } from '../../../src/world/house-recovery.js';
import { ensureWorldConversationInboxSchema } from '../../../src/runtime/world-conversation-inbox.js';
import { ensureStorageParticipantsSchema } from '../../../src/host/storage-maintenance.js';
import { ensureStorageRestoreSchema } from '../../../src/host/storage-backup.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { ensureInstallationIdSchema } from '../../../src/runtime/house-lifecycle/installation.js';
import { ensureExecutionStoreIdentitySchema, ensureExecutionStoreCatalogSchema, addPrivateMessageFeatureColumn } from '../../../src/host/execution-catalog-schema.js';
import { ensureHouseOriginBindingsSchema, ensureHouseRecoveryCursorEvidenceSchema } from '../../../src/runtime/house-lifecycle/house-runtime-schema.js';

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const migrations = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
const roots: string[] = [];
const logger = { info() {}, warn() {}, error() {}, debug() {} };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
function root() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'popclaw-admission-A-'))); roots.push(path); return new PopclawPaths(path); }
function key(paths: PopclawPaths, seedByte = 7) {
  const seed = Buffer.alloc(32, seedByte), pair = nacl.sign.keyPair.fromSeed(seed);
  const actorId = bs58.encode(pair.publicKey);
  mkdirSync(paths.identityDir(), {recursive: true});
  writeFileSync(join(paths.identityDir(), 'master.key'), JSON.stringify({version: 1, type: 'master-raw-seed', seed: seed.toString('hex'), public_key: actorId, created_at: '2026-10-08T00:00:00Z'}), {mode: 0o600});
  return actorId;
}
function fixture() {
  const paths = root(), actorId = key(paths);
  const db = new LocalHostDb(paths.socialDb());
  runMigrations(db, migrationsDir);
  const catalog = new ExecutionStoreCatalog({db, paths, actorId});
  const partition = catalog.open('https://house.example');
  const partitionPath = partition.path;
  // Stopped-fixture byte measurement uses rollback-journal files. A SQLite
  // readonly connection may otherwise create WAL coordination sidecars.
  partition.db.queryOne('PRAGMA journal_mode=DELETE');
  catalog.close(); seal(db);
  writeFileSync(join(paths.vaultSocialDir(), 'data-profile.json'), JSON.stringify({generation: 1, actorId, globalMigrations: migrations, executionLayout: 1, identityFormat: 'master-raw-seed/v1'}));
  return {paths, actorId, partitionPath};
}
function seal(db: LocalHostDb) { db.queryOne('PRAGMA journal_mode=DELETE'); db.close(); }
/** Commit then terminate the OWNED fixture writer without close/checkpoint.
 * The parent waits for its death before any raw-byte measurement. */
function stoppedWalCommit(path: string, sql: string) {
  const module = new URL('../../../src/host/local-host-db.ts', import.meta.url).href;
  const script = `import {LocalHostDb} from ${JSON.stringify(module)}; const db=new LocalHostDb(${JSON.stringify(path)}); db.execute('PRAGMA wal_autocheckpoint=0'); db.execute(${JSON.stringify(sql)}); process.kill(process.pid,'SIGKILL');`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {cwd: resolve(migrationsDir, '..'), encoding: 'utf8'});
  expect(result.error).toBeUndefined(); expect(result.signal).toBe('SIGKILL');
  expect(readFileSync(path + '-wal').length).toBeGreaterThan(32);
}
function persistentWalSnapshot(paths: PopclawPaths) {
  return Object.fromEntries(Object.entries(snapshot(paths)).filter(([name]) => !name.endsWith('.db-shm')));
}
function proveUnchangedWalBytes(paths: PopclawPaths, before: Record<string, string>, scenario: string) {
  const after = persistentWalSnapshot(paths);
  expect(after).toEqual(before);
  // Synthetic, stopped fixtures only. Emit metadata for DB/WAL evidence;
  // never identity contents, row bodies, envelope bytes or key material.
  console.info('A_WAL_BYTE_PROOF', JSON.stringify({scenario, unchanged: true, files: Object.entries(before)
    .filter(([name]) => name.endsWith('.db') || name.endsWith('.db-wal'))
    .map(([name, sha256]) => ({name, bytes: statSync(join(paths.rootDir(), name)).size, before: sha256, after: after[name]}))}));
}
function migrationFixture(paths: PopclawPaths, actorId: string, state = 'prepared') {
  const source = paths.lorehouseDb('pending'), original = new LocalHostDb(source);
  original.execute('CREATE TABLE world_stream(value BLOB)');
  original.execute('INSERT INTO world_stream VALUES(?)', [Uint8Array.of(9, 3, 1)]);
  const fingerprint = tableFingerprint(original, 'world_stream'); seal(original);
  const record = {version: 1, actorId, origin: 'https://pending.example', storeId: 'a'.repeat(32), source, sourceFingerprint: 'b'.repeat(64), backupDirectory: join(paths.rootDir(), 'migration-backup'), durable: ['world_stream'], cache: [], fingerprints: {world_stream: fingerprint}, state};
  mkdirSync(record.backupDirectory); mkdirSync(join(paths.executionDir(), 'migrations'), {recursive: true});
  const recordPath = join(paths.executionDir(), 'migrations/pending.json');
  writeFileSync(recordPath, JSON.stringify(record));
  return {record, recordPath};
}
/** These fixtures are stopped before plain-fs hashing; no live SQLite descriptor is read. */
function snapshot(paths: PopclawPaths): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string, prefix = '') {
    for (const e of readdirSync(dir, {withFileTypes: true})) {
      const rel = prefix + e.name, full = join(dir, e.name);
      if (e.isDirectory()) walk(full, rel + '/');
      else result[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }
  if (existsSync(paths.rootDir())) walk(paths.rootDir());
  return result;
}
function refused(paths: PopclawPaths, code: string) {
  const before = snapshot(paths); let called = 0;
  expect(() => {
    const host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger, beforeDbInitialize: db => {
      called++; return registerStorageRuntime(db, paths);
    }});
    host.db.close();
  }).toThrow(code);
  expect(called).toBe(0);
  expect(snapshot(paths)).toEqual(before);
}
describe('storage admission before the first durable write', () => {
  it.each([false, true])('allows the actual catalog schema with optional private-message column=%s without writing admission state', feature => {
    const paths = root(), actorId = key(paths), db = new LocalHostDb(paths.socialDb());
    runMigrations(db, migrationsDir);
    const catalog = new ExecutionStoreCatalog({db, paths, actorId}); catalog.close();
    if (feature) addPrivateMessageFeatureColumn(db);
    ensureHouseOriginBindingsSchema(db); ensureHouseRecoveryCursorEvidenceSchema(db);
    seal(db);
    writeFileSync(paths.dataProfileFile(), JSON.stringify({generation: 1, actorId, globalMigrations: migrations,
      executionLayout: 1, identityFormat: 'master-raw-seed/v1'}));
    const before = snapshot(paths);
    expect(inspectStorageCompatibility({paths, migrationsDir}).status).toBe('current');
    expect(snapshot(paths)).toEqual(before);
    const probe = new LocalHostDb(paths.socialDb(), {readOnly: true});
    expect(probe.queryAll('SELECT * FROM house_origin_bindings')).toEqual([]);
    expect(probe.queryAll('SELECT * FROM house_recovery_cursor_evidence_v1')).toEqual([]);
    expect(probe.queryAll<{name: string}>('PRAGMA table_info(execution_store_catalog_v1)').some(row => row.name === 'private_message_feature')).toBe(feature);
    probe.close();
    let callbacks = 0;
    const host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger,
      beforeDbInitialize: () => { callbacks++; return () => {}; }});
    host.db.close(); expect(callbacks).toBe(1);
  });
  it('allows migrated current data when all four optional runtime tables are absent', () => {
    const paths = root(), actorId = key(paths), db = new LocalHostDb(paths.socialDb());
    runMigrations(db, migrationsDir); seal(db);
    writeFileSync(paths.dataProfileFile(), JSON.stringify({generation: 1, actorId, globalMigrations: migrations,
      executionLayout: 1, identityFormat: 'master-raw-seed/v1'}));
    const before = snapshot(paths);
    expect(inspectStorageCompatibility({paths, migrationsDir}).status).toBe('current');
    expect(snapshot(paths)).toEqual(before);
  });
  it.each([
    ['execution_store_identity_v1', ensureExecutionStoreIdentitySchema, 'PRIMARY KEY', ''],
    ['execution_store_identity_v1', ensureExecutionStoreIdentitySchema, 'CHECK(singleton=1)', 'CHECK(singleton>=1)'],
    ['execution_store_catalog_v1', ensureExecutionStoreCatalogSchema, 'store_id TEXT NOT NULL UNIQUE', 'store_id TEXT NOT NULL'],
    ['execution_store_catalog_v1', ensureExecutionStoreCatalogSchema, "DEFAULT '[]'", "DEFAULT '[ ]'"],
    ['house_origin_bindings', ensureHouseOriginBindingsSchema, 'origin TEXT NOT NULL UNIQUE', 'origin TEXT NOT NULL'],
    ['house_origin_bindings', ensureHouseOriginBindingsSchema, 'slug TEXT PRIMARY KEY', 'slug TEXT'],
    ['house_recovery_cursor_evidence_v1', ensureHouseRecoveryCursorEvidenceSchema, 'PRIMARY KEY(decision_id,store_lane)', 'PRIMARY KEY(store_lane,decision_id)'],
    ['house_recovery_cursor_evidence_v1', ensureHouseRecoveryCursorEvidenceSchema, 'evidence_json TEXT NOT NULL', 'evidence_json TEXT'],
  ] as const)('refuses damaged runtime authority %s', (table, ensure, original, changed) => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb()); ensure(db);
    const ddl = db.queryOne<{sql: string}>('SELECT sql FROM sqlite_master WHERE name=?', [table])!.sql;
    expect(ddl).toContain(original);
    const rows = db.queryAll<Record<string, string | number | null>>(`SELECT * FROM ${table}`);
    db.execute(`DROP TABLE ${table}`); db.execute(ddl.replace(original, changed));
    for (const row of rows) {
      const names = Object.keys(row);
      db.execute(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`, Object.values(row));
    }
    seal(db); refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it.each([
    ['execution_store_identity_v1', ensureExecutionStoreIdentitySchema, ', layout_version INTEGER NOT NULL'],
    ['execution_store_catalog_v1', ensureExecutionStoreCatalogSchema, ", required_tables TEXT NOT NULL DEFAULT '[]'"],
    ['house_origin_bindings', ensureHouseOriginBindingsSchema, ', origin TEXT NOT NULL UNIQUE'],
    ['house_recovery_cursor_evidence_v1', ensureHouseRecoveryCursorEvidenceSchema, 'evidence_json TEXT NOT NULL, '],
  ].flatMap(([table, ensure, missing]) => [false, true].map(unknown => ({table: table as string,
    ensure: ensure as (db: LocalHostDb) => void, missing: missing as string, unknown}))))('refuses missing/unknown columns: $table (unknown=$unknown)', ({table, ensure, missing, unknown}) => {
      const {paths} = fixture(), db = new LocalHostDb(paths.socialDb()); ensure(db);
      if (unknown) db.execute(`ALTER TABLE ${table} ADD COLUMN future_runtime_column TEXT`);
      else {
        const ddl = db.queryOne<{sql: string}>('SELECT sql FROM sqlite_master WHERE name=?', [table])!.sql;
        expect(ddl).toContain(missing);
        db.execute(`DROP TABLE ${table}`); db.execute(ddl.replace(missing, ''));
      }
      seal(db);
      const admission = inspectStorageCompatibility({paths, migrationsDir});
      expect(admission.status).toBe('refused');
      refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it('refuses a future applied migration before registration or RW initialization', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute("INSERT INTO _migrations VALUES('999-future.sql',1)"); seal(db);
    refused(paths, 'STORAGE_MIGRATION_UNSUPPORTED');
  });
  it('refuses a newer selected execution layout without resetting it', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute('UPDATE execution_store_catalog_v1 SET layout_version=2'); seal(db);
    refused(paths, 'EXECUTION_LAYOUT_UNSUPPORTED');
  });
  it('refuses a missing selected partition rather than creating an empty ledger', () => {
    const {paths, partitionPath} = fixture(); rmSync(partitionPath);
    refused(paths, 'EXECUTION_PARTITION_MISSING');
  });
  it('refuses existing assets without their key without minting another identity', () => {
    const {paths} = fixture(); rmSync(join(paths.identityDir(), 'master.key'));
    refused(paths, 'STORAGE_IDENTITY_MISSING');
  });
  it('refuses a valid but different real signing key against the existing actor', () => {
    const {paths} = fixture(); key(paths, 8);
    refused(paths, 'STORAGE_IDENTITY_MISMATCH');
  });
  it('allows the current complete profile and preserves the signing identity', () => {
    const {paths, actorId} = fixture();
    const host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger}); host.db.close();
    expect(JSON.parse(readFileSync(join(paths.identityDir(), 'master.key'), 'utf8')).public_key).toBe(actorId);
  });
  it('allows a genuinely empty root', () => {
    const paths = root(), host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger});
    expect(host.db.queryOne("SELECT name FROM sqlite_master WHERE name='_migrations'")).not.toBeNull();
    host.db.close();
  });
  it('publishes the first profile only after normal bootstrap preserves or creates a real key', async () => {
    const paths = root(), host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger});
    expect(existsSync(paths.dataProfileFile())).toBe(false);
    const boot = await bootstrapPlugin(host);
    expect(boot.identityGenerated).toBe(true);
    expect(JSON.parse(readFileSync(paths.dataProfileFile(), 'utf8')).actorId).toBe(boot.popclawId);
    host.db.close();
    expect(inspectStorageCompatibility({paths, migrationsDir}).status).toBe('current');
    const marker = readFileSync(paths.dataProfileFile(), 'utf8');
    const reopened = new LocalHostAdapter({dataRoot: paths.rootDir(), logger});
    const again = await bootstrapPlugin(reopened);
    expect(again.identityGenerated).toBe(false);
    expect(again.popclawId).toBe(boot.popclawId);
    expect(readFileSync(paths.dataProfileFile(), 'utf8')).toBe(marker);
    reopened.db.close();
  });
  it('reuses an identity-only setup root without minting or overwriting its key', async () => {
    const paths = root(), actorId = key(paths), original = readFileSync(join(paths.identityDir(), 'master.key'));
    expect(inspectStorageCompatibility({paths, migrationsDir}).status).toBe('identity-only');
    const host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger});
    const boot = await bootstrapPlugin(host);
    expect(boot.popclawId).toBe(actorId); expect(boot.identityGenerated).toBe(false);
    expect(readFileSync(join(paths.identityDir(), 'master.key'))).toEqual(original); host.db.close();
  });
  it('accepts the existing setup-management credential for the same identity-only root', async () => {
    const paths = root(), actorId = key(paths);
    claimRoot(paths.rootDir(), actorId, 'a'.repeat(64), 'existing_key');
    mkdirSync(paths.config(), {recursive: true});
    writeFileSync(paths.configFile('plugin'), JSON.stringify({lore_houses: ['https://house.example']}));
    expect(inspectStorageCompatibility({paths, migrationsDir})).toMatchObject({status: 'identity-only', actorId});
    const host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger}), boot = await bootstrapPlugin(host);
    expect(boot.popclawId).toBe(actorId); expect(boot.identityGenerated).toBe(false); host.db.close();
  });
  it('accepts a supported profile from a different code build without rewriting assets', () => {
    const {paths} = fixture();
    // The existing backup provenance field is separate from the local profile.
    writeFileSync(join(paths.rootDir(), 'source-build-provenance.json'), JSON.stringify({codeVersion: '0.1.0+older-build'}));
    const marker = readFileSync(paths.dataProfileFile(), 'utf8');
    const host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger}); host.db.close();
    expect(inspectStorageCompatibility({paths, migrationsDir}).status).toBe('current');
    expect(readFileSync(paths.dataProfileFile(), 'utf8')).toBe(marker);
  });
  it('classifies a recognized unversioned internal root but refuses automatic adoption', () => {
    const {paths} = fixture(); rmSync(paths.dataProfileFile());
    const before = snapshot(paths);
    expect(inspectStorageCompatibility({paths, migrationsDir})).toMatchObject({status: 'adoption-required', reason: 'STORAGE_UNVERSIONED_ROOT'});
    expect(snapshot(paths)).toEqual(before);
    refused(paths, 'STORAGE_UNVERSIONED_ROOT');
  });
  it('preserves interrupted initialization instead of treating its missing key as a fresh root', () => {
    const paths = root(), host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger}); seal(host.db as LocalHostDb);
    refused(paths, 'STORAGE_IDENTITY_MISSING');
  });
  it('refuses a newer profile before touching any database', () => {
    const {paths} = fixture(), profile = JSON.parse(readFileSync(paths.dataProfileFile(), 'utf8'));
    writeFileSync(paths.dataProfileFile(), JSON.stringify({...profile, generation: 2}));
    refused(paths, 'STORAGE_PROFILE_UNSUPPORTED');
  });
  it('refuses an unknown global table even when the profile says current', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute('CREATE TABLE future_owner_assets(value BLOB)'); seal(db);
    refused(paths, 'STORAGE_SCHEMA_UNKNOWN');
  });
  it('keeps the actual supported inbox read and cross-replay UNIQUE dedup behavior', () => {
    const {paths} = fixture(), host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger});
    const store = new InboxStore(host.db), item = {ts: 1, fromPopclawId: 'synthetic-sender', toPopclawId: 'synthetic-owner', body: 'synthetic', receivedAtMs: 1};
    expect([store.record(item), store.record(item)]).toEqual([true, false]);
    expect(host.db.queryOne<{n: number}>('SELECT count(body) n FROM inbox')?.n).toBe(1); host.db.close();
  });
  it('refuses a migrated global table missing a required body column', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute('ALTER TABLE inbox DROP COLUMN body'); seal(db);
    refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it.each([
    '',
    'CREATE INDEX inbox_dedup ON inbox(from_popclaw_id,ts,body_hash)',
    'CREATE UNIQUE INDEX inbox_dedup ON inbox(from_popclaw_id,ts)',
    "CREATE UNIQUE INDEX inbox_dedup ON inbox(from_popclaw_id,ts,body_hash) WHERE ts>0",
  ])('refuses missing or changed critical dedup index semantics: %s', replacement => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute('DROP INDEX inbox_dedup'); if (replacement) db.execute(replacement); seal(db);
    refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it.each([
    ['notification_preferences', (sql: string) => sql.replace('PRIMARY KEY', '')],
    ['notification_preferences', (sql: string) => sql.replace("CHECK(dm_level IN ('L1','L2','L3'))", "CHECK(dm_level IN ('L1','L2','L3','future'))")],
    ['bond_dynamics', (sql: string) => sql.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT')],
  ])('refuses changed PK, CHECK or FK semantics derived from applied SQL: %s', (table, change) => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    const ddl = db.queryOne<{sql: string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table])!.sql;
    const indices = db.queryAll<{sql: string}>("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", [table]);
    expect(change(ddl)).not.toBe(ddl);
    db.execute(`DROP TABLE ${table}`); db.execute(change(ddl));
    for (const index of indices) db.execute(index.sql);
    seal(db); refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it.each([
    'CREATE UNIQUE INDEX inbox_dedup ON inbox(from_popclaw_id COLLATE NOCASE,ts,body_hash)',
    'CREATE UNIQUE INDEX inbox_dedup ON inbox(from_popclaw_id,ts DESC,body_hash)',
  ])('refuses changed index collation or ordering: %s', replacement => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute('DROP INDEX inbox_dedup'); db.execute(replacement); seal(db);
    refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it('refuses an opaque selected trigger that demonstrably corrupts a real signed original', () => {
    const {paths, partitionPath} = fixture(), db = new LocalHostDb(partitionPath);
    db.execute('CREATE TRIGGER future_asset_rewriter AFTER INSERT ON world_public_events_v1 BEGIN UPDATE world_public_events_v1 SET envelope=zeroblob(length(NEW.envelope)) WHERE binding_id=NEW.binding_id AND event_id=NEW.event_id; END');
    const pair = nacl.sign.keyPair.fromSeed(Buffer.alloc(32, 11)), signed = nacl.sign(Uint8Array.of(1, 9, 255, 4), pair.secretKey);
    expect(nacl.sign.open(signed, pair.publicKey)).not.toBeNull();
    db.execute('INSERT INTO world_public_events_v1(binding_id,event_id,envelope,kind) VALUES(?,?,?,?)', ['binding', 'event', signed, 'test']);
    const stored = db.queryOne<{envelope: Uint8Array}>('SELECT envelope FROM world_public_events_v1')!.envelope;
    expect(nacl.sign.open(stored, pair.publicKey)).toBeNull(); seal(db);
    refused(paths, 'EXECUTION_SCHEMA_UNKNOWN');
  });
  it.each([
    [ensureWorldCapabilitySchema, 'world_capability_views_v1', 'guide_bytes'],
    [ensureHouseCommandSchema, 'house_lifecycle_commands', 'effect_json'],
    [ensureOwnerLeaseSchema, 'house_lifecycle_owner', 'renewed_at'],
    [ensureHouseRecoverySchema, 'house_recovery_decisions_v1', 'raw_bytes'],
    [ensureWorldConversationInboxSchema, 'world_conversation_inbox_v1', 'envelope_bytes'],
    [ensureStorageParticipantsSchema, 'storage_runtime_participants_v1', 'pid'],
    [ensureStorageRestoreSchema, 'storage_restore_applied_v1', 'operation'],
    [ensureHouseLifecycleSchema, 'house_participation', 'remote_error'],
    [ensureInstallationIdSchema, 'house_lifecycle_meta', 'value'],
  ])('verifies a present optional runtime table from its real schema authority: %s', (ensure, table, column) => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    ensure(db); seal(db); const before = snapshot(paths);
    expect(inspectStorageCompatibility({paths, migrationsDir}).status).toBe('current');
    expect(snapshot(paths)).toEqual(before);
    const damaged = new LocalHostDb(paths.socialDb()); damaged.execute(`ALTER TABLE ${table} DROP COLUMN ${column}`); seal(damaged);
    refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it('allows a partially initialized optional capability schema without manufacturing missing tables', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    ensureWorldCapabilitySchema(db);
    for (const name of ['world_capability_current_v1', 'world_capability_recovery_views_v1', 'world_public_manifest_logs_v1', 'world_public_manifest_log_evidence_v1', 'world_kind_revisions']) db.execute(`DROP TABLE ${name}`);
    seal(db); const before = snapshot(paths);
    expect(inspectStorageCompatibility({paths, migrationsDir}).status).toBe('current');
    expect(snapshot(paths)).toEqual(before);
  });
  it('boots the ordinary adapter with optional runtime schemas without minting installation or lease authority', async () => {
    const {paths, actorId} = fixture(), db = new LocalHostDb(paths.socialDb());
    for (const ensure of [ensureWorldCapabilitySchema, ensureHouseCommandSchema, ensureOwnerLeaseSchema,
      ensureHouseRecoverySchema, ensureWorldConversationInboxSchema, ensureStorageRestoreSchema,
      ensureHouseLifecycleSchema, ensureInstallationIdSchema]) ensure(db);
    seal(db);
    const before = snapshot(paths), host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger});
    const boot = await bootstrapPlugin(host);
    expect(boot.identityGenerated).toBe(false); expect(boot.popclawId).toBe(actorId);
    for (const table of ['house_lifecycle_owner', 'house_lifecycle_commands', 'house_lifecycle_meta',
      'house_participation', 'house_recovery_decisions_v1', 'world_capability_current_v1']) {
      expect(host.db.queryOne<{n: number}>(`SELECT count(*) n FROM ${table}`)?.n).toBe(0);
    }
    seal(host.db as LocalHostDb); const after = snapshot(paths);
    // Ordinary admitted bootstrap may initialize configuration. The pure
    // schema reuse must preserve identity/profile and selected originals.
    for (const [name, hash] of Object.entries(before)) {
      if (name.endsWith('master.key') || name.endsWith('data-profile.json') || name.startsWith('vault/social/execution/')) expect(after[name]).toBe(hash);
    }
  });
  it('refuses changed optional owner CHECK and command pending-index semantics', () => {
    for (const kind of ['owner', 'commands']) {
      const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
      if (kind === 'commands') { ensureHouseCommandSchema(db); db.execute('DROP INDEX house_commands_pending'); }
      else {
        ensureOwnerLeaseSchema(db);
        const sql = db.queryOne<{sql: string}>("SELECT sql FROM sqlite_master WHERE name='house_lifecycle_owner'")!.sql;
        db.execute('DROP TABLE house_lifecycle_owner'); db.execute(sql.replace('CHECK (id = 1)', 'CHECK (id >= 1)'));
      }
      seal(db); refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
    }
  });
  it.each([
    ['restore', false, false],
    ['clone', true, false],
    ['clone', false, false],
    ['clone', false, true],
  ] as const)('admits actual %s output (source meta=%s, former compact clone DDL=%s)', async (operation, withMeta, compactMeta) => {
    const source = root(), actorId = key(source), host = new LocalHostAdapter({dataRoot: source.rootDir(), logger});
    await bootstrapPlugin(host);
    expect(inspectStorageCompatibility({paths: source, migrationsDir}).status).toBe('current');
    expect(host.db.queryOne("SELECT name FROM sqlite_master WHERE name='house_lifecycle_meta'")).toBeNull();
    if (withMeta) ensureInstallationIdSchema(host.db);
    const maintenance = MaintenanceSession.begin(host.db, source, 'synthetic clone schema regression');
    const backup = await createStorageBackup({paths: source, actorId, installationId: null, codeVersion: 'synthetic-P2', maintenance});
    host.db.close();
    const destination = root(), restored = await restoreStorageBackup({backupDirectory: backup.directory,
      destination, operation, expectedActorId: actorId});
    if (compactMeta) {
      // Preserve the exact format previously generated by the legitimate clone
      // writer. Fixing only future creation must not strand that existing root.
      const old = new LocalHostDb(destination.socialDb());
      old.execute('DROP TABLE house_lifecycle_meta');
      old.execute('CREATE TABLE house_lifecycle_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      old.execute("INSERT INTO house_lifecycle_meta VALUES('installation_id',?)", [restored.installationId]);
      old.close();
    }
    const probe = new LocalHostDb(destination.socialDb(), {readOnly: true});
    if (operation === 'clone') {
      expect(probe.queryOne<{value: string}>("SELECT value FROM house_lifecycle_meta WHERE key='installation_id'")?.value).toBe(restored.installationId);
      const authority = new LocalHostDb(':memory:'); ensureInstallationIdSchema(authority);
      for (const pragma of ['table_xinfo(house_lifecycle_meta)', 'foreign_key_list(house_lifecycle_meta)',
        'index_list(house_lifecycle_meta)', 'index_xinfo(sqlite_autoindex_house_lifecycle_meta_1)']) {
        expect(probe.queryAll(`PRAGMA ${pragma}`)).toEqual(authority.queryAll(`PRAGMA ${pragma}`));
      }
      authority.close();
    }
    probe.close();
    const control = readStorageControl(destination);
    expect(control?.mode).toBe('recovery'); expect(control?.held.length).toBeGreaterThan(0);
    const admission = inspectStorageCompatibility({paths: destination, migrationsDir});
    let callbackCount = 0, runtimeError: string | null = null;
    try {
      const resumed = new LocalHostAdapter({dataRoot: destination.rootDir(), logger,
        beforeDbInitialize: () => {callbackCount++; return () => {};}});
      resumed.db.close();
    } catch (error) { runtimeError = (error as Error).message.split(':')[0]!; }
    console.info('A_P2_CLONE_PROOF', JSON.stringify({operation, withMeta, compactMeta,
      admission: {status: admission.status, reason: admission.reason}, runtimeError, callbackCount,
      recoveryHoldPreserved: JSON.stringify(readStorageControl(destination)) === JSON.stringify(control)}));
    expect(admission.status).toBe('current'); expect(runtimeError).toBeNull(); expect(callbackCount).toBe(1);
    expect(readStorageControl(destination)).toEqual(control);
  });
  it.each([
    ['CHECK', 'notification_preferences', "'L2'", "'L 2'"],
    ['DEFAULT', 'notification_preferences', "DEFAULT 'L1'", "DEFAULT 'L 1'"],
  ])('refuses meaningful whitespace changes inside a %s literal', (_kind, table, original, changed) => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    const ddl = db.queryOne<{sql: string}>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [table])!.sql;
    expect(ddl).toContain(original);
    db.execute(`DROP TABLE ${table}`); db.execute(ddl.replace(original, changed));
    seal(db); refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it('refuses meaningful whitespace changes inside a partial-index expression literal', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    const ddl = db.queryOne<{sql: string}>("SELECT sql FROM sqlite_master WHERE name='inbox_pending_policy'")!.sql;
    expect(ddl).toContain("'pending'");
    db.execute('DROP INDEX inbox_pending_policy'); db.execute(ddl.replace("'pending'", "'pen ding'"));
    seal(db); refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it('refuses an opaque selected view without repairing the partition', () => {
    const {paths, partitionPath} = fixture(), db = new LocalHostDb(partitionPath);
    db.execute('CREATE VIEW future_projection AS SELECT event_id FROM world_public_events_v1'); seal(db);
    refused(paths, 'EXECUTION_SCHEMA_UNKNOWN');
  });
  it('reads committed but uncheckpointed compatible WAL state without changing DB or existing WAL bytes', () => {
    const {paths} = fixture();
    stoppedWalCommit(paths.socialDb(), "INSERT INTO notification_queue(level,kind,payload_json,enqueued_at) VALUES('L1','wal-proof','{}',1)");
    const before = persistentWalSnapshot(paths);
    expect(inspectStorageCompatibility({paths, migrationsDir}).status).toBe('current');
    const db = new LocalHostDb(paths.socialDb(), {readOnly: true});
    expect(db.queryOne<{n: number}>("SELECT count(*) n FROM notification_queue WHERE kind='wal-proof'")?.n).toBe(1); db.close();
    proveUnchangedWalBytes(paths, before, 'compatible-uncheckpointed-global');
  });
  it('sees a future applied migration committed only in WAL and refuses before application writes', () => {
    const {paths} = fixture(); stoppedWalCommit(paths.socialDb(), "INSERT INTO _migrations VALUES('999-future.sql',1)");
    const before = persistentWalSnapshot(paths); let called = 0;
    expect(inspectStorageCompatibility({paths, migrationsDir}).reason).toBe('STORAGE_MIGRATION_UNSUPPORTED');
    expect(() => new LocalHostAdapter({dataRoot: paths.rootDir(), logger, beforeDbInitialize: () => {called++; return () => {};}})).toThrow('STORAGE_MIGRATION_UNSUPPORTED');
    expect(called).toBe(0); proveUnchangedWalBytes(paths, before, 'future-migration-uncheckpointed-global');
  });
  it('rejects a selected trigger committed only in its WAL without checkpointing or altering original bytes', () => {
    const {paths, partitionPath} = fixture();
    stoppedWalCommit(partitionPath, 'CREATE TRIGGER future_asset_rewriter AFTER INSERT ON world_public_events_v1 BEGIN UPDATE world_public_events_v1 SET envelope=zeroblob(length(NEW.envelope)) WHERE event_id=NEW.event_id; END');
    const before = persistentWalSnapshot(paths);
    expect(inspectStorageCompatibility({paths, migrationsDir}).reason).toBe('EXECUTION_SCHEMA_UNKNOWN');
    expect(() => new LocalHostAdapter({dataRoot: paths.rootDir(), logger})).toThrow('EXECUTION_SCHEMA_UNKNOWN');
    proveUnchangedWalBytes(paths, before, 'unknown-trigger-uncheckpointed-partition');
  });
  it('allows only SQLite coordination sidecars when inspecting a stopped WAL root with no sidecars', async () => {
    const paths = root(), host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger});
    await bootstrapPlugin(host); host.db.close();
    const writer = new LocalHostDb(paths.socialDb()); writer.execute("INSERT INTO _migrations VALUES('999-future.sql',1)"); writer.close();
    expect(existsSync(paths.socialDb() + '-wal')).toBe(false);
    const before = snapshot(paths);
    expect(inspectStorageCompatibility({paths, migrationsDir}).reason).toBe('STORAGE_MIGRATION_UNSUPPORTED');
    const after = snapshot(paths), added = Object.keys(after).filter(name => !(name in before));
    expect(added.every(name => name === 'vault/social/my-social-assets.db-wal' || name === 'vault/social/my-social-assets.db-shm')).toBe(true);
    for (const [name, hash] of Object.entries(before)) expect(after[name]).toBe(hash);
    if (existsSync(paths.socialDb() + '-wal')) expect(readFileSync(paths.socialDb() + '-wal').length).toBe(0);
  });
  it('refuses a selected journal with unknown schema', () => {
    const {paths, partitionPath} = fixture(), db = new LocalHostDb(partitionPath);
    db.execute('CREATE TABLE future_journal(value BLOB)'); seal(db);
    refused(paths, 'EXECUTION_SCHEMA_UNKNOWN');
  });
  it('refuses unknown catalog schema independently of the supported marker', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute('ALTER TABLE execution_store_catalog_v1 ADD COLUMN future_binding TEXT'); seal(db);
    refused(paths, 'STORAGE_GLOBAL_SCHEMA_MISMATCH');
  });
  it('records missing post-publication source provenance without treating the complete selected ledger as missing', () => {
    const {paths} = fixture(), source = join(paths.rootDir(), 'retired-original.db'), db = new LocalHostDb(paths.socialDb());
    db.execute('UPDATE execution_store_catalog_v1 SET source_path=?,source_fingerprint=?', [source, 'c'.repeat(64)]); seal(db);
    expect(inspectStorageCompatibility({paths, migrationsDir})).toMatchObject({status: 'current', preservedReferences: [{role: 'migration-original', path: source, state: 'missing', requiredFor: 'history'}]});
    const host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger}); host.db.close();
  });
  it('keeps an external catalog source as historical provenance without opening or scanning that directory', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb()), source = '/not-opened-by-admission/old/original.db';
    db.execute('UPDATE execution_store_catalog_v1 SET source_path=?', [source]); seal(db);
    expect(inspectStorageCompatibility({paths, migrationsDir})).toMatchObject({status: 'current', preservedReferences: [{state: 'outside-root', requiredFor: 'history'}]});
  });
  it('classifies a prepared migration and its unselected original-copy candidate for maintenance while preserving both', () => {
    const {paths, actorId} = fixture(), {record} = migrationFixture(paths, actorId);
    copyFileSync(record.source, paths.executionDb(record.storeId));
    const before = snapshot(paths), inspection = inspectStorageCompatibility({paths, migrationsDir});
    expect(inspection.status).toBe('upgrade-required');
    expect(inspection.preservedReferences).toEqual(expect.arrayContaining([{role: 'migration-candidate', path: paths.executionDb(record.storeId), state: 'present', requiredFor: 'maintenance'}]));
    expect(snapshot(paths)).toEqual(before); refused(paths, 'STORAGE_MAINTENANCE_UPGRADE_REQUIRED');
  });
  it('refuses a pending migration missing its required original before any startup writes', () => {
    const {paths, actorId} = fixture(), {record} = migrationFixture(paths, actorId); rmSync(record.source);
    refused(paths, 'STORAGE_MIGRATION_SOURCE_MISSING');
  });
  it('refuses a pending migration missing the backup required by the existing resume path', () => {
    const {paths, actorId} = fixture(), {record} = migrationFixture(paths, actorId); rmSync(record.backupDirectory, {recursive: true});
    refused(paths, 'STORAGE_MIGRATION_BACKUP_MISSING');
  });
  it('classifies a prepared migration before its candidate is copied without recreating it', () => {
    const {paths, actorId} = fixture(); migrationFixture(paths, actorId);
    expect(inspectStorageCompatibility({paths, migrationsDir})).toMatchObject({status: 'upgrade-required', preservedReferences: expect.arrayContaining([{role: 'migration-candidate', path: paths.executionDb('a'.repeat(32)), state: 'missing', requiredFor: 'maintenance'}])});
    refused(paths, 'STORAGE_MAINTENANCE_UPGRADE_REQUIRED');
  });
  it('keeps a published migration record and missing historical backup without dereferencing the past', () => {
    const {paths, actorId, partitionPath} = fixture(), {record, recordPath} = migrationFixture(paths, actorId, 'published');
    const db = new LocalHostDb(paths.socialDb()), selected = db.queryOne<{store_id: string}>('SELECT store_id FROM execution_store_catalog_v1')!;
    db.execute('UPDATE execution_store_catalog_v1 SET source_path=?,source_fingerprint=?', [record.source, record.sourceFingerprint]); seal(db);
    writeFileSync(recordPath, JSON.stringify({...record, origin: 'https://house.example', storeId: selected.store_id}));
    rmSync(record.source); rmSync(record.backupDirectory, {recursive: true});
    const before = snapshot(paths), inspection = inspectStorageCompatibility({paths, migrationsDir});
    expect(inspection.status).toBe('current');
    expect(inspection.preservedReferences).toEqual(expect.arrayContaining([{role: 'migration-backup', path: record.backupDirectory, state: 'missing', requiredFor: 'history'}, {role: 'migration-candidate', path: partitionPath, state: 'present', requiredFor: 'history'}]));
    expect(snapshot(paths)).toEqual(before);
  });
  it('refuses a verified migration missing its unpublished candidate', () => {
    const {paths, actorId} = fixture(); migrationFixture(paths, actorId, 'verified');
    refused(paths, 'EXECUTION_PARTITION_MISSING');
  });
  it('refuses a future migration record format even with a supported current marker', () => {
    const {paths, actorId} = fixture(), {record, recordPath} = migrationFixture(paths, actorId);
    writeFileSync(recordPath, JSON.stringify({...record, version: 2})); refused(paths, 'STORAGE_MIGRATION_RECORD_UNKNOWN');
  });
  it('refuses missing selected feature state even when the catalog and marker exist', () => {
    const {paths, partitionPath} = fixture(), db = new LocalHostDb(partitionPath);
    db.execute('DROP TABLE world_private_states_v2'); seal(db);
    refused(paths, 'EXECUTION_REQUIRED_TABLE_MISSING');
  });
  it('checks global actor bindings independently of the supplied profile', () => {
    const {paths} = fixture(), actorId = key(paths, 9), profile = JSON.parse(readFileSync(paths.dataProfileFile(), 'utf8'));
    writeFileSync(paths.dataProfileFile(), JSON.stringify({...profile, actorId}));
    refused(paths, 'STORAGE_IDENTITY_MISMATCH');
  });
  it('refuses a wrong key on an unversioned root using its existing catalog binding', () => {
    const {paths} = fixture(); rmSync(paths.dataProfileFile()); key(paths, 11);
    refused(paths, 'STORAGE_IDENTITY_MISMATCH');
  });
  it('classifies a supported earlier migration set for explicit maintenance upgrade', () => {
    const paths = root(), oldMigrationsDir = root().rootDir(), actorId = key(paths);
    const earlier = migrations.filter(f => f !== '046-social-chat-drafts.sql');
    for (const name of earlier) copyFileSync(join(migrationsDir, name), join(oldMigrationsDir, name));
    const db = new LocalHostDb(paths.socialDb()); runMigrations(db, oldMigrationsDir); seal(db);
    writeFileSync(paths.dataProfileFile(), JSON.stringify({generation: 1, actorId, globalMigrations: earlier, executionLayout: 1, identityFormat: 'master-raw-seed/v1'}));
    expect(inspectStorageCompatibility({paths, migrationsDir})).toMatchObject({status: 'upgrade-required', reason: 'STORAGE_MAINTENANCE_UPGRADE_REQUIRED'});
    refused(paths, 'STORAGE_MAINTENANCE_UPGRADE_REQUIRED');
  });
  it('refuses newer migration data under a program supporting only the earlier set', () => {
    const {paths} = fixture(), oldMigrationsDir = root().rootDir();
    for (const name of migrations.filter(f => f !== '046-social-chat-drafts.sql')) copyFileSync(join(migrationsDir, name), join(oldMigrationsDir, name));
    const before = snapshot(paths); let called = 0;
    expect(() => new LocalHostAdapter({dataRoot: paths.rootDir(), migrationsDir: oldMigrationsDir, logger, beforeDbInitialize: () => {called++; return () => {};}})).toThrow('STORAGE_MIGRATION_UNSUPPORTED');
    expect(called).toBe(0); expect(snapshot(paths)).toEqual(before);
  });
  it('preserves an actual signed original and unresolved/consumed state on compatible restart', () => {
    const {paths, actorId} = fixture(), db = new LocalHostDb(paths.socialDb());
    const pair = nacl.sign.keyPair.fromSeed(Buffer.alloc(32, 7)), message = Uint8Array.of(0, 9, 255, 1);
    const signed = nacl.sign(message, pair.secretKey);
    db.execute('INSERT INTO relation_outbox(event_id,house_key,followee_popclaw_id,seq,signed_payload,created_at,sent_at) VALUES(?,?,?,?,?,?,NULL)', ['original', 'house-key', 'followee', 17, signed, 1]);
    db.execute('INSERT INTO social_chat_drafts(actor_id,draft_id,payload,digest,created_at,consumed_at) VALUES(?,?,NULL,?,?,?)', [actorId, 'dm-s9', 'spent-digest', 1, 2]);
    seal(db);
    const host = new LocalHostAdapter({dataRoot: paths.rootDir(), logger});
    const original = host.db.queryOne<{signed_payload: Uint8Array; sent_at: number | null}>('SELECT signed_payload,sent_at FROM relation_outbox WHERE event_id=?', ['original'])!;
    expect(new Uint8Array(original.signed_payload)).toEqual(signed);
    expect(nacl.sign.open(original.signed_payload, pair.publicKey)).toEqual(message);
    expect(original.sent_at).toBeNull();
    expect(host.db.queryOne<{consumed_at: number}>('SELECT consumed_at FROM social_chat_drafts WHERE draft_id=?', ['dm-s9'])?.consumed_at).toBe(2);
    host.db.close();
  });
  it('refuses an asset root with a missing global catalog', () => {
    const {paths} = fixture(); rmSync(paths.socialDb());
    refused(paths, 'STORAGE_GLOBAL_DATABASE_MISSING');
  });
  it('does not mint when a keyless root contains only non-database assets', () => {
    const paths = root(); mkdirSync(paths.newspaperDir(), {recursive: true});
    writeFileSync(paths.lastNewspaperHtml(), '<html>owner artifact</html>');
    refused(paths, 'STORAGE_IDENTITY_MISSING');
  });
  it('reaches the same guard from the actual native adapter before its participant callback', () => {
    const {paths} = fixture(), profile = JSON.parse(readFileSync(paths.dataProfileFile(), 'utf8'));
    writeFileSync(paths.dataProfileFile(), JSON.stringify({...profile, generation: 2}));
    const oldRoot = process.env.POPCLAW_DATA_ROOT, before = snapshot(paths); let called = 0;
    process.env.POPCLAW_DATA_ROOT = paths.rootDir();
    try {
      expect(() => createOpenClawHostAdapter({runtime: {state: {resolveStateDir: () => dirname(paths.rootDir())}}}, () => {called++; return () => {};})).toThrow('STORAGE_PROFILE_UNSUPPORTED');
    } finally { if (oldRoot === undefined) delete process.env.POPCLAW_DATA_ROOT; else process.env.POPCLAW_DATA_ROOT = oldRoot; }
    expect(called).toBe(0); expect(snapshot(paths)).toEqual(before);
  });
  it('reaches the guard from the actual MCP runtime root before assembly or registration writes', async () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute("INSERT INTO _migrations VALUES('999-future.sql',1)"); seal(db);
    const before = snapshot(paths); let called = 0;
    await expect(buildMcpRuntime({dataRoot: paths.rootDir(), logger, closing: new AbortController().signal,
      serverBox: {}, approvalWindowMs: undefined, consumerId: () => {called++; return 'not-reached';}})).rejects.toThrow('STORAGE_MIGRATION_UNSUPPORTED');
    expect(called).toBe(0); expect(snapshot(paths)).toEqual(before);
  });
});
