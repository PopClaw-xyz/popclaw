import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { cidFromCanonical } from '@popclaw/algorithms';
import { popclaw } from '@popclaw/contracts';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { WorldPolicyRegistry } from '../../../src/world/world-interaction-consumers.js';
import { WorldReadiness } from '../../../src/world/world-readiness.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';
import { HostWorldTurn, type HostWorldTurnHost } from '../../../src/runtime/host-world-turn.js';
import { WorldTurnCoordinator, type WorldTurnCoordinatorOptions, type WorldTurnEffectInput } from '../../../src/runtime/world-turn-coordinator.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';
import type { ParticipationDescriptor } from '../../../src/world/world-participation.js';
import { withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
import { refusingReadAuthorityFor } from '../../helpers/read-authority.js';

const actor = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(63));
const authority = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(64));
const actorId = bs58.encode(actor.publicKey), recipient = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(65)).publicKey);
const house = { origin: 'https://coordinator.invalid', houseKey: bs58.encode(authority.publicKey), incarnation: 'inc1' };
const revision = 'a'.repeat(64), stamp = (n: number) => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'world-turn-coordinator-'));
  const db = new LocalHostDb(join(dir, 'house.db')), hostDb = new LocalHostDb(join(dir, 'host.db'));
  let now = 1800000000, supported = true, output = '{"version":1,"actions":[]}';
  const signer = new MasterKeySigner({ ...actor, seed: actor.secretKey.slice(0, 32), popclawId: actorId });
  const houses = new HouseRuntime({ readAuthorityFor: refusingReadAuthorityFor, db: hostDb, signer, origins: [house.origin], clock: () => now * 1000,
    fetch: async () => { throw new Error('UNEXPECTED_NETWORK'); } });
  hostDb.execute(`INSERT INTO house_participation(house_origin,installation_id,op_seq,desired,phase,session_id,house_revision,lease_expires_at,ack_key_hex)
    VALUES(?,'installation1',3,'enabled','connected','session1',17,?,?)`, [house.origin, now + 3600, Buffer.from(authority.publicKey).toString('hex')]);
  const gate = houses.captureSessionCommandContext(house.origin).gate;
  const registry = new WorldPolicyRegistry(db, house, actorId);
  const readiness = new WorldReadiness(db, house, actorId, new ScopedStreamJournal(db, house, bytes => JSON.parse(new TextDecoder().decode(bytes))));
  const guide = 'Only choose a declared opportunity. Decision is not speech.';
  const schema = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false };
  let caps: TrustedWorldCapabilities | null = { house, capabilityRevision: revision, guide, manifest: {
    intent_kinds: ['neutral.decide', 'neutral.speak'].map(kind => ({ kind, schema_version: 1, params_schema: schema, result_schema: { type: 'object' } })), event_kinds: [],
    world_interaction: { version: 1, endpoints: { actions_status: '/v1/world-actions/status', world_stream: '/v1/world-stream' }, features: { world_actions: 1 },
      result_authority_pubkey: house.houseKey, initial_public_scopes: [], private_message_version: 1,
      guide: { path: '/v1/guide.md', revision: 'guide1', sha256: cidFromCanonical(new TextEncoder().encode(guide)) } } } };
  function addParticipation(id = 'part1') {
    const policy = registry.policy(id);
    const descriptor: ParticipationDescriptor = { version: 1, house: { origin: house.origin, house_key: house.houseKey, incarnation: house.incarnation }, actor_id: actorId,
      participation_id: id, revision: '1', window: { id: 'window1', opens_at: stamp(now - 10), closes_at: stamp(now + 1000) },
      action_groups: [{ id: 'decision', intent_kinds: ['neutral.decide'], control_reset: 'explicit' },
        { id: 'speech', intent_kinds: ['neutral.speak'], control_reset: 'explicit', channels: ['intent', 'direct_message'] }],
      opportunities: [{ id: 'decision1', action_group_id: 'decision', budget_group_id: 'turns', budget_window_id: 'window1', not_before: stamp(now - 10), expires_at: stamp(now + 1000), dedupe_key: 'decision1' },
        { id: 'speech1', action_group_id: 'speech', budget_group_id: 'messages', budget_window_id: 'window1', not_before: stamp(now - 10), expires_at: stamp(now + 1000), dedupe_key: 'speech1', channels: ['intent'] },
        { id: 'dm1', action_group_id: 'speech', budget_group_id: 'messages', budget_window_id: 'window1', not_before: stamp(now - 10), expires_at: stamp(now + 1000), dedupe_key: 'dm1', channels: ['direct_message'] }],
      budgets: [{ id: 'turns', window_id: 'window1', resource: 'agent_turn', suggested_limit: 10 }, { id: 'messages', window_id: 'window1', resource: 'outbound_message', suggested_limit: 10 }] };
    expect(policy.mergeAuthenticatedDescriptor(descriptor, { source: 'verified_action_result', trustedCurrent: true, capabilityRevision: revision }, stamp(now)).ok).toBe(true);
    expect(policy.configureCeilings({ aggregate: { agent_turn: 10, outbound_message: 10, owner_notice: 1 }, rolling: { seconds: 3600, limits: { agent_turn: 10, outbound_message: 10, owner_notice: 1 } }, count_successful_owner_messages: false }).ok).toBe(true);
    expect(policy.grant({ allowed_action_kinds: ['neutral.decide', 'neutral.speak'], expires_at: stamp(now + 1000), max_agent_turns: 10, max_outbound_messages: 10, max_owner_notices: 1 }).ok).toBe(true);
    readiness.recordPrivateDescriptor(id);
    return policy;
  }
  const policy = addParticipation();
  const runs = new Map<string, { sessionKey: string; prompt: string }>();
  const host: HostWorldTurnHost = { id: 'controlled', createSessionKey: token => `agent:world:popclaw-world-turn:${token}`,
    isAvailable: vi.fn(async () => true), run: vi.fn(async input => { runs.set(input.runId, input); return { runId: input.runId, sessionKey: input.sessionKey, runtime: { harness: 'controlled', provider: 'controlled', model: 'controlled' } }; }),
    waitForRun: vi.fn(async input => ({ runId: input.runId, status: 'ok', startedAt: now, endedAt: now, terminalReply: { disposition: 'visible', text: output } })),
    readOutput: vi.fn(async input => ({ kind: 'bound' as const, text: (input.terminal.terminalReply as { text: string }).text, source: 'terminal_reply_and_dedicated_transcript' as const, evidence: { controlled: true } })) };
  const hostTurns = new HostWorldTurn({ db, host, now: () => now });
  const dispatch = vi.fn(async (_input: WorldTurnEffectInput) => ({ status: 'accepted', code: 'CONTROLLED_TRANSPORT_ACCEPTED' }));
  const readKnown = vi.fn(async () => ({ status: 'unknown', code: 'CONTROLLED_STATUS_UNKNOWN' }));
  const options = (): WorldTurnCoordinatorOptions => ({ db, house, actorId, gate, houses, registry, readiness, hostTurns,
    capabilities: () => caps, supportsBackgroundTurns: () => supported, effects: { intent: { dispatch, readKnown }, directMessage: { dispatch, readKnown } }, now: () => now });
  let coordinator = new WorldTurnCoordinator(options());
  cleanups.push(async () => { coordinator.stop(); await coordinator.whenIdle(); await houses.stop(); db.close(); hostDb.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, hostDb, houses, registry, readiness, policy, hostTurns, host, dispatch, readKnown, options, addParticipation, runs,
    get coordinator() { return coordinator; }, restart() { coordinator = new WorldTurnCoordinator(options()); return coordinator; },
    get now() { return now; }, set now(value) { now = value; }, get caps() { return caps; }, set caps(value) { caps = value; },
    set supported(value: boolean) { supported = value; }, set output(value: string) { output = value; } };
}
const decision = { opportunity_id: 'decision1', channel: 'intent', kind: 'neutral.decide', params: { value: 1 } };
const speech = { opportunity_id: 'speech1', channel: 'intent', kind: 'neutral.speak', params: { value: 2 } };
const dm = { opportunity_id: 'dm1', channel: 'direct_message', kind: 'direct_message', recipient, text: 'Hello' };

