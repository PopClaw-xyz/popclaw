import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { encryptDmBody } from '../../../src/messaging/dm-crypto.js';
import { PrivateWorldMessages } from '../../../src/world/private-world-messages.js';
import { WorldParticipation, type ParticipationDescriptor } from '../../../src/world/world-participation.js';
import { WorldReadiness } from '../../../src/world/world-readiness.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';
import { createPrivateWorldDelivery, type PrivateWorldDelivery, type PrivateWorldDeliveryOptions } from '../../../src/world/private-world-delivery.js';

const official = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
const actor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(22));
const actorId = bs58.encode(actor.publicKey);
const officialId = bs58.encode(official.publicKey);
const house = { origin: 'https://private.invalid', houseKey: officialId, incarnation: 'inc_1' };
const revision = 'a'.repeat(64);
const now = '2026-09-08T12:30:00Z';
const resources: LocalHostDb[] = [];
const deliveries: PrivateWorldDelivery[] = [];
const directories: string[] = [];
function descriptor(extra: Partial<ParticipationDescriptor> = {}): ParticipationDescriptor {
  return { version: 1, house: { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation }, actor_id: actorId,
    participation_id: 'p_1', revision: '1', window: { id: 'w_1', opens_at: '2026-09-08T12:00:00Z', closes_at: '2026-09-08T13:00:00Z' },
    action_groups: [{ id: 'g_1', intent_kinds: ['mud.say'], control_reset: 'window', channels: ['intent', 'direct_message'] }],
    budgets: [{ id: 'messages', window_id: 'w_1', resource: 'outbound_message', suggested_limit: 3 }],
    opportunities: [{ id: 'o_1', action_group_id: 'g_1', budget_group_id: 'messages', budget_window_id: 'w_1', not_before: '2026-09-08T12:00:00Z',
      expires_at: '2026-09-08T13:00:00Z', dedupe_key: 'reply_1', channels: ['intent', 'direct_message'] }], ...extra };
}
function wrapper(extra: Record<string, unknown> = {}) {
  return { format: 'popclaw.world-message', version: 1, kind: 'mud.message', schema_version: 1, capability_revision: revision,
    message_id: 'message_1', conversation_ref: 'conversation_1', delivery_class: 'conversation', summary: 'Private message', body: { text: 'hello' }, ...extra };
}
function state(extra: Record<string, unknown> = {}) {
  return wrapper({ delivery_class: 'state', house: { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation },
    state_ref: 'card_1', state_revision: '2', ...extra });
}
function wire(text: string) {
  const envelope = popclaw.event.EventEnvelope.fromObject({ actor: { popclawId: officialId }, target: { scope: 1, targetIds: [actorId] }, timestamp: '1000',
    directMessage: { fromPopclawId: officialId, toPopclawId: actorId, ts: '1000', body: '[encrypted]', ...encryptDmBody(text, actorId, official.secretKey) } });
  const canonical = canonicalizeEnvelope(envelope); envelope.eventId = cidFromCanonical(canonical); envelope.signature = nacl.sign.detached(canonical, official.secretKey);
  return popclaw.event.EventEnvelope.encode(envelope).finish();
}
function fixture(overrides: Partial<PrivateWorldDeliveryOptions> = {}, path?: string, capturedRevision = revision) {
  if (!path) { const dir = mkdtempSync(join(tmpdir(), 'world-private-delivery-')); directories.push(dir); path = join(dir, 'private.db'); }
  const db = new LocalHostDb(path); resources.push(db);
  const abort = new AbortController();
  const gate = { origin: house.origin, signal: abort.signal, isActive: () => !abort.signal.aborted };
  let current: TrustedWorldCapabilities | null = { house, capabilityRevision: capturedRevision, guide: '', manifest: { world_interaction: { features: { structured_private_messages: 1 } }, official_ids: [officialId],
    event_kinds: [{ kind: 'mud.message', schema_version: 1, transport: 'house', signer: 'official',
      body_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] } };
  const caps = structuredClone(current);
  const cache = new PrivateWorldMessages({ db, gate, capabilities: caps, recipientId: actorId,
    recipient: new MasterKeySigner({ ...actor, seed: actor.secretKey.slice(0, 32), popclawId: actorId }), isOfficialActor: () => true });
  const stream = new ScopedStreamJournal(db, house, () => { throw new Error('public stream not used by this fixture'); });
  const readiness = new WorldReadiness(db, house, actorId, stream);
  const policies = new Map<string, WorldParticipation>();
  const policyFor = (id: string) => { let policy = policies.get(id); if (!policy) { policy = new WorldParticipation(db, house, actorId, id); policies.set(id, policy); } return policy; };
  const onConversation = vi.fn<PrivateWorldDeliveryOptions['onConversation']>(async () => {}), onPlain = vi.fn<PrivateWorldDeliveryOptions['onPlain']>(async () => {});
  const options: PrivateWorldDeliveryOptions = { cache, db, gate, capabilities: caps, currentCapabilities: () => current, actorId, readiness, policyFor,
    participationIds: () => [...policies.keys()], onConversation, onPlain, now: () => now, retryMs: 20, ...overrides };
  const delivery = createPrivateWorldDelivery(options); deliveries.push(delivery);
  return { db, cache, delivery, abort, readiness, stream, policyFor, policies, path, onConversation, onPlain, options,
    setCurrent(caps: TrustedWorldCapabilities | null) { current = caps; } };
}
afterEach(() => { deliveries.splice(0).forEach(d => d.stop()); resources.splice(0).forEach(db => db.close()); directories.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.restoreAllMocks(); });

describe('PrivateWorldDelivery', () => {
  it('has no construction wakeup and delivers a durable conversation before acknowledging it', async () => {
    const f = fixture(); const text = JSON.stringify(wrapper()); const raw = wire(text);
    expect(f.onConversation).not.toHaveBeenCalled();
    f.onConversation.mockImplementation(async message => {
      expect(f.cache.readMessage('message_1')).not.toBeNull(); expect(f.cache.pending()).toHaveLength(1);
      expect(message.originalText).toBe(text); expect([...message.envelopeBytes]).toEqual([...raw]);
      expect(message.senderId).toBe(officialId); expect(message.actorId).toBe(actorId);
      expect(message.idempotencyKey).toBe(JSON.stringify([house.origin, house.houseKey, house.incarnation, actorId, 'message_1']));
    });
    expect(await f.delivery.receive(raw)).toMatchObject({ kind: 'structured', delivery: 'handled' });
    expect(f.onConversation).toHaveBeenCalledOnce(); expect(f.cache.pending()).toEqual([]);
  });

  it('serializes duplicate receives, never renotifies ACKed messages, and records both authenticated event CIDs', async () => {
    const f = fixture(); const policy = f.policyFor('p_1'); const source = vi.spyOn(policy, 'sourceArrived');
    const text = JSON.stringify(wrapper()), first = wire(text), again = wire(text);
    const results = await Promise.all([f.delivery.receive(first), f.delivery.receive(again)]);
    expect(results.map(result => result.kind === 'structured' ? result.delivery : result.kind)).toEqual(['handled', 'already_handled']);
    expect(f.onConversation).toHaveBeenCalledOnce(); expect(f.cache.pending()).toEqual([]);
    expect(source).toHaveBeenCalledWith(popclaw.event.EventEnvelope.decode(first).eventId);
    expect(source).toHaveBeenCalledWith(popclaw.event.EventEnvelope.decode(again).eventId);
    expect(policy.reservations()).toEqual([]);
  });

  it('retains receipt/state records with no automatic conversation notification', async () => {
    const f = fixture();
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper({ delivery_class: 'receipt', message_id: 'receipt' }))))).toMatchObject({ delivery: 'handled' });
    expect(await f.delivery.receive(wire(JSON.stringify(state({ message_id: 'state' }))))).toMatchObject({ delivery: 'handled' });
    expect(f.cache.readMessage('receipt')).not.toBeNull(); expect(f.cache.readMessage('state')).not.toBeNull();
    expect(f.onConversation).not.toHaveBeenCalled(); expect(f.onPlain).not.toHaveBeenCalled(); expect(f.cache.pending()).toEqual([]);
  });

  it('retries a failed consumer while idle and clears pending only after success', async () => {
    const f = fixture(); f.onConversation.mockRejectedValueOnce(new Error('consumer unavailable'));
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper())))).toMatchObject({ kind: 'structured', delivery: 'pending' });
    expect(f.cache.pending()).toHaveLength(1);
    await vi.waitFor(() => expect(f.onConversation).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.cache.pending()).toEqual([]));
    await new Promise(resolve => setTimeout(resolve, 60)); expect(f.onConversation).toHaveBeenCalledTimes(2);
  });

  it('routes initial ordinary text back to G0 and preserves authentication/storage failures', async () => {
    const f = fixture();
    expect(await f.delivery.receive(wire('ordinary DM'))).toMatchObject({ kind: 'plain', originalText: 'ordinary DM' });
    expect(f.onPlain).not.toHaveBeenCalled(); expect(f.onConversation).not.toHaveBeenCalled();
    const invalid = popclaw.event.EventEnvelope.decode(wire(JSON.stringify(wrapper()))); invalid.signature[0]! ^= 1;
    expect(await f.delivery.receive(popclaw.event.EventEnvelope.encode(invalid).finish())).toMatchObject({ kind: 'dropped' });
    await f.cache.receive(wire(JSON.stringify(wrapper({ message_id: 'seed' })))); f.cache.markHandled('seed');
    f.db.execute("CREATE TRIGGER fail_cache BEFORE INSERT ON world_private_messages_v2 BEGIN SELECT RAISE(ABORT,'disk-fault'); END");
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper())))).toMatchObject({ kind: 'storage_failed', retryable: true });
    expect(f.onConversation).not.toHaveBeenCalled();
  });
});


