import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { WorldActionClient, ACTION_SELECTION_PROFILE, type ActionSelectionEvidenceV1 } from '../../../src/world/action-client.js';
import { WorldOwnerActionAuthorityStore } from '../../../src/world/world-owner-action-authority.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';

import { prepareActionReceiptJournal, ACTION_RECEIPT_SCHEMA_FINGERPRINT } from '../../../src/world/action-receipt-journal.js';
import { canonicalWorldCore, worldSigningInput } from '../../../src/world/action-wire.js';
const actor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(91));
const authorityKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(92));
const actorId = bs58.encode(actor.publicKey), houseKey = bs58.encode(authorityKey.publicKey);
const house = { origin: 'https://manual.invalid', houseKey, incarnation: 'inc1' };
let revision = 'a'.repeat(64);
const partition = {origin:house.origin,actorId,storeId:'owner-test',layoutVersion:1 as const};
const dirs: string[] = [], handles: LocalHostDb[] = [], utf8 = new TextEncoder();
function capabilities(): TrustedWorldCapabilities {
  const guide = 'The operator explicitly chooses to join.';
  const entry = { schema_version: 1, transport: 'house', signer: 'user', description: 'Join a world',
    result_attachments:{allowed:[],required_on_success:[]},consistency:'none',
    params_schema: { type: 'object', properties: { world: { type: 'string' }, choice: { type: 'object' } }, required: ['world'], additionalProperties: false }, result_schema: { type: 'object' } };
  const manifest = {
    house_session:{version:1,endpoint:'/v1/house-session',ack_pubkey:Buffer.from(authorityKey.publicKey).toString('hex'),operations:['enter','renew','leave']},
    world_interaction:{version:1,actions:{status_endpoint:'/v1/world-actions/status',result_authority_pubkey:houseKey,kinds:['neutral.join','neutral.other'],attachments:[]},guide:{path:'/v1/guide.md',sha256:cidFromCanonical(utf8.encode(guide)),revision:'guide1'}},
    intent_kinds:[{...entry,kind:'neutral.join'},{...entry,kind:'neutral.other'}],
  };
  revision = cidFromCanonical(utf8.encode(JSON.stringify(manifest)));
  return {house,capabilityRevision:revision,guide,manifest};
}
function selection(caps: TrustedWorldCapabilities | null, kind: string): ActionSelectionEvidenceV1 {
  if (!caps?.manifest.world_interaction) throw new Error('CAPABILITY_CONTEXT_INCOMPLETE');
  const row = (caps.manifest.intent_kinds as Record<string,unknown>[]).find(r=>r.kind===kind)!;
  const proofCore = {house:caps.house,manifestDigest:caps.capabilityRevision,signedAt:900};
  return {profile:ACTION_SELECTION_PROFILE,house:caps.house as typeof house,actorId,capabilityRevision:caps.capabilityRevision,kind,schemaVersion:1,resultAuthorityKey:houseKey,
    manifestBytes:utf8.encode(JSON.stringify(caps.manifest)),proofBytes:canonicalWorldCore(popclaw.world.ManifestProof,{...proofCore,authoritySignature:nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_MANIFEST_PROOF_V1',canonicalWorldCore(popclaw.world.ManifestProof,proofCore)),authorityKey.secretKey)}),
    guideBytes:utf8.encode(caps.guide),guideDigest:(caps.manifest.world_interaction as {guide:{sha256:string}}).guide.sha256,
    paramsSchema:row?.params_schema as Record<string,unknown>,resultSchema:row?.result_schema as Record<string,unknown>,allowed:[],requiredOnSuccess:[],consistency:'none'};
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'world-owner-authority-')); dirs.push(dir); const path = join(dir, 'host.db');
  let db = new LocalHostDb(path); handles.push(db);
  db.execute('CREATE TABLE execution_partition_identity_v1(singleton INTEGER PRIMARY KEY,actor_id TEXT,origin TEXT,store_id TEXT,layout_version INTEGER)');
  db.execute('INSERT INTO execution_partition_identity_v1 VALUES(1,?,?,?,1)',[actorId,house.origin,partition.storeId]);
  prepareActionReceiptJournal({executionDb:db,expectedPartition:partition,expectedSchemaFingerprint:ACTION_RECEIPT_SCHEMA_FINGERPRINT});
  let now = 1000, caps: TrustedWorldCapabilities | null = capabilities();
  const abort = new AbortController(), gate = { origin: house.origin, signal: abort.signal, isActive: () => !abort.signal.aborted };
  const signer = new MasterKeySigner({ ...actor, seed: actor.secretKey.slice(0, 32), popclawId: actorId });
  const push = vi.fn(async (_bytes: Uint8Array) => ({}));
  const captureSelectedActionContext = (kind:string) => ({evidence:selection(caps,kind),assertCurrent() {if(abort.signal.aborted) throw new Error('ACTION_GATE_CLOSED'); const value = selection(caps,kind); if(value.guideDigest !== cidFromCanonical(value.guideBytes)) throw new Error('GUIDE_DIGEST_MISMATCH');}});
  const storeOptions = () => ({ db, expectedPartition:partition,captureSelectedActionContext,house: { ...house }, actorId, capabilities: () => caps, now: () => now });
  const store = () => new WorldOwnerActionAuthorityStore(storeOptions());
  const clientOptions = () => ({ db, expectedPartition:partition,captureSelectedActionContext,house, actorId, signer, capabilities: () => caps!,
    captureSession: () => ({ gate, sessionId: 'session1', fence: '1', installationId: 'install1', leaseExpiresAt: 5000 }),
    push, controlRead: () => gate, readStatus: vi.fn(), now: () => now });
  const client = () => new WorldActionClient(clientOptions());
  const input = () => ({ house: house.origin, kind: 'neutral.join', params: { world: 'world1', choice: { color: 'blue', seats: 1 } }, expected_capability_revision: revision });
  const grant = (jobId = 'human_command1') => ({ jobId, input: input(), expiresAt: 1300 });
  const reopen = () => { db.close(); db = new LocalHostDb(path); handles.push(db); };
  return { get db() { return db; }, get now() { return now; }, set now(value) { now = value; }, get caps() { return caps; }, set caps(value) { caps = value; },
    signer, abort, push, store, storeOptions, client, clientOptions, input, grant, reopen };
}
afterEach(() => { vi.restoreAllMocks(); handles.splice(0).forEach(db => db.close()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('trusted operator single-action authority', () => {
  it('joins without prior participation, persists one request slot and retries original signed bytes after reopen', async () => {
    const f = fixture(); let store = f.store(); const grant = f.grant(), authority = store.reserve(grant);
    expect(store.reserve(grant).reservationId).toBe(authority.reservationId);
    expect(authority.executionReference).toEqual({ kind: 'owner_action', reservationId: authority.reservationId });
    expect(Object.isFrozen(authority.executionReference)).toBe(true);
    expect(() => Object.assign(authority.executionReference, { reservationId: 'changed' })).toThrow();
    f.push.mockImplementation(async bytes => {
      const env = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload);
      expect(store.hasRequest(env.eventId)).toBe(true);
      expect(store.reservations()[0]!.request_id).toBe(env.eventId);
      return {};
    });
    const result = await f.client().invoke(f.input(), authority);
    expect(result.status).toBe('unknown'); store.settle(result.request_id, 'unknown');
    const bytes = f.push.mock.calls[0]![0]; f.reopen(); store = f.store();
    const recovered = store.reserve(grant); expect(recovered.reservationId).toBe(authority.reservationId);
    const restored = store.authority(authority.reservationId), inspectInput = vi.fn(restored.assertInput);
    expect(restored.executionReference).toEqual(authority.executionReference);
    await f.client().retry(result.request_id, { ...restored, assertInput: inspectInput });
    expect(inspectInput).toHaveBeenCalledWith(f.input());
    expect([...f.push.mock.calls[1]![0]]).toEqual([...bytes]);
    expect(store.reservations()).toHaveLength(1);
    expect(f.db.queryOne("SELECT name FROM sqlite_master WHERE name='world_participation_policy'")).toBeNull();
  });
  it('reports an identical earlier request as unresolved until it settles, and never one that never left', async () => {
    // What the owner confirmation dialog asks before asking again. A twin that
    // is still open makes the next confirmation a SECOND action, not a retry.
    const f = fixture(), store = f.store();
    expect(store.unresolvedRequests(f.input())).toEqual([]);
    // Reserved but never sent: no request id, so nothing was ever asked of the
    // house and there is nothing to query. Not an unresolved REQUEST.
    const authority = store.reserve(f.grant());
    expect(store.reservations()[0]!.request_id).toBeNull();
    expect(store.unresolvedRequests(f.input())).toEqual([]);
    const sent = await f.client().invoke(f.input(), authority);
    expect(sent.status).toBe('unknown');
    expect(store.unresolvedRequests(f.input())).toEqual([sent.request_id]);
    // Key order is canonicalised, so a reordered but identical input matches.
    const reordered = f.input(); reordered.params.choice = { seats: 1, color: 'blue' };
    expect(store.unresolvedRequests(reordered)).toEqual([sent.request_id]);
    // A different input is a different action and has no twin here.
    expect(store.unresolvedRequests({ ...f.input(), kind: 'neutral.other' })).toEqual([]);
    expect(store.unresolvedRequests({ ...f.input(), params: { world: 'world2' } })).toEqual([]);
    // But the capability revision is NOT part of what the owner means by "the
    // same thing": a house rotating its capability document between the first
    // ask and the second must not make the earlier request invisible.
    expect(store.unresolvedRequests({ ...f.input(), expected_capability_revision: 'f'.repeat(64) }))
      .toEqual([sent.request_id]);
    // `unknown` is still unresolved; a terminal status is not.
    store.settle(sent.request_id, 'unknown');
    expect(store.unresolvedRequests(f.input())).toEqual([sent.request_id]);
    store.settle(sent.request_id, 'succeeded');
    expect(store.unresolvedRequests(f.input())).toEqual([]);
  });
  it('seals canonical parameters and rejects other kinds, worlds, capability revisions and replacement payloads', async () => {
    const f = fixture(), store = f.store(), grant = f.grant(), authority = store.reserve(grant);
    grant.input.params.world = 'mutated_after_approval'; grant.input.params.choice.color = 'red'; grant.expiresAt = 1400;
    const reordered = f.input(); reordered.params.choice = { seats: 1, color: 'blue' };
    expect(() => authority.assertInput(reordered)).not.toThrow();
    for (const input of [grant.input, { ...f.input(), house: 'https://other.invalid' }, { ...f.input(), kind: 'neutral.other' },
      { ...f.input(), expected_capability_revision: 'b'.repeat(64) }]) {
      expect(() => authority.assertInput(input)).toThrow('OWNER_ACTION_INPUT_MISMATCH');
    }
    await expect(f.client().invoke(grant.input, authority)).rejects.toThrow('OWNER_ACTION_INPUT_MISMATCH');
    expect(f.push).not.toHaveBeenCalled();
    const first = await f.client().invoke(f.input(), authority);
    f.now = 1001;
    await expect(f.client().invoke(f.input(), authority, first.request_id)).rejects.toThrow('ACTION_AUTHORITY_REQUEST_MISMATCH');
    expect(f.push).toHaveBeenCalledOnce();
    expect(store.reservations()).toHaveLength(1);
    expect(f.db.queryAll('SELECT * FROM world_action_client_requests')).toHaveLength(1);
  });
  it('captures exact database and identity despite mutable constructor options and rejects foreign clients', async () => {
    const f = fixture(), other = fixture(), options = f.storeOptions(), store = new WorldOwnerActionAuthorityStore(options);
    options.db = other.db; options.house.incarnation = 'changed'; options.actorId = houseKey; options.capabilities = () => null;
    const authority = store.reserve(f.grant());
    expect(() => authority.assertBinding(f.db, house, actorId)).not.toThrow();
    expect(() => authority.assertBinding(other.db, house, actorId)).toThrow('OWNER_ACTION_BINDING_MISMATCH');
    for (const foreignHouse of [{ ...house, origin: 'https://other.invalid' }, { ...house, houseKey: actorId }, { ...house, incarnation: 'other' }]) {
      expect(() => authority.assertBinding(f.db, foreignHouse, actorId)).toThrow('OWNER_ACTION_BINDING_MISMATCH');
    }
    expect(() => authority.assertBinding(f.db, house, houseKey)).toThrow('OWNER_ACTION_BINDING_MISMATCH');
    expect(() => authority.record(other.db, 'b'.repeat(64))).toThrow('OWNER_ACTION_BINDING_MISMATCH');
    expect(() => new WorldActionClient({ ...f.clientOptions(), actorId: houseKey })).toThrow('ACTION_RECEIPT_PARTITION_REQUIRED');
    const foreignHouse = { ...house, incarnation: 'other' };
    await expect(new WorldActionClient({ ...f.clientOptions(), house: foreignHouse, capabilities: () => ({ ...f.caps!, house: foreignHouse }) }).invoke(f.input(), authority)).rejects.toThrow('ACTION_CONTEXT_MISMATCH');
    expect(f.push).not.toHaveBeenCalled(); expect(store.reservations()[0]!.request_id).toBeNull();
  });
  it('rechecks the verified guide and current capability binding without converting new capabilities into permission', () => {
    const f = fixture(), store = f.store(), authority = store.reserve(f.grant());
    const check = () => authority.check({ kind: 'neutral.join', validUntil: 1300 });
    const caps = f.caps!;
    f.caps = null; expect(check).toThrow('CAPABILITY_CONTEXT_INCOMPLETE');
    f.caps = { ...caps, guide: 'changed' }; expect(check).toThrow('GUIDE_DIGEST_MISMATCH');
    f.caps = { ...caps, manifest: {} }; expect(check).toThrow('CAPABILITY_CONTEXT_INCOMPLETE');
    f.caps = { ...caps, capabilityRevision: 'b'.repeat(64) }; expect(check).toThrow('CAPABILITY_REVISION_MISMATCH');
    f.caps = { ...caps, house: { ...house, incarnation: 'other' } }; expect(check).toThrow('CAPABILITY_REVISION_MISMATCH');
    f.caps = caps; expect(check).not.toThrow();
    expect(() => store.reserve({ ...f.grant(), input: { ...f.input(), kind: 'direct_message' } })).toThrow();
    expect(store.reservations()).toHaveLength(1);
  });
  it('has fixed short expiration and exact job identity; terminal results never refund or reopen the slot', async () => {
    const f = fixture(), store = f.store(), grant = f.grant();
    for (const expiresAt of [999, 1000, 1301]) expect(() => store.reserve({ ...grant, expiresAt })).toThrow('ACTION_EXPIRED');
    const authority = store.reserve(grant);
    expect(() => store.reserve({ ...grant, expiresAt: 1299 })).toThrow('OWNER_ACTION_JOB_CONFLICT');
    expect(() => store.reserve({ ...grant, input: { ...f.input(), params: { world: 'other' } } })).toThrow('OWNER_ACTION_JOB_CONFLICT');
    const result = await f.client().invoke(f.input(), authority);
    expect(() => authority.check({ kind: 'neutral.join', validUntil: 1300, requestId: 'c'.repeat(64) })).toThrow('ACTION_AUTHORITY_REQUEST_MISMATCH');
    store.settle(result.request_id, 'rejected');
    expect(() => store.reserve(grant)).toThrow('OWNER_ACTION_RESERVATION_TERMINAL');
    expect(() => authority.check({ kind: 'neutral.join', validUntil: 1300, requestId: result.request_id })).toThrow('OWNER_ACTION_RESERVATION_TERMINAL');
    expect(() => store.settle(result.request_id, 'unknown')).toThrow('RESULT_CONFLICT');
    expect(store.hasRequest(result.request_id)).toBe(true); expect(store.reservations()).toHaveLength(1);
    const second = store.reserve(f.grant('human_command2')); f.now = 1300;
    expect(() => second.check({ kind: 'neutral.join', validUntil: 1300 })).toThrow('ACTION_EXPIRED');
    expect(store.reservations()).toHaveLength(2);
  });
  it('rolls failed request association back with the client bytes while preserving the consumed operator slot', async () => {
    const f = fixture(), store = f.store(), authority = store.reserve(f.grant());
    const client = f.client();
    f.db.execute("CREATE TRIGGER fail_owner_link BEFORE UPDATE ON world_owner_action_reservations BEGIN SELECT RAISE(ABORT, 'link_disk_failure'); END");
    await expect(client.invoke(f.input(), authority)).rejects.toThrow('link_disk_failure');
    f.db.execute('DROP TRIGGER fail_owner_link');
    expect(f.push).not.toHaveBeenCalled(); expect(f.db.queryAll('SELECT * FROM world_action_client_requests')).toEqual([]);
    expect(store.reservations()).toHaveLength(1); expect(store.reservations()[0]!.request_id).toBeNull();
    await f.client().invoke(f.input(), store.authority(authority.reservationId));
    expect(f.push).toHaveBeenCalledOnce(); expect(store.reservations()).toHaveLength(1);
  });
  it('rolls the written association and its request back when the transaction fails after the association, and keeps the slot', async () => {
    const f = fixture(); let store = f.store(); const grant = f.grant(), authority = store.reserve(grant);
    const before = store.reservations()[0]!;
    // The association is the last durable write of the request transaction, so
    // "after it was written" is the production re-check that follows it. Drive
    // the real store write, prove it landed inside the transaction, then close
    // the session gate so that re-check aborts the enclosing transaction.
    let associated: string | null = null;
    const driven = { ...authority, record: (tx: HostDb, id: string) => {
      authority.record(tx, id);
      expect(tx.queryOne('SELECT request_id FROM world_owner_action_reservations WHERE reservation_id=?', [authority.reservationId])).toEqual({ request_id: id });
      expect(tx.queryOne('SELECT request_id FROM world_action_client_requests WHERE request_id=?', [id])).toEqual({ request_id: id });
      associated = id;
    } };
    const gate = { origin: house.origin, signal: f.abort.signal, isActive: () => associated === null };
    const session = () => ({ gate, sessionId: 'session1', fence: '1', installationId: 'install1', leaseExpiresAt: 5000 });
    await expect(new WorldActionClient({ ...f.clientOptions(), captureSession: session }).invoke(f.input(), driven)).rejects.toThrow('ACTION_GATE_CLOSED');
    const requested: string = associated!;
    expect(requested).toMatch(/^[0-9a-f]{64}$/);
    for (const stage of ['open', 'reopened']) {
      if (stage === 'reopened') { f.reopen(); store = f.store(); }
      expect(f.db.queryAll('SELECT * FROM world_action_client_requests')).toEqual([]);
      expect(store.reservations()).toEqual([{ ...before, request_id: null, status: 'reserved' }]);
      expect(store.hasRequest(requested)).toBe(false);
      expect(store.reserve(grant).reservationId).toBe(authority.reservationId);
      expect(f.push).not.toHaveBeenCalled();
    }
    const recovered = await f.client().invoke(f.input(), store.authority(authority.reservationId));
    expect(f.push).toHaveBeenCalledOnce();
    expect(store.reservations()).toEqual([{ ...before, request_id: recovered.request_id, status: 'reserved' }]);
  });
  it('rechecks G0 and capability changes around asynchronous signing before any egress', async () => {
    const f = fixture(), store = f.store(), authority = store.reserve(f.grant());
    const original = f.signer.sign.bind(f.signer);
    vi.spyOn(f.signer, 'sign').mockImplementation(async bytes => {
      const signature = await original(bytes); f.caps = { ...f.caps!, guide: 'changed_during_sign' }; return signature;
    });
    await expect(f.client().invoke(f.input(), authority)).rejects.toThrow('GUIDE_DIGEST_MISMATCH');
    expect(f.push).not.toHaveBeenCalled(); expect(store.reservations()[0]!.request_id).toBeNull();
    f.caps = capabilities(); vi.restoreAllMocks();
    f.abort.abort(); await expect(f.client().invoke(f.input(), authority)).rejects.toThrow('ACTION_GATE_CLOSED');
    expect(f.push).not.toHaveBeenCalled(); expect(store.reservations()).toHaveLength(1);
  });
  it('keeps the approved payload sealed while the caller mutates its object during signing', async () => {
    const f = fixture(), store = f.store(), authority = store.reserve(f.grant()), input = f.input();
    const original = f.signer.sign.bind(f.signer);
    vi.spyOn(f.signer, 'sign').mockImplementation(async bytes => {
      input.params.world = 'injected_world'; input.params.choice.color = 'red'; return original(bytes);
    });
    await f.client().invoke(input, authority);
    const envelope = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(f.push.mock.calls[0]![0]).payload);
    expect(JSON.parse(new TextDecoder().decode(envelope.intent!.params!))).toEqual(f.input().params);
    expect(store.reservations()).toHaveLength(1);
  });
  it('cannot expose an authority before its one operator slot is durable', () => {
    const f = fixture(), store = f.store();
    f.db.execute("CREATE TRIGGER fail_owner_reserve BEFORE INSERT ON world_owner_action_reservations BEGIN SELECT RAISE(ABORT, 'reserve_disk_failure'); END");
    expect(() => store.reserve(f.grant())).toThrow('reserve_disk_failure');
    expect(store.reservations()).toEqual([]);
    f.db.execute('DROP TRIGGER fail_owner_reserve');
    const authority = store.reserve(f.grant());
    expect(f.store().reserve(f.grant()).reservationId).toBe(authority.reservationId);
    expect(store.reservations()).toHaveLength(1);
  });
});
