import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { hostDbSlug } from '../../../src/ingress/host-slug.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import type { HouseResourceOptions } from '../../../src/runtime/house-lifecycle/resource-set.js';
import { WorldParticipation } from '../../../src/world/world-participation.js';
import { WorldReadiness } from '../../../src/world/world-readiness.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';
import { createWorldDirectDm, type WorldDirectDmOptions, type WorldDirectDmReference } from '../../../src/runtime/world-direct-dm.js';
import type { PushExecutionContext } from '../../../src/runtime/house-lifecycle/command-bus.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

const pair = (n: number) => nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(n));
const actor = pair(93), recipient = pair(94), authority = pair(95), actorId = bs58.encode(actor.publicKey), recipientId = bs58.encode(recipient.publicKey);
const house = { origin: 'https://dm-target.invalid', houseKey: bs58.encode(authority.publicKey), incarnation: 'inc_1' };
const defaultHouse = house;
const home = 'https://different-home.invalid', participationId = 'participation1', revision = 'a'.repeat(64);
const stamp = (n: number) => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

// Resident ownership and bus/HTTP are real; the unrelated ingress factory is
// suppressed so this unit never opens SSE, inbox, ranger or provider traffic.
vi.mock('../../../src/runtime/house-lifecycle/resource-set.js', () => ({ createHouseStreamFactory: () => ({ open: () => ({ stop: async () => {} }) }) }));
function fixture(house = defaultHouse, commandTimeoutMs = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'world-direct-dm-'));
  let now = Math.floor(Date.now() / 1000), supported = true;
  let db = new LocalHostDb(join(dir, 'house.db')), hostDb = new LocalHostDb(join(dir, 'host.db'));
  const signer = new MasterKeySigner({ ...actor, seed: actor.secretKey.slice(0, 32), popclawId: actorId });
  const receiver = new MasterKeySigner({ ...recipient, seed: recipient.secretKey.slice(0, 32), popclawId: recipientId });
  const signed = vi.spyOn(signer, 'sign'), sealed = vi.spyOn(signer, 'sealDm');
  const guide = 'Bound direct-message guide';
  let caps: TrustedWorldCapabilities | null = { house, capabilityRevision: revision, guide, manifest: { intent_kinds: [], event_kinds: [],
    world_interaction: { version: 1, endpoints: { actions_status: '/v1/world-actions/status', world_stream: '/v1/world-stream' }, features: { world_actions: 1 },
      result_authority_pubkey: house.houseKey, initial_public_scopes: [], private_message_version: 1,
      guide: { path: '/v1/guide.md', revision: 'guide1', sha256: cidFromCanonical(new TextEncoder().encode(guide)) } } } };
  let policy = new WorldParticipation(db, house, actorId, participationId);
  const readinessFor = () => new WorldReadiness(db, house, actorId, new ScopedStreamJournal(db, house, bytes => JSON.parse(new TextDecoder().decode(bytes))));
  let readiness = readinessFor();
  const runtimeFor = () => {
    const runtime = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db: hostDb, signer, origins: [home, house.origin], clock: () => now * 1000, commandTimeoutMs,
      fetch: async () => { throw new Error('UNEXPECTED_DISCOVERY_OR_CONTROL_NETWORK'); } });
    const store = { baseUrl: house.origin, slug: hostDbSlug(house.origin), db, executionDb: db, dbPath: join(dir, 'house.db'), cache: new WorldFeedCache({ db }) };
    runtime.configureResources({ stores: [store], openStore: async () => store, worldStreamMode: false,
      host: {} as HouseResourceOptions['host'], recipientPopclawId: actorId, isOfficialActor: () => false });
    return runtime;
  };
  let runtime = runtimeFor();
  hostDb.execute(`INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase,session_id,house_revision,lease_expires_at,ack_key_hex)
    VALUES(?,'installation1',3,'enabled','connected','session1',17,?,?)`, [house.origin, now + 3600, Buffer.from(authority.publicKey).toString('hex')]);
  expect(policy.mergeAuthenticatedDescriptor({ version: 1, house: { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation }, actor_id: actorId,
    participation_id: participationId, revision: '1', window: { id: 'window1', opens_at: stamp(now - 10), closes_at: stamp(now + 1000) },
    action_groups: [{ id: 'group1', intent_kinds: ['neutral.speak'], control_reset: 'explicit', channels: ['intent', 'direct_message'] }],
    opportunities: [{ id: 'opportunity1', action_group_id: 'group1', budget_group_id: 'messages', budget_window_id: 'window1',
      not_before: stamp(now - 10), expires_at: stamp(now + 1000), dedupe_key: 'reply_slot', channels: ['intent', 'direct_message'] }],
    budgets: [{ id: 'messages', window_id: 'window1', resource: 'outbound_message', suggested_limit: 3 }], dm_response_slot_key: 'reply_slot',
  }, { source: 'verified_action_result', trustedCurrent: true, capabilityRevision: revision }, stamp(now)).ok).toBe(true);
  expect(policy.configureCeilings({ aggregate: { agent_turn: 3, outbound_message: 3, owner_notice: 1 },
    rolling: { seconds: 3600, limits: { agent_turn: 3, outbound_message: 3, owner_notice: 1 } }, count_successful_owner_messages: false }).ok).toBe(true);
  expect(policy.grant({ allowed_action_kinds: ['neutral.speak'], expires_at: stamp(now + 1000), max_agent_turns: 3, max_outbound_messages: 3, max_owner_notices: 1 }).ok).toBe(true);
  readiness.recordPrivateDescriptor(participationId);
  const invocation = { opportunityId: 'opportunity1', kind: 'direct_message', channel: 'direct_message' as const, message: true,
    contextValidUntil: stamp(now + 300), expectedCapabilityRevision: revision };
  const reserved = policy.reserveBatch({ jobId: 'job1', turnId: 'turn1', invocations: [invocation] }, stamp(now));
  if (!reserved.ok) throw new Error(reserved.code);
  const outcome = reserved.value[0]!; if (!outcome.ok) throw new Error(outcome.code);
  const input = { reservationId: outcome.reservation.reservationId, jobId: 'job1', invocation, recipient: recipientId, text: 'A private autonomous message', replyToEventId: 'b'.repeat(64) };
  const options = (): WorldDirectDmOptions => ({ db, policy, house, actorId, participationId, houses: runtime,
    gate: runtime.captureSessionCommandContext(house.origin).gate, signer, nickname: 'Captured sender', capabilities: () => caps,
    readiness, now: () => now, supportsBackgroundTurns: () => supported });
  let adapter = createWorldDirectDm(options());
  cleanup.push(async () => { adapter.stop(); await runtime.stop(); await adapter.whenIdle(); db.close(); hostDb.close(); rmSync(dir, { recursive: true, force: true }); });
  const reopen = async () => {
    // Simulate a crash boundary after the attempt settled locally: no adapter
    // stop hook rewrites unknown into an explicit local cancellation.
    await runtime.stop(); await adapter.whenIdle(); db.close(); hostDb.close();
    db = new LocalHostDb(join(dir, 'house.db')); hostDb = new LocalHostDb(join(dir, 'host.db'));
    policy = new WorldParticipation(db, house, actorId, participationId); readiness = readinessFor(); runtime = runtimeFor(); adapter = createWorldDirectDm(options());
  };
  const disable = () => hostDb.execute("UPDATE house_participation SET desired='disabled',phase='disconnected',op_seq=op_seq+1 WHERE house_origin=?", [house.origin]);
  return { get db() { return db; }, get hostDb() { return hostDb; }, get runtime() { return runtime; }, get adapter() { return adapter; }, get policy() { return policy; },
    get readiness() { return readiness; }, get now() { return now; }, set now(value: number) { now = value; }, set supported(value: boolean) { supported = value; },
    get caps() { return caps; }, set caps(value) { caps = value; }, signer, signed, sealed, receiver, input, options, reopen, disable };
}

