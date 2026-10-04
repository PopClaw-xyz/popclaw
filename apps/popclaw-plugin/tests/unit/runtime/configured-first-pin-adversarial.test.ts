/** Finite first-trust transaction, cancellation, and same-root IPC regressions.
 * All identities, transports and storage roots are synthetic. Two connections
 * share a real SQLite file; no replacement admission/schema is used. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { popclaw } from '@popclaw/contracts';
import { ackSigningInput } from '@popclaw/algorithms';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { publishStorageJson, registerStorageRuntime } from '../../../src/host/storage-maintenance.js';
import { HouseLifecycleManager } from '../../../src/runtime/house-lifecycle/manager.js';
import { HouseCommandBus } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { ResidentLifecycle } from '../../../src/runtime/house-lifecycle/resident.js';
import { readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { ActionInactiveError, assertActionActive, withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import { startFollowDoorbell } from '../../../src/newspaper/follow-doorbell-service.js';
import type { FollowIntentRow } from '../../../src/social-graph/pending-follow-store.js';
import { PendingFollowStore } from '../../../src/social-graph/pending-follow-store.js';
import { noDmCrypto } from '../../helpers/test-signer.js';
import type { ConfiguredFirstPinAttempt } from '../../../src/runtime/house-lifecycle/configured-first-pin.js';
import { pinConfiguredHouses, startDefaultHousePinning } from '../../../src/social-graph/default-house-pinning.js';
import { makeRelationBindingPreparer } from '../../../src/social-graph/relation-binding.js';
import { beginHouseAdd, commitEstablishAndActivate, prepareHouseTrust } from '../../../src/world/house-trust.js';
import { pinnedBinding } from '../../../src/world/house-binding-pin.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const ORIGIN = 'https://first-pin-races.invalid';
const OTHER = 'https://wrong-origin.invalid';
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(control = false, publicPolicy = false) {
  const root = mkdtempSync(join(tmpdir(), 'first-pin-races-'));
  const file = join(root, 'host.db');
  const db = new LocalHostDb(file); runMigrations(db, MIGRATIONS);
  const peer = new LocalHostDb(file);
  const paths = new PopclawPaths(root);
  const releaseA = registerStorageRuntime(db, paths), releaseB = registerStorageRuntime(peer, paths);
  const houseKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(83));
  const ackKey = Buffer.from(houseKeys.publicKey).toString('hex');
  const house = mintHouse({ origin: ORIGIN, seed: 83, ...(control ? { manifest: { house_session: {
    version: 1, endpoint: '/v1/house-session', ack_pubkey: ackKey,
    operations: ['enter', 'renew', 'leave', 'status', 'action'], lease_seconds: 90, renew_interval_seconds: 30,
  } } } : {}) });
  let configured = true, key = '', resolverFails = false;
  const identity = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
  const signer = { ...noDmCrypto, publicKey: async () => identity.publicKey,
    popclawId: async () => bs58.encode(identity.publicKey),
    sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, identity.secretKey) };
  const transport = (async (input: unknown, init?: RequestInit) => {
    if (!control || !String(input).endsWith('/v1/house-session')) return house.fetch(input);
    const req = popclaw.housesession.HouseSessionRequest.decode(new Uint8Array(init!.body as ArrayBuffer)).core!;
    const now = Math.floor(Date.now() / 1000), leave = req.operation === 3;
    const core = { houseOrigin: ORIGIN, popclawId: bs58.encode(identity.publicKey), installationId: 'first-pin-install',
      requestId: req.requestId, opSeq: req.opSeq, operation: req.operation, outcome: leave ? 4 : 1,
      sessionId: 'signed-session', sessionActive: !leave, houseRevision: 1,
      leaseExpiresAt: now + 90, serverCommittedAt: now, inboxReadToken: 'synthetic-token' };
    const bytes = popclaw.housesession.HouseSessionAck.encode({ core, signerPubkey: houseKeys.publicKey,
      signature: nacl.sign.detached(ackSigningInput(core), houseKeys.secretKey) }).finish();
    return new Response(bytes as unknown as BodyInit, { headers: { 'content-type': 'application/octet-stream' } });
  }) as typeof fetch;
  const makeManager = (db: LocalHostDb) => new HouseLifecycleManager({ db, installationId: 'first-pin-install', signer,
    fetch: transport, configuredPinningMode: publicPolicy ? 'public-v1' : 'static', legacyRecoveryConfigured: origin => configured && origin === ORIGIN,
    configuredPinFor: () => { if (resolverFails) throw new Error('config unavailable'); return key; },
    prepareRelationBinding: makeRelationBindingPreparer({ db }), onRelationBindingRefused: () => {} });
  const manager = makeManager(db), writer = makeManager(peer);
  manager.seedLegacyHouse(ORIGIN);
  const events: string[] = [];
  const observers = new Set<() => void>();
  const observed = (origin: string) => { if (origin === ORIGIN) for (const changed of observers) changed(); };
  const observe = (changed: () => void) => { observers.add(changed); return () => { observers.delete(changed); }; };
  const resident = new ResidentLifecycle({ manager, token: 'first-pin-owner', onParticipationObserved: observed,
    streams: { open: () => { events.push('open'); return { stop: () => { events.push('stop'); } }; } } });
  const sent = vi.fn(async () => ({ status: 200 }));
  const bus = new HouseCommandBus({ db, coordinator: resident.coordinator, authority: resident.authority, executePush: sent });
  const reader = new HouseCommandBus({ db: peer, coordinator: resident.coordinator,
    authority: { captureEpoch: () => null, isEpochCurrent: () => false }, timeoutMs: 1 });
  resident.configureOrigins([ORIGIN]); resident.start();
  cleanup.push(async () => {
    await resident.stop(); await bus.stop(); await reader.stop(); writer.stopHost(); await writer.waitForQuiet();
    releaseB(); releaseA(); peer.close(); db.close(); rmSync(root, { recursive: true, force: true });
  });
  const pin = (fetchImpl = house.fetch as typeof fetch, hint = () => resident.participationChanged(), target = manager) =>
    pinConfiguredHouses({ db: target.db, recipientPopclawId: 'owner', origins: [ORIGIN], fetch: fetchImpl,
      pinning: publicPolicy ? { mode: 'public-v1', proofPin: target.configuredPublicPin }
        : { mode: 'static', firstPin: target.configuredFirstPin }, onParticipationChanged: hint });
  const parked = (target = manager) => {
    const entered = deferred(), release = deferred();
    const pending = pin((async (input: unknown) => { entered.resolve(); await release.promise; return house.fetch(input); }) as typeof fetch,
      () => resident.participationChanged(), target);
    cleanup.push(() => release.resolve());
    return { pending, release, entered: Promise.race([entered.promise, pending.then(() => { throw new Error('refused before transport'); })]) };
  };
  return { root, paths, db, peer, house, manager, writer, resident, bus, reader, events, sent, pin, parked, signer, observe, observed,
    setConfig: (on: boolean) => { configured = on; }, setKey: (value: string) => { key = value; },
    failResolver: () => { resolverFails = true; } };
}
function expectNoCombinedCommit(f: ReturnType<typeof fixture>) {
  expect(pinnedBinding(f.db, ORIGIN)).toBeUndefined();
  expect(f.db.queryOne('SELECT origin FROM house_read_declaration WHERE origin=?', [ORIGIN])).toBeNull();
  expect(f.db.queryOne('SELECT house_key FROM relation_participation WHERE house_key=?', [f.house.houseKey])).toBeNull();
  expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(0);
}
async function prepared(f: ReturnType<typeof fixture>, origin = ORIGIN, db = f.db) {
  const house = origin === ORIGIN ? f.house : mintHouse({ origin, seed: 84 });
  const result = await prepareHouseTrust(db, origin, { attempt: beginHouseAdd(db, origin), fetch: house.fetch as typeof fetch });
  if (!result.ok) throw new Error(result.refusal);
  return result.prepared;
}

it.each(['delete', 'replace'] as const)('old in-flight action and queued sessionless push stay stale after pin %s', async change => {
  const f = fixture(); await f.pin();
  const old = f.resident.captureGate(ORIGIN), release = deferred(), delivered = vi.fn();
  const inflight = withAction(old, async () => { await release.promise; assertActionActive(); delivered(); });
  const rejection = expect(inflight).rejects.toBeInstanceOf(ActionInactiveError);
  const queued = await f.reader.push(ORIGIN, new Uint8Array([1, 2, 3]));
  expect(queued.state).toBe('pending');
  expect(f.db.queryOne('SELECT baseline_seq,session_id FROM house_lifecycle_commands WHERE request_id=?', [queued.operationId]))
    .toEqual({ baseline_seq: 1, session_id: '' });
  expect((await f.pin())[0]?.outcome).toBe('already-decided');
  if (change === 'delete') f.peer.execute('DELETE FROM house_binding_pin WHERE origin=?', [ORIGIN]);
  else f.peer.execute('UPDATE house_binding_pin SET revision=revision+1, house_key=? WHERE origin=?',
    [mintHouse({ origin: ORIGIN, seed: 85 }).houseKey, ORIGIN]);
  f.resident.participationChanged(); release.resolve(); await rejection;
  f.bus.start();
  expect(f.reader.getPushOperation(queued.operationId)?.result).toMatchObject({ status: 409, errorCode: 'STALE_OPERATION' });
  expect(old.isActive()).toBe(false); expect(delivered).not.toHaveBeenCalled(); expect(f.sent).not.toHaveBeenCalled();
  expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(1);
});

it('logout before proof refuses pin and preserves the durable disabled intent', async () => {
  const f = fixture(), attempt = f.parked(); await attempt.entered;
  await f.bus.logoutHouse(ORIGIN); attempt.release.resolve();
  expect((await attempt.pending)[0]?.outcome).toBe('refused');
  expect(pinnedBinding(f.db, ORIGIN)).toBeUndefined();
  expect(readParticipation(f.db, ORIGIN)).toMatchObject({ op_seq: 1, desired: 'disabled' });
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(false);
});
it.each([false, true])('old proof cannot revive after logout then legal command login (persist failure=%s)', async failed => {
  const f = fixture(true), attempt = f.parked(); await attempt.entered;
  if (failed) {
    const tx = vi.spyOn(f.db, 'transaction').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(f.bus.logoutHouse(ORIGIN)).rejects.toThrow('PERSISTENCE_FAILED'); tx.mockRestore();
  } else await f.bus.logoutHouse(ORIGIN);
  f.bus.start();
  expect((await f.bus.loginHouse(ORIGIN)).status).toBe('connected');
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(true);
  const row = readParticipation(f.db, ORIGIN), pin = pinnedBinding(f.db, ORIGIN);
  const relation = f.db.queryOne('SELECT * FROM relation_participation WHERE house_key=?', [f.house.houseKey]);
  attempt.release.resolve(); expect((await attempt.pending)[0]?.outcome).toBe('already-decided');
  expect(readParticipation(f.db, ORIGIN)).toEqual(row); expect(pinnedBinding(f.db, ORIGIN)).toEqual(pin);
  expect(f.db.queryOne('SELECT * FROM relation_participation WHERE house_key=?', [f.house.houseKey])).toEqual(relation);
  expect(row?.op_seq).toBe(failed ? 1 : 2);
});
it('logout after commit wins over a delayed participation hint', async () => {
  const f = fixture();
  expect((await f.pin(f.house.fetch as typeof fetch, () => {}))[0]?.outcome).toBe('pinned');
  await f.bus.logoutHouse(ORIGIN); f.resident.participationChanged();
  expect(readParticipation(f.db, ORIGIN)).toMatchObject({ op_seq: 2, desired: 'disabled' });
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(false);
});

it.each(['config removed', 'key changed', 'resolver unreadable', 'row changed', 'control history', 'loop stopped'] as const)('authority moving during proof refuses the combined transaction: %s', async change => {
  const f = fixture(); let current = true;
  const fetchImpl = (async (input: unknown) => {
    const response = await f.house.fetch(input);
    if (change === 'config removed') f.setConfig(false);
    if (change === 'key changed') f.setKey(Buffer.from(bs58.decode(f.house.houseKey)).toString('hex'));
    if (change === 'resolver unreadable') f.failResolver();
    if (change === 'row changed') f.peer.execute('UPDATE house_participation SET remote_error=? WHERE house_origin=?', ['changed', ORIGIN]);
    if (change === 'control history') f.peer.execute(`INSERT INTO house_lifecycle_outbox(request_id,house_origin,op,op_seq,ack_key_hex,installation_id,created_at,settled_at)
      VALUES('prior-leave',?,'leave',0,'','first-pin-install',0,1)`, [ORIGIN]);
    if (change === 'loop stopped') current = false;
    return response;
  }) as typeof fetch;
  const result = await pinConfiguredHouses({ db: f.db, recipientPopclawId: 'owner', origins: [ORIGIN], fetch: fetchImpl,
    current: () => current, pinning: { mode: 'static', firstPin: f.manager.configuredFirstPin } });
  expect(result[0]?.outcome).toBe('refused'); expectNoCombinedCommit(f);
});
it('invalid manifest proof has no pin, relation, declaration or lifecycle advance', async () => {
  const f = fixture(); const bad = mintHouse({ origin: ORIGIN, seed: 83,
    signWith: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(84)).secretKey });
  expect((await f.pin(bad.fetch as typeof fetch))[0]?.outcome).toBe('refused'); expectNoCombinedCommit(f);
});
it('stopping the actual retry loop during fetch cancels its captured first-pin attempt', async () => {
  const f = fixture(), entered = deferred(), release = deferred();
  const loop = startDefaultHousePinning({ db: f.db, recipientPopclawId: 'owner', origins: [ORIGIN], delaysMs: [],
    pinning: { mode: 'static', firstPin: f.manager.configuredFirstPin },
    fetch: (async (input: unknown) => { entered.resolve(); await release.promise; return f.house.fetch(input); }) as typeof fetch });
  await entered.promise; loop.stop(); release.resolve(); await loop.done; expectNoCombinedCommit(f);
});
it.each(['blocked', 'trusted'] as const)('an already decided %s pin is never retried or advanced', async kind => {
  const f = fixture(); expect((await f.pin())[0]?.outcome).toBe('pinned');
  if (kind === 'blocked') f.db.execute("UPDATE house_binding_pin SET blocked_reason='revoked',blocked_at=1,revision=revision+1 WHERE origin=?", [ORIGIN]);
  const before = pinnedBinding(f.db, ORIGIN), fetchImpl = vi.fn(f.house.fetch) as unknown as typeof fetch;
  expect((await f.pin(fetchImpl))[0]?.outcome).toBe('already-decided');
  expect(fetchImpl).not.toHaveBeenCalled(); expect(pinnedBinding(f.db, ORIGIN)).toEqual(before);
  expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(1);
});
it.each(['replaced', 'revoked'] as const)('a peer pin %s during fetch is preserved without a lifecycle advance', async kind => {
  const f = fixture(), attempt = f.parked(); await attempt.entered;
  const winner = mintHouse({ origin: ORIGIN, seed: 85 });
  f.peer.execute(`INSERT INTO house_binding_pin(origin,house_key,incarnation,source,first_trusted_at,confirmed_at,blocked_reason,blocked_at,revision)
    VALUES(?,?,'1','tofu',1,1,?,1,9)`, [ORIGIN, winner.houseKey, kind === 'revoked' ? 'revoked' : '']);
  const before = pinnedBinding(f.peer, ORIGIN); attempt.release.resolve();
  expect((await attempt.pending)[0]?.outcome).toBe('already-decided');
  expect(pinnedBinding(f.db, ORIGIN)).toEqual(before); expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(0);
  expect(f.db.queryOne('SELECT house_key FROM relation_participation WHERE house_key=?', [f.house.houseKey])).toBeNull();
});
it('nonconfigured origins and prior control intent refuse before network', async () => {
  const f = fixture(), fetchImpl = vi.fn(f.house.fetch) as unknown as typeof fetch;
  f.setConfig(false); expect((await f.pin(fetchImpl))[0]?.outcome).toBe('refused');
  f.setConfig(true); f.peer.execute('UPDATE house_participation SET op_seq=1 WHERE house_origin=?', [ORIGIN]);
  expect((await f.pin(fetchImpl))[0]?.outcome).toBe('refused'); expect(fetchImpl).not.toHaveBeenCalled();
  expect(pinnedBinding(f.db, ORIGIN)).toBeUndefined();
});

it('two same-root connections race one first pin with one lifecycle advance', async () => {
  const f = fixture(), a = f.parked(), b = f.parked(f.writer); await Promise.all([a.entered, b.entered]);
  a.release.resolve(); b.release.resolve();
  const results = await Promise.all([a.pending, b.pending]);
  expect(results.map(r => r[0]?.outcome).sort()).toEqual(['already-decided', 'pinned']);
  expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(1);
  expect(f.db.queryOne('SELECT active,owner_generation FROM relation_participation WHERE house_key=?', [f.house.houseKey]))
    .toEqual({ active: 1, owner_generation: 1 });
});
it('a nonresident writer can exit before notification and existing owner polling restores new work', async () => {
  vi.useFakeTimers(); const f = fixture(), old = f.resident.captureGate(ORIGIN);
  expect((await f.pin(f.house.fetch as typeof fetch, () => {}, f.writer))[0]?.outcome).toBe('pinned');
  f.writer.stopHost(); await f.writer.waitForQuiet();
  expect(old.isActive()).toBe(false); expect(f.events).toEqual([]);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(f.events).toEqual(['open']);
  expect(old.isActive()).toBe(false); expect(f.resident.captureGate(ORIGIN).isActive()).toBe(true);
});
it('ownership takeover restores committed first pin without notification and kills old owner captures', async () => {
  vi.useFakeTimers(); const f = fixture(), old = f.resident.captureGate(ORIGIN);
  expect((await f.pin(f.house.fetch as typeof fetch, () => {}, f.writer))[0]?.outcome).toBe('pinned');
  await f.resident.stop(); const opened = vi.fn(() => ({ stop: () => {} }));
  const next = new ResidentLifecycle({ manager: f.writer, token: 'next-owner', streams: { open: opened } });
  next.configureOrigins([ORIGIN]); cleanup.push(() => next.stop()); next.start();
  expect(old.isActive()).toBe(false); expect(next.captureGate(ORIGIN).isActive()).toBe(true);
  expect(opened).toHaveBeenCalledTimes(1); expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(1);
});

it.each(['pin', 'declaration', 'relation', 'lifecycle'] as const)('exception after the %s write rolls back ALL combined facts', async stage => {
  const f = fixture(), token = f.manager.configuredFirstPin.begin(f.db, ORIGIN)!;
  const proof = await prepared(f), execute = f.db.execute.bind(f.db);
  const marker = { pin: 'INSERT OR IGNORE INTO house_binding_pin', declaration: 'INSERT INTO house_read_declaration',
    relation: 'INSERT INTO relation_participation', lifecycle: 'UPDATE house_participation SET op_seq=op_seq+1' }[stage];
  let faulted = false;
  const spy = vi.spyOn(f.db, 'execute').mockImplementation((sql, args) => {
    const result = execute(sql, args);
    if (sql.includes(marker)) { faulted = true; throw new Error(`synthetic ${stage} write fault`); }
    return result;
  });
  expect(() => commitEstablishAndActivate(f.db, proof, { firstPin: token })).toThrow(`synthetic ${stage} write fault`);
  spy.mockRestore(); expect(faulted).toBe(true); expectNoCombinedCommit(f);
  expect(commitEstablishAndActivate(f.db, proof, { firstPin: token })).toMatchObject({ ok: false, refusal: 'HOUSE_FIRST_PIN_ATTEMPT_STALE' });
});
it('a failed lifecycle CAS returns refusal only after pin/relation/declaration rollback', async () => {
  const f = fixture(), token = f.manager.configuredFirstPin.begin(f.db, ORIGIN)!;
  const proof = await prepared(f), execute = f.db.execute.bind(f.db); let checked = false;
  const spy = vi.spyOn(f.db, 'execute').mockImplementation((sql, args) => {
    if (sql.includes('UPDATE house_participation SET op_seq=op_seq+1')) {
      checked = true; expect(pinnedBinding(f.db, ORIGIN)).toBeDefined();
      expect(f.db.queryOne('SELECT house_key FROM relation_participation WHERE house_key=?', [f.house.houseKey])).not.toBeNull();
      return { changes: 0, lastInsertRowid: 0 };
    }
    return execute(sql, args);
  });
  expect(commitEstablishAndActivate(f.db, proof, { firstPin: token })).toMatchObject({ ok: false, refusal: 'HOUSE_FIRST_PIN_LIFECYCLE_CAS_FAILED' });
  spy.mockRestore(); expect(checked).toBe(true); expectNoCombinedCommit(f);
});
it.each(['wrong DB', 'wrong origin', 'forged', 'reused'] as const)('one-use attempt rejects %s without a partial commit', async mismatch => {
  const f = fixture(), token = f.manager.configuredFirstPin.begin(f.db, ORIGIN)!;
  let target = f.db, origin = ORIGIN; let supplied: ConfiguredFirstPinAttempt = token;
  if (mismatch === 'wrong DB') target = f.peer;
  if (mismatch === 'wrong origin') origin = OTHER;
  if (mismatch === 'forged') supplied = Object.freeze({ mode: 'static' }) as ConfiguredFirstPinAttempt;
  if (mismatch === 'reused') {
    expect(commitEstablishAndActivate(f.db, await prepared(f), { firstPin: token }).ok).toBe(true);
    f.db.execute('DELETE FROM house_binding_pin WHERE origin=?', [ORIGIN]);
  }
  expect(commitEstablishAndActivate(target, await prepared(f, origin, target), { firstPin: supplied }))
    .toMatchObject({ ok: false, refusal: 'HOUSE_FIRST_PIN_ATTEMPT_STALE' });
  expect(pinnedBinding(f.db, origin)).toBeUndefined();
  expect(readParticipation(f.db, ORIGIN)?.op_seq).toBe(mismatch === 'reused' ? 1 : 0);
  if (mismatch !== 'reused') expectNoCombinedCommit(f);
  if (mismatch === 'wrong DB' || mismatch === 'wrong origin') {
    expect(commitEstablishAndActivate(f.db, await prepared(f), { firstPin: token }))
      .toMatchObject({ ok: false, refusal: 'HOUSE_FIRST_PIN_ATTEMPT_STALE' });
  }
});
it.each(['execution', 'consumers', 'unreadable'] as const)('storage becoming %s during fetch refuses the combined commit', async hold => {
  const f = fixture(), attempt = f.parked(); await attempt.entered;
  if (hold === 'unreadable') {
    f.peer.execute('CREATE TABLE storage_control_required_v1(id INTEGER)');
    mkdirSync(dirname(f.paths.storageControlFile()), { recursive: true });
    writeFileSync(f.paths.storageControlFile(), '{damaged');
  } else publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'synthetic', mode: 'recovery', reason: 'fixture', held: [hold], releases: {} });
  attempt.release.resolve(); expect((await attempt.pending)[0]?.outcome).toBe('refused'); expectNoCombinedCommit(f);
  // Restore the synthetic control before teardown's normal owner release.
  publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'synthetic', mode: 'normal', reason: 'fixture', held: [], releases: {} });
});

it('a failed logout cancellation epoch outlives a legal fence-clearing login with unchanged participation', async () => {
  const f = fixture(true, true);
  // Resident startup asynchronously drains/rearms control ownership. Settle
  // that actual startup before requesting a new command, without retrying it.
  await new Promise<void>(resolve => setImmediate(resolve)); f.bus.start();
  expect((await f.bus.loginHouse(ORIGIN)).status).toBe('connected');
  f.db.execute('DELETE FROM house_binding_pin WHERE origin=?', [ORIGIN]);
  const attempt = f.parked(); await attempt.entered;
  const before = readParticipation(f.db, ORIGIN);
  const relation = f.db.queryOne('SELECT * FROM relation_participation WHERE house_key=?', [f.house.houseKey]);
  const tx = vi.spyOn(f.db, 'transaction').mockImplementationOnce(() => { throw new Error('disk full'); });
  await expect(f.bus.logoutHouse(ORIGIN)).rejects.toThrow('PERSISTENCE_FAILED'); tx.mockRestore();
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(false);
  expect((await f.bus.loginHouse(ORIGIN)).status).toBe('connected');
  expect(readParticipation(f.db, ORIGIN)).toEqual(before);
  expect(f.resident.captureGate(ORIGIN).isActive()).toBe(true);
  attempt.release.resolve(); expect((await attempt.pending)[0]?.outcome).toBe('refused');
  expect(pinnedBinding(f.db, ORIGIN)).toBeUndefined(); expect(readParticipation(f.db, ORIGIN)).toEqual(before);
  expect(f.db.queryOne('SELECT * FROM relation_participation WHERE house_key=?', [f.house.houseKey])).toEqual(relation);
});


const FOLLOWEE = 'ELbgz8Lc4HHmZkSQRtRkVvNRy8UmVNbY4Ep2xP1nJ9vZ';
function click(): FollowIntentRow {
  return { owner_popclaw_id: 'owner', followee_popclaw_id: FOLLOWEE, followee_label: 'Synthetic',
    first_ts: Date.now() - 1_000, latest_ts: Date.now() - 1_000, click_count: 1 };
}
it('lost first-pin notification wakes a blocked doorbell through the EXISTING resident poll', async () => {
  vi.useFakeTimers(); const f = fixture(), old = f.resident.captureGate(ORIGIN);
  const cursors: number[] = [], enqueue = vi.fn(), store = new PendingFollowStore(f.db);
  const loop = startFollowDoorbell({ db: f.db, ownerPopclawId: 'owner', canvasBaseUrl: 'https://canvas.invalid',
    signer: f.signer, followsIn: () => false, notifier: { enqueue }, store,
    runCommand: work => work(), captureGate: origin => f.resident.captureGate(origin), houseOrigin: ORIGIN,
    observeParticipation: f.observe, pull: async (_owner, after) => { cursors.push(after); return [click()]; }
  }); cleanup.push(() => loop.stop());
  await loop.firstTick;
  expect(cursors).toEqual([]); expect(store.listPending()).toEqual([]);
  expect((await f.pin(f.house.fetch as typeof fetch, () => {}, f.writer))[0]?.outcome).toBe('pinned');
  f.writer.stopHost(); await f.writer.waitForQuiet();
  expect(old.isActive()).toBe(false);
  await vi.advanceTimersByTimeAsync(2_001);
  expect(cursors).toEqual([0]); expect(store.listPending()).toHaveLength(1); expect(enqueue).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_000); expect(cursors).toHaveLength(1);
  loop.stop(); await vi.advanceTimersByTimeAsync(2_000); expect(cursors).toHaveLength(1);
});
it('owner acquisition recovers a blocked startup doorbell after another writer committed without a hint', async () => {
  vi.useFakeTimers(); const f = fixture(), old = f.resident.captureGate(ORIGIN);
  expect((await f.pin(f.house.fetch as typeof fetch, () => {}, f.writer))[0]?.outcome).toBe('pinned');
  await f.resident.stop(); const next = new ResidentLifecycle({ manager: f.writer, token: 'new-doorbell-owner',
    streams: { open: () => ({ stop: () => {} }) }, onParticipationObserved: f.observed });
  next.configureOrigins([ORIGIN]); cleanup.push(() => next.stop());
  const pull = vi.fn(async () => [click()]), enqueue = vi.fn(), store = new PendingFollowStore(f.peer);
  const loop = startFollowDoorbell({ db: f.peer, ownerPopclawId: 'owner', canvasBaseUrl: 'https://canvas.invalid',
    signer: f.signer, followsIn: () => false, notifier: { enqueue }, store,
    runCommand: work => work(), captureGate: origin => next.captureGate(origin), houseOrigin: ORIGIN,
    observeParticipation: f.observe, pull }); cleanup.push(() => loop.stop());
  await loop.firstTick; expect(pull).not.toHaveBeenCalled();
  next.start(); await vi.advanceTimersByTimeAsync(0);
  expect(pull).toHaveBeenCalledTimes(1); expect(store.listPending()).toHaveLength(1); expect(enqueue).toHaveBeenCalledTimes(1);
  expect(old.isActive()).toBe(false); expect(next.captureGate(ORIGIN).isActive()).toBe(true);
});
