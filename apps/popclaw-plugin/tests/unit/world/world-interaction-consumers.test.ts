import { afterEach, describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';
import { WorldReadiness } from '../../../src/world/world-readiness.js';
import { createWorldResultConsumers, WorldPolicyRegistry } from '../../../src/world/world-interaction-consumers.js';
import { participationDescriptorFromProto } from '../../../src/world/world-participation.js';
import { canonicalWorldCore, worldSigningInput } from '../../../src/world/action-wire.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';
const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51)), actorId = bs58.encode(key.publicKey);
const house = { origin: 'https://consumer.invalid', houseKey: actorId, incarnation: 'i1' };
const at = 1788876000, now = new Date(at * 1000).toISOString().replace('.000Z', 'Z'), cap = 'a'.repeat(64);
const dirs: string[] = [], dbs: LocalHostDb[] = [];
function participation(id = 'p1', revision = '1') {
  return popclaw.world.ParticipationDescriptor.fromObject({ version: 1, house, actorId, participationId: id, revision,
    windowId: 'w1', windowOpensAt: at - 100, windowClosesAt: at + 1000,
    actionGroups: [{ id: 'g1', intentKinds: ['demo.act'], controlReset: 'window' }],
    budgets: [{ id: 'b1', windowId: 'w1', resource: 'agent_turn', suggestedLimit: 2 }],
    opportunities: [{ id: 'o1', actionGroupId: 'g1', budgetGroupId: 'b1', budgetWindowId: 'w1', notBefore: at - 1, expiresAt: at + 1000, dedupeKey: 'd1', sourceEventId: 'c'.repeat(64) }],
  });
}
function result(overrides: Record<string, unknown> = {}) {
  return popclaw.world.ActionResult.fromObject({ house, actorId, audienceId: actorId, requestId: 'b'.repeat(64), status: 3, capabilityRevision: cap,
    participation: participation(), ...overrides });
}
function subscription() { return popclaw.world.SubscriptionDescriptor.fromObject({ house, actorId, participationId: 'p1', descriptorRevision: '1', logIncarnation: 'log1', scopes: ['sc_a'], barrierId: '' }); }
function snapshot() { return popclaw.world.WorldSnapshot.fromObject({ stateRef: 's1', stateRevision: '1', schemaKind: 'demo.state', schemaVersion: 1, asOf: at, body: new TextEncoder().encode('{}') }); }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'world-consumers-')); dirs.push(dir); const path = join(dir, 'host.db');
  const db = new LocalHostDb(path); dbs.push(db);
  const registry = new WorldPolicyRegistry(db, house, actorId);
  const stream = new ScopedStreamJournal(db, house, () => { throw new Error('not used'); });
  const readiness = new WorldReadiness(db, house, actorId, stream);
  let caps: TrustedWorldCapabilities | null = { house, capabilityRevision: cap, guide: '', manifest: { world_interaction: { result_authority_pubkey: actorId } } };
  const abort = new AbortController(), gate = { origin: house.origin, signal: abort.signal, isActive: () => !abort.signal.aborted };
  const install = vi.fn((d: popclaw.world.ISubscriptionDescriptor) => { stream.bootstrapLogIncarnation(d.logIncarnation!); stream.installDescriptor(d); });
  const readState = { assertBinding: vi.fn(), hasRequest: vi.fn(() => false), settle: vi.fn() };
  const options = { db, house, actorId, gate, registry, readiness, readState, capabilities: () => caps,
    subscriptionReceiver: () => ({ assertBinding: stream.assertBinding.bind(stream), installSubscription: install }), now: () => at };
  const consumer = createWorldResultConsumers(options);
  const prepare = (id = 'p1') => {
    const policy = registry.policy(id); readiness.recordPrivateDescriptor(id);
    expect(policy.mergeAuthenticatedDescriptor(participationDescriptorFromProto(participation(id)), { source: 'verified_private_state', trustedCurrent: true, capabilityRevision: cap }, now).ok).toBe(true);
    expect(policy.configureCeilings({ aggregate: { agent_turn: 10, outbound_message: 10, owner_notice: 10 }, rolling: { seconds: 3600, limits: { agent_turn: 10, outbound_message: 10, owner_notice: 10 } }, count_successful_owner_messages: false }).ok).toBe(true);
    expect(policy.grant({ allowed_action_kinds: ['demo.act'], expires_at: new Date((at + 1000) * 1000).toISOString().replace('.000Z', 'Z'), max_agent_turns: 10, max_outbound_messages: 10, max_owner_notices: 10 }).ok).toBe(true);
    return policy;
  };
  return { db, path, registry, stream, readiness, consumer, options, prepare, install, readState, abort, caps: () => caps!, changeCaps: (value: typeof caps) => { caps = value; } };
}
afterEach(() => { dbs.splice(0).forEach(db => db.close()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });
describe('world interaction consumers', () => {
  it('keeps one policy instance and durable actor-scoped membership across reopen', () => {
    const f = fixture(); const p = f.registry.policy('p1'); expect(f.registry.policy('p1')).toBe(p);
    f.registry.policy('p2'); expect(f.registry.participationIds()).toEqual(['p1', 'p2']);
    const other = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(52)).publicKey);
    expect(new WorldPolicyRegistry(f.db, house, other).participationIds()).toEqual([]);
    f.db.close(); const reopened = new LocalHostDb(f.path); dbs.push(reopened);
    expect(new WorldPolicyRegistry(reopened, house, actorId).participationIds()).toEqual(['p1', 'p2']);
    expect(() => f.registry.assertBinding(reopened, house, actorId)).toThrow('BINDING_MISMATCH');
  });
  it('registers authenticated facts without granting a turn', async () => {
    const f = fixture(); await f.consumer.onResult(result());
    expect(f.registry.participationIds()).toEqual(['p1']); expect(f.registry.policy('p1').facts()?.revision).toBe('1');
    expect(f.registry.policy('p1').eligibleOpportunities(now)).toEqual([]); expect(f.registry.policy('p1').reservations()).toEqual([]);
  });
  it('routes only actual verified source identities to known same-actor policies without scheduling', () => {
    const f = fixture(), p = f.prepare(); expect(p.eligibleOpportunities(now)).toEqual([]);
    expect(() => f.consumer.onWorldEvent({ eventId: 'c'.repeat(64), envelope: { eventId: 'd'.repeat(64) } })).toThrow('SOURCE_ID');
    f.consumer.onWorldEvent({ eventId: 'c'.repeat(64), envelope: { eventId: 'c'.repeat(64) } });
    expect(p.eligibleOpportunities(now)).toHaveLength(1); expect(p.reservations()).toHaveLength(0);
  });
  it('requires a real subscription receiver before result ACK and closes old availability on failure', async () => {
    const f = fixture(), p = f.prepare(); p.sourceArrived('c'.repeat(64));
    const consumer = createWorldResultConsumers({ ...f.options, subscriptionReceiver: () => null });
    await expect(consumer.onResult(result({ subscription: subscription() }))).rejects.toThrow('SCOPED_RECEIVER_REQUIRED');
    expect(p.eligibleOpportunities(now)).toEqual([]); expect(f.readiness.view('p1').ready).toBe(false);
  });
  it('keeps publication, catch-up and explicitly recorded refresh separate', async () => {
    const f = fixture(), p = f.prepare(); p.sourceArrived('c'.repeat(64));
    const initial = result({ subscription: subscription(), snapshot: snapshot() }); await f.consumer.onResult(initial);
    expect(f.readiness.view('p1').phase).toBe('waiting_publication'); expect(p.eligibleOpportunities(now)).toEqual([]);
    const generation = f.stream.beginReplay(popclaw.world.WorldStreamBoundary.fromObject({ logIncarnation: 'log1', scopes: ['sc_a'], highWaterSeq: '0' }));
    f.stream.checkpoint(generation, popclaw.world.WorldStreamCheckpoint.fromObject({ phase: 'replay', scopes: [{ scopeId: 'sc_a', throughSeq: '0' }] }));
    const observation = popclaw.world.SubscriptionObservation.fromObject({ version: 1, house, actorId, participationId: 'p1', descriptorRevision: '1', observationRevision: '1', publicationState: 'published', logIncarnation: 'log1', queryRequestId: initial.requestId, queryNonce: 'nonce1', observedAt: at });
    const signature = nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_SUBSCRIPTION_OBSERVATION_V1', canonicalWorldCore(popclaw.world.SubscriptionObservation, observation)), key.secretKey);
    f.consumer.onProgress(popclaw.world.SignedSubscriptionObservation.encode({ observation, signature }).finish(), { requestId: initial.requestId, nonce: 'nonce1', result: initial, capabilities: f.caps() });
    f.consumer.onStreamState(f.stream.status()); expect(p.eligibleOpportunities(now)).toEqual([]);
    const requestId = 'd'.repeat(64); f.db.transaction(tx => f.readiness.recordRefresh(tx, 'p1', requestId));
    await f.consumer.onResult(result({ requestId, participation: null, snapshot: snapshot() }));
    expect(f.readiness.view('p1').ready).toBe(true); expect(p.eligibleOpportunities(now)).toHaveLength(1);
    const failed = popclaw.world.SubscriptionObservation.fromObject({ ...observation, publicationState: 'failed' });
    const failedSignature = nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_SUBSCRIPTION_OBSERVATION_V1', canonicalWorldCore(popclaw.world.SubscriptionObservation, failed)), key.secretKey);
    const query = { requestId: initial.requestId, nonce: 'nonce1', result: initial, capabilities: f.caps() };
    expect(() => f.consumer.onProgress(popclaw.world.SignedSubscriptionObservation.encode({ observation: failed, signature: new Uint8Array(64) }).finish(), query)).toThrow('SIGNATURE_INVALID');
    expect(p.eligibleOpportunities(now)).toHaveLength(1);
    expect(() => f.consumer.onProgress(popclaw.world.SignedSubscriptionObservation.encode({ observation: failed, signature: failedSignature }).finish(), query)).toThrow('SUBSCRIPTION_OBSERVATION_CONFLICT');
    expect(f.readiness.view('p1').ready).toBe(false); expect(p.eligibleOpportunities(now)).toEqual([]);
    f.stream.endReplay(generation); f.consumer.onStreamState(f.stream.status()); expect(p.eligibleOpportunities(now)).toEqual([]);
  });
  it('does not reactivate unrelated private policy or stamp old results with new capability', async () => {
    const f = fixture(), p = f.prepare(), other = f.prepare('p2'); p.sourceArrived('c'.repeat(64)); other.sourceArrived('c'.repeat(64)); other.invalidate('untrusted');
    await f.consumer.onResult(result()); expect(other.eligibleOpportunities(now)).toEqual([]);
    f.changeCaps({ ...f.caps(), capabilityRevision: 'e'.repeat(64) }); await f.consumer.onResult(result());
    expect(p.capabilityRevision()).toBe(cap); expect(p.eligibleOpportunities(now)).toEqual([]);
  });
  it('persists fail-closed descriptor rejection outside the failing policy transaction', async () => {
    const f = fixture(), p = f.prepare(); p.sourceArrived('c'.repeat(64));
    const conflict = participation(); conflict.actionGroups[0]!.controlReset = 'explicit';
    await expect(f.consumer.onResult(result({ participation: conflict }))).rejects.toThrow('DESCRIPTOR_REVISION_CONFLICT');
    expect(p.eligibleOpportunities(now)).toEqual([]); expect(f.readiness.view('p1').ready).toBe(false);
    expect(f.db.queryAll('SELECT * FROM world_readiness_invalidations')).toHaveLength(1);
  });
  it('never clears invalidation from an old descriptor or attachment-free nonterminal refresh status', async () => {
    const f = fixture(), p = f.prepare(); p.sourceArrived('c'.repeat(64));
    await f.consumer.onResult(result({ participation: participation('p1', '2') }));
    f.readiness.invalidate('p1'); p.invalidate('untrusted');
    await f.consumer.onResult(result({ participation: participation('p1', '1') }));
    expect(p.eligibleOpportunities(now)).toEqual([]); expect(f.readiness.view('p1').ready).toBe(false);
    f.db.transaction(tx => f.readiness.recordRefresh(tx, 'p1', 'e'.repeat(64)));
    for (const status of [1, 2, 4, 5]) {
      await f.consumer.onResult(result({ status, participation: null, requestId: 'e'.repeat(64) }));
      expect(p.eligibleOpportunities(now)).toEqual([]); expect(f.readiness.view('p1').ready).toBe(false);
    }
  });
  it('settles only linked attempts and never creates a reservation from receipts', async () => {
    const f = fixture(), p = f.prepare(); p.sourceArrived('c'.repeat(64));
    const batch = p.reserveBatch({ jobId: 'job1', turnId: 'turn1', invocations: [{ opportunityId: 'o1', kind: 'demo.act', channel: 'intent', message: false, contextValidUntil: new Date((at + 100) * 1000).toISOString().replace('.000Z', 'Z'), expectedCapabilityRevision: cap }] }, now);
    if (!batch.ok || !batch.value[0]!.ok) throw Error(JSON.stringify(batch));
    p.associateRequest(batch.value[0]!.reservation.reservationId, 'b'.repeat(64));
    const ownerActions = { assertBinding: vi.fn(), hasRequest: vi.fn(() => true), settle: vi.fn() };
    const consumer = createWorldResultConsumers({ ...f.options, ownerActions });
    f.readState.hasRequest.mockReturnValue(true); await consumer.onResult(result({ status: 4, participation: null }));
    expect(ownerActions.settle).toHaveBeenCalledWith('b'.repeat(64), 'rejected');
    expect(p.reservations()[0]!.status).toBe('rejected'); expect(f.readState.settle).toHaveBeenCalledWith('b'.repeat(64), 'rejected');
    expect(p.reservations()).toHaveLength(1);
  });
  it('fences after asynchronous subscription installation before policy/source effects', async () => {
    const f = fixture(); const consumer = createWorldResultConsumers({ ...f.options, subscriptionReceiver: () => ({ assertBinding: f.stream.assertBinding.bind(f.stream), installSubscription: async () => { f.abort.abort(); } }) });
    await expect(consumer.onResult(result({ subscription: subscription() }))).rejects.toThrow('HOUSE_GATE_CLOSED');
    expect(f.registry.policy('p1').facts()).toBeUndefined();
  });
  it('rejects foreign registry and readiness identity before callbacks', () => {
    const f = fixture(), other = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(52)).publicKey);
    expect(() => createWorldResultConsumers({ ...f.options, registry: new WorldPolicyRegistry(f.db, house, other) })).toThrow('BINDING_MISMATCH');
    expect(() => createWorldResultConsumers({ ...f.options, readiness: new WorldReadiness(f.db, house, other, f.stream) })).toThrow('BINDING_MISMATCH');
  });
});
