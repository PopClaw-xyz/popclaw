import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { HouseCommandBus } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { neverControlSubset } from '../../../src/runtime/house-lifecycle/legacy-history.js';
import { ResidentLifecycle } from '../../../src/runtime/house-lifecycle/resident.js';
import { readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { pinConfiguredHouses } from '../../../src/social-graph/default-house-pinning.js';
import { makeRelationBindingPreparer } from '../../../src/social-graph/relation-binding.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const ORIGIN = 'https://first-pin.invalid';
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'first-pin-'));
  const db = new LocalHostDb(join(root, 'host.db'));
  runMigrations(db, MIGRATIONS);
  const paths = new PopclawPaths(root);
  const release = registerStorageRuntime(db, paths);
  const house = mintHouse({ origin: ORIGIN, seed: 83 });
  const manager = new HouseLifecycleManager({ db, installationId: 'first-pin-install',
    signer: {} as never, fetch: house.fetch as typeof fetch, legacyRecoveryConfigured: origin => origin === ORIGIN,
    prepareRelationBinding: makeRelationBindingPreparer({ db }), onRelationBindingRefused: () => {} });
  manager.seedLegacyHouse(ORIGIN);
  const events: string[] = [];
  const resident = new ResidentLifecycle({ manager, token: 'first-pin-owner', intentPollMs: 60_000,
    streams: { open: () => { events.push('open'); return { stop: () => { events.push('stop'); } }; } } });
  // The real command-bus constructor owns the complete command schema.
  // No manual schema, weakened history guard, or fake admission is used.
  const bus = new HouseCommandBus({ db, coordinator: resident.coordinator, authority: resident.authority });
  expect(neverControlSubset(db, ORIGIN, readParticipation(db, ORIGIN))).toBe(true);
  resident.configureOrigins([ORIGIN]); resident.start();
  cleanup.push(async () => { await resident.stop(); await bus.stop(); release(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, house, manager, resident, bus, events,
    pin: () => pinConfiguredHouses({ db, recipientPopclawId: 'owner', origins: [ORIGIN], fetch: house.fetch as typeof fetch,
      pinning: { mode: 'static', firstPin: manager.configuredFirstPin }, onParticipationChanged: () => resident.participationChanged() }) };
}
it('verified config first pin advances once and reopens only new work without control login', async () => {
  const f = fixture(); const old = f.resident.captureGate(ORIGIN);
  expect(old.isActive()).toBe(true);
  expect((await f.pin())[0]?.outcome).toBe('pinned');
  expect(readParticipation(f.db, ORIGIN)).toMatchObject({ op_seq: 1, desired: 'enabled', phase: 'connected',
    session_id: '', ack_key_hex: '', pending_enter_request_id: null, remote_status: 'none' });
  expect(old.isActive()).toBe(false);
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(true);
  expect(f.events).toEqual(['open', 'stop', 'open']);
  expect((await f.pin())[0]?.outcome).toBe('already-decided');
  expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(1);
  f.db.execute('DELETE FROM house_binding_pin WHERE origin=?', [ORIGIN]);
  expect(old.isActive()).toBe(false);
});
it('a locally failed logout cancels a pending first-pin proof even with unchanged durable state', async () => {
  const f = fixture(); let resume!: () => void; let reached!: () => void;
  const waiting = new Promise<void>(resolve => { reached = resolve; });
  const pending = pinConfiguredHouses({ db: f.db, recipientPopclawId: 'owner', origins: [ORIGIN],
    pinning: { mode: 'static', firstPin: f.manager.configuredFirstPin },
    fetch: (async (input: unknown) => { reached(); await new Promise<void>(resolve => { resume = resolve; }); return f.house.fetch(input); }) as typeof fetch });
  // Fail immediately if a guard refuses before transport, rather than
  // hanging on a fetch the legitimate fixture never reached.
  await Promise.race([waiting, pending.then(() => { throw new Error('first-pin attempt refused before proof fetch'); })]);
  const tx = vi.spyOn(f.db, 'transaction').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(f.manager.logoutHouse(ORIGIN)).rejects.toThrow('PERSISTENCE_FAILED'); tx.mockRestore();
  resume();
  expect((await pending)[0]?.outcome).toBe('refused');
  expect(f.db.queryOne('SELECT origin FROM house_binding_pin WHERE origin=?', [ORIGIN])).toBeNull();
  expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(0);
});

it('failed logout after the pin commit fences both a delayed rescan hint and later polling', async () => {
  const f = fixture();
  // Delay the permission-free hint. The proof/pin commit already happened;
  // the same existing seed/sync path is also what resident polling calls.
  const hint = () => f.resident.coordinator.seedLegacyHouses([ORIGIN]);
  expect((await pinConfiguredHouses({ db: f.db, recipientPopclawId: 'owner', origins: [ORIGIN],
    fetch: f.house.fetch as typeof fetch, pinning: { mode: 'static', firstPin: f.manager.configuredFirstPin },
    onParticipationChanged: () => {} }))[0]?.outcome).toBe('pinned');
  const tx = vi.spyOn(f.db, 'transaction').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(f.bus.logoutHouse(ORIGIN)).rejects.toThrow('PERSISTENCE_FAILED'); tx.mockRestore();
  expect(readParticipation(f.db, ORIGIN)?.desired).toBe('enabled');
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(false);
  hint();
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(false);
  hint();
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(false);
});
