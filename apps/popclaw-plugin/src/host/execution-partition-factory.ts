/**
 * The shared factory for a GENUINELY NEW, NOT YET PUBLISHED execution
 * partition, used by every product root through `ExecutionStoreCatalog.open`.
 *
 * Storage readiness is not house support and is not owner authorization. This
 * factory only builds empty, correctly bound tables; nothing here creates a
 * business request, an owner grant, a follow, outbound traffic, or revives a
 * logged-out participation. Execution stays gated by the verified capability,
 * live participation, per-action owner confirmation and the final permission
 * gate, exactly as before.
 *
 * Eligibility comes from a controlled creation, never from observing an empty
 * `required_tables` afterwards: an already published catalog row, a partly
 * prepared partition, an unreserved feature, a mis-bound identity and an
 * orphan left by a failed creation are all refused by the existing codes.
 */
import { existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { HostDb } from './host-db.js';
import { LocalHostDb } from './local-host-db.js';
import type { PopclawPaths } from './popclaw-paths.js';
import { ACTION_RECEIPT_FEATURE_TABLES, NATIVE_ACTION_FEATURE_TABLES, PUBLIC_JOURNAL_TABLES, DURABLE_TABLES, EXECUTION_LAYOUT_VERSION } from './execution-store-schema.js';
import { MaintenanceSession, readStorageControl, storagePathAllowed } from './storage-maintenance.js';
import { prepareActionReceiptJournal, snapshotActionReceiptOriginalContent, snapshotActionJournalTableOriginalContent, ACTION_RECEIPT_SCHEMA_FINGERPRINT } from '../world/action-receipt-journal.js';
import { prepareNativeActionJournal, snapshotNativeActionOriginalContent, NATIVE_ACTION_SCHEMA_FINGERPRINT } from '../world/native-action-journal.js';
import { preparePrivateMessageJournal, snapshotPrivateMessageOriginalContent, PRIVATE_MESSAGE_FEATURE_TABLES, PRIVATE_MESSAGE_SCHEMA_FINGERPRINT } from '../world/private-message-storage.js';
import { createPublicStreamSchema, verifyPublicStreamJournalSchema } from '../world/scoped-stream-journal.js';

/** Exactly what a first-release partition is published with. Bindings, cursors
 * and every other selection-bearing record stay outside: they are established
 * by their own checked lifecycle, never by an empty table. */
export const FRESH_PARTITION_REQUIRED_TABLES: readonly string[] =
  Object.freeze([...ACTION_RECEIPT_FEATURE_TABLES, ...NATIVE_ACTION_FEATURE_TABLES,
    ...PRIVATE_MESSAGE_FEATURE_TABLES, ...PUBLIC_JOURNAL_TABLES].sort());

/**
 * Storage gates for creating a partition on a live root. A held execution or
 * consumers path, and a root whose control file has gone missing after the
 * marker was written, both refuse by name instead of quietly opening a house
 * with no ledger. A maintenance token is an accepted entrance — the offline
 * preparation path must keep working — but it is never auto-acquired here and
 * nothing in this module releases a hold.
 */
export function assertFreshPartitionAdmissible(globalDb: HostDb, paths: PopclawPaths, maintenance?: MaintenanceSession): void {
  if (maintenance) {
    if (!(maintenance instanceof MaintenanceSession) || resolve(paths.rootDir()) !== resolve(maintenance.paths.rootDir()))
      throw new Error('FRESH_PARTITION_ROOT_MISMATCH');
    maintenance.assertCurrent();
    return;
  }
  if (!readStorageControl(paths) && globalDb.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_control_required_v1'"))
    throw new Error('FRESH_PARTITION_STORAGE_CONTROL_MISSING');
  for (const path of ['execution', 'consumers'] as const)
    if (!storagePathAllowed(paths, path)) throw new Error(`FRESH_PARTITION_STORAGE_HELD: ${path}`);
}

/** Durable before publication: the catalog row must never name a store whose
 * own file is still only in a write-ahead log.
 *
 * The database file is made durable THROUGH SQLite's own descriptor and never
 * through a plain `fs` one. POSIX record locks are per process and per file:
 * closing ANY descriptor on a file drops ALL of this process's locks on it, and
 * SQLite can only shield the descriptors it opened itself. The
 * `openSync(path,'r') + fsyncSync + closeSync` that used to stand here
 * therefore dropped this process's SHARED lock on a database it was holding
 * open — after which the next connection in another process to close took
 * EXCLUSIVE, believed it was the last connection, checkpointed and unlinked
 * `-wal`/`-shm` while this one kept writing into a nameless inode (the full
 * mechanism is in local-host-db.ts). It also bought nothing:
 * `wal_checkpoint(TRUNCATE)` copies every committed frame into the main file
 * and, at `synchronous` NORMAL or FULL, fsyncs that file through SQLite's own
 * descriptor before truncating the log. Same durability, from the inside.
 *
 * The DIRECTORY fsync stays. A directory is a different inode, so it carries
 * none of the database's locks, and it is what makes the file's NAME survive a
 * power cut — something syncing the file itself never provides.
 *
 * Because the checkpoint is now the ONLY thing that makes the file itself
 * durable, its result is read. `wal_checkpoint` reports `busy = 1` instead of
 * throwing when a reader or writer stopped it from finishing, which would leave
 * committed frames in the log with nothing to say so — the caller would publish
 * a catalog row naming a store that is not yet in its own file. A busy
 * checkpoint therefore fails here, exactly as a failed fsync did before, and
 * `buildFreshExecutionPartition`'s existing catch closes the partition and
 * propagates. Exported only so the durability step can be tested against a
 * reader that really is holding the log open.
 */
export function persistPartitionFile(db: LocalHostDb, path: string): void {
  const checkpoint = db.queryOne<{busy: number}>('PRAGMA wal_checkpoint(TRUNCATE)');
  if (!checkpoint || checkpoint.busy !== 0) throw new Error('EXECUTION_PARTITION_CHECKPOINT_BUSY');
  const fd = openSync(dirname(path), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/**
 * Build the partition file completely — identity and every published feature's
 * empty schema — and verify the result independently, before
 * the caller publishes the catalog row. The two databases are not claimed
 * atomic: a failure between this call and the catalog write leaves an
 * unselected orphan, which is never adopted, cleared, or taken as evidence of
 * recovery. The next creation mints its own store id.
 */
export function buildFreshExecutionPartition(input: { paths: PopclawPaths; actorId: string; origin: string; storeId: string }): { db: LocalHostDb; path: string } {
  const { paths, actorId, origin, storeId } = input;
  const path = paths.executionDb(storeId);
  if (existsSync(path)) throw new Error('EXECUTION_TARGET_EXISTS');
  const db = new LocalHostDb(path);
  try {
    db.execute(`CREATE TABLE execution_partition_identity_v1 (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), actor_id TEXT NOT NULL,
      origin TEXT NOT NULL, store_id TEXT NOT NULL, layout_version INTEGER NOT NULL, public_initialization TEXT NOT NULL CHECK(public_initialization IN ('fresh-public-v1','prepared-public-v1')))`);
    db.execute('INSERT INTO execution_partition_identity_v1 VALUES(1,?,?,?,?,?)', [actorId, origin, storeId, EXECUTION_LAYOUT_VERSION, 'fresh-public-v1']);
    const expectedPartition = { origin, actorId, storeId, layoutVersion: 1 as const };
    prepareActionReceiptJournal({ executionDb: db, expectedPartition, expectedSchemaFingerprint: ACTION_RECEIPT_SCHEMA_FINGERPRINT });
    prepareNativeActionJournal({ executionDb: db, expectedPartition, expectedSchemaFingerprint: NATIVE_ACTION_SCHEMA_FINGERPRINT });
    // The two structured private-message tables use the one existing
    // preparation; the certification marker the caller publishes with them is a
    // schema credential, never house support or owner authorization.
    preparePrivateMessageJournal({ executionDb: db, expectedSchemaFingerprint: PRIVATE_MESSAGE_SCHEMA_FINGERPRINT });
    // The public-stream tables come from the world lane's own pure-schema entry
    // — no DDL copy lives here. It creates and verifies the eight names and
    // deliberately writes no binding, log profile or cursor: a subscription is
    // still established by the checked activation chain, never by an empty
    // table this factory left behind.
    createPublicStreamSchema(db);
    // Independent read of the actual result: a preparation report may not
    // attest its own emptiness.
    const content = { ...snapshotActionReceiptOriginalContent(db), ...snapshotNativeActionOriginalContent(db),
      ...snapshotPrivateMessageOriginalContent(db),
      ...Object.fromEntries(PUBLIC_JOURNAL_TABLES.map(name => [name, snapshotActionJournalTableOriginalContent(db, name)])) };
    for (const name of FRESH_PARTITION_REQUIRED_TABLES) {
      if (!content[name] || content[name]!.rowCount !== '0') throw new Error('FRESH_PARTITION_NOT_EMPTY');
    }
    persistPartitionFile(db, path);
    return { db, path };
  } catch (error) { db.close(); throw error; }
}

/** Factory provenance is explicit and durable. Empty tables never confer it. */
export function assertFreshPublicPartition(db: HostDb, expected: { actorId: string; origin: string; storeId: string }): void {
  const columns = db.queryAll<{name:string}>('PRAGMA table_info(execution_partition_identity_v1)');
  if (!columns.some(c => c.name === 'public_initialization')) throw new Error('PUBLIC_JOURNAL_INITIALIZATION_REQUIRED');
  const row = db.queryOne<{actor_id:string;origin:string;store_id:string;layout_version:number;public_initialization:string}>(
    'SELECT * FROM execution_partition_identity_v1 WHERE singleton=1');
  if (!row || row.actor_id !== expected.actorId || row.origin !== expected.origin || row.store_id !== expected.storeId
    || row.layout_version !== EXECUTION_LAYOUT_VERSION || row.public_initialization !== 'fresh-public-v1')
    throw new Error('PUBLIC_JOURNAL_INITIALIZATION_REQUIRED');
  verifyPublicStreamJournalSchema(db);
  // Keep the complete legacy stream family from the component authority. A
  // cursor/descriptor/log/gap is history even when no event row survived.
  const historical = [...PUBLIC_JOURNAL_TABLES, ...DURABLE_TABLES.filter(name =>
    name === 'world_stream' || name === 'world_stream_cursor' || name.startsWith('world_scoped_'))];
  for (const table of historical) {
    if (db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [table])
      && db.queryOne(`SELECT 1 FROM "${table}" LIMIT 1`)) throw new Error('PUBLIC_JOURNAL_INITIALIZATION_REQUIRED');
  }
}
