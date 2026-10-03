import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, mkdirSync, lstatSync, accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HostDb } from './host-db.js';
import type { PopclawPaths } from './popclaw-paths.js';

export type RecoveryPath = 'execution' | 'consumers' | 'notifications';
export interface StorageControl {
  version: 1;
  epoch: string;
  mode: 'maintenance' | 'recovery' | 'normal';
  reason: string;
  held: RecoveryPath[];
  releases: Partial<Record<RecoveryPath, { policy: string; evidence: string }>>;
  priorRecovery?: {held: RecoveryPath[]; releases: StorageControl['releases']};
}
const databasePaths = new WeakMap<HostDb, PopclawPaths>();
/** No historical certification: only the supported in-place subset with
 * positively readable metadata and no managed restore/clone/move trace. */
export function storageInPlaceHistoryKnown(db: HostDb): boolean {
  const paths = databasePaths.get(db);
  if (!paths) return false;
  try {
    accessSync(paths.rootDir(), constants.R_OK);
    if (!storageDatabasePathAllowed(db, 'execution')) return false;
    for (const file of [join(paths.rootDir(), '.restore-reservation'), join(paths.vaultSocialDir(), 'restore-progress.json')]) {
      try { lstatSync(file); return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    }
    const table = db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_restore_applied_v1'");
    if (table && db.queryOne('SELECT 1 FROM storage_restore_applied_v1 LIMIT 1')) return false;
    return true;
  } catch { return false; }
}
export function storageDatabasePathAllowed(db: HostDb, path: RecoveryPath, suppliedPaths?: PopclawPaths): boolean {
  const paths = suppliedPaths ?? databasePaths.get(db);
  if (!paths) return true;
  if (!readStorageControl(paths) && db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='storage_control_required_v1'")) return false;
  return storagePathAllowed(paths, path);
}
export function assertStorageBootstrap(paths: PopclawPaths): void {
  const control = readStorageControl(paths);
  if (control?.mode === 'maintenance' || (!control && existsSync(join(paths.rootDir(), '.restore-reservation')))) throw new Error('STORAGE_MAINTENANCE_PENDING');
}
const ALL_PATHS: RecoveryPath[] = ['execution', 'consumers', 'notifications'];

/** Atomic durable publication. A partial temporary file never becomes the selected control state. */
export function publishStorageJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
export function readStorageControl(paths: PopclawPaths): StorageControl | null {
  if (!existsSync(paths.storageControlFile())) return null;
  const row = JSON.parse(readFileSync(paths.storageControlFile(), 'utf8')) as StorageControl;
  if (row.version !== 1 || typeof row.epoch !== 'string' || !['normal', 'maintenance', 'recovery'].includes(row.mode)
    || !Array.isArray(row.held) || row.held.some(path => !ALL_PATHS.includes(path))) throw new Error('STORAGE_CONTROL_INVALID');
  return row;
}
export function storagePathAllowed(paths: PopclawPaths, path: RecoveryPath): boolean {
  const row = readStorageControl(paths);
  if (!row && existsSync(join(paths.rootDir(), '.restore-reservation'))) return false;
  return !row || (row.mode !== 'maintenance' && !row.held.includes(path));
}
export function assertStoragePath(paths: PopclawPaths, path: RecoveryPath): void {
  if (!storagePathAllowed(paths, path)) throw new Error(`STORAGE_RECOVERY_HELD: ${path}`);
}

/** Opaque evidence of an offline, fenced root; expires by epoch, never by elapsed time. */
export class MaintenanceSession {
  private constructor(readonly paths: PopclawPaths, readonly epoch: string) {}
  static begin(db: HostDb, paths: PopclawPaths, reason: string): MaintenanceSession {
    if (!reason.trim()) throw new Error('STORAGE_REASON_REQUIRED');
    return db.transaction(tx => {
      const current = readStorageControl(paths);
      if (current?.mode === 'maintenance') throw new Error('STORAGE_MAINTENANCE_PENDING');
      ensureParticipants(tx);
      // No TTL takeover: an expired lease cannot prove an uncancellable call has finished.
      const participants = tx.queryAll<{token: string; pid: number}>('SELECT token,pid FROM storage_runtime_participants_v1');
      for (const row of participants) {
        let dead = false;
        try { process.kill(row.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) throw new Error('STORAGE_ROOT_NOT_QUIESCENT');
        tx.execute('DELETE FROM storage_runtime_participants_v1 WHERE token=?', [row.token]);
      }
      const epoch = randomBytes(16).toString('hex');
      tx.execute('CREATE TABLE IF NOT EXISTS storage_control_required_v1(id INTEGER PRIMARY KEY CHECK(id=1))');
      tx.execute('INSERT OR IGNORE INTO storage_control_required_v1 VALUES(1)');
      publishStorageJson(paths.storageControlFile(), {
        version: 1, epoch, mode: 'maintenance', reason, held: ALL_PATHS, releases: {},
        ...(current?.mode === 'recovery' ? {priorRecovery: {held: current.held, releases: current.releases}} : {}),
      } satisfies StorageControl);
      return new MaintenanceSession(paths, epoch);
    });
  }
  /** Explicitly continue a interrupted maintenance operation; does not release execution. */
  static resume(paths: PopclawPaths, epoch: string): MaintenanceSession {
    const session = new MaintenanceSession(paths, epoch);
    session.assertCurrent();
    return session;
  }
  assertCurrent(): void {
    const row = readStorageControl(this.paths);
    if (row?.mode !== 'maintenance' || row.epoch !== this.epoch) throw new Error('STORAGE_MAINTENANCE_TOKEN_STALE');
  }
  finish(options: { recovery: boolean; reason: string }): void {
    this.assertCurrent();
    const previous = readStorageControl(this.paths)?.priorRecovery;
    publishStorageJson(this.paths.storageControlFile(), {
      version: 1, epoch: this.epoch, mode: options.recovery || previous ? 'recovery' : 'normal',
      reason: options.reason, held: options.recovery ? ALL_PATHS : previous?.held ?? [], releases: previous?.releases ?? {},
    } satisfies StorageControl);
  }
}
function ensureParticipants(db: HostDb): void {
  db.execute('CREATE TABLE IF NOT EXISTS storage_runtime_participants_v1(token TEXT PRIMARY KEY, pid INTEGER NOT NULL)');
}
/** Register before starting any root writer; release only after all owned promises have joined. */
export function registerStorageRuntime(db: HostDb, paths: PopclawPaths): () => void {
  const token = randomBytes(16).toString('hex');
  databasePaths.set(db, paths);
  db.transaction(tx => {
    assertStorageBootstrap(paths);
    ensureParticipants(tx);
    tx.execute('INSERT INTO storage_runtime_participants_v1 VALUES(?,?)', [token, process.pid]);
  });
  return () => { db.execute('DELETE FROM storage_runtime_participants_v1 WHERE token=?', [token]); };
}
/** Separate releases cannot erase historical rows or let a model grant release notifications. */
export function releaseRecoveryPath(db: HostDb, paths: PopclawPaths, epoch: string, path: RecoveryPath, decision: {policy: string; evidence: string}): void {
  db.transaction(() => {
  const row = readStorageControl(paths);
  if (!ALL_PATHS.includes(path)) throw new Error('STORAGE_RECOVERY_PATH_INVALID');
  if (row?.mode !== 'recovery' || row.epoch !== epoch) throw new Error('STORAGE_RECOVERY_EPOCH_MISMATCH');
  if (!decision.policy.trim() || !decision.evidence.trim()) throw new Error('STORAGE_RECOVERY_EVIDENCE_REQUIRED');
  publishStorageJson(paths.storageControlFile(), {...row, held: row.held.filter(item => item !== path), releases: {...row.releases, [path]: decision}});
  });
}