describe('PrivateWorldDelivery durable recovery and lifecycle fences', () => {
  it('recovers a failed conversation after real SQLite close/reopen only when root starts drain', async () => {
    const first = fixture({ retryMs: 60000 }); first.onConversation.mockRejectedValue(new Error('consumer down'));
    const raw = wire(JSON.stringify(wrapper()));
    expect(await first.delivery.receive(raw)).toMatchObject({ delivery: 'pending' });
    first.delivery.stop(); first.db.close();
    const next = fixture({}, first.path);
    await new Promise(resolve => setTimeout(resolve, 30)); expect(next.onConversation).not.toHaveBeenCalled();
    const report = await next.delivery.drain();
    expect(report).toMatchObject({ attempted: 1, handled: 1, pending: false });
    expect(next.onConversation).toHaveBeenCalledOnce(); expect(next.cache.pending()).toEqual([]);
    expect([...next.onConversation.mock.calls[0]![0].envelopeBytes]).toEqual([...raw]);
  });

  it('synchronously stops from inside a consumer without deadlock or acknowledging its late completion', async () => {
    const f = fixture();
    f.onConversation.mockImplementation(async message => {
      expect(f.delivery.stop()).toBeUndefined();
      expect(message.signal.aborted).toBe(true);
      await Promise.resolve();
    });
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper())))).toMatchObject({ kind: 'dropped', reason: 'HOUSE_GATE_CLOSED' });
    expect(f.cache.pending()).toHaveLength(1);
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper({ message_id: 'later' }))))).toMatchObject({ kind: 'dropped' });
    expect(f.onConversation).toHaveBeenCalledOnce(); expect(f.cache.readMessage('later')).toBeNull();
  });

  it('does not acknowledge or apply descriptor authority after capabilities change during a callback', async () => {
    const f = fixture();
    f.onConversation.mockImplementation(async () => { f.setCurrent({ ...structuredClone(f.options.capabilities), capabilityRevision: 'b'.repeat(64) }); });
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper({ participation: descriptor() }))))).toMatchObject({ kind: 'dropped', reason: 'WORLD_CAPABILITIES_CHANGED' });
    expect(f.cache.pending()).toHaveLength(1); expect(f.policyFor('p_1').facts()).toBeUndefined();
    f.delivery.stop();
  });

  it('awaits receipt/state UI consumers and retains independently failed neighbors through a keyset drain', async () => {
    const onReceipt = vi.fn<NonNullable<PrivateWorldDeliveryOptions['onReceipt']>>(async message => { if (message.messageId === 'a_fail') throw new Error('one failed'); });
    const onState = vi.fn<NonNullable<PrivateWorldDeliveryOptions['onState']>>(async () => {});
    const f = fixture({ onReceipt, onState, retryMs: 60000 });
    for (const id of ['a_fail', 'b_ok']) await f.cache.receive(wire(JSON.stringify(wrapper({ message_id: id, delivery_class: 'receipt' }))));
    await f.cache.receive(wire(JSON.stringify(state({ message_id: 'c_state' }))));
    const report = await f.delivery.drain();
    expect(report).toMatchObject({ attempted: 3, handled: 2, pending: true });
    expect(report.failures).toEqual([{ messageId: 'a_fail', reason: 'one failed' }]);
    expect(f.cache.pending().map(row => row.messageId)).toEqual(['a_fail']);
    expect(onReceipt).toHaveBeenCalledTimes(2); expect(onState).toHaveBeenCalledOnce(); expect(f.onConversation).not.toHaveBeenCalled();
    f.delivery.stop();
  });

  it('uses the required ordinary inbox callback only for a durable pending message reclassified under new capabilities', async () => {
    const first = fixture({ retryMs: 60000 }); first.onConversation.mockRejectedValue(new Error('not yet delivered'));
    const text = JSON.stringify(wrapper()), raw = wire(text);
    await first.delivery.receive(raw); first.delivery.stop(); first.db.close();
    const next = fixture({ retryMs: 60000 }, first.path, 'b'.repeat(64));
    next.onPlain.mockRejectedValueOnce(new Error('ordinary inbox unavailable'));
    expect(await next.delivery.drain()).toMatchObject({ handled: 0, pending: true });
    expect(next.cache.pending()).toHaveLength(1);
    expect(await next.delivery.drain()).toMatchObject({ handled: 1, pending: false });
    expect(next.onPlain).toHaveBeenCalledTimes(2); expect(next.onConversation).not.toHaveBeenCalled();
    expect(next.onPlain.mock.calls[1]![0]).toMatchObject({ originalText: text, senderId: officialId, actorId, eventId: popclaw.event.EventEnvelope.decode(raw).eventId });
    expect([...next.onPlain.mock.calls[1]![0].envelopeBytes]).toEqual([...raw]);
  });

  it('coalesces concurrent drains and captures queued caller buffers before asynchronous consumption', async () => {
    const f = fixture();
    await f.cache.receive(wire(JSON.stringify(wrapper())));
    const first = f.delivery.drain(), duplicate = f.delivery.drain();
    expect(first).toBe(duplicate);
    await first; expect(f.onConversation).toHaveBeenCalledOnce();
    const raw = wire(JSON.stringify(wrapper({ message_id: 'next' }))), captured = new Uint8Array(raw);
    const receiving = f.delivery.receive(raw); raw.fill(0);
    expect(await receiving).toMatchObject({ delivery: 'handled' });
    expect([...f.onConversation.mock.calls[1]![0].envelopeBytes]).toEqual([...captured]);
  });
});

