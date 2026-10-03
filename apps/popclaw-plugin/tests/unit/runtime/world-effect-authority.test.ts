import { afterEach, expect, it } from 'vitest';
import { cidFromCanonical } from '@popclaw/algorithms';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { WorldParticipation } from '../../../src/world/world-participation.js';
import { WorldReadiness } from '../../../src/world/world-readiness.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';
import { createWorldEffectAuthority } from '../../../src/runtime/world-effect-authority.js';

const key = (n: number) => bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(n)).publicKey);
const actorId = key(91), house = { origin: 'https://effect.invalid', houseKey: key(92), incarnation: 'inc_1' };
const participationId = 'participation1', revision = 'a'.repeat(64), stamp = (n: number) => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const handles: InMemoryHostDb[] = [];
afterEach(() => { handles.splice(0).forEach(db => db.close()); });

function fixture() {
  const db = new InMemoryHostDb(); handles.push(db);
  const policy = new WorldParticipation(db, house, actorId, participationId);
  const stream = new ScopedStreamJournal(db, house, bytes => JSON.parse(new TextDecoder().decode(bytes)));
  const readiness = new WorldReadiness(db, house, actorId, stream);
  let now = 1000, supported = true;
  const guide = 'Exact trusted guide';
  let caps: TrustedWorldCapabilities | null = { house, capabilityRevision: revision, guide, manifest: { intent_kinds: [], event_kinds: [],
    world_interaction: { version: 1, endpoints: { actions_status: '/v1/world-actions/status', world_stream: '/v1/world-stream' },
      features: { world_actions: 1 }, result_authority_pubkey: house.houseKey, initial_public_scopes: [], private_message_version: 1,
      guide: { path: '/v1/guide.md', revision: 'guide1', sha256: cidFromCanonical(new TextEncoder().encode(guide)) } } } };
  expect(policy.mergeAuthenticatedDescriptor({ version: 1, house: { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation }, actor_id: actorId,
    participation_id: participationId, revision: '1', window: { id: 'window1', opens_at: stamp(900), closes_at: stamp(2000) },
    action_groups: [{ id: 'group1', intent_kinds: ['neutral.speak'], control_reset: 'explicit', channels: ['intent', 'direct_message'] }],
    opportunities: [{ id: 'opportunity1', action_group_id: 'group1', budget_group_id: 'messages', budget_window_id: 'window1',
      not_before: stamp(900), expires_at: stamp(2000), dedupe_key: 'reply_slot', channels: ['intent', 'direct_message'] }],
    budgets: [{ id: 'messages', window_id: 'window1', resource: 'outbound_message', suggested_limit: 3 }], dm_response_slot_key: 'reply_slot',
  }, { source: 'verified_action_result', trustedCurrent: true, capabilityRevision: revision }, stamp(now)).ok).toBe(true);
  expect(policy.configureCeilings({ aggregate: { agent_turn: 3, outbound_message: 3, owner_notice: 1 },
    rolling: { seconds: 3600, limits: { agent_turn: 3, outbound_message: 3, owner_notice: 1 } }, count_successful_owner_messages: false }).ok).toBe(true);
  expect(policy.grant({ allowed_action_kinds: ['neutral.speak'], expires_at: stamp(2000), max_agent_turns: 3, max_outbound_messages: 3, max_owner_notices: 1 }).ok).toBe(true);
  readiness.recordPrivateDescriptor(participationId);
  const invocation = { opportunityId: 'opportunity1', kind: 'direct_message', channel: 'direct_message' as const, message: true,
    contextValidUntil: stamp(1300), expectedCapabilityRevision: revision };
  const result = policy.reserveBatch({ jobId: 'job1', turnId: 'turn1', invocations: [invocation] }, stamp(now));
  if (!result.ok) throw new Error(result.code);
  const reserved = result.value[0]!; if (!reserved.ok) throw new Error(reserved.code);
  const options = { db, policy, house: { ...house }, actorId, participationId, reservationId: reserved.reservation.reservationId,
    jobId: 'job1', invocation: { ...invocation }, capabilities: () => caps, readiness, now: () => now, supportsBackgroundTurns: () => supported };
  return { db, policy, readiness, options, get caps() { return caps; }, set caps(value) { caps = value; }, set now(value: number) { now = value; }, set supported(value: boolean) { supported = value; } };
}

it('authorizes the reserved DM channel without requiring a manifest pseudo-intent and atomically associates its event', () => {
  const f = fixture(), authority = createWorldEffectAuthority(f.options), id = 'b'.repeat(64);
  expect(authority.check().invocation).toMatchObject({ kind: 'direct_message', channel: 'direct_message', message: true });
  expect(() => f.db.transaction(tx => { authority.record(tx, id); throw new Error('ROLLBACK'); })).toThrow('ROLLBACK');
  expect(f.policy.reservations()[0]!.requestId).toBeUndefined();
  f.db.transaction(tx => authority.record(tx, id));
  expect(authority.check(id).requestId).toBe(id);
  expect(() => authority.check('c'.repeat(64))).toThrow('EFFECT_REQUEST_MISMATCH');
  expect(f.policy.reservations()[0]!.status).toBe('reserved');
  expect(f.policy.usage()).toHaveLength(2);
});

it.each(['revoke', 'takeover', 'expiry', 'readiness', 'guide', 'revision', 'unsupported'] as const)('rechecks %s on every use of an already created authority', change => {
  const f = fixture(), authority = createWorldEffectAuthority(f.options);
  authority.check();
  if (change === 'revoke') f.policy.revoke(['neutral.speak']);
  if (change === 'takeover') f.policy.takeover({ whole: true });
  if (change === 'expiry') f.now = 1300;
  if (change === 'readiness') f.readiness.invalidate(participationId);
  if (change === 'guide') f.caps = { ...f.caps!, guide: 'Changed unbound guide' };
  if (change === 'revision') f.caps = { ...f.caps!, capabilityRevision: 'c'.repeat(64) };
  if (change === 'unsupported') f.supported = false;
  expect(() => authority.check()).toThrow();
  expect(() => authority.record(f.db, 'b'.repeat(64))).toThrow();
  expect(f.policy.reservations()[0]!.requestId).toBeUndefined();
  expect(f.policy.usage()).toHaveLength(2);
});

it('binds authority to the exact database, house, actor, participation and captured invocation', () => {
  const f = fixture(), other = fixture(), authority = createWorldEffectAuthority(f.options);
  f.options.invocation.opportunityId = 'other'; f.options.house.incarnation = 'other';
  expect(authority.check().invocation.opportunityId).toBe('opportunity1');
  expect(() => authority.assertBinding(other.db, house, actorId)).toThrow('EFFECT_BINDING_MISMATCH');
  expect(() => authority.record(other.db, 'b'.repeat(64))).toThrow('EFFECT_BINDING_MISMATCH');
  expect(() => createWorldEffectAuthority({ ...other.options, readiness: f.readiness })).toThrow(/BINDING_MISMATCH/);
  expect(() => createWorldEffectAuthority({ ...other.options, participationId: 'foreign' })).toThrow(/BINDING_MISMATCH/);
  expect(() => createWorldEffectAuthority({ ...other.options, invocation: { ...other.options.invocation, message: false } })).toThrow('EFFECT_CHANNEL_INVALID');
});
