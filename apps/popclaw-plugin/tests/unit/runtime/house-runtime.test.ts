import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializePublicStreamJournal } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession, readStorageControl, storagePathAllowed } from '../../../src/host/storage-maintenance.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import type { Signer } from '../../../src/identity/signer.js';
import { commitLocalLogout, ensureHouseLifecycleSchema, readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { makeWorldManifestPreparer, revokeHouseCapabilityView } from '../../../src/world/world-capabilities.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

const instances: HouseRuntime[] = [];
const dbs: InMemoryHostDb[] = [];
const displayCleanup: Array<() => void> = [];
function runtime(origins = ['https://a.invalid'], db = new InMemoryHostDb()) {
  const result = new HouseRuntime({readAuthorityFor: refusingReadAuthorityFor, db, signer: {} as Signer, origins, commandTimeoutMs: 10, commandPollMs: 1});
  instances.push(result); if (!dbs.includes(db)) dbs.push(db);
  return result;
}
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('unexpected network'); })));
afterEach(async () => {
  await Promise.all(instances.splice(0).map(instance => instance.stop()));
  vi.restoreAllMocks();
  for (const close of displayCleanup.splice(0).reverse()) close();
  for (const db of dbs.splice(0)) db.close(); vi.unstubAllGlobals();
});

it('reader login stays queued without an owner and does no network or stream work', async () => {
  const rt = runtime(); rt.startReader();
  const result = await rt.commands.loginHouse('https://a.invalid');
  expect(result.status).toBe('connecting'); expect(result.operationId).toBeTruthy();
  expect(readParticipation(rt.manager.db, 'https://a.invalid')).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('explicit public-v1 omits legacy public and Ranger factories while keeping the real business inbox slot', async () => {
  const db = new InMemoryHostDb(); dbs.push(db);
  const origin = 'https://a.invalid';
  const rt = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer: {} as Signer, origins: [origin], publicV1Mode: true }); instances.push(rt);
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq) VALUES(?,?,'enabled','connected',1)", [origin, rt.manager.installationId]);
  const createPublicReceiver = vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}), isReceiving: () => false, onConnected() {} }));
  const createRanger = vi.fn(() => ({ start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }));
  const createInboxConsumer = vi.fn(() => undefined);
  const house = { baseUrl: origin, slug: 'a-invalid', db, executionDb: db, dbPath: ':memory:', cache: {} as never };
  rt.configureResources({ host: { db } as never, recipientPopclawId: 'self', worldStreamMode: true, stores: [house],
    openStore: async () => house, isOfficialActor: () => false, createPublicReceiver, createRanger, createInboxConsumer });
  rt.start();
  await vi.waitFor(() => expect(createInboxConsumer).toHaveBeenCalledOnce());
  expect(rt.captureGate(origin).isActive()).toBe(true);
  expect(createPublicReceiver).not.toHaveBeenCalled(); expect(createRanger).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects two origins sharing a cache slug before queuing a command', async () => {
  const rt = runtime(['https://a-b.invalid']);
  expect(() => rt.commands.loginHouse('https://a.b.invalid')).toThrow('HOUSE_SLUG_COLLISION');
  expect(rt.manager.db.queryAll('SELECT * FROM house_lifecycle_commands')).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves the configured home when a new command target is mounted', async () => {
  const rt = runtime(); rt.startReader();
  await rt.commands.loginHouse('https://b.invalid');
  expect(rt.egress.home.slug).toBe('a-invalid');
  expect(rt.egress.slugs()).toEqual(['a-invalid', 'b-invalid']);
  await expect(rt.egress.pushTo('unknown', new Uint8Array())).rejects.toThrow('INVALID_HOUSE');
  await expect(rt.egress.pushTo('b-invalid', new Uint8Array())).rejects.toMatchObject({result: {status: 409, errorCode: 'STALE_OPERATION'}});
  expect(fetch).not.toHaveBeenCalled();
});

it('enforces the same slug binding across independent runtime instances', async () => {
  const db = new InMemoryHostDb(); const first = runtime(['https://a-b.invalid'], db);
  const second = runtime(['https://a-b.invalid'], db);
  expect(second.originForSlug('a-b-invalid')).toBe('https://a-b.invalid');
  expect(() => second.commands.loginHouse('https://a.b.invalid')).toThrow('HOUSE_SLUG_COLLISION');
  expect(first.originForSlug('a-b-invalid')).toBe('https://a-b.invalid');
});

it('capturing a stopped runtime gate does not access a closed database', async () => {
  const rt = runtime(); await rt.stop(); rt.manager.db.close();
  expect(rt.captureGate('https://a.invalid').isActive()).toBe(false);
});

