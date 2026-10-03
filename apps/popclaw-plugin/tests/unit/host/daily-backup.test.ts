import {afterEach, describe, expect, it} from 'vitest';
import {mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalHostDb} from '../../../src/host/local-host-db.js';
import {PopclawPaths} from '../../../src/host/popclaw-paths.js';
import {ExecutionStoreCatalog} from '../../../src/host/execution-store.js';
import {runDailyBackup} from '../../../src/host/daily-backup.js';
import {verifyStorageBackup} from '../../../src/host/storage-backup.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'daily-storage-set-'));
 cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const paths=new PopclawPaths(root),db=new LocalHostDb(paths.socialDb());
 cleanup.push(()=>db.close());
 db.execute('CREATE TABLE history(bytes BLOB)');
 db.execute('INSERT INTO history VALUES(?)',[Uint8Array.of(0,255)]);
 return {paths,db,actorId:'synthetic',installationId:null,codeVersion:'test',date:'2026-09-08',keep:1};
}
describe('routine component backup retention',()=>{
 it('publishes distinct same-day sets instead of overwriting a previous complete set',async()=>{
  const f=fixture();await runDailyBackup(f);await runDailyBackup(f);
  const sets=readdirSync(f.paths.backupsDir());expect(sets).toHaveLength(2);
  for(const set of sets)expect(verifyStorageBackup(join(f.paths.backupsDir(),set)).consistency).toBe('component-snapshots');
 });
 it('refuses a missing required durable table without deleting the last good backup',async()=>{
  const f=fixture(),catalog=new ExecutionStoreCatalog({db:f.db,paths:f.paths,actorId:f.actorId});
  // The factory publishes this table as a reserved name; dropping it later is
  // the missing-required-table case the backup must refuse.
  const part=catalog.open('https://synthetic.example');
  catalog.close();
  await runDailyBackup({...f,date:'2026-09-07'});
  const previous=join(f.paths.backupsDir(),readdirSync(f.paths.backupsDir())[0]!);
  const damaged=new LocalHostDb(part.path);
  try {damaged.execute('DROP TABLE world_action_client_requests');} finally {damaged.close();}
  await expect(runDailyBackup(f)).rejects.toThrow('EXECUTION_REQUIRED_TABLE_MISSING');
  expect(existsSync(previous)).toBe(true);
  expect(verifyStorageBackup(previous).files.some(file=>file.path.endsWith(part.storeId+'.db'))).toBe(true);
 });
 it('counts retained days and preserves unclassified incomplete and old standalone backups',async()=>{
  const f=fixture();await runDailyBackup({...f,date:'2026-09-07'});
  const previous=readdirSync(f.paths.backupsDir())[0]!;
  const incomplete=join(f.paths.backupsDir(),'unknown-incomplete');mkdirSync(incomplete);writeFileSync(join(incomplete,'original'), 'keep');
  const legacy=join(f.paths.backupsDir(),'my-social-assets-2026-01-01.db');writeFileSync(legacy,'keep');
  await runDailyBackup(f);
  expect(existsSync(join(f.paths.backupsDir(),previous))).toBe(false);
  expect(existsSync(incomplete)).toBe(true);expect(existsSync(legacy)).toBe(true);
 });
});
