import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { createStorageBackup, verifyStorageBackup } from '../../../src/host/storage-backup.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'efficiency-backup-')); roots.push(root);
 const paths = new PopclawPaths(root);
 const db = new LocalHostDb(paths.socialDb()); db.execute('CREATE TABLE history(n INTEGER)'); db.close();
 return { paths, actorId: 'synthetic', installationId: null, codeVersion: 'test' };
}
it('captures the known historical ghost-purge SQLite backup using the backup API', async () => {
 const f = fixture(); const file = f.paths.lorehouseDb('house-popclaw-me') + '.bak-pre-ghost-purge-20260731-1000';
 const legacy = new LocalHostDb(file); legacy.execute('CREATE TABLE preserved(n INTEGER)'); legacy.execute('INSERT INTO preserved VALUES(123)'); legacy.close();
 try {
  const result = await createStorageBackup(f);
  const member = verifyStorageBackup(result.directory).files.find(row => row.path.endsWith('.bak-pre-ghost-purge-20260731-1000'));
  expect(member?.sqlite).toBe(true); expect(member?.tables?.preserved).toBe(1);
 } finally { legacy.close(); }
});
it('removes only its own incomplete attempt and preserves prior evidence on failure', async () => {
 const f = fixture(); const good = await createStorageBackup(f);
 const old = join(f.paths.backupsDir(), 'old-incomplete'); mkdirSync(old); writeFileSync(join(old, 'evidence'), 'keep');
 const before = readdirSync(f.paths.backupsDir()).sort();
 await expect(createStorageBackup({ ...f, failpoint: () => { throw new Error('injected'); } })).rejects.toThrow('injected');
 expect(readdirSync(f.paths.backupsDir()).sort()).toEqual(before);
 expect(existsSync(join(old, 'evidence'))).toBe(true); expect(verifyStorageBackup(good.directory).files.length).toBeGreaterThan(0);
});
it('still refuses an unknown SQLite path and leaves no attempt directory', async () => {
 const f = fixture(); const unknown = new LocalHostDb(join(f.paths.rootDir(), 'unknown.sqlite'));
 unknown.execute('CREATE TABLE x(n INTEGER)'); unknown.close();
 await expect(createStorageBackup(f)).rejects.toThrow('BACKUP_UNCLASSIFIED_DATABASE');
 expect(readdirSync(f.paths.backupsDir())).toEqual([]);
});
