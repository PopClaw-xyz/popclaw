import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, rmSync, existsSync, lstatSync, realpathSync, mkdirSync, readdirSync, readFileSync, readSync, writeFileSync, renameSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { verifyExecutionPartition, type ExecutionCatalogRow } from './execution-store.js';
import { LocalHostDb, assertNoLiveDatabaseDescriptor, hasOpenDatabaseConnection } from './local-host-db.js';
import type { PopclawPaths } from './popclaw-paths.js';
import type { HostDb } from './host-db.js';
import { MaintenanceSession, publishStorageJson, readStorageControl, type StorageControl } from './storage-maintenance.js';

export interface BackupFile { path: string; sha256: string; sqlite: boolean; tables?: Record<string, number> }
export interface StorageBackupManifest {
  version: 1;
  setId: string;
  sourceRoot: string;
  actorId: string;
  installationId: string | null;
  codeVersion: string;
  consistency: 'quiescent-set' | 'component-snapshots';
  maintenanceEpoch: string | null;
  day?: string;
  files: BackupFile[];
}
/**
 * Raw-byte hash. Every caller here hands it a SNAPSHOT or a backup member, and
 * the assertion is what keeps it that way: hashing a LIVE database with plain
 * `fs` is exactly how this process loses its POSIX locks on it and gets its
 * write-ahead log unlinked underneath it (local-host-db.ts). A live database is
 * hashed by taking a snapshot through the SQLite backup API first
 * (`LocalHostDb.snapshotTo`) and hashing that.
 */
export function fileSha256(path: string): string {
  assertNoLiveDatabaseDescriptor(path, 'hash');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function quoteSqlIdentifier(name: string): string { return '"' + name.replaceAll('"', '""') + '"'; }

/** `<file>.<32-hex restore epoch>.restore-tmp`, written by restoreStorageBackup. */
const RESTORE_TEMPORARY = /\.[0-9a-f]{32}\.restore-tmp$/;

/**
 * The SQLite magic number, read from a file NO connection is coordinating — a
 * finished copy or snapshot inside a backup set. Never call this on a member of
 * a live data root: the whole point of the layout-based classification above is
 * that a header read is a descriptor, and a descriptor on a live database is
 * what drops this process's locks on it.
 */
function looksLikeSqlite(quiescedFile: string): boolean {
  assertNoLiveDatabaseDescriptor(quiescedFile, 'read the header of');
  const fd = openSync(quiescedFile, 'r');
  try {
    const header = Buffer.alloc(16);
    return readSync(fd, header, 0, 16, 0) === 16 && header.toString('latin1') === 'SQLite format 3\u0000';
  } finally { closeSync(fd); }
}

/** Exact logical content including SQLite types, large integers, BLOB bytes and traversal rowids. */
export function tableFingerprint(db: LocalHostDb, name: string): string {
  const schema = db.queryOne<{sql: string}>('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?', [name]);
  if (!schema) throw new Error('TABLE_MISSING');
  const columns = db.queryAll<{name: string}>(`PRAGMA table_xinfo(${quoteSqlIdentifier(name)})`).map(row => row.name);
  const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(schema.sql);
  const rowid = ['_rowid_', 'rowid', 'oid'].find(alias => !columns.some(column => column.toLowerCase() === alias));
  if (!withoutRowid && !rowid) throw new Error('ROWID_SHADOW_UNSUPPORTED');
  const expressions = columns.map((column, index) => {
    const q = quoteSqlIdentifier(column);
    return `typeof(${q}) AS t${index}, CASE typeof(${q}) WHEN 'blob' THEN hex(${q}) WHEN 'integer' THEN CAST(${q} AS TEXT) WHEN 'real' THEN quote(${q}) ELSE ${q} END AS v${index}`;
  });
  if (!withoutRowid) expressions.unshift(`CAST(${rowid} AS TEXT) AS traversal_rowid`);
  const rows = db.queryAll(`SELECT ${expressions.join(',')} FROM ${quoteSqlIdentifier(name)}`).map(row => JSON.stringify(row)).sort();
  return createHash('sha256').update(JSON.stringify([schema.sql, rows])).digest('hex');
}
function listFiles(root: string, directory: string, excluded: readonly string[]): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    if (excluded.some((skip) => resolve(path) === resolve(skip))) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`BACKUP_SYMLINK_UNSUPPORTED: ${relative(root, path)}`);
    if (stat.isDirectory()) result.push(...listFiles(root, path, excluded));
    else if (stat.isFile()) result.push(path);
    else throw new Error('BACKUP_SPECIAL_FILE_UNSUPPORTED');
  }
  return result;
}
function validRelative(path: string): boolean {
  return !!path && !path.startsWith('/') && !path.split(/[\\/]/).some(part => !part || part === '.' || part === '..');
}
export function verifyStorageBackup(directory: string, manifestName: 'manifest.json' | 'manifest.pending.json' = 'manifest.json'): StorageBackupManifest {
  const manifest = JSON.parse(readFileSync(join(directory, manifestName), 'utf8')) as StorageBackupManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !['quiescent-set', 'component-snapshots'].includes(manifest.consistency)) throw new Error('BACKUP_MANIFEST_INVALID');
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!validRelative(file.path) || seen.has(file.path)) throw new Error('BACKUP_PATH_INVALID');
    seen.add(file.path);
    const path = join(directory, 'files', file.path);
    if (!realpathSync(path).startsWith(realpathSync(join(directory, 'files')) + sep) || lstatSync(path).isSymbolicLink() || fileSha256(path) !== file.sha256) throw new Error('BACKUP_HASH_MISMATCH');
    if (file.sqlite) {
      const db = new LocalHostDb(path, {readOnly: true});
      try {
        if (db.queryOne<{integrity_check: string}>('PRAGMA integrity_check')?.integrity_check !== 'ok') throw new Error('BACKUP_DATABASE_CORRUPT');
        if (db.queryAll('PRAGMA foreign_key_check').length) throw new Error('BACKUP_FOREIGN_KEY_FAILURE');
        for (const [name, count] of Object.entries(file.tables ?? {})) {
          if (db.queryOne<{n: number}>(`SELECT count(*) AS n FROM ${quoteSqlIdentifier(name)}`)?.n !== count) throw new Error('BACKUP_TABLE_COUNT_MISMATCH');
        }
      } finally { db.close(); }
    }
  }
  const globalFile = 'vault/social/my-social-assets.db';
  if (!seen.has(globalFile)) throw new Error('BACKUP_GLOBAL_DATABASE_MISSING');
  const global = new LocalHostDb(join(directory, 'files', globalFile), {readOnly: true});
  try {
    if (global.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_store_catalog_v1'")) {
      for (const row of global.queryAll<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1')) {
        if (!/^[a-f0-9]{32}$/.test(row.store_id) || row.actor_id !== manifest.actorId || row.layout_version !== 1) throw new Error('BACKUP_CATALOG_BINDING_MISMATCH');
        const file = `vault/social/execution/${row.store_id}.db`;
        if (!seen.has(file)) throw new Error('BACKUP_EXECUTION_PARTITION_MISSING');
        const partition = new LocalHostDb(join(directory, 'files', file), {readOnly: true});
        try {
          verifyExecutionPartition(partition, row, manifest.actorId);
        } finally {partition.close();}
      }
    }
  } finally {global.close();}
  return manifest;
}

