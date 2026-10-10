import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializePublicStreamJournal } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession } from '../../../src/host/storage-maintenance.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { makeWorldManifestPreparer, readHouseCapabilityView } from '../../../src/world/world-capabilities.js';
import { PublicWorldStreamClient } from '../../../src/ingress/public-world-stream-client.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';
import { PUBLIC_JOURNAL_TABLES } from '../../../src/host/execution-store-schema.js';
import { PublicReadResources, publicProducerPolicy } from '../../../src/runtime/house-lifecycle/public-read-resources.js';
import { HouseLifecycleCoordinator } from '../../../src/runtime/house-lifecycle/coordinator.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'https://public-resource.invalid', pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const pinHex = Buffer.from(pair.publicKey).toString('hex');
async function fixture(fresh = false) {
  const root = mkdtempSync(join(tmpdir(), 'public-read-resource-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb());
  cleanup.push(() => db.close());
  runMigrations(db, join(import.meta.dirname, '../../../migrations'));
  establishTrust(db, {origin, houseKey:bs58.encode(pair.publicKey), incarnation:'house_1'}, 'configured');
  ensureHouseLifecycleSchema(db);
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex) VALUES(?,'test','enabled','disconnected',1,?)", [origin, pinHex]);
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: bs58.encode(pair.publicKey) });
  cleanup.push(() => catalog.close());
  const partition = catalog.open(origin);
  async function observe(log = 'log_1', officialIds: unknown = []) {
    const rawBytes = new TextEncoder().encode(JSON.stringify({ official_ids: officialIds, world_interaction: { version: 1,
      public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: log, envelope_baseline: 'public-envelope-02' as const, initial_public_scopes: [] } } }));
    const core = { house: { origin, houseKey: bs58.encode(pair.publicKey), incarnation: 'house_1' }, manifestDigest: cidFromCanonical(rawBytes), signedAt: 1 };
    const bytes = popclaw.world.ManifestProof.encode(core).finish(), prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
    const signing = new Uint8Array(prefix.length + bytes.length); signing.set(prefix); signing.set(bytes, prefix.length);
    db.transaction((await makeWorldManifestPreparer()({ origin, rawBytes, ackKeyHex: pinHex, provenance: 'configured_pin', signal: new AbortController().signal,
      proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core, authoritySignature: nacl.sign.detached(signing, pair.secretKey) }).finish()).toString('base64') })).commit);
  }
  await observe();
  if (!fresh) {
    const maintenance = MaintenanceSession.begin(db, paths, 'public resource fixture');
    initializePublicStreamJournal({ catalog, origin, maintenance, configuredPin: pinHex });
    maintenance.finish({ recovery: false, reason: 'synthetic initialized' });
  }
  let owner = 1, pin = pinHex, allowed = true, selected = true;
  const cacheRecord = vi.fn();
  const house = { baseUrl: origin, slug: 'public-resource-invalid', executionDb: partition.db,
    db: partition.db, dbPath: partition.path, cacheReadOnly: true, cache: { record: cacheRecord } } as unknown as HouseStore;
  let acquire: () => Promise<HouseStore> = async () => house;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      init?.signal?.addEventListener('abort', () => { try { controller.close(); } catch { /* already cancelled */ } }, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  const resources = new PublicReadResources({ db, catalog, authority: { captureEpoch: () => owner, isEpochCurrent: epoch => epoch === owner },
    selected: () => selected, pinFor: () => pin, consumersAllowed: () => allowed, storeFor: () => acquire(), fetch });
  function open() {
    const selection = resources.capture(origin)!;
    expect(selection).not.toBeNull();
    const resource = selection.open(); cleanup.push(() => resource.stop()); return resource;
  }
  return { db, paths, catalog, partition, resources, requests, fetch, house, cacheRecord, open, observe,
    setOwner: (value: number) => { owner = value; }, setPin: (value: string) => { pin = value; },
    setAllowed: (value: boolean) => { allowed = value; }, setSelected: (value: boolean) => { selected = value; },
    setAcquire: (value: () => Promise<HouseStore>) => { acquire = value; } };
}

it('starts real anonymous raw reception on H31 even when the cache is read-only', async () => {
  const f = await fixture(), resource = f.open();
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  expect(new URL(f.requests[0]!.url).pathname).toBe('/v1/world-stream');
  expect(new Headers(f.requests[0]!.init?.headers).has('authorization')).toBe(false);
  expect(f.db.queryOne<{ session_id: string; phase: string }>('SELECT session_id,phase FROM house_participation'))
    .toEqual({ session_id: '', phase: 'disconnected' });
  expect(f.resources.status(origin).consumers).toEqual({ cache: 'unsupported', notifications: 'unsupported', ranger: 'unsupported' });
  expect(f.cacheRecord).not.toHaveBeenCalled();
  await resource.stop();
  expect(f.requests[0]!.init?.signal?.aborted).toBe(true);
});