describe('PrivateWorldDelivery descriptor and source authority', () => {
  it('merges validated private descriptor facts without grants and records authenticated source facts for every registered entity', async () => {
    const f = fixture(); const other = f.policyFor('other'); const sources = vi.spyOn(other, 'sourceArrived');
    const raw = wire(JSON.stringify(state({ participation: descriptor() })));
    expect(await f.delivery.receive(raw)).toMatchObject({ delivery: 'handled' });
    expect(f.policyFor('p_1').facts()).toEqual(descriptor()); expect(f.readiness.view('p_1').ready).toBe(true);
    expect(f.policyFor('p_1').eligibleOpportunities(now)).toEqual([]); expect(f.policyFor('p_1').reservations()).toEqual([]);
    expect(sources).toHaveBeenCalledWith(popclaw.event.EventEnvelope.decode(raw).eventId);
  });

  it('cannot bypass a subscription publication/replay requirement with private arrival', async () => {
    const f = fixture();
    f.readiness.recordResult({ house, actorId, audienceId: actorId, requestId: 'c'.repeat(64), status: 3,
      subscription: { house, actorId, participationId: 'p_1', descriptorRevision: 1, logIncarnation: 'log_1', scopes: ['sc_public'], barrierId: 'barrier_1' } });
    expect(await f.delivery.receive(wire(JSON.stringify(state({ participation: descriptor() }))))).toMatchObject({ delivery: 'handled' });
    expect(f.policyFor('p_1').facts()).toEqual(descriptor()); expect(f.readiness.view('p_1').ready).toBe(false);
    const policy = f.policyFor('p_1');
    expect(policy.grant({ allowed_action_kinds: ['mud.say'], expires_at: '2026-09-08T13:00:00Z', max_agent_turns: 3, max_outbound_messages: 3, max_owner_notices: 0 }).ok).toBe(true);
    expect(policy.configureCeilings({ aggregate: { agent_turn: 3, outbound_message: 3, owner_notice: 0 }, rolling: { seconds: 3600, limits: { agent_turn: 3, outbound_message: 3, owner_notice: 0 } }, count_successful_owner_messages: true }).ok).toBe(true);
    expect(policy.eligibleOpportunities(now)).toEqual([]);
  });

  it('keeps old/conflicting state messages readable without installing their proposed higher participation revision', async () => {
    const f = fixture();
    await f.delivery.receive(wire(JSON.stringify(state({ participation: descriptor() }))));
    expect(await f.delivery.receive(wire(JSON.stringify(state({ message_id: 'old', state_revision: '1', participation: descriptor({ revision: '100' }) }))))).toMatchObject({ delivery: 'handled', stateStatus: 'old' });
    expect(await f.delivery.receive(wire(JSON.stringify(state({ message_id: 'conflict', body: { text: 'different' }, participation: descriptor({ revision: '101' }) }))))).toMatchObject({ delivery: 'handled', stateStatus: 'conflict' });
    expect(f.policyFor('p_1').facts()?.revision).toBe('1');
    expect(f.cache.readMessage('old')).not.toBeNull(); expect(f.cache.readMessage('conflict')).not.toBeNull();
  });

  it('retains pending on pure descriptor validation failure before running a conversation consumer', async () => {
    const f = fixture({ retryMs: 60000 }); const invalid = descriptor();
    delete invalid.dm_response_slot_key;
    invalid.opportunities[0]!.channels = ['intent'];
    invalid.opportunities.push({ ...invalid.opportunities[0]!, id: 'different_id_same_key' });
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper({ participation: invalid }))))).toMatchObject({ kind: 'structured', delivery: 'pending', failure: 'DEDUPE_KEY_DUPLICATE' });
    expect(f.onConversation).not.toHaveBeenCalled(); expect(f.cache.pending()).toHaveLength(1);
    expect(f.policyFor('p_1').facts()).toBeUndefined(); f.delivery.stop();
  });

  it('rolls back source/readiness/ACK on a policy write failure and retries with the same initialized policy object', async () => {
    const f = fixture({ retryMs: 60000 }); const policy = f.policyFor('p_1');
    f.db.execute("CREATE TRIGGER fail_policy BEFORE UPDATE ON world_participation_policy BEGIN SELECT RAISE(ABORT,'policy-disk-fault'); END");
    const raw = wire(JSON.stringify(state({ participation: descriptor() })));
    expect(await f.delivery.receive(raw)).toMatchObject({ delivery: 'pending', failure: 'policy-disk-fault' });
    expect(f.cache.pending()).toHaveLength(1); expect(f.readiness.view('p_1').ready).toBe(false); expect(policy.facts()).toBeUndefined();
    f.db.execute('DROP TRIGGER fail_policy');
    expect(await f.delivery.drain()).toMatchObject({ handled: 1, pending: false });
    expect(policy.facts()).toEqual(descriptor()); expect(f.readiness.view('p_1').ready).toBe(true);
  });

  it('keeps message-id conflicts explicit and never routes them to the ordinary inbox', async () => {
    const f = fixture(); await f.delivery.receive(wire(JSON.stringify(wrapper())));
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper({ body: { text: 'conflicting text' } }))))).toMatchObject({ kind: 'conflict', reason: 'MESSAGE_ID_CONFLICT' });
    expect(f.onConversation).toHaveBeenCalledOnce(); expect(f.onPlain).not.toHaveBeenCalled();
  });
});