/** Manifest is published last. A failed attempt leaves earlier complete sets untouched. */
export async function createStorageBackup(options: {
  paths: PopclawPaths; actorId: string; installationId: string | null; codeVersion: string; day?: string;
  maintenance?: MaintenanceSession;
  failpoint?: (stage: string) => void;
}): Promise<{directory: string; manifest: StorageBackupManifest}> {
  const {paths, maintenance} = options;
  if (maintenance && resolve(maintenance.paths.rootDir()) !== resolve(paths.rootDir())) throw new Error('BACKUP_ROOT_MISMATCH');
  maintenance?.assertCurrent();
  const setId = `${Date.now()}-${randomBytes(16).toString('hex')}`;
  const directory = join(paths.backupsDir(), setId);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  // Not members: the backups themselves, and draft review copies — plaintext
  // letters that live only as long as their draft (tools/draft-review.ts) and
  // may be deleted mid-walk. A persistent set must not keep them.
  try {
    const sources = listFiles(paths.rootDir(), paths.rootDir(), [paths.backupsDir(), paths.draftReviewDir()]);
    const manifest: StorageBackupManifest = {
      version: 1, setId, sourceRoot: resolve(paths.rootDir()), actorId: options.actorId,
      installationId: options.installationId, codeVersion: options.codeVersion,
      consistency: maintenance ? 'quiescent-set' : 'component-snapshots',
      maintenanceEpoch: maintenance?.epoch ?? null, ...(options.day ? {day: options.day} : {}), files: [],
    };
    for (const source of sources) {
      maintenance?.assertCurrent();
      if (/(?:-wal|-shm|-journal)$/.test(source) && existsSync(source.replace(/(?:-wal|-shm|-journal)$/, ''))) continue;
      // Our own restore's half-written temporaries, skipped by name next to the
      // sidecars above and for the same reason: they are this module's own
      // artefacts, not members. A restore interrupted between the copy and the
      // rename leaves `<file>.<epoch>.restore-tmp` behind (restoreStorageBackup
      // below); for a database member that is a partial SQLite image under a name
      // the layout does not know, so it is worth nothing in a set — the finished
      // file it was becoming is captured from its own path — and it is the one
      // shape of unclassified database this code can produce itself, which the
      // refusal below would otherwise turn on us.
      //
      // NOT a claim that such a leftover is reachable while backups run. It is
      // not: an unfinished restore leaves the root in `mode: 'maintenance'` with
      // a `.restore-reservation` (restoreStorageBackup below), and
      // assertStorageBootstrap (host/storage-maintenance.ts) refuses to boot on
      // exactly that state at every entry point, so the backup service never
      // starts there; a resumed restore must reuse the same epoch and therefore
      // overwrites the leftover and renames it away. This is one regex beside an
      // existing skip, not a cleanup sweep.
      if (RESTORE_TEMPORARY.test(source)) continue;
      const path = relative(paths.rootDir(), source).split(sep).join('/');
      const destination = join(directory, 'files', path);
      mkdirSync(resolve(destination, '..'), {recursive: true, mode: 0o700});
      // Which members are databases is decided from the CONTROLLED LAYOUT
      // (PopclawPaths.isDatabaseFile), plus anything this process currently has
      // open — never by reading the file. This walk runs inside the resident
      // gateway over its OWN live data root, so the
      // `readFileSync(source).subarray(0,16)` magic-number sniff that used to
      // stand here opened a plain-fs descriptor on every live database under the
      // root, and closing it dropped this process's POSIX locks on all of them.
      // That is how a resident gateway ends up writing into an unlinked
      // write-ahead log (local-host-db.ts has the mechanism; measured: the
      // social, execution-partition and house-cache databases had all lost their
      // locks while OpenClaw's own databases outside the root kept theirs).
      //
      // The set's coverage is unchanged: every member is still captured,
      // databases still through the online backup API, and the manifest is still
      // verified before it is published.
      const sqlite = paths.isDatabaseFile(source) || paths.isLegacyDatabaseBackup(source) || hasOpenDatabaseConnection(source);
      let tables: Record<string, number> | undefined;
      if (sqlite) {
        // A member the layout calls a database and which will not open or snapshot
        // as one is a refusal, never a quiet fallback to a byte copy. (SQLite
        // reads no header at open, so "this is not a database" surfaces from the
        // backup call; both legs carry the same name.)
        let db: LocalHostDb | undefined;
        try {
          db = new LocalHostDb(source, {readOnly: true});
          await db.snapshotTo(destination);
        } catch (error) { throw new Error(`BACKUP_DATABASE_UNREADABLE: ${path}`, {cause: error}); }
        finally { db?.close(); }
        const snapshot = new LocalHostDb(destination, {readOnly: true});
        try {
          tables = Object.fromEntries(snapshot.queryAll<{name: string}>("SELECT name FROM sqlite_master WHERE type='table'")
            .map(row => [row.name, snapshot.queryOne<{n: number}>(`SELECT count(*) AS n FROM ${quoteSqlIdentifier(row.name)}`)!.n]));
        } finally { snapshot.close(); }
      } else {
        assertNoLiveDatabaseDescriptor(source, 'copy');
        copyFileSync(source, destination);
        // Only now ask what it actually was — of the COPY, a dead file no
        // connection is coordinating, so reading it coordinates with nothing. An
        // unclassified member that turns out to hold a database is refused here
        // instead of shipping as a plain byte copy of something that needed the
        // backup API. The layout makes the decision; this is the check on it.
        if (looksLikeSqlite(destination)) throw new Error(`BACKUP_UNCLASSIFIED_DATABASE: ${path}`);
      }
      assertNoLiveDatabaseDescriptor(destination, 'fsync');
      const fd = openSync(destination, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
      chmodSync(destination, 0o400);
      manifest.files.push({path, sqlite, sha256: fileSha256(destination), ...(tables ? {tables} : {})});
      options.failpoint?.(`copied:${path}`);
    }
    maintenance?.assertCurrent();
    options.failpoint?.('before-manifest');
    publishStorageJson(join(directory, 'manifest.pending.json'), manifest);
    verifyStorageBackup(directory, 'manifest.pending.json');
    maintenance?.assertCurrent();
    publishStorageJson(join(directory, 'manifest.json'), manifest);
    chmodSync(join(directory, 'manifest.json'), 0o400);
    return {directory, manifest};
  } catch (error) {
    // This call exclusively owns this random set directory. Earlier complete
    // sets and historic incomplete evidence are never cleanup candidates.
    if (!existsSync(join(directory, 'manifest.json'))) rmSync(directory, {recursive: true, force: true});
    throw error;
  }
}


/** Managed restore publishes a hold before copying data. Existing roots are never overwritten.
 * A move consumes a currently held, freshly quiesced source; clones always mint a new installation.
 * Recovery release is deliberately separate from copying history.
 */
export function ensureStorageRestoreSchema(db: HostDb): void {
  db.execute('CREATE TABLE IF NOT EXISTS storage_restore_applied_v1(epoch TEXT PRIMARY KEY, set_id TEXT NOT NULL, operation TEXT NOT NULL)');
}

export async function restoreStorageBackup(options: {
  backupDirectory: string; destination: PopclawPaths; operation: 'restore' | 'move' | 'clone';
  expectedActorId: string; sourceMaintenance?: MaintenanceSession;
  resumeEpoch?: string; failpoint?: (stage: string) => void;
}): Promise<{epoch: string; installationId: string | null}> {
  const manifest = verifyStorageBackup(options.backupDirectory);
  const paths = options.destination;
  if (manifest.actorId !== options.expectedActorId) throw new Error('RESTORE_ACTOR_MISMATCH');
  if (resolve(paths.rootDir()) === manifest.sourceRoot) throw new Error('RESTORE_EXISTING_ROOT_FORBIDDEN');
  if (options.operation === 'move') {
    const source = options.sourceMaintenance;
    source?.assertCurrent();
    if (!source || manifest.consistency !== 'quiescent-set' || manifest.maintenanceEpoch !== source.epoch
      || resolve(source.paths.rootDir()) !== manifest.sourceRoot) throw new Error('MOVE_REQUIRES_QUIESCENT_SOURCE_SET');
  }
  let epoch = options.resumeEpoch;
  const receiptPath = join(paths.vaultSocialDir(), 'restore-progress.json');
  if (!epoch) {
    if (existsSync(paths.rootDir()) && readdirSync(paths.rootDir()).length) throw new Error('RESTORE_DESTINATION_NOT_EMPTY');
    mkdirSync(paths.rootDir(), {recursive: true, mode: 0o700});
    epoch = randomBytes(16).toString('hex');
    // Exclusive reservation is retained after a crash; only explicit epoch resume may continue.
    const reservation = join(paths.rootDir(), '.restore-reservation');
    const planned = {version: 1, epoch, setId: manifest.setId, operation: options.operation,
      actorId: manifest.actorId, installationId: options.operation === 'clone' ? randomUUID() : manifest.installationId};
    const fd = openSync(reservation, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(planned)); fsyncSync(fd); } finally {closeSync(fd);}
    const rootFd = openSync(paths.rootDir(), 'r');
    try {fsyncSync(rootFd);} finally {closeSync(rootFd);}
    options.failpoint?.('restore-reserved');
    publishStorageJson(paths.storageControlFile(), {version: 1, epoch, mode: 'maintenance',
      reason: `${options.operation} ${manifest.setId}`, held: ['execution','consumers','notifications'], releases: {}} satisfies StorageControl);
    options.failpoint?.('restore-control-published');
    publishStorageJson(receiptPath, planned);
  }
  if (!existsSync(receiptPath)) {
    const planned = JSON.parse(readFileSync(join(paths.rootDir(), '.restore-reservation'), 'utf8'));
    if (planned.epoch !== epoch || planned.setId !== manifest.setId || planned.operation !== options.operation || planned.actorId !== manifest.actorId) throw new Error('RESTORE_RESERVATION_MISMATCH');
    publishStorageJson(receiptPath, planned);
  }
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
    version: number; epoch: string; setId: string; operation: string; actorId: string; installationId: string | null;
  };
  if (receipt.version !== 1 || receipt.epoch !== epoch || receipt.setId !== manifest.setId
    || receipt.operation !== options.operation || receipt.actorId !== options.expectedActorId) throw new Error('RESTORE_RESUME_MISMATCH');
  if (!readStorageControl(paths)) {
    const reserved = JSON.parse(readFileSync(join(paths.rootDir(), '.restore-reservation'), 'utf8'));
    if (reserved.epoch !== epoch || reserved.setId !== manifest.setId || reserved.operation !== options.operation || reserved.actorId !== manifest.actorId) throw new Error('RESTORE_RESERVATION_MISMATCH');
    publishStorageJson(paths.storageControlFile(), {version: 1, epoch, mode: 'maintenance',
      reason: `${options.operation} ${manifest.setId}`, held: ['execution','consumers','notifications'], releases: {}} satisfies StorageControl);
  }
  const applied = (): boolean => {
    if (!existsSync(paths.socialDb())) return false;
    const probe = new LocalHostDb(paths.socialDb(), {readOnly: true});
    try {
      return !!probe.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_restore_applied_v1'")
        && !!probe.queryOne('SELECT epoch FROM storage_restore_applied_v1 WHERE epoch=?', [epoch!]);
    } finally {probe.close();}
  };
  if (readStorageControl(paths)?.mode === 'recovery' && readStorageControl(paths)?.epoch === epoch && applied()) return {epoch, installationId: receipt.installationId};
  const maintenance = MaintenanceSession.resume(paths, epoch);
  options.failpoint?.('restore-held');
  const excluded = new Set(['vault/social/storage-control.json', 'vault/social/restore-progress.json', '.restore-reservation']);
  for (const file of manifest.files) {
    maintenance.assertCurrent();
    options.sourceMaintenance?.assertCurrent();
    if (excluded.has(file.path)) continue;
    const destination = join(paths.rootDir(), file.path);
    // A restore destination is a quiesced root under a maintenance hold, so
    // both legs below (hash-and-compare, copy-and-rename) are plain-fs work on
    // a file nobody has open. Say so, so that a future caller that restores
    // into a LIVE root is stopped here instead of silently unlinking that
    // root's write-ahead logs.
    assertNoLiveDatabaseDescriptor(destination, 'restore');
    if (existsSync(destination)) {
      if (fileSha256(destination) !== file.sha256 && !(file.path === 'vault/social/my-social-assets.db' && applied())) throw new Error('RESTORE_DESTINATION_CHANGED');
    } else {
      mkdirSync(resolve(destination, '..'), {recursive: true, mode: 0o700});
      const temporary = `${destination}.${epoch}.restore-tmp`;
      copyFileSync(join(options.backupDirectory, 'files', file.path), temporary);
      chmodSync(temporary, 0o600);
      const fd = openSync(temporary, 'r');
      try {fsyncSync(fd);} finally {closeSync(fd);}
      renameSync(temporary, destination);
      const directory = openSync(resolve(destination, '..'), 'r');
      try {fsyncSync(directory);} finally {closeSync(directory);}
    }
    options.failpoint?.(`restored:${file.path}`);
  }
  maintenance.assertCurrent();
  // The backup's registration/lease facts describe its old process, never this restored root.
  const global = new LocalHostDb(paths.socialDb());
  try {
    global.transaction(tx => {
      ensureStorageRestoreSchema(tx);
      if (tx.queryOne('SELECT epoch FROM storage_restore_applied_v1 WHERE epoch=?', [epoch!])) return;
      const has = (name: string) => !!tx.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
      if (has('storage_runtime_participants_v1')) tx.execute('DELETE FROM storage_runtime_participants_v1');
      if (has('house_lifecycle_owner')) tx.execute("UPDATE house_lifecycle_owner SET generation=generation+1, holder='', renewed_at=0");
      if (options.operation === 'clone') {
        tx.execute('CREATE TABLE IF NOT EXISTS house_lifecycle_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
        tx.execute("INSERT INTO house_lifecycle_meta(key,value) VALUES('installation_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [receipt.installationId]);
      }
      tx.execute('INSERT INTO storage_restore_applied_v1 VALUES(?,?,?)', [epoch!, manifest.setId, options.operation]);
      // Per-House op_seq, captured installation/session, grants and uncertain attempts are preserved.
    });
  } finally {global.close();}
  options.failpoint?.('before-recovery-publication');
  maintenance.finish({recovery: true, reason: `${options.operation} ${manifest.setId}: history is evidence, not renewed authority`});
  if (readStorageControl(paths)?.epoch !== epoch) throw new Error('RESTORE_CONTROL_CHANGED');
  // A move intentionally leaves the old source in maintenance. It cannot auto-boot beside the destination.
  return {epoch, installationId: receipt.installationId};
}