it('uses the captured target and real encrypted signing, links exact bytes before push, and records transport acceptance only', async () => {
  const f = fixture(), verify = vi.fn(async () => ({ status: 'verified' as const, nickname: 'Recipient', sigil: 'sigil1' }));
  const adapter = createWorldDirectDm({ ...f.options(), verifyRecipient: verify });
  const push = vi.spyOn(f.runtime.egress, 'pushTo').mockImplementation(async (slug, bytes) => {
    expect(slug).toBe(hostDbSlug(house.origin));
    const payload = popclaw.identity.SignedPayload.decode(bytes), env = popclaw.event.EventEnvelope.decode(payload.payload), dm = env.directMessage!;
    expect(env.actor).toMatchObject({ popclawId: actorId, nickname: 'Captured sender' });
    expect(env.prevEventId).toBe(f.input.replyToEventId); expect(env.lorehouse).toBe('');
    expect(dm).toMatchObject({ fromPopclawId: actorId, toPopclawId: recipientId });
    expect(dm.ciphertext!.length).toBeGreaterThan(0); expect(dm.nonce!.length).toBe(24); expect(dm.mediaCiphertext!.length).toBe(0);
    expect(nacl.sign.detached.verify(payload.payload, payload.signature, payload.signerPubkey)).toBe(true);
    expect(nacl.sign.detached.verify(canonicalizeEnvelope(env), env.signature, actor.publicKey)).toBe(true);
    expect(f.receiver.openDm(dm, actorId)).toMatchObject({ ok: true, plaintext: f.input.text });
    expect(f.policy.reservations()[0]!.requestId).toBe(env.eventId);
    const row = f.db.queryOne<{ signed_bytes: Uint8Array; dispatch_intent: number }>('SELECT signed_bytes,dispatch_intent FROM world_direct_dm_attempts WHERE event_id=?', [env.eventId])!;
    expect(new Uint8Array(row.signed_bytes)).toEqual(bytes); expect(row.dispatch_intent).toBe(1);
    return { status: 200, operationId: 'operation1', state: 'done' };
  });
  const view = await adapter.send(f.input);
  expect(view).toMatchObject({ state: 'accepted', code: 'HOUSE_TRANSPORT_ACCEPTED', operationId: 'operation1', transportStatus: 200 });
  expect(verify).toHaveBeenCalledWith(recipientId, hostDbSlug(house.origin));
  expect(push).toHaveBeenCalledOnce(); expect(f.signed).toHaveBeenCalledTimes(2); expect(f.sealed).toHaveBeenCalledOnce();
  expect(f.policy.reservations()[0]!.status).toBe('reserved'); expect(f.policy.usage()).toHaveLength(2);
  expect(await adapter.send(f.input)).toEqual(view); expect(push).toHaveBeenCalledOnce();
  adapter.stop(); await adapter.whenIdle();
});

