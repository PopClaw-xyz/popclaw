/** Shared write admission. Inspection never creates data, adopts a root, or changes authority. */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { HostAdapter } from './host-adapter.js';
import type { HostDb } from './host-db.js';
import { LocalHostDb } from './local-host-db.js';
import { PopclawPaths } from './popclaw-paths.js';
import { assertKnownAppliedMigrations, migrationFilenames } from './migrations.js';
import { CACHE_TABLES, DURABLE_TABLES, EXECUTION_LAYOUT_VERSION, inspectLegacySchema } from './execution-store-schema.js';
import { verifyExecutionPartition, type ExecutionCatalogRow } from './execution-store.js';
import { assertStorageBootstrap, publishStorageJson, readStorageControl } from './storage-maintenance.js';
import { tableFingerprint } from './storage-backup.js';
import { verifyAppliedGlobalSchema } from './storage-compatibility-schema.js';

/** Generation 1 is the first public local format. Component authorities stay
 * _migrations and the execution catalog/journal verifiers; no build equality. */
export interface StorageDataProfile {
  generation: 1;
  actorId: string;
  globalMigrations: string[];
  executionLayout: 1;
  identityFormat: 'master-raw-seed/v1';
}
export type StorageAdmissionStatus = 'new' | 'identity-only' | 'current' | 'upgrade-required' | 'adoption-required' | 'refused';
export interface StorageAdmission {
  status: StorageAdmissionStatus;
  reason: string;
  actorId?: string;
  profile?: StorageDataProfile;
  appliedMigrations?: string[];
  /** Sources need maintenance splitting; unknown schema is refused instead. */
  legacyMixedSources?: string[];
  /** Historical references do not become current runtime selections. No
   * external historical path is opened or certified by this inspection. */
  preservedReferences?: PreservedStorageReference[];
}
export interface PreservedStorageReference {
  role: 'migration-original' | 'migration-candidate' | 'migration-backup';
  path: string;
  state: 'present' | 'missing' | 'outside-root';
  requiredFor: 'maintenance' | 'history';
}
export interface StorageInspectionOptions { paths: PopclawPaths; migrationsDir: string }

