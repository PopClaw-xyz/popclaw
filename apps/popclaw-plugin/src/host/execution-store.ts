import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HostDb } from './host-db.js';
import { LocalHostDb } from './local-host-db.js';
import type { PopclawPaths } from './popclaw-paths.js';
import { DURABLE_TABLES, PUBLIC_JOURNAL_TABLES, ACTION_RECEIPT_FEATURE_TABLES, NATIVE_ACTION_FEATURE_TABLES, EXECUTION_LAYOUT_VERSION, inspectLegacySchema } from './execution-store-schema.js';
import { assertActionReceiptJournalSchema } from '../world/action-receipt-journal.js';
import { assertNativeActionJournalSchema } from '../world/native-action-journal.js';
import { verifyLegacyPublicStreamJournalSchema, verifyPublicStreamJournalSchema } from '../world/scoped-stream-journal.js';
import { assertPrivateMessageJournalSchema, PRIVATE_MESSAGE_FEATURE_TABLES, PRIVATE_MESSAGE_FEATURE_PROFILE, PRIVATE_MESSAGE_SCHEMA_FINGERPRINT } from '../world/private-message-storage.js';
import { MaintenanceSession, readStorageControl } from './storage-maintenance.js';
import { assertFreshPartitionAdmissible, buildFreshExecutionPartition, FRESH_PARTITION_REQUIRED_TABLES } from './execution-partition-factory.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { normalizeHouseOrigin } from '../runtime/house-lifecycle/control-client.js';

export interface ExecutionPartition { readonly db: LocalHostDb; readonly path: string; readonly storeId: string }
export interface PrivateMessageReadCapture { readonly executionDb: HostDb; assertCurrent(): void; close(): void }
export interface ExecutionCatalogRow { origin: string; actor_id: string; store_id: string; layout_version: number; required_tables?: string; private_message_feature?: string | null }

/** Every feature whose reservation must come from a controlled preparation. */
const PROTECTED_FEATURE_TABLES = new Set<string>([...ACTION_RECEIPT_FEATURE_TABLES,
  ...NATIVE_ACTION_FEATURE_TABLES, ...PUBLIC_JOURNAL_TABLES, ...PRIVATE_MESSAGE_FEATURE_TABLES]);

/** Separate from historical required-table inventory; only explicit preparation writes this marker. */
export function privateMessageFeatureCertification(state: 'reserved' | 'certified'): string {
  return JSON.stringify({profile: PRIVATE_MESSAGE_FEATURE_PROFILE, schemaFingerprint: PRIVATE_MESSAGE_SCHEMA_FINGERPRINT, state});
}
/** The marker column is historically absent; adding it carries no certification. */
function addPrivateMessageFeatureColumn(tx: HostDb): void {
  if (!tx.queryAll<{name: string}>('PRAGMA table_info(execution_store_catalog_v1)').some(column => column.name === 'private_message_feature'))
    tx.execute('ALTER TABLE execution_store_catalog_v1 ADD COLUMN private_message_feature TEXT');
}
function assertPrivateCertification(probe: HostDb, row: ExecutionCatalogRow): void {
  if (row.private_message_feature == null) return;
  if (row.private_message_feature !== privateMessageFeatureCertification('certified')) throw new Error('PRIVATE_MESSAGE_RECOVERY_REQUIRED');
  const required: unknown = JSON.parse(row.required_tables ?? '[]');
  if (!Array.isArray(required) || !PRIVATE_MESSAGE_FEATURE_TABLES.every(name => required.includes(name))) throw new Error('PRIVATE_MESSAGE_PROTECTION_INCOMPLETE');
  assertPrivateMessageJournalSchema(probe);
}