it('atomically admits one real G1 model turn, freezes bounded context, then closes no_action without a fake result', async () => {
  const f = fixture();
  await Promise.all([f.coordinator.poll(), f.coordinator.poll()]);
  expect(f.host.run).toHaveBeenCalledOnce(); expect(f.policy.usage().filter(c => c.resource === 'agent_turn')).toHaveLength(1);
  const sent = [...f.runs.values()][0]!, prompt = JSON.parse(sent.prompt);
  expect(prompt.context.guide).toBe(f.caps!.guide); expect(prompt.context.participation.descriptor.participation_id).toBe('part1');
  expect(prompt.context.snapshot).toBeNull();
  await f.coordinator.poll();
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'closed', outcome: 'no_action' });
  expect(f.dispatch).not.toHaveBeenCalled(); expect(f.policy.reservations()).toHaveLength(0);
  expect(f.policy.usage()).toHaveLength(1);
});

it('reserves each real decision, speech and DM attempt without charging a second model turn or settling transport receipts', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [decision, speech, dm] });
  await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.dispatch).toHaveBeenCalledTimes(3);
  expect(f.policy.usage().filter(c => c.resource === 'agent_turn')).toHaveLength(1);
  expect(f.policy.usage().filter(c => c.resource === 'outbound_message')).toHaveLength(2);
  expect(f.policy.reservations().map(r => r.status)).toEqual(['reserved', 'reserved', 'reserved']);
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'closed', outcome: 'completed' });
});