it.each(['logout', 'operation', 'owner', 'pin', 'view', 'hold', 'mode', 'table'] as const)('fences a captured receiver after %s changes', async change => {
  const f = await fixture(), resource = f.open();
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  if (change === 'logout') f.db.execute("UPDATE house_participation SET desired='disabled'");
  if (change === 'operation') f.db.execute('UPDATE house_participation SET op_seq=2');
  if (change === 'owner') f.setOwner(2);
  if (change === 'pin') f.setPin('11'.repeat(32));
  if (change === 'view') f.db.execute('UPDATE world_capability_current_v1 SET active=0');
  if (change === 'hold') f.setAllowed(false);
  if (change === 'mode') f.setSelected(false);
  if (change === 'table') f.partition.db.execute('DROP TABLE world_public_imports_v1');
  resource.refresh?.();
  expect(f.requests[0]!.init?.signal?.aborted).toBe(true);
  expect(f.resources.status(origin).transport).toBe('inactive');
  await resource.stop();
});

it('joins late store completion after stop without constructing a receiver', async () => {
  const f = await fixture();
  const openPartition = vi.spyOn(f.catalog, 'open');
  let release!: (house: HouseStore) => void;
  const pending = new Promise<HouseStore>(resolve => { release = resolve; });
  f.setAcquire(() => pending);
  const resource = f.open(); await Promise.resolve(); await Promise.resolve();
  let joined = false; const stopped = Promise.resolve(resource.stop()).then(() => { joined = true; });
  await Promise.resolve(); expect(joined).toBe(false);
  release(f.house); await stopped;
  expect(f.fetch).not.toHaveBeenCalled();
  expect(openPartition).not.toHaveBeenCalled();
});

it.each(['owner', 'pin', 'operation'] as const)('rejects late store completion after captured %s changes', async change => {
  const f = await fixture(), openPartition = vi.spyOn(f.catalog, 'open');
  let release!: (house: HouseStore) => void;
  f.setAcquire(() => new Promise<HouseStore>(resolve => { release = resolve; }));
  const resource = f.open(); await Promise.resolve(); await Promise.resolve();
  if (change === 'owner') f.setOwner(2);
  if (change === 'pin') f.setPin('11'.repeat(32));
  if (change === 'operation') f.db.execute('UPDATE house_participation SET op_seq=2');
  release(f.house); await Promise.resolve(); await resource.stop();
  expect(f.fetch).not.toHaveBeenCalled(); expect(openPartition).not.toHaveBeenCalled();
});

it('stops and joins the real old transport before selecting an authenticated new log', async () => {
  const f = await fixture();
  const manager = new HouseLifecycleManager({ db: f.db, installationId: 'test', signer: {} as never });
  const coordinator = new HouseLifecycleCoordinator({ manager, streams: { open: () => { throw new Error('business gate must stay closed'); } }, publicStreams: f.resources });
  cleanup.push(() => coordinator.stopHost());
  coordinator.syncHouse(origin);
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  await f.observe('log_2'); coordinator.syncHouse(origin);
  expect(f.requests[0]!.init?.signal?.aborted).toBe(true);
  await vi.waitFor(() => expect(f.requests).toHaveLength(2));
  expect(f.requests[1]!.url).not.toBe(f.requests[0]!.url);
});

it('keeps malformed producer policy unsupported while accepting a proven empty set', async () => {
  const f = await fixture();
  expect(publicProducerPolicy(readHouseCapabilityView(f.db, origin)!).officialActorIds).toEqual([]);
  await f.observe('log_1', null);
  expect(f.resources.capture(origin)).toBeNull();
  expect(f.resources.status(origin).detail).toContain('PUBLIC_PRODUCER_POLICY_INVALID');
  expect(f.fetch).not.toHaveBeenCalled();
});

it('prepares a factory-born public-only House through normal reception without maintenance', async () => {
  const f = await fixture(true), resource = f.open();
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  const binding = f.partition.db.queryOne<{active_log:string;capability_revision:string}>(
    'SELECT active_log,capability_revision FROM world_public_bindings_v1');
  expect(binding).toMatchObject({active_log:'log_1',capability_revision:readHouseCapabilityView(f.db,origin)!.verified.capabilityRevision});
  expect(f.partition.db.queryAll('SELECT * FROM world_public_log_profiles_v1')).toHaveLength(1);
  expect(f.partition.db.queryAll('SELECT * FROM world_public_cursors_v1')).toHaveLength(1);
  expect(f.db.queryOne('SELECT session_id FROM house_participation')).toEqual({session_id:''});
  expect(new Headers(f.requests[0]!.init?.headers).has('authorization')).toBe(false);
  await resource.stop();
});