describe('PrivateWorldDelivery source retry and shutdown', () => {
  it('joins a timer consumer already in flight after stop without ACK or another callback', async () => {
    const f = fixture();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    f.onConversation.mockRejectedValueOnce(new Error('initial failure')).mockImplementation(async () => blocked);
    await f.delivery.receive(wire(JSON.stringify(wrapper())));
    await vi.waitFor(() => expect(f.onConversation).toHaveBeenCalledTimes(2));
    f.delivery.stop(); let idle = false;
    const joining = f.delivery.whenIdle().then(() => { idle = true; });
    await Promise.resolve(); expect(idle).toBe(false);
    release(); await joining; expect(idle).toBe(true);
    expect(f.cache.pending()).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 40)); expect(f.onConversation).toHaveBeenCalledTimes(2);
  });

  it('durably retries a failed new source CID on an ACKed duplicate without notifying its consumer again', async () => {
    const f = fixture(); const policy = f.policyFor('p_1');
    await f.delivery.receive(wire(JSON.stringify(wrapper())));
    const raw = wire(JSON.stringify(wrapper())), eventId = popclaw.event.EventEnvelope.decode(raw).eventId;
    f.db.execute("CREATE TRIGGER fail_source BEFORE UPDATE ON world_participation_policy BEGIN SELECT RAISE(ABORT,'source-fault'); END");
    expect(await f.delivery.receive(raw)).toMatchObject({ delivery: 'pending', failure: 'source-fault' });
    expect(f.cache.pending()).toEqual([]); expect(f.onConversation).toHaveBeenCalledOnce();
    const queued = f.db.queryOne<{ envelope_bytes: Uint8Array; capability_revision: string }>('SELECT envelope_bytes,capability_revision FROM world_private_delivery_sources WHERE event_id=?', [eventId]);
    expect([...queued!.envelope_bytes]).toEqual([...raw]); expect(queued!.capability_revision).toBe(revision);
    const arrived = vi.spyOn(policy, 'sourceArrived');
    f.db.execute('DROP TRIGGER fail_source');
    await vi.waitFor(() => expect(arrived).toHaveBeenCalledWith(eventId));
    await vi.waitFor(() => expect(f.db.queryAll('SELECT * FROM world_private_delivery_sources')).toEqual([]));
    expect(f.onConversation).toHaveBeenCalledOnce();
  });

  it('revalidates queued source bytes after restart and never revives authority revoked by current capabilities', async () => {
    const first = fixture({ retryMs: 60000 }); first.policyFor('p_1');
    await first.delivery.receive(wire(JSON.stringify(wrapper())));
    first.db.execute("CREATE TRIGGER fail_source BEFORE UPDATE ON world_participation_policy BEGIN SELECT RAISE(ABORT,'source-fault'); END");
    const raw = wire(JSON.stringify(wrapper()));
    expect(await first.delivery.receive(raw)).toMatchObject({ delivery: 'pending' });
    first.db.execute('DROP TRIGGER fail_source'); first.delivery.stop(); first.db.close();
    const next = fixture({ retryMs: 60000 }, first.path, 'b'.repeat(64));
    const receive = vi.spyOn(next.cache, 'receive');
    const arrived = vi.spyOn(next.policyFor('p_1'), 'sourceArrived');
    expect(await next.delivery.drain()).toMatchObject({ attempted: 1, handled: 1, pending: false });
    expect(receive).toHaveBeenCalledWith(expect.any(Uint8Array));
    expect([...receive.mock.calls[0]![0]]).toEqual([...raw]);
    expect(arrived).not.toHaveBeenCalled(); expect(next.onConversation).not.toHaveBeenCalled(); expect(next.onPlain).not.toHaveBeenCalled();
    expect(next.cache.pending()).toEqual([]);
  });

  it('reports an undurable source queue failure explicitly for transport redelivery', async () => {
    const f = fixture({ retryMs: 60000 }); await f.delivery.receive(wire(JSON.stringify(wrapper())));
    f.db.execute("CREATE TRIGGER fail_queue BEFORE INSERT ON world_private_delivery_sources BEGIN SELECT RAISE(ABORT,'queue-fault'); END");
    const raw = wire(JSON.stringify(wrapper()));
    expect(await f.delivery.receive(raw)).toMatchObject({ kind: 'storage_failed', retryable: true, failure: 'MESSAGE_SOURCE_STORAGE_FAILED' });
    expect(f.cache.pending()).toEqual([]); expect(f.db.queryAll('SELECT * FROM world_private_delivery_sources')).toEqual([]);
    expect(f.onConversation).toHaveBeenCalledOnce();
    f.db.execute('DROP TRIGGER fail_queue');
    expect(await f.delivery.receive(raw)).toMatchObject({ delivery: 'already_handled' });
    expect(f.onConversation).toHaveBeenCalledOnce();
  });

  it('rejects a policy on a second database before consumer effects or partial source writes', async () => {
    const other = fixture(); const wrong = other.policyFor('p_1');
    const f = fixture({ participationIds: () => ['p_1'], policyFor: () => wrong, retryMs: 60000 });
    expect(await f.delivery.receive(wire(JSON.stringify(wrapper())))).toMatchObject({ delivery: 'pending', failure: 'PARTICIPATION_BINDING_MISMATCH' });
    expect(f.onConversation).not.toHaveBeenCalled(); expect(f.cache.pending()).toHaveLength(1);
  });
});


