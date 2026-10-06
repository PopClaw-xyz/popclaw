import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { ensureHouseLifecycleSchema, commitLocalLogout } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { HouseCommandBus } from '../../../src/runtime/house-lifecycle/command-bus.js';
import type { HouseLifecycleCoordinator } from '../../../src/runtime/house-lifecycle/coordinator.js';

const origin = 'https://synthetic.invalid';
const resources: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const close of resources.reverse()) await close(); resources.length = 0; });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'house-command-bus-'));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  const ownerDb = new LocalHostDb(join(root, 'ipc.db')); const readerDb = new LocalHostDb(join(root, 'ipc.db'));
  resources.push(() => ownerDb.close(), () => readerDb.close());
  ensureHouseLifecycleSchema(ownerDb);
  return { ownerDb, readerDb };
}
const connected = (sessionId = 'session-1') => ({ scope: 'local_installation' as const, origin, status: 'connected' as const, sessionId });
function port(login: () => Promise<ReturnType<typeof connected>>) {
  return { loginHouse: login, knownHouseOrigins: () => [origin] } as unknown as HouseLifecycleCoordinator;
}
const noOwner = { captureEpoch: () => null, isEpochCurrent: () => false };
const owner = { captureEpoch: () => 1, isEpochCurrent: (epoch: number) => epoch === 1 };

it('transfers a login request and response between two SQLite connections; only the owner executes', async () => {
  const { ownerDb, readerDb } = setup(); let sends = 0;
  const a = new HouseCommandBus({ db: ownerDb, coordinator: port(async () => { sends++; return connected(); }), authority: owner, pollMs: 5 });
  const b = new HouseCommandBus({ db: readerDb, coordinator: port(async () => { throw new Error('reader executed'); }), authority: noOwner, pollMs: 5 });
  resources.push(() => a.stop(), () => b.stop());
  a.start(); const result = await b.loginHouse(origin);
  expect(result).toMatchObject(connected()); expect(sends).toBe(1);
});

it('a logout committed before an old queued login is claimed cancels that request', async () => {
  const { ownerDb, readerDb } = setup(); let sends = 0;
  const a = new HouseCommandBus({ db: ownerDb, coordinator: port(async () => { sends++; return connected(); }), authority: owner, pollMs: 5 });
  const b = new HouseCommandBus({ db: readerDb, coordinator: port(async () => { throw new Error('reader executed'); }), authority: noOwner, pollMs: 5 });
  resources.push(() => a.stop(), () => b.stop());
  const waiting = b.loginHouse(origin);
  commitLocalLogout(readerDb, origin, 'installation', 'new-logout', 100, '');
  a.start();
  expect(await waiting).toMatchObject({ status: 'connecting', errorCode: 'STALE_OPERATION' });
  expect(sends).toBe(0);
});

it('a new owner reclaims interrupted work and an old owner cannot overwrite its result', async () => {
  const { ownerDb, readerDb } = setup(); let epoch = 1; let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const a = new HouseCommandBus({ db: ownerDb, coordinator: port(async () => { entered(); await new Promise<void>(r => { release = r; }); return connected('old'); }), authority: { captureEpoch: () => epoch === 1 ? 1 : null, isEpochCurrent: e => epoch === e }, pollMs: 5 });
  const b = new HouseCommandBus({ db: readerDb, coordinator: port(async () => connected('new')), authority: { captureEpoch: () => epoch === 2 ? 2 : null, isEpochCurrent: e => epoch === e }, pollMs: 5 });
  resources.push(() => a.stop(), () => b.stop());
  resources.push(() => release?.());
  a.start(); const waiting = b.loginHouse(origin); await started;
  epoch = 2; b.start(); expect(await waiting).toMatchObject({ sessionId: 'new' });
  release(); await a.stop();
  const rows = readerDb.queryAll<{ result_json: string }>('SELECT result_json FROM house_lifecycle_commands');
  expect(rows).toHaveLength(1); expect(JSON.parse(rows[0]!.result_json).sessionId).toBe('new');
});

it('a caller without a resident reports pending, and stopped waiters do not touch a closed DB', async () => {
  const { readerDb } = setup();
  const b = new HouseCommandBus({ db: readerDb, coordinator: port(async () => { throw new Error('must not execute'); }), authority: noOwner, pollMs: 5, timeoutMs: 10 });
  resources.push(() => b.stop());
  const result = await b.loginHouse(origin); expect(result.status).toBe('connecting'); expect(result.operationId).toBeTruthy();
  const pending = b.loginHouse(origin); await b.stop(); readerDb.close();
  expect((await pending).status).toBe('connecting');
});

it('a backlog at a stalled house does not prevent another house command from executing', async () => {
  const { ownerDb, readerDb } = setup();
  let release!: () => void;
  const stalled = new Promise<void>(r => { release = r; });
  const coordinator = { loginHouse: async (target: string) => { if (target === origin) await stalled; return { ...connected(), origin: target }; }, knownHouseOrigins: () => [] } as unknown as HouseLifecycleCoordinator;
  const a = new HouseCommandBus({ db: ownerDb, coordinator, authority: owner, pollMs: 5 });
  const b = new HouseCommandBus({ db: readerDb, coordinator: port(async () => { throw new Error('reader executed'); }), authority: noOwner, pollMs: 5, timeoutMs: 100 });
  resources.push(() => a.stop(), () => b.stop(), () => release());
  const backlog = Array.from({ length: 40 }, () => b.loginHouse(origin));
  readerDb.execute('UPDATE house_lifecycle_commands SET created_at = 0'); // deterministic queue order
  const other = b.loginHouse('https://other.invalid');
  a.start();
  try { expect(await other).toMatchObject({ status: 'connected', origin: 'https://other.invalid' }); }
  finally { release(); await b.stop(); await a.stop(); await Promise.all(backlog); }
});


it('backs off empty owner pumps but wakes same-process owners immediately', async () => {
  const { ownerDb, readerDb } = setup();
  let captures = 0;
  const authority = { captureEpoch: () => { captures++; return 1; }, isEpochCurrent: () => true };
  const a = new HouseCommandBus({ db: ownerDb, coordinator: port(async () => connected()), authority });
  const b = new HouseCommandBus({ db: readerDb, coordinator: port(async () => { throw new Error('reader executed'); }), authority: noOwner });
  resources.push(() => a.stop(), () => b.stop());
  const reads = vi.spyOn(ownerDb, 'queryAll');
  const writes = vi.spyOn(ownerDb, 'execute');
  const single = vi.spyOn(ownerDb, 'queryOne');
  a.start(); b.start();
  await new Promise(r => setTimeout(r, 2200));
  console.log('IDLE_PUMPS', captures, 'DB_CALLS', reads.mock.calls.length + writes.mock.calls.length + single.mock.calls.length);
  expect(captures).toBeLessThanOrEqual(8);
  const started = performance.now();
  expect(await b.loginHouse(origin)).toMatchObject(connected());
  const elapsed = performance.now() - started;
  console.log('LOCAL_WAKE_MS', elapsed);
  expect(elapsed).toBeLessThan(150);
});
