import { afterEach, describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import type { HostDb } from '../../../src/host/host-db.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';
import { WorldReadiness } from '../../../src/world/world-readiness.js';
import { canonicalWorldCore, worldSigningInput } from '../../../src/world/action-wire.js';
import type { TrustedWorldCapabilities } from '../../../src/world/world-capabilities.js';

const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(81)), keyId = bs58.encode(key.publicKey);
const actorId = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(82)).publicKey);
const house = { origin: 'https://state.invalid', houseKey: keyId, incarnation: 'inc_1' };
const caps: TrustedWorldCapabilities = { house, capabilityRevision: 'a'.repeat(64), guide: 'guide', manifest: { world_interaction: { result_authority_pubkey: keyId } } };
const dbs: HostDb[] = [], dirs: string[] = [];
const utf8 = new TextEncoder();
function descriptor(overrides: Record<string, unknown> = {}) {
  return popclaw.world.SubscriptionDescriptor.fromObject({ house, actorId, participationId: 'p_1', descriptorRevision: '1', logIncarnation: 'log_1', scopes: ['sc_a'], barrierId: 'barrier_1', ...overrides });
}
function snapshot(revision = '9007199254740993', ref = 'state_1', body = '{}') {
  return popclaw.world.WorldSnapshot.fromObject({ stateRef: ref, stateRevision: revision, schemaKind: 'test.state', schemaVersion: 1, asOf: '1000', body: utf8.encode(body) });
}
function result(overrides: Record<string, unknown> = {}) {
  return popclaw.world.ActionResult.fromObject({ house, actorId, audienceId: actorId, requestId: 'a'.repeat(64), status: 3, subscription: descriptor(), snapshot: snapshot(), ...overrides });
}
function fixture(db: HostDb = new InMemoryHostDb()) {
  dbs.push(db);
  const stream = new ScopedStreamJournal(db, house, raw => JSON.parse(new TextDecoder().decode(raw)));
  stream.bootstrapLogIncarnation('log_1'); stream.installDescriptor(descriptor());
  const readiness = new WorldReadiness(db, house, actorId, stream);
  return { db, stream, readiness };
}
function caughtUp(f: ReturnType<typeof fixture>, high = '10') {
  const generation = f.stream.beginReplay(popclaw.world.WorldStreamBoundary.fromObject({ logIncarnation: 'log_1', scopes: ['sc_a'], highWaterSeq: high }));
  f.stream.checkpoint(generation, popclaw.world.WorldStreamCheckpoint.fromObject({ phase: 'replay', scopes: [{ scopeId: 'sc_a', throughSeq: high }] }));
  return generation;
}
function observe(f: ReturnType<typeof fixture>, changes: Record<string, unknown> = {}, source = result(), queryChanges: Record<string, unknown> = {}) {
  const observation = popclaw.world.SubscriptionObservation.fromObject({ version: 1, house, actorId, participationId: source.subscription?.participationId,
    // "no barrier" is the ABSENCE of the field, not an empty string. proto3
    // elides default values (CLAUDE.md deliberate-design ①) and the wire
    // checker now refuses an explicitly-encoded zero-length string, so passing
    // '' through fromObject fails at RESULT_WIRE_UNSUPPORTED — in the one case
    // whose whole point is a publication with no barrier.
    ...(source.subscription?.barrierId ? { barrierId: source.subscription.barrierId } : {}),
    descriptorRevision: source.subscription?.descriptorRevision, observationRevision: '9007199254740993',
    publicationState: 'published', logIncarnation: 'log_1', highWaterSeq: '10', publishedThrough: [{ scopeId: 'sc_a', throughSeq: '10' }],
    queryRequestId: source.requestId, queryNonce: 'nonce_1', observedAt: '1000', ...changes });
  const signature = nacl.sign.detached(worldSigningInput('POPCLAW_WORLD_SUBSCRIPTION_OBSERVATION_V1', canonicalWorldCore(popclaw.world.SubscriptionObservation, observation)), key.secretKey);
  f.readiness.acceptObservation(popclaw.world.SignedSubscriptionObservation.encode({ observation, signature }).finish(), { requestId: source.requestId, nonce: 'nonce_1', result: source, capabilities: caps, ...queryChanges });
}
function refresh(f: ReturnType<typeof fixture>, source = result({ requestId: 'b'.repeat(64) })) {
  f.db.transaction(tx => f.readiness.recordRefresh(tx, source.subscription?.participationId ?? 'p_1', source.requestId));
  f.readiness.recordResult(source);
}
afterEach(() => { dbs.splice(0).forEach(db => db.close()); dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

describe('WorldReadiness evidence composition', () => {
  it('keeps invalidation durable and in memory when SQLite invalidation fails', () => {
    const f = fixture(); f.readiness.recordPrivateDescriptor('private_1');
    const write = vi.spyOn(f.db, 'execute').mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => f.readiness.invalidate('private_1')).toThrow('disk full'); write.mockRestore();
    expect(f.readiness.view('private_1')).toMatchObject({ ready: false, canRefresh: true });
    f.readiness.invalidate('private_1');
    expect(new WorldReadiness(f.db, house, actorId, f.stream).view('private_1').ready).toBe(false);
    f.readiness.clearInvalidation('private_1'); expect(f.readiness.view('private_1').ready).toBe(true);
  });
  it('exposes only actor-bound refresh and current subscription facts and rejects foreign transactions', () => {
    const f = fixture(); f.readiness.recordResult(result());
    expect(f.readiness.subscriptionFor('p_1')?.descriptorRevision.toString()).toBe('1');
    const other = new InMemoryHostDb(); dbs.push(other);
    expect(() => f.readiness.recordRefresh(other, 'p_1', 'b'.repeat(64))).toThrow('READINESS_DATABASE_MISMATCH');
    observe(f); caughtUp(f); f.db.transaction(tx => f.readiness.recordRefresh(tx, 'p_1', 'b'.repeat(64)));
    expect(f.readiness.refreshParticipation('b'.repeat(64))).toBe('p_1');
    expect(new WorldReadiness(f.db, house, keyId, f.stream).refreshParticipation('b'.repeat(64))).toBeUndefined();
  });
  it('keeps success separate from publication, replay and post-catch-up snapshot freshness', () => {
    const f = fixture(); f.readiness.recordResult(result());
    expect(f.readiness.view('p_1')).toMatchObject({ ready: false, canRefresh: false, phase: 'waiting_publication', snapshot_stale: true });
    observe(f, { publicationState: 'waiting_publication', publishedThrough: [] });
    caughtUp(f);
    expect(f.readiness.view('p_1').ready).toBe(false);
    observe(f, { observationRevision: '9007199254740994' });
    expect(f.readiness.view('p_1')).toMatchObject({ ready: false, canRefresh: true, phase: 'snapshot_stale' });
    refresh(f);
    expect(f.readiness.view('p_1')).toMatchObject({ ready: true, canRefresh: true, phase: 'ready', snapshot_stale: false });
    // Original result is unchanged and duplicate arrival cannot undo freshness.
    f.readiness.recordResult(result());
    expect(f.readiness.view('p_1').ready).toBe(true);
  });
  it('requires a new refresh after same-H reconnect, and never rebinds an original refresh on retry', () => {
    const f = fixture(); f.readiness.recordResult(result()); observe(f); const generation = caughtUp(f); refresh(f);
    expect(f.readiness.view('p_1').ready).toBe(true);
    f.stream.endReplay(generation); expect(f.readiness.view('p_1').canRefresh).toBe(false);
    caughtUp(f);
    expect(f.readiness.view('p_1')).toMatchObject({ phase: 'snapshot_stale', ready: false });
    refresh(f); expect(f.readiness.view('p_1').ready).toBe(false);
    refresh(f, result({ requestId: 'c'.repeat(64) })); expect(f.readiness.view('p_1').ready).toBe(true);
  });
  it('binds publication coverage to the actual local log and each scope cursor', () => {
    const f = fixture(); f.readiness.recordResult(result()); observe(f); caughtUp(f, '9');
    expect(f.readiness.view('p_1')).toMatchObject({ phase: 'replaying', canRefresh: false });
    f.stream.checkpoint(JSON.parse(f.stream.replayAnchor()!)[1], popclaw.world.WorldStreamCheckpoint.fromObject({ phase: 'live', scopes: [{ scopeId: 'sc_a', throughSeq: '10' }] }));
    expect(f.readiness.view('p_1').canRefresh).toBe(true);
    f.readiness.recordResult(result({ subscription: descriptor({ descriptorRevision: '2', logIncarnation: 'log_2' }) }));
    observe(f, { logIncarnation: 'log_2', observationRevision: '9007199254740994' }, result({ subscription: descriptor({ descriptorRevision: '2', logIncarnation: 'log_2' }) }));
    expect(f.readiness.view('p_1')).toMatchObject({ canRefresh: false, phase: 'replaying' });
  });
  it('accepts no-barrier publication while still requiring catch-up and refresh', () => {
    const f = fixture(), source = result({ subscription: descriptor({ barrierId: '' }) });
    f.stream.installDescriptor(descriptor({ barrierId: '', descriptorRevision: '2' }));
    f.readiness.recordResult(source); observe(f, { publishedThrough: [] }, source); caughtUp(f);
    expect(f.readiness.view('p_1')).toMatchObject({ ready: false, canRefresh: true });
    refresh(f, result({ requestId: 'b'.repeat(64), subscription: descriptor({ barrierId: '' }) }));
    expect(f.readiness.view('p_1').ready).toBe(true);
  });
  it.each(['actorId', 'house', 'queryRequestId', 'queryNonce', 'participationId', 'barrierId', 'descriptorRevision'])('rejects signed wrong %s query binding', field => {
    const f = fixture(); f.readiness.recordResult(result());
    const value = field === 'house' ? { ...house, incarnation: 'other' } : field === 'descriptorRevision' ? '2' : 'wrong';
    expect(() => observe(f, { [field]: value })).toThrow('OBSERVATION_BINDING_MISMATCH');
    expect(f.readiness.view('p_1').publication).toBeUndefined();
  });
  it('rejects incomplete/duplicate/out-of-H publication coverage and wrong key', () => {
    const f = fixture(); f.readiness.recordResult(result());
    for (const publishedThrough of [[], [{ scopeId: 'sc_a', throughSeq: '11' }], [{ scopeId: 'sc_b', throughSeq: '1' }], [{ scopeId: 'sc_a', throughSeq: '1' }, { scopeId: 'sc_a', throughSeq: '1' }]]) {
      expect(() => observe(f, { publishedThrough })).toThrow('OBSERVATION_COVERAGE_INVALID');
    }
    expect(() => observe(f, {}, result(), { capabilities: { ...caps, manifest: { world_interaction: { result_authority_pubkey: actorId } } } })).toThrow('OBSERVATION_SIGNATURE_INVALID');
  });
  it('merges full uint64 observation revisions and ignores old descriptor observations', () => {
    const f = fixture(); f.readiness.recordResult(result()); observe(f);
    expect(() => observe(f, { publicationState: 'failed' })).toThrow('SUBSCRIPTION_OBSERVATION_CONFLICT');
    observe(f, { observationRevision: '9007199254740992', publicationState: 'waiting_publication', publishedThrough: [] });
    expect(f.readiness.view('p_1').publication?.publicationState).toBe('published');
    expect(() => observe(f, { observationRevision: '9007199254740994', publicationState: 'waiting_publication', publishedThrough: [] })).toThrow('PUBLICATION_ROLLBACK');
    f.readiness.recordResult(result({ subscription: descriptor({ descriptorRevision: '2' }) }));
    observe(f, { observationRevision: '18446744073709551615' });
    expect(f.readiness.view('p_1').publication).toBeUndefined();
  });
  it('keeps snapshots by state_ref with uint64 revisions and never lets unrelated refresh bless newer bytes', () => {
    const f = fixture(); f.readiness.recordResult(result()); observe(f); caughtUp(f); refresh(f);
    f.readiness.recordResult(result({ requestId: 'd'.repeat(64), subscription: descriptor({ participationId: 'p_2' }), snapshot: snapshot('9007199254740994') }));
    expect(f.readiness.view('p_1')).toMatchObject({ ready: false, phase: 'snapshot_stale' });
    expect(f.readiness.view('p_1').snapshot?.stateRevision.toString()).toBe('9007199254740994');
    f.readiness.recordResult(result({ requestId: 'e'.repeat(64), snapshot: snapshot('1', 'other_state') }));
    expect(f.db.queryAll('SELECT * FROM world_readiness_snapshots')).toHaveLength(2);
    f.readiness.recordResult(result({ snapshot: snapshot('9007199254740992') }));
    expect(f.readiness.view('p_1').snapshot?.stateRef).toBe('other_state');
    expect(() => f.readiness.recordResult(result({ snapshot: snapshot('9007199254740994', 'state_1', '{"changed":true}') }))).toThrow('SNAPSHOT_REVISION_CONFLICT');
  });
  it('does not let a late old descriptor attach a different snapshot to the current participation', () => {
    const f = fixture(); f.readiness.recordResult(result({ subscription: descriptor({ descriptorRevision: '2' }) }));
    f.readiness.recordResult(result({ snapshot: snapshot('999', 'old_state') }));
    expect(f.readiness.view('p_1').snapshot?.stateRef).toBe('state_1');
  });
  it('preserves refresh/request atomicity and recipient/database isolation', () => {
    const f = fixture(); f.readiness.recordResult(result()); observe(f); caughtUp(f);
    expect(() => f.db.transaction(tx => { f.readiness.recordRefresh(tx, 'p_1', 'b'.repeat(64)); throw new Error('rollback'); })).toThrow('rollback');
    expect(f.db.queryAll('SELECT * FROM world_readiness_refreshes')).toHaveLength(0);
    const other = new WorldReadiness(f.db, house, keyId, f.stream);
    expect(other.view('p_1')).toMatchObject({ ready: false, phase: 'state_missing' });
    expect(() => f.readiness.assertBinding(f.db, house, keyId)).toThrow('READINESS_BINDING_MISMATCH');
    expect(() => f.readiness.assertBinding(f.db, house, actorId)).not.toThrow();
    expect(() => new WorldReadiness(f.db, { ...house, incarnation: 'other' }, actorId, f.stream)).toThrow('JOURNAL_BINDING_MISMATCH');
  });
  it('allows authenticated private state for unscoped participation but cannot bypass scoped publication', () => {
    const f = fixture(); f.readiness.recordPrivateDescriptor('private_1');
    expect(f.readiness.view('private_1')).toMatchObject({ ready: true, canRefresh: true });
    f.readiness.recordResult(result()); f.readiness.recordPrivateDescriptor('p_1');
    expect(f.readiness.view('p_1')).toMatchObject({ ready: false, canRefresh: false });
  });
  it('never inherits crashed-process replay readiness when reopening the real SQLite file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'world-readiness-')); dirs.push(dir);
    const path = join(dir, 'host.sqlite'), f = fixture(new LocalHostDb(path));
    f.readiness.recordResult(result()); observe(f); caughtUp(f); refresh(f);
    expect(f.readiness.view('p_1').ready).toBe(true); f.db.close();
    const db = new LocalHostDb(path); dbs.push(db);
    const stream = new ScopedStreamJournal(db, house, () => { throw new Error('no frames received'); });
    const readiness = new WorldReadiness(db, house, actorId, stream);
    expect(stream.replayAnchor()).toBeNull(); expect(stream.status().caughtUp).toBe(false);
    expect(readiness.view('p_1')).toMatchObject({ ready: false, canRefresh: false, snapshot_stale: true, phase: 'replaying' });
    expect(stream.cursorVector()[0]?.afterSeq.toString()).toBe('10');
  });
  it('does not relabel an old snapshot as fresh when only an unscoped private descriptor arrives', () => {
    const f = fixture();
    f.readiness.recordResult(result({ subscription: null, participation: { participationId: 'private_1' } }));
    expect(f.readiness.view('private_1').snapshot_stale).toBe(true);
    f.readiness.recordPrivateDescriptor('private_1');
    expect(f.readiness.view('private_1')).toMatchObject({ ready: true, snapshot_stale: true });
    expect(f.db.queryAll('SELECT * FROM world_readiness_refreshes')).toHaveLength(0);
  });
});