it('business commands keep their original per-house participation across awaits', async () => {
  const {assertHouseActionActive} = await import('../../../src/runtime/house-lifecycle/action-context.js');
  const db = new InMemoryHostDb(); dbs.push(db);
  const rt = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer: {} as Signer,
    origins: ['https://a.invalid', 'https://b.invalid'], publicV1Mode: true }); instances.push(rt);
  for (const origin of ['https://a.invalid', 'https://b.invalid']) rt.manager.db.execute(
    "INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq) VALUES(?,'install','enabled','connected',1)", [origin]);
  let release!: () => void; const hold = new Promise<void>(r => {release=r;});
  const original = rt.runCommand(async () => {await hold; assertHouseActionActive('https://a.invalid');});
  await Promise.resolve();
  rt.manager.db.execute("UPDATE house_participation SET op_seq=3 WHERE house_origin='https://a.invalid'");
  release(); await expect(original).rejects.toThrow('no longer active');
  await expect(rt.runCommand(async () => {assertHouseActionActive('https://b.invalid');return 'B';})).resolves.toBe('B');
  await expect(rt.runCommand(async () => {assertHouseActionActive('https://a.invalid');return 'new A';})).resolves.toBe('new A');
});

it('shutdown waits for real business command continuation before closing its database', async () => {
  const rt = runtime(); let release!: () => void;
  const hold = new Promise<void>(r => {release=r;});
  const task = rt.runCommand(async () => {await hold;rt.manager.db.queryOne('SELECT 1');});
  await Promise.resolve(); let drained = false;
  const stopping = rt.stop().then(() => {drained=true;});
  await Promise.resolve(); expect(drained).toBe(false);
  release(); await task; await stopping;
  rt.manager.db.close(); await expect(rt.runCommand(async()=>{})).rejects.toThrow('HOUSE_RUNTIME_STOPPED');
});