function fail(code: string): never { throw new Error(code); }
function tables(db: HostDb): Set<string> {
  return new Set(db.queryAll<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(r => r.name));
}
function checkDatabase(db: HostDb): void {
  if (db.queryOne<{integrity_check: string}>('PRAGMA integrity_check')?.integrity_check !== 'ok'
    || db.queryAll('PRAGMA foreign_key_check').length) fail('STORAGE_DATABASE_CORRUPT');
}
function checkColumns(db: HostDb, table: string, required: string[], optional: string[] = []): void {
  const columns = db.queryAll<{name: string}>(`PRAGMA table_info(${table})`).map(row => row.name);
  if (required.some(name => !columns.includes(name)) || columns.some(name => ![...required, ...optional].includes(name))) fail('STORAGE_SCHEMA_UNKNOWN');
}
function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (!lstatSync(path).isDirectory()) fail('STORAGE_ROOT_INVALID');
  const files: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push(file);
      else fail('STORAGE_FILE_UNCLASSIFIED');
    }
  }
  walk(path); return files;
}
/** Derive, do not trust the redundant public_key. No chmod, mint or logging. */
function readActor(paths: PopclawPaths): string | undefined {
  const file = join(paths.identityDir(), 'master.key');
  if (!existsSync(file)) return undefined;
  if (!lstatSync(file).isFile()) fail('STORAGE_IDENTITY_INVALID');
  let raw: {version?: unknown; type?: unknown; seed?: unknown; public_key?: unknown};
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return fail('STORAGE_IDENTITY_INVALID'); }
  if (raw.version !== 1 || raw.type !== 'master-raw-seed' || typeof raw.seed !== 'string' || !/^[a-f0-9]{64}$/i.test(raw.seed)) fail('STORAGE_IDENTITY_FORMAT_UNSUPPORTED');
  const actor = bs58.encode(nacl.sign.keyPair.fromSeed(Buffer.from(raw.seed, 'hex')).publicKey);
  if (actor !== raw.public_key) fail('STORAGE_IDENTITY_INVALID');
  return actor;
}
function parseProfile(paths: PopclawPaths, known: readonly string[]): StorageDataProfile | undefined {
  if (!existsSync(paths.dataProfileFile())) return undefined;
  let profile: StorageDataProfile;
  try { profile = JSON.parse(readFileSync(paths.dataProfileFile(), 'utf8')); } catch { return fail('STORAGE_PROFILE_INVALID'); }
  if (profile?.generation !== 1 || profile.executionLayout !== EXECUTION_LAYOUT_VERSION
    || profile.identityFormat !== 'master-raw-seed/v1') fail('STORAGE_PROFILE_UNSUPPORTED');
  if (typeof profile.actorId !== 'string' || !profile.actorId || !Array.isArray(profile.globalMigrations)
    || profile.globalMigrations.some(f => typeof f !== 'string')
    || new Set(profile.globalMigrations).size !== profile.globalMigrations.length) fail('STORAGE_PROFILE_INVALID');
  if (Object.keys(profile).some(key => !['generation', 'actorId', 'globalMigrations', 'executionLayout', 'identityFormat'].includes(key))) fail('STORAGE_PROFILE_UNSUPPORTED');
  if (profile.globalMigrations.some(f => !known.includes(f))) fail('STORAGE_MIGRATION_UNSUPPORTED');
  return profile;
}
function assertActor(actor: string, recorded: unknown): void {
  if (typeof recorded !== 'string' || recorded !== actor) fail('STORAGE_IDENTITY_MISMATCH');
}
/** Existing setup management evidence authorizes reuse, never regeneration. */
function eligibleSetupFiles(paths: PopclawPaths, files: string[], actor: string | undefined): boolean {
  const key = join(paths.identityDir(), 'master.key'), credentialPath = join(paths.rootDir(), '.popclaw-setup-root.json');
  const setupCredential = files.includes(credentialPath);
  if (!setupCredential) return files.every(file => file === key);
  let credential: {format?: unknown; root?: unknown; scope?: unknown; identityOrigin?: unknown; popclawId?: unknown; initialRuntimeDigest?: unknown};
  try { credential = JSON.parse(readFileSync(credentialPath, 'utf8')); } catch { return fail('STORAGE_SETUP_CREDENTIAL_INVALID'); }
  if (credential.format !== 1 || credential.root !== resolve(paths.rootDir()) || credential.scope !== 'setup-management-only'
    || !['created_by_setup', 'existing_key'].includes(String(credential.identityOrigin))
    || typeof credential.initialRuntimeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(credential.initialRuntimeDigest)) fail('STORAGE_SETUP_CREDENTIAL_INVALID');
  if (!actor) fail('STORAGE_IDENTITY_MISSING');
  assertActor(actor, credential.popclawId);
  // A credential is not permission to adopt an arbitrary history. Only setup's
  // identity and configuration files can enter the normal first-runtime path.
  return files.every(file => file === key || file === credentialPath || relative(paths.config(), file) === 'plugin.json');
}
function inspectGlobal(db: HostDb, actor: string, known: string[], migrationsDir: string): {applied: string[]; selected: ExecutionCatalogRow[]} {
  checkDatabase(db);
  const present = tables(db), applied = [...assertKnownAppliedMigrations(db, known)].sort();
  if (!present.has('_migrations')) fail('STORAGE_MIGRATION_RECORD_MISSING');
  checkColumns(db, '_migrations', ['filename', 'applied_at']);
  const verified = verifyAppliedGlobalSchema(db, migrationsDir, applied);
  const allowed = verified;
  if ([...present].some(name => !allowed.has(name)) || db.queryOne("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')")) fail('STORAGE_SCHEMA_UNKNOWN');
  if (present.has('execution_store_identity_v1')) {
    checkColumns(db, 'execution_store_identity_v1', ['singleton', 'actor_id', 'layout_version']);
    const identity = db.queryOne<{actor_id: string; layout_version: number}>('SELECT actor_id,layout_version FROM execution_store_identity_v1 WHERE singleton=1');
    if (!identity) fail('EXECUTION_PARTITION_BINDING_MISMATCH');
    if (identity.layout_version !== EXECUTION_LAYOUT_VERSION) fail('EXECUTION_LAYOUT_UNSUPPORTED');
    assertActor(actor, identity.actor_id);
  }
  if (present.has('execution_store_catalog_v1')) {
    if (!present.has('execution_store_identity_v1')) fail('EXECUTION_PARTITION_BINDING_MISMATCH');
    checkColumns(db, 'execution_store_catalog_v1', ['origin', 'actor_id', 'store_id', 'layout_version', 'source_path', 'source_fingerprint', 'required_tables'], ['private_message_feature']);
  }
  const selected = present.has('execution_store_catalog_v1') ? db.queryAll<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1') : [];
  for (const row of selected) {
    assertActor(actor, row.actor_id);
    if (row.layout_version !== EXECUTION_LAYOUT_VERSION) fail('EXECUTION_LAYOUT_UNSUPPORTED');
  }
  for (const table of ['social_chat_drafts', 'house_initial_setup']) {
    if (present.has(table)) for (const row of db.queryAll<{actor_id: string}>(`SELECT DISTINCT actor_id FROM ${table}`)) assertActor(actor, row.actor_id);
  }
  return {applied, selected};
}

