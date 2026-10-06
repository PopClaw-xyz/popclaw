/** Routine online sets include every owned file/SQLite image. Each DB is WAL-safe,
 * but the set is explicitly component-snapshots; managed restore always enters recovery.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PopclawPaths } from './popclaw-paths.js';
import { createStorageBackup, verifyStorageBackup, type StorageBackupManifest } from './storage-backup.js';

export interface DailyBackupDeps {
  paths: PopclawPaths;
  actorId: string;
  installationId: string | null;
  codeVersion: string;
  date: string;
  keep: number;
}
export async function runDailyBackup(deps: DailyBackupDeps): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(deps.date) || !Number.isSafeInteger(deps.keep) || deps.keep < 1) throw new Error('BACKUP_RETENTION_INVALID');
  // Read tiny manifests first. Verify only a same-day candidate, never every
  // historic database on a restart. Corrupt/incomplete candidates cannot skip.
  if (existsSync(deps.paths.backupsDir())) {
    for (const name of readdirSync(deps.paths.backupsDir())) {
      const directory = join(deps.paths.backupsDir(), name);
      try {
        const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as StorageBackupManifest;
        if (manifest.day !== deps.date || manifest.consistency !== 'component-snapshots'
          || manifest.actorId !== deps.actorId || manifest.installationId !== deps.installationId) continue;
        verifyStorageBackup(directory);
        return;
      } catch { /* An invalid set is evidence, not a successful daily backup. */ }
    }
  }
  await createStorageBackup({...deps, day: deps.date});
  // Prune only verified complete routine sets by local calendar day. Offline migration/export
  // sets, legacy snapshots and incomplete/unknown artifacts remain protected.
  const sets: Array<{directory: string; day: string}> = [];
  for (const name of readdirSync(deps.paths.backupsDir())) {
    const directory = join(deps.paths.backupsDir(), name);
    try {
      const manifest = verifyStorageBackup(directory);
      if (manifest.consistency === 'component-snapshots' && manifest.day) sets.push({directory, day: manifest.day});
    } catch { /* Never delete unclassified or damaged evidence. */ }
  }
  const retained = new Set([...new Set(sets.map(set => set.day))].sort().slice(-deps.keep));
  for (const set of sets) if (!retained.has(set.day)) rmSync(set.directory, {recursive: true});
}
