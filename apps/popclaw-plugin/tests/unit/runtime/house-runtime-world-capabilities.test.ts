import { runHouseLoginCommand } from '../../../src/commands/popclaw-house.js';
import type { HouseCommandPort } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { afterEach, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical, stripDefaultKeys, ackSigningInput } from '@popclaw/algorithms';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { readParticipation } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { readHouseCapabilityView } from '../../../src/world/world-capabilities.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';
import { readFileSync } from 'node:fs';

const origin = 'https://world.example';
const houseKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const ackKeyHex = Buffer.from(houseKey.publicKey).toString('hex');
const guide = '# A verified world guide\n';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** popclaw-world `feat/fast-instance` f818bd5 `protocol/manifest.json`, byte
 * for byte: 11,230 bytes, no `world_interaction` block, `event_kinds` rows
 * carrying their schema under the legacy member name and nesting to raw depth
 * nine. `with_session` splices a session block in front of the original bytes
 * and changes nothing else, so ENTER stays observable over the same rows. */
const fastInstance = Uint8Array.from(readFileSync(new URL('../../fixtures/world/fast-instance-manifest.json', import.meta.url)));
function realWorldBytes(session: boolean): Uint8Array<ArrayBuffer> {
  if (!session) return Uint8Array.from(fastInstance);
  const text = new TextDecoder().decode(fastInstance);
  const block = JSON.stringify({ version: 1, endpoint: '/v1/house-session', ack_pubkey: ackKeyHex,
    operations: ['enter', 'renew', 'leave', 'status'], lease_seconds: 90, renew_interval_seconds: 30 });
  return new TextEncoder().encode('{"house_session":' + block + ',' + text.slice(text.indexOf('{') + 1));
}
function manifest(options: { badProof?: boolean; legacy?: boolean; noSession?: boolean; log?: string; incarnation?: string; realWorld?: 'verbatim' | 'with_session' }) {
  const document = {
    intent_kinds: [{ kind: 'booking.reserve', schema_version: 1, transport: 'house', signer: 'user', description: 'Reserve', params_schema: { type: 'object' }, result_schema: { type: 'object' }, result_attachments: { allowed: [], required_on_success: [] }, consistency: 'none' }],
    world_interaction: { version: 1,
      public_stream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: options.log ?? 'log_1', envelope_baseline: 'public-envelope-01' as const, initial_public_scopes: [] },
      ...(!options.noSession ? { actions: { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: bs58.encode(houseKey.publicKey), kinds: ['booking.reserve'], attachments: [] },
        guide: { path: '/v1/guide.md', sha256: cidFromCanonical(new TextEncoder().encode(guide)), revision: '1' } } : {}),
    },
  };
  const { world_interaction: world, ...rest } = document;
  const raw = options.realWorld ? realWorldBytes(options.realWorld === 'with_session') : new TextEncoder().encode(JSON.stringify({
    ...rest,
    ...(!options.legacy ? { world_interaction: world } : {}),
    official_ids: [bs58.encode(houseKey.publicKey)],
    ...(!options.noSession ? { house_session: {
      version: 1, endpoint: '/v1/house-session', ack_pubkey: ackKeyHex,
      operations: ['enter', 'renew', 'leave', 'status'], lease_seconds: 90, renew_interval_seconds: 30,
    } } : {}),
  }));
  const core = {
    house: { origin, houseKey: bs58.encode(houseKey.publicKey), incarnation: options.incarnation ?? 'world_1' },
    manifestDigest: cidFromCanonical(raw), signedAt: 1780000000,
  };
  const coreBytes = popclaw.world.ManifestProof.encode(stripDefaultKeys(core)).finish();
  const prefix = new TextEncoder().encode('POPCLAW_WORLD_MANIFEST_PROOF_V1');
  const signingBytes = new Uint8Array(prefix.length + coreBytes.length);
  signingBytes.set(prefix); signingBytes.set(coreBytes, prefix.length);
  const authoritySignature = nacl.sign.detached(signingBytes, houseKey.secretKey);
  if (options.badProof) authoritySignature[0] = authoritySignature[0]! ^ 1;
  const proof = Buffer.from(popclaw.world.ManifestProof.encode({ ...core, authoritySignature }).finish()).toString('base64');
  return { raw, proof, revision: core.manifestDigest };
}

