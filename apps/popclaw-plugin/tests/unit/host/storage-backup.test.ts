import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializeActionReceiptJournal, initializeNativeActionJournal } from '../../../src/host/execution-store-migration.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { MaintenanceSession } from '../../../src/host/storage-maintenance.js';
import { createStorageBackup, verifyStorageBackup, tableFingerprint } from '../../../src/host/storage-backup.js';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'storage-backup-'));
  cleanup.push(() => rmSync(root, {recursive: true, force: true}));
  const paths = new PopclawPaths(root);
  const db = new LocalHostDb(paths.socialDb());
  cleanup.push(() => db.close());
  db.execute('CREATE TABLE history(value BLOB, seq INTEGER)');
  db.execute("INSERT INTO history(rowid,value,seq) VALUES(99,?,9223372036854775807)", [Uint8Array.of(255, 0, 128)]);
  mkdirSync(paths.identityDir(), {recursive: true});
  writeFileSync(join(paths.identityDir(), 'master.key'), 'synthetic-not-a-real-key');
  return {paths, db};
}
describe('complete immutable backup sets', () => {
  it('captures committed WAL, exact rowids, large integers and identity files', async () => {
    const {db, paths} = fixture();
    const maintenance = MaintenanceSession.begin(db, paths, 'synthetic backup');
    const {directory} = await createStorageBackup({paths, actorId: 'synthetic', installationId: 'synthetic-installation', codeVersion: 'test', maintenance});
    const manifest = verifyStorageBackup(directory);
    expect(manifest.consistency).toBe('quiescent-set');
    const snapshot = new LocalHostDb(join(directory, 'files/vault/social/my-social-assets.db'), {readOnly: true});
    cleanup.push(() => snapshot.close());
    expect(tableFingerprint(snapshot, 'history')).toBe(tableFingerprint(db, 'history'));
    expect(readFileSync(join(directory, 'files/vault/social/identity/master.key'), 'utf8')).toBe('synthetic-not-a-real-key');
  });
  it('keeps a previous complete set when the next attempt fails before manifest publication', async () => {
    const {paths} = fixture();
    const options = {paths, actorId: 'synthetic', installationId: null, codeVersion: 'test'};
    const first = await createStorageBackup(options);
    await expect(createStorageBackup({...options, failpoint: stage => {if (stage === 'before-manifest') throw new Error('power loss');}})).rejects.toThrow('power loss');
    expect(verifyStorageBackup(first.directory).consistency).toBe('component-snapshots');
    expect(readdirSync(paths.backupsDir()).filter(dir => existsSync(join(paths.backupsDir(), dir, 'manifest.json')))).toHaveLength(1);
  });
  it.each([false, true])('verifies action feature shape in backups and refuses malformed schema (native=%s)', async native => {
    const { db, paths } = fixture();
    const catalog = new ExecutionStoreCatalog({ db, paths, actorId: 'synthetic' }); cleanup.push(() => catalog.close());
    const origin = 'https://backup-actions.example', partition = catalog.open(origin);
    const maintenance = MaintenanceSession.begin(db, paths, 'action backup fixture');
    initializeActionReceiptJournal({ catalog, origin, maintenance });
    if (native) initializeNativeActionJournal({ catalog, origin, maintenance });
    const options = { paths, actorId: 'synthetic', installationId: null, codeVersion: 'test', maintenance };
    const backup = await createStorageBackup(options);
    expect(verifyStorageBackup(backup.directory).consistency).toBe('quiescent-set');
    partition.db.execute(native ? 'ALTER TABLE world_native_action_reservations DROP COLUMN policy_scope_json' : 'ALTER TABLE world_action_client_results DROP COLUMN receipt_state');
    await expect(createStorageBackup(options)).rejects.toThrow();
    // A subsequent damaged source does not invalidate the earlier complete set.
    expect(verifyStorageBackup(backup.directory).consistency).toBe('quiescent-set');
  });

});
describe('what a backup set leaves out', () => {
  it('never captures draft review copies', async () => {
    const {paths} = fixture();
    mkdirSync(paths.draftReviewDir(), {recursive: true});
    writeFileSync(join(paths.draftReviewDir(), 'message-1-abcd.md'), 'a plaintext letter that lives only as long as its draft');
    const {directory, manifest} = await createStorageBackup({paths, actorId: 'synthetic', installationId: null, codeVersion: 'test'});
    expect(manifest.files.some((file) => file.path.startsWith('data/review'))).toBe(false);
    expect(existsSync(join(directory, 'files/data/review'))).toBe(false);
    expect(manifest.files.some((file) => file.path.endsWith('master.key'))).toBe(true);
  });
});