it('rejects cache/readiness binding mismatches at construction before creating a delivery job', () => {
  const first = fixture(), second = fixture();
  expect(() => createPrivateWorldDelivery({ ...first.options, cache: second.cache })).toThrow('MESSAGE_CACHE_BINDING_MISMATCH');
  expect(() => createPrivateWorldDelivery({ ...first.options, readiness: second.readiness })).toThrow('READINESS_BINDING_MISMATCH');
});


it('replays an ACKed duplicate source after real database reopen without replaying its consumer', async () => {
  const first = fixture({ retryMs: 60000 }); first.policyFor('p_1');
  await first.delivery.receive(wire(JSON.stringify(wrapper())));
  first.db.execute("CREATE TRIGGER fail_source BEFORE UPDATE ON world_participation_policy BEGIN SELECT RAISE(ABORT,'source-fault'); END");
  const raw = wire(JSON.stringify(wrapper())), eventId = popclaw.event.EventEnvelope.decode(raw).eventId;
  expect(await first.delivery.receive(raw)).toMatchObject({ delivery: 'pending' });
  first.db.execute('DROP TRIGGER fail_source'); first.delivery.stop(); first.db.close();
  const next = fixture({}, first.path); const arrived = vi.spyOn(next.policyFor('p_1'), 'sourceArrived');
  expect(await next.delivery.drain()).toMatchObject({ attempted: 1, handled: 1, pending: false });
  expect(arrived).toHaveBeenCalledWith(eventId); expect(next.onConversation).not.toHaveBeenCalled();
});