async function fixture(options: {
  connected?: boolean; badProof?: boolean; badGuide?: boolean; holdGuide?: boolean; legacy?: boolean; noSession?: boolean; configuredPin?: boolean;
  realWorld?: 'verbatim' | 'with_session';
} = {}) {
  const db = new InMemoryHostDb();
  cleanup.push(() => db.close());
  let board = manifest(options);
  let configuredPin: string | undefined = options.configuredPin ? ackKeyHex : undefined;
  const guideStarted = deferred<void>();
  const guideResponse = deferred<void>();
  const calls: string[] = [];
  const enterSnapshots: Array<{
    pin: string | undefined; revision: string | undefined; guide: string | undefined; kinds: number;
  }> = [];
  let guideSignal: AbortSignal | null | undefined;
  const transport: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    calls.push(path);
    if (path === '/v1/manifest') {
      return new Response(board.raw, { headers: { 'X-Popclaw-Manifest-Proof': board.proof } });
    }
    if (path === '/v1/guide.md') {
      guideSignal = init?.signal;
      guideStarted.resolve();
      if (options.holdGuide) await guideResponse.promise;
      // Deliberately return even after cancellation to exercise the real
      // preparer's post-await fence against a transport that ignores abort.
      return new Response(options.badGuide ? '# Wrong guide\n' : guide);
    }
    if (path === '/v1/house-session') {
      const request = popclaw.housesession.HouseSessionRequest.decode(new Uint8Array(init?.body as Uint8Array));
      if (request.core?.operation === 1) {
        const capability = readHouseCapabilityView(db, origin);
        enterSnapshots.push({
          pin: readParticipation(db, origin)?.ack_key_hex,
          revision: capability?.verified.capabilityRevision, guide: capability?.guide.validation === 'valid' ? guide : undefined,
          kinds: capability ? db.queryAll('SELECT * FROM world_kind_revisions WHERE origin=?', [origin]).length : 0,
        });
      }
      if (options.connected) {
        const core = {...request.core, outcome: 1, houseRevision: 1, sessionId: 'verified_session', sessionActive: true,
          leaseExpiresAt: Math.floor(Date.now() / 1000) + 3600, inboxReadToken: 'read_token', serverCommittedAt: Math.floor(Date.now() / 1000)};
        const signature = nacl.sign.detached(ackSigningInput(core), houseKey.secretKey);
        return new Response(new Uint8Array(popclaw.housesession.HouseSessionAck.encode({core, signature, signerPubkey: houseKey.publicKey}).finish()).buffer);
      }
      // The test boundary is preparation-before-ENTER, so no forged ACK or
      // connected stream resources are needed to observe the signed request.
      return new Response('', { status: 503 });
    }
    throw new Error(`Unexpected transport path: ${path}`);
  };
  const seed = new Uint8Array(32).fill(23);
  const keys = nacl.sign.keyPair.fromSeed(seed);
  const signer = new MasterKeySigner({ seed, ...keys, popclawId: bs58.encode(keys.publicKey) });
  const runtime = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer, origins: [origin], fetch: transport,
    configuredPinFor: () => configuredPin,
    retryBackoffMs: 60_000, intentPollMs: 60_000 });
  cleanup.push(async () => { guideResponse.resolve(); await runtime.stop(); });
  // Acquire the actual durable owner through the public resident seam. Empty
  // startup origins prevent legacy migration/streams from replacing login.
  runtime.resident.configureOrigins([]);
  runtime.resident.start();
  await runtime.manager.resumeAfterOwnership();
  expect(runtime.resident.authority.captureEpoch()).not.toBeNull();
  expect(readParticipation(db, origin)).toBeNull();
  return { db, runtime, signer, board, calls, enterSnapshots, guideStarted, guideResponse,
    setManifest: (next: Parameters<typeof manifest>[0]) => { board = manifest(next); },
    setPin: (pin: string) => { configuredPin = pin; },
    guideSignal: () => guideSignal };
}