/** Local address catalog. A missing selected file must never become a new empty ledger. */
export class ExecutionStoreCatalog {
  private readonly opened = new Map<string, ExecutionPartition>();
  private readonly privateReadClosers = new Set<() => void>();
  private closed = false;
  constructor(readonly options: { db: HostDb; paths: PopclawPaths; actorId: string }) {
    if (!options.actorId) throw new Error('EXECUTION_ACTOR_REQUIRED');
    options.db.transaction(db => {
      db.execute(`CREATE TABLE IF NOT EXISTS execution_store_identity_v1 (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), actor_id TEXT NOT NULL, layout_version INTEGER NOT NULL)`);
      db.execute('INSERT OR IGNORE INTO execution_store_identity_v1 VALUES(1,?,?)', [options.actorId, EXECUTION_LAYOUT_VERSION]);
      const identity = db.queryOne<{actor_id: string; layout_version: number}>('SELECT * FROM execution_store_identity_v1 WHERE singleton=1')!;
      if (identity.actor_id !== options.actorId) throw new Error('EXECUTION_ACTOR_MISMATCH');
      if (identity.layout_version !== EXECUTION_LAYOUT_VERSION) throw new Error('EXECUTION_LAYOUT_UNSUPPORTED');
      db.execute(`CREATE TABLE IF NOT EXISTS execution_store_catalog_v1 (
        origin TEXT PRIMARY KEY, actor_id TEXT NOT NULL, store_id TEXT NOT NULL UNIQUE,
        layout_version INTEGER NOT NULL, source_path TEXT, source_fingerprint TEXT, required_tables TEXT NOT NULL DEFAULT '[]')`);
    });
  }
  /** A brand-new partition is built and verified before it is published; the
   * optional maintenance token keeps the offline preparation entrance open on
   * a root whose storage paths are deliberately held. */
  open(input: string, options: { maintenance?: MaintenanceSession } = {}): ExecutionPartition {
    if (this.closed) throw new Error('EXECUTION_CATALOG_CLOSED');
    const origin = normalizeHouseOrigin(input);
    const existing = this.opened.get(origin);
    if (existing) {
      this.verifySelected(origin, existing);
      return existing;
    }
    const { db, paths, actorId } = this.options;
    // BEGIN IMMEDIATE: the whole eligibility decision and the publication share
    // the one global write lock, so a second root reads a published result
    // instead of minting a rival partition for the same origin.
    const partition = db.transaction(tx => {
      if (tx.queryAll<{origin:string}>('SELECT origin FROM execution_store_catalog_v1').some(row => row.origin !== origin && hostDbSlug(row.origin) === hostDbSlug(origin))) throw new Error('EXECUTION_ORIGIN_COLLISION');
      const row = tx.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
      if (row) return this.openSelected(row);
      const legacyPath = paths.lorehouseDb(hostDbSlug(origin));
      if (existsSync(legacyPath)) {
        const legacy = new LocalHostDb(legacyPath, { readOnly: true });
        try {
          if (inspectLegacySchema(legacy).durable.length) throw new Error('EXECUTION_MIGRATION_REQUIRED');
        } finally { legacy.close(); }
      }
      assertFreshPartitionAdmissible(tx, paths, options.maintenance);
      const storeId = randomBytes(16).toString('hex');
      const required = JSON.stringify([...FRESH_PARTITION_REQUIRED_TABLES]);
      // The private-message credential is published with the very first row of a
      // partition this call just built, never added to one that already exists.
      const privateMessageFeature = privateMessageFeatureCertification('certified');
      const { db: target, path } = buildFreshExecutionPartition({ paths, actorId, origin, storeId });
      try {
        // Independent verification of the built result against the COMPLETE
        // reservation, then publication. H is durable first; G follows. The two
        // are not one atomic commit.
        verifyExecutionPartition(target, { origin, actor_id: actorId, store_id: storeId, layout_version: EXECUTION_LAYOUT_VERSION,
          required_tables: required, private_message_feature: privateMessageFeature }, actorId);
        addPrivateMessageFeatureColumn(tx);
        tx.execute('INSERT INTO execution_store_catalog_v1(origin,actor_id,store_id,layout_version,required_tables,private_message_feature) VALUES(?,?,?,?,?,?)',
          [origin, actorId, storeId, EXECUTION_LAYOUT_VERSION, required, privateMessageFeature]);
        return { db: target, path, storeId };
      } catch (error) { target.close(); throw error; }
    });
    this.opened.set(origin, partition);
    return partition;
  }
  /** Read-only validation also covers handles opened before a protected reservation. */
  verifySelected(input: string, partition: ExecutionPartition): void {
    if (this.closed) throw new Error('EXECUTION_CATALOG_CLOSED');
    const origin = normalizeHouseOrigin(input);
    const { db, paths, actorId } = this.options;
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
    if (!row || row.actor_id !== actorId || row.layout_version !== EXECUTION_LAYOUT_VERSION
      || row.store_id !== partition.storeId || partition.path !== paths.executionDb(row.store_id)
      || this.opened.get(origin) !== partition) throw new Error('PUBLIC_JOURNAL_PARTITION_MISMATCH');
    if (!existsSync(partition.path)) throw new Error('EXECUTION_PARTITION_MISSING');
    verifyExecutionPartition(partition.db, row, actorId);
  }

