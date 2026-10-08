import { WorldFeedCache } from '../ingress/world-feed-cache.js';
import { rebuildPublicWorldProjection } from '../ingress/public-world-stream-client.js';
import { randomBytes } from 'node:crypto';
import { existsSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalHostDb } from './local-host-db.js';
import { ExecutionStoreCatalog, type ExecutionCatalogRow, type ExecutionPartition } from './execution-store.js';
import { CACHE_TABLES, PUBLIC_JOURNAL_TABLES, ACTION_RECEIPT_FEATURE_TABLES, NATIVE_ACTION_FEATURE_TABLES, EXECUTION_LAYOUT_VERSION, inspectLegacySchema } from './execution-store-schema.js';
import { MaintenanceSession, publishStorageJson } from './storage-maintenance.js';
import { createStorageBackup, fileSha256, quoteSqlIdentifier, tableFingerprint, verifyStorageBackup } from './storage-backup.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { normalizeHouseOrigin, normalizeAckKeyHex } from '../runtime/house-lifecycle/control-client.js';
import { readParticipation } from '../runtime/house-lifecycle/participation-store.js';
import { readHouseCapabilityView } from '../world/world-capabilities.js';
import { publicProducerPolicy } from '../runtime/house-lifecycle/public-read-resources.js';
import { preparePublicStreamJournal, verifyPublicStreamJournalSchema, EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST } from '../world/scoped-stream-journal.js';

import { prepareActionReceiptJournal, assertActionReceiptJournalSchema, snapshotActionReceiptOriginalContent,
  snapshotActionJournalTableOriginalContent, canonicalActionJson, ACTION_RECEIPT_FEATURE_PROFILE, ACTION_RECEIPT_SCHEMA_FINGERPRINT } from '../world/action-receipt-journal.js';
import { prepareNativeActionJournal, assertNativeActionJournalSchema, snapshotNativeActionOriginalContent,
  NATIVE_ACTION_FEATURE_PROFILE, NATIVE_ACTION_SCHEMA_FINGERPRINT } from '../world/native-action-journal.js';

import { preparePrivateMessageJournal, assertPrivateMessageJournalSchema, snapshotPrivateMessageOriginalContent,
  PRIVATE_MESSAGE_FEATURE_TABLES, PRIVATE_MESSAGE_FEATURE_PROFILE, PRIVATE_MESSAGE_SCHEMA_FINGERPRINT } from '../world/private-message-storage.js';