it.each([
  '{"version":1,"version":1,"actions":[]}',
  JSON.stringify({ version: 1, actions: [{ ...decision, message: false }] }),
  JSON.stringify({ version: 1, actions: [decision, decision] }),
  JSON.stringify({ version: 1, actions: [{ ...speech, kind: 'neutral.decide' }] }),
  JSON.stringify({ version: 1, actions: [{ ...dm, recipient: 'someone' }] }),
  JSON.stringify({ version: 1, actions: [{ ...decision, params: { value: 'invalid schema' } }] }),
])('rejects the complete invalid output without an attempt or refund: %s', async text => {
  const f = fixture(); f.output = text; await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'closed', outcome: 'invalid_output' });
  expect(f.dispatch).not.toHaveBeenCalled(); expect(f.policy.reservations()).toHaveLength(0); expect(f.policy.usage()).toHaveLength(1);
});

it('does not launch when guide, readiness, host support or owner grant is absent', async () => {
  for (const change of ['guide', 'ready', 'host', 'grant'] as const) {
    const f = fixture();
    if (change === 'guide') f.caps = { ...f.caps!, guide: 'different' };
    if (change === 'ready') f.readiness.invalidate('part1');
    if (change === 'host') f.supported = false;
    if (change === 'grant') f.policy.revoke(['neutral.decide', 'neutral.speak']);
    await f.coordinator.poll(); expect(f.host.run).not.toHaveBeenCalled(); expect(f.policy.usage()).toHaveLength(0);
  }
});

it('rejects a foreign HostWorldTurn database before admission', () => {
  const f = fixture(), foreign = new HostWorldTurn({ db: f.hostDb, host: f.host });
  expect(() => new WorldTurnCoordinator({ ...f.options(), hostTurns: foreign })).toThrow('HOST_WORLD_TURN_DATABASE_MISMATCH');
  expect(f.policy.usage()).toHaveLength(0);
});