it('retains an unknown attempt across reopen without another encryption, signature or push', async () => {
  const f = fixture(); const push = vi.spyOn(f.runtime.egress, 'pushTo').mockRejectedValue(new Error('ACK_LOST'));
  const first = await f.adapter.send(f.input);
  expect(first).toMatchObject({ state: 'unknown', code: 'DM_TRANSPORT_UNKNOWN' });
  expect(first.eventId).toMatch(/^[0-9a-f]{64}$/); expect(push).toHaveBeenCalledOnce();
  const raw = f.db.queryOne<{ signed_bytes: Uint8Array }>('SELECT signed_bytes FROM world_direct_dm_attempts')!.signed_bytes;
  await f.reopen(); const replayPush = vi.spyOn(f.runtime.egress, 'pushTo');
  expect(await f.adapter.send(f.input)).toEqual(first);
  expect(await f.adapter.reconcile(f.input.reservationId)).toEqual(first);
  expect(f.db.queryOne<{ signed_bytes: Uint8Array }>('SELECT signed_bytes FROM world_direct_dm_attempts')!.signed_bytes).toEqual(raw);
  expect(replayPush).not.toHaveBeenCalled(); expect(f.signed).toHaveBeenCalledTimes(2); expect(f.sealed).toHaveBeenCalledOnce();
  await expect(f.adapter.send({ ...f.input, text: 'Changed retry' })).rejects.toThrow('DM_INPUT_CONFLICT');
});