it('default HouseRuntime verifies and commits real world capabilities before sending ENTER', async () => {
  const s = await fixture();
  await s.runtime.manager.loginHouse(origin);
  expect(s.enterSnapshots).toEqual([{ pin: ackKeyHex, revision: s.board.revision, guide, kinds: 1 }]);
  expect(s.calls).toEqual(['/v1/manifest', '/v1/guide.md', '/v1/house-session']);
  expect(readHouseCapabilityView(s.db, origin)?.verified.house).toEqual({
    origin, houseKey: bs58.encode(houseKey.publicKey), incarnation: 'world_1',
  });
});

it('default HouseRuntime rejects bad base proof before ENTER', async () => {
  const s = await fixture({ badProof: true });
  expect(await s.runtime.manager.loginHouse(origin)).toMatchObject({ errorCode: 'AUTH_INVALID' });
  expect(s.enterSnapshots).toEqual([]); expect(readHouseCapabilityView(s.db, origin)).toBeNull();
  expect(readParticipation(s.db, origin)?.ack_key_hex).toBe(ackKeyHex);
  expect(s.runtime.captureGate(origin).isActive()).toBe(false);
  expect(s.calls).toEqual(['/v1/manifest']);
});
it('bad optional guide leaves public facts and ordinary session ENTER available', async () => {
  const s = await fixture({ badGuide: true });
  expect(await s.runtime.manager.loginHouse(origin)).not.toHaveProperty('errorCode', 'AUTH_INVALID');
  expect(s.enterSnapshots).toHaveLength(1);
  expect(readHouseCapabilityView(s.db, origin)).toMatchObject({ publicStream: { validation: 'valid' }, guide: { validation: 'invalid' }, actions: { validation: 'invalid' } });
});
it('a pinned public-only House commits its observation without ENTER or an execution gate', async () => {
  const s = await fixture({ noSession: true, configuredPin: true });
  expect(await s.runtime.manager.loginHouse(origin)).toMatchObject({ status: 'unsupported', errorCode: 'HOUSE_LIFECYCLE_UNSUPPORTED' });
  expect(s.calls).toEqual(['/v1/manifest']); expect(s.enterSnapshots).toEqual([]);
  expect(readHouseCapabilityView(s.db, origin)).toMatchObject({ publicStream: { validation: 'valid', support: 'unsupported', ready: false } });
  expect(s.runtime.captureGate(origin).isActive()).toBe(false);
  expect(readParticipation(s.db, origin)?.session_id).toBe('');
});
it('keeps the ordinary path for a trusted pin, no session and the real world manifest', async () => {
  // Condition X: an origin whose pin is already trusted, answering with a
  // manifest that selects nothing. Nothing here is the client's to interpret,
  // so nothing here may be reported as a credential failure.
  const s = await fixture({ realWorld: 'verbatim', noSession: true, configuredPin: true });
  const result = await s.runtime.manager.loginHouse(origin);
  expect(result).toMatchObject({ status: 'unsupported', errorCode: 'HOUSE_LIFECYCLE_UNSUPPORTED' });
  expect(s.calls).toEqual(['/v1/manifest']);
  expect(readParticipation(s.db, origin)?.ack_key_hex).toBe(ackKeyHex);
});
it('lets a carried deep declaration disable the world view alone: the house stays in, the gate stays open, the pin is untouched', async () => {
  const s = await fixture({ connected: true });
  expect(await s.runtime.manager.loginHouse(origin)).toMatchObject({ status: 'connected' });
  expect(s.runtime.captureGate(origin).isActive()).toBe(true);
  expect(readHouseCapabilityView(s.db, origin)).not.toBeNull();
  // Every trust row this login could touch, before and after.
  const trust = () => ({ participation: readParticipation(s.db, origin),
    binding: s.db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='house_binding_pin'")
      ? s.db.queryAll('SELECT * FROM house_binding_pin') : [] });
  const trustBefore = trust();

  s.setManifest({ realWorld: 'with_session' });
  const result = await s.runtime.manager.loginHouse(origin);
  expect(result).toMatchObject({ status: 'connected' });
  expect(result).not.toHaveProperty('errorCode');
  expect(s.runtime.captureGate(origin).isActive()).toBe(true);
  expect(trust()).toEqual(trustBefore);
  expect(readHouseCapabilityView(s.db, origin)).toBeNull();
  expect(s.db.queryOne('SELECT active,detail FROM world_capability_current_v1 WHERE origin=?', [origin]))
    .toEqual({ active: 0, detail: 'WORLD_UNSUPPORTED' });
});
it('an unpinned public-only House cannot bootstrap its authority from the proof', async () => {
  const s = await fixture({ noSession: true });
  expect(await s.runtime.manager.loginHouse(origin)).toMatchObject({ status: 'unsupported' });
  expect(readHouseCapabilityView(s.db, origin)).toBeNull();
  expect(readParticipation(s.db, origin)?.ack_key_hex).toBe('');
  expect(s.calls).toEqual(['/v1/manifest']);
});