function grantExisting(f: ReturnType<typeof fixture>) {
  const policy = f.policyFor('p_1');
  expect(policy.grant({ allowed_action_kinds: ['mud.say'], expires_at: '2026-09-08T13:00:00Z', max_agent_turns: 3, max_outbound_messages: 3, max_owner_notices: 0 }).ok).toBe(true);
  expect(policy.configureCeilings({ aggregate: { agent_turn: 3, outbound_message: 3, owner_notice: 0 }, rolling: { seconds: 3600, limits: { agent_turn: 3, outbound_message: 3, owner_notice: 0 } }, count_successful_owner_messages: true }).ok).toBe(true);
  expect(policy.eligibleOpportunities(now)).toHaveLength(1);
  return policy;
}

describe('PrivateWorldDelivery rejects stale execution authority after failed updates', () => {
  it('preserves pending and disables an existing granted policy after same-revision descriptor conflict rolls back', async () => {
    const f = fixture({ retryMs: 60000 });
    await f.delivery.receive(wire(JSON.stringify(state({ participation: descriptor() }))));
    const policy = grantExisting(f);
    const changed = descriptor(); changed.opportunities[0]!.not_before = '2026-09-08T12:01:00Z';
    expect(await f.delivery.receive(wire(JSON.stringify(state({ message_id: 'conflicting_descriptor', state_revision: '3', participation: changed }))))).toMatchObject({ delivery: 'pending', failure: 'DESCRIPTOR_REVISION_CONFLICT' });
    expect(f.cache.pending()).toHaveLength(1); expect(policy.facts()).toEqual(descriptor());
    expect(policy.eligibleOpportunities(now)).toEqual([]); expect(f.readiness.view('p_1').ready).toBe(false);
  });

  it('fences only the authenticated proposed entity when pure descriptor validation fails', async () => {
    const f = fixture({ retryMs: 60000 });
    await f.delivery.receive(wire(JSON.stringify(state({ participation: descriptor() }))));
    const policy = grantExisting(f); const other = f.policyFor('other'); const invalidated = vi.spyOn(other, 'invalidate');
    const invalid = descriptor({ revision: '2' }); invalid.opportunities[0]!.channels = ['intent'];
    invalid.opportunities.push({ ...invalid.opportunities[0]!, id: 'duplicate_dedupe' });
    expect(await f.delivery.receive(wire(JSON.stringify(state({ message_id: 'invalid_descriptor', state_revision: '3', participation: invalid }))))).toMatchObject({ delivery: 'pending', failure: 'DEDUPE_KEY_DUPLICATE' });
    expect(policy.eligibleOpportunities(now)).toEqual([]); expect(f.readiness.view('p_1').ready).toBe(false);
    expect(invalidated).not.toHaveBeenCalled(); expect(f.cache.pending()).toHaveLength(1);
  });

  it('keeps execution fenced through failed SQLite invalidation and restores only a valid trusted retry', async () => {
    const f = fixture({ retryMs: 60000 });
    await f.delivery.receive(wire(JSON.stringify(state({ participation: descriptor() }))));
    const policy = grantExisting(f);
    f.db.execute("CREATE TRIGGER fail_policy BEFORE UPDATE ON world_participation_policy BEGIN SELECT RAISE(ABORT,'policy-unwritable'); END");
    f.db.execute("CREATE TRIGGER fail_readiness BEFORE UPDATE ON world_readiness BEGIN SELECT RAISE(ABORT,'readiness-unwritable'); END");
    const raw = wire(JSON.stringify(state({ message_id: 'valid_update', state_revision: '3', participation: descriptor({ revision: '2' }) })));
    expect(await f.delivery.receive(raw)).toMatchObject({ delivery: 'pending' });
    expect(policy.eligibleOpportunities(now)).toEqual([]); expect(f.readiness.view('p_1').ready).toBe(false);
    expect(f.cache.pending()).toHaveLength(1);
    f.db.execute('DROP TRIGGER fail_policy'); f.db.execute('DROP TRIGGER fail_readiness');
    expect(await f.delivery.drain()).toMatchObject({ handled: 1, pending: false });
    expect(policy.facts()?.revision).toBe('2'); expect(policy.eligibleOpportunities(now)).toHaveLength(1);
    expect(f.readiness.view('p_1').ready).toBe(true);
  });
});