  /** Cheap synchronous receive fence after full startup verification. File
   * presence stays in the host layer; no integrity scan runs per frame. */
  isPublicJournalCurrent(input: string, partition: ExecutionPartition): boolean {
    if (this.closed) return false;
    const origin = normalizeHouseOrigin(input), { db, paths, actorId } = this.options;
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
    if (!row || row.actor_id !== actorId || row.layout_version !== EXECUTION_LAYOUT_VERSION || row.store_id !== partition.storeId
      || this.opened.get(origin) !== partition || partition.path !== paths.executionDb(row.store_id) || !existsSync(partition.path)) return false;
    const identity = partition.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_partition_identity_v1 WHERE singleton=1');
    if (!identity || identity.actor_id !== actorId || identity.origin !== origin || identity.store_id !== row.store_id
      || identity.layout_version !== row.layout_version) return false;
    const present = new Set(partition.db.queryAll<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(row => row.name));
    const allowed = new Set<string>([...DURABLE_TABLES, '_READ_THIS_FIRST', 'execution_partition_identity_v1']);
    const required: unknown = JSON.parse(row.required_tables ?? '[]');
    return Array.isArray(required) && required.every(name => typeof name === 'string' && present.has(name))
      && [...present].every(name => allowed.has(name)) && PUBLIC_JOURNAL_TABLES.every(name => required.includes(name) && present.has(name));
  }

  /** Opens only the already-certified selected database. It never mounts a
   * writable store, creates storage, or borrows the resident consumer handle. */
  capturePrivateMessageRead(input: string): PrivateMessageReadCapture {
    if (this.closed) throw new Error('EXECUTION_CATALOG_CLOSED');
    const origin = normalizeHouseOrigin(input), {db, paths, actorId} = this.options;
    const readCatalog = (): ExecutionCatalogRow => {
      if (this.closed) throw new Error('EXECUTION_CATALOG_CLOSED');
      const identity = db.queryOne<{actor_id: string; layout_version: number}>('SELECT * FROM execution_store_identity_v1 WHERE singleton=1');
      if (!identity || identity.actor_id !== actorId || identity.layout_version !== EXECUTION_LAYOUT_VERSION) throw new Error('PRIVATE_MESSAGE_READ_CATALOG_CHANGED');
      const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
      if (!row) throw new Error('PRIVATE_MESSAGE_NOT_PREPARED');
      if (row.actor_id !== actorId || row.origin !== origin || row.layout_version !== EXECUTION_LAYOUT_VERSION) throw new Error('PRIVATE_MESSAGE_PARTITION_MISMATCH');
      if (row.private_message_feature == null) throw new Error('PRIVATE_MESSAGE_NOT_PREPARED');
      if (row.private_message_feature !== privateMessageFeatureCertification('certified')) throw new Error('PRIVATE_MESSAGE_RECOVERY_REQUIRED');
      return row;
    };
    const selected = readCatalog(), path = paths.executionDb(selected.store_id);
    const fileIdentity = () => {
      try {
        const file = lstatSync(path, {bigint: true});
        if (!file.isFile()) throw new Error('PRIVATE_MESSAGE_READ_FILE_CHANGED');
        return {device: file.dev, inode: file.ino};
      } catch { throw new Error('PRIVATE_MESSAGE_READ_FILE_CHANGED'); }
    };
    const file = fileIdentity();
    const assertFile = () => {
      const current = fileIdentity();
      if (current.device !== file.device || current.inode !== file.inode) throw new Error('PRIVATE_MESSAGE_READ_FILE_CHANGED');
    };
    // SQLite may create WAL read-lock sidecars on a cold read-only open. Keep
    // normal WAL visibility; immutable mode would miss a concurrent writer.
    const executionDb = new LocalHostDb(path, {readOnly: true});
    let released = false;
    const close = () => {
      if (released) return;
      released = true; this.privateReadClosers.delete(close); executionDb.close();
    };
    const assertCurrent = () => {
      if (this.closed) throw new Error('EXECUTION_CATALOG_CLOSED');
      if (released) throw new Error('PRIVATE_MESSAGE_READ_CLOSED');
      const row = readCatalog();
      if (row.store_id !== selected.store_id || paths.executionDb(row.store_id) !== path) throw new Error('PRIVATE_MESSAGE_PARTITION_MISMATCH');
      assertFile();
      verifyExecutionPartition(executionDb, row, actorId);
      assertFile();
    };
    try {
      assertCurrent(); this.privateReadClosers.add(close);
      return {executionDb, assertCurrent, close};
    } catch (error) { close(); throw error; }
  }