it('reopens an unknown host run without relaunching and rotates to another actual participation', async () => {
  const f = fixture(); vi.mocked(f.host.run).mockRejectedValueOnce(new Error('ACK_LOST'));
  await f.coordinator.poll(); f.addParticipation('part2'); f.restart();
  await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.host.run).toHaveBeenCalledTimes(2);
  expect(f.coordinator.views()).toHaveLength(2); expect(f.registry.policy('part2').usage()).toHaveLength(1);
});

it('stop joins a real pending SDK promise and fences its late ACK', async () => {
  const f = fixture(), held = deferred<unknown>(); vi.mocked(f.host.run).mockImplementation(async input => {
    await held.promise; return { runId: input.runId, sessionKey: input.sessionKey, runtime: { harness: 'controlled', provider: 'controlled', model: 'controlled' } };
  });
  const work = f.coordinator.poll(); await vi.waitFor(() => expect(f.host.run).toHaveBeenCalledOnce());
  f.coordinator.stop(); let idle = false; const joined = f.coordinator.whenIdle().then(() => { idle = true; });
  await Promise.resolve(); expect(idle).toBe(false); held.resolve(undefined); await work; await joined;
  expect(f.coordinator.views()[0]!.state).toBe('cancel_pending'); expect(f.dispatch).not.toHaveBeenCalled();
});

function failAtCommit(db: LocalHostDb, table: string) {
  db.execute('PRAGMA foreign_keys=ON');
  db.execute('CREATE TABLE commit_parent(id INTEGER PRIMARY KEY)');
  db.execute('CREATE TABLE commit_child(id INTEGER REFERENCES commit_parent(id) DEFERRABLE INITIALLY DEFERRED)');
  db.execute(`CREATE TRIGGER fail_commit AFTER INSERT ON ${table} BEGIN INSERT INTO commit_child(id) VALUES(1); END`);
}

it('rolls back real G1 reserveTurn and the coordinator job when actual outer COMMIT fails', async () => {
  const f = fixture(); failAtCommit(f.db, 'world_turn_coordinator_jobs');
  await expect(f.coordinator.poll()).rejects.toThrow('FOREIGN KEY constraint failed');
  expect(f.policy.usage()).toHaveLength(0); expect(f.policy.eligibleOpportunities(stamp(f.now))).toHaveLength(3);
  expect(f.coordinator.views()).toHaveLength(0); expect(f.host.run).not.toHaveBeenCalled();
});

it('rolls back actual effect reservation and dispatch claim at outer COMMIT failure, preserving only the paid model turn', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [speech] });
  await f.coordinator.poll(); failAtCommit(f.db, 'world_turn_coordinator_attempts'); await f.coordinator.poll();
  expect(f.dispatch).not.toHaveBeenCalled(); expect(f.policy.reservations()).toHaveLength(0);
  expect(f.policy.usage()).toHaveLength(1); expect(f.coordinator.views()[0]).toMatchObject({ state: 'active', phase: 'effects', attempts: [] });
});

it('spends the final allowed message unit without requiring another free unit after reserveAttempt', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [speech, dm] });
  f.policy.configureCeilings({ aggregate: { agent_turn: 1, outbound_message: 1, owner_notice: 0 },
    rolling: { seconds: 3600, limits: { agent_turn: 1, outbound_message: 1, owner_notice: 0 } }, count_successful_owner_messages: false });
  await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.dispatch.mock.calls[0]![0].invocation.message).toBe(true);
  expect(f.policy.usage().map(c => c.resource)).toEqual(['agent_turn', 'outbound_message']);
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'closed', outcome: 'completed', attempts: [{ state: 'observed' }, { state: 'blocked' }] });
});

it('keeps a non-message decision eligible when the independent message budget is zero', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [decision] });
  f.policy.configureCeilings({ aggregate: { agent_turn: 1, outbound_message: 0, owner_notice: 0 },
    rolling: { seconds: 3600, limits: { agent_turn: 1, outbound_message: 0, owner_notice: 0 } }, count_successful_owner_messages: false });
  await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.dispatch.mock.calls[0]![0].invocation.message).toBe(false);
  expect(f.policy.usage().map(c => c.resource)).toEqual(['agent_turn']);
});

