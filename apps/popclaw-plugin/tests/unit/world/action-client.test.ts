import { afterEach, describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { WorldActionClient, ACTION_SELECTION_PROFILE, copyActionSelectionEvidence, type ActionSelectionEvidenceV1, type WorldActionClientOptions, type WorldActionAuthority } from '../../../src/world/action-client.js';
import { canonicalWorldCore, worldSigningInput } from '../../../src/world/action-wire.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';

import { WorldNativeActionAuthorityStore } from '../../../src/world/world-native-action-authority.js';
import { WorldOwnerActionAuthorityStore } from '../../../src/world/world-owner-action-authority.js';
import { prepareActionReceiptJournal, ACTION_RECEIPT_SCHEMA_FINGERPRINT } from '../../../src/world/action-receipt-journal.js';
const actor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(71));
const authorityKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(72));
const actorId = bs58.encode(actor.publicKey), keyId = bs58.encode(authorityKey.publicKey);
const house = { origin: 'https://world.invalid', houseKey: keyId, incarnation: 'inc_1' };
const caps: TrustedWorldCapabilities = { house, capabilityRevision: 'a'.repeat(64), guide: 'Bound guide', manifest: {
  house_session: {version:1,endpoint:'/v1/house-session',ack_pubkey:Buffer.from(authorityKey.publicKey).toString('hex'),operations:['enter','renew','leave']},
  world_interaction: { version:1,actions:{status_endpoint:'/v1/world-actions/status',result_authority_pubkey:keyId,kinds:['test.act'],attachments:[]},guide:{path:'/v1/guide.md',sha256:cidFromCanonical(new TextEncoder().encode('Bound guide')),revision:'g1'} },
  intent_kinds: [{ kind: 'test.act', schema_version: 1, transport:'house',signer:'user',description:'Test action',result_attachments:{allowed:[],required_on_success:[]},consistency:'none', params_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    result_schema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'], additionalProperties: false } }],
  event_kinds: [{ kind: 'test.state', schema_version: 1, body_schema: { type: 'object' } }],
} };
const manifestBytes = new TextEncoder().encode(JSON.stringify(caps.manifest));
Object.assign(caps,{capabilityRevision:cidFromCanonical(manifestBytes)});
const proofCore = {house,manifestDigest:caps.capabilityRevision,signedAt:900};
const proofBytes = canonicalWorldCore(popclaw.world.ManifestProof,{...proofCore,authoritySignature:nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1',canonicalWorldCore(popclaw.world.ManifestProof,proofCore)),authorityKey.secretKey)});
const kindRow = (caps.manifest.intent_kinds as Record<string,unknown>[])[0]!;
const selection: ActionSelectionEvidenceV1 = {profile:ACTION_SELECTION_PROFILE,house,actorId,capabilityRevision:caps.capabilityRevision,manifestBytes,proofBytes,guideBytes:new TextEncoder().encode(caps.guide),guideDigest:cidFromCanonical(new TextEncoder().encode(caps.guide)),kind:'test.act',schemaVersion:1,resultAuthorityKey:keyId,paramsSchema:kindRow.params_schema as Record<string,unknown>,resultSchema:kindRow.result_schema as Record<string,unknown>,allowed:[],requiredOnSuccess:[],consistency:'none'};
const partition = {origin:house.origin,actorId,storeId:'test-store',layoutVersion:1 as const};
const input = { house: house.origin, kind: 'test.act', params: { text: 'hello' }, expected_capability_revision: caps.capabilityRevision };
const dbs: HostDb[] = [], dirs: string[] = [];
const utf8 = new TextEncoder();
function fixture(overrides: Partial<WorldActionClientOptions> = {}) {
  const db = overrides.db ?? new InMemoryHostDb(); if (!overrides.db) dbs.push(db);
  const abort = new AbortController(), control = new AbortController();
  const gate = { origin: house.origin, signal: abort.signal, isActive: () => !abort.signal.aborted };
  const controlGate = { origin: house.origin, signal: control.signal, isActive: () => !control.signal.aborted };
  const signer = new MasterKeySigner({ ...actor, seed: actor.secretKey.slice(0, 32), popclawId: actorId });
  const push = vi.fn(async (_bytes: Uint8Array) => ({}));
  const onResult = vi.fn();
  if (!db.queryOne("SELECT 1 FROM sqlite_master WHERE name='execution_partition_identity_v1'")) {
    db.execute('CREATE TABLE execution_partition_identity_v1(singleton INTEGER PRIMARY KEY,actor_id TEXT,origin TEXT,store_id TEXT,layout_version INTEGER)');
    db.execute('INSERT INTO execution_partition_identity_v1 VALUES(1,?,?,?,1)',[actorId,house.origin,partition.storeId]);
    prepareActionReceiptJournal({executionDb:db,expectedPartition:partition,expectedSchemaFingerprint:ACTION_RECEIPT_SCHEMA_FINGERPRINT});
  }
  const captureSelectedActionContext = () => ({evidence:selection,assertCurrent() {if (abort.signal.aborted) throw new Error('ACTION_GATE_CLOSED');}});
  const store = new WorldOwnerActionAuthorityStore({db,house,actorId,expectedPartition:partition,captureSelectedActionContext,now:()=>1000});
  const original = store.reserve({jobId:'test-job',input,expiresAt:1250});
  const permission: WorldActionAuthority = {...original,check:vi.fn(original.check),record:vi.fn(original.record)};
  const accounting = {assertCurrent() {},settle:vi.fn(store.settleOriginal.bind(store))};
  const options: WorldActionClientOptions = { db, signer, actorId, house, expectedPartition:partition,captureSelectedActionContext,accounting,capabilities: () => caps, now: () => 1000,
    captureSession: () => ({ gate, sessionId: 'session_1', fence: '3', leaseExpiresAt: 1200, installationId: 'install_1' }),
    push, controlRead: () => controlGate, readStatus: vi.fn(), onResult, ...overrides };
  return { db, abort, control, gate, controlGate, signer, push, onResult, permission, options, store, accounting, client: new WorldActionClient(options) };
}
function signedResult(requestBytes: Uint8Array, changes: Record<string, unknown> = {}, key = authorityKey): Uint8Array {
  const env = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(requestBytes).payload);
  const c = env.intent!.context!;
  const result = popclaw.world.ActionResult.fromObject({ house, actorId, audienceId: actorId, requestId: env.eventId,
    requestDigest: cidFromCanonical(popclaw.identity.SignedPayload.decode(requestBytes).payload), kind: env.intent!.intentKind, schemaVersion: c.schemaVersion,
    capabilityRevision: c.capabilityRevision, status: 1, statusRevision: '9007199254740993', code: 'ACCEPTED', ...changes });
  const signature = nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_ACTION_RESULT_V1', canonicalWorldCore(popclaw.world.ActionResult, result)), key.secretKey);
  return canonicalWorldCore(popclaw.world.SignedActionResult,{ result, signature });
}
function lastBytes(f: ReturnType<typeof fixture>): Uint8Array { return f.push.mock.calls.at(-1)![0]; }
function terminal(extra: Record<string, unknown> = {}) {
  const resultBody = utf8.encode('{"done":true}');
  return { status: 3, statusRevision: '9007199254740995', executionId: 'execution_1', code: 'OK', committedAt: '1001', resultBody, resultDigest: cidFromCanonical(resultBody), ...extra };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); dbs.splice(0).forEach(db => db.close()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('selected-row jurisdiction in action evidence', () => {
  function evidenceFor(edit: (document: any) => void, serialize: (text: string) => string = text => text): ActionSelectionEvidenceV1 {
    const document = JSON.parse(JSON.stringify(caps.manifest));
    edit(document);
    const bytes = utf8.encode(serialize(JSON.stringify(document)));
    const core = { house, manifestDigest: cidFromCanonical(bytes), signedAt: 900 };
    const proof = canonicalWorldCore(popclaw.world.ManifestProof, { ...core, authoritySignature: nacl.sign.detached(
      worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1', canonicalWorldCore(popclaw.world.ManifestProof, core)), authorityKey.secretKey) });
    return { ...selection, manifestBytes: bytes, proofBytes: proof, capabilityRevision: core.manifestDigest };
  }
  // The sibling is shaped like the running world House's rows: payload under
  // the legacy member name, past the business depth, larger than a selected
  // schema may be. The board selects neither, so it pays and escapes nothing.
  const legacySibling = (document: any) => document.intent_kinds.push({ kind: 'world.pack_and_travel', schema_version: 1,
    transport: 'typed', signer: 'user', description: 'y'.repeat(40000),
    schema: { $defs: { figure: { properties: { ref: { properties: { deep: { properties: { deeper: { type: 'string' } } } } } } } } } });
  it('copies evidence for a selected kind while an unselected sibling carries an oversized deep schema', () => {
    const owned = copyActionSelectionEvidence(evidenceFor(legacySibling));
    expect(owned.kind).toBe('test.act');
    expect(owned.paramsSchema).toEqual(kindRow.params_schema);
  });
  it('refuses the selected kind when its own original schema bytes exceed the bound', () => {
    expect(() => copyActionSelectionEvidence(evidenceFor(legacySibling,
      text => text.replace('"params_schema":{', '"params_schema":{' + ' '.repeat(32768))))).toThrow('SCHEMA_SIZE_LIMIT');
  });
});

describe('WorldActionClient durable authority', () => {
  it.each(['response', 'typed_error'] as const)('preserves an original signed receipt after execution revocation (%s)', async source => {
    const f = fixture(), originalCheck = f.permission.check;
    let revoked = false;
    f.permission.check = attempt => {
      if (revoked) throw new Error('TEST_EXECUTION_AUTHORITY_REVOKED');
      originalCheck(attempt);
    };
    f.push.mockImplementation(async bytes => {
      const result = { signedActionResultBase64: Buffer.from(signedResult(bytes, terminal())).toString('base64') };
      revoked = true;
      if (source === 'typed_error') throw Object.assign(new Error('REMOTE_RESULT'), { result });
      return result;
    });
    const view = await f.client.invoke(input, f.permission);
    expect(revoked).toBe(true);
    expect(f.permission.executionReference.kind).toBe('owner_action');
    expect(f.push).toHaveBeenCalledTimes(1);
    expect(f.db.queryAll('SELECT * FROM world_action_client_results')).toHaveLength(1);
    expect(f.db.queryAll('SELECT * FROM world_action_client_evidence')).toHaveLength(1);
    expect(view.base_accounting?.state).toBe('applied');
    expect(f.store.reservations()[0]!.status).toBe('succeeded');
  });

  it('keeps the storage gate closed after a response arrives', async () => {
    const f = fixture();
    f.push.mockImplementation(async bytes => {
      const raw = signedResult(bytes, terminal()); f.abort.abort();
      return { signedActionResultBase64: Buffer.from(raw).toString('base64') };
    });
    await expect(f.client.invoke(input, f.permission)).rejects.toThrow('ACTION_GATE_CLOSED');
    expect(f.db.queryAll('SELECT * FROM world_action_client_results')).toHaveLength(0);
    expect(f.store.reservations()[0]!.status).toBe('reserved');
  });

  it('persists a returned receipt while the original accounting hold blocks settlement', async () => {
    const f = fixture();
    f.push.mockImplementation(async bytes => {
      f.accounting.assertCurrent = () => { throw new Error('ACCOUNTING_HOLD'); };
      return { signedActionResultBase64: Buffer.from(signedResult(bytes, terminal())).toString('base64') };
    });
    const view = await f.client.invoke(input, f.permission);
    expect(view.receipt_durable).toBe(true);
    expect(view.base_accounting?.state).toBe('pending');
    expect(f.accounting.settle).not.toHaveBeenCalled();
    expect(f.store.reservations()[0]!.status).toBe('reserved');
  });

  it('still authenticates a returned receipt after execution revocation', async () => {
    const f = fixture();
    f.push.mockImplementation(async bytes => {
      f.permission.check = () => { throw new Error('TEST_EXECUTION_AUTHORITY_REVOKED'); };
      return { signedActionResultBase64: Buffer.from(signedResult(bytes, terminal(), actor)).toString('base64') };
    });
    await expect(f.client.invoke(input, f.permission)).rejects.toThrow('RESULT_SIGNATURE_INVALID');
    expect(f.db.queryAll('SELECT * FROM world_action_client_results')).toHaveLength(0);
    expect(f.store.reservations()[0]!.status).toBe('reserved');
  });

  it('checks the actual client binding and fixed input before signing and exact retry egress', async () => {
    const f = fixture(), sign = vi.spyOn(f.signer, 'sign');
    f.permission.assertBinding = (db, binding, id) => { expect(db).toBe(f.db); expect(binding).toEqual(house); expect(id).toBe(actorId); };
    f.permission.assertInput = incoming => { if (incoming.params.text !== 'hello') throw new Error('OWNER_INPUT_MISMATCH'); incoming.params.text = 'mutated by hook'; };
    await expect(f.client.invoke({ ...input, params: { text: 'wrong' } }, f.permission)).rejects.toThrow('OWNER_INPUT_MISMATCH');
    expect(sign).not.toHaveBeenCalled();
    const request = await f.client.invoke(input, f.permission);
    expect(popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(lastBytes(f)).payload).intent?.params).toEqual(utf8.encode('{"text":"hello"}'));
    f.permission.assertBinding = () => { throw new Error('OWNER_BINDING_MISMATCH'); };
    await expect(f.client.retry(request.request_id, f.permission)).rejects.toThrow('OWNER_BINDING_MISMATCH'); expect(f.push).toHaveBeenCalledOnce();
    f.permission.assertBinding = undefined; f.permission.assertInput = () => { throw new Error('OWNER_INPUT_MISMATCH'); };
    await expect(f.client.retry(request.request_id, f.permission)).rejects.toThrow('OWNER_INPUT_MISMATCH'); expect(f.push).toHaveBeenCalledOnce();
  });
  it('persists the exact signed request and atomic reservation link before egress; injects captured context', async () => {
    const f = fixture();
    const record = f.permission.record; f.permission.record = (tx, id) => { expect(tx.queryOne('SELECT request_id FROM world_action_client_requests WHERE request_id=?', [id])).toBeTruthy(); record(tx,id); };
    f.push.mockImplementation(async bytes => {
      const saved = f.db.queryOne<{ request_bytes: Uint8Array }>('SELECT request_bytes FROM world_action_client_requests')!;
      expect([...saved.request_bytes]).toEqual([...bytes]);
      const outer = popclaw.identity.SignedPayload.decode(bytes), env = popclaw.event.EventEnvelope.decode(outer.payload);
      expect(nacl.sign.detached.verify(outer.payload, outer.signature, actor.publicKey)).toBe(true);
      const canonical = canonicalizeEnvelope(env);
      expect(nacl.sign.detached.verify(canonical, env.signature, actor.publicKey)).toBe(true);
      expect(cidFromCanonical(canonical)).toBe(env.eventId);
      expect(env.intent?.context).toMatchObject({ houseOrigin: house.origin, houseKey: keyId, incarnation: 'inc_1', sessionId: 'session_1', fence: '3', capabilityRevision: caps.capabilityRevision, schemaVersion: 1 });
      expect(env.intent?.context?.validUntil?.toString()).toBe('1200');
      return { signedActionResultBase64: Buffer.from(signedResult(bytes)).toString('base64') };
    });
    expect(await f.client.invoke(input, f.permission)).toMatchObject({ status: 'accepted', code: 'ACCEPTED' });
    expect(f.onResult).not.toHaveBeenCalled();
    expect(f.permission.check).toHaveBeenCalled();
  });
  it('rolls back request insertion if reservation association fails and never sends', async () => {
    const f = fixture(); f.permission.record = () => { throw new Error('reservation failed'); };
    await expect(f.client.invoke(input, f.permission)).rejects.toThrow('reservation failed');
    expect(f.db.queryAll('SELECT * FROM world_action_client_requests')).toEqual([]); expect(f.push).not.toHaveBeenCalled();
  });
  it('keeps unknown reservations and reuses same-second CID rather than minting a nonce', async () => {
    const f = fixture();
    const first = await f.client.invoke(input, f.permission), second = await f.client.invoke(input, f.permission);
    expect(second.request_id).toBe(first.request_id);
    expect(f.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(1);
    const correctedInput = { ...input, params: { text: 'corrected' } };
    const corrected = await f.client.invoke(correctedInput, f.store.reserve({jobId:'corrected',input:correctedInput,expiresAt:1250}), first.request_id);
    expect(corrected.request_id).not.toBe(first.request_id);
    expect(f.db.queryOne<{ replacement_of: string }>('SELECT replacement_of FROM world_action_client_requests WHERE request_id=?', [corrected.request_id])!.replacement_of).toBe(first.request_id);
  });
  it('rejects missing authority, model context injection, stale revision, unknown kind, and invalid params before signing', async () => {
    const f = fixture(), sign = vi.spyOn(f.signer, 'sign');
    await expect(f.client.invoke(input, undefined as unknown as WorldActionAuthority)).rejects.toThrow('ACTION_AUTHORITY_REQUIRED');
    for (const bad of [{ ...input, context: {} }, { ...input, expected_capability_revision: 'b'.repeat(64) }, { ...input, kind: 'test.other' }, { ...input, params: { text: 42 } }, { ...input, params: { text: 'x'.repeat(16384) } }]) {
      await expect(f.client.invoke(bad, f.permission)).rejects.toThrow();
    }
    expect(sign).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
  });
  it('fences every asynchronous signature stage and commits nothing after logout', async () => {
    const f = fixture(), original = f.signer.sign.bind(f.signer);
    vi.spyOn(f.signer, 'sign').mockImplementation(async bytes => { const sig = await original(bytes); f.abort.abort(); return sig; });
    await expect(f.client.invoke(input, f.permission)).rejects.toThrow('ACTION_GATE_CLOSED');
    expect(f.push).not.toHaveBeenCalled(); expect(f.db.queryAll('SELECT * FROM world_action_client_requests')).toEqual([]);
  });
  it('rechecks permission after signing and before sending; no expiry extension on renewal', async () => {
    let now = 1000;
    const f = fixture({ now: () => now });
    const request = await f.client.invoke(input, f.permission);
    now = 1200;
    await expect(f.client.retry(request.request_id, f.permission)).rejects.toThrow('ACTION_EXPIRED');
    expect(f.push).toHaveBeenCalledOnce();
  });
});

describe('authenticated action results', () => {
  it('rejects untrusted signature, body/schema tampering and oversized receipts', async () => {
    const f = fixture(), r = await f.client.invoke(input, f.permission), bytes = lastBytes(f);
    await expect(f.client.acceptResult(r.request_id, signedResult(bytes, {}, actor), f.gate)).rejects.toThrow('RESULT_SIGNATURE_INVALID');
    await expect(f.client.acceptResult(r.request_id, signedResult(bytes, terminal({ resultDigest: 'b'.repeat(64) })), f.gate)).rejects.toThrow('RESULT_DIGEST_MISMATCH');
    const resultBody = utf8.encode('{"done":"bad"}');
    await expect(f.client.acceptResult(r.request_id, signedResult(bytes, terminal({ resultBody, resultDigest: cidFromCanonical(resultBody) })), f.gate)).rejects.toThrow();
    await expect(f.client.acceptResult(r.request_id, new Uint8Array(1048577), f.gate)).rejects.toThrow('RESULT_SIZE_LIMIT');
    expect(f.client.view(r.request_id).status).toBe('unknown');
  });
  it('compares uint64 status revisions losslessly and freezes terminal bytes', async () => {
    const f = fixture(), r = await f.client.invoke(input, f.permission), bytes = lastBytes(f);
    await f.client.acceptResult(r.request_id, signedResult(bytes), f.gate);
    await expect(f.client.acceptResult(r.request_id, signedResult(bytes, { code: 'changed' }), f.gate)).rejects.toThrow('RESULT_REVISION_CONFLICT');
    await f.client.acceptResult(r.request_id, signedResult(bytes, { status: 2, executionId: 'execution_1', statusRevision: '9007199254740994' }), f.gate);
    await f.client.acceptResult(r.request_id, signedResult(bytes), f.gate);
    expect(f.client.view(r.request_id).status).toBe('executing');
    await f.client.acceptResult(r.request_id, signedResult(bytes, terminal()), f.gate);
    await expect(f.client.acceptResult(r.request_id, signedResult(bytes, terminal({ statusRevision: '9007199254740996', code: 'changed' })), f.gate)).rejects.toThrow('RESULT_TERMINAL_CONFLICT');
    await f.client.drainPending(f.gate);
    expect(f.onResult).not.toHaveBeenCalled();
    expect(f.store.reservations()[0]!.status).toBe('succeeded');
    expect(f.client.view(r.request_id).base_accounting?.state).toBe('applied');
    expect(f.db.queryAll('SELECT * FROM world_action_client_results')).toHaveLength(3);
    expect(f.client.view(r.request_id).result?.statusRevision.toString()).toBe('9007199254740995');
  });
  it.each([
    terminal({ executionId: '' }), terminal({ statusRevision: '0' }),
    { status: 1, executionId: 'exec' }, { status: 5, executionId: 'exec' },
    { ...terminal(), statusRevision: '9', status: 5, executionId: '' },
    { status: 4, statusRevision: '0', committedAt: '1000' },
  ])('rejects signed impossible state invariants %#', async changes => {
    const f = fixture(), r = await f.client.invoke(input, f.permission);
    await expect(f.client.acceptResult(r.request_id, signedResult(lastBytes(f), changes), f.gate)).rejects.toThrow('RESULT_INVALID');
    expect(f.client.view(r.request_id).status).toBe('unknown');
  });
  it('rejects cancellation after a durable execution permit but accepts pre-admission rejection revision zero', async () => {
    const f = fixture(), r = await f.client.invoke(input, f.permission), bytes = lastBytes(f);
    await f.client.acceptResult(r.request_id, signedResult(bytes, { status: 2, executionId: 'exec', statusRevision: '2' }), f.gate);
    await expect(f.client.acceptResult(r.request_id, signedResult(bytes, { status: 5, code: 'CANCELLED', statusRevision: '3' }), f.gate)).rejects.toThrow('RESULT_TRANSITION_INVALID');
    const otherInput = {...input,params:{text:'other'}};
    const another = await f.client.invoke(otherInput, f.store.reserve({jobId:'other',input:otherInput,expiresAt:1250}));
    await expect(f.client.acceptResult(another.request_id, signedResult(lastBytes(f), { status: 4, code: 'SESSION_EXPIRED', statusRevision: '0' }), f.gate)).resolves.toBeUndefined();
    expect(f.client.view(another.request_id)).toMatchObject({ status: 'rejected', code: 'SESSION_EXPIRED' });
  });
  it('uses explicit signed control read for known request while disabled; never dispatches attachments', async () => {
    const f = fixture(), r = await f.client.invoke(input, f.permission), bytes = lastBytes(f);
    f.abort.abort();
    f.options.readStatus = vi.fn(async queryBytes => {
      const query = popclaw.world.ActionStatusRequest.decode(queryBytes);
      const core = canonicalWorldCore(popclaw.world.ActionStatusRequest, { house: query.house, actorId: query.actorId, requestId: query.requestId, nonce: query.nonce, issuedAt: query.issuedAt, expiresAt: query.expiresAt });
      expect(nacl.sign.detached.verify(worldSigningInput('POPCLAW_WORLD_ACTION_STATUS_READ_V1', core), query.signature, actor.publicKey)).toBe(true);
      return popclaw.world.ActionStatusResponse.encode({ result: popclaw.world.SignedActionResult.decode(signedResult(bytes, terminal())) }).finish();
    });
    expect(await f.client.status(r.request_id)).toMatchObject({ status: 'succeeded' });
    expect(f.onResult).not.toHaveBeenCalled();
    await expect(f.client.status('b'.repeat(64))).rejects.toThrow('REQUEST_NOT_KNOWN');
    expect(f.options.readStatus).toHaveBeenCalledOnce(); expect(f.push).toHaveBeenCalledOnce();
  });
  it('isolates known request/control access across actors and house incarnations', async () => {
    const f = fixture(), r = await f.client.invoke(input, f.permission);
    expect(() => new WorldActionClient({...f.options,actorId:keyId})).toThrow('ACTION_RECEIPT_PARTITION_REQUIRED');
    expect(() => new WorldActionClient({...f.options,house:{...house,incarnation:'inc_2'}}).view(r.request_id)).toThrow('REQUEST_NOT_KNOWN');
  });
  it('elides defaults recursively within repeated child messages like prost', () => {
    const message = popclaw.world.WorldStreamCheckpoint.fromObject({ phase: 'replay', scopes: [{ scopeId: 'sc_a', throughSeq: '0' }] });
    // phase field 1 + child field 2; child has only scope_id field 1, no seq=0 tag.
    expect(Buffer.from(canonicalWorldCore(popclaw.world.WorldStreamCheckpoint, message)).toString('hex')).toBe('0a067265706c617912060a0473635f61');
  });
});


describe('WorldActionClient durable original execution authority reference', () => {
  it('persists and forwards only the original frozen factory reference with the request', async () => {
    const f = fixture(); let forwarded: unknown;
    f.options.push = async (_bytes, context) => { forwarded = context.executionReference; expect(Object.isFrozen(forwarded)).toBe(true); return {}; };
    const r = await f.client.invoke(input, f.permission);
    expect(forwarded).toEqual(f.permission.executionReference);
    const row = f.db.queryOne<{ execution_reference: string }>('SELECT execution_reference FROM world_action_client_requests WHERE request_id=?', [r.request_id])!;
    expect(JSON.parse(row.execution_reference)).toEqual(f.permission.executionReference);
    await f.client.retry(r.request_id, { ...f.permission, executionReference: { kind: 'owner_action', reservationId: '2'.repeat(64) } }).then(() => { throw Error('unexpected send'); }, error => expect(error.message).toBe('ACTION_EXECUTION_REFERENCE_MISMATCH'));
  });
  it('rejects a second original-request collision that tries to replace the initially recorded grant', async () => {
    const f = fixture(); const r = await f.client.invoke(input, f.permission);
    const other = { ...f.permission, executionReference: { kind: 'read_state' as const, reservationId: '2'.repeat(64), participationId: 'p' } };
    await expect(f.client.invoke(input, other)).rejects.toThrow('ACTION_EXECUTION_REFERENCE_MISMATCH');
    expect(f.permission.record).toHaveBeenCalledOnce(); expect(f.push).toHaveBeenCalledOnce();
    expect(f.db.queryOne<{ execution_reference: string }>('SELECT execution_reference FROM world_action_client_requests WHERE request_id=?', [r.request_id])!.execution_reference).toBe(JSON.stringify(f.permission.executionReference));
  });
  it('refuses missing/malformed or inherited authority references before signing', async () => {
    const f = fixture(); const sign = vi.spyOn(f.signer, 'sign');
    for (const executionReference of [undefined, { kind: 'owner_action' }, { kind: 'owner_action', reservationId: 'a', extra: true }, Object.create({ kind: 'owner_action', reservationId: 'a' })]) {
      await expect(f.client.invoke(input, { ...f.permission, executionReference } as WorldActionAuthority)).rejects.toThrow('ACTION_EXECUTION_REFERENCE_REQUIRED');
    }
    expect(sign).not.toHaveBeenCalled(); expect(f.push).not.toHaveBeenCalled();
  });
  it('detects reference replacement across signer awaits without persisting or pushing', async () => {
    const f = fixture(); const original = f.signer.sign.bind(f.signer);
    vi.spyOn(f.signer, 'sign').mockImplementation(async bytes => {
      (f.permission as { executionReference: unknown }).executionReference = { kind: 'owner_action', reservationId: '2'.repeat(64) };
      return original(bytes);
    });
    await expect(f.client.invoke(input, f.permission)).rejects.toThrow('ACTION_EXECUTION_REFERENCE_MISMATCH');
    expect(f.db.queryAll('SELECT request_id FROM world_action_client_requests')).toEqual([]); expect(f.push).not.toHaveBeenCalled();
  });

});

function statusBytes(raw: Uint8Array, observation?: Uint8Array): Uint8Array {
  const wrap = (tag:number, value:Uint8Array) => { const length:number[]=[];let n=value.length;do{length.push((n&127)|(n>=128?128:0));n=Math.floor(n/128);}while(n);return [tag,...length,...value]; };
  return Uint8Array.from([...wrap(10,raw),...(observation ? wrap(18,observation) : [])]);
}
function originalReordered(raw: Uint8Array): Uint8Array {
  const envelope=popclaw.world.SignedActionResult.decode(raw);
  const signature = canonicalWorldCore(popclaw.world.SignedActionResult,{signature:envelope.signature});
  const result = canonicalWorldCore(popclaw.world.SignedActionResult,{result:envelope.result});
  return Uint8Array.from([...signature,...result]);
}
describe('independent durable receipts and exact original accounting', () => {
  it('rolls back evidence, semantic receipt and latest together before a receipt ACK', async () => {
    const f=fixture(), request=await f.client.invoke(input,f.permission), raw=signedResult(lastBytes(f),terminal());
    const execute=f.db.execute.bind(f.db); const fault=vi.spyOn(f.db,'execute').mockImplementation((sql,params)=>{
      if(sql.startsWith('INSERT INTO world_action_client_evidence')) throw new Error('receipt_disk_failure'); return execute(sql,params);
    });
    await expect(f.client.acceptResult(request.request_id,raw,f.gate)).rejects.toThrow('receipt_disk_failure');
    expect(f.db.queryAll('SELECT * FROM world_action_client_results')).toEqual([]);expect(f.db.queryAll('SELECT * FROM world_action_client_evidence')).toEqual([]);expect(f.client.view(request.request_id).status).toBe('unknown');
    expect(f.store.reservations()[0]!.status).toBe('reserved'); fault.mockRestore();
    await f.client.acceptResult(request.request_id,raw,f.gate);expect(f.client.view(request.request_id).receipt_durable).toBe(true);
  });
  it('persists a terminal receipt before accounting, rolls back settlement before marker, and recovers after file reopen', async () => {
    const dir=mkdtempSync(join(tmpdir(),'receipt-atomic-'));dirs.push(dir);const path=join(dir,'execution.sqlite');
    const db=new LocalHostDb(path);dbs.push(db);const f=fixture({db}), request=await f.client.invoke(input,f.permission), raw=signedResult(lastBytes(f),terminal());
    await f.client.acceptResult(request.request_id,raw,f.gate);
    expect(f.client.view(request.request_id).base_accounting?.state).toBe('pending');expect(f.store.reservations()[0]!.status).toBe('reserved');
    const evidenceDir=process.env.ACTION_RECEIPT_EVIDENCE_DIR;
    if(evidenceDir) {
      mkdirSync(evidenceDir,{recursive:true});writeFileSync(join(evidenceDir,'original-signed-result.bin'),raw);
      writeFileSync(join(evidenceDir,'original-signed-request.bin'),lastBytes(f));
      await db.snapshotTo(join(evidenceDir,'after-receipt-before-accounting.sqlite'));
    }
    const execute=db.execute.bind(db);const fault=vi.spyOn(db,'execute').mockImplementation((sql,params)=>{
      if(sql.startsWith('UPDATE world_action_client_results SET receipt_state')) throw new Error('marker_disk_failure');return execute(sql,params);
    });
    f.client.reconcileAccounting(request.request_id);expect(f.store.reservations()[0]!.status).toBe('reserved');expect(f.client.view(request.request_id).base_accounting?.state).toBe('pending');fault.mockRestore();
    if(evidenceDir) await db.snapshotTo(join(evidenceDir,'after-accounting-rollback.sqlite'));
    db.close();
    const reopened=new LocalHostDb(path);dbs.push(reopened);
    const store=new WorldOwnerActionAuthorityStore({db:reopened,house,actorId,expectedPartition:partition,now:()=>2000});
    const client=new WorldActionClient({...f.options,db:reopened,captureSelectedActionContext(){throw new Error('must not capture');},accounting:{assertCurrent(){},settle:store.settleOriginal.bind(store)},now:()=>2000});
    expect(store.reservations()[0]!.status).toBe('reserved');expect(client.view(request.request_id).base_accounting?.state).toBe('pending');
    client.reconcileAccounting(request.request_id);expect(store.reservations()[0]!.status).toBe('succeeded');expect(client.view(request.request_id).base_accounting?.state).toBe('applied');
    if(evidenceDir) {await reopened.snapshotTo(join(evidenceDir,'after-reopen-accounting-applied.sqlite'));writeFileSync(join(evidenceDir,'verified-state.json'),JSON.stringify({requestId:request.request_id,reservation:store.reservations()[0],view:client.view(request.request_id)},null,2));}
    await client.acceptResult(request.request_id,raw,f.controlGate);client.reconcileAccounting(request.request_id);expect(store.reservations()).toHaveLength(1);expect(client.hasPending()).toBe(false);expect(f.push).toHaveBeenCalledOnce();
  });
  it('retains original raw status without progress, old key and accounting after logout and grant expiry', async () => {
    const f=fixture(), request=await f.client.invoke(input,f.permission), raw=originalReordered(signedResult(lastBytes(f),terminal())), outer=statusBytes(raw);
    f.abort.abort();f.options.now=()=>2000;f.options.captureSelectedActionContext=()=>{throw new Error('new selection forbidden');};f.options.capabilities=()=>{throw new Error('new key forbidden');};f.options.readStatus=async()=>outer;
    const view=await f.client.status(request.request_id);
    expect(view).toMatchObject({house_status:'succeeded',receipt_durable:true,installed_readiness:false,base_accounting:{state:'applied'}});
    const evidence=f.db.queryOne<{source_bytes:Uint8Array;signed_result_bytes:Uint8Array}>('SELECT source_bytes,signed_result_bytes FROM world_action_client_evidence')!;
    expect([...evidence.source_bytes]).toEqual([...outer]);expect([...evidence.signed_result_bytes]).toEqual([...raw]);expect(f.store.reservations()[0]!.status).toBe('succeeded');expect(f.push).toHaveBeenCalledOnce();expect(f.onResult).not.toHaveBeenCalled();
  });
  it('retains distinct source encodings for one semantic result without resetting applied accounting', async () => {
    const f=fixture(), request=await f.client.invoke(input,f.permission), raw=signedResult(lastBytes(f),terminal());
    await f.client.acceptResult(request.request_id,raw,f.gate);f.client.reconcileAccounting(request.request_id);
    await f.client.acceptResult(request.request_id,originalReordered(raw),f.gate);
    f.options.readStatus=async()=>statusBytes(originalReordered(raw));await f.client.status(request.request_id);
    expect(f.db.queryAll('SELECT * FROM world_action_client_results')).toHaveLength(1);expect(f.db.queryAll('SELECT * FROM world_action_client_evidence')).toHaveLength(3);
    expect(f.accounting.settle).toHaveBeenCalledOnce();expect(f.client.view(request.request_id).base_accounting?.state).toBe('applied');
  });
  it('rejects evidence-key conflicts without replacing preserved source associations', async () => {
    const f=fixture(),request=await f.client.invoke(input,f.permission),raw=signedResult(lastBytes(f),terminal());await f.client.acceptResult(request.request_id,raw,f.gate);
    f.db.execute("UPDATE world_action_client_evidence SET core_digest=?",['f'.repeat(64)]);
    await expect(f.client.acceptResult(request.request_id,raw,f.gate)).rejects.toThrow('ACTION_EVIDENCE_CONFLICT');
    expect(f.db.queryOne<{core_digest:string}>('SELECT core_digest FROM world_action_client_evidence')!.core_digest).toBe('f'.repeat(64));
  });
  it('retains earlier valid nonterminal history but rejects older conflicting terminals', async () => {
    const f=fixture(),request=await f.client.invoke(input,f.permission),bytes=lastBytes(f);
    await f.client.acceptResult(request.request_id,signedResult(bytes,terminal()),f.gate);
    await f.client.acceptResult(request.request_id,signedResult(bytes),f.gate);
    expect(f.db.queryAll('SELECT * FROM world_action_client_results')).toHaveLength(2);expect(f.client.view(request.request_id).status).toBe('succeeded');
    await expect(f.client.acceptResult(request.request_id,signedResult(bytes,{status:4,statusRevision:'2',code:'REJECTED'}),f.gate)).rejects.toThrow('RESULT_TERMINAL_CONFLICT');
    expect(f.db.queryAll('SELECT * FROM world_action_client_evidence')).toHaveLength(2);
  });
  it('keeps invalid attachments separate from successful base accounting', async () => {
    const f=fixture(),request=await f.client.invoke(input,f.permission);
    await f.client.acceptResult(request.request_id,signedResult(lastBytes(f),terminal({snapshot:{stateRef:'s1',schemaKind:'test.state',schemaVersion:1,body:utf8.encode('{}')}})),f.gate);
    f.client.reconcileAccounting(request.request_id);
    expect(f.client.view(request.request_id)).toMatchObject({status:'succeeded',receipt_durable:true,attachment_contract:{outcome:'violated'},base_accounting:{state:'applied'},installed_readiness:false});expect(f.onResult).not.toHaveBeenCalled();expect(f.client.hasPending()).toBe(false);
  });
  it('marks missing reservations blocked without hot retries or manufactured rows', async () => {
    const f=fixture(),request=await f.client.invoke(input,f.permission);f.db.execute('DELETE FROM world_owner_action_reservations');
    await f.client.acceptResult(request.request_id,signedResult(lastBytes(f),terminal()),f.gate);f.client.reconcileAccounting(request.request_id);
    expect(f.client.view(request.request_id).base_accounting).toMatchObject({state:'blocked',reason:'OWNER_ACTION_RESERVATION_UNKNOWN'});expect(f.client.hasPending()).toBe(false);expect(f.store.reservations()).toEqual([]);
  });
  it('does not accept a claimed applied callback without the actual reservation transition', async () => {
    const f=fixture(),request=await f.client.invoke(input,f.permission);f.accounting.settle.mockImplementation((_tx,arg)=>({outcome:'applied',reservationId:arg.executionReference.reservationId}));
    await f.client.acceptResult(request.request_id,signedResult(lastBytes(f),terminal()),f.gate);f.client.reconcileAccounting(request.request_id);
    expect(f.store.reservations()[0]!.status).toBe('reserved');expect(f.client.view(request.request_id).base_accounting?.state).toBe('blocked');
  });
  it('preserves the receipt and reservation while original accounting is held', async () => {
    const f=fixture(),request=await f.client.invoke(input,f.permission);f.accounting.assertCurrent=()=>{throw new Error('RESTORE_HOLD');};
    await f.client.acceptResult(request.request_id,signedResult(lastBytes(f),terminal()),f.gate);f.client.reconcileAccounting(request.request_id);
    expect(f.client.view(request.request_id).base_accounting?.state).toBe('pending');expect(f.store.reservations()[0]!.status).toBe('reserved');expect(f.client.hasPending()).toBe(false);
    f.accounting.assertCurrent=()=>{};f.client.reconcileAccounting(request.request_id);expect(f.client.view(request.request_id).base_accounting?.state).toBe('applied');
  });
  it('never derives accounting success from legacy pending flags or missing provenance', async () => {
    const f=fixture(),request=await f.client.invoke(input,f.permission);await f.client.acceptResult(request.request_id,signedResult(lastBytes(f),terminal()),f.gate);
    f.db.execute('UPDATE world_action_client_results SET pending=0,receipt_profile=NULL,receipt_state=NULL');f.db.execute('UPDATE world_action_client_requests SET receipt_profile=NULL,original_context=NULL,execution_reference=NULL');
    await f.client.drainPending(f.gate);expect(f.client.hasPending()).toBe(false);expect(f.store.reservations()[0]!.status).toBe('reserved');expect(f.client.view(request.request_id).code).toBe('ACTION_CONTEXT_UNSUPPORTED');await expect(f.client.retry(request.request_id,f.permission)).rejects.toThrow('ACTION_CONTEXT_UNSUPPORTED');
  });
  it('retains independently signed progress without selecting an installer, even if another progress is malformed', async () => {
    const f=fixture(),request=await f.client.invoke(input,f.permission),bytes=lastBytes(f),subscription={house,actorId,participationId:'p1',descriptorRevision:'1',logIncarnation:'log1',scopes:['scope1'],barrierId:'b1'};
    const raw=signedResult(bytes,terminal({subscription}));
    f.options.readStatus=async queryBytes=>{
      const query=popclaw.world.ActionStatusRequest.decode(queryBytes);
      const observation={version:1,house,actorId,participationId:'p1',barrierId:'b1',descriptorRevision:1,observationRevision:1,publicationState:'published',logIncarnation:'log1',highWaterSeq:1,publishedThrough:[{scopeId:'scope1',throughSeq:1}],queryRequestId:request.request_id,queryNonce:query.nonce,observedAt:1000};
      const progress=canonicalWorldCore(popclaw.world.SignedSubscriptionObservation,{observation,signature:nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_SUBSCRIPTION_OBSERVATION_V1',canonicalWorldCore(popclaw.world.SubscriptionObservation,observation)),authorityKey.secretKey)});
      return statusBytes(raw,progress);
    };
    await f.client.status(request.request_id);expect(f.db.queryAll('SELECT * FROM world_action_client_progress')).toHaveLength(1);expect(f.client.hasPending()).toBe(false);
    f.options.readStatus=async()=>statusBytes(raw,new Uint8Array([255]));await f.client.status(request.request_id);
    expect(f.db.queryAll('SELECT * FROM world_action_client_progress')).toHaveLength(1);expect(f.db.queryAll('SELECT * FROM world_action_client_evidence')).toHaveLength(2);expect(f.onResult).not.toHaveBeenCalled();
  });
});

it('assigns accounting single-flight before a synchronous adapter can reenter delivery', async () => {
  const f=fixture(),request=await f.client.invoke(input,f.permission);await f.client.acceptResult(request.request_id,signedResult(lastBytes(f),terminal()),f.gate);
  const settle=f.store.settleOriginal.bind(f.store);let nested:Promise<void>|undefined;
  f.accounting.settle.mockImplementation((tx,arg)=>{nested=f.client.drainPending(f.gate);return settle(tx,arg);});
  const pass=f.client.drainPending(f.gate);await pass;expect(nested).toBe(pass);expect(f.accounting.settle).toHaveBeenCalledOnce();expect(f.client.view(request.request_id).base_accounting?.state).toBe('applied');
});

// A bounded trusted-adapter fixture exercises G1's ledger boundary. Actual host
// policy parsing/live authority creation is owned and tested by G0.
function nativeAccounting(db:HostDb): import('../../../src/world/action-client.js').OriginalActionAccounting {
  const store = new WorldNativeActionAuthorityStore({db,house,actorId,expectedPartition:partition,
    captureSelectedActionContext(){throw new Error('NO_EXECUTION_RECAPTURE');},assertPermit(){throw new Error('NO_NEW_EXECUTION_PERMIT');},now:()=>2000});
  return {assertCurrent(){},settle:store.settleOriginal.bind(store)};
}
function canonicalNativeInput(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonicalNativeInput).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonicalNativeInput((value as Record<string,unknown>)[key])).join(',')+'}';
  return JSON.stringify(value);
}
async function nativeFixture(db?:HostDb, reservationId='d'.repeat(64)) {
  const f=fixture(db?{db}:{}), journal=await import('../../../src/world/native-action-journal.js');
  journal.prepareNativeActionJournal({executionDb:f.db,expectedPartition:partition,expectedSchemaFingerprint:journal.NATIVE_ACTION_SCHEMA_FINGERPRINT});
  const binding=JSON.stringify([house.origin,house.houseKey,house.incarnation,actorId]);
  f.db.execute('INSERT INTO world_native_action_reservations VALUES(?,?,?,?,?,?,?,?,?,?,NULL,?)',[
    binding,reservationId,cidFromCanonical(utf8.encode(reservationId)),canonicalNativeInput({kind:'openclaw_agent',agentId:'main',actorId}),canonicalNativeInput({kind:'openclaw_runtime_config',path:'plugins.entries.popclaw.config.worldExecution'}),'f'.repeat(64),canonicalNativeInput({agentId:'main',actorId,house:house.origin,kinds:['test.act'],authorizedAt:900,expiresAt:1300}),canonicalNativeInput(input),1000,1250,'reserved']);
  let current=true;
  const authority:WorldActionAuthority={executionReference:{kind:'native_policy',reservationId},expiresAt:1250,
    check(attempt){if(!current)throw new Error('NATIVE_EXECUTION_REVOKED');if(attempt.requestId&&f.db.queryOne<{request_id:string}>('SELECT request_id FROM world_native_action_reservations WHERE reservation_id=?',[reservationId])?.request_id!==attempt.requestId)throw new Error('NATIVE_ACTION_REQUEST_MISMATCH');},
    assertBinding(db,bound,actor){if(db!==f.db||actor!==actorId||JSON.stringify(bound)!==JSON.stringify(house))throw new Error('NATIVE_ACTION_BINDING_MISMATCH');},
    assertInput(candidate){if(canonicalNativeInput(candidate)!==canonicalNativeInput(input))throw new Error('NATIVE_ACTION_INPUT_MISMATCH');},
    record(tx,requestId){expect(tx).toBe(f.db);tx.execute('UPDATE world_native_action_reservations SET request_id=? WHERE reservation_id=?',[requestId,reservationId]);}};
  f.options.accounting=nativeAccounting(f.db);
  const status=()=>f.db.queryOne<{status:string}>('SELECT status FROM world_native_action_reservations WHERE reservation_id=?',[reservationId])!.status;
  return {...f,authority,reservationId,status,revoke:()=>{current=false;}};
}
describe('native original-ledger receipt profile',()=>{
  it('creates distinct signed requests for two independently authorized native calls with identical input',async()=>{
    const first=await nativeFixture(),second=await nativeFixture(first.db,'c'.repeat(64));

    let now=1000;first.options.now=second.options.now=()=>now;
    const firstView=await first.client.invoke(input,first.authority);
    const signed=vi.spyOn(second.signer,'sign');
    const pending=second.client.invoke(input,second.authority);
    await vi.waitFor(()=>expect(signed).toHaveBeenCalled());
    await new Promise(resolve=>setTimeout(resolve,50));expect(second.push).not.toHaveBeenCalled();
    now=1001;await new Promise(resolve=>setTimeout(resolve,50));
    const secondView=await pending;
    expect(secondView.request_id).not.toBe(firstView.request_id);
    expect(first.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(2);
    const firstBytes=lastBytes(first),secondBytes=lastBytes(second);
    const envelopes=[firstBytes,secondBytes].map(raw=>popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(raw).payload));
    expect(envelopes.map(env=>Number(env.timestamp))).toEqual([1000,1001]);
    for(const env of envelopes){expect(Number(env.intent!.context!.validUntil)).toBe(1200);expect(new Uint8Array(env.intent!.params!)).toEqual(utf8.encode(JSON.stringify(input.params)));}
    await first.client.retry(firstView.request_id,first.authority);
    await second.client.retry(secondView.request_id,second.authority);
    expect(lastBytes(first)).toEqual(firstBytes);expect(lastBytes(second)).toEqual(secondBytes);
  });
  it.each(['stalled','revoked','expired','aborted'] as const)('bounds collision waiting and closes on %s',async mode=>{
    const first=await nativeFixture(),second=await nativeFixture(first.db,'c'.repeat(64));

    let now=1000;second.options.now=()=>now;
    await first.client.invoke(input,first.authority);
    const signed=vi.spyOn(second.signer,'sign');
    const pending=second.client.invoke(input,second.authority);
    let elapsed=0;const monotonic=performance.now();vi.spyOn(performance,'now').mockImplementation(()=>monotonic+elapsed);
    const reason={stalled:'ACTION_REQUEST_COLLISION_BUSY',revoked:'NATIVE_EXECUTION_REVOKED',expired:'ACTION_EXPIRED',aborted:'ACTION_GATE_CLOSED'}[mode];
    const rejected=expect(pending).rejects.toThrow(reason);
    await vi.waitFor(()=>expect(signed).toHaveBeenCalled());
    await new Promise(resolve=>setTimeout(resolve,50));
    expect(second.push).not.toHaveBeenCalled();
    // A write remains possible while this call waits: no transaction is held.
    second.db.transaction(tx=>tx.execute('CREATE TABLE collision_probe(value INTEGER)'));
    if(mode==='revoked')second.revoke();
    if(mode==='expired')now=1200;
    if(mode==='aborted')second.abort.abort();
    if(mode==='stalled')elapsed=5001;
    await rejected;
    expect(first.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(1);
    expect(second.push).not.toHaveBeenCalled();
  });
  it('resolves concurrent native contenders into three distinct requests and reuses the same call after time advances',async()=>{
    const first=await nativeFixture(),second=await nativeFixture(first.db,'c'.repeat(64)),third=await nativeFixture(first.db,'b'.repeat(64));

    let now=1000;for(const f of [first,second,third])f.options.now=()=>now;
    const firstView=await first.client.invoke(input,first.authority);
    const secondSigned=vi.spyOn(second.signer,'sign'),thirdSigned=vi.spyOn(third.signer,'sign');
    const calls=[second,third].map(f=>f.client.invoke(input,f.authority));
    await vi.waitFor(()=>{expect(secondSigned).toHaveBeenCalled();expect(thirdSigned).toHaveBeenCalled();});
    await new Promise(resolve=>setTimeout(resolve,50));expect(first.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(1);
    now=1001;await vi.waitFor(()=>expect(first.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(2));
    now=1002;const views=[firstView,...await Promise.all(calls)];
    expect(new Set(views.map(v=>v.request_id)).size).toBe(3);
    const original=lastBytes(first);now=1003;
    expect((await first.client.invoke(input,first.authority)).request_id).toBe(views[0]!.request_id);
    expect(lastBytes(first)).toEqual(original);expect(first.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(3);
  });
  it('records and settles native execution without touching the historical manual reservation',async()=>{
    const f=await nativeFixture();f.push.mockImplementation(async bytes=>({signedActionResultBase64:Buffer.from(signedResult(bytes,terminal())).toString('base64')}));
    const view=await f.client.invoke(input,f.authority);
    expect(view.base_accounting).toMatchObject({state:'applied',executionReference:{kind:'native_policy',reservationId:f.reservationId}});
    expect(f.status()).toBe('succeeded');expect(f.store.reservations()[0]!.status).toBe('reserved');expect(f.store.reservations()[0]!.request_id).toBeNull();
    expect(f.db.queryOne<{receipt_profile:string}>('SELECT receipt_profile FROM world_action_client_requests')!.receipt_profile).toBe('public-envelope-01.3-native-action-v1');
    expect(f.db.queryOne<{receipt_profile:string}>('SELECT receipt_profile FROM world_action_client_results')!.receipt_profile).toBe('public-envelope-01.3-native-action-v1');
  });
  it('keeps a signed native result after policy revocation during the send',async()=>{
    const f=await nativeFixture();f.push.mockImplementation(async bytes=>{const raw=signedResult(bytes,terminal());f.revoke();return {signedActionResultBase64:Buffer.from(raw).toString('base64')};});
    expect((await f.client.invoke(input,f.authority)).base_accounting?.state).toBe('applied');expect(f.status()).toBe('succeeded');
  });
  it('refuses missing native schema before signing or inserting a request',async()=>{
    const f=await nativeFixture();f.db.execute('DROP TABLE world_native_action_reservations');const sign=vi.spyOn(f.signer,'sign');
    await expect(f.client.invoke(input,f.authority)).rejects.toThrow('NATIVE_ACTION_SCHEMA_UNSUPPORTED');expect(sign).not.toHaveBeenCalled();expect(f.push).not.toHaveBeenCalled();expect(f.db.queryAll('SELECT * FROM world_action_client_requests')).toEqual([]);
  });
  it('keeps exact retry bytes and blocks future sends on revoked execution authority',async()=>{
    const f=await nativeFixture(),view=await f.client.invoke(input,f.authority), original=lastBytes(f);
    await f.client.retry(view.request_id,f.authority);expect(lastBytes(f)).toEqual(original);
    f.revoke();await expect(f.client.retry(view.request_id,f.authority)).rejects.toThrow('NATIVE_EXECUTION_REVOKED');expect(f.push).toHaveBeenCalledTimes(2);
  });
  it('never accepts a callback-only claim that the native ledger was applied',async()=>{
    const f=await nativeFixture(),view=await f.client.invoke(input,f.authority);
    await f.client.acceptResult(view.request_id,signedResult(lastBytes(f),terminal()),f.gate);
    f.options.accounting={assertCurrent(){},settle:()=>({outcome:'applied',reservationId:f.reservationId})};f.client.reconcileAccounting(view.request_id);
    expect(f.client.view(view.request_id).base_accounting?.state).toBe('blocked');expect(f.status()).toBe('reserved');expect(f.client.hasPending()).toBe(false);
  });
  it('rejects manual/native profile relabeling without replacing the original receipt',async()=>{
    const f=await nativeFixture(),view=await f.client.invoke(input,f.authority);await f.client.acceptResult(view.request_id,signedResult(lastBytes(f),terminal()),f.gate);
    f.db.execute("UPDATE world_action_client_requests SET receipt_profile='first-release-1ff7-action-v1'");
    expect(()=>f.client.view(view.request_id)).toThrow('ACTION_CONTEXT_MISMATCH');expect(f.status()).toBe('reserved');
  });
  it('retains the original receipt but blocks accounting if the native ledger disappears',async()=>{
    const f=await nativeFixture(),view=await f.client.invoke(input,f.authority);await f.client.acceptResult(view.request_id,signedResult(lastBytes(f),terminal()),f.gate);
    f.db.execute('DROP TABLE world_native_action_reservations');f.client.reconcileAccounting(view.request_id);
    expect(f.client.view(view.request_id)).toMatchObject({receipt_durable:true,base_accounting:{state:'blocked',reason:'NATIVE_ACTION_SCHEMA_UNSUPPORTED'}});
    expect(f.client.hasPending()).toBe(false);expect(f.db.queryAll('SELECT * FROM world_action_client_evidence')).toHaveLength(1);
  });
  it('keeps native receipts pending while the original-accounting maintenance hold is active',async()=>{
    const f=await nativeFixture(),view=await f.client.invoke(input,f.authority);await f.client.acceptResult(view.request_id,signedResult(lastBytes(f),terminal()),f.gate);
    f.options.accounting!.assertCurrent=()=>{throw new Error('MAINTENANCE_HOLD');};f.client.reconcileAccounting(view.request_id);
    expect(f.client.hasPending()).toBe(false);expect(f.client.view(view.request_id).base_accounting?.state).toBe('pending');expect(f.status()).toBe('reserved');
    f.options.accounting!.assertCurrent=()=>{};f.client.reconcileAccounting(view.request_id);expect(f.client.view(view.request_id).base_accounting?.state).toBe('applied');
  });
  it('rolls back native settlement and reopens original signed receipts without renewing execution',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'native-receipt-'));dirs.push(dir);const path=join(dir,'execution.sqlite'),db=new LocalHostDb(path);dbs.push(db);
    const f=await nativeFixture(db),view=await f.client.invoke(input,f.authority),requestBytes=lastBytes(f),raw=signedResult(requestBytes,terminal());
    await f.client.acceptResult(view.request_id,raw,f.gate);expect(f.client.hasPending()).toBe(true);
    const execute=db.execute.bind(db),fault=vi.spyOn(db,'execute').mockImplementation((sql,params)=>{if(sql.startsWith('UPDATE world_action_client_results SET receipt_state'))throw new Error('native_marker_failure');return execute(sql,params);});
    f.client.reconcileAccounting(view.request_id);expect(f.status()).toBe('reserved');expect(f.client.view(view.request_id).base_accounting?.state).toBe('pending');fault.mockRestore();f.revoke();
    const evidenceDir=process.env.NATIVE_ACTION_EVIDENCE_DIR;
    if(evidenceDir){mkdirSync(evidenceDir,{recursive:true});writeFileSync(join(evidenceDir,'original-request.bin'),requestBytes);writeFileSync(join(evidenceDir,'original-result.bin'),raw);await db.snapshotTo(join(evidenceDir,'native-pending-after-rollback.sqlite'));}
    db.close();const reopened=new LocalHostDb(path);dbs.push(reopened);
    const client=new WorldActionClient({...f.options,db:reopened,accounting:nativeAccounting(reopened),now:()=>2000,captureSelectedActionContext(){throw new Error('no authority recapture');}});
    client.reconcileAccounting(view.request_id);expect(client.view(view.request_id).base_accounting?.state).toBe('applied');
    await client.acceptResult(view.request_id,raw,f.controlGate);client.reconcileAccounting(view.request_id);expect(client.hasPending()).toBe(false);expect(f.push).toHaveBeenCalledOnce();
    expect([...reopened.queryOne<{request_bytes:Uint8Array}>('SELECT request_bytes FROM world_action_client_requests')!.request_bytes]).toEqual([...requestBytes]);
    if(evidenceDir)await reopened.snapshotTo(join(evidenceDir,'native-applied-after-reopen.sqlite'));
  });
});


describe('explicit action request digest domains', () => {
  it('uses the exact inner envelope for new receipts and keeps the wrapper checksum and retry bytes', async () => {
    const f = fixture(), request = await f.client.invoke(input, f.permission), bytes = lastBytes(f);
    const row = f.db.queryOne<{request_digest:string;receipt_profile:string}>('SELECT request_digest,receipt_profile FROM world_action_client_requests')!;
    expect(row.request_digest).toBe(cidFromCanonical(bytes));
    expect(row.receipt_profile).toBe('public-envelope-01.3-action-v1');
    await expect(f.client.acceptResult(request.request_id, signedResult(bytes, {requestDigest:cidFromCanonical(bytes)}), f.gate)).rejects.toThrow('RESULT_BINDING_MISMATCH');
    await f.client.acceptResult(request.request_id, signedResult(bytes), f.gate);
    await f.client.retry(request.request_id, f.permission);
    expect(lastBytes(f)).toEqual(bytes);
  });
  it('retains historical wrapper-domain receipt semantics without migrating the row', async () => {
    const f = fixture(), request = await f.client.invoke(input, f.permission), bytes = lastBytes(f);
    f.db.execute("UPDATE world_action_client_requests SET receipt_profile='first-release-1ff7-action-v1'");
    await expect(f.client.acceptResult(request.request_id, signedResult(bytes), f.gate)).rejects.toThrow('RESULT_BINDING_MISMATCH');
    await f.client.acceptResult(request.request_id, signedResult(bytes, terminal({requestDigest:cidFromCanonical(bytes)})), f.gate);
    f.abort.abort();
    f.client.reconcileAccounting(request.request_id);
    expect(f.client.view(request.request_id).base_accounting?.state).toBe('applied');
    expect(f.db.queryOne<{receipt_profile:string}>('SELECT receipt_profile FROM world_action_client_requests')!.receipt_profile).toBe('first-release-1ff7-action-v1');
    expect([...f.db.queryOne<{request_bytes:Uint8Array}>('SELECT request_bytes FROM world_action_client_requests')!.request_bytes]).toEqual([...bytes]);
  });
  it.each(['wrapper', 'payload'])('rejects stored %s corruption before accepting a receipt', async target => {
    const f = fixture(), request = await f.client.invoke(input, f.permission), bytes = lastBytes(f), changed = new Uint8Array(bytes);
    const offset = target === 'wrapper' ? changed.length - 1 : 12; changed[offset] = changed[offset]! ^ 1;
    f.db.execute('UPDATE world_action_client_requests SET request_bytes=?', [changed]);
    await expect(f.client.acceptResult(request.request_id, signedResult(bytes), f.gate)).rejects.toThrow('REQUEST_STORAGE_INVALID');
    expect(f.db.queryAll('SELECT * FROM world_action_client_results')).toHaveLength(0);
  });
});


it.each(['owner_action', 'native_policy'] as const)('reopens and settles a historical %s receipt with the original profile and bytes', async kind => {
  const dir = mkdtempSync(join(tmpdir(),'legacy-action-digest-')); dirs.push(dir);
  const path = join(dir,'execution.sqlite'), db = new LocalHostDb(path); dbs.push(db);
  const native = kind === 'native_policy' ? await nativeFixture(db) : null, f = native ?? fixture({db});
  const request = await f.client.invoke(input, native?.authority ?? f.permission), bytes = lastBytes(f);
  const profile = kind === 'native_policy' ? 'first-release-1ff7-native-action-v1' : 'first-release-1ff7-action-v1';
  db.execute('UPDATE world_action_client_requests SET receipt_profile=?', [profile]);
  const raw = signedResult(bytes, terminal({requestDigest:cidFromCanonical(bytes)}));
  await f.client.acceptResult(request.request_id, raw, f.gate);
  const original = db.queryOne('SELECT * FROM world_action_client_requests');
  f.abort.abort(); db.close();
  const reopened = new LocalHostDb(path); dbs.push(reopened);
  const ownerStore = new WorldOwnerActionAuthorityStore({db:reopened,house,actorId,expectedPartition:partition,now:()=>2000});
  const accounting = kind === 'native_policy' ? nativeAccounting(reopened) : {assertCurrent(){},settle:ownerStore.settleOriginal.bind(ownerStore)};
  const client = new WorldActionClient({...f.options,db:reopened,accounting,captureSelectedActionContext(){throw new Error('NO_EXECUTION_RECAPTURE');}});
  expect(client.hasPending()).toBe(true);
  client.reconcileAccounting(request.request_id);
  expect(client.view(request.request_id).base_accounting?.state).toBe('applied');
  expect(reopened.queryOne('SELECT * FROM world_action_client_requests')).toEqual(original);
  expect([...reopened.queryOne<{result_bytes:Uint8Array}>('SELECT result_bytes FROM world_action_client_results')!.result_bytes]).toEqual([...raw]);
});

it.each(['duplicate', 'unknown', 'signature'])('rejects malformed new-profile wrapper even after checksum is updated (%s)', async mode => {
  const f = fixture(), request = await f.client.invoke(input,f.permission), bytes = lastBytes(f);
  const outer = popclaw.identity.SignedPayload.decode(bytes);
  let changed: Uint8Array;
  if (mode === 'duplicate') changed = Uint8Array.from([...bytes,...popclaw.identity.SignedPayload.encode({payload:outer.payload}).finish()]);
  else if (mode === 'unknown') changed = Uint8Array.from([...bytes,34,1,1]);
  else {outer.signature[0] = outer.signature[0]! ^ 1; changed = popclaw.identity.SignedPayload.encode(outer).finish();}
  f.db.execute('UPDATE world_action_client_requests SET request_bytes=?,request_digest=?',[changed,cidFromCanonical(changed)]);
  await expect(f.client.acceptResult(request.request_id,signedResult(bytes),f.gate)).rejects.toThrow('REQUEST_STORAGE_INVALID');
});

it('hashes exact accepted envelope bytes even when their field order differs from canonical encoding', async () => {
  const f = fixture(), request = await f.client.invoke(input,f.permission), bytes = lastBytes(f);
  const outer = popclaw.identity.SignedPayload.decode(bytes);
  expect([...outer.payload.subarray(0,2)]).toEqual([10,64]);
  outer.payload = Uint8Array.from([...outer.payload.subarray(66),...outer.payload.subarray(0,66)]);
  outer.signature = nacl.sign.detached(outer.payload,actor.secretKey);
  const changed = popclaw.identity.SignedPayload.encode(outer).finish();
  f.db.execute('UPDATE world_action_client_requests SET request_bytes=?,request_digest=?',[changed,cidFromCanonical(changed)]);
  await f.client.acceptResult(request.request_id,signedResult(changed,terminal()),f.gate);
  f.client.reconcileAccounting(request.request_id);
  expect(f.client.view(request.request_id).base_accounting?.state).toBe('applied');
});

describe('an authenticated empty guide', () => {
  /**
   * A house with nothing to say still says it, and says it signed.
   *
   * world-capabilities fetches the guide, checks its digest against the one the
   * manifest declares, and checks UTF-8 — it has always accepted a zero-byte
   * body whose digest matches. The selection copy refused the same bytes, so
   * the two halves of one path disagreed about whether "the house published an
   * empty guide" is a thing that can happen. It is: the digest is what makes it
   * authentic, and the digest of nothing is a perfectly good digest.
   *
   * The negative cases are the reason the positive one is safe: emptiness is
   * accepted only where the digest still has to match, never as a way around
   * carrying a guide at all.
   */
  // An empty guide is only authentic if the MANIFEST says the guide is empty —
  // the check is two-sided: the digest must be the one the board declares AND
  // the bytes must hash to it. So this is a whole coherent capabilities set,
  // not `selection` with two fields swapped; getting that wrong is how a test
  // "passes" while proving something else.
  const EMPTY = new Uint8Array(0);
  const emptyDigest = cidFromCanonical(EMPTY);
  const emptyManifest = JSON.parse(JSON.stringify(caps.manifest)) as typeof caps.manifest;
  (emptyManifest.world_interaction as Record<string, Record<string, unknown>>).guide!.sha256 = emptyDigest;
  const emptyManifestBytes = new TextEncoder().encode(JSON.stringify(emptyManifest));
  const emptyRevision = cidFromCanonical(emptyManifestBytes);
  const emptyProofCore = { house, manifestDigest: emptyRevision, signedAt: 900 };
  const emptyProofBytes = canonicalWorldCore(popclaw.world.ManifestProof, { ...emptyProofCore,
    authoritySignature: nacl.sign.detached(
      worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1', canonicalWorldCore(popclaw.world.ManifestProof, emptyProofCore)),
      authorityKey.secretKey) });
  const emptyGuide = (over: Partial<ActionSelectionEvidenceV1> = {}): ActionSelectionEvidenceV1 => ({
    ...selection, capabilityRevision: emptyRevision, manifestBytes: emptyManifestBytes, proofBytes: emptyProofBytes,
    guideBytes: EMPTY, guideDigest: emptyDigest, ...over,
  });

  it('is accepted when its digest is the digest of nothing', () => {
    const copied = copyActionSelectionEvidence(emptyGuide());
    expect(copied.guideBytes).toHaveLength(0);
    expect(copied.guideDigest).toBe(emptyDigest);
  });

  it('is refused when the digest belongs to some other guide', () => {
    // The whole point: empty is allowed, unauthenticated is not. This carries
    // the real guide's digest with no guide behind it.
    expect(() => copyActionSelectionEvidence(emptyGuide({ guideDigest: selection.guideDigest })))
      .toThrow('GUIDE_DIGEST_MISMATCH');
    // …and the mirror: a real guide's bytes under a board that declares empty.
    expect(() => copyActionSelectionEvidence(emptyGuide({ guideBytes: selection.guideBytes })))
      .toThrow('GUIDE_DIGEST_MISMATCH');
  });

  it('does not extend the same licence to the manifest or the proof', () => {
    // Those two are what the digest and the signature are computed over; an
    // empty one cannot mean anything, and relaxing the floor for the guide must
    // not have relaxed it for them.
    expect(() => copyActionSelectionEvidence({ ...selection, manifestBytes: new Uint8Array(0) }))
      .toThrow('ACTION_CONTEXT_SIZE_LIMIT');
    expect(() => copyActionSelectionEvidence({ ...selection, proofBytes: new Uint8Array(0) }))
      .toThrow('ACTION_CONTEXT_SIZE_LIMIT');
  });
});
