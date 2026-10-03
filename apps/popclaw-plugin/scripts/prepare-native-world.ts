/** Explicit offline operator entry. Never generates identity or automatically releases a recovery path. */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostAdapter } from '../src/host/host-adapter.js';
import type { HostDb } from '../src/host/host-db.js';
import { LocalHostDb } from '../src/host/local-host-db.js';
import { PopclawPaths } from '../src/host/popclaw-paths.js';
import { Keystore } from '../src/identity/keystore.js';
import { worldPublicKey } from '../src/world/action-wire.js';
import { normalizeHouseOrigin } from '../src/runtime/house-lifecycle/control-client.js';
import { ExecutionStoreCatalog, verifyExecutionPartition, privateMessageFeatureCertification, type ExecutionCatalogRow } from '../src/host/execution-store.js';
import { initializeActionReceiptJournal, initializeNativeActionJournal, initializePrivateMessageJournal } from '../src/host/execution-store-migration.js';
import { ACTION_RECEIPT_FEATURE_TABLES, NATIVE_ACTION_FEATURE_TABLES } from '../src/host/execution-store-schema.js';
import { FRESH_PARTITION_REQUIRED_TABLES } from '../src/host/execution-partition-factory.js';
import { MaintenanceSession, readStorageControl, releaseRecoveryPath, type StorageControl } from '../src/host/storage-maintenance.js';
import { createStorageBackup, fileSha256, verifyStorageBackup, tableFingerprint } from '../src/host/storage-backup.js';
import { assertActionReceiptJournalSchema, snapshotActionReceiptOriginalContent, canonicalActionJson } from '../src/world/action-receipt-journal.js';
import { assertNativeActionJournalSchema, snapshotNativeActionOriginalContent } from '../src/world/native-action-journal.js';

import { PRIVATE_MESSAGE_FEATURE_TABLES, PRIVATE_MESSAGE_FEATURE_PROFILE, PRIVATE_MESSAGE_SCHEMA_FINGERPRINT, assertPrivateMessageJournalSchema, snapshotPrivateMessageOriginalContent } from '../src/world/private-message-storage.js';