/** Use the existing execution-store MigrationRecord v1 and its three stages.
 * Catalog source_path is post-publication provenance: openSelected and backup
 * validation select the new partition, not that original. A pending migration
 * still needs its original when migrateExecutionStore verifies/resumes it. */
function inspectMigrationReferences(paths: PopclawPaths, actor: string, selected: ExecutionCatalogRow[]): {pending: boolean; references: PreservedStorageReference[]} {
  const references: PreservedStorageReference[] = [];
  function record(role: PreservedStorageReference['role'], path: string, requiredFor: PreservedStorageReference['requiredFor']): PreservedStorageReference {
    const local = relative(resolve(paths.rootDir()), resolve(path));
    const outside = local === '..' || local.startsWith('../') || resolve(paths.rootDir()) === resolve(path);
    const ref = {role, path, state: outside ? 'outside-root' as const : existsSync(path) ? 'present' as const : 'missing' as const, requiredFor};
    references.push(ref); return ref;
  }
  for (const row of selected) {
    const source = (row as ExecutionCatalogRow & {source_path?: unknown}).source_path;
    if (source !== null && source !== undefined) {
      if (typeof source !== 'string' || !source) fail('STORAGE_MIGRATION_REFERENCE_INVALID');
      record('migration-original', source, 'history');
    }
  }
  const directory = join(paths.executionDir(), 'migrations');
  let pending = false;
  if (existsSync(directory) && !lstatSync(directory).isDirectory()) fail('STORAGE_MIGRATION_RECORD_INVALID');
  if (existsSync(directory)) for (const file of readdirSync(directory)) {
    if (!file.endsWith('.json')) fail('STORAGE_MIGRATION_RECORD_UNKNOWN');
    if (!lstatSync(join(directory, file)).isFile()) fail('STORAGE_MIGRATION_RECORD_INVALID');
    let migration: {version: number; actorId: string; origin: string; storeId: string; source: string; sourceFingerprint: string; backupDirectory: string; durable: string[]; cache: string[]; fingerprints: Record<string, string>; state: string};
    try { migration = JSON.parse(readFileSync(join(directory, file), 'utf8')); } catch { return fail('STORAGE_MIGRATION_RECORD_INVALID'); }
    if (migration?.version !== 1 || !['prepared', 'verified', 'published'].includes(migration.state)
      || typeof migration.origin !== 'string' || !migration.origin || !/^[a-f0-9]{32}$/.test(migration.storeId)
      || typeof migration.source !== 'string' || !migration.source || typeof migration.backupDirectory !== 'string' || !migration.backupDirectory
      || !/^[a-f0-9]{64}$/.test(migration.sourceFingerprint)
      || !Array.isArray(migration.durable) || migration.durable.some(t => !(DURABLE_TABLES as readonly string[]).includes(t))
      || !Array.isArray(migration.cache) || migration.cache.some(t => !(CACHE_TABLES as readonly string[]).includes(t))
      || !migration.fingerprints || typeof migration.fingerprints !== 'object' || Array.isArray(migration.fingerprints)
      || [...migration.durable, ...migration.cache].some(t => !/^[a-f0-9]{64}$/.test(migration.fingerprints[t] ?? ''))
      || Object.keys(migration.fingerprints).some(t => ![...migration.durable, ...migration.cache].includes(t))) fail('STORAGE_MIGRATION_RECORD_UNKNOWN');
    assertActor(actor, migration.actorId);
    const historical = migration.state === 'published', requiredFor = historical ? 'history' as const : 'maintenance' as const;
    const source = record('migration-original', migration.source, requiredFor);
    const backup = record('migration-backup', migration.backupDirectory, requiredFor);
    const target = record('migration-candidate', paths.executionDb(migration.storeId), requiredFor);
    if (historical) {
      if (!selected.some(row => row.origin === migration.origin && row.store_id === migration.storeId)) fail('STORAGE_MIGRATION_SELECTION_MISMATCH');
    } else {
      pending = true;
      if (source.state === 'missing') fail('STORAGE_MIGRATION_SOURCE_MISSING');
      if (backup.state === 'missing') fail('STORAGE_MIGRATION_BACKUP_MISSING');
      if (source.state === 'present') {
        if (!lstatSync(source.path).isFile()) fail('STORAGE_MIGRATION_REFERENCE_INVALID');
        const original = new LocalHostDb(source.path, {readOnly: true});
        try {
          checkDatabase(original); inspectLegacySchema(original);
          for (const name of [...migration.durable, ...migration.cache]) if (tableFingerprint(original, name) !== migration.fingerprints[name]) fail('STORAGE_MIGRATION_CONTENT_MISMATCH');
        } finally { original.close(); }
      }
      if (migration.state === 'verified' && target.state === 'missing') fail('EXECUTION_PARTITION_MISSING');
      if (target.state === 'present') {
        if (!lstatSync(target.path).isFile()) fail('EXECUTION_PARTITION_BINDING_MISMATCH');
        const candidate = new LocalHostDb(target.path, {readOnly: true});
        try {
          checkDatabase(candidate);
          const present = tables(candidate);
          const identity = present.has('execution_partition_identity_v1') ? candidate.queryOne<{actor_id: string; origin: string; store_id: string; layout_version: number}>('SELECT * FROM execution_partition_identity_v1 WHERE singleton=1') : null;
          if (present.has('execution_partition_identity_v1') && !identity) fail('EXECUTION_PARTITION_BINDING_MISMATCH');
          if (identity && (identity.actor_id !== actor || identity.origin !== migration.origin || identity.store_id !== migration.storeId || identity.layout_version !== 1)) fail('EXECUTION_PARTITION_BINDING_MISMATCH');
          // The existing prepared stage legally retains an unedited source
          // snapshot before the identity table is installed. Verified does not.
          if (!identity && (migration.state !== 'prepared' || [...migration.durable, ...migration.cache].some(t => !present.has(t)))) fail('EXECUTION_PARTITION_BINDING_MISMATCH');
          const allowed = new Set([...migration.durable, ...migration.cache, '_READ_THIS_FIRST', 'execution_partition_identity_v1']);
          if ([...present].some(t => !allowed.has(t)) || candidate.queryOne("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')")) fail('EXECUTION_SCHEMA_UNKNOWN');
          for (const name of [...migration.durable, ...(identity ? [] : migration.cache)]) if (!present.has(name) || tableFingerprint(candidate, name) !== migration.fingerprints[name]) fail('STORAGE_MIGRATION_CONTENT_MISMATCH');
        } finally { candidate.close(); }
      }
    }
  }
  return {pending, references};
}

