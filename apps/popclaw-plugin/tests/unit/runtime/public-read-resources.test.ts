import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializePublicStreamJournal } from '../../../src/host/execution-store-migration.js';
import { MaintenanceSession } from '../../../src/host/storage-maintenance.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { makeWorldManifestPreparer, readHouseCapabilityView } from '../../../src/world/world-capabilities.js';
import { PublicReadResources, publicProducerPolicy } from '../../../src/runtime/house-lifecycle/public-read-resources.js';
import { HouseLifecycleCoordinator } from '../../../src/runtime/house-lifecycle/coordinator.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const origin = 'https://public-resource.invalid', pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const pinHex = Buffer.from(pair.publicKey).toString('hex');
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'public-read-resource-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = new PopclawPaths(root), db = new LocalHostDb(paths.socialDb());
  cleanup.push(() => db.close());
  ensureHouseLifecycleSchema(db);
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex) VALUES(?,'test','enabled','disconnected',1,?)", [origin, pinHex]);
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId: bs58.encode(pair.publicKey) });
  cleanup.push(() => catalog.close());
  const partition = catalog.open(origin);
  async function observe(log = 'log_1', officialIds: unknown = []) {
    const rawBytes = new TextEncoder().encode(JSON.stringify({ official_ids: officialIds, world_interaction: { version: 1,
      public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: log, envelope_baseline: 'public-envelope-01' as const, initial_public_scopes: [] } } }));
    const core = { house: { origin, houseKey: bs58.encode(pair.publicKey), incarnation: 'house_1' }, manifestDigest: cidFromCanonical(rawBytes), signedAt: 1 };
    const bytes = popclaw.world.ManifestProof.encode(core).finish(), prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
    const signing = new Uint8Array(prefix.length + bytes.length); signing.set(prefix); signing.set(bytes, prefix.length);
    db.transaction((await makeWorldManifestPreparer()({ origin, rawBytes, ackKeyHex: pinHex, provenance: 'configured_pin', signal: new AbortController().signal,
      proofHeader: Buffer.from(popclaw.world.ManifestProof.encode({ ...core, authoritySignature: nacl.sign.detached(signing, pair.secretKey) }).finish()).toString('base64') })).commit);
  }
  await observe();
  const maintenance = MaintenanceSession.begin(db, paths, 'public resource fixture');
  initializePublicStreamJournal({ catalog, origin, maintenance, configuredPin: pinHex });
  maintenance.finish({ recovery: false, reason: 'synthetic initialized' });
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
  return { db, catalog, partition, resources, requests, fetch, house, cacheRecord, open, observe,
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