/** G is reserved first; G1 owns the sole target transaction. Failure never releases holds or intent. */
export function initializePrivateMessageJournal(options: {
  catalog: ExecutionStoreCatalog; origin: string; maintenance: MaintenanceSession;
  failpoint?: (stage: 'reserved' | 'prepared' | 'verified') => void;
}): ReturnType<typeof preparePrivateMessageJournal> {
  const {catalog, maintenance} = options;
  if (!(maintenance instanceof MaintenanceSession) || resolve(catalog.options.paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('PRIVATE_MESSAGE_ROOT_MISMATCH');
  maintenance.assertCurrent();
  const origin = normalizeHouseOrigin(options.origin), partition = catalog.open(origin, {maintenance});
  catalog.reservePrivateMessageJournal(origin, partition, maintenance);
  const before = Object.fromEntries(PRIVATE_MESSAGE_FEATURE_TABLES.map(table => [table,
    partition.db.queryOne("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [table])
      ? snapshotActionJournalTableOriginalContent(partition.db, table) : null]));
  options.failpoint?.('reserved');
  catalog.assertPrivateMessagePreparationCurrent(origin, partition, maintenance);
  const report = preparePrivateMessageJournal({executionDb: partition.db, expectedSchemaFingerprint: PRIVATE_MESSAGE_SCHEMA_FINGERPRINT});
  options.failpoint?.('prepared');
  catalog.assertPrivateMessagePreparationCurrent(origin, partition, maintenance);
  const observed = assertPrivateMessageJournalSchema(partition.db), after = snapshotPrivateMessageOriginalContent(partition.db);
  for (const table of PRIVATE_MESSAGE_FEATURE_TABLES) {
    if (!after[table] || (before[table] ? canonicalActionJson(before[table]) !== canonicalActionJson(after[table]) : after[table]!.rowCount !== '0')) throw new Error('PRIVATE_MESSAGE_ORIGINAL_CONTENT_CHANGED');
  }
  const originalContent = Object.fromEntries(PRIVATE_MESSAGE_FEATURE_TABLES.map(table => [table, {before: before[table], after: after[table]}]));
  const createdTables = PRIVATE_MESSAGE_FEATURE_TABLES.filter(table => before[table] === null).sort();
  const preservedRowCounts = Object.fromEntries(PRIVATE_MESSAGE_FEATURE_TABLES.filter(table => before[table]).map(table => [table, before[table]!.rowCount]));
  if (report.featureProfile !== PRIVATE_MESSAGE_FEATURE_PROFILE || report.schemaFingerprint !== PRIVATE_MESSAGE_SCHEMA_FINGERPRINT
    || observed.schemaFingerprint !== PRIVATE_MESSAGE_SCHEMA_FINGERPRINT
    || canonicalActionJson(report.originalContent) !== canonicalActionJson(originalContent)
    || canonicalActionJson([...report.createdTables].sort()) !== canonicalActionJson(createdTables)
    || canonicalActionJson(report.preservedRowCounts) !== canonicalActionJson(preservedRowCounts)) throw new Error('PRIVATE_MESSAGE_PREPARATION_MISMATCH');
  options.failpoint?.('verified');
  if (canonicalActionJson(snapshotPrivateMessageOriginalContent(partition.db)) !== canonicalActionJson(after)) throw new Error('PRIVATE_MESSAGE_ORIGINAL_CONTENT_CHANGED');
  catalog.certifyPrivateMessageJournal(origin, partition, maintenance);
  return report;
}

/** Separate explicit transition after the old action feature is complete. G1 owns its sole H31 transaction. */
export function initializeNativeActionJournal(options: {
  catalog: ExecutionStoreCatalog; origin: string; maintenance: MaintenanceSession;
  failpoint?: (stage: 'reserved' | 'prepared' | 'verified') => void;
}): ReturnType<typeof prepareNativeActionJournal> {
  const { catalog, maintenance } = options;
  if (resolve(catalog.options.paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('NATIVE_ACTION_ROOT_MISMATCH');
  maintenance.assertCurrent();
  const origin = normalizeHouseOrigin(options.origin), partition = catalog.open(origin, {maintenance});
  const expectedPartition = { origin, actorId: catalog.options.actorId, storeId: partition.storeId, layoutVersion: 1 as const };
  assertActionReceiptJournalSchema(partition.db, expectedPartition);
  const before = snapshotNativeActionOriginalContent(partition.db), oldBefore = snapshotActionReceiptOriginalContent(partition.db);
  catalog.reserveNativeActionJournal(origin, partition, maintenance);
  options.failpoint?.('reserved');
  catalog.assertNativeActionPreparationCurrent(origin, partition, maintenance);
  const report = prepareNativeActionJournal({ executionDb: partition.db, expectedPartition, expectedSchemaFingerprint: NATIVE_ACTION_SCHEMA_FINGERPRINT });
  options.failpoint?.('prepared');
  maintenance.assertCurrent(); catalog.verifySelected(origin, partition);
  const observed = assertNativeActionJournalSchema(partition.db, expectedPartition);
  const after = snapshotNativeActionOriginalContent(partition.db), oldAfter = snapshotActionReceiptOriginalContent(partition.db);
  const pairs = (names: readonly string[], left: typeof before, right: typeof before) => Object.fromEntries(names.map(table => [table, { before: left[table], after: right[table] }]));
  const originalContent = pairs(NATIVE_ACTION_FEATURE_TABLES, before, after);
  const oldActionOriginalContent = pairs(ACTION_RECEIPT_FEATURE_TABLES, oldBefore, oldAfter);
  for (const table of NATIVE_ACTION_FEATURE_TABLES) {
    if (!after[table] || (before[table] ? canonicalActionJson(before[table]) !== canonicalActionJson(after[table]) : after[table]!.rowCount !== '0'))
      throw new Error('NATIVE_ACTION_ORIGINAL_CONTENT_CHANGED');
  }
  if (canonicalActionJson(oldBefore) !== canonicalActionJson(oldAfter)) throw new Error('ACTION_ORIGINAL_CONTENT_CHANGED');
  const createdTables = NATIVE_ACTION_FEATURE_TABLES.filter(table => before[table] === null).sort();
  const preservedLegacyCounts = Object.fromEntries(NATIVE_ACTION_FEATURE_TABLES.filter(table => before[table]).map(table => [table, before[table]!.rowCount]));
  if (report.featureProfile !== NATIVE_ACTION_FEATURE_PROFILE || report.schemaFingerprint !== NATIVE_ACTION_SCHEMA_FINGERPRINT
    || observed.schemaFingerprint !== NATIVE_ACTION_SCHEMA_FINGERPRINT
    || canonicalActionJson(report.partition) !== canonicalActionJson(observed.partition)
    || canonicalActionJson([...report.createdTables].sort()) !== canonicalActionJson(createdTables)
    || canonicalActionJson(report.addedColumns) !== '[]'
    || canonicalActionJson(report.preservedLegacyCounts) !== canonicalActionJson(preservedLegacyCounts)
    || canonicalActionJson(report.originalContent) !== canonicalActionJson(originalContent)
    || canonicalActionJson(report.oldActionOriginalContent) !== canonicalActionJson(oldActionOriginalContent)) throw new Error('NATIVE_ACTION_PREPARATION_MISMATCH');
  maintenance.assertCurrent(); options.failpoint?.('verified'); return report;
}

/** Explicit offline preparation preserves all original bindings and leaves every hold intact. */
export function initializeActionReceiptJournal(options: {
  catalog: ExecutionStoreCatalog; origin: string; maintenance: MaintenanceSession;
  failpoint?: (stage: 'reserved' | 'prepared' | 'verified') => void;
}): ReturnType<typeof prepareActionReceiptJournal> {
  const { catalog, maintenance } = options;
  if (resolve(catalog.options.paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('ACTION_RECEIPT_ROOT_MISMATCH');
  maintenance.assertCurrent();
  const origin = normalizeHouseOrigin(options.origin), partition = catalog.open(origin, {maintenance});
  const expectedPartition = { origin, actorId: catalog.options.actorId, storeId: partition.storeId, layoutVersion: 1 as const };
  // Independent actual reads: the prepare report cannot attest its own preservation.
  const before = snapshotActionReceiptOriginalContent(partition.db);
  catalog.reserveActionReceiptJournal(origin, partition, maintenance);
  options.failpoint?.('reserved');
  catalog.assertActionReceiptPreparationCurrent(origin, partition, maintenance);
  // No wrapping H31 transaction: G1 owns the one atomic schema preparation.
  const report = prepareActionReceiptJournal({ executionDb: partition.db, expectedPartition,
    expectedSchemaFingerprint: ACTION_RECEIPT_SCHEMA_FINGERPRINT });
  options.failpoint?.('prepared');
  maintenance.assertCurrent();
  catalog.verifySelected(origin, partition);
  const observed = assertActionReceiptJournalSchema(partition.db, expectedPartition);
  const after = snapshotActionReceiptOriginalContent(partition.db, before);
  const fullAfter = snapshotActionReceiptOriginalContent(partition.db);
  const originalContent = Object.fromEntries(ACTION_RECEIPT_FEATURE_TABLES.map(table => [table, { before: before[table], after: after[table] }]));
  const createdTables = ACTION_RECEIPT_FEATURE_TABLES.filter(table => before[table] === null).sort();
  const addedColumns = ACTION_RECEIPT_FEATURE_TABLES.flatMap(table => before[table]
    ? fullAfter[table]!.columns.filter(column => !before[table]!.columns.includes(column)).map(column => ({ table, column })) : []);
  const preservedLegacyCounts = Object.fromEntries(ACTION_RECEIPT_FEATURE_TABLES.filter(table => before[table]).map(table => [table, before[table]!.rowCount]));
  for (const table of ACTION_RECEIPT_FEATURE_TABLES) {
    if (!after[table] || (before[table] ? canonicalActionJson(before[table]) !== canonicalActionJson(after[table]) : after[table]!.rowCount !== '0'))
      throw new Error('ACTION_ORIGINAL_CONTENT_CHANGED');
  }
  const sortedAdditions = (values: {table: string; column: string}[]) => [...values].sort((a, b) =>
    a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  if (report.featureProfile !== ACTION_RECEIPT_FEATURE_PROFILE || report.schemaFingerprint !== ACTION_RECEIPT_SCHEMA_FINGERPRINT
    || canonicalActionJson(report.partition) !== canonicalActionJson(observed.partition)
    || canonicalActionJson([...report.createdTables].sort()) !== canonicalActionJson(createdTables)
    || canonicalActionJson(sortedAdditions(report.addedColumns)) !== canonicalActionJson(sortedAdditions(addedColumns))
    || canonicalActionJson(report.preservedLegacyCounts) !== canonicalActionJson(preservedLegacyCounts)
    || canonicalActionJson(report.originalContent) !== canonicalActionJson(originalContent)) throw new Error('ACTION_RECEIPT_PREPARATION_MISMATCH');
  maintenance.assertCurrent();
  options.failpoint?.('verified');
  return report;
}

interface MigrationRecord {
  version: 1; origin: string; actorId: string; storeId: string;
  source: string; sourceFingerprint: string; backupDirectory: string;
  durable: string[]; cache: string[]; fingerprints: Record<string, string>;
  state: 'prepared' | 'verified' | 'published';
}
function checkDatabase(db: LocalHostDb): void {
  if (db.queryOne<{integrity_check: string}>('PRAGMA integrity_check')?.integrity_check !== 'ok') throw new Error('MIGRATION_INTEGRITY_FAILURE');
  if (db.queryAll('PRAGMA foreign_key_check').length) throw new Error('MIGRATION_FOREIGN_KEY_FAILURE');
}
function verifyTables(db: LocalHostDb, names: string[], fingerprints: Record<string, string>): void {
  checkDatabase(db);
  for (const name of names) if (tableFingerprint(db, name) !== fingerprints[name]) throw new Error(`MIGRATION_CONTENT_MISMATCH: ${name}`);
}
function capturePublicPreparation(catalog: ExecutionStoreCatalog, origin: string, assertCurrent: () => void, configuredPin?: string) {
  assertCurrent();
  const view = readHouseCapabilityView(catalog.options.db, origin), capability = view?.publicStreamCapability;
  if (!view || view.publicStream.validation !== 'valid' || !capability) throw new Error('PUBLIC_CAPABILITY_UNAVAILABLE');
  const currentPin = () => normalizeAckKeyHex(configuredPin || readParticipation(catalog.options.db, origin)?.ack_key_hex || '');
  const pin = currentPin();
  if (!pin || pin !== normalizeAckKeyHex(capability.house.houseKey)) throw new Error('PUBLIC_PIN_MISMATCH');
  const producerPolicy = publicProducerPolicy(view);
  const identity = JSON.stringify([capability, producerPolicy]);
  return { capability, producerPolicy, assertCurrent: () => {
    assertCurrent();
    const current = readHouseCapabilityView(catalog.options.db, origin);
    if (currentPin() !== pin || current?.publicStream.validation !== 'valid'
      || JSON.stringify([current.publicStreamCapability, publicProducerPolicy(current)]) !== identity) throw new Error('PUBLIC_MAINTENANCE_CAPTURE_CHANGED');
  } };
}

/** The existing checked preparation: offline reservation or a factory-born live partition.
 * The live path consumes provenance in its target transaction; it never repairs old storage.
 * G reservation survives target rollback; neither path releases storage holds. */
export function initializePublicStreamJournal(options: {
  catalog: ExecutionStoreCatalog; origin: string; maintenance?: MaintenanceSession;
  activation?: { readonly partition: ExecutionPartition; assertCurrent(): void };
  configuredPin?: string; failpoint?: (stage: 'reserved' | 'prepared' | 'verified') => void;
}): ReturnType<typeof preparePublicStreamJournal> {
  const { catalog, maintenance, activation } = options;
  if (!!maintenance === !!activation) throw new Error('PUBLIC_PREPARATION_AUTHORITY_REQUIRED');
  if (maintenance && (!(maintenance instanceof MaintenanceSession)
    || resolve(catalog.options.paths.rootDir()) !== resolve(maintenance.paths.rootDir()))) throw new Error('PUBLIC_JOURNAL_ROOT_MISMATCH');
  const origin = normalizeHouseOrigin(options.origin);
  const assertCurrent = () => {
    if (maintenance) maintenance.assertCurrent();
    else { activation!.assertCurrent(); catalog.verifySelected(origin, activation!.partition); }
  };
  const captured = capturePublicPreparation(catalog, origin, assertCurrent, options.configuredPin);
  const partition = activation?.partition ?? catalog.open(origin, {maintenance});
  const { capability, producerPolicy } = captured;
  const selection = { fullPublic: true, scopes: [...capability.publicStream.initial_public_scopes].sort() };
  const reservation = maintenance ? catalog.reservePublicJournal(origin, partition, maintenance)
    : (catalog.assertFreshPublicPreparation(origin, partition), {upgradeLegacyLogProfiles:false});
  const bindingId = JSON.stringify([origin, capability.house.houseKey, capability.house.incarnation]);
  type PreparedBinding = {origin: string; house_key: string; house_incarnation: string; active_log: string; capability_revision: string; selection_json: string};
  const previous = partition.db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_public_bindings_v1'")
    ? partition.db.queryOne<PreparedBinding>('SELECT * FROM world_public_bindings_v1 WHERE binding_id=?', [bindingId]) : null;
  const prepare = () => {
    options.failpoint?.('reserved');
    captured.assertCurrent();
    // G1 owns exactly one H31 transaction, including DDL and checked import.
    const result = preparePublicStreamJournal({ executionDb: partition.db, capability, producerPolicy, selection,
      upgradeLegacyLogProfiles: reservation.upgradeLegacyLogProfiles, consumerContracts: [], approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST });
    options.failpoint?.('prepared');
    captured.assertCurrent();
    catalog.verifySelected(origin, partition);
    verifyPublicStreamJournalSchema(partition.db);
    if (result.bindingId !== bindingId || result.mappingDigest !== EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST
      || JSON.stringify([...result.tables].sort()) !== JSON.stringify([...PUBLIC_JOURNAL_TABLES].sort())) throw new Error('PUBLIC_JOURNAL_PREPARATION_MISMATCH');
    const binding = partition.db.queryOne<PreparedBinding>(
      'SELECT * FROM world_public_bindings_v1 WHERE binding_id=?', [result.bindingId]);
    if (!binding || binding.origin !== origin || binding.house_key !== capability.house.houseKey
      || binding.house_incarnation !== capability.house.incarnation
      || binding.active_log !== (previous?.active_log ?? capability.publicStream.log_incarnation)
      || binding.capability_revision !== (previous?.capability_revision ?? capability.capabilityRevision)
      || binding.selection_json !== (previous?.selection_json ?? JSON.stringify(selection))) throw new Error('PUBLIC_JOURNAL_PREPARATION_BINDING_MISMATCH');
    // Preparation preserves an older runtime selection. New captured lanes are
    // prepared independently; only a subsequently admitted receiver activates them.
    for (const lane of [{ lane: 'public', scope: '' }, ...selection.scopes.map(scope => ({ lane: 'scope', scope }))]) {
      const cursor = partition.db.queryOne<{after_seq: string; stale: number}>(
        'SELECT after_seq,stale FROM world_public_cursors_v1 WHERE binding_id=? AND log_incarnation=? AND lane=? AND scope_id=?',
        [bindingId, capability.publicStream.log_incarnation, lane.lane, lane.scope]);
      if (!cursor || typeof cursor.after_seq !== 'string' || !/^(0|[1-9][0-9]*)$/.test(cursor.after_seq) || BigInt(cursor.after_seq) > 18_446_744_073_709_551_615n
        || ![0, 1].includes(cursor.stale)) throw new Error('PUBLIC_JOURNAL_PREPARATION_CURSOR_INVALID');
    }
    options.failpoint?.('verified');
    return result;
  };
  if (!activation) return prepare();
  return partition.db.transaction(tx => {
    captured.assertCurrent();
    catalog.assertFreshPublicPreparation(origin, partition);
    const result = prepare();
    tx.execute("UPDATE execution_partition_identity_v1 SET public_initialization='prepared-public-v1' WHERE singleton=1 AND public_initialization='fresh-public-v1'");
    captured.assertCurrent();
    return result;
  });
}

/** Offline only. Original files are retained; the catalog selects both verified replacement handles. */
export async function migrateExecutionStore(options: {
  catalog: ExecutionStoreCatalog; origin: string; maintenance: MaintenanceSession;
  installationId: string | null; codeVersion: string;
  failpoint?: (stage: string) => void;
}): Promise<{storeId: string; source: string; recordPath: string}> {
  const {catalog, maintenance, failpoint} = options;
  const {db, paths, actorId} = catalog.options;
  const origin = normalizeHouseOrigin(options.origin);
  if (resolve(paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('MIGRATION_ROOT_MISMATCH');
  maintenance.assertCurrent();
  const slug = hostDbSlug(origin);
  // Slugs are lossy. A caller-provided URL alone is not proof of an old file's owner.
  const binding = db.queryOne<{origin: string}>('SELECT origin FROM house_origin_bindings WHERE slug=?', [slug]);
  if (binding?.origin !== origin) throw new Error('MIGRATION_ORIGIN_BINDING_REQUIRED');
  const selected = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
  const recordDir = join(paths.executionDir(), 'migrations');
  const recordPath = join(recordDir, `${slug}.json`);
  let record: MigrationRecord;
  if (existsSync(recordPath)) {
    record = JSON.parse(readFileSync(recordPath, 'utf8')) as MigrationRecord;
    if (record.version !== 1 || record.origin !== origin || record.actorId !== actorId) throw new Error('MIGRATION_RECORD_MISMATCH');
  } else {
    if (selected) throw new Error('MIGRATION_ALREADY_SELECTED');
    const source = paths.lorehouseDb(slug);
    const probe = new LocalHostDb(source, {readOnly: true});
    let classified: {durable: string[]; cache: string[]};
    let fingerprints: Record<string, string>;
    try {
      classified = inspectLegacySchema(probe);
      if (!classified.durable.length) throw new Error('MIGRATION_NOT_REQUIRED');
      // Opaque code-bearing schema and cross-cache triggers need explicit review, not silent copying.
      if (probe.queryAll("SELECT name FROM sqlite_master WHERE type IN ('view','trigger')").length) throw new Error('EXECUTION_SCHEMA_UNKNOWN');
      if (classified.durable.includes('world_scoped_bindings') && probe.queryAll<{origin: string}>('SELECT DISTINCT origin FROM world_scoped_bindings').some(row => row.origin !== origin)) throw new Error('MIGRATION_ORIGIN_MISMATCH');
      checkDatabase(probe);
      fingerprints = Object.fromEntries([...classified.durable, ...classified.cache].map(name => [name, tableFingerprint(probe, name)]));
    } finally { probe.close(); }
    const backup = await createStorageBackup({paths, actorId, installationId: options.installationId, codeVersion: options.codeVersion, maintenance});
    failpoint?.('after-backup');
    maintenance.assertCurrent();
    const sourceImage = join(backup.directory, 'files', 'data', 'lorehouses', `${slug}.db`);
    record = {version: 1, origin, actorId, storeId: randomBytes(16).toString('hex'), source,
      sourceFingerprint: fileSha256(sourceImage), backupDirectory: backup.directory,
      ...classified, fingerprints, state: 'prepared'};
    mkdirSync(recordDir, {recursive: true, mode: 0o700});
    publishStorageJson(recordPath, record);
  }
  failpoint?.('prepared');
  maintenance.assertCurrent();
  const backup = verifyStorageBackup(record.backupDirectory);
  if (backup.consistency !== 'quiescent-set' || backup.actorId !== actorId) throw new Error('MIGRATION_BACKUP_MISMATCH');
  const sourceImage = join(record.backupDirectory, 'files', 'data', 'lorehouses', `${slug}.db`);
  if (record.source !== paths.lorehouseDb(slug) || fileSha256(sourceImage) !== record.sourceFingerprint) throw new Error('MIGRATION_SOURCE_MISMATCH');
  const original = new LocalHostDb(record.source, {readOnly: true});
  try {
    inspectLegacySchema(original);
    verifyTables(original, [...record.durable, ...record.cache], record.fingerprints);
  } finally { original.close(); }
  const targetPath = paths.executionDb(record.storeId);
  const cachePath = paths.worldFeedProjectionDb(slug);
  const prepareCopy = async (destination: string, remove: readonly string[], keep: string[], durable: boolean): Promise<void> => {
    if (existsSync(destination)) {
      const probe = new LocalHostDb(destination, {readOnly: true});
      try {
        const tables = probe.queryAll<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row => row.name);
        const originalTables = new Set([...record.durable, ...record.cache, '_READ_THIS_FIRST']);
        const finalTables = new Set([...keep, '_READ_THIS_FIRST', ...(durable ? ['execution_partition_identity_v1'] : [])]);
        const isOriginalCopy = tables.every(table => originalTables.has(table))
          && [...record.durable, ...record.cache].every(table => tables.includes(table) && tableFingerprint(probe, table) === record.fingerprints[table]);
        const isFinalCopy = tables.every(table => finalTables.has(table))
          && keep.every(table => tables.includes(table) && tableFingerprint(probe, table) === record.fingerprints[table]);
        if (!isOriginalCopy && !isFinalCopy) throw new Error('MIGRATION_EXISTING_TARGET_UNVERIFIED');
        if (isFinalCopy && durable) {
          const identity = probe.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_partition_identity_v1 WHERE singleton=1');
          if (!identity || identity.actor_id !== actorId || identity.origin !== origin || identity.store_id !== record.storeId) throw new Error('MIGRATION_TARGET_BINDING_MISMATCH');
        }
      } finally {probe.close();}
    } else {
      const snapshot = new LocalHostDb(sourceImage, {readOnly: true});
      try { await snapshot.snapshotTo(destination); } finally { snapshot.close(); }
      failpoint?.(durable ? 'target-copied' : 'cache-copied');
    }
    const target = new LocalHostDb(destination);
    try {
      target.execute('PRAGMA foreign_keys = OFF');
      target.transaction(tx => {
        for (const name of remove) tx.execute(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(name)}`);
        if (durable) {
          tx.execute(`CREATE TABLE IF NOT EXISTS execution_partition_identity_v1 (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1), actor_id TEXT NOT NULL,
            origin TEXT NOT NULL, store_id TEXT NOT NULL, layout_version INTEGER NOT NULL)`);
          const identity = tx.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_partition_identity_v1 WHERE singleton=1');
          if (identity && (identity.origin !== origin || identity.actor_id !== actorId || identity.store_id !== record.storeId || identity.layout_version !== EXECUTION_LAYOUT_VERSION)) throw new Error('MIGRATION_TARGET_BINDING_MISMATCH');
          tx.execute('INSERT OR IGNORE INTO execution_partition_identity_v1 VALUES(1,?,?,?,?)', [actorId, origin, record.storeId, EXECUTION_LAYOUT_VERSION]);
        }
      });
      target.execute('PRAGMA foreign_keys = ON');
      const allowed = new Set([...keep, '_READ_THIS_FIRST', ...(durable ? ['execution_partition_identity_v1'] : [])]);
      if (target.queryAll<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").some(row => !allowed.has(row.name))) throw new Error('EXECUTION_SCHEMA_UNKNOWN');
      verifyTables(target, keep, record.fingerprints);
    } finally { target.close(); }
  };
  if (selected && selected.store_id !== record.storeId) throw new Error('MIGRATION_CATALOG_MISMATCH');
  if (!selected) {
    await prepareCopy(targetPath, CACHE_TABLES, record.durable, true);
    failpoint?.('target-verified');
    await prepareCopy(cachePath, record.durable, record.cache, false);
    failpoint?.('cache-verified');
    record.state = 'verified'; publishStorageJson(recordPath, record);
    failpoint?.('before-publish');
    maintenance.assertCurrent();
    db.transaction(tx => {
      if (tx.queryOne('SELECT origin FROM execution_store_catalog_v1 WHERE origin=?', [origin])) throw new Error('MIGRATION_CATALOG_CHANGED');
      tx.execute('INSERT INTO execution_store_catalog_v1(origin,actor_id,store_id,layout_version,source_path,source_fingerprint,required_tables) VALUES(?,?,?,?,?,?,?)',
        [origin, actorId, record.storeId, EXECUTION_LAYOUT_VERSION, record.source, record.sourceFingerprint, JSON.stringify(record.durable)]);
    });
  }
  failpoint?.('after-publish');
  // Selected files are checked on restart; a post-publish retry never overwrites newer selected state.
  const target = new LocalHostDb(targetPath, {readOnly: true});
  try { checkDatabase(target); } finally { target.close(); }
  chmodSync(record.source, 0o400);
  record.state = 'published'; publishStorageJson(recordPath, record);
  return {storeId: record.storeId, source: record.source, recordPath};
}

/** Bounded cache operation, intentionally no directory deletion or generic SQL reset. */
export async function clearWorldFeedProjection(options: {
  catalog: ExecutionStoreCatalog; origin: string; maintenance: MaintenanceSession;
  configuredPin?: string;
  mode?: 'public-v1' | 'legacy';
}): Promise<void> {
  const {catalog, maintenance} = options;
  const {db, paths} = catalog.options;
  const origin = normalizeHouseOrigin(options.origin);
  if (resolve(paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('CACHE_ROOT_MISMATCH');
  maintenance.assertCurrent();
  if (!db.queryOne('SELECT origin FROM execution_store_catalog_v1 WHERE origin=?', [origin])) throw new Error('CACHE_LAYOUT_NOT_SELECTED');
  const partition = catalog.open(origin, {maintenance});
  // Every partition the factory builds carries the public tables, so their mere
  // presence no longer distinguishes a subscribed house from a joined one. The
  // BINDING is the subscription: only a bound journal may not be rebuilt
  // without an explicit choice. An unbound one is told 'legacy' outright, which
  // is exactly the source this call read before the tables were provisioned at
  // creation — it is not a new rebuild mode and reaches no public row.
  const hasPublicTables = !!partition.db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_public_bindings_v1'");
  if (hasPublicTables && !options.mode && partition.db.queryOne('SELECT 1 FROM world_public_bindings_v1')) throw new Error('PUBLIC_REBUILD_MODE_REQUIRED');
  const publicRebuild = options.mode === 'public-v1'
    ? { mode: 'public-v1' as const, ...capturePublicPreparation(catalog, origin, () => maintenance.assertCurrent(), options.configuredPin) }
    : options.mode === 'legacy' || hasPublicTables ? { mode: 'legacy' as const } : undefined;
  const slug = hostDbSlug(origin);
  const path = existsSync(paths.worldFeedProjectionDb(slug)) ? paths.worldFeedProjectionDb(slug) : paths.lorehouseDb(slug);
  const probe = new LocalHostDb(path, {readOnly: true});
  try { if (inspectLegacySchema(probe).durable.length) throw new Error('CACHE_PROTECTED_MIXED_SOURCE'); }
  finally {probe.close();}
  const projection = new LocalHostDb(path);
  try {
    const cache = new WorldFeedCache({db: projection});
    await cache.start();
    maintenance.assertCurrent();
    projection.transaction(tx => {
      tx.execute('DELETE FROM world_feed');
      tx.execute('DELETE FROM world_feed_cursor');
      rebuildPublicWorldProjection(partition.db, cache, publicRebuild);
    });
  } finally {projection.close();}
}
