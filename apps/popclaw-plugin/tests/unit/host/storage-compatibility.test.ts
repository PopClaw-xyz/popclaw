import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostAdapter } from '../../../src/host/local-host-adapter.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { inspectStorageCompatibility } from '../../../src/host/storage-compatibility.js';
import { bootstrapPlugin } from '../../../src/runtime/plugin-bootstrap.js';
import { createOpenClawHostAdapter } from '../../../src/host/openclaw-host-adapter.js';
import { claimRoot } from '../../../src/setup/identity.js';
import { tableFingerprint } from '../../../src/host/storage-backup.js';
import { buildMcpRuntime } from '../../../src/host/mcp-runtime-ports.js';

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
  it('refuses a selected journal with unknown schema', () => {
    const {paths, partitionPath} = fixture(), db = new LocalHostDb(partitionPath);
    db.execute('CREATE TABLE future_journal(value BLOB)'); seal(db);
    refused(paths, 'EXECUTION_SCHEMA_UNKNOWN');
  });
  it('refuses unknown catalog schema independently of the supported marker', () => {
    const {paths} = fixture(), db = new LocalHostDb(paths.socialDb());
    db.execute('ALTER TABLE execution_store_catalog_v1 ADD COLUMN future_binding TEXT'); seal(db);
    refused(paths, 'STORAGE_SCHEMA_UNKNOWN');
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