it('opens the same known house store for reader commands without starting streams or binding another origin', async () => {
  const rt = runtime(); const houseDb = new InMemoryHostDb(); dbs.push(houseDb);
  const store = {baseUrl: 'https://a.invalid', slug: 'a-invalid', db: houseDb, dbPath: ':memory:', cache: {} as never};
  const openStore = vi.fn(async () => store), onStore = vi.fn();
  rt.configureResources({stores: [], host: {} as never, recipientPopclawId: 'self', worldStreamMode: true,
    openStore, onStore, isOfficialActor: () => false});
  const start = vi.spyOn(rt.resident, 'start'); rt.startReader();
  const [first, second] = await Promise.all([rt.storeForCommand('https://a.invalid/'), rt.storeForCommand('https://a.invalid')]);
  expect(first).toBe(store); expect(second).toBe(store);
  expect(await rt.storeForCommand('https://a.invalid')).toBe(store);
  expect(openStore).toHaveBeenCalledOnce(); expect(onStore).toHaveBeenCalledOnce(); expect(onStore).toHaveBeenCalledWith(store);
  await expect(rt.storeForCommand('https://unknown.invalid')).rejects.toThrow('INVALID_HOUSE');
  expect(rt.manager.db.queryAll('SELECT origin FROM house_origin_bindings')).toEqual([{origin: 'https://a.invalid'}]);
  expect(rt.manager.db.queryAll('SELECT * FROM house_lifecycle_commands')).toEqual([]);
  expect(start).not.toHaveBeenCalled(); expect(rt.resident.authority.captureEpoch()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('joins a pending command store opening and rejects its result after runtime stop', async () => {
  const rt = runtime(); const houseDb = new InMemoryHostDb(); dbs.push(houseDb);
  const store = {baseUrl: 'https://a.invalid', slug: 'a-invalid', db: houseDb, dbPath: ':memory:', cache: {} as never};
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
  const openStore = vi.fn(async () => { await hold; return store; });
  rt.configureResources({stores: [], host: {} as never, recipientPopclawId: 'self', worldStreamMode: true,
    openStore, isOfficialActor: () => false});
  const opening = rt.storeForCommand('https://a.invalid'); const failure = expect(opening).rejects.toThrow('HOUSE_RUNTIME_STOPPED');
  let done = false; const stopping = rt.stop().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  release(); await failure; await stopping;
  expect(done).toBe(true);
  await expect(rt.storeForCommand('https://a.invalid')).rejects.toThrow('HOUSE_RUNTIME_STOPPED');
  expect(openStore).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
});

const displayOrigin = 'https://display-runtime.invalid';
const displayPair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
const displayPin = Buffer.from(displayPair.publicKey).toString('hex');

/** All initialization is explicit fixture setup; capture must only borrow the
 * selected handle after this setup has finished. No real host files are used. */
async function displayFixture() {
  const root = mkdtempSync(join(tmpdir(), 'house-runtime-display-'));
  displayCleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb());
  displayCleanup.push(() => db.close());
  runMigrations(db, join(import.meta.dirname, '../../../migrations'));
  establishTrust(db, {origin:displayOrigin, houseKey:bs58.encode(displayPair.publicKey), incarnation:'display_house_1'}, 'configured');
  ensureHouseLifecycleSchema(db);
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex) VALUES(?,'fixture','enabled','disconnected',1,?)", [displayOrigin, displayPin]);
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: bs58.encode(displayPair.publicKey) });
  displayCleanup.push(() => catalog.close());
  const partition = catalog.open(displayOrigin);
  async function observe(log = 'display_log_1', officialIds: unknown = []) {
    const rawBytes = new TextEncoder().encode(JSON.stringify({ official_ids: officialIds, world_interaction: { version: 1,
      public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: log, envelope_baseline: 'public-envelope-02' as const, initial_public_scopes: [] } } }));
    const core = { house: { origin: displayOrigin, houseKey: bs58.encode(displayPair.publicKey), incarnation: 'display_house_1' },
      manifestDigest: cidFromCanonical(rawBytes), signedAt: 1 };
    const bytes = popclaw.world.ManifestProof.encode(core).finish(), prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
    const signing = new Uint8Array(prefix.length + bytes.length); signing.set(prefix); signing.set(bytes, prefix.length);
    const prepared = await makeWorldManifestPreparer()({ origin: displayOrigin, rawBytes, ackKeyHex: displayPin,
      provenance: 'configured_pin', signal: new AbortController().signal,
      proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core,
        authoritySignature: nacl.sign.detached(signing, displayPair.secretKey) }).finish()).toString('base64') });
    db.transaction(prepared.commit);
  }
  await observe();
  const maintenance = MaintenanceSession.begin(db, paths, 'display fixture initialization');
  initializePublicStreamJournal({ catalog, origin: displayOrigin, maintenance, configuredPin: displayPin });
  maintenance.finish({ recovery: false, reason: 'synthetic journal initialized' });
  let pin = displayPin;
  const rt = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer: {} as Signer, origins: [displayOrigin], publicV1Mode: true,
    executionStores: catalog, configuredPinFor: () => pin });
  instances.push(rt);
  const cacheRecord = vi.fn();
  const house = { baseUrl: displayOrigin, slug: 'display-runtime-invalid', db: partition.db,
    executionDb: partition.db, dbPath: partition.path, cacheReadOnly: true,
    cache: { record: cacheRecord } } as unknown as HouseStore;
  const openStore = vi.fn(async () => house);
  rt.configureResources({ host: { db } as never, recipientPopclawId: catalog.options.actorId, worldStreamMode: true,
    stores: [house], openStore, isOfficialActor: () => false });
  return { rt, house, db, paths, catalog, partition, cacheRecord, openStore, observe,
    setPin: (value: string) => { pin = value; } };
}

