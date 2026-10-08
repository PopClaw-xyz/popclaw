import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { LocalHostAdapter } from '../../../src/host/local-host-adapter.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { MaintenanceSession, registerStorageRuntime, storagePathAllowed, releaseRecoveryPath } from '../../../src/host/storage-maintenance.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-maintenance-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const paths = new PopclawPaths(root);
  const db = new LocalHostDb(paths.socialDb());
  cleanup.push(() => db.close());
  return {paths, db};
}
describe('offline storage maintenance', () => {
  it('refuses live participants, including same-PID participants, until their full shutdown releases them', () => {
    const {db, paths} = fixture();
    const release = registerStorageRuntime(db, paths);
    expect(() => MaintenanceSession.begin(db, paths, 'migration')).toThrow('NOT_QUIESCENT');
    release();
    const session = MaintenanceSession.begin(db, paths, 'migration');
    expect(() => registerStorageRuntime(db, paths)).toThrow('MAINTENANCE_PENDING');
    expect(storagePathAllowed(paths, 'execution')).toBe(false);
    session.finish({recovery: false, reason: 'verified migration'});
    expect(storagePathAllowed(paths, 'execution')).toBe(true);
    expect(() => session.assertCurrent()).toThrow('TOKEN_STALE');
  });
  it('registers before startup migrations even when maintenance begins after the root precheck', () => {
    const {db, paths} = fixture();
    const migrations = join(paths.rootDir(), 'test-migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '001-probe.sql'), 'CREATE TABLE startup_probe(value INTEGER); INSERT INTO startup_probe VALUES(1);');
    const maintenance = MaintenanceSession.begin(db, paths, 'won startup race');
    const logger = {info() {}, warn() {}, error() {}, debug() {}};
    expect(() => new LocalHostAdapter({dataRoot: paths.rootDir(), logger, migrationsDir: migrations,
      beforeDbInitialize: candidate => registerStorageRuntime(candidate, paths)})).toThrow('MAINTENANCE_PENDING');
    expect(db.queryOne("SELECT name FROM sqlite_master WHERE name='startup_probe'")).toBeNull();
    maintenance.assertCurrent();
  });
  it('releases admission when adapter SQL migration fails before a runtime exists', () => {
    const existing = fixture(), paths = new PopclawPaths(join(existing.paths.rootDir(), 'fresh-start'));
    const migrations = join(existing.paths.rootDir(), 'bad-migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, '001-bad.sql'), 'INSERT INTO missing_table VALUES(1);');
    const logger = {info() {}, warn() {}, error() {}, debug() {}};
    expect(() => new LocalHostAdapter({dataRoot: paths.rootDir(), logger, migrationsDir: migrations,
      beforeDbInitialize: candidate => registerStorageRuntime(candidate, paths)})).toThrow('missing_table');
    const db = new LocalHostDb(paths.socialDb());
    cleanup.push(() => db.close());
    expect(db.queryAll('SELECT token FROM storage_runtime_participants_v1')).toEqual([]);
    MaintenanceSession.begin(db, paths, 'failed migration is closed').assertCurrent();
  });
  it('holds all rollback-dependent paths after restart and releases each by its own recorded decision', () => {
    const {db, paths} = fixture();
    const session = MaintenanceSession.begin(db, paths, 'restore old backup');
    MaintenanceSession.resume(paths, session.epoch).finish({recovery: true, reason: 'historical lower bound'});
    db.close();
    const reopened = new LocalHostDb(paths.socialDb());
    cleanup.push(() => reopened.close());
    expect(storagePathAllowed(paths, 'consumers')).toBe(false);
    releaseRecoveryPath(reopened, paths, session.epoch, 'execution', {policy: 'future facts only', evidence: 'explicit synthetic decision'});
    expect(storagePathAllowed(paths, 'execution')).toBe(true);
    expect(storagePathAllowed(paths, 'notifications')).toBe(false);
    expect(storagePathAllowed(paths, 'consumers')).toBe(false);
    expect(() => releaseRecoveryPath(reopened, paths, 'old epoch', 'notifications', {policy: 'x', evidence: 'y'})).toThrow('EPOCH_MISMATCH');
  });
});