it('does not treat an old selected empty schema as factory authorization', async () => {
  const f = await fixture(true);
  if (f.partition.db.queryAll<{name:string}>('PRAGMA table_info(execution_partition_identity_v1)').some(c=>c.name==='public_initialization'))
    f.partition.db.execute('ALTER TABLE execution_partition_identity_v1 DROP COLUMN public_initialization');
  const before=f.partition.db.queryAll("SELECT type,name,sql FROM sqlite_master ORDER BY type,name");
  const resource=f.open();
  await vi.waitFor(()=>expect(f.resources.status(origin).detail).toContain('PUBLIC_JOURNAL_INITIALIZATION_REQUIRED'));
  expect(f.partition.db.queryAll("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")).toEqual(before);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.partition.db.queryAll('SELECT * FROM world_public_bindings_v1')).toEqual([]);
  await resource.stop();
});

it('retains factory provenance across restart before first preparation',async()=>{
  const f=await fixture(true);f.catalog.close();
  const restarted=new ExecutionStoreCatalog({db:f.db,paths:f.paths,actorId:bs58.encode(pair.publicKey)});
  cleanup.push(()=>restarted.close());
  const partition=restarted.open(origin);
  const report=initializePublicStreamJournal({catalog:restarted,origin,configuredPin:pinHex,activation:{partition,assertCurrent() {}}});
  expect(report.imported).toBe(0);
  expect(partition.db.queryOne('SELECT public_initialization FROM execution_partition_identity_v1')).toEqual({public_initialization:'prepared-public-v1'});
});
it('rolls back both fresh prepared records and provenance consumption on preparation failure',async()=>{
  const f=await fixture(true);
  expect(()=>initializePublicStreamJournal({catalog:f.catalog,origin,configuredPin:pinHex,
    activation:{partition:f.partition,assertCurrent() {}},failpoint:stage=>{if(stage==='prepared') throw new Error('SYNTHETIC_PREPARATION_FAILURE');}})).toThrow('SYNTHETIC_PREPARATION_FAILURE');
  expect(f.partition.db.queryAll('SELECT * FROM world_public_bindings_v1')).toEqual([]);
  expect(f.partition.db.queryAll('SELECT * FROM world_public_log_profiles_v1')).toEqual([]);
  expect(f.partition.db.queryAll('SELECT * FROM world_public_cursors_v1')).toEqual([]);
  expect(f.partition.db.queryOne('SELECT public_initialization FROM execution_partition_identity_v1')).toEqual({public_initialization:'fresh-public-v1'});
  const resource=f.open();await vi.waitFor(()=>expect(f.requests).toHaveLength(1));await resource.stop();
});
it('does not reissue consumed provenance when selected public records disappear',async()=>{
  const f=await fixture(true),resource=f.open();await vi.waitFor(()=>expect(f.requests).toHaveLength(1));await resource.stop();
  f.partition.db.execute('PRAGMA foreign_keys=OFF');
  for(const table of ['world_public_cursors_v1','world_public_log_profiles_v1','world_public_bindings_v1']) f.partition.db.execute(`DELETE FROM ${table}`);
  expect(()=>initializePublicStreamJournal({catalog:f.catalog,origin,configuredPin:pinHex,activation:{partition:f.partition,assertCurrent() {}}})).toThrow('PUBLIC_JOURNAL_INITIALIZATION_REQUIRED');
  expect(f.partition.db.queryAll('SELECT * FROM world_public_bindings_v1')).toEqual([]);
});


