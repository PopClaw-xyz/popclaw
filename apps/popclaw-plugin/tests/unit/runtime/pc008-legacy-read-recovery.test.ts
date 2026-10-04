/**
 * PC-008 recovery regression, initially RED on fixed baseline 71f5141a.
 * Explicit recovery and conservative rejection cases use production paths.
 * All identities, origins, proofs, SQLite rows, holds and transport are synthetic.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { publishStorageJson, registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { ActionInactiveError } from '../../../src/runtime/house-lifecycle/action-context.js';
import { normalizeHouseOrigin } from '../../../src/runtime/house-lifecycle/control-client.js';
import { commitLocalLogout, readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { houseReadAuthority } from '../../../src/identity/read-authority.js';
import type { Signer } from '../../../src/identity/signer.js';
import { pinnedBinding } from '../../../src/world/house-binding-pin.js';
import { readVerifiedDeclaration } from '../../../src/world/house-read-declaration.js';
import { WorldSummaryClient } from '../../../src/world/world-summary-client.js';
import { WorldFeedClient } from '../../../src/ingress/world-feed-client.js';
import { runPopclawFeedCommand } from '../../../src/commands/popclaw-feed.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';
import { runHouseAddCommand } from '../../../src/commands/house.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const ORIGIN = 'https://house.pc008.invalid';
const CLOCK = 1_800_000_000_000;
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const PUBLIC_BODY = { window_hours: 24, generated_at_ms: CLOCK, total_posts: 7,
  distinct_authors: 2, authors: {}, hot_posts: [] };
const cleanup: Array<() => Promise<void>> = [];

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => {
  throw new Error('PC008_REAL_NETWORK_FORBIDDEN');
})));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function fixture(overrides: Partial<import('../../../src/runtime/house-lifecycle/house-runtime.js').HouseRuntimeOptions> = {}) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const root = mkdtempSync(join(tmpdir(), 'pc008-legacy-read-'));
  const paths = new PopclawPaths(root);
  const releaseStorage = registerStorageRuntime(db, paths);
  const actorKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(81));
  const actorId = bs58.encode(actorKey.publicKey);
  const signer = { publicKey: async () => actorKey.publicKey, popclawId: async () => actorId,
    sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, actorKey.secretKey) } as Signer;
  const house = mintHouse({ origin: ORIGIN, seed: 82 });
  const calls: Array<{url: string; method: string; hasCredentials: boolean}> = [];
  let deferred: (() => Promise<Response>) | undefined;
  let manifest = house.fetch;
  let control: ((init: RequestInit) => Promise<Response>) | undefined;
  let beforeManifest: (() => Promise<void>) | undefined;
  const origins = [ORIGIN];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    calls.push({ url, method, hasCredentials: ['authorization','cookie','x-popclaw-inbox-token'].some(k => headers.has(k)) });
    if (method === 'POST' && url === ORIGIN + '/v1/house-session' && control) return control(init!);
    if (method !== 'GET' && method !== 'HEAD') throw new Error('PC008_WRITE_TRANSPORT_FORBIDDEN');
    if (url === ORIGIN + '/v1/manifest') { if (beforeManifest) await beforeManifest(); return manifest(url); }
    if (url.startsWith(ORIGIN + '/v1/world-summary')) {
      if (deferred) return deferred();
      return Response.json(PUBLIC_BODY);
    }
    if (url.startsWith(ORIGIN + '/world-feed')) return new Response(
      popclaw.event.WorldFeedSnapshot.encode({ items: [] }).finish() as unknown as BodyInit,
      { headers: { 'content-type': 'application/x-protobuf' } });
    throw new Error('PC008_UNEXPECTED_TARGET:' + url);
  }) as typeof globalThis.fetch;

  // Explicit relation add verifies the original pin/active relation shape
  // without a first-pin lifecycle handoff. The unavailable PC008 row below
  // remains the recovery subject; do not pre-seed or auto-grant its lane.
  const pinResult = await runHouseAddCommand(ORIGIN, { db, recipientPopclawId: actorId,
    fetch: transport, now: () => CLOCK / 1000 });
  expect(pinResult.ok).toBe(true);
  const rt = new HouseRuntime({ db, signer, origins, fetch: transport,
    clock: () => CLOCK, commandPollMs: 1, commandTimeoutMs: 1000,
    readAuthorityFor: origin => houseReadAuthority({ db, signer, clock: () => CLOCK }, origin), ...overrides });
  // Synthetic analogue of the PC008 metadata: enabled/connecting/unsupported,
  // op_seq=1, verified pin+relation, no session/ACK/lease/read-token authority.
  db.execute(`INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase,
    session_id,house_revision,lease_expires_at,inbox_read_token,ack_key_hex,remote_status,remote_error)
    VALUES (?, ?, 1, 'enabled', 'connecting', '', 0, 0, '', '', 'unsupported', 'no house_session board')`,
  [ORIGIN, rt.manager.installationId]);
  // Suppress every resource transport. This test concerns foreground public GETs;
  // cacheReadOnly has no effect on manager/owner/participation/read gates.
  const store = { baseUrl: ORIGIN, slug: 'house-pc008-invalid', db, dbPath: ':memory:',
    cacheReadOnly: true, cache: {} as never } as HouseStore;
  rt.configureResources({ host: { db } as never, recipientPopclawId: actorId,
    worldStreamMode: true, stores: [store], openStore: async () => store,
    isOfficialActor: () => false });
  const summary = new WorldSummaryClient({ baseUrl: ORIGIN, fetch: rt.fetchHouse });
  const snapshot = new WorldFeedClient({ baseUrl: ORIGIN, fetch: rt.houseFetch(ORIGIN) });
  calls.length = 0;
  cleanup.push(async () => { await rt.stop(); releaseStorage(); db.close(); rmSync(root, {recursive: true, force: true}); });
  return { db, rt, house, summary, snapshot, calls, paths, signer, origins, transport, store,
    serveControl: (serve: (init: RequestInit) => Promise<Response>) => {control=serve;},
    serveManifest: (serve: typeof house.fetch) => { manifest = serve; },
    beforeManifest: (work: () => Promise<void>) => { beforeManifest = work; },
    phaseOnly: () => db.execute("UPDATE house_participation SET phase='connected' WHERE house_origin=?", [ORIGIN]),
    deferSummary: (work: () => Promise<Response>) => { deferred = work; } };
}

it('PC008 characterization: verified active relation is not a lifecycle read grant', async () => {
  const f = await fixture(); f.rt.start();
  const pin = pinnedBinding(f.db, ORIGIN)!;
  expect(pin.blockedReason).toBeUndefined();
  expect(readVerifiedDeclaration(f.db, pin)?.sessionBoard).toBe(false);
  expect(f.db.queryOne('SELECT active,owner_generation FROM relation_participation WHERE house_key=?',
    [f.house.houseKey])).toEqual({active: 1, owner_generation: 1});
  expect(f.rt.resident.authority.captureEpoch()).not.toBeNull();
  expect(f.rt.captureGate(ORIGIN).isActive()).toBe(false);
  await expect(f.rt.runCommand(() => f.snapshot.fetchSnapshot({limit: 20}))).rejects.toBeInstanceOf(ActionInactiveError);
  await expect(f.rt.runCommand(() => f.summary.fetchSummary(24))).resolves.toBeNull();
  const feed = await f.rt.runCommand(() => runPopclawFeedCommand({positional: [], flags: {}}, f.snapshot));
  expect(feed.text).not.toBe('');
  expect(readParticipation(f.db, ORIGIN)).toMatchObject({desired: 'enabled', phase: 'connecting'});
  expect(f.calls).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});

it('PC008 characterization: changing phase opens restricted public GET but not resident-owned GET in a reader', async () => {
  const f = await fixture(); f.phaseOnly();
  expect(f.rt.resident.authority.captureEpoch()).toBeNull();
  const response = await f.rt.runCommand(() => f.rt.houseReadFetch(ORIGIN)(ORIGIN + '/v1/world-summary'));
  expect(await response.json()).toEqual(PUBLIC_BODY);
  await expect(f.rt.runCommand(() => f.rt.houseFetch(ORIGIN)(ORIGIN + '/v1/world-summary'))).rejects.toBeInstanceOf(ActionInactiveError);
  await expect(f.rt.runCommand(() => f.summary.fetchSummary())).resolves.toBeNull();
  expect(f.calls).toHaveLength(1); expect(f.calls[0]?.hasCredentials).toBe(false);
});

it('PC008 characterization: phase plus actual owner permits public body but never grants a session command', async () => {
  const f = await fixture(); f.phaseOnly(); f.rt.start();
  await expect(f.rt.runCommand(() => f.summary.fetchSummary(24))).resolves.toEqual(PUBLIC_BODY);
  await expect(f.rt.runCommand(() => f.snapshot.fetchSnapshot({limit: 20}))).resolves.toEqual([]);
  expect(f.calls.map(c => c.url)).toEqual([ORIGIN + '/v1/world-summary?window_hours=24', ORIGIN + '/world-feed?limit=20']);
  expect(() => f.rt.captureSessionCommandContext(ORIGIN)).toThrow('HOUSE_SESSION_CONTEXT_UNAVAILABLE');
  expect(readParticipation(f.db, ORIGIN)).toMatchObject({session_id: '', ack_key_hex: '', house_revision: 0, remote_status: 'unsupported'});
});

it('PC008 recovery: blocked relation pin refuses every legacy GET lane', async () => {
  const f = await fixture(); f.phaseOnly(); f.rt.start();
  f.db.execute('UPDATE house_binding_pin SET blocked_reason=? WHERE origin=?', ['fixture key conflict', ORIGIN]);
  await expect(houseReadAuthority({db: f.db, signer: {} as Signer}, ORIGIN)('relation-list'))
    .resolves.toMatchObject({ok: false, refusal: 'READ_AUTH_HOUSE_NOT_TRUSTED'});
  for (const read of [f.rt.houseReadFetch(ORIGIN), f.rt.houseFetch(ORIGIN)]) {
    await expect(f.rt.runCommand(() => read(ORIGIN + '/v1/world-summary'))).rejects.toBeInstanceOf(ActionInactiveError);
  }
  await expect(f.rt.runCommand(() => f.summary.fetchSummary())).resolves.toBeNull();
  expect(f.calls).toHaveLength(0);
});

it('PC008 characterization: an execution storage hold still blocks both GET lanes after a phase change', async () => {
  const f = await fixture(); f.phaseOnly(); f.rt.start();
  publishStorageJson(f.paths.storageControlFile(), {version: 1, epoch: 'synthetic-storage-epoch',
    mode: 'recovery', reason: 'fixture only', held: ['execution','consumers','notifications'], releases: {}});
  expect(f.rt.captureGate(ORIGIN).isActive()).toBe(false);
  for (const read of [f.rt.houseFetch(ORIGIN), f.rt.houseReadFetch(ORIGIN)]) {
    await expect(f.rt.runCommand(() => read(ORIGIN + '/v1/world-summary'))).rejects.toBeInstanceOf(ActionInactiveError);
  }
  expect(f.calls).toEqual([]);
});

it('PC008 characterization: owner epoch takeover closes actual GET while the public lane deliberately survives', async () => {
  const f = await fixture(); f.phaseOnly(); f.rt.start();
  const captured = f.rt.captureGate(ORIGIN);
  f.db.execute('UPDATE house_lifecycle_owner SET generation=generation+1,holder=? WHERE id=1', ['synthetic-other-owner']);
  expect(captured.isActive()).toBe(false);
  await expect(f.rt.runCommand(() => f.rt.houseFetch(ORIGIN)(ORIGIN + '/v1/world-summary'))).rejects.toBeInstanceOf(ActionInactiveError);
  const response = await f.rt.runCommand(() => f.rt.houseReadFetch(ORIGIN)(ORIGIN + '/v1/world-summary'));
  expect(await response.json()).toEqual(PUBLIC_BODY);
  expect(f.calls).toHaveLength(1);
});

it('PC008 characterization: disable and op_seq change fence an in-flight public response without clearing leave outbox', async () => {
  const f = await fixture(); f.phaseOnly(); f.rt.start();
  let resolveResponse!: (r: Response) => void;
  f.deferSummary(() => new Promise<Response>(r => { resolveResponse = r; }));
  const task = f.rt.runCommand(() => f.rt.houseReadFetch(ORIGIN)(ORIGIN + '/v1/world-summary'));
  await vi.waitFor(() => expect(f.calls).toHaveLength(1));
  commitLocalLogout(f.db, ORIGIN, f.rt.manager.installationId, 'synthetic-leave', CLOCK/1000, '');
  resolveResponse(Response.json(PUBLIC_BODY));
  await expect(task).rejects.toBeInstanceOf(ActionInactiveError);
  expect(readParticipation(f.db, ORIGIN)).toMatchObject({desired: 'disabled', op_seq: 2});
  expect(f.db.queryOne('SELECT op,op_seq,settled_at FROM house_lifecycle_outbox WHERE request_id=?',
    ['synthetic-leave'])).toEqual({op: 'leave', op_seq: 2, settled_at: null});
});

it.each(['expired-session', 'session-pin-conflict'] as const)('PC008 characterization: phase alone cannot bypass %s', async kind => {
  const f = await fixture(); f.phaseOnly();
  f.db.execute('UPDATE house_participation SET session_id=?,ack_key_hex=?,house_revision=7,lease_expires_at=? WHERE house_origin=?',
    ['synthetic-session', 'ab'.repeat(32), kind === 'expired-session' ? CLOCK/1000-1 : CLOCK/1000+90, ORIGIN]);
  if (kind === 'session-pin-conflict') {
    // Rebuild only the configured-pin comparison through the actual shared gate.
    const { HouseLifecycleManager } = await import('../../../src/runtime/house-lifecycle/manager.js');
    expect(HouseLifecycleManager.pinAgreesWithBinding(readParticipation(f.db, ORIGIN)!, 'cd'.repeat(32))).toBe(false);
  } else {
    f.rt.start();
    for (const read of [f.rt.houseFetch(ORIGIN), f.rt.houseReadFetch(ORIGIN)])
      await expect(f.rt.runCommand(() => read(ORIGIN + '/v1/world-summary'))).rejects.toBeInstanceOf(ActionInactiveError);
    expect(f.calls).toEqual([]);
  }
});

it('PC008 characterization: restart seed never revives disabled or repairs an existing unsupported row', async () => {
  const f = await fixture();
  expect(f.rt.manager.seedLegacyHouse(ORIGIN)).toBe(false);
  expect(readParticipation(f.db, ORIGIN)?.phase).toBe('connecting');
  commitLocalLogout(f.db, ORIGIN, f.rt.manager.installationId, 'synthetic-leave', CLOCK/1000, '');
  expect(f.rt.manager.seedLegacyHouse(ORIGIN)).toBe(false);
  expect(readParticipation(f.db, ORIGIN)).toMatchObject({desired: 'disabled', phase: 'disconnected'});
  expect(f.calls).toEqual([]);
});

it('PC008 characterization: origin normalization never guesses a house subdomain from a human website', () => {
  expect(normalizeHouseOrigin('pc008.invalid')).toBe('https://pc008.invalid');
  expect(normalizeHouseOrigin('house.pc008.invalid')).toBe(ORIGIN);
});

it('PC008 recovery: explicit same-origin login restores real summary and protobuf feed', async () => {
  const f = await fixture(); f.rt.start();
  // start() schedules resumeAfterOwnership; let its empty worker drain
  // re-arm the control generation before submitting a foreground login.
  await new Promise<void>(resolve => setImmediate(resolve));
  const outcome = await f.rt.commands.loginHouse(ORIGIN);
  expect(outcome).toMatchObject({status: 'unsupported', errorCode: 'HOUSE_LIFECYCLE_UNSUPPORTED', legacyAvailable: true});
  expect(pinnedBinding(f.db, ORIGIN)?.houseKey).toBe(f.house.houseKey);
  expect(readVerifiedDeclaration(f.db, pinnedBinding(f.db, ORIGIN)!)?.sessionBoard).toBe(false);
  // Desired contract: preserve the honest unsupported result, but recover
  // actual public GET under verified proof/current owner/CAS/storage fences.
  // The original fixed baseline returned null before any public GET.
  const actual = await f.rt.runCommand(() => f.summary.fetchSummary(24));
  await expect(f.rt.runCommand(() => f.snapshot.fetchSnapshot({limit: 20}))).resolves.toEqual([]);
  const observed = {phase: readParticipation(f.db, ORIGIN)?.phase,
    summaryGETs: f.calls.filter(c => c.url.startsWith(ORIGIN + '/v1/world-summary')).length};
  expect(actual, 'verified board-less recovery must yield the public body; observed=' + JSON.stringify(observed)).toEqual(PUBLIC_BODY);
  expect(readParticipation(f.db, ORIGIN)).toMatchObject({remote_status: 'unsupported', session_id: '', ack_key_hex: ''});
  expect(f.calls.some(c => c.url.startsWith(ORIGIN + '/v1/world-summary'))).toBe(true);
  expect(f.calls.every(c => c.method === 'GET' && !c.hasCredentials)).toBe(true);
});

async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  f.rt.start(); await new Promise<void>(resolve => setImmediate(resolve));
}

it.each([
  ['ack_key_hex', 'ab'.repeat(32)], ['session_id', 'observed-session'],
  ['inbox_read_token', 'observed-token'], ['house_revision', 1], ['lease_expires_at', 1],
] as const)('PC008 recovery: retained %s control history cannot become legacy', async (column, value) => {
  const f=await fixture(); f.db.execute(`UPDATE house_participation SET ${column}=? WHERE house_origin=?`,[value,ORIGIN]);
  await ready(f); await f.rt.commands.loginHouse(ORIGIN);
  expect(readParticipation(f.db,ORIGIN)?.phase).toBe('connecting');
  expect((readParticipation(f.db,ORIGIN) as unknown as Record<string,unknown>)[column]).toBe(value);
});

it.each([null, {}, {version:999}])('PC008 recovery: a present invalid board %j is not absence', async board => {
  const f=await fixture();
  const response=mintHouse({origin:ORIGIN,seed:82,manifest:{house_session:board}});
  f.serveManifest(response.fetch); await ready(f);
  const outcome=await f.rt.commands.loginHouse(ORIGIN);
  expect(outcome).toMatchObject({status:'unsupported',legacyAvailable:false});
  expect(readParticipation(f.db,ORIGIN)?.phase).toBe('connecting');
});

it.each([null, 1])('PC008 recovery: all leave ledger including settled=%s refuses admission', async settled => {
  const f=await fixture();
  f.db.execute(`INSERT INTO house_lifecycle_outbox(request_id,house_origin,op,op_seq,ack_key_hex,installation_id,created_at,settled_at)
    VALUES ('retained-leave',?,'leave',1,?,'old-install',0,?)`,[ORIGIN,'ab'.repeat(32),settled]);
  await ready(f); await f.rt.commands.loginHouse(ORIGIN);
  expect(readParticipation(f.db,ORIGIN)?.phase).toBe('connecting');
  expect(f.db.queryOne('SELECT ack_key_hex,settled_at FROM house_lifecycle_outbox WHERE request_id=?',['retained-leave']))
    .toEqual({ack_key_hex:'ab'.repeat(32),settled_at:settled});
});

it.each(['receipt','reservation','progress'])('PC008 recovery: managed restore %s refuses even after hold release', async kind => {
  const f=await fixture();
  if(kind==='receipt') {
    f.db.execute('CREATE TABLE storage_restore_applied_v1(epoch TEXT PRIMARY KEY,set_id TEXT,operation TEXT)');
    f.db.execute("INSERT INTO storage_restore_applied_v1 VALUES('older-root','snapshot','clone')");
  } else {
    publishStorageJson(kind==='reservation'?join(f.paths.rootDir(),'.restore-reservation'):join(f.paths.vaultSocialDir(),'restore-progress.json'),{version:1});
  }
  publishStorageJson(f.paths.storageControlFile(),{version:1,epoch:'released',mode:'recovery',reason:'synthetic',held:[],releases:{}});
  await ready(f); await f.rt.commands.loginHouse(ORIGIN);
  expect(readParticipation(f.db,ORIGIN)?.phase).toBe('connecting');
});

it('PC008 recovery: unknown schema cannot prove absence of control history', async()=>{
  const f=await fixture(); f.db.execute('ALTER TABLE house_lifecycle_outbox ADD COLUMN unsupported_history TEXT');
  await ready(f); await f.rt.commands.loginHouse(ORIGIN);
  expect(readParticipation(f.db,ORIGIN)?.phase).toBe('connecting');
});

it('configured admission refuses an unresolved earlier enter even with empty current credentials', async()=>{
  const f=await fixture(); f.db.execute("UPDATE house_participation SET pending_enter_request_id='proven-unsent' WHERE house_origin=?",[ORIGIN]);
  await ready(f); const first=await f.rt.commands.loginHouse(ORIGIN);
  expect(first).toMatchObject({status:'unsupported',legacyAvailable:false});
  expect(readParticipation(f.db,ORIGIN)).toMatchObject({phase:'connecting',pending_enter_request_id:'proven-unsent'});
  expect((await f.rt.commands.loginHouse(ORIGIN)).legacyAvailable).toBe(false);
});

it('configured public reads require a verified binding; a fresh explicit join may establish it', async()=>{
  const f=await fixture(); f.db.execute('DELETE FROM house_binding_pin'); f.phaseOnly(); await ready(f);
  await expect(f.rt.runCommand(()=>f.summary.fetchSummary())).resolves.toBeNull();
  const captured=f.rt.captureGate(ORIGIN);
  // Appearance of a trusted pin changes the authority, including no-pin captures.
  const {establishTrust}=await import('../../../src/world/house-binding-pin.js');
  establishTrust(f.db,{origin:ORIGIN,houseKey:f.house.houseKey,incarnation:f.house.incarnation},'tofu',()=>CLOCK/1000);
  expect(captured.isActive()).toBe(false);
  const g=await fixture(); g.db.execute('DELETE FROM house_binding_pin'); await ready(g);
  await g.rt.commands.loginHouse(ORIGIN);
  expect(readParticipation(g.db,ORIGIN)?.phase).toBe('connected');
});

it.each(['logout','owner','trust','storage','key','config','pending'])('PC008 recovery: manifest await revoked by %s never restores', async kind=>{
  const f=await fixture(); let release!:()=>void;
  f.beforeManifest(()=>new Promise<void>(r=>{release=r;})); await ready(f);
  const task=f.rt.commands.loginHouse(ORIGIN);
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  if(kind==='logout') commitLocalLogout(f.db,ORIGIN,f.rt.manager.installationId,'concurrent-leave',CLOCK/1000,'');
  if(kind==='owner') f.db.execute("UPDATE house_lifecycle_owner SET generation=generation+1,holder='other-owner'");
  if(kind==='trust') f.db.execute("UPDATE house_binding_pin SET blocked_reason='concurrent-block',revision=revision+1 WHERE origin=?",[ORIGIN]);
  if(kind==='storage') publishStorageJson(f.paths.storageControlFile(),{version:1,epoch:'hold',mode:'recovery',reason:'fixture',held:['execution'],releases:{}});
  if(kind==='key') f.db.execute('UPDATE house_participation SET ack_key_hex=? WHERE house_origin=?',['ab'.repeat(32),ORIGIN]);
  if(kind==='config') f.origins.splice(0);
  if(kind==='pending') f.db.execute("UPDATE house_participation SET pending_enter_request_id='other-enter' WHERE house_origin=?",[ORIGIN]);
  release(); await task;
  expect(readParticipation(f.db,ORIGIN)?.phase).not.toBe('connected');
});

it.each(['removal','replacement','revision','unreadable'])('PC008 recovery: captured public body authority is revoked by pin %s', async kind=>{
  const f=await fixture(); f.phaseOnly(); await ready(f);
  const response=await f.rt.runCommand(()=>f.rt.houseFetch(ORIGIN)(ORIGIN+'/v1/world-summary'));
  if(kind==='removal') f.db.execute('DELETE FROM house_binding_pin WHERE origin=?',[ORIGIN]);
  if(kind==='replacement') f.db.execute("UPDATE house_binding_pin SET incarnation='replacement',revision=revision+1 WHERE origin=?",[ORIGIN]);
  if(kind==='revision') f.db.execute('UPDATE house_binding_pin SET revision=revision+1 WHERE origin=?',[ORIGIN]);
  if(kind==='unreadable') vi.spyOn(f.db,'queryOne').mockImplementation(()=>{throw new Error('SYNTHETIC_QUERY_FAILURE');});
  await expect(response.json()).rejects.toBeInstanceOf(ActionInactiveError);
});


it.each(['proof-missing','proof-invalid','incarnation','network','http','parse'])('PC008 recovery: fresh manifest %s never grants legacy authority',async kind=>{
  const f=await fixture();
  if(kind==='network') f.serveManifest(async()=>{throw new TypeError('synthetic network');});
  if(kind==='http') f.serveManifest(async()=>new Response('synthetic unavailable',{status:503}));
  if(kind==='parse') f.serveManifest(async()=>new Response('<html>synthetic</html>'));
  if(kind==='proof-missing') f.serveManifest(async()=>new Response(f.house.bodyBytes.slice().buffer as ArrayBuffer));
  if(kind==='proof-invalid') f.serveManifest(mintHouse({origin:ORIGIN,seed:82,signWith:nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99)).secretKey}).fetch);
  if(kind==='incarnation') f.serveManifest(mintHouse({origin:ORIGIN,seed:82,incarnation:'new-incarnation'}).fetch);
  await ready(f);
  if(kind==='parse') await expect(f.rt.commands.loginHouse(ORIGIN)).rejects.toThrow('invalid JSON');
  else expect((await f.rt.commands.loginHouse(ORIGIN)).legacyAvailable).not.toBe(true);
  expect(readParticipation(f.db,ORIGIN)?.phase).not.toBe('connected');
  if(kind==='incarnation') expect(pinnedBinding(f.db,ORIGIN)?.blockedReason).toBeTruthy();
  expect(f.calls.every(c=>!c.url.includes('world-summary') && !c.url.includes('world-feed'))).toBe(true);
});

it.each(['query','positive-session','positive-fence'])('PC008 recovery: %s history is a refusal, never empty proof',async kind=>{
  const f=await fixture(); await ready(f);
  if(kind==='query') {
    const original=f.db.queryAll.bind(f.db);
    vi.spyOn(f.db,'queryAll').mockImplementation((sql,params)=>{
      if(sql.startsWith('PRAGMA table_info')) throw new Error('synthetic unreadable history');
      return original(sql,params);
    });
  } else {
    f.db.execute(`INSERT INTO house_lifecycle_commands(request_id,kind,house_origin,baseline_seq,state,created_at,result_json,session_id)
      VALUES('contradiction','status',?,1,'done',0,?,?)`,[ORIGIN,kind==='positive-fence'?JSON.stringify({errorCode:'SESSION_FENCED'}):null,kind==='positive-session'?'past-session':null]);
  }
  await f.rt.commands.loginHouse(ORIGIN);
  expect(readParticipation(f.db,ORIGIN)?.phase).toBe('connecting');
});

it('PC008 recovery: malformed empty fields cannot be coerced into supported history',async()=>{
  const {emptyControlState}=await import('../../../src/runtime/house-lifecycle/legacy-history.js');
  const f=await fixture(); const row=readParticipation(f.db,ORIGIN)!;
  for(const key of ['session_id','ack_key_hex','inbox_read_token','house_revision','lease_expires_at','pending_enter_request_id']) {
    for(const value of [undefined,null,false]) {
      if(key==='pending_enter_request_id' && value===null) continue;
      expect(emptyControlState({...row,[key]:value})).toBe(false);
    }
  }
});

it.each(['logout','owner','trust','storage','pending','config'])('PC008 recovery: relation preparation await revoked by %s',async kind=>{
  const {makeRelationBindingPreparer}=await import('../../../src/social-graph/relation-binding.js');
  let release!:()=>void;
  const prep:{value?:ReturnType<typeof makeRelationBindingPreparer>}={};
  const f=await fixture({prepareRelationBinding:async input=>{
    const prepared=await prep.value!(input);
    await new Promise<void>(resolve=>{release=resolve;}); return prepared;
  }});
  prep.value=makeRelationBindingPreparer({db:f.db,now:()=>CLOCK/1000});
  await ready(f); const task=f.rt.commands.loginHouse(ORIGIN);
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  if(kind==='logout') commitLocalLogout(f.db,ORIGIN,f.rt.manager.installationId,'during-proof',CLOCK/1000,'');
  if(kind==='owner') f.db.execute("UPDATE house_lifecycle_owner SET generation=generation+1,holder='other'");
  if(kind==='trust') f.db.execute("UPDATE house_binding_pin SET blocked_reason='during-proof',revision=revision+1 WHERE origin=?",[ORIGIN]);
  if(kind==='storage') publishStorageJson(f.paths.storageControlFile(),{version:1,epoch:'proof-hold',mode:'recovery',reason:'synthetic',held:['execution'],releases:{}});
  if(kind==='pending') f.db.execute("UPDATE house_participation SET pending_enter_request_id='new-pending' WHERE house_origin=?",[ORIGIN]);
  if(kind==='config') f.origins.splice(0);
  release(); await task;
  expect(readParticipation(f.db,ORIGIN)?.phase).not.toBe('connected');
});

it('PC008 recovery: resource/signing authority and undeclared private reads stay independently fenced',async()=>{
  const {withResourceAction,actionSigner}=await import('../../../src/runtime/house-lifecycle/action-context.js');
  const f=await fixture(); await ready(f); await f.rt.commands.loginHouse(ORIGIN);
  expect(() => f.rt.captureSessionCommandContext(ORIGIN)).toThrow('HOUSE_SESSION_CONTEXT_UNAVAILABLE');
  await expect(houseReadAuthority({db:f.db,signer:f.signer},ORIGIN)('inbox-stream')).resolves.toMatchObject({ok:false});
  const gate=f.rt.manager.gateFor(ORIGIN);
  let release!:(bytes:Uint8Array)=>void;
  const raw={...f.signer,sign:()=>new Promise<Uint8Array>(resolve=>{release=resolve;})} as Signer;
  const task=withResourceAction(gate,()=>actionSigner(raw).sign(new Uint8Array([1])));
  f.db.execute("UPDATE house_binding_pin SET blocked_reason='blocked-after-sign',revision=revision+1 WHERE origin=?",[ORIGIN]);
  release(new Uint8Array(64));
  await expect(task).rejects.toBeInstanceOf(ActionInactiveError);
  expect(gate.isActive()).toBe(false);
});

it('PC008 recovery: a restarted runtime reopens only durable legacy authority and current pin',async()=>{
  const f=await fixture(); await ready(f); await f.rt.commands.loginHouse(ORIGIN); await f.rt.stop();
  const g=new HouseRuntime({db:f.db,signer:f.signer,origins:[ORIGIN],fetch:f.transport,clock:()=>CLOCK,readAuthorityFor:origin=>houseReadAuthority({db:f.db,signer:f.signer},origin)});
  g.configureResources({host:{db:f.db} as never,recipientPopclawId:await f.signer.popclawId(),worldStreamMode:true,stores:[f.store],openStore:async()=>f.store,isOfficialActor:()=>false});
  cleanup.push(()=>g.stop()); g.start();
  await expect(g.runCommand(()=>new WorldSummaryClient({baseUrl:ORIGIN,fetch:g.fetchHouse}).fetchSummary())).resolves.toEqual(PUBLIC_BODY);
  f.db.execute("UPDATE house_binding_pin SET blocked_reason='restart-block',revision=revision+1 WHERE origin=?",[ORIGIN]);
  expect(g.captureGate(ORIGIN).isActive()).toBe(false);
});

it.each(['lost-ack','verified-reject'])('PC008 recovery: actual %s session control leaves sticky evidence that rejects subsequent board-less downgrade',async kind=>{
  const {ackSigningInput}=await import('@popclaw/algorithms');
  const kp=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(82));
  const ackKey=Buffer.from(kp.publicKey).toString('hex');
  const f=await fixture({prepareTrustedManifest:async()=>({commit:()=>{}})});
  f.serveManifest(mintHouse({origin:ORIGIN,seed:82,manifest:{house_session:{version:1,endpoint:'/v1/house-session',ack_pubkey:ackKey,operations:['enter','renew','leave','status','action'],lease_seconds:90,renew_interval_seconds:30}}}).fetch);
  f.serveControl(async init=>{
    if(kind==='lost-ack') throw new TypeError('synthetic lost response');
    const bytes=new Uint8Array(await new Response(init.body).arrayBuffer());
    const hs=(popclaw as unknown as {housesession:{HouseSessionRequest:{decode(b:Uint8Array):{core:Record<string,unknown>}};HouseSessionAck:{encode(v:unknown):{finish():Uint8Array}}}}).housesession;
    const request=hs.HouseSessionRequest.decode(bytes).core;
    const core={houseOrigin:ORIGIN,popclawId:request.popclawId,installationId:request.installationId,requestId:request.requestId,opSeq:request.opSeq,operation:1,outcome:7,errorCode:4,serverCommittedAt:CLOCK/1000};
    const encoded=hs.HouseSessionAck.encode({core,signature:nacl.sign.detached(ackSigningInput(core),kp.secretKey),signerPubkey:kp.publicKey}).finish();
    return new Response(Uint8Array.from(encoded).buffer);
  });
  await ready(f); const controlResult=await f.rt.commands.loginHouse(ORIGIN);
  if(kind==='verified-reject') expect(controlResult.errorCode,JSON.stringify(readParticipation(f.db,ORIGIN))).toBe('EXECUTOR_BUSY');
  expect(f.calls.some(c=>c.method==='POST')).toBe(true);
  expect(readParticipation(f.db,ORIGIN)?.ack_key_hex).toBe(ackKey);
  f.serveManifest(f.house.fetch); await f.rt.commands.loginHouse(ORIGIN);
  expect(readParticipation(f.db,ORIGIN)).toMatchObject({phase:'connecting',ack_key_hex:ackKey});
});


it.each(['disabled','connecting','unsupported','owner','trust','storage'])('PC008 classification: actual %s gate returns its local cause with zero transport',async kind=>{
  const f=await fixture();
  if(kind==='connecting') f.db.execute("UPDATE house_participation SET remote_status='pending' WHERE house_origin=?",[ORIGIN]);
  if(kind==='disabled') f.db.execute("UPDATE house_participation SET desired='disabled' WHERE house_origin=?",[ORIGIN]);
  if(['owner','trust','storage'].includes(kind)) f.phaseOnly();
  if(kind!=='owner') await ready(f);
  if(kind==='trust') f.db.execute("UPDATE house_binding_pin SET blocked_reason='synthetic-block' WHERE origin=?",[ORIGIN]);
  if(kind==='storage') publishStorageJson(f.paths.storageControlFile(),{version:1,epoch:'read-hold',mode:'recovery',reason:'synthetic',held:['execution'],releases:{}});
  const expected={disabled:'HOUSE_DISABLED',connecting:'HOUSE_CONNECTING',unsupported:'HOUSE_LIFECYCLE_UNSUPPORTED',owner:'HOUSE_OWNER_INACTIVE',trust:'HOUSE_TRUST_REVOKED',storage:'HOUSE_STORAGE_UNAVAILABLE'}[kind];
  await expect(f.rt.runCommand(()=>f.summary.fetchSummaryResult())).resolves.toMatchObject({ok:false,failure:{code:expected}});
  expect(f.calls).toEqual([]);
});

it.each([false,true])('PC008 recovery: supported configured-pin LEAVE backfill, settled=%s, remains an exclusion',async settled=>{
  let pin='';
  const f=await fixture({configuredPinFor:()=>pin}); await ready(f);
  commitLocalLogout(f.db,ORIGIN,f.rt.manager.installationId,'outbox-only',CLOCK/1000,'');
  pin=Buffer.from(bs58.decode(f.house.houseKey)).toString('hex');
  f.serveControl(async()=>new Response('synthetic leave not found',{status:404}));
  await f.rt.manager.resumePendingOperations();
  await vi.waitFor(()=>expect(f.calls.some(c=>c.method==='POST')).toBe(true));
  expect(readParticipation(f.db,ORIGIN)?.ack_key_hex).toBe('');
  expect(f.db.queryOne('SELECT ack_key_hex FROM house_lifecycle_outbox WHERE request_id=?',['outbox-only'])).toEqual({ack_key_hex:pin});
  // Settling the retained row does not erase it or manufacture admission.
  if(settled) {
    const {settleOutboxRow}=await import('../../../src/runtime/house-lifecycle/participation-store.js');
    settleOutboxRow(f.db,'outbox-only','confirmed',CLOCK/1000);
  }
  pin=''; await f.rt.commands.loginHouse(ORIGIN); // ordinary explicit disabled login preserves existing semantics
  expect(readParticipation(f.db,ORIGIN)).toMatchObject({desired:'enabled',phase:'connecting',ack_key_hex:''});
  await f.rt.commands.loginHouse(ORIGIN); // now eligible shape still has the complete contradictory ledger
  expect(readParticipation(f.db,ORIGIN)?.phase).toBe('connecting');
  expect(f.db.queryOne('SELECT request_id FROM house_lifecycle_outbox WHERE request_id=?',['outbox-only'])).not.toBeNull();
});


it('PC008 classification: unreadable authority at capture is a local refusal with zero transport',async()=>{
  const f=await fixture(); f.phaseOnly(); await ready(f);
  const query=f.db.queryOne.bind(f.db);
  const spy=vi.spyOn(f.db,'queryOne').mockImplementation((sql,params)=>{
    if(sql.includes('house_participation') || sql.includes('house_binding_pin')) throw new Error('synthetic unreadable authority');
    return query(sql,params);
  });
  await expect(f.rt.runCommand(()=>f.summary.fetchSummaryResult())).resolves.toMatchObject({ok:false,failure:{code:'HOUSE_TRUST_REVOKED'}});
  for(const fetch of [f.rt.houseFetch(ORIGIN),f.rt.houseReadFetch(ORIGIN)])
    await expect(fetch(ORIGIN+'/v1/world-summary')).rejects.toMatchObject({code:'HOUSE_TRUST_REVOKED'});
  expect(f.calls).toEqual([]); spy.mockRestore();
});


it.each(['unchanged','equivalent-empty','replaced','unreadable','changed-in-commit'])('PC008 review regression: configured pin %s cannot change the captured recovery selection',async kind=>{
  const {makeRelationBindingPreparer}=await import('../../../src/social-graph/relation-binding.js');
  const {houseKeyFromAckHex}=await import('../../../src/world/house-binding.js');
  let pin:string|undefined=''; let unreadable=false;
  const configuredPinFor=()=>{if(unreadable) throw new Error('SYNTHETIC_CONFIG_PIN_UNREADABLE');return pin;};
  let release!:()=>void; let suspended=true;
  const prep:{value?:ReturnType<typeof makeRelationBindingPreparer>}={};
  const f=await fixture({configuredPinFor,prepareRelationBinding:async input=>{
    const prepared=await prep.value!(input);
    if(suspended) await new Promise<void>(resolve=>{release=resolve;});
    return {commit:tx=>{
      const refusal=prepared.commit(tx);
      if(kind==='changed-in-commit' && suspended) pin='ab'.repeat(32);
      return refusal;
    }};
  }});
  prep.value=makeRelationBindingPreparer({db:f.db,now:()=>CLOCK/1000,
    configuredKeyFor:()=>{const selected=configuredPinFor();return selected?houseKeyFromAckHex(selected):undefined;}});
  await ready(f); const task=f.rt.commands.loginHouse(ORIGIN);
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  if(kind==='replaced') pin='ab'.repeat(32);
  if(kind==='unreadable') unreadable=true;
  if(kind==='equivalent-empty') pin=undefined;
  release(); const outcome=await task;
  const row=readParticipation(f.db,ORIGIN)!;
  expect(row).toMatchObject({session_id:'',ack_key_hex:'',house_revision:0,lease_expires_at:0,inbox_read_token:''});
  if(kind==='unchanged' || kind==='equivalent-empty') {
    expect(outcome.legacyAvailable).toBe(true);
    await expect(f.rt.runCommand(()=>f.summary.fetchSummaryResult())).resolves.toEqual({ok:true,summary:PUBLIC_BODY});
    await expect(f.rt.runCommand(()=>f.snapshot.fetchSnapshot({limit:20}))).resolves.toEqual([]);
  } else {
    expect(outcome.legacyAvailable).not.toBe(true);
    expect(row.phase).toBe('connecting');
    expect(row.pending_enter_request_id).toBeNull(); // this boardless round sent no control request; unrelated ledger stays intact
    expect(f.calls.filter(c=>c.url.includes('world-summary') || c.url.includes('world-feed'))).toEqual([]);
    // Reverting to the supported selection requires a new explicit command,
    // with fresh manifest/proof; the old operation was never recaptured.
    pin='';unreadable=false;suspended=false;
    await expect(f.rt.commands.loginHouse(ORIGIN)).resolves.toMatchObject({legacyAvailable:true});
    await expect(f.rt.runCommand(()=>f.summary.fetchSummaryResult())).resolves.toEqual({ok:true,summary:PUBLIC_BODY});
  }
});


it.each(['replaced','unreadable'])('PC008 review regression: configured pin %s during manifest await aborts before intent allocation',async kind=>{
  let pin='';let unreadable=false;
  const f=await fixture({configuredPinFor:()=>{if(unreadable) throw new Error('SYNTHETIC_CONFIG_PIN_UNREADABLE');return pin;}});
  let release!:()=>void;f.beforeManifest(()=>new Promise<void>(r=>{release=r;}));
  await ready(f); const task=f.rt.commands.loginHouse(ORIGIN);
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  if(kind==='replaced') pin='ab'.repeat(32);else unreadable=true;
  release();const outcome=await task;
  expect(outcome.legacyAvailable).not.toBe(true);
  expect(readParticipation(f.db,ORIGIN)).toMatchObject({phase:'connecting',op_seq:1,pending_enter_request_id:null,ack_key_hex:'',session_id:''});
});