it('logout during the default guide fetch prevents capability commit and ENTER', async () => {
  const s = await fixture({ holdGuide: true });
  const login = s.runtime.manager.loginHouse(origin);
  const first = await Promise.race([
    s.guideStarted.promise.then(() => 'guide'), login.then(() => 'login-completed'),
  ]);
  expect(first).toBe('guide');
  expect(readHouseCapabilityView(s.db, origin)).toBeNull();
  await s.runtime.manager.logoutHouse(origin);
  expect(s.guideSignal()?.aborted).toBe(true);
  s.guideResponse.resolve();
  await login;
  expect(s.enterSnapshots).toEqual([]);
  expect(readHouseCapabilityView(s.db, origin)).toBeNull();
  expect(readParticipation(s.db, origin)?.desired).toBe('disabled');
  expect(s.runtime.captureGate(origin).isActive()).toBe(false);
});

it('a house_session board without world capabilities keeps its lifecycle ENTER and fetches no guide', async () => {
  const s = await fixture({ legacy: true });
  const result = await s.runtime.manager.loginHouse(origin);
  expect(result.status).toBe('connecting');
  expect(s.enterSnapshots).toEqual([{ pin: ackKeyHex, revision: undefined, guide: undefined, kinds: 0 }]);
  expect(s.calls).toEqual(['/v1/manifest', '/v1/house-session']);
  expect(readHouseCapabilityView(s.db, origin)).toBeNull();
});

it('a legacy board without house_session remains unsupported and fetches no guide', async () => {
  const s = await fixture({ legacy: true, noSession: true });
  expect(await s.runtime.manager.loginHouse(origin)).toMatchObject({
    status: 'unsupported', errorCode: 'HOUSE_LIFECYCLE_UNSUPPORTED',
  });
  expect(s.calls).toEqual(['/v1/manifest']);
  expect(s.enterSnapshots).toEqual([]);
  expect(readHouseCapabilityView(s.db, origin)).toBeNull();
});