/** Pure read-only decision, also usable by maintenance inspection. SQLite files
 * are opened only through LocalHostDb's readOnly/fileMustExist path; never fs-read. */
export function inspectStorageCompatibility({paths, migrationsDir}: StorageInspectionOptions): StorageAdmission {
  try {
    const known = migrationFilenames(migrationsDir), profile = parseProfile(paths, known), actorId = readActor(paths);
    const globalExists = existsSync(paths.socialDb());
    if (!globalExists) {
      if (profile) fail('STORAGE_GLOBAL_DATABASE_MISSING');
      const files = filesUnder(paths.rootDir());
      if (!actorId && files.length) fail('STORAGE_IDENTITY_MISSING');
      if (eligibleSetupFiles(paths, files, actorId)) return {status: actorId ? 'identity-only' : 'new', reason: 'STORAGE_FIRST_INITIALIZATION', actorId};
      // Data without the global catalog is incomplete, not identity-only setup.
      fail('STORAGE_GLOBAL_DATABASE_MISSING');
    }
    if (!lstatSync(paths.socialDb()).isFile()) fail('STORAGE_GLOBAL_DATABASE_INVALID');
    if (!actorId) fail('STORAGE_IDENTITY_MISSING');
    if (profile) assertActor(actorId, profile.actorId);
    const db = new LocalHostDb(paths.socialDb(), {readOnly: true});
    let applied: string[], selected: ExecutionCatalogRow[];
    try {
      ({applied, selected} = inspectGlobal(db, actorId, known, migrationsDir));
      if (tables(db).has('storage_control_required_v1') && !readStorageControl(paths)) fail('STORAGE_CONTROL_MISSING');
    } finally { db.close(); }
    for (const row of selected) {
      const path = paths.executionDb(row.store_id);
      if (!existsSync(path)) fail('EXECUTION_PARTITION_MISSING');
      if (!lstatSync(path).isFile()) fail('EXECUTION_PARTITION_BINDING_MISMATCH');
      const partition = new LocalHostDb(path, {readOnly: true});
      try {
        if (partition.queryOne("SELECT name FROM sqlite_master WHERE type IN ('trigger','view')")) fail('EXECUTION_SCHEMA_UNKNOWN');
        verifyExecutionPartition(partition, row, actorId);
      } finally { partition.close(); }
    }
    const migration = inspectMigrationReferences(paths, actorId, selected);
    const legacyMixedSources: string[] = [];
    if (existsSync(paths.lorehousesDir())) for (const file of readdirSync(paths.lorehousesDir())) {
      if (!file.endsWith('.db')) continue;
      if (!lstatSync(join(paths.lorehousesDir(), file)).isFile()) fail('STORAGE_FILE_UNCLASSIFIED');
      const legacy = new LocalHostDb(join(paths.lorehousesDir(), file), {readOnly: true});
      try {
        checkDatabase(legacy);
        if (inspectLegacySchema(legacy).durable.length) legacyMixedSources.push(file);
      } finally { legacy.close(); }
    }
    const metadata = {actorId, appliedMigrations: applied, legacyMixedSources, preservedReferences: migration.references};
    if (!profile) return {status: 'adoption-required', reason: 'STORAGE_UNVERSIONED_ROOT', ...metadata};
    if (JSON.stringify([...profile.globalMigrations].sort()) !== JSON.stringify(applied)) fail('STORAGE_PROFILE_MIGRATION_MISMATCH');
    const unselectedMixedSource = legacyMixedSources.some(file => !selected.some(row =>
      (row as ExecutionCatalogRow & {source_path?: string}).source_path === join(paths.lorehousesDir(), file)));
    if (known.some(f => !applied.includes(f)) || unselectedMixedSource || migration.pending) return {status: 'upgrade-required', reason: 'STORAGE_MAINTENANCE_UPGRADE_REQUIRED', profile, ...metadata};
    // Retained migrated mixed sources are archival evidence, not a reset target.
    return {status: 'current', reason: 'STORAGE_PROFILE_CURRENT', profile, ...metadata};
  } catch (error) {
    // Never expose SQL rows, key bytes, capability links or parser payloads.
    const reason = error instanceof Error && /^(STORAGE_|EXECUTION_|PUBLIC_|PRIVATE_MESSAGE_|NATIVE_ACTION_|ACTION_RECEIPT_)[A-Z0-9_]+(?::.*)?$/.test(error.message)
      ? error.message.split(':')[0]! : 'STORAGE_INSPECTION_FAILED';
    return {status: 'refused', reason};
  }
}