it.each(['resolve', 'identity', 'verify', 'inner_signature', 'outer_signature'] as const)('fences every %s continuation after logout, revoke, takeover or expiry', async stage => {
  for (const change of ['logout', 'revoke', 'takeover', 'expiry'] as const) {
    const f = fixture(), held = deferred<void>(), started = vi.fn();
    const pause = async () => { started(); await held.promise; };
    const originalSign = MasterKeySigner.prototype.sign.bind(f.signer), originalId = MasterKeySigner.prototype.popclawId.bind(f.signer);
    let signCalls = 0;
    if (stage === 'identity') vi.spyOn(f.signer, 'popclawId').mockImplementation(async () => { await pause(); return originalId(); });
    if (stage === 'inner_signature' || stage === 'outer_signature') f.signed.mockImplementation(async bytes => {
      if (++signCalls === (stage === 'inner_signature' ? 1 : 2)) await pause(); return originalSign(bytes);
    });
    const adapter = createWorldDirectDm({ ...f.options(),
      ...(stage === 'resolve' ? { resolveRecipient: async () => { await pause(); return { kind: 'resolved' as const, popclawId: recipientId, nickname: 'Recipient', sigil: 'sigil1' }; } } : {}),
      ...(stage === 'verify' ? { verifyRecipient: async () => { await pause(); return { status: 'verified' as const, nickname: 'Recipient', sigil: 'sigil1' }; } } : {}),
    });
    cleanup.push(async () => { adapter.stop(); await adapter.whenIdle(); });
    const push = vi.spyOn(f.runtime.egress, 'pushTo').mockResolvedValue({ status: 200 });
    const input = { ...f.input, recipient: stage === 'resolve' ? 'Recipient' : recipientId };
    const sending = adapter.send(input); await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    if (change === 'logout') f.disable();
    if (change === 'revoke') f.policy.revoke(['neutral.speak']);
    if (change === 'takeover') f.policy.takeover({ whole: true });
    if (change === 'expiry') f.now += 300;
    held.resolve();
    expect(await sending).toMatchObject({ state: 'rejected' }); expect(push).not.toHaveBeenCalled();
    expect(f.policy.reservations()[0]!.requestId).toBeUndefined();
    const signatureCount = stage === 'inner_signature' ? 1 : stage === 'outer_signature' ? 2 : 0;
    expect(f.signed).toHaveBeenCalledTimes(signatureCount);
    expect(await adapter.send(input)).toMatchObject({ state: 'rejected' }); expect(f.signed).toHaveBeenCalledTimes(signatureCount);
  }
});

it('captures all input before the first await and rejects a changed duplicate while the original is pending', async () => {
  const f = fixture(), held = deferred<void>(), verify = vi.fn(async () => { await held.promise; return { status: 'unknown' as const, sigil: 'sigil1' }; });
  const adapter = createWorldDirectDm({ ...f.options(), verifyRecipient: verify });
  cleanup.push(async () => { adapter.stop(); await adapter.whenIdle(); });
  const original = structuredClone(f.input);
  const push = vi.spyOn(f.runtime.egress, 'pushTo').mockImplementation(async (_slug, bytes) => {
    const dm = popclaw.event.EventEnvelope.decode(popclaw.identity.SignedPayload.decode(bytes).payload).directMessage!;
    expect(f.receiver.openDm(dm, actorId)).toMatchObject({ ok: true, plaintext: original.text });
    expect(dm.toPopclawId).toBe(recipientId); return { status: 200 };
  });
  const sending = adapter.send(f.input);
  f.input.text = 'Changed after call'; f.input.recipient = actorId; f.input.invocation.opportunityId = 'changed';
  await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
  await expect(adapter.send(f.input)).rejects.toThrow('DM_INPUT_CONFLICT');
  expect(await adapter.send(original)).toMatchObject({ state: 'unknown' });
  held.resolve(); expect(await sending).toMatchObject({ state: 'accepted' }); expect(push).toHaveBeenCalledOnce();
});