interface Common { root: string; actor: string; house: string; offlineConfirmed: boolean }
interface Receipt {
  version: 1; root: string; actor: string; house: string; epoch: string;
  prior: StorageControl | null; priorControlRequired: boolean; backup: string; backupManifestSha256: string;
  action: ReturnType<typeof initializeActionReceiptJournal>; native: ReturnType<typeof initializeNativeActionJournal>;
  actionContent: ReturnType<typeof snapshotActionReceiptOriginalContent>;
  nativeContent: ReturnType<typeof snapshotNativeActionOriginalContent>;
  globalContent: ReturnType<typeof globalSnapshot>;
  privateMessages?: ReturnType<typeof initializePrivateMessageJournal>;
  privateContent?: ReturnType<typeof snapshotPrivateMessageOriginalContent>;
}
function globalSnapshot(db: LocalHostDb) {
  const schema = db.queryAll<{type: string; name: string; tbl_name: string; sql: string | null}>(
    'SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name');
  return {schema, tables: Object.fromEntries(schema.filter(row => row.type === 'table').map(row => [row.name, tableFingerprint(db, row.name)]))};
}
/** Only the selected catalog reservations and the explicit optional feature column may change after backup. */
function verifyGlobalTransition(before: LocalHostDb, after: LocalHostDb, house: string, actor: string, storeId: string, privateMessages = false): void {
  const old = globalSnapshot(before), current = globalSnapshot(after);
  const identity = 'execution_store_identity_v1', catalog = 'execution_store_catalog_v1';
  for (const [name, fingerprint] of Object.entries(old.tables)) {
    if (name !== catalog && current.tables[name] !== fingerprint) throw new Error('OFFLINE_ORIGINAL_GLOBAL_CONTENT_CHANGED');
  }
  if (Object.keys(current.tables).some(name => !(name in old.tables) && name !== identity && name !== catalog)) throw new Error('OFFLINE_GLOBAL_TABLE_ADDED');
  // Publishing a brand-new factory-born partition also adds the optional marker
  // column, so it is read from the actual before/after shape, not from the flag.
  const privateColumn = (db: LocalHostDb) => db.queryAll<{name: string}>('PRAGMA table_info(execution_store_catalog_v1)').some(column => column.name === 'private_message_feature');
  const addsPrivateColumn = !!old.tables[catalog] && !privateColumn(before) && privateColumn(after);
  for (const row of old.schema) {
    const expected = addsPrivateColumn && row.type === 'table' && row.name === catalog && row.sql?.endsWith(')')
      ? {...row, sql: row.sql.slice(0, -1) + ', private_message_feature TEXT)'} : row;
    if (canonicalActionJson(current.schema.find(item => item.type === row.type && item.name === row.name) ?? null) !== canonicalActionJson(expected)) throw new Error('OFFLINE_GLOBAL_SCHEMA_CHANGED');
  }
  for (const row of current.schema.filter(row => !old.schema.some(item => item.type === row.type && item.name === row.name))) {
    if (row.type === 'table' && (row.name === identity || row.name === catalog)) continue;
    if (row.type === 'index' && row.tbl_name === catalog && row.sql === null
      && ['sqlite_autoindex_execution_store_catalog_v1_1', 'sqlite_autoindex_execution_store_catalog_v1_2'].includes(row.name)) continue;
    throw new Error('OFFLINE_GLOBAL_SCHEMA_ADDED');
  }
  const binding = after.queryAll('SELECT * FROM execution_store_identity_v1');
  if (canonicalActionJson(binding) !== canonicalActionJson([{singleton: 1, actor_id: actor, layout_version: 1}])) throw new Error('OFFLINE_CATALOG_BINDING_INVALID');
  type Row = ExecutionCatalogRow & {source_path: string | null; source_fingerprint: string | null; traversal_rowid: number};
  const oldRows = old.tables[catalog] ? before.queryAll<Row>('SELECT rowid AS traversal_rowid,* FROM execution_store_catalog_v1 ORDER BY origin') : [];
  const rows = after.queryAll<Row>('SELECT rowid AS traversal_rowid,* FROM execution_store_catalog_v1 ORDER BY origin');
  const required = (prior: string | undefined) => JSON.stringify([...new Set([...(JSON.parse(prior ?? '[]') as string[]), ...ACTION_RECEIPT_FEATURE_TABLES, ...NATIVE_ACTION_FEATURE_TABLES, ...(privateMessages ? PRIVATE_MESSAGE_FEATURE_TABLES : [])])].sort());
  for (const row of oldRows) {
    const prior = addsPrivateColumn ? {...row, private_message_feature: null} : row;
    const expected = row.origin === house ? {...prior, required_tables: required(row.required_tables),
      ...(privateMessages ? {private_message_feature: privateMessageFeatureCertification('certified')} : {})} : prior;
    if (canonicalActionJson(rows.find(item => item.origin === row.origin) ?? null) !== canonicalActionJson(expected)) throw new Error('OFFLINE_CATALOG_ORIGINAL_CHANGED');
  }
  const additions = rows.filter(row => !oldRows.some(item => item.origin === row.origin));
  if (oldRows.some(row => row.origin === house)) {
    if (additions.length) throw new Error('OFFLINE_CATALOG_ADDED');
  } else {
    const row = additions[0];
    // A row the factory published carries the complete fresh reservation and the
    // private-message schema credential whether or not the flag was given.
    if (additions.length !== 1 || !row || canonicalActionJson({...row, traversal_rowid: 0}) !== canonicalActionJson({
      traversal_rowid: 0, origin: house, actor_id: actor, store_id: storeId, layout_version: 1,
      source_path: null, source_fingerprint: null, required_tables: JSON.stringify([...FRESH_PARTITION_REQUIRED_TABLES]),
      ...(privateColumn(after) ? {private_message_feature: privateMessageFeatureCertification('certified')} : {}),
    })) throw new Error('OFFLINE_CATALOG_ADDED');
  }
}
function verifyGlobalBackup(paths: PopclawPaths, backup: string, db: LocalHostDb, house: string, actor: string, storeId: string, privateMessages = false): void {
  const snapshot = new LocalHostDb(join(backup, 'files', relative(paths.rootDir(), paths.socialDb())), {readOnly: true});
  try { verifyGlobalTransition(snapshot, db, house, actor, storeId, privateMessages); } finally { snapshot.close(); }
}
const deny = (): never => { throw new Error('OFFLINE_READ_ONLY_PORT'); };
function identityHost(paths: PopclawPaths, db: HostDb): HostAdapter {
  return { db, storage: {
    async read(ns, key) { if (ns !== 'identity' || key !== 'master.key') return deny(); return readFileSync(join(paths.identityDir(), key)); },
    write: async () => deny(), delete: async () => deny(), list: async () => deny(),
  }, config: {loadJson: async () => deny(), saveJson: async () => deny()},
  logger: {info: deny, warn: deny, error: deny}, clock: {now: () => new Date()}, timer: {schedule: deny} };
}
function quiescent(db: HostDb): void {
  if (!db.queryOne("SELECT name FROM sqlite_master WHERE name='storage_runtime_participants_v1'")) return;
  for (const row of db.queryAll<{pid: number}>('SELECT pid FROM storage_runtime_participants_v1')) {
    let dead = false;
    try { process.kill(row.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (!dead) throw new Error('STORAGE_ROOT_NOT_QUIESCENT');
  }
}
async function preflight(options: Common): Promise<PopclawPaths> {
  if (!options.offlineConfirmed) throw new Error('OFFLINE_CONFIRMATION_REQUIRED');
  if (!isAbsolute(options.root) || realpathSync(options.root) !== resolve(options.root)) throw new Error('OFFLINE_ROOT_INVALID');
  worldPublicKey(options.actor);
  if (normalizeHouseOrigin(options.house) !== options.house) throw new Error('OFFLINE_HOUSE_NOT_CANONICAL');
  const paths = new PopclawPaths(resolve(options.root));
  if (!existsSync(paths.socialDb()) || !existsSync(join(paths.identityDir(), 'master.key'))) throw new Error('OFFLINE_EXISTING_IDENTITY_REQUIRED');
  const db = new LocalHostDb(paths.socialDb(), {readOnly: true});
  try {
    let actor: string | undefined;
    try { actor = (await new Keystore(identityHost(paths, db)).load())?.popclawId; }
    catch { throw new Error('OFFLINE_IDENTITY_INVALID'); }
    if (actor !== options.actor) throw new Error('OFFLINE_ACTOR_MISMATCH');
    if (db.queryOne("SELECT name FROM sqlite_master WHERE name='execution_store_identity_v1'")) {
      const binding = db.queryOne<{actor_id: string; layout_version: number}>('SELECT actor_id,layout_version FROM execution_store_identity_v1 WHERE singleton=1');
      if (binding?.actor_id !== actor || binding.layout_version !== 1) throw new Error('OFFLINE_CATALOG_BINDING_INVALID');
    }
    if (db.queryOne("SELECT name FROM sqlite_master WHERE name='execution_store_catalog_v1'")) {
      for (const row of db.queryAll<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1')) {
        const selected = new LocalHostDb(paths.executionDb(row.store_id), {readOnly: true});
        try { verifyExecutionPartition(selected, row, options.actor); } finally { selected.close(); }
      }
    }
    quiescent(db); readStorageControl(paths);
  } finally { db.close(); }
  return paths;
}
export async function prepareNativeWorld(options: Common & { output: string; codeVersion: string; privateMessages?: boolean;
  failpoint?: (stage: 'backup' | 'action' | 'native' | 'private') => void }): Promise<{receipt: Receipt; sha256: string}> {
  const paths = await preflight(options);
  // Evidence must be outside the protected root, exclusively created, with no symlinked parent.
  if (!isAbsolute(options.output) || realpathSync(dirname(options.output)) !== resolve(dirname(options.output))
    || resolve(options.output).startsWith(paths.rootDir() + sep) || resolve(options.output) === paths.rootDir()) throw new Error('OFFLINE_OUTPUT_INVALID');
  const fd = openSync(options.output, 'wx', 0o600);
  let db: LocalHostDb | undefined, catalog: ExecutionStoreCatalog | undefined;
  try {
    const prior = readStorageControl(paths);
    const probe = new LocalHostDb(paths.socialDb(), {readOnly: true});
    let priorControlRequired: boolean;
    try { priorControlRequired = !!probe.queryOne("SELECT name FROM sqlite_master WHERE name='storage_control_required_v1'"); } finally { probe.close(); }
    let maintenance: MaintenanceSession | undefined;
    db = new LocalHostDb(paths.socialDb(), {beforeInitialize: handle => {
      maintenance = MaintenanceSession.begin(handle, paths, 'Explicit native world journal preparation');
      return () => {}; // Failure preserves the maintenance fence; no rollback of storage-control evidence.
    }});
    if (!maintenance) throw new Error('OFFLINE_MAINTENANCE_MISSING');
    const backup = await createStorageBackup({paths, actorId: options.actor, installationId: null, codeVersion: options.codeVersion, maintenance,
      failpoint: stage => { if (stage === 'before-manifest') options.failpoint?.('backup'); }});
    verifyStorageBackup(backup.directory);
    catalog = new ExecutionStoreCatalog({db, paths, actorId: options.actor});
    const action = initializeActionReceiptJournal({catalog, origin: options.house, maintenance});
    options.failpoint?.('action');
    const native = initializeNativeActionJournal({catalog, origin: options.house, maintenance});
    options.failpoint?.('native');
    const privateMessages = options.privateMessages ? initializePrivateMessageJournal({catalog, origin: options.house, maintenance}) : undefined;
    if (privateMessages) options.failpoint?.('private');
    const selected = catalog.open(options.house);
    verifyGlobalBackup(paths, backup.directory, db, options.house, options.actor, selected.storeId, options.privateMessages);
    const receipt: Receipt = {version: 1, root: paths.rootDir(), actor: options.actor, house: options.house,
      epoch: maintenance.epoch, prior, priorControlRequired, backup: backup.directory,
      backupManifestSha256: fileSha256(join(backup.directory, 'manifest.json')), action, native,
      ...(privateMessages ? {privateMessages} : {}),
      ...(catalog.isPrivateMessageJournalCurrent(options.house, selected) ? {privateContent: snapshotPrivateMessageOriginalContent(selected.db)} : {}),
      actionContent: snapshotActionReceiptOriginalContent(selected.db), nativeContent: snapshotNativeActionOriginalContent(selected.db), globalContent: globalSnapshot(db)};
    writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fsyncSync(fd);
    maintenance.finish({recovery: true, reason: 'Native journals prepared; explicit per-path release required'});
    return {receipt, sha256: fileSha256(options.output)};
  } finally { catalog?.close(); db?.close(); closeSync(fd); }
}
export async function releaseNativeWorld(options: Common & { receipt: string; sha256: string; epoch: string; path: 'execution' | 'consumers' | 'notifications' }): Promise<StorageControl> {
  const paths = await preflight(options);
  if (!['execution', 'consumers', 'notifications'].includes(options.path)) throw new Error('OFFLINE_RELEASE_PATH_INVALID');
  if (!/^[a-f0-9]{64}$/.test(options.sha256) || fileSha256(options.receipt) !== options.sha256) throw new Error('OFFLINE_RECEIPT_HASH_MISMATCH');
  const receipt = JSON.parse(readFileSync(options.receipt, 'utf8')) as Receipt;
  if (receipt.version !== 1 || receipt.root !== paths.rootDir() || receipt.actor !== options.actor || receipt.house !== options.house || receipt.epoch !== options.epoch) throw new Error('OFFLINE_RECEIPT_BINDING_INVALID');
  if ((receipt.prior && (receipt.prior.mode !== 'normal' || receipt.prior.held.length !== 0)) || (!receipt.prior && receipt.priorControlRequired)) throw new Error('OFFLINE_PRIOR_HOLD_REQUIRES_SEPARATE_RECOVERY');
  if (!receipt.backup.startsWith(paths.backupsDir() + sep) || fileSha256(join(receipt.backup, 'manifest.json')) !== receipt.backupManifestSha256) throw new Error('OFFLINE_BACKUP_MISMATCH');
  const backup = verifyStorageBackup(receipt.backup);
  if (backup.actorId !== options.actor || backup.sourceRoot !== paths.rootDir() || backup.maintenanceEpoch !== options.epoch || backup.consistency !== 'quiescent-set') throw new Error('OFFLINE_BACKUP_BINDING_INVALID');
  const db = new LocalHostDb(paths.socialDb(), {readOnly: true});
  try { return db.transaction(() => {
    quiescent(db);
    const current = readStorageControl(paths);
    if (current?.mode !== 'recovery' || current.epoch !== options.epoch || !current.held.includes(options.path) || current.releases[options.path]) throw new Error('OFFLINE_RELEASE_STALE');
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [options.house]);
    if (!row || row.actor_id !== options.actor || row.store_id !== receipt.native.partition.storeId) throw new Error('OFFLINE_PARTITION_CHANGED');
    verifyGlobalBackup(paths, receipt.backup, db, options.house, options.actor, row.store_id, receipt.privateMessages !== undefined);
    if (canonicalActionJson(globalSnapshot(db)) !== canonicalActionJson(receipt.globalContent)) throw new Error('OFFLINE_GLOBAL_CONTENT_CHANGED');
    const partition = new LocalHostDb(paths.executionDb(row.store_id), {readOnly: true});
    try {
      verifyExecutionPartition(partition, row, options.actor);
      const expected = {origin: options.house, actorId: options.actor, storeId: row.store_id, layoutVersion: 1 as const};
      assertActionReceiptJournalSchema(partition, expected); assertNativeActionJournalSchema(partition, expected);
      if (canonicalActionJson(snapshotActionReceiptOriginalContent(partition)) !== canonicalActionJson(receipt.actionContent)
        || canonicalActionJson(snapshotNativeActionOriginalContent(partition)) !== canonicalActionJson(receipt.nativeContent)) throw new Error('OFFLINE_CONTENT_CHANGED');
      if (receipt.privateMessages && (receipt.privateMessages.featureProfile !== PRIVATE_MESSAGE_FEATURE_PROFILE
        || receipt.privateMessages.schemaFingerprint !== PRIVATE_MESSAGE_SCHEMA_FINGERPRINT)) throw new Error('OFFLINE_PRIVATE_FEATURE_INVALID');
      if ((row.private_message_feature != null) !== (receipt.privateContent !== undefined)) throw new Error('OFFLINE_PRIVATE_FEATURE_CHANGED');
      if (receipt.privateContent) {
        assertPrivateMessageJournalSchema(partition);
        if (canonicalActionJson(snapshotPrivateMessageOriginalContent(partition)) !== canonicalActionJson(receipt.privateContent)) throw new Error('OFFLINE_PRIVATE_CONTENT_CHANGED');
      }
      releaseRecoveryPath(db, paths, options.epoch, options.path, {policy: 'Explicit offline native journal verification', evidence: `sha256:${options.sha256}`});
      return readStorageControl(paths)!;
    } finally { partition.close(); }
  }); } finally { db.close(); }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help' || command === 'help') {
    console.log('Offline native world journal preparation. Stop Gateway and join all in-flight writers first.');
    console.log('prepare --root ABS_ROOT --actor EXISTING_ACTOR --house CANONICAL_ORIGIN --offline-confirmed --output ABS_NEW_RECEIPT --code-version FIXED_VERSION [--private-messages]');
    console.log('release --root ABS_ROOT --actor EXISTING_ACTOR --house CANONICAL_ORIGIN --offline-confirmed --receipt ABS_RECEIPT --sha256 RECEIPT_SHA256 --epoch PREPARE_EPOCH --path execution|consumers|notifications');
    console.log('Preparation retains all recovery holds. Release each path explicitly before restarting. Hot authorization edits are unsupported: stop, join, edit, restart.');
    return;
  }
  const values = new Map<string, string>(); let offlineConfirmed = false; let privateMessages = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--private-messages') { if (command !== 'prepare' || privateMessages) throw new Error('OFFLINE_ARGUMENT_INVALID'); privateMessages = true; continue; }
    if (key === '--offline-confirmed') { offlineConfirmed = true; continue; }
    if (!['--root', '--actor', '--house', '--output', '--code-version', '--receipt', '--sha256', '--epoch', '--path'].includes(key) || values.has(key) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('OFFLINE_ARGUMENT_INVALID');
    values.set(key, args[++i]!);
  }
  const required = (key: string) => { const value = values.get(key); if (!value) throw new Error('OFFLINE_ARGUMENT_REQUIRED'); return value; };
  const common = {root: required('--root'), actor: required('--actor'), house: required('--house'), offlineConfirmed};
  if (command === 'prepare') {
    const result = await prepareNativeWorld({...common, privateMessages, output: required('--output'), codeVersion: required('--code-version')});
    console.log(JSON.stringify({epoch: result.receipt.epoch, sha256: result.sha256, held: ['execution', 'consumers', 'notifications']}));
  } else if (command === 'release') {
    const path = required('--path'); if (path !== 'execution' && path !== 'consumers' && path !== 'notifications') throw new Error('OFFLINE_RELEASE_PATH_INVALID');
    console.log(JSON.stringify(await releaseNativeWorld({...common, path, receipt: required('--receipt'), sha256: required('--sha256'), epoch: required('--epoch')})));
  } else throw new Error('OFFLINE_COMMAND_INVALID');
}
// Node resolves module symlinks, while argv retains the operator's path (e.g. /tmp).
if (process.argv[1] && existsSync(process.argv[1])
  && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch(error => { console.error(error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'OFFLINE_OPERATION_FAILED'); process.exitCode = 1; });
}