  /** Full physical and catalog check; historical tables never imply feature activation. */
  isPrivateMessageJournalCurrent(input: string, partition: ExecutionPartition): boolean {
    try {
      this.verifySelected(input, partition);
      const row = this.options.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [normalizeHouseOrigin(input)]);
      return row?.private_message_feature === privateMessageFeatureCertification('certified');
    } catch { return false; }
  }

  private assertPrivateMaintenance(maintenance: MaintenanceSession): void {
    if (!(maintenance instanceof MaintenanceSession) || resolve(this.options.paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('PRIVATE_MESSAGE_ROOT_MISMATCH');
    maintenance.assertCurrent();
    const control = readStorageControl(this.options.paths);
    if (!control || !(['execution', 'consumers', 'notifications'] as const).every(path => control.held.includes(path))) throw new Error('PRIVATE_MESSAGE_MAINTENANCE_HOLDS_INCOMPLETE');
    // Recheck the live root at each boundary, including resumed sessions.
    for (const row of this.options.db.queryAll<{pid: number}>('SELECT pid FROM storage_runtime_participants_v1')) {
      let dead = false;
      try { process.kill(row.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead) throw new Error('STORAGE_ROOT_NOT_QUIESCENT');
    }
  }

  reservePrivateMessageJournal(input: string, partition: ExecutionPartition, maintenance: MaintenanceSession): void {
    this.assertPrivateMaintenance(maintenance);
    const origin = normalizeHouseOrigin(input);
    this.options.db.transaction(tx => {
      this.assertPrivateMaintenance(maintenance); this.verifySelected(origin, partition);
      const row = tx.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
      addPrivateMessageFeatureColumn(tx);
      const required = [...new Set([...(JSON.parse(row.required_tables ?? '[]') as string[]), ...PRIVATE_MESSAGE_FEATURE_TABLES])].sort();
      tx.execute('UPDATE execution_store_catalog_v1 SET required_tables=?,private_message_feature=? WHERE origin=?',
        [JSON.stringify(required), privateMessageFeatureCertification('reserved'), origin]);
    });
  }

  /** Validate the actual selected identity while reserved tables can still be absent. */
  assertPrivateMessagePreparationCurrent(input: string, partition: ExecutionPartition, maintenance: MaintenanceSession): void {
    this.assertPrivateMaintenance(maintenance);
    const origin = normalizeHouseOrigin(input), {db, paths, actorId} = this.options;
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
    if (this.closed || !row || row.actor_id !== actorId || row.store_id !== partition.storeId || row.layout_version !== EXECUTION_LAYOUT_VERSION
      || this.opened.get(origin) !== partition || partition.path !== paths.executionDb(row.store_id) || !existsSync(partition.path)) throw new Error('PRIVATE_MESSAGE_PARTITION_MISMATCH');
    const required: unknown = JSON.parse(row.required_tables ?? '[]');
    if (row.private_message_feature !== privateMessageFeatureCertification('reserved') || !Array.isArray(required)
      || !PRIVATE_MESSAGE_FEATURE_TABLES.every(name => required.includes(name))) throw new Error('PRIVATE_MESSAGE_PROTECTION_INCOMPLETE');
    const identity = partition.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_partition_identity_v1 WHERE singleton=1');
    if (!identity || identity.actor_id !== actorId || identity.origin !== origin || identity.store_id !== row.store_id
      || identity.layout_version !== row.layout_version) throw new Error('EXECUTION_PARTITION_BINDING_MISMATCH');
  }

  certifyPrivateMessageJournal(input: string, partition: ExecutionPartition, maintenance: MaintenanceSession): void {
    this.options.db.transaction(tx => {
      this.assertPrivateMessagePreparationCurrent(input, partition, maintenance);
      const origin = normalizeHouseOrigin(input);
      const row = tx.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
      verifyExecutionPartition(partition.db, {...row, private_message_feature: privateMessageFeatureCertification('certified')}, this.options.actorId);
      tx.execute('UPDATE execution_store_catalog_v1 SET private_message_feature=? WHERE origin=?', [privateMessageFeatureCertification('certified'), origin]);
    });
  }

  /** Reserve the fixed B ledger in G before its separate H31 transaction.
   * An incomplete prior reservation requires recovery evidence, never CREATE. */
  reservePublicJournal(input: string, partition: ExecutionPartition, maintenance: MaintenanceSession): { upgradeLegacyLogProfiles: boolean } {
    const { db, paths } = this.options;
    if (resolve(paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('PUBLIC_JOURNAL_ROOT_MISMATCH');
    maintenance.assertCurrent();
    const origin = normalizeHouseOrigin(input);
    return db.transaction(tx => {
      maintenance.assertCurrent();
      this.verifySelected(origin, partition);
      const row = tx.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
      const prior = JSON.parse(row.required_tables ?? '[]') as string[];
      const present = new Set(partition.db.queryAll<{name: string}>("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
      const reserved = PUBLIC_JOURNAL_TABLES.filter(name => prior.includes(name));
      if (reserved.length === PUBLIC_JOURNAL_TABLES.length) {
        verifyPublicStreamJournalSchema(partition.db);
        return { upgradeLegacyLogProfiles: false };
      }
      const legacy = PUBLIC_JOURNAL_TABLES.filter(name => name !== 'world_public_log_profiles_v1');
      const upgradeLegacyLogProfiles = reserved.length === legacy.length && legacy.every(name => prior.includes(name))
        && !present.has('world_public_log_profiles_v1');
      if (upgradeLegacyLogProfiles) verifyLegacyPublicStreamJournalSchema(partition.db);
      else if (reserved.length || PUBLIC_JOURNAL_TABLES.some(name => present.has(name))) throw new Error('PUBLIC_JOURNAL_RECOVERY_REQUIRED');
      const required = [...new Set([...prior, ...PUBLIC_JOURNAL_TABLES])].sort();
      tx.execute('UPDATE execution_store_catalog_v1 SET required_tables=? WHERE origin=?', [JSON.stringify(required), origin]);
      return { upgradeLegacyLogProfiles };
    });
  }
  /** Persist feature intent in G before the sole H31 preparation transaction. */
  reserveActionReceiptJournal(input: string, partition: ExecutionPartition, maintenance: MaintenanceSession): void {
    const { db, paths } = this.options;
    if (resolve(paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('ACTION_RECEIPT_ROOT_MISMATCH');
    maintenance.assertCurrent();
    const origin = normalizeHouseOrigin(input);
    db.transaction(tx => {
      maintenance.assertCurrent();
      this.verifySelected(origin, partition);
      const row = tx.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
      const prior = JSON.parse(row.required_tables ?? '[]') as string[];
      const required = [...new Set([...prior, ...ACTION_RECEIPT_FEATURE_TABLES])].sort();
      tx.execute('UPDATE execution_store_catalog_v1 SET required_tables=? WHERE origin=?', [JSON.stringify(required), origin]);
    });
  }

  /** Native preparation extends an already prepared action journal; it never prepares the old feature. */
  reserveNativeActionJournal(input: string, partition: ExecutionPartition, maintenance: MaintenanceSession): void {
    const { db, paths, actorId } = this.options;
    if (resolve(paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('NATIVE_ACTION_ROOT_MISMATCH');
    maintenance.assertCurrent();
    const origin = normalizeHouseOrigin(input);
    db.transaction(tx => {
      maintenance.assertCurrent(); this.verifySelected(origin, partition);
      const row = tx.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
      const prior = JSON.parse(row.required_tables ?? '[]') as string[];
      if (!ACTION_RECEIPT_FEATURE_TABLES.every(name => prior.includes(name))) throw new Error('ACTION_RECEIPT_PROTECTION_INCOMPLETE');
      assertActionReceiptJournalSchema(partition.db, { origin, actorId, storeId: partition.storeId, layoutVersion: 1 });
      tx.execute('UPDATE execution_store_catalog_v1 SET required_tables=? WHERE origin=?',
        [JSON.stringify([...new Set([...prior, ...NATIVE_ACTION_FEATURE_TABLES])].sort()), origin]);
    });
  }

  assertNativeActionPreparationCurrent(input: string, partition: ExecutionPartition, maintenance: MaintenanceSession): void {
    this.assertActionReceiptPreparationCurrent(input, partition, maintenance);
    const origin = normalizeHouseOrigin(input);
    const row = this.options.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin])!;
    const required = JSON.parse(row.required_tables ?? '[]') as string[];
    if (!NATIVE_ACTION_FEATURE_TABLES.every(name => required.includes(name))) throw new Error('NATIVE_ACTION_PROTECTION_INCOMPLETE');
    assertActionReceiptJournalSchema(partition.db, { origin, actorId: this.options.actorId, storeId: partition.storeId, layoutVersion: 1 });
  }

  /** Identity/intent check during the deliberately incomplete reserved-to-DDL interval. */
  assertActionReceiptPreparationCurrent(input: string, partition: ExecutionPartition, maintenance: MaintenanceSession): void {
    maintenance.assertCurrent();
    const origin = normalizeHouseOrigin(input), { db, paths, actorId } = this.options;
    if (this.closed || resolve(paths.rootDir()) !== resolve(maintenance.paths.rootDir())) throw new Error('ACTION_RECEIPT_ROOT_MISMATCH');
    const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [origin]);
    if (!row || row.actor_id !== actorId || row.store_id !== partition.storeId || row.layout_version !== EXECUTION_LAYOUT_VERSION
      || this.opened.get(origin) !== partition || partition.path !== paths.executionDb(row.store_id) || !existsSync(partition.path))
      throw new Error('ACTION_RECEIPT_PARTITION_MISMATCH');
    const required: unknown = JSON.parse(row.required_tables ?? '[]');
    if (!Array.isArray(required) || !ACTION_RECEIPT_FEATURE_TABLES.every(name => required.includes(name)))
      throw new Error('ACTION_RECEIPT_PROTECTION_INCOMPLETE');
    const identity = partition.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_partition_identity_v1 WHERE singleton=1');
    if (!identity || identity.actor_id !== actorId || identity.origin !== origin || identity.store_id !== row.store_id
      || identity.layout_version !== row.layout_version) throw new Error('EXECUTION_PARTITION_BINDING_MISMATCH');
  }

  /** Classify a cache address without opening a legacy mixed source for writes. */
  cacheProjection(input: string): {path: string; readOnly: boolean} {
    const origin = normalizeHouseOrigin(input), slug = hostDbSlug(origin), paths = this.options.paths;
    const migrated = paths.worldFeedProjectionDb(slug);
    if (existsSync(migrated)) return {path: migrated, readOnly: false};
    const path = paths.lorehouseDb(slug);
    if (!existsSync(path)) return {path, readOnly: false};
    const probe = new LocalHostDb(path, {readOnly: true});
    try {return {path, readOnly: inspectLegacySchema(probe).durable.length > 0};}
    catch {return {path, readOnly: true};}
    finally {probe.close();}
  }

  private openSelected(row: ExecutionCatalogRow): ExecutionPartition {
    const { paths, actorId } = this.options;
    if (row.actor_id !== actorId) throw new Error('EXECUTION_ACTOR_MISMATCH');
    if (row.layout_version !== EXECUTION_LAYOUT_VERSION) throw new Error('EXECUTION_LAYOUT_UNSUPPORTED');
    const path = paths.executionDb(row.store_id);
    if (!existsSync(path)) throw new Error('EXECUTION_PARTITION_MISSING');
    const probe = new LocalHostDb(path, { readOnly: true });
    try {
      verifyExecutionPartition(probe, row, actorId);
    } finally { probe.close(); }
    return { db: new LocalHostDb(path), path, storeId: row.store_id };
  }
  close(): void {
    if (this.closed) return;
    for (const close of this.privateReadClosers) close();
    for (const partition of this.opened.values()) {
      const present = partition.db.queryAll<{name:string}>("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name);
      const prior = this.options.db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE store_id=?', [partition.storeId]);
      // Closing a handle is not a preparation. A protected feature whose tables
      // merely exist is never promoted into the reservation here: only the
      // controlled creation or an explicit reservation may select one, so an
      // unregistered feature still demands recovery after close and reopen.
      const required = [...new Set([...(JSON.parse(prior?.required_tables ?? '[]') as string[]),
        ...DURABLE_TABLES.filter(name => present.includes(name) && !PROTECTED_FEATURE_TABLES.has(name))])];
      this.options.db.execute('UPDATE execution_store_catalog_v1 SET required_tables=? WHERE store_id=?', [JSON.stringify(required), partition.storeId]);
      partition.db.close();
    }
    this.opened.clear();
    this.closed = true;
  }
}

/** Shared read-only validation for selection and backup eligibility. */
export function verifyExecutionPartition(probe: HostDb, row: ExecutionCatalogRow, actorId: string): void {
  const identity = probe.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_partition_identity_v1 WHERE singleton=1');
  if (!identity || identity.actor_id !== actorId || identity.origin !== row.origin || identity.store_id !== row.store_id || identity.layout_version !== EXECUTION_LAYOUT_VERSION) {
    throw new Error('EXECUTION_PARTITION_BINDING_MISMATCH');
  }
  const tables = new Set(probe.queryAll<{name: string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").map(table => table.name));
  const allowed = new Set<string>([...DURABLE_TABLES, '_READ_THIS_FIRST', 'execution_partition_identity_v1']);
  if ([...tables].some(table => !allowed.has(table))) throw new Error('EXECUTION_SCHEMA_UNKNOWN');
  const required = JSON.parse(row.required_tables ?? '[]') as unknown;
  if (!Array.isArray(required) || required.some(table => typeof table !== 'string' || !allowed.has(table) || !tables.has(table))) throw new Error('EXECUTION_REQUIRED_TABLE_MISSING');
  if (required.includes('world_public_log_profiles_v1')) {
    if (!PUBLIC_JOURNAL_TABLES.every(name => required.includes(name))) throw new Error('PUBLIC_JOURNAL_PROTECTION_INCOMPLETE');
    verifyPublicStreamJournalSchema(probe);
  } else if (tables.has('world_public_log_profiles_v1')) throw new Error('PUBLIC_JOURNAL_RECOVERY_REQUIRED');
  assertPrivateCertification(probe, row);
  if (NATIVE_ACTION_FEATURE_TABLES.some(name => required.includes(name))) {
    if (![...ACTION_RECEIPT_FEATURE_TABLES, ...NATIVE_ACTION_FEATURE_TABLES].every(name => required.includes(name)))
      throw new Error('NATIVE_ACTION_PROTECTION_INCOMPLETE');
    assertNativeActionJournalSchema(probe, { origin: row.origin, actorId, storeId: row.store_id, layoutVersion: 1 });
  } else if (NATIVE_ACTION_FEATURE_TABLES.some(name => tables.has(name))) throw new Error('NATIVE_ACTION_RECOVERY_REQUIRED');
  if (required.includes('world_action_client_evidence')) {
    if (!ACTION_RECEIPT_FEATURE_TABLES.every(name => required.includes(name))) throw new Error('ACTION_RECEIPT_PROTECTION_INCOMPLETE');
    assertActionReceiptJournalSchema(probe, { origin: row.origin, actorId, storeId: row.store_id, layoutVersion: 1 });
  } else {
    // Legacy action tables alone remain historical. New feature objects without
    // durable intent are never silently adopted by ordinary open or backup.
    const additions = {
      world_action_client_requests: ['receipt_profile', 'original_context'],
      world_action_client_results: ['receipt_profile', 'receipt_state'],
      world_action_client_progress: ['receipt_profile', 'observation_state'],
    };
    if (tables.has('world_action_client_evidence') || Object.entries(additions).some(([table, columns]) =>
      tables.has(table) && probe.queryAll<{name: string}>(`PRAGMA table_info("${table}")`).some(column => columns.includes(column.name))))
      throw new Error('ACTION_RECEIPT_RECOVERY_REQUIRED');
  }
  if (probe.queryOne<{integrity_check: string}>('PRAGMA integrity_check')?.integrity_check !== 'ok') throw new Error('EXECUTION_PARTITION_CORRUPT');
  if (probe.queryAll('PRAGMA foreign_key_check').length) throw new Error('EXECUTION_PARTITION_FOREIGN_KEY_FAILURE');
}