it('does not resume the committed coordinator-to-host crash gap on a fresh database connection', async () => {
  const f = fixture(); vi.spyOn(f.hostTurns, 'startOnce').mockRejectedValueOnce(new Error('CRASH_BEFORE_HOST_JOURNAL'));
  await f.coordinator.poll();
  const db = new LocalHostDb(join(f.dir, 'house.db'));
  const options = { ...f.options(), db, registry: new WorldPolicyRegistry(db, house, actorId),
    readiness: new WorldReadiness(db, house, actorId, new ScopedStreamJournal(db, house, bytes => JSON.parse(new TextDecoder().decode(bytes)))),
    hostTurns: new HostWorldTurn({ db, host: f.host, now: () => f.now }) };
  const recovered = new WorldTurnCoordinator(options);
  await recovered.poll(); await recovered.poll();
  expect(f.host.run).not.toHaveBeenCalled(); expect(recovered.views()).toHaveLength(1);
  expect(recovered.views()[0]!.error).toBe('HOST_WORLD_TURN_NOT_KNOWN');
  expect(options.registry.policy('part1').usage()).toHaveLength(1);
  recovered.stop(); await recovered.whenIdle(); db.close();
});

it('a crash after effect claim without an associated request remains unknown without re-invoke or another charge', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [speech] });
  f.dispatch.mockRejectedValueOnce(new Error('CRASH_BEFORE_REQUEST'));
  await f.coordinator.poll(); await f.coordinator.poll(); f.restart();
  await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.readKnown).not.toHaveBeenCalled();
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'closed', outcome: 'completed', attempts: [{ state: 'unknown' }] });
  expect(f.policy.usage()).toHaveLength(2);
});

it('recovers only each original associated request and rotates status reads across sibling attempts', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [decision, speech, dm] });
  let number = 0;
  f.dispatch.mockImplementation(async input => {
    const requestId = String(++number).repeat(64); expect(input.check().reservationId).toBe(input.reservation.reservationId);
    expect(input.policy.associateRequest(input.reservation.reservationId, requestId).ok).toBe(true);
    throw new Error('ACK_LOST_AFTER_REQUEST_COMMIT');
  });
  await f.coordinator.poll(); await f.coordinator.poll(); f.restart();
  for (let index = 0; index < 4; index++) await f.coordinator.poll();
  expect(f.dispatch).toHaveBeenCalledTimes(3); expect(f.readKnown).toHaveBeenCalledTimes(4);
  expect(f.readKnown.mock.calls.slice(0, 3).map(args => (args as unknown as [{ requestId: string }])[0].requestId)).toEqual(['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)]);
  expect(f.policy.reservations().every(row => row.status === 'reserved')).toBe(true);
});

it.each(['logout', 'capability', 'readiness', 'window', 'takeover', 'expiry'] as const)('fences a pending model continuation after %s without refund', async change => {
  const f = fixture(), held = deferred<boolean>(); vi.mocked(f.host.isAvailable).mockReturnValueOnce(held.promise);
  const work = f.coordinator.poll(); await vi.waitFor(() => expect(f.host.isAvailable).toHaveBeenCalledOnce());
  if (change === 'logout') f.hostDb.execute("UPDATE house_participation SET desired='disabled',op_seq=op_seq+1 WHERE house_origin=?", [house.origin]);
  if (change === 'capability') f.caps = { ...f.caps!, capabilityRevision: 'b'.repeat(64) };
  if (change === 'readiness') f.readiness.invalidate('part1');
  if (change === 'window') { const facts = f.policy.facts()!; facts.revision = '2'; facts.window.id = 'window2'; facts.budgets.forEach(b => { b.window_id = 'window2'; }); facts.opportunities.forEach(o => { o.budget_window_id = 'window2'; }); expect(f.policy.mergeAuthenticatedDescriptor(facts, { source: 'verified_action_result', trustedCurrent: true, capabilityRevision: revision }, stamp(f.now)).ok).toBe(true); }
  if (change === 'takeover') expect(f.policy.takeover({ whole: true }).ok).toBe(true);
  if (change === 'expiry') f.now += 301;
  held.resolve(true); await work;
  expect(f.host.run).not.toHaveBeenCalled(); expect(f.policy.usage()).toHaveLength(1); expect(f.dispatch).not.toHaveBeenCalled();
});

