/** Standard fresh-root entry. Every key, manifest and response is synthetic;
 * the default origins are routed only through the injected transport. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { ackSigningInput } from '@popclaw/algorithms';
import { LocalHostAdapter } from '../../../src/host/local-host-adapter.js';
import { bootstrapPlugin } from '../../../src/runtime/plugin-bootstrap.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { readParticipation, readOutboxRow } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { houseReadAuthority } from '../../../src/identity/read-authority.js';
import { ResolveClient } from '../../../src/world/resolve-client.js';
import { pinnedBinding } from '../../../src/world/house-binding-pin.js';
import { pinConfiguredHouses } from '../../../src/social-graph/default-house-pinning.js';
import { makeToolCollector, dispatchMcpCall } from '../../../src/tools/mcp-adapter.js';
import { registerNamecardTool } from '../../../src/tools/identity-tools.js';
import { registerHouseTools } from '../../../src/tools/house-tools.js';
import { runHouseLoginCommand } from '../../../src/commands/popclaw-house.js';
import { mintHouse } from '../../helpers/signed-manifest.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';

const ME = 'https://house.popclaw.me', WORLD = 'https://house.popclaw.world';
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('REAL_NETWORK_FORBIDDEN'); })));
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function fixture(opts: { configuredPin?: boolean; publicV1?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'configured-entry-'));
  const paths = new PopclawPaths(root);
  let releaseStorage!: () => void;
  const host = new LocalHostAdapter({ dataRoot: root, logger: { info() {}, warn() {}, error() {} },
    beforeDbInitialize: db => (releaseStorage = registerStorageRuntime(db, paths)) });
  const db = host.db;
  const saveJson = vi.spyOn(host.config, 'saveJson');
  const boot = await bootstrapPlugin(host);
  const config = boot.config, signer = boot.signer, actorId = boot.popclawId;
  expect(boot.identityGenerated).toBe(true);
  expect(config.lore_houses).toEqual([ME]);
  expect(boot.loreHouseUrl).toBe(ME);
  expect(saveJson).toHaveBeenCalledWith('plugin', { lore_houses: [ME] });
  // Exercise the retained two-House configuration of existing installations.
  config.lore_houses.push(WORLD);
  const reboot = await bootstrapPlugin(host);
  expect(reboot.identityGenerated).toBe(false); expect(reboot.popclawId).toBe(actorId);
  const manifest = { relations: { ordered: 1 }, read_auth: { schemes: ['popclaw-identity-read-v2'] } };
  const houses = new Map([ME, WORLD].map((origin, index) => [origin, mintHouse({ origin, seed: 90 + index, manifest })]));
  const pins = new Map([...houses].map(([origin, house]) => [origin, Buffer.from(bs58.decode(house.houseKey)).toString('hex')]));
  let control: ((init: RequestInit) => Promise<Response>) | undefined;
  let beforeManifest: (() => Promise<void>) | undefined;
  const calls: Array<{url: string; method: string; headers: Headers}> = [];
  const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input), target = new URL(url);
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    if (target.pathname === '/v1/manifest') {
      if (beforeManifest) await beforeManifest();
      return houses.get(target.origin)!.fetch(url);
    }
    if (target.pathname === '/v1/house-session' && control) return control(init!);
    if (target.pathname.startsWith('/v1/profile/')) return Response.json({ popclaw_id: actorId, sigil: 'test0001', profiles: [], card: { nickname: 'Synthetic Nalan' } });
    if (target.pathname === '/v1/resolve') return Response.json({ candidates: [{
      popclaw_id: actorId, nickname: 'Synthetic Nalan', sigil: 'test0001' }] });
    throw new Error('UNEXPECTED_TRANSPORT:' + url);
  });
  const rt = new HouseRuntime({ db, signer, origins: config.lore_houses, fetch: transport,
    readAuthorityFor: origin => houseReadAuthority({ db, signer }, origin),
    commandPollMs: 1, commandTimeoutMs: 1000, intentPollMs: 60_000,
    ...(opts.configuredPin ? { configuredPinFor: (origin: string) => pins.get(origin) } : {}),
    ...(opts.publicV1 ? { publicV1Mode: true } : {}) });
  const stores = config.lore_houses.map(baseUrl => ({ baseUrl, db, cacheReadOnly: true,
    dbPath: paths.socialDb(), slug: new URL(baseUrl).hostname.replaceAll('.', '-'), cache: {} } as unknown as HouseStore));
  rt.configureResources({ host: { db } as never, recipientPopclawId: actorId, worldStreamMode: true,
    stores, openStore: async origin => stores.find(s => s.baseUrl === origin)!, isOfficialActor: () => false });
  rt.start();
  const pin = () => pinConfiguredHouses({ db, recipientPopclawId: actorId, origins: config.lore_houses,
    fetch: transport, pinning: rt.configuredHousePinning, onParticipationChanged: () => rt.resident.participationChanged() });
  const resolveName = (origin = ME) => rt.runCommand(() => new ResolveClient({ baseUrl: origin,
    fetch: rt.houseReadFetch(origin) }).resolve({ name: 'Synthetic Nalan' }));
  cleanup.push(async () => { await rt.stop(); releaseStorage(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { db, rt, calls, houses, pins, signer, pin, resolveName, transport, origins: config.lore_houses,
    serveControl: (serve: (init: RequestInit) => Promise<Response>) => { control = serve; },
    beforeManifest: (work?: () => Promise<void>) => { beforeManifest = work; } };
}

it('does not read the configured public directory before a successful verified first pin', async () => {
  const f = await fixture();
  expect(await f.resolveName()).toBeNull();
  expect(f.calls).toEqual([]);
  expect(f.rt.captureGate(ME).isActive()).toBe(false);
});

it.each([false, true])('first pin, explicit join, leave and rejoin work with configured key=%s and no session', async configuredPin => {
  const f = await fixture({ configuredPin });
  expect((await f.pin()).map(r => r.outcome)).toEqual(['pinned', 'pinned']);
  for (const origin of [ME, WORLD]) {
    expect(readParticipation(f.db, origin)).toMatchObject({ desired: 'enabled', phase: 'connected', session_id: '', ack_key_hex: '' });
    expect((await f.resolveName(origin))?.[0]?.nickname).toBe('Synthetic Nalan');
  }
  await f.rt.commands.loginHouse(ME);
  expect(readParticipation(f.db, ME)?.phase).toBe('connected');
  const old = f.rt.captureGate(ME);
  const left = await f.rt.commands.logoutHouse(ME);
  const leaveRow = readOutboxRow(f.db, left.operationId)!;
  expect(leaveRow.ack_key_hex).toBe('');
  expect(old.isActive()).toBe(false);
  expect(await f.resolveName()).toBeNull();
  expect((await f.pin())[0]?.outcome).toBe('already-decided');
  f.rt.resident.participationChanged();
  expect(readParticipation(f.db, ME)?.desired).toBe('disabled');
  expect((await f.resolveName(WORLD))?.[0]?.nickname).toBe('Synthetic Nalan');
  const rejoined = await f.rt.commands.loginHouse(ME);
  expect(rejoined).toMatchObject({ status: 'unsupported', sessionId: '', admission: 'configured' });
  expect(readParticipation(f.db, ME)).toMatchObject({ desired: 'enabled', phase: 'connected', session_id: '', ack_key_hex: '', inbox_read_token: '' });
  expect(readOutboxRow(f.db, left.operationId)).toEqual(leaveRow);
  expect(old.isActive()).toBe(false);
  expect((await f.resolveName())?.[0]?.nickname).toBe('Synthetic Nalan');
  const identity = await houseReadAuthority({ db: f.db, signer: f.signer }, ME)('inbox-stream');
  expect(identity.ok).toBe(true);
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
  expect(f.calls.filter(c => new URL(c.url).pathname === '/v1/resolve').every(c => !c.headers.has('x-popclaw-inbox-token'))).toBe(true);
});

it('does not read or activate after the operator pin changes', async () => {
  const f = await fixture({ configuredPin: true }); await f.pin();
  f.pins.set(ME, '11'.repeat(32));
  expect(await f.resolveName()).toBeNull();
  expect(f.rt.captureGate(ME).isActive()).toBe(false);
  expect((await f.resolveName(WORLD))?.[0]?.nickname).toBe('Synthetic Nalan');
  expect(pinnedBinding(f.db, ME)?.houseKey).toBe(f.houses.get(ME)!.houseKey);
});


it.each(['missing-proof', 'bad-signature', 'wrong-origin', 'wrong-key', 'incarnation'] as const)(
  'a %s manifest cannot open configured reads or overwrite trust', async kind => {
    const f = await fixture({ configuredPin: true });
    if (kind === 'incarnation') await f.pin();
    const original = f.houses.get(ME)!;
    if (kind === 'missing-proof') f.houses.set(ME, { ...original,
      fetch: async () => new Response(original.bodyBytes.slice().buffer as ArrayBuffer) });
    else {
      const bad = mintHouse({ origin: kind === 'wrong-origin' ? WORLD : ME,
      seed: kind === 'wrong-key' ? 98 : 90, incarnation: kind === 'incarnation' ? 'changed' : '1',
      manifest: { relations: { ordered: 1 }, read_auth: { schemes: ['popclaw-identity-read-v2'] } },
      ...(kind === 'bad-signature' ? { signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(99)).secretKey } : {}) });
      f.houses.set(ME, { ...bad, fetch: async () => bad.fetch(bad.origin + '/v1/manifest') });
    }
    if (kind !== 'incarnation') expect((await f.pin())[0]?.outcome).toBe('refused');
    const result = await f.rt.commands.loginHouse(ME);
    expect(result.admission).toBeUndefined();
    f.calls.length = 0;
    expect(await f.resolveName()).toBeNull(); expect(f.calls).toEqual([]);
    if (kind === 'incarnation') {
      const binding = pinnedBinding(f.db, ME)!;
      expect(binding.incarnation).toBe('1'); expect(binding.blockedReason).toBeTruthy();
    }
  });

it('a blocked pin stays blocked across explicit join and default pin retry', async () => {
  const f = await fixture(); await f.pin();
  f.houses.set(ME, mintHouse({ origin: ME, seed: 90, incarnation: 'replacement' }));
  await f.rt.commands.loginHouse(ME);
  f.houses.set(ME, mintHouse({ origin: ME, seed: 90 }));
  const before = pinnedBinding(f.db, ME)!;
  expect((await f.pin())[0]?.outcome).toBe('already-decided');
  expect((await f.rt.commands.loginHouse(ME)).admission).toBeUndefined();
  expect(pinnedBinding(f.db, ME)).toEqual(before);
  expect(await f.resolveName()).toBeNull();
});

it.each(['missing', 'unsupported'] as const)('private auth refuses a %s declared scheme while public reads remain separate', async kind => {
  const f = await fixture();
  f.houses.set(ME, mintHouse({ origin: ME, seed: 90,
    manifest: { relations: { ordered: 1 }, ...(kind === 'unsupported' ? { read_auth: { schemes: ['invented-scheme'] } } : {}) } }));
  await f.pin(); await f.rt.commands.loginHouse(ME);
  expect((await f.resolveName())?.[0]?.nickname).toBe('Synthetic Nalan');
  const identity = await houseReadAuthority({ db: f.db, signer: f.signer }, ME)('inbox-stream');
  expect(identity).toMatchObject({ ok: false, refusal: kind === 'missing' ? 'READ_AUTH_NOT_DECLARED' : 'READ_AUTH_SCHEME_UNSUPPORTED' });
  expect(f.calls.every(c => !c.headers.has('x-popclaw-inbox-token'))).toBe(true);
});

it('same-key signed withdrawal of identity read auth takes effect on the next explicit join', async () => {
  const f = await fixture(); await f.pin();
  const read = houseReadAuthority({ db: f.db, signer: f.signer }, ME);
  expect((await read('inbox-stream')).ok).toBe(true);
  f.houses.set(ME, mintHouse({ origin: ME, seed: 90, manifest: { relations: { ordered: 1 } } }));
  expect((await f.rt.commands.loginHouse(ME)).admission).toBe('configured');
  expect(await read('inbox-stream')).toMatchObject({ ok: false, refusal: 'READ_AUTH_NOT_DECLARED' });
});

function sessionHouse() {
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(90));
  const house = mintHouse({ origin: ME, seed: 90, manifest: { relations: { ordered: 1 },
    read_auth: { schemes: ['popclaw-identity-read-v2'] }, house_session: {
      version: 1, endpoint: '/v1/house-session', ack_pubkey: Buffer.from(key.publicKey).toString('hex'),
      operations: ['enter','renew','leave','status','action'], lease_seconds: 90, renew_interval_seconds: 30 } } });
  return { house, key };
}
function signedSessionReply(init: RequestInit, rejected = false) {
  const request = popclaw.housesession.HouseSessionRequest.decode(new Uint8Array(init.body as ArrayBuffer)).core!;
  const { key } = sessionHouse();
  const now = Math.floor(Date.now() / 1000);
  const core = { ...request, outcome: rejected ? 7 : 1, ...(rejected ? { errorCode: 4 } : {
    sessionId: 'synthetic-session', sessionActive: true, houseRevision: 1, leaseExpiresAt: now + 90,
    inboxReadToken: 'synthetic-session-token' }), serverCommittedAt: now };
  return new Response(popclaw.housesession.HouseSessionAck.encode({ core,
    signerPubkey: key.publicKey, signature: nacl.sign.detached(ackSigningInput(core), key.secretKey) }).finish() as unknown as BodyInit);
}
it.each(['selected-board', 'refused', 'network-pending', 'revoked-session'] as const)(
  'a %s session lane cannot switch to configured participation after the board disappears', async kind => {
    const f = await fixture(); f.houses.set(ME, sessionHouse().house); await f.pin();
    if (kind !== 'selected-board') {
      f.serveControl(async init => {
        if (kind === 'network-pending') throw new TypeError('synthetic control network failure');
        return signedSessionReply(init, kind === 'refused');
      });
      const admitted = await f.rt.commands.loginHouse(ME);
      if (kind === 'refused') expect(admitted.errorCode).toBe('EXECUTOR_BUSY');
      if (kind === 'revoked-session') {
        expect(admitted.status).toBe('connected');
        // A real local logout keeps the session's ACK/revision history.
        await f.rt.commands.logoutHouse(ME);
      }
    }
    f.houses.set(ME, mintHouse({ origin: ME, seed: 90,
      manifest: { relations: { ordered: 1 }, read_auth: { schemes: ['popclaw-identity-read-v2'] } } }));
    const result = await f.rt.commands.loginHouse(ME);
    expect(result.admission).toBeUndefined(); expect(result.legacyAvailable).not.toBe(true);
    expect(readParticipation(f.db, ME)?.phase).not.toBe('connected');
  });

it.each([false, true])('a manifest-only unknown enter with configured key=%s stays closed until normal explicit leave ends it', async configuredPin => {
  const f = await fixture({ configuredPin }); await f.pin();
  f.beforeManifest(async () => { throw new TypeError('synthetic manifest outage'); });
  expect((await f.rt.commands.loginHouse(ME)).status).toBe('connecting');
  const pending = readParticipation(f.db, ME)!.pending_enter_request_id;
  expect(pending).toBeTruthy();
  expect(readParticipation(f.db, ME)?.ack_key_hex).toBe('');
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
  f.beforeManifest();
  expect((await f.rt.commands.loginHouse(ME)).admission).toBeUndefined();
  expect(readParticipation(f.db, ME)?.pending_enter_request_id).toBe(pending);
  expect(await f.resolveName()).toBeNull();
  const left = await f.rt.commands.logoutHouse(ME);
  const retainedLeave = readOutboxRow(f.db, left.operationId);
  expect(retainedLeave?.ack_key_hex).toBe('');
  expect((await f.rt.commands.loginHouse(ME)).admission).toBe('configured');
  expect(readOutboxRow(f.db, left.operationId)).toEqual(retainedLeave);
  expect(f.calls.every(c => c.method === 'GET')).toBe(true);
});

it.each(['logout', 'config-removed', 'configured-key', 'pending-changed', 'owner-lost'] as const)(
  '%s during discovery prevents stale admission', async kind => {
    const f = await fixture({ configuredPin: true }); await f.pin(); await f.rt.commands.logoutHouse(ME);
    let enter!: () => void, resume!: () => void;
    const reached = new Promise<void>(r => { enter = r; });
    f.beforeManifest(async () => { enter(); await new Promise<void>(r => { resume = r; }); });
    const task = f.rt.commands.loginHouse(ME); await reached;
    if (kind === 'logout') await f.rt.commands.logoutHouse(ME);
    if (kind === 'config-removed') f.origins.splice(0, 1);
    if (kind === 'configured-key') f.pins.set(ME, '11'.repeat(32));
    if (kind === 'pending-changed') f.db.execute("UPDATE house_participation SET pending_enter_request_id='different-request' WHERE house_origin=?", [ME]);
    if (kind === 'owner-lost') f.db.execute("UPDATE house_lifecycle_owner SET generation=generation+1,holder='another-synthetic-owner'");
    resume(); const result = await task;
    expect(result.admission).toBeUndefined(); expect(readParticipation(f.db, ME)?.phase).not.toBe('connected');
    expect(await f.resolveName()).toBeNull();
  });

it('foreground native namecard and MCP share the configured public read gate and join command', async () => {
  const f = await fixture();
  const collector = makeToolCollector();
  const runtime = async () => ({ boot: { loreHouseUrl: ME, popclawId: '', nickname: '' }, houseRuntime: f.rt });
  const ctx = { api: collector.api, runtime, deps: { runtime, getWorldDeps: async () => ({
    resolveClient: new ResolveClient({ baseUrl: ME, fetch: f.rt.houseReadFetch(ME) }) }),
    getHouseCommandContext: async () => ({ coordinator: () => f.rt.commands }) } } as unknown as Parameters<typeof registerNamecardTool>[0];
  registerNamecardTool(ctx); registerHouseTools(ctx);
  const namecard = collector.tools.find(t => t.name === 'popclaw_show_namecard')!;
  expect(await namecard.execute('before-pin', { person: 'Synthetic Nalan' })).toMatchObject({ text: expect.stringContaining('HOUSE_TRUST_REVOKED') });
  expect(f.calls).toEqual([]);
  await f.pin();
  const direct = await namecard.execute('native-namecard', { person: 'Synthetic Nalan' });
  const mcp = await dispatchMcpCall(namecard, { person: 'Synthetic Nalan' }, { requestId: 'namecard' });
  expect(direct).toEqual(mcp); expect(direct).toMatchObject({ text: expect.stringContaining('Synthetic Nalan') });
  expect(f.calls.filter(c => new URL(c.url).pathname.startsWith('/v1/profile/'))).toHaveLength(2);
  expect(f.calls.filter(c => new URL(c.url).pathname.startsWith('/v1/profile/')).every(c => !c.headers.has('x-popclaw-inbox-token'))).toBe(true);
  await f.rt.commands.logoutHouse(ME);
  expect(await namecard.execute('disabled', { person: 'Synthetic Nalan' })).toMatchObject({ text: expect.stringContaining(ME) });
  const login = collector.tools.find(t => t.name === 'popclaw_house_login')!;
  const reply = await dispatchMcpCall(login, { host: ME }, { requestId: 'join' });
  expect(reply).toMatchObject({ text: expect.stringContaining(ME) });
  expect(readParticipation(f.db, ME)?.phase).toBe('connected');
  expect(await runHouseLoginCommand({ coordinator: () => f.rt.commands }, WORLD)).toContain(WORLD);
  expect(f.rt.egress.home.origin).toBe(ME);
});


it('a pending first pin never starts public lookup before its proof commits', async () => {
  const f = await fixture();
  let reached!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => { reached = r; }), hold = new Promise<void>(r => { resume = r; });
  f.beforeManifest(async () => { reached(); await hold; });
  const pinning = f.pin(); await entered;
  expect(await f.resolveName()).toBeNull();
  expect(f.calls.map(c => new URL(c.url).pathname)).toEqual(['/v1/manifest']);
  resume(); await pinning;
  expect((await f.resolveName())?.[0]?.nickname).toBe('Synthetic Nalan');
});

it.each(['loading', 'intent-write', 'trust-write'] as const)('a %s failure cannot activate a disabled configured House', async kind => {
  const f = await fixture(); await f.pin(); await f.rt.commands.logoutHouse(ME);
  if (kind === 'loading') {
    const original = f.db.queryOne.bind(f.db);
    const spy = vi.spyOn(f.db, 'queryOne').mockImplementation((sql, args) => {
      if (sql.includes('house_participation')) throw new Error('synthetic authority read failed');
      return original(sql, args);
    });
    f.calls.length = 0;
    expect(await f.resolveName()).toBeNull(); expect(f.calls).toEqual([]); spy.mockRestore();
  } else {
    let restore = () => {};
    f.beforeManifest(async () => {
      if (kind === 'intent-write') {
        const spy = vi.spyOn(f.db, 'transaction').mockImplementationOnce(() => { throw new Error('synthetic disk full'); });
        restore = () => { spy.mockRestore(); };
      }
      else {
        const execute = f.db.execute.bind(f.db);
        const spy = vi.spyOn(f.db, 'execute').mockImplementation((sql, args) => {
          if (sql.includes('INSERT INTO house_read_declaration')) throw new Error('synthetic trust write failed');
          return execute(sql, args);
        });
        restore = () => { spy.mockRestore(); };
      }
    });
    try {
      if (kind === 'intent-write') await expect(f.rt.commands.loginHouse(ME)).rejects.toThrow('synthetic disk full');
      else expect((await f.rt.commands.loginHouse(ME)).admission).toBeUndefined();
    } finally { restore(); }
  }
  expect(readParticipation(f.db, ME)?.phase).not.toBe('connected');
  expect(await f.resolveName()).toBeNull();
});

it('a public response captured before leave stays stale after a normal rejoin', async () => {
  const f = await fixture(); await f.pin();
  let reached!: () => void, resume!: (response: Response) => void;
  const entered = new Promise<void>(r => { reached = r; });
  const delayed = (async () => { reached(); return new Promise<Response>(r => { resume = r; }); }) as typeof fetch;
  // Capture the ordinary foreground gate in the production read method, then
  // park only its injected transport. No participation or pin writes are seeded.
  const originFetch = f.rt.houseReadFetch(ME);
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementationOnce(delayed);
  const old = f.rt.runCommand(() => originFetch(ME + '/v1/resolve?name=old'));
  await entered; f.transport.mockImplementation(original);
  await f.rt.commands.logoutHouse(ME); await f.rt.commands.loginHouse(ME);
  resume(Response.json({ candidates: [] }));
  await expect(old).rejects.toMatchObject({ code: 'HOUSE_ACTION_STALE' });
  expect((await f.resolveName())?.[0]?.nickname).toBe('Synthetic Nalan');
});

it('a signing callback captured before leave cannot return an identity credential after rejoin', async () => {
  const f = await fixture(); await f.pin();
  let reached!: () => void, resume!: () => void;
  const entered = new Promise<void>(r => { reached = r; }), hold = new Promise<void>(r => { resume = r; });
  const sign = f.signer.sign.bind(f.signer);
  vi.spyOn(f.signer, 'sign').mockImplementation(async bytes => { reached(); await hold; return sign(bytes); });
  const old = houseReadAuthority({ db: f.db, signer: f.signer }, ME)('inbox-stream');
  await entered; await f.rt.commands.logoutHouse(ME); await f.rt.commands.loginHouse(ME); resume();
  expect(await old).toMatchObject({ ok: false, refusal: 'READ_AUTH_HOUSE_NOT_TRUSTED' });
});

it('configuration removal stays closed across a fresh foreground runtime on the retained root', async () => {
  const f = await fixture(); await f.pin();
  const get = (rt: HouseRuntime, origin: string) => rt.runCommand(() =>
    rt.houseReadFetch(origin)(origin + '/v1/resolve?name=Synthetic%20Nalan'));
  expect((await get(f.rt, ME)).status).toBe(200);
  const before = f.calls.length;
  f.origins.splice(0, 1);
  await expect(get(f.rt, ME)).rejects.toMatchObject({ code: 'HOUSE_TRUST_REVOKED' });
  expect(f.calls).toHaveLength(before);
  await f.rt.stop();
  const restarted = new HouseRuntime({ db: f.db, signer: f.signer, origins: [...f.origins], fetch: f.transport,
    readAuthorityFor: origin => houseReadAuthority({ db: f.db, signer: f.signer }, origin) });
  cleanup.push(() => restarted.stop()); restarted.startReader();
  await expect(get(restarted, ME)).rejects.toMatchObject({ code: 'HOUSE_TRUST_REVOKED' });
  expect(f.calls).toHaveLength(before);
  expect((await get(restarted, WORLD)).status).toBe(200);
  expect(readParticipation(f.db, ME)).toMatchObject({ desired: 'enabled', phase: 'connected', ack_key_hex: '' });
  expect(pinnedBinding(f.db, ME)?.houseKey).toBe(f.houses.get(ME)!.houseKey);
});
