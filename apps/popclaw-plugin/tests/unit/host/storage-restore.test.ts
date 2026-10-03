import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializeActionReceiptJournal, initializeNativeActionJournal } from '../../../src/host/execution-store-migration.js';
import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalHostDb} from '../../../src/host/local-host-db.js';
import {LocalHostAdapter} from '../../../src/host/local-host-adapter.js';
import {PopclawPaths} from '../../../src/host/popclaw-paths.js';
import {MaintenanceSession, storagePathAllowed, readStorageControl, registerStorageRuntime} from '../../../src/host/storage-maintenance.js';
import {createStorageBackup, restoreStorageBackup, tableFingerprint} from '../../../src/host/storage-backup.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function root() {
  const path = mkdtempSync(join(tmpdir(), 'storage-restore-'));
  cleanup.push(() => rmSync(path, {recursive: true, force: true}));
  return new PopclawPaths(path);
}
async function fixture() {
  const paths = root();
  const db = new LocalHostDb(paths.socialDb());
  cleanup.push(() => db.close());
  db.execute('CREATE TABLE house_lifecycle_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.execute("INSERT INTO house_lifecycle_meta VALUES('installation_id','original-installation')");
  db.execute('CREATE TABLE house_lifecycle_owner(id INTEGER PRIMARY KEY, generation INTEGER, holder TEXT, renewed_at INTEGER)');
  db.execute("INSERT INTO house_lifecycle_owner VALUES(1,99,'old-live-holder',9999999999999)");
  db.execute('CREATE TABLE house_participation(op_seq INTEGER, session_id TEXT, installation_id TEXT)');
  db.execute("INSERT INTO house_participation VALUES(83,'old-session','original-installation')");
  db.execute('CREATE TABLE history(bytes BLOB, unknown INTEGER)');
  db.execute('INSERT INTO history(rowid,bytes,unknown) VALUES(47,?,1)', [Uint8Array.of(0,255,128)]);
  const fingerprint = tableFingerprint(db, 'history');
  mkdirSync(paths.identityDir(), {recursive: true});
  writeFileSync(join(paths.identityDir(), 'master.key'), 'synthetic identity');
  const maintenance = MaintenanceSession.begin(db, paths, 'restore fixture');
  const backup = await createStorageBackup({paths, actorId:'synthetic', installationId:'original-installation', codeVersion:'test', maintenance});
  return {paths, db, backup, maintenance, fingerprint};
}
describe('managed move, clone and older restore', () => {
  it.each([false, true])('restores the complete selected action feature under recovery holds (native=%s)', async native => {
    const paths = root(), db = new LocalHostDb(paths.socialDb()); cleanup.push(() => db.close());
    const catalog = new ExecutionStoreCatalog({ db, paths, actorId: 'synthetic' }); cleanup.push(() => catalog.close());
    const origin = 'https://restore-actions.example', partition = catalog.open(origin);
    const maintenance = MaintenanceSession.begin(db, paths, 'action restore fixture');
    initializeActionReceiptJournal({ catalog, origin, maintenance });
    if (native) {
      initializeNativeActionJournal({ catalog, origin, maintenance });
      // Synthetic lossless storage cells, never a claimed execution permit.
      partition.db.execute("INSERT INTO world_native_action_reservations VALUES('binding','r','call','{}','{}','revision','{}','{}',9223372036854775807,42,NULL,'unknown')");
    }
    partition.db.execute('INSERT INTO world_action_client_evidence VALUES(?,?,?,?,?,?,?,?)',
      ['synthetic-binding', 'request', 'status_response', 'source', 'core', Uint8Array.of(255, 0), Uint8Array.of(128, 1), 9]);
    const before = tableFingerprint(partition.db, 'world_action_client_evidence');
    const nativeBefore = native ? tableFingerprint(partition.db, 'world_native_action_reservations') : null;
    const backup = await createStorageBackup({ paths, actorId: 'synthetic', installationId: null, codeVersion: 'test', maintenance });
    const destination = root();
    await restoreStorageBackup({ backupDirectory: backup.directory, destination, operation: 'restore', expectedActorId: 'synthetic' });
    const restoredDb = new LocalHostDb(destination.socialDb()); cleanup.push(() => restoredDb.close());
    const restored = new ExecutionStoreCatalog({ db: restoredDb, paths: destination, actorId: 'synthetic' }); cleanup.push(() => restored.close());
    expect(tableFingerprint(restored.open(origin).db, 'world_action_client_evidence')).toBe(before);
    if (native) expect(tableFingerprint(restored.open(origin).db, 'world_native_action_reservations')).toBe(nativeBefore);
    expect(storagePathAllowed(destination, 'execution')).toBe(false);
    expect(storagePathAllowed(destination, 'consumers')).toBe(false);
    restored.open(origin).db.execute(native ? 'DROP TABLE world_native_action_reservations' : 'DROP TABLE world_action_client_evidence');
    expect(() => restored.open(origin)).toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
    expect(storagePathAllowed(destination, 'execution')).toBe(false);
  });
  it.each(['restore','clone','move'] as const)('%s preserves history and operation sequence but cannot copy live execution authority', async operation => {
    const f = await fixture();
    const destination = root();
    const result = await restoreStorageBackup({backupDirectory:f.backup.directory, destination, operation, expectedActorId:'synthetic', ...(operation==='move' ? {sourceMaintenance:f.maintenance} : {})});
    const db = new LocalHostDb(destination.socialDb());
    try {
      expect(tableFingerprint(db,'history')).toBe(f.fingerprint);
      expect(db.queryOne<{op_seq:number}>('SELECT op_seq FROM house_participation')?.op_seq).toBe(83);
      expect(db.queryOne<{holder:string}>('SELECT holder FROM house_lifecycle_owner')?.holder).toBe('');
      expect(db.queryOne<{generation:number}>('SELECT generation FROM house_lifecycle_owner')?.generation).toBe(100);
      expect(db.queryOne<{value:string}>("SELECT value FROM house_lifecycle_meta WHERE key='installation_id'")?.value).toBe(result.installationId);
      if(operation==='clone') expect(result.installationId).not.toBe('original-installation');
      else expect(result.installationId).toBe('original-installation');
      expect(storagePathAllowed(destination,'execution')).toBe(false);
      expect(storagePathAllowed(destination,'consumers')).toBe(false);
      expect(storagePathAllowed(destination,'notifications')).toBe(false);
      expect(readFileSync(join(destination.identityDir(),'master.key'),'utf8')).toBe('synthetic identity');
      if(operation==='move') expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
    } finally {db.close();}
  });
  it.each(['restore-reserved','restore-control-published','restore-held','restored:vault/social/my-social-assets.db','before-recovery-publication'])('resumes a restore interrupted at %s without a second clone identity or lease generation', async stage => {
    const f=await fixture(), destination=root();
    const options={backupDirectory:f.backup.directory,destination,operation:'clone' as const,expectedActorId:'synthetic'};
    await expect(restoreStorageBackup({...options,failpoint:at=>{if(at===stage)throw new Error('crash');}})).rejects.toThrow('crash');
    const epoch=readStorageControl(destination)?.epoch ?? JSON.parse(readFileSync(join(destination.rootDir(),'.restore-reservation'),'utf8')).epoch;
    expect(storagePathAllowed(destination,'execution')).toBe(false);
    if(stage==='restore-reserved') {
      // The process's early precheck ran before restore claimed this empty root.
      const logger={info() {},warn() {},error() {},debug() {}};
      expect(()=>new LocalHostAdapter({dataRoot:destination.rootDir(),logger,
        beforeDbInitialize:db=>registerStorageRuntime(db,destination)})).toThrow('MAINTENANCE_PENDING');
      expect(existsSync(destination.socialDb())).toBe(false);
    }
    const result=await restoreStorageBackup({...options,resumeEpoch:epoch});
    const again=await restoreStorageBackup({...options,resumeEpoch:epoch});
    expect(again.installationId).toBe(result.installationId);
    const db=new LocalHostDb(destination.socialDb(),{readOnly:true});
    try {expect(db.queryOne<{generation:number}>('SELECT generation FROM house_lifecycle_owner')?.generation).toBe(100);}
    finally {db.close();}
  });
  it('refuses replacing a surviving root and refuses an online component snapshot as a move',async()=>{
    const f=await fixture();
    await expect(restoreStorageBackup({backupDirectory:f.backup.directory,destination:f.paths,operation:'restore',expectedActorId:'synthetic'})).rejects.toThrow('EXISTING_ROOT_FORBIDDEN');
    const online=await createStorageBackup({paths:f.paths,actorId:'synthetic',installationId:'original-installation',codeVersion:'test'});
    await expect(restoreStorageBackup({backupDirectory:online.directory,destination:root(),operation:'move',expectedActorId:'synthetic',sourceMaintenance:f.maintenance})).rejects.toThrow('QUIESCENT_SOURCE_SET');
  });
});