it('a bad later base proof revokes the current selection while preserving verified observation history', async () => {
  const s = await fixture(); await s.runtime.manager.loginHouse(origin);
  const original = s.db.queryOne<any>('SELECT * FROM world_capability_views_v1');
  expect(readHouseCapabilityView(s.db, origin)).not.toBeNull();
  s.setManifest({ badProof: true });
  expect(await s.runtime.manager.loginHouse(origin)).toMatchObject({ errorCode: 'AUTH_INVALID' });
  expect(readHouseCapabilityView(s.db, origin)).toBeNull();
  expect(s.db.queryOne<any>('SELECT * FROM world_capability_views_v1')).toEqual(original);
  expect(s.enterSnapshots).toHaveLength(1);
});
it.each(['pin', 'owner'] as const)('rechecks %s after guide preparation before selecting any capability or sending ENTER', async change => {
  const s = await fixture({ holdGuide: true, configuredPin: true });
  const login = s.runtime.manager.loginHouse(origin); await s.guideStarted.promise;
  if (change === 'pin') s.setPin('ff'.repeat(32));
  else s.db.execute("UPDATE house_lifecycle_owner SET generation=generation+1,holder='replacement-owner'");
  s.guideResponse.resolve(); await login;
  expect(readHouseCapabilityView(s.db, origin)).toBeNull(); expect(s.enterSnapshots).toEqual([]);
  expect(s.runtime.captureGate(origin).isActive()).toBe(false);
});


it('login exposes its server-verified guide and schemas from the same cache, with no second fetch', async () => {
  const s = await fixture({connected: true, configuredPin: true});
  const actorId = await s.signer.popclawId();
  const result = await runHouseLoginCommand({coordinator: () => s.runtime.manager as unknown as HouseCommandPort,
    readAgentContext: (house, session) => s.runtime.readAgentContext(house, actorId, {}, session)}, origin);
  const material = JSON.parse(result.split('\n').at(-1)!).agent_context;
  expect(material).toMatchObject({status: 'available', session_id: 'verified_session', capability_revision: s.board.revision,
    guide: {text: guide}, actions: [{kind: 'booking.reserve', params_schema: {type: 'object'}, result_schema: {type: 'object'}}]});
  expect(s.calls).toEqual(['/v1/manifest', '/v1/guide.md', '/v1/house-session']);
  expect(s.runtime.readAgentContext(origin, actorId, {kind: 'booking.reserve', expected_capability_revision: s.board.revision,
    expected_session_id: 'verified_session'})).toMatchObject({status: 'available'});
  expect(s.calls).toHaveLength(3);
  expect(s.runtime.readAgentContext(origin, actorId, {}, 'another_session')).toEqual({status: 'unavailable', code: 'HOUSE_SESSION_CHANGED'});
  s.setPin('ff'.repeat(32));
  expect(s.runtime.readAgentContext(origin, actorId)).toMatchObject({status: 'unavailable'});
});

it('explicit repeated login refreshes the verified public log without rotating its session', async () => {
  const s = await fixture({ connected: true });
  await s.runtime.manager.loginHouse(origin);
  const before = readParticipation(s.db, origin)!;
  s.setManifest({ log: 'fresh_log_2' });
  const result = await s.runtime.manager.loginHouse(origin);
  expect(result.status).toBe('connected');
  expect(readHouseCapabilityView(s.db, origin)?.publicStreamCapability?.publicStream.log_incarnation).toBe('fresh_log_2');
  expect(readParticipation(s.db, origin)).toMatchObject({ session_id: before.session_id, op_seq: before.op_seq,
    house_revision: before.house_revision, ack_key_hex: before.ack_key_hex, inbox_read_token: before.inbox_read_token });
  expect(s.enterSnapshots).toHaveLength(1);
});
it('a server incarnation change on explicit refresh pauses execution without changing its pin', async () => {
  const s = await fixture({ connected: true });
  await s.runtime.manager.loginHouse(origin);
  const before = readParticipation(s.db, origin)!;
  s.setManifest({ log: 'fresh_log_2', incarnation: 'different_server' });
  const result = await s.runtime.manager.loginHouse(origin);
  expect(result.errorCode).toBe('AUTH_INVALID');
  expect(readHouseCapabilityView(s.db, origin)).toBeNull();
  expect(s.runtime.manager.gateFor(origin).isActive()).toBe(false);
  expect(readParticipation(s.db, origin)).toMatchObject({ session_id: before.session_id, op_seq: before.op_seq, ack_key_hex: before.ack_key_hex });
  expect(s.enterSnapshots).toHaveLength(1);
});
