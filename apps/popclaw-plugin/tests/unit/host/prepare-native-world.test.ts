import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareNativeWorld, releaseNativeWorld } from '../../../scripts/prepare-native-world.js';
import { ExecutionStoreCatalog, privateMessageFeatureCertification, verifyExecutionPartition, type ExecutionCatalogRow } from '../../../src/host/execution-store.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { LocalHostAdapter } from '../../../src/host/local-host-adapter.js';
import { Keystore } from '../../../src/identity/keystore.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { publishStorageJson, readStorageControl, registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { openUnprovisionedPartition } from '../../helpers/unprovisioned-partition.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });
async function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'native-prepare-'))); roots.push(base);
  const root = join(base, 'root'); mkdirSync(root); const paths = new PopclawPaths(root);
  const host = new LocalHostAdapter({dataRoot: root, logger: {info() {}, warn() {}, error() {}}});
  const identity = await new Keystore(host).loadOrGenerate(); host.db.close();
  return {paths, options: {root, actor: identity.popclawId, house: 'http://127.0.0.1:48180', offlineConfirmed: true,
    output: join(base, 'receipt.json'), codeVersion: 'test'}, key: readFileSync(join(paths.identityDir(), 'master.key'))};
}
describe('offline native journal operator entry', () => {
  it('runs no offline private preparation by default, yet publishes the factory credential', async () => {
    const f = await fixture(), result = await prepareNativeWorld(f.options);
    // The offline preparation is still opt-in: it did not run here.
    expect(result.receipt.privateMessages).toBeUndefined();
    const db = new LocalHostDb(f.paths.socialDb(), {readOnly: true});
    try {
      // The partition was born from the factory, so its first published row
      // already carries the private-message schema credential.
      const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1 WHERE origin=?', [f.options.house])!;
      expect(row.private_message_feature).toBe(privateMessageFeatureCertification('certified'));
    } finally { db.close(); }
  });
  it.each(['fresh', 'existing', 'pre-factory'] as const)('explicitly certifies private messages and releases three paths (catalog: %s)', async catalogState => {
    const f = await fixture();
    if (catalogState !== 'fresh') {
      const db = new LocalHostDb(f.paths.socialDb()), catalog = new ExecutionStoreCatalog({db, paths: f.paths, actorId: f.options.actor});
      if (catalogState === 'existing') { catalog.open(f.options.house); catalog.open('https://other.example'); }
      else openUnprovisionedPartition({catalog, db, paths: f.paths, actorId: f.options.actor, origin: f.options.house});
      catalog.close(); db.close();
    }
    const result = await prepareNativeWorld({...f.options, privateMessages: true});
    // The offline entrance still creates both tables on a partition that
    // predates the factory; on a factory-born one it finds and preserves them.
    expect(result.receipt.privateMessages?.createdTables).toHaveLength(catalogState === 'pre-factory' ? 2 : 0);
    expect(Object.keys(result.receipt.privateMessages?.preservedRowCounts ?? {})).toHaveLength(catalogState === 'pre-factory' ? 0 : 2);
    expect(result.receipt.privateContent).toBeDefined();
    for (const path of ['execution', 'consumers', 'notifications'] as const) {
      await releaseNativeWorld({...f.options, receipt: f.options.output, sha256: result.sha256, epoch: result.receipt.epoch, path});
    }
    expect(readStorageControl(f.paths)?.held).toEqual([]);
    expect(readFileSync(join(f.paths.identityDir(), 'master.key'))).toEqual(f.key);
  });
  it.each(['content', 'schema', 'reservation'] as const)('rejects private %s changes at release', async damage => {
    const f = await fixture(), result = await prepareNativeWorld({...f.options, privateMessages: true});
    const db = new LocalHostDb(damage === 'reservation' ? f.paths.socialDb() : f.paths.executionDb(result.receipt.native.partition.storeId));
    if (damage === 'content') db.execute("INSERT INTO world_private_states_v2 VALUES('b','s','1','d','m')");
    if (damage === 'schema') db.execute('CREATE INDEX forged_private ON world_private_states_v2(state_ref)');
    if (damage === 'reservation') db.execute("UPDATE execution_store_catalog_v1 SET private_message_feature=NULL");
    db.close();
    await expect(releaseNativeWorld({...f.options, receipt: f.options.output, sha256: result.sha256, epoch: result.receipt.epoch, path: 'execution'})).rejects.toThrow();
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  });
  it('retains all holds after private preparation fails', async () => {
    const f = await fixture();
    await expect(prepareNativeWorld({...f.options, privateMessages: true, failpoint: stage => {
      if (stage === 'private') throw new Error('interrupted');
    }})).rejects.toThrow('interrupted');
    expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  });

  it('accepts the explicit private flag through the real offline CLI', async () => {
    const f = await fixture(), plugin = fileURLToPath(new URL('../../../', import.meta.url));
    const result = spawnSync(process.execPath, ['--import', resolve(plugin, 'node_modules/tsx/dist/loader.mjs'),
      resolve(plugin, 'scripts/prepare-native-world.ts'), 'prepare', '--root', f.options.root, '--actor', f.options.actor,
      '--house', f.options.house, '--offline-confirmed', '--output', f.options.output, '--code-version', 'test', '--private-messages'], {encoding: 'utf8'});
    expect(result.status, result.stderr).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(f.options.output, 'utf8')).privateMessages.preservedRowCounts)).toHaveLength(2);
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  });

  it.each(['directory', 'file'] as const)('runs the CLI through a %s symlink', kind => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'native-cli-alias-'))); roots.push(base);
    const plugin = fileURLToPath(new URL('../../../', import.meta.url));
    const source = resolve(plugin, 'scripts/prepare-native-world.ts');
    const alias = join(base, kind === 'directory' ? 'package-alias' : 'helper-alias.ts');
    symlinkSync(kind === 'directory' ? plugin : source, alias);
    const entry = kind === 'directory' ? join(alias, 'scripts/prepare-native-world.ts') : alias;
    const result = spawnSync(process.execPath, ['--import', resolve(plugin, 'node_modules/tsx/dist/loader.mjs'), entry, '--help'], {encoding: 'utf8'});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Offline native world journal preparation.');
    expect(result.stdout).toContain('--path execution|consumers|notifications');
  });

  it('can be imported without starting the CLI when argv names no entry file', () => {
    const plugin = fileURLToPath(new URL('../../../', import.meta.url));
    const source = pathToFileURL(resolve(plugin, 'scripts/prepare-native-world.ts')).href;
    const program = `process.argv[1] = 'not-a-cli-entry'; await import(${JSON.stringify(source)}); console.log('imported');`;
    const result = spawnSync(process.execPath, ['--import', resolve(plugin, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', program], {encoding: 'utf8'});
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('imported');
  });
  it('preserves identity and explicitly releases only new execution/consumer holds without database writes', async () => {
    const f = await fixture(), result = await prepareNativeWorld(f.options);
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
    const before = readFileSync(f.paths.socialDb()), execution = f.paths.executionDb(result.receipt.native.partition.storeId);
    const beforeExecution = readFileSync(execution);
    const args = {...f.options, receipt: f.options.output, sha256: result.sha256, epoch: result.receipt.epoch};
    await releaseNativeWorld({...args, path: 'execution'});
    await expect(releaseNativeWorld({...args, path: 'execution'})).rejects.toThrow('OFFLINE_RELEASE_STALE');
    await releaseNativeWorld({...args, path: 'consumers'});
    expect(readStorageControl(f.paths)?.held).toEqual(['notifications']);
    await releaseNativeWorld({...args, path: 'notifications'});
    await expect(releaseNativeWorld({...args, path: 'notifications'})).rejects.toThrow('OFFLINE_RELEASE_STALE');
    expect(readStorageControl(f.paths)?.held).toEqual([]);
    expect(readFileSync(f.paths.socialDb())).toEqual(before); expect(readFileSync(execution)).toEqual(beforeExecution);
    expect(readFileSync(join(f.paths.identityDir(), 'master.key'))).toEqual(f.key);
  });
  it('rejects wrong actor and a live writer before preparing', async () => {
    const f = await fixture();
    await expect(prepareNativeWorld({...f.options, actor: '1'.repeat(32)})).rejects.toThrow('OFFLINE_ACTOR_MISMATCH');
    const db = new LocalHostDb(f.paths.socialDb()), unregister = registerStorageRuntime(db, f.paths);
    await expect(prepareNativeWorld(f.options)).rejects.toThrow('STORAGE_ROOT_NOT_QUIESCENT');
    unregister(); db.close(); expect(readStorageControl(f.paths)).toBeNull();
  });
  it.each(['backup', 'action'] as const)('retains maintenance holds when interrupted after %s', async stage => {
    const f = await fixture();
    await expect(prepareNativeWorld({...f.options, failpoint: at => { if (at === stage) throw new Error('interrupted'); }})).rejects.toThrow('interrupted');
    expect(readStorageControl(f.paths)?.mode).toBe('maintenance');
    expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
    const db = new LocalHostDb(f.paths.socialDb(), {readOnly: true});
    try {
      if (stage === 'backup') expect(db.queryOne("SELECT name FROM sqlite_master WHERE name='execution_store_catalog_v1'")).toBeNull();
      else {
        // An interruption publishes no evidence and leaves no half-built
        // partition: what the controlled creation built still verifies whole.
        expect(readFileSync(f.options.output, 'utf8')).toBe('');
        const row = db.queryOne<ExecutionCatalogRow>('SELECT * FROM execution_store_catalog_v1')!;
        const partition = new LocalHostDb(f.paths.executionDb(row.store_id), {readOnly: true});
        try { verifyExecutionPartition(partition, row, f.options.actor); }
        finally { partition.close(); }
      }
    } finally { db.close(); }
  });
  it('does not restore notifications after original business data changes', async () => {
    const f = await fixture(); let db = new LocalHostDb(f.paths.socialDb());
    db.execute('CREATE TABLE prior_notification_receipts(id INTEGER PRIMARY KEY, payload BLOB)');
    db.execute("INSERT INTO prior_notification_receipts VALUES(1,x'001122')"); db.close();
    const result = await prepareNativeWorld(f.options);
    db = new LocalHostDb(f.paths.socialDb()); db.execute("UPDATE prior_notification_receipts SET payload=x'334455' WHERE id=1"); db.close();
    await expect(releaseNativeWorld({...f.options, receipt: f.options.output, sha256: result.sha256,
      epoch: result.receipt.epoch, path: 'notifications'})).rejects.toThrow('OFFLINE_ORIGINAL_GLOBAL_CONTENT_CHANGED');
    expect(readStorageControl(f.paths)?.held).toContain('notifications');
  });
  it('refuses stale epoch, tampered evidence, and preexisting recovery holds', async () => {
    const f = await fixture();
    publishStorageJson(f.paths.storageControlFile(), {version: 1, epoch: 'previous', mode: 'recovery', reason: 'previous incident', held: ['execution'], releases: {}});
    const result = await prepareNativeWorld(f.options), args = {...f.options, receipt: f.options.output, sha256: result.sha256, epoch: result.receipt.epoch, path: 'execution' as const};
    await expect(releaseNativeWorld({...args, epoch: 'wrong'})).rejects.toThrow('OFFLINE_RECEIPT_BINDING_INVALID');
    await expect(releaseNativeWorld(args)).rejects.toThrow('OFFLINE_PRIOR_HOLD_REQUIRES_SEPARATE_RECOVERY');
    writeFileSync(f.options.output, '{}');
    await expect(releaseNativeWorld(args)).rejects.toThrow('OFFLINE_RECEIPT_HASH_MISMATCH');
    expect(readStorageControl(f.paths)?.held).toContain('execution');
  });
});
