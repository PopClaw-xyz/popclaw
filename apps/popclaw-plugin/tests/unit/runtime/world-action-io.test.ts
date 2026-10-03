import { afterEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
import { HousePushError, HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import { createWorldActionIo } from '../../../src/runtime/world-action-io.js';
import { ACTION_SELECTION_PROFILE, WorldActionClient, type ActionSelectionEvidenceV1 } from '../../../src/world/action-client.js';
import { ACTION_RECEIPT_SCHEMA_FINGERPRINT, prepareActionReceiptJournal } from '../../../src/world/action-receipt-journal.js';
import { WorldOwnerActionAuthorityStore } from '../../../src/world/world-owner-action-authority.js';
import { canonicalWorldCore, worldSigningInput } from '../../../src/world/action-wire.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

const origin = 'https://world.invalid';
const actor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(81));
const authority = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(82));
const actorId = bs58.encode(actor.publicKey), keyId = bs58.encode(authority.publicKey);
const house = { origin, houseKey: keyId, incarnation: 'inc_1' };
const caps: TrustedWorldCapabilities = { house, capabilityRevision: 'a'.repeat(64), guide: 'Bound guide', manifest: {
  house_session: {version: 1, endpoint: '/v1/house-session', ack_pubkey: Buffer.from(authority.publicKey).toString('hex'), operations: ['enter', 'renew', 'leave']},
  world_interaction: {version: 1, actions: {status_endpoint: '/v1/world-actions/status', result_authority_pubkey: keyId, kinds: ['test.act'], attachments: []},
    guide: {path: '/v1/guide.md', sha256: cidFromCanonical(new TextEncoder().encode('Bound guide')), revision: 'g1'}},
  intent_kinds: [{kind: 'test.act', schema_version: 1, transport: 'house', signer: 'user', description: 'Test action',
    result_attachments: {allowed: [], required_on_success: []}, consistency: 'none', params_schema: {type: 'object'}, result_schema: {type: 'object'}}],
} };
const manifestBytes = new TextEncoder().encode(JSON.stringify(caps.manifest));
Object.assign(caps, {capabilityRevision: cidFromCanonical(manifestBytes)});
const proofCore = {house, manifestDigest: caps.capabilityRevision, signedAt: 900};
const proofBytes = canonicalWorldCore(popclaw.world.ManifestProof, {...proofCore,
  authoritySignature: nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1', canonicalWorldCore(popclaw.world.ManifestProof, proofCore)), authority.secretKey)});
const selection: ActionSelectionEvidenceV1 = {profile: ACTION_SELECTION_PROFILE, house, actorId,
  capabilityRevision: caps.capabilityRevision, manifestBytes, proofBytes,
  guideBytes: new TextEncoder().encode(caps.guide), guideDigest: cidFromCanonical(new TextEncoder().encode(caps.guide)),
  kind: 'test.act', schemaVersion: 1, resultAuthorityKey: keyId, paramsSchema: {type: 'object'}, resultSchema: {type: 'object'},
  allowed: [], requiredOnSuccess: [], consistency: 'none'};
const partition = {origin, actorId, storeId: 'action-io-execution-store', layoutVersion: 1 as const};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function protobuf(bytes: Uint8Array = new Uint8Array([0, 255, 3])) {
  return new Response(new Uint8Array(bytes), {headers: {'content-type': 'application/x-protobuf'}});
}
async function fixture() {
  // Keep actual SQLite host/session state separate from the execution partition.
  const hostDb = new InMemoryHostDb(), db = new InMemoryHostDb();
  const signer = new MasterKeySigner({...actor, seed: actor.secretKey.slice(0, 32), popclawId: actorId});
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => protobuf());
  const runtime = new HouseRuntime({readAuthorityFor: refusingReadAuthorityFor, db: hostDb, signer, origins: ['https://home.invalid', origin], fetch, clock: () => 1_000_000});
  cleanup.push(async () => { await runtime.stop(); db.close(); hostDb.close(); });
  hostDb.execute(`INSERT INTO house_participation(house_origin, installation_id, op_seq, desired, phase,
    session_id, house_revision, lease_expires_at, ack_key_hex) VALUES(?, 'install_1', 3, 'enabled', 'connected', 'session_1', 17, 1200, ?)`, [origin, 'ab'.repeat(32)]);
  db.execute('CREATE TABLE execution_partition_identity_v1(singleton INTEGER PRIMARY KEY,actor_id TEXT,origin TEXT,store_id TEXT,layout_version INTEGER)');
  db.execute('INSERT INTO execution_partition_identity_v1 VALUES(1,?,?,?,1)', [actorId, origin, partition.storeId]);
  prepareActionReceiptJournal({executionDb: db, expectedPartition: partition, expectedSchemaFingerprint: ACTION_RECEIPT_SCHEMA_FINGERPRINT});
  const knownRequest = vi.fn((id: string) => { client.view(id); return true; });
  const io = createWorldActionIo({runtime, origin, knownRequest, statusTimeoutMs: 20});
  const captureSelectedActionContext = () => ({evidence: selection, assertCurrent() {
    if (!io.captureSession().gate.isActive()) throw new Error('ACTION_GATE_CLOSED');
  }});
  const store = new WorldOwnerActionAuthorityStore({db, house, actorId, expectedPartition: partition, captureSelectedActionContext, now: () => 1000});
  const client = new WorldActionClient({db, signer, actorId, house, expectedPartition: partition, captureSelectedActionContext,
    accounting: {assertCurrent() {}, settle: store.settleOriginal.bind(store)}, capabilities: () => caps, ...io, now: () => 1000});
  const input = {house: origin, kind: 'test.act', params: {}, expected_capability_revision: caps.capabilityRevision};
  const permission = store.reserve({jobId: 'action-io-fixture', input, expiresAt: 1200});
  const executionReference = permission.executionReference;
  // Only the external bus transport is replaced. Signing, authorization,
  // journal schema and request/reservation association use production code.
  const push = vi.spyOn(runtime.egress, 'pushTo').mockResolvedValue({status: 200});
  const created = await client.invoke(input, permission);
  const binding = JSON.stringify([origin, keyId, 'inc_1', actorId]);
  const requestId = created.request_id;
  const row = db.queryOne<{request_bytes: Uint8Array; request_digest: string; receipt_profile: string}>('SELECT request_bytes,request_digest,receipt_profile FROM world_action_client_requests WHERE binding=? AND request_id=?', [binding, requestId])!;
  expect(row.receipt_profile).toBe('public-envelope-01.3-action-v1');
  expect(row.request_digest).toBe(cidFromCanonical(row.request_bytes));
  expect(store.reservations()[0]!.request_id).toBe(requestId);
  expect(hostDb.queryOne("SELECT name FROM sqlite_master WHERE name='world_action_client_requests'")).toBeNull();
  const signed = {eventId: requestId, signedPayloadBytes: new Uint8Array(row.request_bytes)};
  const statusBytes = popclaw.world.ActionStatusRequest.encode({house, actorId, requestId, nonce: 'fixed-nonce', issuedAt: 1000, expiresAt: 1060, signature: new Uint8Array([11, 12])}).finish();
  const disable = () => hostDb.execute("UPDATE house_participation SET desired='disabled',phase='disconnected',op_seq=op_seq+1 WHERE house_origin=?", [origin]);
  push.mockClear(); knownRequest.mockClear();
  return {db, hostDb, runtime, client, store, io, signer, fetch, knownRequest, push, disable, requestId, statusBytes, signed, binding, executionReference};
}

describe('actual world action runtime I/O', () => {
  it('reconciles a real locally known request while disabled without sending or claiming an owner', async () => {
    const f = await fixture(); f.disable();
    expect(f.client.view(f.requestId).status).toBe('unknown');
    const result = popclaw.world.ActionResult.fromObject({house, actorId, audienceId: actorId, requestId: f.requestId,
      requestDigest: cidFromCanonical(popclaw.identity.SignedPayload.decode(f.signed.signedPayloadBytes).payload), kind: 'test.act', schemaVersion: 1,
      capabilityRevision: caps.capabilityRevision, status: 1, statusRevision: '1', code: 'ACCEPTED'});
    const signature = nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_ACTION_RESULT_V1', canonicalWorldCore(popclaw.world.ActionResult, result)), authority.secretKey);
    f.fetch.mockImplementation(async (_url, init) => {
      const query = popclaw.world.ActionStatusRequest.decode(new Uint8Array(init!.body as Uint8Array));
      expect(query.requestId).toBe(f.requestId);
      expect(nacl.sign.detached.verify(worldSigningInput('POPCLAW_WORLD_ACTION_STATUS_READ_V1', canonicalWorldCore(popclaw.world.ActionStatusRequest, {...query, signature: undefined})), query.signature, actor.publicKey)).toBe(true);
      return protobuf(canonicalWorldCore(popclaw.world.ActionStatusResponse, {result: {result, signature}}));
    });
    expect(await f.runtime.runCommand(() => f.client.status(f.requestId))).toMatchObject({status: 'accepted', code: 'ACCEPTED'});
    expect(f.client.view(f.requestId)).toMatchObject({status: 'accepted', receipt_durable: true,
      base_accounting: {state: 'not_terminal'}});
    // Pending now means terminal accounting work, not an aggregate legacy consumer.
    expect(f.client.hasPending()).toBe(false);
    expect(f.db.queryAll('SELECT * FROM world_action_client_results WHERE request_id=?', [f.requestId])).toHaveLength(1);
    expect(f.db.queryAll('SELECT * FROM world_action_client_evidence WHERE request_id=?', [f.requestId])).toHaveLength(1);
    expect(f.store.reservations()[0]).toMatchObject({request_id: f.requestId, status: 'reserved'});
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.push).not.toHaveBeenCalled();
    expect(f.runtime.resident.authority.captureEpoch()).toBeNull();
    expect(f.hostDb.queryAll('SELECT * FROM house_lifecycle_commands')).toEqual([]);
    expect(() => f.io.captureSession()).toThrow();
  });

  it('uses only the fixed same-origin status endpoint and snapshots protobuf before awaiting', async () => {
    const f = await fixture(); f.disable(); const held = deferred<Response>();
    f.fetch.mockReturnValue(held.promise);
    const gate = f.io.controlRead(f.requestId), bytes = new Uint8Array(f.statusBytes), expected = new Uint8Array(bytes);
    const reading = f.io.readStatus(bytes, {gate, requestId: f.requestId});
    bytes.fill(0);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe(`${origin}/v1/world-actions/status`);
    expect(init).toMatchObject({method: 'POST', redirect: 'error', credentials: 'omit', headers: {'Content-Type': 'application/x-protobuf'}});
    expect(Array.from(init!.body as Uint8Array)).toEqual(Array.from(expected));
    const response = new Uint8Array([0, 255, 3]); held.resolve(protobuf(response));
    expect(await reading).toEqual(response); expect(f.push).not.toHaveBeenCalled();
  });

  it('does not let a disabled business AsyncLocalStorage gate close a known-request control read', async () => {
    const f = await fixture(); const business = f.io.captureSession().gate; const hold = deferred<void>();
    // Enter while live, then invalidate before continuing the captured command.
    const reading = withAction(business, async () => {
      await hold.promise;
      const gate = f.io.controlRead(f.requestId);
      expect(gate.isActive()).toBe(true);
      expect(await f.io.readStatus(f.statusBytes, {gate, requestId: f.requestId})).toEqual(new Uint8Array([0, 255, 3]));
    });
    f.disable(); hold.resolve(); await reading;
  });

  it('rejects unknown, malformed and another binding\'s request before any fetch', async () => {
    const f = await fixture();
    expect(() => f.io.controlRead('bad')).toThrow();
    expect(() => f.io.controlRead('b'.repeat(64))).toThrow('REQUEST_NOT_KNOWN');
    for (const binding of [
      ['https://foreign.invalid', keyId, 'inc_1', actorId],
      [origin, keyId, 'inc_1', keyId],
      [origin, keyId, 'foreign_incarnation', actorId],
    ]) {
      f.db.execute('UPDATE world_action_client_requests SET binding=? WHERE request_id=?', [JSON.stringify(binding), f.requestId]);
      expect(() => f.io.controlRead(f.requestId)).toThrow('REQUEST_NOT_KNOWN');
    }
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
  });

  it('rejects unknown origins, forged gates, cross-request gates and wire/request mismatches without fetching', async () => {
    const f = await fixture(); const gate = f.io.controlRead(f.requestId);
    expect(() => f.runtime.captureKnownActionReadGate('https://foreign.invalid', f.requestId, f.knownRequest)).toThrow();
    await expect(f.io.readStatus(f.statusBytes, {gate: {...gate}, requestId: f.requestId})).rejects.toThrow();
    await expect(f.io.readStatus(f.statusBytes, {gate, requestId: 'b'.repeat(64)})).rejects.toThrow();
    const mismatched = popclaw.world.ActionStatusRequest.encode({house: {...house, origin: 'https://foreign.invalid'}, requestId: f.requestId}).finish();
    await expect(f.io.readStatus(mismatched, {gate, requestId: f.requestId})).rejects.toThrow();
    const wrongRequest = popclaw.world.ActionStatusRequest.encode({house, requestId: 'b'.repeat(64)}).finish();
    await expect(f.io.readStatus(wrongRequest, {gate, requestId: f.requestId})).rejects.toThrow();
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('rechecks known-request authorization after asynchronous transport and preserves database failures', async () => {
    const f = await fixture(); const held = deferred<Response>(); f.fetch.mockReturnValue(held.promise);
    const reading = f.io.readStatus(f.statusBytes, {gate: f.io.controlRead(f.requestId), requestId: f.requestId});
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    f.db.execute('DELETE FROM world_action_client_requests WHERE request_id=?', [f.requestId]); held.resolve(protobuf());
    await expect(reading).rejects.toThrow('REQUEST_NOT_KNOWN');
    const unavailable = new Error('known-request database unavailable'); f.knownRequest.mockImplementation(() => { throw unavailable; });
    expect(() => f.io.controlRead(f.requestId)).toThrow(unavailable);
  });

  it.each(['redirect', 'foreign-url', 'same-origin-redirect', 'wrong-content-type', 'http-error'] as const)('rejects %s without retrying or treating it as an unknown business result', async mode => {
    const f = await fixture();
    const response = mode === 'redirect' ? new Response(null, {status: 307, headers: {location: 'https://foreign.invalid/status'}})
      : mode === 'wrong-content-type' ? new Response('{}', {headers: {'content-type': 'application/json'}})
      : mode === 'http-error' ? new Response('{"code":"REQUEST_FORBIDDEN"}', {status: 403}) : protobuf();
    if (mode === 'foreign-url') Object.defineProperty(response, 'url', {value: 'https://foreign.invalid/v1/world-actions/status'});
    if (mode === 'same-origin-redirect') Object.defineProperty(response, 'redirected', {value: true});
    f.fetch.mockResolvedValue(response);
    await expect(f.io.readStatus(f.statusBytes, {gate: f.io.controlRead(f.requestId), requestId: f.requestId})).rejects.toThrow();
    expect(f.fetch).toHaveBeenCalledOnce(); expect(f.push).not.toHaveBeenCalled();
  });

  it.each(['declared', 'streamed'] as const)('enforces the one-MiB response cap when %s', async mode => {
    const f = await fixture(); const cancelled = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({start(controller) { if (mode === 'streamed') { controller.enqueue(new Uint8Array(700_000)); controller.enqueue(new Uint8Array(400_000)); } }, cancel: cancelled}),
      {headers: {'content-type': 'application/x-protobuf', ...(mode === 'declared' ? {'content-length': '1048577'} : {})}});
    f.fetch.mockResolvedValue(response);
    await expect(f.io.readStatus(f.statusBytes, {gate: f.io.controlRead(f.requestId), requestId: f.requestId})).rejects.toThrow(/limit|MiB|SIZE/i);
    expect(cancelled).toHaveBeenCalled();
  });

  it('accepts an exact one-MiB response without transforming the bytes', async () => {
    const f = await fixture(); const bytes = new Uint8Array(1_048_576).fill(131); f.fetch.mockResolvedValue(protobuf(bytes));
    const received = await f.io.readStatus(f.statusBytes, {gate: f.io.controlRead(f.requestId), requestId: f.requestId});
    expect(received.byteLength).toBe(bytes.byteLength); expect(received.every(byte => byte === 131)).toBe(true);
  });

  it('times out a stalled response body and cancels the reader', async () => {
    const f = await fixture(); vi.useFakeTimers(); const cancelled = vi.fn();
    f.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({cancel: cancelled}), {headers: {'content-type': 'application/x-protobuf'}}));
    const reading = f.io.readStatus(f.statusBytes, {gate: f.io.controlRead(f.requestId), requestId: f.requestId});
    const failure = expect(reading).rejects.toThrow(/time|abort/i);
    await vi.advanceTimersByTimeAsync(21); await failure; expect(cancelled).toHaveBeenCalled();
  });

  it('uses a ten-second default covering a stalled fetch without retrying', async () => {
    const f = await fixture(); vi.useFakeTimers();
    const io = createWorldActionIo({runtime: f.runtime, origin, knownRequest: f.knownRequest});
    f.fetch.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {once: true});
    }));
    const reading = io.readStatus(f.statusBytes, {gate: io.controlRead(f.requestId), requestId: f.requestId});
    const failure = expect(reading).rejects.toThrow(/time|abort/i);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await failure;
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it('requires a true local-known-request decision and validates configured timeout bounds', async () => {
    const f = await fixture(); f.knownRequest.mockReturnValue(false);
    expect(() => f.io.controlRead(f.requestId)).toThrow('HOUSE_ACTION_READ_NOT_AUTHORIZED');
    for (const statusTimeoutMs of [0, -1, 1.5, 60001, Number.NaN]) {
      expect(() => createWorldActionIo({runtime: f.runtime, origin, knownRequest: f.knownRequest, statusTimeoutMs})).toThrow('ACTION_STATUS_TIMEOUT_INVALID');
    }
    expect(f.fetch).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
  });

  it('runtime.stop immediately aborts reads and still joins a configured fetch that settles late', async () => {
    const f = await fixture(); const held = deferred<Response>(); f.fetch.mockReturnValue(held.promise);
    const gate = f.io.controlRead(f.requestId);
    const reading = f.io.readStatus(f.statusBytes, {gate, requestId: f.requestId});
    const failure = expect(reading).rejects.toThrow();
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledOnce());
    let stopped = false; const stopping = f.runtime.stop().then(() => { stopped = true; });
    expect(gate.signal.aborted).toBe(true); expect(gate.isActive()).toBe(false);
    expect(f.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    await Promise.resolve(); await Promise.resolve(); expect(stopped).toBe(false);
    held.resolve(protobuf()); await failure; await stopping;
    expect(stopped).toBe(true); expect(f.push).not.toHaveBeenCalled();
    const query = vi.spyOn(f.db, 'queryOne'); expect(gate.isActive()).toBe(false); expect(query).not.toHaveBeenCalled();
    expect(() => f.io.controlRead(f.requestId)).toThrow('HOUSE_RUNTIME_STOPPED');
  });

  it('sends a snapshot through the actual selected bus egress seam and preserves the receipt object', async () => {
    const f = await fixture(); const held = deferred<{status: number; signedActionResultBase64: string}>(); f.push.mockReturnValue(held.promise);
    const gate = f.io.captureSession().gate, bytes = new Uint8Array([1, 0, 255]);
    const sending = f.io.push(bytes, {gate, requestId: f.requestId, executionReference: f.executionReference}); bytes.fill(9);
    expect(f.push).toHaveBeenCalledWith(hostDbSlug(origin), new Uint8Array([1, 0, 255]));
    const receipt = {status: 200, signedActionResultBase64: 'AP8D'}; held.resolve(receipt);
    expect(await sending).toBe(receipt); expect(f.fetch).not.toHaveBeenCalled();
  });

  it('passes the exact action reference through the existing runtime effect scope', async () => {
    const f = await fixture(), scoped = vi.spyOn(f.runtime, 'withPushEffect');
    const gate = f.io.captureSession().gate;
    await f.io.push(new Uint8Array([1]), {gate, requestId: f.requestId, executionReference: f.executionReference});
    expect(scoped).toHaveBeenCalledWith(origin, {version: 1, kind: 'world_intent', requestId: f.requestId, executionReference: f.executionReference}, expect.any(Function));
  });

  it('keeps the original HousePushError including its opaque signed receipt', async () => {
    const f = await fixture(); const error = new HousePushError({status: 409, state: 'done', operationId: 'original-op', signedActionResultBase64: 'AP8D', detail: 'original-error'});
    f.push.mockRejectedValue(error);
    await expect(f.io.push(new Uint8Array([1]), {gate: f.io.captureSession().gate, requestId: f.requestId, executionReference: f.executionReference})).rejects.toBe(error);
  });

  it('rejects control/foreign/expired gates before egress and rejects a receipt after the captured session changes', async () => {
    const f = await fixture(); const session = f.io.captureSession(); const control = f.io.controlRead(f.requestId);
    await expect(f.io.push(new Uint8Array([1]), {gate: control, requestId: f.requestId, executionReference: f.executionReference})).rejects.toThrow();
    await expect(f.io.push(new Uint8Array([1]), {gate: {...session.gate, origin: 'https://foreign.invalid'}, requestId: f.requestId, executionReference: f.executionReference})).rejects.toThrow();
    expect(f.push).not.toHaveBeenCalled();
    const held = deferred<{status: number}>(); f.push.mockReturnValue(held.promise);
    const sending = f.io.push(new Uint8Array([1]), {gate: session.gate, requestId: f.requestId, executionReference: f.executionReference});
    f.disable(); held.resolve({status: 200}); await expect(sending).rejects.toThrow();
    await expect(f.io.push(new Uint8Array([1]), {gate: session.gate, requestId: f.requestId, executionReference: f.executionReference})).rejects.toThrow();
    expect(f.push).toHaveBeenCalledOnce();
  });
});
