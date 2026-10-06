import {expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {gatewayRuntimePorts} from '../../../src/host/openclaw-runtime-ports.js';
import {LocalHostDb} from '../../../src/host/local-host-db.js';
import {PopclawPaths} from '../../../src/host/popclaw-paths.js';
import {RuntimeOwnerNotifier} from '../../../src/notifier/owner-notifier.js';
import {guardedShutdown} from '../../../src/runtime/assembly/core.js';
import {readIntegrityState} from '../../../src/host/integrity-check.js';

async function scenario(shutdownBeforeDelivery: boolean, delivered: boolean) {
 const directory = mkdtempSync(join(tmpdir(), 'integrity-held-alert-'));
 const paths = new PopclawPaths(directory), db = new LocalHostDb(paths.socialDb());
 db.execute('CREATE TABLE p(id INTEGER PRIMARY KEY)');
 db.execute('CREATE TABLE c(parent INTEGER REFERENCES p(id))');
 db.execute('PRAGMA foreign_keys=OFF'); db.execute('INSERT INTO c VALUES(99)'); db.execute('PRAGMA foreign_keys=ON');
 const events: string[] = []; let release!: () => void, entered!: () => void;
 const deliveryEntered = new Promise<void>(resolve => {entered = resolve;});
 const delivery = vi.spyOn(RuntimeOwnerNotifier.prototype, 'deliverNow').mockImplementation(async () => {
  events.push('alert.entered'); entered(); await new Promise<void>(resolve => {release = resolve;}); return delivered;
 });
 const noop = () => {};
 const host: any = {db};
 const api: any = {config: {}, logger: {info: noop, warn: noop, error: noop}, runtime: {state: {resolveStateDir: () => directory}}};
 const ports = gatewayRuntimePorts({api, host, build: 'fixture', storagePaths: paths, releaseStorage: noop,
  llmComplete: async () => '', favoritesFile: () => '', root: {l2: {clear: noop, notifier: noop, nameOf: noop, pendingFollows: noop, proposals: noop},
   markStorageShuttingDown: () => events.push('shutdown.mark'), snapshotStorageBackups: () => []}});
 let task: Promise<void> | undefined;
 try {
  (ports.delivery as any).open({notifier: {}, houses: {}, paths, ownerNotifyTargetStore: {}});
  ports.lifecycle.checkIntegrity!({paths, houseStores: []});
  await deliveryEntered; // Real child scan finished and entered the held delivery.
  const shutdown = guardedShutdown({host, platform: {releaseStorage: noop} as any, log: {warn: noop} as any,
   hostOps: ports.lifecycle.guardedShutdown!, lane: {stop: noop} as any, worlds: {stop: noop, whenIdle: async () => {}} as any,
   reception: {stop: noop}, houses: {stop: async () => {}} as any, houseStores: [], executionStores: {close: () => events.push('execution.close')} as any});
  if (shutdownBeforeDelivery) {
   const before = readFileSync(paths.dbIntegrityFile(), 'utf8');
   let finished = false;
   task = shutdown().then(() => {finished = true;});
   await new Promise(resolve => setTimeout(resolve, 150));
   expect({finished, executionClosed: events.includes('execution.close'), drainTasks: ports.lifecycle.guardedShutdown!.snapshotStorageBackups().length})
    .toEqual({finished: true, executionClosed: true, drainTasks: 0});
   release(); await new Promise(resolve => setImmediate(resolve)); await task;
   expect(readFileSync(paths.dbIntegrityFile(), 'utf8')).toBe(before);
  } else {
   release(); await new Promise(resolve => setImmediate(resolve));
   expect(readIntegrityState(paths.dbIntegrityFile()).social?.announced).toBe(delivered ? 'foreign_key_check' : undefined);
   await shutdown();
  }
 } finally {
  release?.(); await task; delivery.mockRestore(); db.close(); rmSync(directory, {recursive: true, force: true});
 }
}
it('drains the scanner and closes databases while alert delivery remains held; late success writes no state', async () => {
 await scenario(true, true);
});
it('marks delivered findings only after real success while the runtime is active', async () => {
 await scenario(false, true);
});
it('preserves an undelivered finding for the next boot', async () => {
 await scenario(false, false);
});