it('rejects a revoked candidate at first output classification even while an independent candidate remains valid', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [decision, speech] });
  await f.coordinator.poll(); expect(f.policy.revoke(['neutral.speak']).ok).toBe(true); await f.coordinator.poll();
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'closed', outcome: 'invalid_output' });
  expect(f.policy.reservations()).toHaveLength(0); expect(f.dispatch).not.toHaveBeenCalled(); expect(f.policy.usage()).toHaveLength(1);
});

it('an expired unknown model cannot block a fresh participation and remains readable only as the original run', async () => {
  const f = fixture(); vi.mocked(f.host.waitForRun).mockImplementation(async input => ({ runId: input.runId, status: 'timeout' }));
  await f.coordinator.poll(); f.now += 301; f.addParticipation('part2');
  await f.coordinator.poll(); expect(f.coordinator.views()[0]!.state).toBe('expired');
  await f.coordinator.poll(); expect(f.host.run).toHaveBeenCalledTimes(2);
  await f.coordinator.poll();
  expect(f.host.waitForRun).toHaveBeenCalled(); expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.policy.usage()).toHaveLength(1);
});

it('captures the original HostWorldTurn database independently of mutable constructor options', () => {
  const f = fixture(), options = { db: f.db, host: f.host }, journal = new HostWorldTurn(options);
  options.db = f.hostDb;
  expect(() => journal.assertDatabase(f.db)).not.toThrow();
  expect(() => journal.assertDatabase(f.hostDb)).toThrow('HOST_WORLD_TURN_DATABASE_MISMATCH');
});

function snapshot(f: ReturnType<typeof fixture>, requestId: string, stateRevision: string) {
  f.db.transaction(tx => f.readiness.recordRefresh(tx, 'part1', requestId));
  f.readiness.recordResult({ house, actorId, audienceId: actorId, requestId, status: 3, participation: { participationId: 'part1' },
    snapshot: popclaw.world.WorldSnapshot.fromObject({ stateRef: 'snapshot1', stateRevision, asOf: String(f.now), schemaKind: 'neutral.snapshot',
      schemaVersion: 1, body: Buffer.from('{"round":1}').toString('base64') }) });
  expect(f.readiness.view('part1')).toMatchObject({ ready: true, snapshot_stale: false });
}

it('captures the current actual protobuf snapshot losslessly and fences a changed snapshot across model awaits', async () => {
  const f = fixture(); snapshot(f, '1'.repeat(64), '18446744073709551614');
  const held = deferred<boolean>(); vi.mocked(f.host.isAvailable).mockReturnValueOnce(held.promise);
  const work = f.coordinator.poll(); await vi.waitFor(() => expect(f.host.isAvailable).toHaveBeenCalledOnce());
  const original = JSON.parse(f.db.queryOne<{ input_json: string }>('SELECT input_json FROM world_turn_coordinator_jobs')!.input_json);
  expect(JSON.parse(original.prompt).context.snapshot).toMatchObject({ stateRevision: '18446744073709551614', asOf: String(f.now), body: Buffer.from('{"round":1}').toString('base64') });
  snapshot(f, '2'.repeat(64), '18446744073709551615'); held.resolve(true); await work;
  expect(f.host.run).not.toHaveBeenCalled(); expect(f.policy.usage()).toHaveLength(1);
});

