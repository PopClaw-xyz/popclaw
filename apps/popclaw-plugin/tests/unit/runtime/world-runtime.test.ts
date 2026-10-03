import { signEnvelope } from '../../../src/identity/sign-envelope.js';
import { PopclawPaths } from '../../../src/host/popclaw-paths.js';
import { ExecutionStoreCatalog } from '../../../src/host/execution-store.js';
import { initializeActionReceiptJournal, initializeNativeActionJournal } from '../../../src/host/execution-store-migration.js';
import { createOpenClawWorldExecution } from '../../../src/host/openclaw-world-execution.js';
import { HouseCommandBus } from '../../../src/runtime/house-lifecycle/command-bus.js';
import type { HouseCommandPort } from '../../../src/runtime/house-lifecycle/command-bus.js';
import type { HousePushEffectResolver } from '../../../src/runtime/house-lifecycle/push-effect.js';
import { MaintenanceSession, publishStorageJson } from '../../../src/host/storage-maintenance.js';
import { ensureHouseLifecycleSchema } from '../../../src/runtime/house-lifecycle/participation-store.js';
import { makeWorldManifestPreparer, readHouseCapabilityView } from '../../../src/world/world-capabilities.js';
import { runWorldCapabilitiesCommand, runWorldInvokeCommand, runWorldActionStatusCommand, type WorldCommandContext } from '../../../src/commands/popclaw-world.js';
import { decodeActionReceiptState } from '../../../src/world/action-receipt-journal.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { WorldRuntime, ownerConfirmedWorldInvoke, worldDeclaredActionParameters } from '../../../src/runtime/world-runtime.js';
import { makeToolCollector } from '../../../src/tools/mcp-adapter.js';
import { registerPopclawTools } from '../../../src/tools/register-tools.js';
import { createMcpOwnerApproval } from '../../../src/host/mcp-owner-approval.js';
import { createMcpOwnerAuthorization } from '../../../src/host/mcp-owner-authorization.js';
import { resetOwnerApprovals } from '../../../src/host/owner-approval.js';
import { WORLD_INVOKE_TOOL } from '../../../src/world/world-approval-subject.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalWorldCore, worldSigningInput } from '../../../src/world/action-wire.js';
import type { HouseCapabilityView, TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';
import type { HouseResourceOptions } from '../../../src/runtime/house-lifecycle/resource-set.js';
import { firstReleaseView } from '../../fixtures/world/first-release-view.js';
import { actionRequestDigest } from '../../../src/world/action-request-digest.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

/** Optional synthetic artifacts from the real tested handle, never runtime configuration. */
async function exportReceiptEvidence(db: LocalHostDb, label: string, response: Uint8Array): Promise<void> {
  const directory = process.env.POPCLAW_C_ROOT_EVIDENCE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  await db.snapshotTo(join(directory, `${label}.sqlite`));
  const request = db.queryOne<{request_bytes: Uint8Array; original_context: Uint8Array}>('SELECT request_bytes,original_context FROM world_action_client_requests');
  if (request) {
    writeFileSync(join(directory, `${label}.request.bin`), request.request_bytes);
    writeFileSync(join(directory, `${label}.context.json`), request.original_context);
  }
  writeFileSync(join(directory, `${label}.status.bin`), response);
}

const origin = 'https://world-runtime.invalid';
const seed = new Uint8Array(32).fill(67), pair = nacl.sign.keyPair.fromSeed(seed), actorId = bs58.encode(pair.publicKey);
const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of resources.splice(0)) await cleanup(); });
function fixture(selected: boolean | 'commands' = true) {
  const root = mkdtempSync(join(tmpdir(), 'g0-world-runtime-')), db = new LocalHostDb(join(root, 'host.db')), houseDb = new LocalHostDb(join(root, 'house.db'));
  const signer = new MasterKeySigner({ seed, ...pair, popclawId: actorId });
  const cache = new WorldFeedCache({ db: houseDb });
  const house = { baseUrl: origin, slug: 'world-runtime-invalid', db: houseDb, executionDb: houseDb, dbPath: join(root, 'house.db'), cache };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('UNEXPECTED_NETWORK'); });
  const houses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer, origins: [origin], fetch });
  houses.configureResources({ stores: [house], openStore: async () => house, worldStreamMode: true,
    host: {} as HouseResourceOptions['host'], recipientPopclawId: actorId, isOfficialActor: () => true });
  let caps: HouseCapabilityView | null = firstReleaseView(origin, actorId);
  const onPlain = vi.fn(async () => {}), onConversation = vi.fn(async () => {});
  const worlds = new WorldRuntime({ houses, signer, actorId, readCapabilities: () => caps,
    ...(selected === 'commands' ? { mode: 'commands' as const } : { selectScopedLane: () => selected, onPlain, onConversation }), fetch });
  const abort = new AbortController(), gate = { origin, generation: 1, signal: abort.signal, isActive: () => !abort.signal.aborted };
  const input = { house, gate, onContent: vi.fn(), isOfficialActor: () => true, onError: vi.fn() };
  resources.push(async () => { worlds.stop(); await houses.stop(); await worlds.whenIdle(); houseDb.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  return { worlds, houses, db, houseDb, signer, caps, setCaps: (value: HouseCapabilityView | null) => { caps = value; }, house, input, gate, abort, fetch };
}

it('does not create old-C consumers or action storage from a validated new observation', async () => {
  const f = fixture();
  expect(f.worlds.createPublicReceiver(f.input)).toBeUndefined();
  expect(f.worlds.createInboxConsumer(f.input)).toBeUndefined();
  await expect(f.worlds.client(origin).invoke({ house: origin, kind: 'example.reply', params: {}, expected_capability_revision: 'a'.repeat(64) }, {} as any)).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  expect(f.houseDb.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_action_client_requests'")).toBeNull();
  expect(f.fetch).not.toHaveBeenCalled();
});

it('does not create a scoped resource when the root has not selected that lane', async () => {
  const f = fixture(false);
  expect(f.worlds.createPublicReceiver(f.input)).toBeUndefined();
  expect(f.worlds.createInboxConsumer(f.input)).toBeUndefined();
  expect(f.worlds.readCapabilities(origin)?.verified.capabilityRevision).toBe('a'.repeat(64));
  expect(f.fetch).not.toHaveBeenCalled();
});

it('rejects a store or capability for another house without opening an extra stream', () => {
  const f = fixture();
  expect(() => f.worlds.createPublicReceiver({ ...f.input, house: { ...f.house, baseUrl: 'https://foreign.invalid' } })).toThrow('HOUSE_STORE_BINDING_MISMATCH');
  f.setCaps({ ...f.caps!, verified: { ...f.caps!.verified, house: { ...f.caps!.verified.house, origin: 'https://foreign.invalid' } } });
  expect(() => f.worlds.createPublicReceiver(f.input)).toThrow('CAPABILITY_HOUSE_MISMATCH');
  expect(f.fetch).not.toHaveBeenCalled();
});

it('unknown request status rejects locally even without active capabilities and after stop cannot read a closed DB', async () => {
  const f = fixture(false); f.setCaps(null);
  const client = f.worlds.client(origin);
  await expect(client.status('a'.repeat(64))).rejects.toThrow('REQUEST_NOT_KNOWN');
  expect(f.fetch).not.toHaveBeenCalled();
  f.worlds.stop();
  expect(() => f.worlds.readCapabilities(origin)).toThrow('WORLD_RUNTIME_STOPPED');
  await expect(client.status('a'.repeat(64))).rejects.toThrow('WORLD_RUNTIME_STOPPED');
});

/** The storage layer's own reason, not a projection-side constant, has to
 * reach a not-ready kind. Uses the real receipt-lane fixture (real manifest,
 * real guide) because `selectActionEvidence` needs genuine bytes to mark a
 * kind "supported" in the first place. */
it('carries the storage layer reason into a not-ready action kind in the receipt lane', async () => {
  const f = await receiptRuntimeFixture(false);
  const baseline = f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate'];
  expect(baseline).toMatchObject({ support: 'supported', ready: true, detail: '' });
  const availability = vi.spyOn(f.houses, 'actionExecutionAvailability').mockReturnValue({ ready: false, reason: 'ACTION_RECEIPT_PROTECTION_INCOMPLETE' });
  expect(f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate'])
    .toEqual({ ...baseline, detail: 'ACTION_RECEIPT_PROTECTION_INCOMPLETE', ready: false });
  expect(availability).toHaveBeenLastCalledWith(origin, actorId, 'receipt');
});

it('carries the storage layer reason into a not-ready action kind in the native lane', async () => {
  const f = await receiptRuntimeFixture(true);
  const baseline = f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate'];
  expect(baseline).toMatchObject({ support: 'supported', ready: true, detail: '' });
  const availability = vi.spyOn(f.houses, 'actionExecutionAvailability').mockReturnValue({ ready: false, reason: 'ACTION_NATIVE_POLICY_MISSING' });
  expect(f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate'])
    .toEqual({ ...baseline, detail: 'ACTION_NATIVE_POLICY_MISSING', ready: false });
  expect(availability).toHaveBeenLastCalledWith(origin, actorId, 'native');
});

/** Readiness used to be composed from execution storage alone, so a host with
 * no native authorization at all still advertised the kind as ready. A person
 * read that, clicked, confirmed, and only then learned nothing authorized it. */
it('reports a native action kind not ready when nothing authorizes it, and says why', async () => {
  const f = await receiptRuntimeFixture(true);
  expect(f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate'])
    .toMatchObject({ support: 'supported', ready: true, detail: '' });
  f.dropPolicies();
  const refused = f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate']!;
  expect(refused.support).toBe('supported');
  expect(refused.ready).toBe(false);
  expect(refused.detail).toContain('NATIVE_POLICY_REQUIRED');
  expect(refused.detail).toContain('No usable owner authorization is in place');
  await expect(f.invoke()).rejects.toThrow('NATIVE_POLICY_REQUIRED');
});

it('separates two conflicting native policies from no policy in the capability view', async () => {
  const f = await receiptRuntimeFixture(true);
  f.duplicatePolicy();
  const refused = f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate']!;
  expect(refused.ready).toBe(false);
  expect(refused.detail).toContain('NATIVE_POLICY_AMBIGUOUS');
  expect(refused.detail).not.toContain('NATIVE_POLICY_REQUIRED');
});

/** A root whose host can ask the owner per call has an answer available for a
 *  kind no policy covers, so the policy probe must not veto it — the same rule
 *  the MCP root has always had. It does not widen what EXECUTES: the call still
 *  arrives with a real answer or a real policy, or is refused by name. */
it('stops the native policy probe vetoing readiness once a host can ask the owner', async () => {
  const f = await receiptRuntimeFixture('native+owner');
  f.dropPolicies();
  expect(f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate'])
    .toMatchObject({ support: 'supported', ready: true, detail: '' });
  // …and a host that cannot ask after all falls straight back to the probe.
  f.closeOwnerForm();
  const refused = f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate']!;
  expect(refused.ready).toBe(false);
  expect(refused.detail).toContain('NATIVE_POLICY_REQUIRED');
});

it('leaves the receipt lane readiness alone, since it has no native authorization to read', async () => {
  const f = await receiptRuntimeFixture(false);
  expect(f.worlds.readCapabilities(origin)!.actions.kinds['reading.annotate'])
    .toMatchObject({ support: 'supported', ready: true, detail: '' });
});

it('command-only composition needs no ingress callbacks and cannot create a receiver', async () => {
  const f = fixture('commands');
  expect(f.worlds.createPublicReceiver(f.input)).toBeUndefined();
  expect(f.worlds.createInboxConsumer(f.input)).toBeUndefined();
  expect(f.worlds.readCapabilities(origin)?.verified.capabilityRevision).toBe('a'.repeat(64));
  await expect(f.worlds.client(origin).status('a'.repeat(64))).rejects.toThrow('REQUEST_NOT_KNOWN');
  expect(f.houseDb.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_private_messages'")).toBeNull();
  expect(f.fetch).not.toHaveBeenCalled();
});

it('preserves signed legacy history as unsupported without inferring new receipt or accounting state', async () => {
  const f = await receiptRuntimeFixture(), now = Math.floor(Date.now() / 1000);
  const saved: TrustedWorldCapabilities = { house: { origin, houseKey: actorId, incarnation: 'historical_house' },
    capabilityRevision: 'd'.repeat(64), guide: 'Historical guide', manifest: {
      world_interaction: { result_authority_pubkey: actorId }, intent_kinds: [{ kind: 'booking.reserve', schema_version: 1,
        params_schema: { type: 'object' }, result_schema: { type: 'object' } }],
    } };
  const signer = new MasterKeySigner({ seed, ...pair, popclawId: actorId });
  const built = await signEnvelope(signer, { actor: { popclawId: actorId }, timestamp: now, lorehouse: origin,
    intent: { lorehouse: origin, intentKind: 'booking.reserve', params: new TextEncoder().encode('{}'), context: {
      houseOrigin: origin, houseKey: actorId, incarnation: 'historical_house', sessionId: 'old_session', fence: '7',
      capabilityRevision: saved.capabilityRevision, schemaVersion: 1, validUntil: now + 100,
    } } });
  const body = new TextEncoder().encode('{}');
  const result = popclaw.world.ActionResult.fromObject({ house: saved.house, actorId, audienceId: actorId, requestId: built.eventId,
    requestDigest: cidFromCanonical(built.signedPayloadBytes), kind: 'booking.reserve', schemaVersion: 1, capabilityRevision: saved.capabilityRevision,
    status: 3, statusRevision: '2', executionId: 'old_execution', code: 'OK', committedAt: now, resultBody: body, resultDigest: cidFromCanonical(body) });
  const core = canonicalWorldCore(popclaw.world.ActionResult, result);
  const scope = JSON.stringify([origin, actorId, 'historical_house', actorId]);
  f.partition.db.execute(`INSERT INTO world_action_client_requests(binding,request_id,request_bytes,request_digest,kind,schema_version,capabilities,valid_until,latest_result)
    VALUES(?,?,?,?,?,?,?,?,?)`, [scope, built.eventId, built.signedPayloadBytes, cidFromCanonical(built.signedPayloadBytes), 'booking.reserve', 1, JSON.stringify(saved), now + 100, core]);
  const before = f.partition.db.queryAll('SELECT * FROM world_action_client_requests');
  const signature = nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_ACTION_RESULT_V1', core), pair.secretKey);
  f.fetch.mockResolvedValue(new Response(Buffer.from(popclaw.world.ActionStatusResponse.encode({ result: { result, signature } }).finish()), { headers: { 'content-type': 'application/x-protobuf' } }));
  f.db.execute("UPDATE house_participation SET desired='disabled',phase='disconnected',op_seq=2");
  f.db.execute('UPDATE world_capability_current_v1 SET active=0');
  const output = await f.worlds.client(origin).status(built.eventId).catch(error => {
    if (!(error instanceof Error) || error.message !== 'ACTION_CONTEXT_UNSUPPORTED') throw error;
    return { code: error.message };
  });
  expect(output.code).toBe('ACTION_CONTEXT_UNSUPPORTED');
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toEqual(before);
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_evidence')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled(); expect(f.authorize).not.toHaveBeenCalled();
});

/** Root/lifecycle and file-SQLite proof; transport is stubbed here. The separately
 * owned integration fixture proves real House/SDK business execution. */
/** `false` = the integration fixture owner lane, `true` = native policy,
 *  `'owner'` = the production MCP owner-confirmation lane. */
async function receiptRuntimeFixture(lane: boolean | 'owner' | 'native+owner' = false) {
  const native = lane === true || lane === 'native+owner';
  const root = mkdtempSync(join(tmpdir(), 'g0-action-runtime-')), paths = new PopclawPaths(root);
  const db = new LocalHostDb(paths.socialDb()), cacheDb = new LocalHostDb(join(root, 'cache.db'));
  const signer = new MasterKeySigner({ seed, ...pair, popclawId: actorId }), pin = Buffer.from(pair.publicKey).toString('hex');
  const now = Math.floor(Date.now() / 1000), binding = { origin, houseKey: actorId, incarnation: 'receipt_house' };
  ensureHouseLifecycleSchema(db);
  db.execute("INSERT INTO house_participation(house_origin,installation_id,desired,phase,op_seq,ack_key_hex,session_id,house_revision,lease_expires_at) VALUES(?,'fixture','enabled','connected',1,?,'session_1',3,?)", [origin, pin, now + 600]);
  const guide = new TextEncoder().encode('Save a reading annotation.');
  const manifest = { house_session: { version: 1, endpoint: '/v1/house-session', ack_pubkey: pin, operations: ['enter', 'renew', 'leave'] },
    world_interaction: { version: 1, actions: { status_endpoint: '/v1/world-actions/status', result_authority_pubkey: actorId, kinds: ['reading.annotate'], attachments: [] },
      guide: { path: '/v1/guide.md', sha256: cidFromCanonical(guide), revision: 'g1' } },
    intent_kinds: [{ kind: 'reading.annotate', schema_version: 1, transport: 'house', signer: 'user', description: 'Save annotation',
      // THE HOUSE NAMES ITS PARAMETER. A bare `{ type: 'object' }` declares no
      // key at all, and both lanes now refuse a key the house never declared —
      // so a fixture that named nothing was a house nobody could act on.
      params_schema: { type: 'object', properties: { text: { type: 'string' } } },
      result_schema: { type: 'object' }, result_attachments: { allowed: [], required_on_success: [] }, consistency: 'none' }] };
  const rawBytes = new TextEncoder().encode(JSON.stringify(manifest)), revision = cidFromCanonical(rawBytes);
  const proof = { house: binding, manifestDigest: revision, signedAt: now };
  const proofBytes = canonicalWorldCore(popclaw.world.ManifestProof, { ...proof,
    authoritySignature: nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1', canonicalWorldCore(popclaw.world.ManifestProof, proof)), pair.secretKey) });
  const prepared = await makeWorldManifestPreparer({ fetch: async () => new Response(Buffer.from(guide)) })({ origin, rawBytes, ackKeyHex: pin,
    provenance: 'configured_pin', signal: new AbortController().signal, proofHeader: Buffer.from(proofBytes).toString('base64') });
  db.transaction(prepared.commit);
  const catalog = new ExecutionStoreCatalog({ db, paths, actorId }), partition = catalog.open(origin);
  const maintenance = MaintenanceSession.begin(db, paths, 'fixture receipt setup');
  initializeActionReceiptJournal({ catalog, origin, maintenance });
  if (native) initializeNativeActionJournal({ catalog, origin, maintenance });
  maintenance.finish({ recovery: false, reason: 'synthetic offline setup finished' });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('UNEXPECTED_NETWORK'); });
  const houses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer, origins: [origin], executionStores: catalog, fetch, configuredPinFor: () => pin });
  const house = { baseUrl: origin, slug: 'world-runtime-invalid', db: cacheDb, executionDb: partition.db, dbPath: join(root, 'cache.db'), cache: new WorldFeedCache({ db: cacheDb }) };
  houses.configureResources({ stores: [house], openStore: async () => house, worldStreamMode: true,
    host: {} as HouseResourceOptions['host'], recipientPopclawId: actorId, isOfficialActor: () => true });
  let permitActive = true;
  const authorize = vi.fn(async () => ({ jobId: 'fixture-explicit-action', expiresAt: now + 200,
    assertCurrent: () => { if (!permitActive) throw new Error('FIXTURE_PERMISSION_REVOKED'); } }));
  // The MCP adapter's presence flag and its per-call ask, split exactly as the
  // production adapter splits them: presence opens the lane, the ask grants.
  let ownerFormAvailable = true;
  const assertActive = vi.fn(() => { if (!ownerFormAvailable) throw new Error('OWNER_CONFIRMATION_UNAVAILABLE'); });
  const ask = { authorize };
  const hostConfig = { plugins: { entries: { popclaw: { enabled: true, config: { worldExecution: { policies: [{
    agentId: 'main', actorId, house: origin, houseKey: actorId, kinds: ['reading.annotate'],
    authorizedAt: new Date((now - 1) * 1000).toISOString().replace('.000Z', 'Z'),
    expiresAt: new Date((now + 600) * 1000).toISOString().replace('.000Z', 'Z'),
  }] } } } } } };
  const adapter = createOpenClawWorldExecution({ actorId, readActiveConfig: () => hostConfig, now: () => now });
  const nativeFactory = adapter.bindFactory({ agentId: 'main', getRuntimeConfig: () => hostConfig });
  let resolver!: HousePushEffectResolver;
  const configureResolver = houses.configurePushEffectResolver.bind(houses);
  vi.spyOn(houses, 'configurePushEffectResolver').mockImplementation(value => { resolver = value; configureResolver(value); });
  const worlds = new WorldRuntime({ mode: 'commands', houses, signer, actorId, readCapabilities: value => readHouseCapabilityView(db, value),
    now: () => now, ...(native ? { nativeAuthorization: adapter }
      : lane === 'owner' ? { ownerAuthorization: { assertActive } }
      : { fixtureOwnerAuthorization: { authorize } }),
    // The OpenClaw native root carries BOTH from this slice on: a configured
    // policy lane and a per-call owner lane.
    ...(lane === 'native+owner' ? { ownerAuthorization: { assertActive } } : {}) });
  const context: WorldCommandContext = { readCapabilities: worlds.readCapabilities, client: worlds.client, actionAuthority: worlds.actionAuthority };
  const push = vi.spyOn(houses.egress, 'pushTo').mockResolvedValue({ status: 200 });
  const input = { house: origin, kind: 'reading.annotate', params: { text: 'annotation' }, expected_capability_revision: revision };
  const invokeWith = (params: Record<string, unknown>) => {
    const value = { ...input, params };
    return native ? nativeFactory.withInvocation('native-call-1', value, undefined,
      permit => houses.runCommand(() => runWorldInvokeCommand(worlds.nativeCommandContext(permit), value)))
      : lane === 'owner' ? houses.runCommand(() => runWorldInvokeCommand(worlds.ownerCommandContext(ask), value))
      : houses.runCommand(() => runWorldInvokeCommand(context, value));
  };
  const invoke = () => invokeWith(input.params);
  const terminal = () => {
    const row = partition.db.queryOne<{request_id: string; request_bytes: Uint8Array; request_digest: string; receipt_profile: string | null}>('SELECT * FROM world_action_client_requests')!;
    // Receipt profiles select the protocol digest domain: the public profile
    // verifies the stored wrapper and returns the INNER payload digest, so the
    // fixture must derive it through the production dispatcher instead of
    // reusing the durable wrapper checksum (which the old profile used).
    const protocolDigest = actionRequestDigest({ request_bytes: row.request_bytes, request_digest: row.request_digest, receipt_profile: row.receipt_profile });
    const resultBody = new TextEncoder().encode('{"saved":true}');
    const result = popclaw.world.ActionResult.fromObject({ house: binding, actorId, audienceId: actorId, requestId: row.request_id,
      requestDigest: protocolDigest, kind: input.kind, schemaVersion: 1, capabilityRevision: revision,
      status: 3, statusRevision: '2', executionId: 'fixture_execution', committedAt: now, code: 'OK', resultBody, resultDigest: cidFromCanonical(resultBody) });
    const signed = { result, signature: nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_ACTION_RESULT_V1', canonicalWorldCore(popclaw.world.ActionResult, result)), pair.secretKey) };
    return { requestId: row.request_id, raw: popclaw.world.ActionStatusResponse.encode({ result: signed }).finish() };
  };
  const state = () => {
    const receipt = partition.db.queryOne<{receipt_state: Uint8Array}>('SELECT receipt_state FROM world_action_client_results');
    return { reservation: partition.db.queryOne<{status: string}>(native ? 'SELECT status FROM world_native_action_reservations' : 'SELECT status FROM world_owner_action_reservations')?.status,
      receipt: receipt ? decodeActionReceiptState(receipt.receipt_state) : null };
  };
  const reopenedCleanup: Array<() => Promise<void>> = [];
  const reopenWithoutAuthority = async () => {
    adapter.stop(); worlds.stop(); await worlds.whenIdle(); await houses.stop(); catalog.close();
    const reopenedCatalog = new ExecutionStoreCatalog({ db, paths, actorId }), reopenedPartition = reopenedCatalog.open(origin);
    const reopenedHouses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db, signer, origins: [origin], executionStores: reopenedCatalog, fetch, configuredPinFor: () => pin });
    const reopenedHouse = { ...house, executionDb: reopenedPartition.db };
    reopenedHouses.configureResources({ stores: [reopenedHouse], openStore: async () => reopenedHouse, worldStreamMode: true,
      host: {} as HouseResourceOptions['host'], recipientPopclawId: actorId, isOfficialActor: () => true });
    const reopenedWorlds = new WorldRuntime({ mode: 'commands', houses: reopenedHouses, signer, actorId, now: () => now + 1000,
      readCapabilities: () => { throw new Error('CURRENT_CAPABILITIES_MUST_NOT_BE_READ'); } });
    reopenedCleanup.push(async () => { reopenedWorlds.stop(); await reopenedWorlds.whenIdle(); await reopenedHouses.stop(); reopenedCatalog.close(); });
    return { worlds: reopenedWorlds, partition: reopenedPartition };
  };
  resources.push(async () => {
    for (const close of reopenedCleanup.reverse()) await close();
    adapter.stop(); worlds.stop(); await worlds.whenIdle(); await houses.stop(); catalog.close(); cacheDb.close(); db.close(); rmSync(root, { recursive: true, force: true });
  });
  return { db, paths, partition, houses, worlds, context, input, invoke, invokeWith, terminal, state, fetch, push, authorize, reopenWithoutAuthority, resolver,
    ask, assertActive, ownerContext: () => worlds.ownerCommandContext(ask),
    stopNative: () => adapter.stop(),
    closeOwnerForm: () => { ownerFormAvailable = false; },
    /** Plugin enabled, `worldExecution` PRESENT with an empty `policies` array.
     *  NOT the measured firstuse2 shape, which has no `worldExecution` block at
     *  all — the comment used to say that and the code never did it. Both land
     *  on the same refusal (`config()` maps an absent block to `policies = []`),
     *  which is why the tests below read the same either way; they are still
     *  two different configurations and this one is the one being built. */
    dropPolicies: () => { hostConfig.plugins.entries.popclaw.config.worldExecution.policies.splice(0); },
    duplicatePolicy: () => { const first = hostConfig.plugins.entries.popclaw.config.worldExecution.policies[0]!;
      hostConfig.plugins.entries.popclaw.config.worldExecution.policies.push({ ...first }); },
    revoke: () => { permitActive = false; hostConfig.plugins.entries.popclaw.enabled = false; } };
}

it.each(['send', 'revoke-before-send', 'stop-before-send', 'revoke-after-send'] as const)('roundtrips native references through the actual SQLite push bus: %s', async mode => {
  const f = await receiptRuntimeFixture(true); f.push.mockRestore(); let sends = 0;
  const bus = new HouseCommandBus({ db: f.db, coordinator: { knownHouseOrigins: () => [origin] } as HouseCommandPort,
    authority: { captureEpoch: () => 1, isEpochCurrent: epoch => epoch === 1 }, pollMs: 1, timeoutMs: 1000,
    executePush: async (target, bytes, context) => {
      expect(context.effectReference?.kind).toBe('world_intent');
      const persisted = f.db.queryOne<{effect_json:string}>('SELECT effect_json FROM house_lifecycle_commands WHERE kind=\'push\'')!;
      expect(JSON.parse(persisted.effect_json).executionReference.kind).toBe('native_policy');
      const check = await f.resolver({ origin: target, bytes, ref: context.effectReference!, context });
      if (mode === 'revoke-before-send') f.revoke();
      if (mode === 'stop-before-send') f.stopNative();
      check(); context.authorizeSend(); sends++;
      if (mode === 'revoke-after-send') {
        const terminal = f.terminal(); f.revoke();
        const signed = popclaw.world.ActionStatusResponse.decode(terminal.raw).result!;
        return { status: 200, signedActionResultBase64: Buffer.from(popclaw.world.SignedActionResult.encode(signed).finish()).toString('base64') };
      }
      return { status: 200 };
    } });
  resources.unshift(async () => { await bus.stop(); }); bus.start();
  const result = await f.invoke();
  expect(sends).toBe(mode === 'revoke-before-send' || mode === 'stop-before-send' ? 0 : 1);
  expect(f.partition.db.queryAll('SELECT * FROM world_native_action_reservations')).toHaveLength(1);
  if (mode === 'revoke-after-send') expect(result).toMatchObject({ receipt_durable: true, base_accounting: { state: 'applied' } });
});

it('executes under native local policy and settles the original result after revocation and restart', async () => {
  const f = await receiptRuntimeFixture(true);
  await f.invoke(); expect(f.push).toHaveBeenCalledOnce(); expect(f.authorize).not.toHaveBeenCalled();
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.partition.db.queryOne<{receipt_profile:string}>('SELECT receipt_profile FROM world_action_client_requests')?.receipt_profile).toBe('public-envelope-01.3-native-action-v1');
  const terminal = f.terminal(); f.revoke();
  f.db.execute("UPDATE house_participation SET desired='disabled',phase='disconnected',op_seq=2,lease_expires_at=0");
  f.db.execute('UPDATE world_capability_current_v1 SET active=0');
  const reopened = await f.reopenWithoutAuthority();
  f.fetch.mockResolvedValue(new Response(Buffer.from(terminal.raw), { headers: { 'content-type': 'application/x-protobuf' } }));
  const output = await runWorldActionStatusCommand(reopened.worlds, { house: origin, request_id: terminal.requestId });
  expect(output).toMatchObject({ receipt_durable: true, base_accounting: { state: 'applied' } });
  expect(reopened.partition.db.queryOne<{status:string}>('SELECT status FROM world_native_action_reservations')?.status).toBe('succeeded');
  expect(f.push).toHaveBeenCalledOnce(); expect(f.authorize).not.toHaveBeenCalled();
});

it('does not create a native reservation after applied local policy revocation', async () => {
  // `revoke()` switches the plugin entry off, which is its own named refusal
  // now: it is not the same situation as a configuration that authorizes
  // nothing, and it never was.
  const f = await receiptRuntimeFixture(true); f.revoke();
  await expect(f.invoke()).rejects.toThrow('NATIVE_PLUGIN_DISABLED');
  expect(f.partition.db.queryAll('SELECT * FROM world_native_action_reservations')).toHaveLength(0);
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled();
});

it('preserves an original native result pending accounting when storage becomes held', async () => {
  const f = await receiptRuntimeFixture(true); await f.invoke(); const terminal = f.terminal(); f.revoke();
  f.fetch.mockImplementation(async () => {
    publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'native-held', mode: 'recovery', reason: 'synthetic restore', held: ['execution', 'consumers', 'notifications'], releases: {} });
    return new Response(Buffer.from(terminal.raw), { headers: { 'content-type': 'application/x-protobuf' } });
  });
  const result = await runWorldActionStatusCommand(f.context, { house: origin, request_id: terminal.requestId });
  expect(result).toMatchObject({ receipt_durable: true, base_accounting: { state: 'pending' } });
  expect(f.state().reservation).toBe('reserved');
});

it('uses independent fixture authorization through the shared command, then settles original status after logout', async () => {
  const f = await receiptRuntimeFixture();
  const invoked = await f.invoke(); expect(invoked.receipt_durable).toBe(false); expect(f.push).toHaveBeenCalledOnce();
  const terminal = f.terminal();
  f.db.execute("UPDATE house_participation SET desired='disabled',phase='disconnected',op_seq=2,lease_expires_at=0");
  f.db.execute('UPDATE world_capability_current_v1 SET active=0'); f.revoke();
  f.fetch.mockImplementation(async (url, init) => {
    expect(url).toBe(origin + '/v1/world-actions/status');
    const query = popclaw.world.ActionStatusRequest.decode(new Uint8Array(init?.body as Uint8Array));
    expect(query.requestId).toBe(terminal.requestId);
    expect(query.house).toMatchObject({ origin, houseKey: actorId, incarnation: 'receipt_house' });
    expect(nacl.sign.detached.verify(worldSigningInput('POPCLAW_WORLD_ACTION_STATUS_READ_V1', canonicalWorldCore(popclaw.world.ActionStatusRequest, { ...query, signature: undefined })), query.signature, pair.publicKey)).toBe(true);
    return new Response(Buffer.from(terminal.raw), { headers: { 'content-type': 'application/x-protobuf' } });
  });
  const output = await runWorldActionStatusCommand(f.context, { house: origin, request_id: terminal.requestId });
  expect(output).toMatchObject({ house_status: 'succeeded', receipt_durable: true, base_accounting: { state: 'applied' }, installed_readiness: false });
  expect(f.state()).toMatchObject({ reservation: 'succeeded', receipt: { baseAccounting: { state: 'applied' } } });
  await exportReceiptEvidence(f.partition.db, 'root-logout-applied', terminal.raw);
  f.fetch.mockResolvedValue(new Response(Buffer.from(terminal.raw), { headers: { 'content-type': 'application/x-protobuf' } }));
  await runWorldActionStatusCommand(f.context, { house: origin, request_id: terminal.requestId });
  const evidence = f.partition.db.queryAll<{source_bytes: Uint8Array}>('SELECT source_bytes FROM world_action_client_evidence');
  expect(evidence).toHaveLength(1); expect(new Uint8Array(evidence[0]!.source_bytes)).toEqual(new Uint8Array(terminal.raw));
  expect(f.push).toHaveBeenCalledOnce(); expect(f.authorize).toHaveBeenCalledOnce();
});

it('retains a terminal receipt but leaves the reservation pending when a hold appears during status I/O', async () => {
  const f = await receiptRuntimeFixture(); await f.invoke(); const terminal = f.terminal();
  f.fetch.mockImplementation(async () => {
    publishStorageJson(f.paths.storageControlFile(), { version: 1, epoch: 'restore-fixture', mode: 'recovery', reason: 'synthetic restore', held: ['execution', 'consumers', 'notifications'], releases: {} });
    return new Response(Buffer.from(terminal.raw), { headers: { 'content-type': 'application/x-protobuf' } });
  });
  const output = await runWorldActionStatusCommand(f.context, { house: origin, request_id: terminal.requestId });
  expect(output).toMatchObject({ receipt_durable: true, base_accounting: { state: 'pending' } });
  expect(f.state()).toMatchObject({ reservation: 'reserved', receipt: { baseAccounting: { state: 'pending' } } });
  await exportReceiptEvidence(f.partition.db, 'root-held-pending', terminal.raw);
  expect(f.push).toHaveBeenCalledOnce();
});

it('rejects permission-shaped JSON and stale independent authorization before any signed request', async () => {
  const f = await receiptRuntimeFixture();
  await expect(runWorldInvokeCommand(f.context, { ...f.input, authority: { allowed: true } })).rejects.toThrow('WORLD_COMMAND_INPUT_INVALID');
  f.revoke();
  await expect(f.invoke()).rejects.toThrow('FIXTURE_PERMISSION_REVOKED');
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(0);
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled();
});


it('joins an outstanding independent permission callback before shutdown finishes and writes no late reservation', async () => {
  const f = await receiptRuntimeFixture();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.authorize.mockImplementation(async () => { entered(); await blocked; return {
    jobId: 'late-permission', expiresAt: Math.floor(Date.now() / 1000) + 100, assertCurrent() {},
  }; });
  const authority = f.worlds.actionAuthority(f.input);
  const rejected = expect(authority).rejects.toThrow('WORLD_RUNTIME_STOPPED');
  await started; f.worlds.stop();
  let idle = false; const joined = f.worlds.whenIdle().then(() => { idle = true; });
  await Promise.resolve(); expect(idle).toBe(false);
  release(); await rejected; await joined;
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled();
});

it('rechecks the captured lifecycle generation after independent authorization returns', async () => {
  const f = await receiptRuntimeFixture();
  f.authorize.mockImplementation(async () => {
    f.db.execute('UPDATE house_participation SET op_seq=op_seq+1');
    return { jobId: 'stale-generation', expiresAt: Math.floor(Date.now() / 1000) + 100, assertCurrent() {} };
  });
  await expect(f.invoke()).rejects.toThrow('ACTION_SELECTION_GENERATION_CHANGED');
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled();
});


it('reopens the execution file without a fixture authority and settles only the original request after logout and expiry', async () => {
  const f = await receiptRuntimeFixture(); await f.invoke(); const terminal = f.terminal();
  const original = f.partition.db.queryAll('SELECT request_bytes,original_context,execution_reference FROM world_action_client_requests');
  f.db.execute("UPDATE house_participation SET desired='disabled',phase='disconnected',op_seq=2,lease_expires_at=0");
  f.db.execute('UPDATE world_capability_current_v1 SET active=0'); f.revoke();
  const reopened = await f.reopenWithoutAuthority();
  f.fetch.mockImplementation(async () => new Response(Buffer.from(terminal.raw), { headers: { 'content-type': 'application/x-protobuf' } }));
  expect(await reopened.worlds.client(origin).status(terminal.requestId)).toMatchObject({ receipt_durable: true, base_accounting: { state: 'applied' } });
  expect(reopened.partition.db.queryAll('SELECT request_bytes,original_context,execution_reference FROM world_action_client_requests')).toEqual(original);
  expect(reopened.partition.db.queryOne<{status: string}>('SELECT status FROM world_owner_action_reservations')?.status).toBe('succeeded');
  expect(reopened.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(1);
  await exportReceiptEvidence(reopened.partition.db, 'root-reopened-applied', terminal.raw);
  await expect(reopened.worlds.client(origin).invoke(f.input, {} as any)).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  expect(f.push).toHaveBeenCalledOnce(); expect(f.authorize).toHaveBeenCalledOnce();
});


it('uses the model-visible cached declaration for a native invocation and reads its signed result', async () => {
  const f = await receiptRuntimeFixture(true);
  const result = await runWorldCapabilitiesCommand(f.worlds, {house: origin});
  const material = result.agent_context as import('../../../src/world/world-agent-context.js').WorldAgentContext;
  expect(material.status).toBe('available');
  expect(material.guide?.text).toBe('Save a reading annotation.');
  expect(material.actions?.[0]?.params_schema).toEqual({type: 'object', properties: {text: {type: 'string'}}});
  f.input.kind = material.actions![0]!.kind;
  f.input.expected_capability_revision = material.capability_revision;
  // This fixture's declared object schema explicitly permits these parameters.
  const invoked = await f.invoke();
  expect(invoked.status).toBe('unknown');
  const terminal = f.terminal();
  f.fetch.mockResolvedValueOnce(new Response(new Uint8Array(terminal.raw).buffer, {headers: {'content-type': 'application/x-protobuf'}}));
  const status = await runWorldActionStatusCommand(f.worlds, {house: origin, request_id: terminal.requestId});
  expect(status).toMatchObject({status: 'succeeded', code: 'OK'});
  expect(f.authorize).not.toHaveBeenCalled(); // native policy, never the fixture owner-action permission lane
});

it('T-i: drives one signed request and one reservation through the MCP owner lane, then settles the receipt', async () => {
  const f = await receiptRuntimeFixture('owner');
  const invoked = await f.invoke();
  expect(invoked.receipt_durable).toBe(false);
  expect(f.push).toHaveBeenCalledOnce();
  expect(f.authorize).toHaveBeenCalledOnce();
  expect(f.assertActive).toHaveBeenCalled(); // the lane is what projected the kind as ready
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(1);
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(1);
  // The fixture's stub hands out the same job id twice, which the real adapter
  // never does (production refuses a second `authorize` in one invocation with
  // OWNER_CONFIRMATION_BUSY). What the second invoke proves is the reservation
  // store's jobId idempotency: one job id is one reservation, one request id and
  // one stored request — the push is the same signed request sent again, not a
  // second footprint.
  const again = await f.invoke();
  expect(again.request_id).toBe(invoked.request_id);
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(1);
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(1);
  expect(f.push).toHaveBeenCalledTimes(2);
  expect(f.push.mock.calls[1]).toEqual(f.push.mock.calls[0]);
  const terminal = f.terminal();
  f.fetch.mockImplementation(async () => new Response(Buffer.from(terminal.raw), { headers: { 'content-type': 'application/x-protobuf' } }));
  const status = await runWorldActionStatusCommand(f.ownerContext(), { house: origin, request_id: terminal.requestId });
  expect(status).toMatchObject({ house_status: 'succeeded', receipt_durable: true, base_accounting: { state: 'applied' } });
  expect(f.state()).toMatchObject({ reservation: 'succeeded', receipt: { baseAccounting: { state: 'applied' } } });
});

it.each(['send', 'revoke-before-recheck', 'lane-closed-before-push'] as const)(
  'T-i also drives owner_action through the actual SQLite push bus: %s', async mode => {
  const f = await receiptRuntimeFixture('owner'); f.push.mockRestore(); let sends = 0;
  const bus = new HouseCommandBus({ db: f.db, coordinator: { knownHouseOrigins: () => [origin] } as HouseCommandPort,
    authority: { captureEpoch: () => 1, isEpochCurrent: epoch => epoch === 1 }, pollMs: 1, timeoutMs: 1000,
    executePush: async (target, bytes, context) => {
      expect(context.effectReference?.kind).toBe('world_intent');
      const persisted = f.db.queryOne<{effect_json:string}>('SELECT effect_json FROM house_lifecycle_commands WHERE kind=\'push\'')!;
      expect(JSON.parse(persisted.effect_json).executionReference.kind).toBe('owner_action');
      // Closing the confirmation form before the resolver runs must be caught by
      // `ownerLaneActive()` at the top of `preparePushEffect`, before any authority
      // lookup or DB row is touched.
      if (mode === 'lane-closed-before-push') f.closeOwnerForm();
      const check = await f.resolver({ origin: target, bytes, ref: context.effectReference!, context });
      // Revoking here (after the resolver's own initial check, before the returned
      // re-check closure runs) targets exactly the re-check that `assertCurrent`
      // consumes: `permission()` -> the owner authorizations closure -> `permit.assertCurrent()`.
      if (mode === 'revoke-before-recheck') f.revoke();
      check(); context.authorizeSend(); sends++;
      expect(new Uint8Array(bytes)).toEqual(new Uint8Array(
        f.partition.db.queryOne<{request_bytes: Uint8Array}>('SELECT request_bytes FROM world_action_client_requests')!.request_bytes));
      return { status: 200 };
    } });
  resources.unshift(async () => { await bus.stop(); }); bus.start();
  const result = await f.invoke();
  expect(sends).toBe(mode === 'send' ? 1 : 0);
  // The reservation and the durable request are both written by `ownerAuthority`
  // before the push is attempted, so both stay at one row each regardless of
  // whether the real push bus goes on to admit or refuse the push itself.
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(1);
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(1);
  if (mode === 'send') expect(result.request_id).toBeTruthy();
});

it('T-j: rejects permission-shaped JSON in the owner lane before any signed request', async () => {
  const f = await receiptRuntimeFixture('owner');
  await expect(runWorldInvokeCommand(f.ownerContext(), { ...f.input, authority: { allowed: true } }))
    .rejects.toThrow('WORLD_COMMAND_INPUT_INVALID');
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(0);
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled();
});

it('T-k: rechecks the captured lifecycle generation after the owner confirmation returns', async () => {
  const f = await receiptRuntimeFixture('owner');
  f.authorize.mockImplementation(async () => {
    f.db.execute('UPDATE house_participation SET op_seq=op_seq+1');
    return { jobId: 'mcp-owner:0123456789abcdef', expiresAt: Math.floor(Date.now() / 1000) + 100, assertCurrent() {} };
  });
  await expect(f.invoke()).rejects.toThrow('ACTION_SELECTION_GENERATION_CHANGED');
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled();
});

it('T-l: joins an outstanding owner confirmation before shutdown finishes and writes no late reservation', async () => {
  const f = await receiptRuntimeFixture('owner');
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.authorize.mockImplementation(async () => { entered(); await blocked; return {
    jobId: 'mcp-owner:fedcba9876543210', expiresAt: Math.floor(Date.now() / 1000) + 100, assertCurrent() {},
  }; });
  const pending = f.ownerContext().actionAuthority!(f.input);
  const rejected = expect(pending).rejects.toThrow('WORLD_RUNTIME_STOPPED');
  await started; f.worlds.stop();
  let idle = false; const joined = f.worlds.whenIdle().then(() => { idle = true; });
  await Promise.resolve(); expect(idle).toBe(false);
  release(); await rejected; await joined;
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled();
});

it('T-m: a reopened runtime without the owner lane refuses new invokes and still settles the original request', async () => {
  const f = await receiptRuntimeFixture('owner');
  await f.invoke();
  const terminal = f.terminal();
  const original = f.partition.db.queryAll('SELECT request_bytes,original_context,execution_reference FROM world_action_client_requests');
  f.db.execute("UPDATE house_participation SET desired='disabled',phase='disconnected',op_seq=2,lease_expires_at=0");
  f.db.execute('UPDATE world_capability_current_v1 SET active=0');
  const reopened = await f.reopenWithoutAuthority();
  f.fetch.mockImplementation(async () => new Response(Buffer.from(terminal.raw), { headers: { 'content-type': 'application/x-protobuf' } }));
  expect(await reopened.worlds.client(origin).status(terminal.requestId)).toMatchObject({ receipt_durable: true, base_accounting: { state: 'applied' } });
  expect(reopened.partition.db.queryAll('SELECT request_bytes,original_context,execution_reference FROM world_action_client_requests')).toEqual(original);
  expect(reopened.partition.db.queryOne<{status: string}>('SELECT status FROM world_owner_action_reservations')?.status).toBe('succeeded');
  await expect(reopened.worlds.client(origin).invoke(f.input, {} as never)).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  expect(() => reopened.worlds.ownerCommandContext(f.ask)).toThrow('OWNER_CONFIRMATION_UNAVAILABLE');
  expect(f.push).toHaveBeenCalledOnce();
});

it('T-n: reusing one confirmation job for a different action is refused by the reservation store', async () => {
  const f = await receiptRuntimeFixture('owner');
  f.authorize.mockImplementation(async () => ({ jobId: 'mcp-owner:00112233445566aa', expiresAt: Math.floor(Date.now() / 1000) + 200, assertCurrent() {} }));
  await f.invoke();
  const swapped = { ...f.input, params: { text: 'a different annotation' } };
  await expect(runWorldInvokeCommand(f.ownerContext(), swapped)).rejects.toThrow('OWNER_ACTION_JOB_CONFLICT');
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(1);
  expect(f.push).toHaveBeenCalledOnce();
});

it('an MCP client that cannot render a confirmation form never reaches the ask', async () => {
  const f = await receiptRuntimeFixture('owner');
  f.closeOwnerForm();
  await expect(f.invoke()).rejects.toThrow('WORLD_LOCAL_UNSUPPORTED');
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
});

/* --------------------------------------------------------------------------
 * PROBE-8c ON THE PATH THAT ACTUALLY ACTS.
 *
 * The owner's dialog refuses to draw a row for a parameter key the house never
 * declared, and prefixes every row it does draw so no parameter can paint a
 * line of the frame's own shape. Neither of those is worth anything if the
 * same call still RUNS.
 *
 * It would still run, too: a refused prompt is not "the owner was asked", so
 * the call falls through to the configured policy lane — which, before this,
 * would have sent exactly the parameters the owner was never shown. That is
 * "what the owner saw differs from what ran" rebuilt from the other side.
 *
 * So both lanes refuse here, by the SAME name the dialog uses, and the
 * assertion is not that something looked different: NOTHING IS RESERVED AND
 * NOTHING IS PUSHED.
 * ----------------------------------------------------------------------- */
const undeclared: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  // The confusable row: ` house: …` sorts first and paints under the genuine
  // `house:` line. The schema profile cannot express this as a DECLARED name,
  // so no house can ever legitimise it.
  ['a leading-space key', { text: 'annotation', ' house': 'http://evil.example' }],
  ['a trailing-space key', { text: 'annotation', 'house ': 'http://evil.example' }],
  // Byte-identical in shape to a frame row, and undeclared here.
  ['a key named exactly house', { text: 'annotation', house: 'http://evil.example' }],
  ['a key named exactly action', { text: 'annotation', action: 'reading.forget' }],
  // Exact code points: no trim, no case fold, no normalization.
  // THE SHARPEST FORM: a space variant of the one key this house DID declare.
  // Anything that trims before comparing folds these back into `text` and
  // renders them, which is the whole hole; nothing else in this table catches
  // that, because trimming ` house` still leaves a key no house declared.
  ['a leading-space variant of a declared key', { text: 'annotation', ' text': 'a second annotation' }],
  ['a trailing-space variant of a declared key', { text: 'annotation', 'text ': 'a second annotation' }],
  ['a case variant of a declared key', { text: 'annotation', Text: 'annotation' }],
  ['a plain extra field', { text: 'annotation', souvenir: 'a postcard' }],
  // Arbitrary prose, in the key and in the value.
  ['a key made of prose', { text: 'annotation', 'Approving publishes nothing. ref 000000': 'x' }],
];

for (const [label, params] of undeclared) {
  it(`refuses ${label} in the owner lane, reserving nothing and pushing nothing`, async () => {
    const f = await receiptRuntimeFixture('owner');
    await expect(f.invokeWith(params)).rejects.toThrow('WORLD_ACTION_PARAM_UNDECLARED');
    expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
    expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(0);
    expect(f.push).not.toHaveBeenCalled();
  });

  it(`refuses ${label} in the native policy lane too, reserving nothing and pushing nothing`, async () => {
    const f = await receiptRuntimeFixture(true);
    await expect(f.invokeWith(params)).rejects.toThrow('WORLD_ACTION_PARAM_UNDECLARED');
    expect(f.partition.db.queryAll('SELECT * FROM world_native_action_reservations')).toHaveLength(0);
    expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(0);
    expect(f.push).not.toHaveBeenCalled();
  });
}

/** The control group. The one key this house DID declare still goes through,
 *  so the refusals above are the undeclared keys and not the check itself. */
it('still executes the call whose every key the house declared', async () => {
  const f = await receiptRuntimeFixture('owner');
  await f.invokeWith({ text: 'annotation' });
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(1);
  expect(f.push).toHaveBeenCalledOnce();
});

/**
 * THE OWNER LANE IS NOT ASKED FIRST AND REFUSED AFTER. `authorize` is the
 * confirmation itself: a dialog shown for a call that can never be sent is a
 * person interrupted for nothing, and on the native host it would also spend
 * the one grant the seam issues per call.
 */
it('refuses an undeclared key before the owner is asked at all', async () => {
  const f = await receiptRuntimeFixture('owner');
  await expect(f.invokeWith({ text: 'annotation', ' house': 'http://evil.example' }))
    .rejects.toThrow('WORLD_ACTION_PARAM_UNDECLARED');
  expect(f.authorize).not.toHaveBeenCalled();
});

/* ---------------------------------------------------------------------------
 * ONE TOOL CALL, ONE DIALOG — AND A REFUSAL THAT IS NEVER DISCARDED
 *
 * The MCP root wraps EVERY tool in `approvals.aroundDispatch` (`src/mcp.ts`),
 * so a tool that has registered an owner-approval subject is asked about
 * there, before its body runs. `popclaw_world_invoke` asks the owner itself,
 * inside its body, through its own reviewed elicitation — so a subject
 * registered under MCP means ONE action, TWO dialogs.
 *
 * And the second dialog is not the worst of it. The world body never calls
 * `consumeOwnerApproval`, so the answer to the first dialog decides nothing:
 * deny it, approve the second, and the action is signed and pushed. A
 * recorded refusal must never fall on the floor.
 *
 * The subject is therefore registered on the native host only. This drives
 * the real MCP composition — the root's own `registerPopclawTools`, the real
 * seam wrapper, the real world elicitation adapter, this fixture's real
 * runtime, reservation store and push bus — and counts the dialogs.
 * ------------------------------------------------------------------------ */
function mcpRoot(f: Awaited<ReturnType<typeof receiptRuntimeFixture>>, answers: ElicitResult[]) {
  // The registry is process-global; leaving a subject behind would decide the
  // next test in this file.
  resetOwnerApprovals();
  resources.push(async () => resetOwnerApprovals());
  const asks: string[] = [];
  const elicitInput = vi.fn(async (params: { message: string }) => {
    asks.push(params.message);
    // Never blocks. An unanswered dialog would turn a wrong dialog COUNT into
    // a test that hangs rather than one that fails on the count.
    return answers.shift() ?? { action: 'cancel' as const };
  });
  // `codex` renders the whole message, so BOTH dialogs are renderable on this
  // client. A client that folds refuses the seam's dialog for being
  // unreadable, which would hide the second prompt behind a different fact.
  const box = { current: { elicitInput,
    getClientCapabilities: () => ({ elicitation: { form: {} } }),
    getClientVersion: () => ({ name: 'codex', version: '0.155' }) } } as never;
  const defects: string[] = [];
  const approvals = createMcpOwnerApproval({ server: box,
    logger: { warn: () => {}, error: (_context: unknown, message: string) => defects.push(message) } });
  const authorization = createMcpOwnerAuthorization({ actorId, server: box, duplicates: { unresolved: () => [] } });
  const collector = makeToolCollector();
  registerPopclawTools({
    api: collector.api,
    runtime: async () => ({}) as never,
    runCommand: <T>(work: () => Promise<T>) => f.houses.runCommand(work),
    getOrchestrator: async () => ({}) as never,
    getWorldDeps: async () => ({}) as never,
    getWorldCommandContext: async () => ({}) as never,
    declaredWorldActionParameters: worldDeclaredActionParameters(f.worlds, actorId),
    bindMcpWorldInvoke: () => ownerConfirmedWorldInvoke(authorization, f.worlds),
  } as unknown as Parameters<typeof registerPopclawTools>[0]);
  const tool = collector.tools.find(item => item.name === WORLD_INVOKE_TOOL)!;
  resources.push(async () => { authorization.stop(); approvals.stop(); });
  return { asks, defects,
    invoke: () => approvals.aroundDispatch(WORLD_INVOKE_TOOL, f.input, 'mcp_77', undefined,
      () => tool.execute('mcp_77', f.input, undefined)) };
}

it('asks once on the MCP root, so a denied dialog cannot be re-asked into a push', async () => {
  const f = await receiptRuntimeFixture('owner');
  // Deny, then approve. Asked twice, the first answer decides nothing and the
  // second one sends the action — which is exactly the defect.
  const root = mcpRoot(f, [{ action: 'decline' }, { action: 'accept', content: { confirm: true } }]);
  await expect(root.invoke()).rejects.toThrow('OWNER_CONFIRMATION_DECLINED');
  expect(root.asks).toHaveLength(1);
  // And the one dialog is the world route's own, not the seam's.
  expect(root.asks[0]).not.toContain('PopClaw world action:');
  expect(root.asks[0]).toContain('PopClaw: confirm world action');
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(0);
  expect(f.partition.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(0);
  expect(f.push).not.toHaveBeenCalled();
});

/** The control group: the same wiring, approved, really does execute — so the
 *  refusal above is the deny being obeyed and not a fixture that can never
 *  reach a push in the first place. */
it('control: one approval on the MCP root signs and pushes exactly one action', async () => {
  const f = await receiptRuntimeFixture('owner');
  const root = mcpRoot(f, [{ action: 'accept', content: { confirm: true } }]);
  const result = await root.invoke() as { structuredContent: { owner_confirmation_ref?: string } };
  expect(root.asks).toHaveLength(1);
  // The reference the owner read in that one dialog comes back on the receipt.
  expect(result.structuredContent.owner_confirmation_ref).toHaveLength(6);
  expect(f.partition.db.queryAll('SELECT * FROM world_owner_action_reservations')).toHaveLength(1);
  expect(f.push).toHaveBeenCalledOnce();
  // Nothing granted that nobody spent: the seam has no defect to report.
  expect(root.defects).toEqual([]);
});