it('rolls signed bytes and policy association back together when the journal write fails, without pushing or restarting', async () => {
  const f = fixture(), push = vi.spyOn(f.runtime.egress, 'pushTo');
  f.db.execute("CREATE TRIGGER reject_dm_bytes BEFORE UPDATE OF signed_bytes ON world_direct_dm_attempts BEGIN SELECT RAISE(ABORT,'injected signed store failure'); END");
  const first = await f.adapter.send(f.input);
  expect(first).toMatchObject({ state: 'rejected', code: 'DM_PREPARATION_FAILED' });
  expect(f.policy.reservations()[0]!.requestId).toBeUndefined(); expect(f.policy.usage()).toHaveLength(2);
  expect(f.db.queryOne('SELECT signed_bytes,event_id,dispatch_intent FROM world_direct_dm_attempts')).toEqual({ signed_bytes: null, event_id: null, dispatch_intent: 0 });
  expect(push).not.toHaveBeenCalled(); expect(f.signed).toHaveBeenCalledTimes(2);
  f.db.execute('DROP TRIGGER reject_dm_bytes'); expect(await f.adapter.send(f.input)).toEqual(first);
  expect(f.signed).toHaveBeenCalledTimes(2); expect(push).not.toHaveBeenCalled();
});

it.each(['flags', 'image', 'file', 'params', 'house', 'authority'] as const)('rejects model %s before any attempt or private-key operation', async field => {
  const f = fixture(), push = vi.spyOn(f.runtime.egress, 'pushTo');
  await expect(f.adapter.send({ ...f.input, [field]: '/not-opened/local-file' })).rejects.toThrow('DM_INPUT_INVALID');
  expect(f.db.queryAll('SELECT * FROM world_direct_dm_attempts')).toEqual([]);
  expect(f.signed).not.toHaveBeenCalled(); expect(f.sealed).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
});

it.each([actorId, 'not-a-public-key', bs58.encode(new Uint8Array(31).fill(1))])('rejects unusable/self recipient %s without an outgoing signed event', async to => {
  const f = fixture(), push = vi.spyOn(f.runtime.egress, 'pushTo');
  expect(await f.adapter.send({ ...f.input, recipient: to })).toMatchObject({ state: 'rejected' });
  expect(push).not.toHaveBeenCalled(); expect(f.signed).not.toHaveBeenCalled();
  expect(f.policy.reservations()[0]!.requestId).toBeUndefined();
});

it('retains the actual bus pending operation and only reads it during recovery', async () => {
  const f = fixture(), push = vi.spyOn(f.runtime.egress, 'pushTo');
  const first = await f.adapter.send(f.input);
  expect(first).toMatchObject({ state: 'unknown', code: 'DM_TRANSPORT_UNKNOWN', transportStatus: 0 });
  expect(first.operationId).toBeTruthy(); expect(push).toHaveBeenCalledOnce();
  expect(f.runtime.getPushOperation(first.operationId!)?.state).toBe('pending');
  const command = f.hostDb.queryOne<{ payload_bytes: Uint8Array; effect_json: string }>('SELECT payload_bytes,effect_json FROM house_lifecycle_commands WHERE request_id=?', [first.operationId!])!;
  expect(JSON.parse(command.effect_json)).toMatchObject({ kind: 'world_direct_dm', requestId: first.eventId, reservationId: f.input.reservationId });
  expect(command.payload_bytes).toEqual(f.db.queryOne<{ signed_bytes: Uint8Array }>('SELECT signed_bytes FROM world_direct_dm_attempts')!.signed_bytes);
  expect(await f.adapter.reconcile(f.input.reservationId)).toEqual(first); expect(await f.adapter.send(f.input)).toEqual(first);
  expect(push).toHaveBeenCalledOnce(); expect(f.signed).toHaveBeenCalledTimes(2);
  expect(f.runtime.resident.authority.captureEpoch()).toBeNull();
});

function contextFor(operationId = 'operation1') {
  const abort = new AbortController();
  const context: PushExecutionContext = { operationId, opSeq: 3, sessionId: 'session1', houseRevision: 17,
    ackKeyHex: Buffer.from(authority.publicKey).toString('hex'), installationId: 'installation1', ownerEpoch: 1,
    deadlineAt: Date.now() + 10000, signal: abort.signal, isActive: () => !abort.signal.aborted,
    authorizeSend() { if (!this.isActive()) throw new Error('STALE_OPERATION'); } };
  return { context, abort };
}
async function prepared() {
  const f = fixture(); vi.spyOn(f.runtime.egress, 'pushTo').mockRejectedValue(new Error('ACK_LOST'));
  const sent = await f.adapter.send(f.input);
  const bytes = new Uint8Array(f.db.queryOne<{ signed_bytes: Uint8Array }>('SELECT signed_bytes FROM world_direct_dm_attempts')!.signed_bytes);
  const ref: WorldDirectDmReference = { version: 1, kind: 'world_direct_dm', requestId: sent.eventId!, participationId, reservationId: f.input.reservationId, jobId: f.input.jobId };
  return { f, ref, bytes };
}