it('captures retained public history under the same pin without acquiring owner or session authority', async () => {
  const f = await displayFixture();
  const residentStart = vi.spyOn(f.rt.resident, 'start');
  const globalWrite = vi.spyOn(f.db, 'execute'), journalWrite = vi.spyOn(f.partition.db, 'execute');
  const globalTransaction = vi.spyOn(f.db, 'transaction');
  const beforeControl = readFileSync(f.paths.storageControlFile(), 'utf8');
  const captured = f.rt.capturePublicDisplay(f.house);
  captured.assertCurrent();
  expect(captured.executionDb).toBe(f.partition.db);
  expect(captured.capability.house.origin).toBe(displayOrigin);
  expect(captured.capability.house.houseKey).toBe(bs58.encode(displayPair.publicKey));
  expect(captured.history).toBe(true);
  expect(captured.producerPolicy.officialActorIds).toEqual([]);
  expect(f.rt.resident.authority.captureEpoch()).toBeNull();
  expect(readParticipation(f.db, displayOrigin)).toMatchObject({ desired: 'enabled', phase: 'disconnected', session_id: '' });
  expect(globalWrite).not.toHaveBeenCalled(); expect(journalWrite).not.toHaveBeenCalled();
  expect(globalTransaction).not.toHaveBeenCalled();
  expect(readFileSync(f.paths.storageControlFile(), 'utf8')).toBe(beforeControl);
  expect(f.db.queryAll('SELECT * FROM house_lifecycle_commands')).toEqual([]);
  expect(f.openStore).not.toHaveBeenCalled(); expect(f.cacheRecord).not.toHaveBeenCalled();
  expect(residentStart).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('keeps the same trusted journal readable as local history after the real local logout transaction', async () => {
  const f = await displayFixture(), before = f.rt.capturePublicDisplay(f.house);
  commitLocalLogout(f.db, displayOrigin, f.rt.manager.installationId, 'display-fixture-logout', 100, displayPin);
  const globalWrite = vi.spyOn(f.db, 'execute'), journalWrite = vi.spyOn(f.partition.db, 'execute');
  const after = f.rt.capturePublicDisplay(f.house); after.assertCurrent();
  expect(after.history).toBe(true); expect(after.executionDb).toBe(before.executionDb);
  expect(after.capability).toEqual(before.capability);
  expect(readParticipation(f.db, displayOrigin)).toMatchObject({ desired: 'disabled', session_id: '' });
  expect(f.rt.captureGate(displayOrigin).isActive()).toBe(false);
  expect(f.rt.resident.authority.captureEpoch()).toBeNull();
  expect(globalWrite).not.toHaveBeenCalled(); expect(journalWrite).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it('captures and rechecks public history with SQLite itself forbidding writes on both databases', async () => {
  const f = await displayFixture();
  f.db.execute('PRAGMA query_only=ON'); f.partition.db.execute('PRAGMA query_only=ON');
  try {
    expect(() => f.db.execute("UPDATE house_participation SET op_seq=99")).toThrow(/readonly/i);
    expect(() => f.partition.db.execute('CREATE TABLE unexpected_display_write(id INTEGER)')).toThrow(/readonly/i);
    const captured = f.rt.capturePublicDisplay(f.house); captured.assertCurrent();
    expect(captured.history).toBe(true);
    expect(readParticipation(f.db, displayOrigin)?.op_seq).toBe(1);
    expect(f.partition.db.queryOne("SELECT name FROM sqlite_master WHERE name='unexpected_display_write'")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    f.db.execute('PRAGMA query_only=OFF'); f.partition.db.execute('PRAGMA query_only=OFF');
  }
});

it.each(['configured-pin', 'revoked-view', 'producer-policy'] as const)('refuses public display after %s becomes untrusted', async change => {
  const f = await displayFixture(), captured = f.rt.capturePublicDisplay(f.house);
  if (change === 'configured-pin') f.setPin('11'.repeat(32));
  if (change === 'revoked-view') f.db.transaction(tx => revokeHouseCapabilityView(tx, displayOrigin, 'fixture revocation'));
  if (change === 'producer-policy') await f.observe('display_log_1', null);
  const expected = change === 'configured-pin' ? 'PUBLIC_DISPLAY_PIN_MISMATCH'
    : change === 'revoked-view' ? 'PUBLIC_DISPLAY_TRUST_UNAVAILABLE' : 'PUBLIC_PRODUCER_POLICY_INVALID';
  expect(() => captured.assertCurrent()).toThrow(expected);
  expect(() => f.rt.capturePublicDisplay(f.house)).toThrow(expected);
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects a captured old log after a newly signed manifest selects another log', async () => {
  const f = await displayFixture(), old = f.rt.capturePublicDisplay(f.house);
  await f.observe('display_log_2');
  expect(() => old.assertCurrent()).toThrow('PUBLIC_DISPLAY_CAPTURE_CHANGED');
  const current = f.rt.capturePublicDisplay(f.house); current.assertCurrent();
  expect(current.capability.publicStream.log_incarnation).toBe('display_log_2');
  expect(current.capability.capabilityRevision).not.toBe(old.capability.capabilityRevision);
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['unmounted', 'missing-handle', 'different-handle'] as const)('rejects a %s public display store', async change => {
  const f = await displayFixture();
  if (change === 'unmounted') {
    expect(() => f.rt.capturePublicDisplay({ ...f.house })).toThrow('PUBLIC_DISPLAY_STORE_UNAVAILABLE');
  } else {
    Object.defineProperty(f.house, 'executionDb', { value: change === 'missing-handle' ? undefined : f.db });
    expect(() => f.rt.capturePublicDisplay(f.house)).toThrow(change === 'missing-handle'
      ? 'PUBLIC_DISPLAY_STORE_UNAVAILABLE' : 'PUBLIC_DISPLAY_HANDLE_MISMATCH');
  }
  expect(f.openStore).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it.each(['missing-file', 'missing-table', 'missing-reservation', 'wrong-actor'] as const)('fails closed on %s without repairing protected public storage', async change => {
  const f = await displayFixture(), captured = f.rt.capturePublicDisplay(f.house);
  if (change === 'missing-file') unlinkSync(f.partition.path);
  if (change === 'missing-table') f.partition.db.execute('DROP TABLE world_public_imports_v1');
  if (change === 'missing-reservation') f.db.execute("UPDATE execution_store_catalog_v1 SET required_tables='[]'");
  if (change === 'wrong-actor') f.db.execute("UPDATE execution_store_catalog_v1 SET actor_id='other-actor'");
  const globalWrite = vi.spyOn(f.db, 'execute'), journalWrite = vi.spyOn(f.partition.db, 'execute');
  expect(() => captured.assertCurrent()).toThrow();
  expect(() => f.rt.capturePublicDisplay(f.house)).toThrow(change === 'missing-file' ? 'EXECUTION_PARTITION_MISSING'
    : change === 'missing-table' ? 'EXECUTION_REQUIRED_TABLE_MISSING' : 'PUBLIC_DISPLAY_JOURNAL_UNAVAILABLE');
  expect(globalWrite).not.toHaveBeenCalled(); expect(journalWrite).not.toHaveBeenCalled();
  if (change === 'missing-file') expect(existsSync(f.partition.path)).toBe(false);
  if (change === 'missing-table') expect(f.partition.db.queryOne("SELECT name FROM sqlite_master WHERE name='world_public_imports_v1'")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it('rechecks the global capture after selecting H31 and rejects a concurrent global catalog change', async () => {
  const f = await displayFixture(), open = f.catalog.open.bind(f.catalog);
  vi.spyOn(f.catalog, 'open').mockImplementation(origin => {
    const partition = open(origin);
    f.db.execute("UPDATE execution_store_catalog_v1 SET source_fingerprint='changed-during-capture' WHERE origin=?", [origin]);
    return partition;
  });
  expect(() => f.rt.capturePublicDisplay(f.house)).toThrow('PUBLIC_DISPLAY_CAPTURE_CHANGED');
  expect(fetch).not.toHaveBeenCalled();
});

it('allows history during recovery while preserving all execution, consumer and notification holds', async () => {
  const f = await displayFixture(), prior = f.rt.capturePublicDisplay(f.house);
  const maintenance = MaintenanceSession.begin(f.db, f.paths, 'synthetic restore');
  maintenance.finish({ recovery: true, reason: 'await independent recovery decisions' });
  const before = readFileSync(f.paths.storageControlFile(), 'utf8');
  expect(() => prior.assertCurrent()).toThrow('PUBLIC_DISPLAY_CAPTURE_CHANGED');
  const globalWrite = vi.spyOn(f.db, 'execute'), journalWrite = vi.spyOn(f.partition.db, 'execute');
  const captured = f.rt.capturePublicDisplay(f.house); captured.assertCurrent();
  expect(captured.history).toBe(true);
  expect(readStorageControl(f.paths)?.held).toEqual(['execution', 'consumers', 'notifications']);
  for (const path of ['execution', 'consumers', 'notifications'] as const) expect(storagePathAllowed(f.paths, path)).toBe(false);
  expect(readFileSync(f.paths.storageControlFile(), 'utf8')).toBe(before);
  expect(globalWrite).not.toHaveBeenCalled(); expect(journalWrite).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(['maintenance', 'missing-control'] as const)('rejects history while %s prevents a valid storage capture', async change => {
  const f = await displayFixture(), captured = f.rt.capturePublicDisplay(f.house);
  if (change === 'maintenance') MaintenanceSession.begin(f.db, f.paths, 'synthetic maintenance');
  else unlinkSync(f.paths.storageControlFile());
  const expected = change === 'maintenance' ? 'STORAGE_MAINTENANCE_PENDING' : 'PUBLIC_DISPLAY_CONTROL_MISSING';
  expect(() => captured.assertCurrent()).toThrow(expected);
  expect(() => f.rt.capturePublicDisplay(f.house)).toThrow(expected);
  if (change === 'missing-control') expect(existsSync(f.paths.storageControlFile())).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});

it('invalidates a public display capture when its runtime stops', async () => {
  const f = await displayFixture(), captured = f.rt.capturePublicDisplay(f.house);
  await f.rt.stop();
  expect(() => captured.assertCurrent()).toThrow('PUBLIC_DISPLAY_BINDING_CHANGED');
  expect(() => f.rt.capturePublicDisplay(f.house)).toThrow('PUBLIC_DISPLAY_STORE_UNAVAILABLE');
  expect(fetch).not.toHaveBeenCalled();
});