const legacyScopedRows={
  world_scoped_descriptors:"INSERT INTO world_scoped_descriptors VALUES('binding','actor','participation','1','{}','[]')",
  world_scoped_initial_scopes:"INSERT INTO world_scoped_initial_scopes VALUES('binding','[]')",
  world_scoped_log_events:"INSERT INTO world_scoped_log_events VALUES('binding','log','event','123')",
  world_scoped_event_scopes:"INSERT INTO world_scoped_event_scopes VALUES('binding','log','scope','event','123')",
  world_scoped_gaps:"INSERT INTO world_scoped_gaps VALUES('binding','1','history_pruned','scope',X'1234')",
} as const;
function legacyHistory(db:LocalHostDb,table:'world_stream_cursor'|keyof typeof legacyScopedRows) {
  if(table==='world_stream_cursor') {
    // Use the actual legacy receiver's DDL and its actual default cursor row.
    new PublicWorldStreamClient({db,baseUrl:origin}).ensureSchema();
    db.execute('UPDATE world_stream_cursor SET seq=123 WHERE id=1');
  } else {
    // The real scoped journal creates the descriptor/log/gap schemas. Remove
    // only its synthetic binding row to isolate the one history fact below.
    new ScopedStreamJournal(db,{origin,houseKey:bs58.encode(pair.publicKey),incarnation:'house_1'},()=>({eventId:'synthetic',publicScopes:[]}));
    db.execute('DELETE FROM world_scoped_bindings');
    db.execute(legacyScopedRows[table]);
  }
}
it.each(['world_stream_cursor',...Object.keys(legacyScopedRows)] as Array<'world_stream_cursor'|keyof typeof legacyScopedRows>)('refuses actual legacy %s history despite true factory provenance and empty public tables',async table=>{
  const f=await fixture(true);legacyHistory(f.partition.db,table);
  const before=f.partition.db.queryAll(`SELECT * FROM ${table}`);
  for(const name of PUBLIC_JOURNAL_TABLES)expect(f.partition.db.queryAll(`SELECT * FROM ${name}`)).toEqual([]);
  expect(()=>initializePublicStreamJournal({catalog:f.catalog,origin,configuredPin:pinHex,
    activation:{partition:f.partition,assertCurrent() {}}})).toThrow('PUBLIC_JOURNAL_INITIALIZATION_REQUIRED');
  for(const name of PUBLIC_JOURNAL_TABLES)expect(f.partition.db.queryAll(`SELECT * FROM ${name}`)).toEqual([]);
  expect(f.partition.db.queryAll(`SELECT * FROM ${table}`)).toEqual(before);
  expect(f.partition.db.queryOne('SELECT public_initialization FROM execution_partition_identity_v1')).toEqual({public_initialization:'fresh-public-v1'});
});
it('checks legacy cursor history again inside the fresh preparation transaction and rolls back',async()=>{
  const f=await fixture(true);let captures=0;
  expect(()=>initializePublicStreamJournal({catalog:f.catalog,origin,configuredPin:pinHex,
    activation:{partition:f.partition,assertCurrent() {if(++captures===2)legacyHistory(f.partition.db,'world_stream_cursor');}}})).toThrow('PUBLIC_JOURNAL_INITIALIZATION_REQUIRED');
  expect(captures).toBe(2);
  for(const name of PUBLIC_JOURNAL_TABLES)expect(f.partition.db.queryAll(`SELECT * FROM ${name}`)).toEqual([]);
  expect(f.partition.db.queryOne('SELECT public_initialization FROM execution_partition_identity_v1')).toEqual({public_initialization:'fresh-public-v1'});
  expect(f.partition.db.queryOne("SELECT name FROM sqlite_master WHERE name='world_stream_cursor'")).toBeNull();
});
it('keeps true fresh preparation available with known empty legacy schema',async()=>{
  const f=await fixture(true);
  new PublicWorldStreamClient({db:f.partition.db,baseUrl:origin}).ensureSchema();
  f.partition.db.execute('DELETE FROM world_stream_cursor');
  const report=initializePublicStreamJournal({catalog:f.catalog,origin,configuredPin:pinHex,activation:{partition:f.partition,assertCurrent() {}}});
  expect(report.imported).toBe(0);
  expect(f.partition.db.queryOne('SELECT public_initialization FROM execution_partition_identity_v1')).toEqual({public_initialization:'prepared-public-v1'});
});


it('fences the actual receiver on incarnation change even when its configured key getter stays unchanged',async()=>{
  const f=await fixture(),resource=f.open();await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
  const writer=new LocalHostDb(f.paths.socialDb());
  try {writer.execute("UPDATE house_binding_pin SET incarnation='new-house',revision=revision+1 WHERE origin=?",[origin]);}
  finally {writer.close();}
  resource.refresh?.();
  expect(f.requests[0]!.init?.signal?.aborted).toBe(true);
  expect(f.resources.capture(origin)).toBeNull();
  expect(f.resources.status(origin).detail).toContain('PUBLIC_BINDING_MISMATCH');
  await resource.stop();
});
it.each(['missing-schema','missing-row','blocked','same-tuple'] as const)('current public binding requires complete trust after %s',async change=>{
  const f=await fixture();
  if(change==='missing-schema')f.db.execute('DROP TABLE house_binding_pin');
  if(change==='missing-row')f.db.execute('DELETE FROM house_binding_pin');
  if(change==='blocked')f.db.execute("UPDATE house_binding_pin SET blocked_reason='synthetic' WHERE origin=?",[origin]);
  if(change==='same-tuple')f.db.execute('UPDATE house_binding_pin SET revision=revision+1,confirmed_at=confirmed_at+1 WHERE origin=?',[origin]);
  expect(f.resources.capture(origin)===null).toBe(change!=='same-tuple');
});