it.each(['actor', 'house', 'participation'] as const)('rejects a same-database foreign %s policy before sources or consumer effects', async mismatch => {
  const f = fixture({ retryMs: 60000 }); f.delivery.stop();
  const foreign = new WorldParticipation(f.db, mismatch === 'house' ? { ...house, incarnation: 'other_incarnation' } : house,
    mismatch === 'actor' ? officialId : actorId, mismatch === 'participation' ? 'other' : 'p_1');
  const source = vi.spyOn(foreign, 'sourceArrived'); const invalidated = vi.spyOn(foreign, 'invalidate');
  const delivery = createPrivateWorldDelivery({ ...f.options, participationIds: () => ['p_1'], policyFor: () => foreign }); deliveries.push(delivery);
  expect(await delivery.receive(wire(JSON.stringify(wrapper())))).toMatchObject({ delivery: 'pending', failure: 'PARTICIPATION_BINDING_MISMATCH' });
  expect(source).not.toHaveBeenCalled(); expect(invalidated).not.toHaveBeenCalled(); expect(f.onConversation).not.toHaveBeenCalled();
  expect(f.cache.pending()).toHaveLength(1);
});


it('reapplies both invalidations when ACK storage fails after a successful policy merge', async () => {
  const f = fixture({ retryMs: 60000 });
  await f.delivery.receive(wire(JSON.stringify(state({ participation: descriptor() }))));
  const policy = grantExisting(f);
  f.db.execute("CREATE TRIGGER fail_ack BEFORE UPDATE OF consumer_pending ON world_private_messages_v2 BEGIN SELECT RAISE(ABORT,'ack-unwritable'); END");
  expect(await f.delivery.receive(wire(JSON.stringify(state({ message_id: 'after_merge', state_revision: '3', participation: descriptor({ revision: '2' }) }))))).toMatchObject({ delivery: 'pending', failure: 'ack-unwritable' });
  expect(policy.facts()?.revision).toBe('1'); expect(policy.eligibleOpportunities(now)).toEqual([]);
  expect(f.readiness.view('p_1').ready).toBe(false); expect(f.cache.pending()).toHaveLength(1);
  f.db.execute('DROP TRIGGER fail_ack');
  expect(await f.delivery.drain()).toMatchObject({ pending: false });
  expect(policy.facts()?.revision).toBe('2'); expect(policy.eligibleOpportunities(now)).toHaveLength(1);
});