it('joins a real in-flight effect after stop, audits its late observation and dispatches no sibling', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [speech, decision] });
  const held = deferred<void>(); f.dispatch.mockImplementation(async input => { input.check(); await held.promise;
    expect(() => input.check()).toThrow(); return { status: 'accepted', code: 'LATE_OBSERVATION' }; });
  await f.coordinator.poll(); const work = f.coordinator.poll(); await vi.waitFor(() => expect(f.dispatch).toHaveBeenCalledOnce());
  f.coordinator.stop(); let joined = false; const idle = f.coordinator.whenIdle().then(() => { joined = true; });
  await Promise.resolve(); expect(joined).toBe(false); held.resolve(); await work; await idle;
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'cancel_pending', attempts: [{ observation: { code: 'LATE_OBSERVATION' } }] });
  expect(f.dispatch).toHaveBeenCalledOnce(); expect(f.policy.reservations()).toHaveLength(1); expect(f.policy.usage()).toHaveLength(2);
});

it('concurrent coordinator instances cannot admit a second model or duplicate a committed attempt', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [speech] });
  const second = new WorldTurnCoordinator(f.options());
  await Promise.all([f.coordinator.poll(), second.poll()]);
  await Promise.all([f.coordinator.poll(), second.poll()]);
  expect(f.host.run).toHaveBeenCalledOnce(); expect(f.dispatch).toHaveBeenCalledOnce();
  expect(f.policy.usage()).toHaveLength(2);
});

it('selects at most eight actual eligible opportunities and excludes unsupported notice-only opportunities without spending', async () => {
  const f = fixture(), facts = f.policy.facts()!;
  facts.revision = '2'; facts.opportunities = Array.from({ length: 10 }, (_, index) => ({ ...facts.opportunities[0]!, id: `decision${index}`, dedupe_key: `decision${index}` }));
  expect(f.policy.mergeAuthenticatedDescriptor(facts, { source: 'verified_action_result', trustedCurrent: true, capabilityRevision: revision }, stamp(f.now)).ok).toBe(true);
  await f.coordinator.poll(); expect(JSON.parse([...f.runs.values()][0]!.prompt).context.opportunities).toHaveLength(8);
  const other = fixture(), notice = other.policy.facts()!; notice.revision = '2'; notice.opportunities = [notice.opportunities[0]!];
  notice.budgets[0]!.resource = 'owner_notice';
  expect(other.policy.mergeAuthenticatedDescriptor(notice, { source: 'verified_action_result', trustedCurrent: true, capabilityRevision: revision }, stamp(other.now)).ok).toBe(true);
  expect(other.policy.eligibleOpportunities(stamp(other.now))).toHaveLength(1);
  await other.coordinator.poll(); expect(other.host.run).not.toHaveBeenCalled(); expect(other.policy.usage()).toHaveLength(0);
});

it.each([
  '\ufeff{"version":1,"actions":[]}',
  JSON.stringify({ version: 2, actions: [] }),
  JSON.stringify({ version: 1, actions: [{ ...dm, text: 'x'.repeat(16385) }] }),
  JSON.stringify({ version: 1, actions: [{ ...decision, params: { padding: 'x'.repeat(16385) } }] }),
  JSON.stringify({ version: 1, actions: [], padding: 'x'.repeat(65536) }),
  JSON.stringify({ version: 1, actions: [{ ...decision, channel: 'owner_notice', text: 'Hello' }] }),
])('rejects bounded output violations before any real attempt', async text => {
  const f = fixture(); f.output = text; await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'closed', outcome: 'invalid_output' });
  expect(f.dispatch).not.toHaveBeenCalled(); expect(f.policy.usage()).toHaveLength(1);
});

it('finishes an explicit original-run model error locally without a refund or succeeded reservation', async () => {
  const f = fixture(); vi.mocked(f.host.waitForRun).mockImplementation(async input => ({ runId: input.runId, status: 'error', error: 'CONTROLLED_MODEL_FAILURE' }));
  await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'closed', outcome: 'model_failed' });
  expect(f.policy.usage()).toHaveLength(1); expect(f.policy.reservations()).toHaveLength(0); expect(f.dispatch).not.toHaveBeenCalled();
});