it('reconstructs owner authorization from the durable row and binds the one actual bus operation', async () => {
  const { f, ref, bytes } = await prepared(), { context } = contextFor();
  const guard = await f.adapter.authorizePersisted(ref, bytes, context); guard();
  expect(f.adapter.view(ref.reservationId).operationId).toBe(context.operationId);
  await expect(f.adapter.authorizePersisted(ref, bytes, contextFor('operation2').context)).rejects.toThrow('DM_EFFECT_JOURNAL_MISMATCH');
  f.policy.revoke(['neutral.speak']); expect(guard).toThrow('GRANT_MISSING');
  expect(f.policy.reservations()[0]!.status).toBe('reserved');
});

it.each(['bytes', 'job', 'request', 'session', 'pin', 'cancel', 'no_dispatch'] as const)('rejects owner reconstruction with altered %s', async changed => {
  const { f, ref, bytes } = await prepared(), { context } = contextFor();
  if (changed === 'bytes') bytes[0] = bytes[0]! ^ 1;
  if (changed === 'job') (ref as { jobId: string }).jobId = 'foreign';
  if (changed === 'request') (ref as { requestId: string }).requestId = 'e'.repeat(64);
  if (changed === 'session') (context as { sessionId: string }).sessionId = 'foreign';
  if (changed === 'pin') (context as { ackKeyHex: string }).ackKeyHex = '00'.repeat(32);
  if (changed === 'cancel') f.adapter.cancel(ref.reservationId);
  if (changed === 'no_dispatch') f.db.execute('UPDATE world_direct_dm_attempts SET dispatch_intent=0');
  await expect(f.adapter.authorizePersisted(ref, bytes, context)).rejects.toThrow();
  expect(f.adapter.view(ref.reservationId).operationId).toBeUndefined();
});

it('does not claim an operation if the owner stops while its store lookup is awaiting', async () => {
  const { f, ref, bytes } = await prepared(), { context, abort } = contextFor(), held = deferred<void>();
  const original = f.runtime.storeForCommand.bind(f.runtime);
  vi.spyOn(f.runtime, 'storeForCommand').mockImplementation(async origin => { await held.promise; return original(origin); });
  const preparing = f.adapter.authorizePersisted(ref, bytes, context);
  abort.abort(); held.resolve(); await expect(preparing).rejects.toThrow('STALE_OPERATION');
  expect(f.adapter.view(ref.reservationId).operationId).toBeUndefined();
});

it('preserves a late accepted transport receipt after local cancellation without creating a signed business success', async () => {
  const f = fixture(), held = deferred<{ status: number; operationId: string; state: 'done' }>();
  const push = vi.spyOn(f.runtime.egress, 'pushTo').mockReturnValue(held.promise);
  const sending = f.adapter.send(f.input); await vi.waitFor(() => expect(push).toHaveBeenCalledOnce());
  f.adapter.cancel(f.input.reservationId); held.resolve({ status: 200, operationId: 'operation1', state: 'done' });
  expect(await sending).toMatchObject({ state: 'cancel_pending', operationId: 'operation1', transportStatus: 200 });
  expect(f.policy.reservations()[0]!.status).toBe('reserved'); expect(f.policy.usage()).toHaveLength(2);
  expect(await f.adapter.send(f.input)).toMatchObject({ state: 'cancel_pending' }); expect(push).toHaveBeenCalledOnce();
});