export function assertStorageWriteAdmission(options: StorageInspectionOptions): StorageAdmission {
  // Keep the existing offline/restore hold authoritative, including a root
  // deliberately stopped halfway through replacement of its files.
  assertStorageBootstrap(options.paths);
  const result = inspectStorageCompatibility(options);
  if (!['new', 'identity-only', 'current'].includes(result.status)) throw new Error(`${result.reason}: preserve this root and its original identity; use reviewed maintenance or recovery before writing`);
  return result;
}

const initializations = new WeakMap<HostAdapter, {options: StorageInspectionOptions; actorId?: string}>();
/** Only the adapter that admitted a genuinely new/identity-only root can mark
 * its first initialization. Internal roots are never adopted by this function. */
export function registerStorageInitialization(host: HostAdapter, options: StorageInspectionOptions, admission: StorageAdmission): void {
  if (admission.status === 'new' || admission.status === 'identity-only') initializations.set(host, {options, actorId: admission.actorId});
}
/** Called after the existing keystore succeeds, before owner/business writes. */
export function completeStorageInitialization(host: HostAdapter, actorId: string): void {
  const initialization = initializations.get(host);
  if (!initialization) return; // Non-local/in-memory adapters keep their existing contract.
  const {options} = initialization;
  if (initialization.actorId && initialization.actorId !== actorId) fail('STORAGE_IDENTITY_MISMATCH');
  const actor = readActor(options.paths);
  if (!actor || actor !== actorId) fail('STORAGE_IDENTITY_MISMATCH');
  const {applied} = inspectGlobal(host.db, actorId, migrationFilenames(options.migrationsDir), options.migrationsDir);
  const profile: StorageDataProfile = {generation: 1, actorId, globalMigrations: applied, executionLayout: 1, identityFormat: 'master-raw-seed/v1'};
  const previous = parseProfile(options.paths, migrationFilenames(options.migrationsDir));
  if (previous && JSON.stringify(previous) !== JSON.stringify(profile)) fail('STORAGE_INITIALIZATION_PROFILE_CHANGED');
  if (!previous) publishStorageJson(options.paths.dataProfileFile(), profile);
  initializations.delete(host);
}