it('authorizes a persisted original request after spending the final message unit, then fences it durably on stop and reopen', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [speech] });
  f.policy.configureCeilings({ aggregate: { agent_turn: 1, outbound_message: 1, owner_notice: 0 },
    rolling: { seconds: 3600, limits: { agent_turn: 1, outbound_message: 1, owner_notice: 0 } }, count_successful_owner_messages: false });
  const requestId = '4'.repeat(64);
  f.dispatch.mockImplementation(async input => { expect(input.policy.associateRequest(input.reservation.reservationId, requestId).ok).toBe(true); throw new Error('TRANSPORT_UNKNOWN'); });
  await f.coordinator.poll(); await f.coordinator.poll();
  const reservation = f.policy.reservations()[0]!, ref = { jobId: reservation.jobId, reservationId: reservation.reservationId, requestId, channel: 'intent' as const };
  expect(f.coordinator.views()[0]!.state).toBe('closed');
  const checker = f.coordinator.authorizePersistedEffect(ref); expect(() => checker()).not.toThrow();
  f.coordinator.stop(); expect(() => checker()).toThrow();
  expect(f.coordinator.views()[0]).toMatchObject({ state: 'cancel_pending', outcome: 'completed' });
  const reopened = f.restart(); expect(() => reopened.authorizePersistedEffect(ref)).toThrow();
  expect(f.policy.usage()).toHaveLength(2); expect(f.dispatch).toHaveBeenCalledOnce();
});

it('denies mismatched persisted job, reservation, request, channel and absent coordinator history without creating permission', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [dm] }); const requestId = '5'.repeat(64);
  f.dispatch.mockImplementation(async input => { expect(input.policy.associateRequest(input.reservation.reservationId, requestId).ok).toBe(true); throw new Error('UNKNOWN'); });
  await f.coordinator.poll(); await f.coordinator.poll();
  const reservation = f.policy.reservations()[0]!, ref = { jobId: reservation.jobId, reservationId: reservation.reservationId, requestId, channel: 'direct_message' as const };
  expect(() => f.coordinator.authorizePersistedEffect(ref)).not.toThrow();
  for (const changed of [{ ...ref, jobId: 'otherjob' }, { ...ref, reservationId: 'unknown' }, { ...ref, requestId: '6'.repeat(64) }, { ...ref, channel: 'intent' as const }]) {
    expect(() => f.coordinator.authorizePersistedEffect(changed)).toThrow();
  }
  const checker = f.coordinator.authorizePersistedEffect(ref);
  f.db.execute("UPDATE world_turn_coordinator_attempts SET action_json='{}'");
  expect(() => checker()).toThrow(); expect(() => f.coordinator.authorizePersistedEffect(ref)).toThrow();
  expect(f.policy.usage()).toHaveLength(2); expect(f.policy.reservations()).toHaveLength(1);
});

it('composes its real effect gate with ambient action scope and actual HouseRuntime session capture without recursive authorization', async () => {
  const f = fixture(); f.output = JSON.stringify({ version: 1, actions: [speech] });
  f.dispatch.mockImplementation(async input => withAction(input.gate, () => {
    expect(f.houses.captureSessionCommandContext(house.origin).sessionId).toBe(input.session.sessionId);
    expect(input.check().reservationId).toBe(input.reservation.reservationId);
    expect(input.policy.associateRequest(input.reservation.reservationId, '7'.repeat(64)).ok).toBe(true);
    f.coordinator.authorizePersistedEffect({ jobId: input.reservation.jobId, reservationId: input.reservation.reservationId, requestId: '7'.repeat(64), channel: 'intent' })();
    return { status: 'accepted', code: 'ACTUAL_SESSION_CAPTURED' };
  }));
  await f.coordinator.poll(); await f.coordinator.poll();
  expect(f.coordinator.views()[0]).toMatchObject({ attempts: [{ state: 'observed', observation: { code: 'ACTUAL_SESSION_CAPTURED' } }] });
});