it('persists stop cancellation before joining actual pending signing and never touches a closed database afterward', async () => {
  const f = fixture(), held = deferred<void>(), entered = vi.fn(), original = MasterKeySigner.prototype.sign.bind(f.signer);
  f.signed.mockImplementation(async bytes => { entered(); await held.promise; return original(bytes); });
  const push = vi.spyOn(f.runtime.egress, 'pushTo');
  const sending = f.adapter.send(f.input); await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
  f.adapter.stop(); expect(f.db.queryOne<{ cancel_pending: number }>('SELECT cancel_pending FROM world_direct_dm_attempts')!.cancel_pending).toBe(1);
  let joined = false;
  const stopping = f.runtime.stop().then(() => { joined = true; });
  await Promise.resolve(); expect(joined).toBe(false);
  held.resolve(); expect(await sending).toMatchObject({ state: 'cancel_pending' });
  await stopping; await f.adapter.whenIdle(); expect(joined).toBe(true); expect(push).not.toHaveBeenCalled();
  f.db.close(); f.hostDb.close();
  expect(() => f.adapter.view(f.input.reservationId)).toThrow('DM_ADAPTER_STOPPED');
  await expect(f.adapter.send(f.input)).rejects.toThrow('DM_ADAPTER_STOPPED');
});

it.each(['', 'x'.repeat(65537), '\ud800'])('rejects empty, oversized or invalid-Unicode text before allocating an attempt', async text => {
  const f = fixture(); await expect(f.adapter.send({ ...f.input, text })).rejects.toThrow('DM_INPUT_INVALID');
  expect(f.db.queryAll('SELECT * FROM world_direct_dm_attempts')).toEqual([]); expect(f.signed).not.toHaveBeenCalled();
});

it.each(['accepted', 'revoked_while_queued', 'revoked_after_guard', 'lost_ack'] as const)('uses the real resident bus and local HTTP with %s', async mode => {
  const received: Uint8Array[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    received.push(Buffer.concat(chunks));
    if (mode === 'lost_ack') { req.socket.destroy(); return; }
    res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ event_id: 'unsigned-transport-only' }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('NO_HTTP_ADDRESS');
  const target = { ...house, origin: `http://127.0.0.1:${address.port}` }, f = fixture(target, 1000);
  const entered = deferred<void>(), release = deferred<void>(), checked = vi.fn();
  cleanup.push(() => { release.resolve(); return Promise.resolve(); });
  f.runtime.configurePushEffectResolver(async input => {
    expect(input.origin).toBe(target.origin); expect(input.ref.kind).toBe('world_direct_dm');
    if (input.ref.kind !== 'world_direct_dm') throw new Error('WRONG_EFFECT');
    entered.resolve(); if (mode === 'revoked_while_queued') await release.promise;
    const guard = await f.adapter.authorizePersisted(input.ref, input.bytes, input.context);
    if (mode === 'revoked_after_guard') f.policy.revoke(['neutral.speak']);
    return () => { checked(); guard(); };
  });
  f.runtime.start(); expect(f.runtime.resident.authority.captureEpoch()).not.toBeNull();
  const sending = f.adapter.send(f.input);
  await entered.promise;
  if (mode === 'revoked_while_queued') { f.policy.revoke(['neutral.speak']); release.resolve(); }
  const result = await sending;
  if (mode === 'accepted') {
    expect(result).toMatchObject({ state: 'accepted', transportStatus: 201 }); expect(checked.mock.calls.length).toBeGreaterThanOrEqual(3);
  } else expect(result.state).toBe('unknown');
  expect(received).toHaveLength(mode.startsWith('revoked_') ? 0 : 1);
  if (received[0]) {
    const payload = popclaw.identity.SignedPayload.decode(received[0]), dm = popclaw.event.EventEnvelope.decode(payload.payload).directMessage!;
    expect(f.receiver.openDm(dm, actorId)).toMatchObject({ ok: true, plaintext: f.input.text });
    expect(received[0]).toEqual(f.db.queryOne<{ signed_bytes: Uint8Array }>('SELECT signed_bytes FROM world_direct_dm_attempts')!.signed_bytes);
  }
  expect(result.operationId).toBeTruthy();
  const before = f.signed.mock.calls.length;
  expect(await f.adapter.reconcile(f.input.reservationId)).toEqual(result);
  expect(await f.adapter.send(f.input)).toEqual(result);
  expect(received).toHaveLength(mode.startsWith('revoked_') ? 0 : 1); expect(f.signed).toHaveBeenCalledTimes(before);
  expect(f.policy.reservations()[0]!.status).toBe('reserved');
});
