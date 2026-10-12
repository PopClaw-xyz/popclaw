import { afterEach, describe, expect, it, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { ScopedStreamJournal } from '../../../src/world/scoped-stream-journal.js';

const house = { origin: 'https://house.example', houseKey: 'house-key', incarnation: 'house-incarnation' };
const log = 'log_initial';
const dbs: InMemoryHostDb[] = [];
const raw = (id: string, scopes = ['sc_a']) => new TextEncoder().encode(JSON.stringify({ eventId: id, publicScopes: scopes }));
const validate = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as { eventId: string; publicScopes: string[] };
const descriptor = (revision = '1', scopes = ['sc_a'], actor = 'actor', participation = 'participation') => popclaw.world.SubscriptionDescriptor.fromObject({
  house, actorId: actor, participationId: participation, descriptorRevision: revision, logIncarnation: log, scopes, barrierId: 'barrier',
});
const boundary = (high = '0', scopes = ['sc_a'], incarnation = log) => popclaw.world.WorldStreamBoundary.fromObject({ logIncarnation: incarnation, scopes, highWaterSeq: high });
const frame = (seq: string, id: string, scopes = ['sc_a']) => popclaw.event.WorldStreamFrame.fromObject({ seq, envelope: raw(id, scopes), scopes });
const checkpoint = (seq: string, scopes = ['sc_a'], phase = 'replay') => popclaw.world.WorldStreamCheckpoint.fromObject({ phase, scopes: scopes.map(scopeId => ({ scopeId, throughSeq: seq })) });
function fixture(scopes = ['sc_a']) {
  const db = new InMemoryHostDb(); dbs.push(db);
  const journal = new ScopedStreamJournal(db, house, validate);
  journal.bootstrapLogIncarnation(log);
  journal.installDescriptor(descriptor('1', scopes));
  return { db, journal };
}
afterEach(() => dbs.splice(0).forEach(db => db.close()));

describe('ScopedStreamJournal', () => {
  it('accepts an authenticated subscription with no publication barrier', () => {
    const { journal } = fixture();
    const next = descriptor('2'); next.barrierId = '';
    expect(() => journal.installDescriptor(next)).not.toThrow();
    expect(journal.cursorVector()).toHaveLength(1);
  });
  it('binds a refresh anchor to the completed replay generation, including same-H reconnects', () => {
    const { journal } = fixture();
    expect(journal.replayAnchor()).toBeNull();
    const first = journal.beginReplay(boundary('0'));
    expect(journal.replayAnchor()).toBeNull();
    journal.checkpoint(first, checkpoint('0'));
    const anchor = journal.replayAnchor(); expect(anchor).toBeTruthy();
    journal.endReplay(first); expect(journal.replayAnchor()).toBeNull();
    const second = journal.beginReplay(boundary('0'));
    journal.checkpoint(second, checkpoint('0'));
    expect(journal.replayAnchor()).not.toBe(anchor);
  });
  it('requires an explicit trusted log pin and never confuses it with house incarnation', () => {
    const db = new InMemoryHostDb(); dbs.push(db);
    const journal = new ScopedStreamJournal(db, house, validate);
    expect(() => journal.beginReplay(boundary())).toThrow('LOG_INCARNATION_UNBOUND');
    journal.bootstrapLogIncarnation(log);
    expect(() => journal.bootstrapLogIncarnation('other_log')).toThrow('LOG_INCARNATION_CONFLICT');
    journal.installDescriptor(descriptor());
    expect(journal.status().logIncarnation).toBe(log);
  });

  it('accepts a one-character log incarnation while scopes still require four characters', () => {
    const db = new InMemoryHostDb(); dbs.push(db);
    const journal = new ScopedStreamJournal(db, house, validate);
    journal.bootstrapLogIncarnation('x');
    const subscription = descriptor(); subscription.logIncarnation = 'x';
    journal.installDescriptor(subscription);
    const generation = journal.beginReplay(boundary('0', ['sc_a'], 'x'));
    journal.checkpoint(generation, checkpoint('0'));
    expect(journal.status()).toMatchObject({ logIncarnation: 'x', caughtUp: true });
    expect(() => journal.installInitialScopes(['a'])).toThrow('SCOPE_INVALID');
  });

  it('persists trusted initial scopes before the log pin without connecting or inventing cursors', () => {
    const db = new InMemoryHostDb(); dbs.push(db);
    const journal = new ScopedStreamJournal(db, house, validate);
    journal.installInitialScopes(['sc_initial']);
    expect(() => journal.cursorVector()).toThrow('LOG_INCARNATION_UNBOUND');
    expect(() => journal.beginReplay(boundary('0', ['sc_initial']))).toThrow('LOG_INCARNATION_UNBOUND');
    expect(db.queryAll('SELECT * FROM world_scoped_cursors')).toEqual([]);
    const restarted = new ScopedStreamJournal(db, house, validate);
    restarted.bootstrapLogIncarnation(log);
    expect(restarted.cursorVector().map(c => [c.scopeId, c.afterSeq?.toString()])).toEqual([['sc_initial', '0']]);
    const generation = restarted.beginReplay(boundary('0', ['sc_initial']));
    restarted.checkpoint(generation, checkpoint('0', ['sc_initial']));
    expect(restarted.status().caughtUp).toBe(true);
  });

  it('unions initial and actor scopes, fencing changes while preserving previous cursors', () => {
    const { journal } = fixture();
    let generation = journal.beginReplay(boundary('9'));
    journal.checkpoint(generation, checkpoint('9'));
    journal.installInitialScopes(['sc_a', 'sc_initial']);
    expect(() => journal.checkpoint(generation, checkpoint('10', ['sc_a'], 'live'))).toThrow('OBSOLETE_GENERATION');
    expect(journal.cursorVector().map(c => [c.scopeId, c.afterSeq?.toString()])).toEqual([['sc_a', '9'], ['sc_initial', '0']]);
    generation = journal.beginReplay(boundary('10', ['sc_a', 'sc_initial']));
    journal.checkpoint(generation, checkpoint('10', ['sc_a', 'sc_initial']));
    journal.installInitialScopes(['sc_initial', 'sc_a']);
    expect(journal.status().caughtUp).toBe(true);
    journal.installInitialScopes([]);
    expect(journal.cursorVector().map(c => c.scopeId)).toEqual(['sc_a']);
    journal.installInitialScopes(['sc_initial']);
    expect(journal.cursorVector().map(c => c.afterSeq?.toString())).toEqual(['10', '10']);
    expect(journal.status().caughtUp).toBe(false);
  });

  it('bounds initial scopes at eight and the single connection union at thirty-two atomically', () => {
    const { journal } = fixture();
    const eight = Array.from({ length: 8 }, (_, index) => `sc_initial_${index}`);
    journal.installInitialScopes(eight);
    expect(() => journal.installInitialScopes([...eight, 'sc_extra'])).toThrow('INITIAL_SCOPE_LIMIT_EXCEEDED');
    expect(journal.cursorVector()).toHaveLength(9);
    const many = Array.from({ length: 25 }, (_, index) => `sc_descriptor_${index}`);
    expect(() => journal.installDescriptor(descriptor('2', many))).toThrow('SCOPE_LIMIT_EXCEEDED');
    expect(journal.cursorVector().map(c => c.scopeId)).toEqual(['sc_a', ...eight]);
    journal.installInitialScopes([]);
    journal.installDescriptor(descriptor('2', Array.from({ length: 32 }, (_, index) => `sc_full_${index}`)));
    expect(() => journal.installInitialScopes(['sc_extra'])).toThrow('SCOPE_LIMIT_EXCEEDED');
    expect(journal.cursorVector()).toHaveLength(32);
  });

  it('stores uint64 above 2^53 as exact TEXT and permits global sequence holes', () => {
    const { db, journal } = fixture();
    const generation = journal.beginReplay(boundary('18446744073709551615'));
    journal.appendFrame(generation, frame('9007199254740993', 'event-1'));
    journal.appendFrame(generation, frame('18446744073709551614', 'event-2'));
    journal.checkpoint(generation, checkpoint('18446744073709551615'));
    expect(journal.cursorVector()[0]?.afterSeq?.toString()).toBe('18446744073709551615');
    expect(db.queryOne<{ type: string }>('SELECT typeof(after_seq) AS type FROM world_scoped_cursors')?.type).toBe('text');
    expect(journal.status().caughtUp).toBe(true);
  });

  it('advances a newly joined scope for an old event without redispatching consumers', () => {
    const { db, journal } = fixture();
    let generation = journal.beginReplay(boundary('7'));
    journal.appendFrame(generation, frame('7', 'event', ['sc_a', 'sc_b']));
    journal.markConsumed('event', 'content'); journal.markConsumed('event', 'task');
    journal.checkpoint(generation, checkpoint('7'));
    journal.installDescriptor(descriptor('2', ['sc_a', 'sc_b']));
    expect(journal.cursorVector().map(c => c.afterSeq?.toString())).toEqual(['7', '0']);
    generation = journal.beginReplay(boundary('7', ['sc_a', 'sc_b']));
    journal.appendFrame(generation, frame('7', 'event', ['sc_a', 'sc_b']));
    journal.checkpoint(generation, checkpoint('7', ['sc_a', 'sc_b']));
    expect(journal.pending('content')).toEqual([]); expect(journal.pending('task')).toEqual([]);
    expect(db.queryAll('SELECT * FROM world_scoped_events')).toHaveLength(1);
    expect(db.queryAll('SELECT * FROM world_scoped_event_scopes')).toHaveLength(2);
  });

  it('rolls back envelope, association, pending and cursor together, fencing a failed frame', () => {
    const { db, journal } = fixture();
    const generation = journal.beginReplay(boundary('7'));
    db.execute("CREATE TRIGGER fail_cursor BEFORE UPDATE ON world_scoped_cursors BEGIN SELECT RAISE(ABORT,'disk-test'); END");
    expect(() => journal.appendFrame(generation, frame('7', 'event'))).toThrow('disk-test');
    expect(db.queryAll('SELECT * FROM world_scoped_events')).toEqual([]);
    expect(db.queryAll('SELECT * FROM world_scoped_event_scopes')).toEqual([]);
    expect(journal.cursorVector()[0]?.afterSeq?.toString()).toBe('0');
    expect(() => journal.checkpoint(generation, checkpoint('7'))).toThrow('OBSOLETE_GENERATION');
  });

  it('paginates past consumed and failed rows without skipping later pending entries', () => {
    const { journal } = fixture(); const generation = journal.beginReplay(boundary('3'));
    journal.appendFrame(generation, frame('1', 'first')); journal.appendFrame(generation, frame('2', 'second')); journal.appendFrame(generation, frame('3', 'third'));
    expect(journal.pending('task', 2).map(row => row.eventId)).toEqual(['first', 'second']);
    journal.markConsumed('second', 'task');
    expect(journal.pending('task', 2, 'second').map(row => row.eventId)).toEqual(['third']);
    expect(journal.pending('task', 2, 'third')).toEqual([]);
    expect(journal.pending('task', 2).map(row => row.eventId)).toEqual(['first', 'third']);
  });

  it('recovers pending consumers independently after reopening the journal', () => {
    const { db, journal } = fixture();
    const generation = journal.beginReplay(boundary('7'));
    journal.appendFrame(generation, frame('7', 'event'));
    journal.markConsumed('event', 'content');
    const restarted = new ScopedStreamJournal(db, house, validate);
    expect(restarted.pending('content')).toEqual([]);
    expect(restarted.pending('task').map(e => e.eventId)).toEqual(['event']);
    expect(restarted.pending('task')[0]?.envelope).toEqual(raw('event'));
    restarted.markConsumed('event', 'task');
    expect(restarted.pending('task')).toEqual([]);
  });

  it('rejects old generation callbacks and recognizes an empty replay checkpoint', () => {
    const { journal } = fixture(['sc_a', 'sc_b']);
    const old = journal.beginReplay(boundary('9', ['sc_a', 'sc_b']));
    const current = journal.beginReplay(boundary('9', ['sc_a', 'sc_b']));
    expect(() => journal.checkpoint(old, checkpoint('9', ['sc_a', 'sc_b']))).toThrow('OBSOLETE_GENERATION');
    expect(() => journal.appendFrame(old, frame('7', 'obsolete'))).toThrow('OBSOLETE_GENERATION');
    expect(journal.status().caughtUp).toBe(false);
    journal.checkpoint(current, checkpoint('9', ['sc_a', 'sc_b']));
    expect(journal.status().caughtUp).toBe(true);
    journal.appendFrame(current, frame('11', 'live', ['sc_b']));
    journal.checkpoint(current, checkpoint('12', ['sc_a', 'sc_b'], 'live'));
    expect(journal.cursorVector().map(c => c.afterSeq?.toString())).toEqual(['12', '12']);
  });

  it('ends a connection without discarding durable progress or pending consumers', () => {
    const { journal } = fixture();
    const generation = journal.beginReplay(boundary('9'));
    journal.appendFrame(generation, frame('7', 'event'));
    journal.checkpoint(generation, checkpoint('9'));
    journal.endReplay(generation);
    expect(journal.status()).toMatchObject({ caughtUp: false, stale: false, gapReason: null });
    expect(journal.cursorVector()[0]?.afterSeq?.toString()).toBe('9');
    expect(journal.pending('content').map(event => event.eventId)).toEqual(['event']);
    expect(journal.pending('task').map(event => event.eventId)).toEqual(['event']);
    expect(() => journal.checkpoint(generation, checkpoint('10', ['sc_a'], 'live'))).toThrow('OBSOLETE_GENERATION');
  });

  it('ignores endReplay from an obsolete connection and preserves explicit gaps', () => {
    const { journal } = fixture();
    const old = journal.beginReplay(boundary('9'));
    const current = journal.beginReplay(boundary('9'));
    journal.checkpoint(current, checkpoint('9'));
    journal.endReplay(old);
    expect(journal.status().caughtUp).toBe(true);
    journal.checkpoint(current, checkpoint('10', ['sc_a'], 'live'));
    journal.gap(current, popclaw.world.WorldStreamGap.create({ reason: 'history_pruned', scopeId: 'sc_a', boundary: boundary('10') }));
    journal.endReplay(current);
    expect(journal.status()).toMatchObject({ caughtUp: false, stale: true, gapReason: 'history_pruned' });
    expect(journal.cursorVector()[0]?.afterSeq?.toString()).toBe('10');
  });

  it('records boundary-first incarnation gaps durably and retains cache and cursor', () => {
    const { db, journal } = fixture();
    let generation = journal.beginReplay(boundary('7'));
    journal.appendFrame(generation, frame('7', 'event'));
    generation = journal.beginReplay(boundary('2', ['sc_a'], 'log_rebuilt'));
    expect(journal.status()).toMatchObject({ stale: true, caughtUp: false, gapReason: 'log_incarnation_changed', logIncarnation: log });
    journal.gap(generation, popclaw.world.WorldStreamGap.create({ reason: 'log_incarnation_changed', boundary: boundary('2', ['sc_a'], 'log_rebuilt') }));
    expect(journal.cursorVector()[0]?.afterSeq?.toString()).toBe('7');
    expect(journal.pending('task')).toHaveLength(1);
    const restarted = new ScopedStreamJournal(db, house, validate);
    const newGeneration = restarted.beginReplay(boundary('9'));
    expect(() => restarted.checkpoint(newGeneration, checkpoint('9'))).toThrow('STREAM_STALE');
    expect(restarted.status().stale).toBe(true);
  });

  it.each(['unknown_scope', 'cursor_ahead', 'history_pruned'])('persists %s gaps without erasing pending events or cursors', reason => {
    const { db, journal } = fixture();
    const generation = journal.beginReplay(boundary('9'));
    journal.appendFrame(generation, frame('7', 'event'));
    journal.gap(generation, popclaw.world.WorldStreamGap.create({ reason, scopeId: 'sc_a', boundary: boundary('9') }));
    expect(journal.status()).toMatchObject({ stale: true, caughtUp: false, gapReason: reason });
    expect(journal.cursorVector()[0]?.afterSeq?.toString()).toBe('7');
    expect(journal.pending('content')).toHaveLength(1);
    expect(db.queryOne<{ stale: number }>('SELECT stale FROM world_scoped_cursors')?.stale).toBe(1);
    expect(db.queryAll('SELECT * FROM world_scoped_gaps')).toHaveLength(1);
    expect(() => journal.checkpoint(generation, checkpoint('9'))).toThrow('STREAM_STALE');
  });

  it('validates the exact durable reconnect request and records cursor-ahead from the first boundary', () => {
    const { journal } = fixture();
    let generation = journal.beginReplay(boundary('9'));
    journal.checkpoint(generation, checkpoint('9'));
    expect(() => journal.beginReplay(boundary('12'), [popclaw.world.ScopeCursor.fromObject({ scopeId: 'sc_a', afterSeq: '8' })])).toThrow('REQUEST_CURSOR_MISMATCH');
    expect(() => journal.beginReplay(boundary('12', ['sc_b']))).toThrow('BOUNDARY_SCOPE_MISMATCH');
    generation = journal.beginReplay(boundary('8'));
    expect(journal.status()).toMatchObject({ stale: true, gapReason: 'cursor_ahead' });
    expect(() => journal.checkpoint(generation, checkpoint('8'))).toThrow('STREAM_STALE');
  });

  it('keeps independent actor revisions, ignores old descriptors and rejects equal revision conflicts and house changes', () => {
    const { journal } = fixture();
    journal.installDescriptor(descriptor('9007199254740993', ['sc_a', 'sc_b']));
    expect(journal.installDescriptor(descriptor('9007199254740992'))).toEqual({ status: 'old', scopesChanged: false });
    expect(() => journal.installDescriptor(descriptor('9007199254740993', ['sc_a']))).toThrow('DESCRIPTOR_REVISION_CONFLICT');
    journal.installDescriptor(descriptor('1', ['sc_c'], 'other-actor'));
    expect(journal.cursorVector().map(c => c.scopeId)).toEqual(['sc_a', 'sc_b', 'sc_c']);
    const wrong = descriptor('9007199254740994'); wrong.house = { ...house, incarnation: 'wrong' };
    expect(() => journal.installDescriptor(wrong)).toThrow('HOUSE_BINDING_MISMATCH');
  });

  it('preserves a removed scope cursor when a later descriptor includes it again', () => {
    const { journal } = fixture(['sc_a', 'sc_b']);
    const generation = journal.beginReplay(boundary('9', ['sc_a', 'sc_b']));
    journal.checkpoint(generation, checkpoint('9', ['sc_a', 'sc_b']));
    journal.installDescriptor(descriptor('2', ['sc_a']));
    expect(journal.cursorVector().map(c => c.scopeId)).toEqual(['sc_a']);
    journal.installDescriptor(descriptor('3', ['sc_a', 'sc_b', 'sc_c']));
    expect(journal.cursorVector().map(c => c.afterSeq?.toString())).toEqual(['9', '9', '0']);
    expect(journal.status().caughtUp).toBe(false);
  });

  it('atomically rolls back a checkpoint when updating its second scope fails', () => {
    const { db, journal } = fixture(['sc_a', 'sc_b']);
    const generation = journal.beginReplay(boundary('9', ['sc_a', 'sc_b']));
    db.execute("CREATE TRIGGER fail_second_cursor BEFORE UPDATE ON world_scoped_cursors WHEN NEW.scope_id='sc_b' BEGIN SELECT RAISE(ABORT,'checkpoint-disk-test'); END");
    expect(() => journal.checkpoint(generation, checkpoint('9', ['sc_a', 'sc_b']))).toThrow('checkpoint-disk-test');
    expect(journal.cursorVector().map(c => c.afterSeq?.toString())).toEqual(['0', '0']);
    expect(journal.status().caughtUp).toBe(false);
  });

  it('rejects changed bytes or a changed global sequence for an existing event', () => {
    const { journal } = fixture();
    let generation = journal.beginReplay(boundary('9'));
    journal.appendFrame(generation, frame('7', 'event'));
    const changedBytes = frame('8', 'event'); changedBytes.envelope = new TextEncoder().encode('{"eventId":"event","publicScopes":["sc_a"],"extra":true}');
    expect(() => journal.appendFrame(generation, changedBytes)).toThrow('EVENT_BYTES_CONFLICT');
    generation = journal.beginReplay(boundary('9'));
    expect(() => journal.appendFrame(generation, frame('8', 'event'))).toThrow('EVENT_SEQUENCE_CONFLICT');
    expect(journal.cursorVector()[0]?.afterSeq?.toString()).toBe('7');
    expect(journal.pending('task')).toHaveLength(1);
  });

  it.each(['unsigned', 'missing', 'duplicate', 'unrequested', 'unsafe-number', 'overflow'])('rejects invalid %s frames and never lets a checkpoint skip them', kind => {
    const { journal } = fixture();
    const generation = journal.beginReplay(boundary('9'));
    const input = frame('7', 'event');
    if (kind === 'unsigned') input.scopes.push('sc_b');
    if (kind === 'missing') input.envelope = raw('event', ['sc_a', 'sc_b']);
    if (kind === 'duplicate') input.scopes.push('sc_a');
    if (kind === 'unrequested') { input.scopes = ['sc_b']; input.envelope = raw('event', ['sc_b']); }
    if (kind === 'unsafe-number') input.seq = 9007199254740992;
    if (kind === 'overflow') input.seq = { toString: () => '18446744073709551616' } as typeof input.seq;
    expect(() => journal.appendFrame(generation, input)).toThrow();
    expect(() => journal.checkpoint(generation, checkpoint('9'))).toThrow('OBSOLETE_GENERATION');
    expect(journal.cursorVector()[0]?.afterSeq?.toString()).toBe('0');
  });

  it('requires complete replay checkpoint coverage at sealed H and monotonic live checkpoints', () => {
    const { journal } = fixture(['sc_a', 'sc_b']);
    const generation = journal.beginReplay(boundary('9', ['sc_a', 'sc_b']));
    expect(() => journal.checkpoint(generation, checkpoint('9'))).toThrow('CHECKPOINT_SCOPE_MISMATCH');
    expect(() => journal.checkpoint(generation, checkpoint('8', ['sc_a', 'sc_b']))).toThrow('CHECKPOINT_HIGH_WATER_MISMATCH');
    expect(() => journal.checkpoint(generation, checkpoint('10', ['sc_a', 'sc_b'], 'live'))).toThrow('CHECKPOINT_PHASE_INVALID');
    journal.checkpoint(generation, checkpoint('9', ['sc_a', 'sc_b']));
    expect(() => journal.checkpoint(generation, checkpoint('8', ['sc_a', 'sc_b'], 'live'))).toThrow('CURSOR_ROLLBACK');
  });
});


it('returns durable descriptor outcomes without disturbing a completed replay for unchanged scopes', () => {
  const { journal } = fixture();
  const generation = journal.beginReplay(boundary('9')); journal.checkpoint(generation, checkpoint('9'));
  const anchor = journal.replayAnchor();
  expect(journal.installDescriptor(descriptor())).toEqual({ status: 'duplicate', scopesChanged: false });
  expect(journal.replayAnchor()).toBe(anchor);
  expect(journal.installDescriptor(descriptor('2'))).toEqual({ status: 'installed', scopesChanged: false });
  expect(journal.replayAnchor()).toBe(anchor);
  expect(journal.installDescriptor(descriptor('1', ['sc_a', 'sc_b']))).toEqual({ status: 'old', scopesChanged: false });
  expect(journal.replayAnchor()).toBe(anchor);
  expect(journal.installDescriptor(descriptor('3', ['sc_a', 'sc_b']))).toEqual({ status: 'installed', scopesChanged: true });
  expect(journal.replayAnchor()).toBeNull();
});

import { PublicStreamJournal, preparePublicStreamJournal, verifyPublicStreamJournalSchema, EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST } from '../../../src/world/scoped-stream-journal.js';
const publicCapability = { house, capabilityRevision: 'revision-1', publicStream: { endpoint: '/v1/world-stream' as const, mode: 'public-v1' as const, log_incarnation: log, envelope_baseline: 'public-envelope-02' as const, initial_public_scopes: ['sc_a'] } };
function publicOptions(db: InMemoryHostDb, baseline: string = 'public-envelope-02', incarnation: string = log) {
  const controller = new AbortController();
  const capability = { ...publicCapability, publicStream: { ...publicCapability.publicStream, envelope_baseline: baseline as 'public-envelope-02', log_incarnation: incarnation } };
  return { executionDb: db, capability, producerPolicy: { house, capabilityRevision: 'revision-1', officialActorIds: [] }, selection: { fullPublic: true, scopes: ['sc_a'] }, consumerContracts: [], approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST, gate: { origin: house.origin, signal: controller.signal, isActive: () => !controller.signal.aborted }, controller };
}
describe('PublicStreamJournal protected lifecycle', () => {
  it('never creates or repairs protected schema on normal construction', () => {
    const db = new InMemoryHostDb(); dbs.push(db); const options = publicOptions(db);
    expect(() => new PublicStreamJournal(options)).toThrow();
    expect(db.queryAll("SELECT name FROM sqlite_master WHERE type='table'")).toEqual([]);
    const report = preparePublicStreamJournal(options);
    expect(report).toMatchObject({ bindingId: JSON.stringify([house.origin, house.houseKey, house.incarnation]), imported: 0, restricted: 0 });
    expect(report.tables).toHaveLength(8);
    expect(() => verifyPublicStreamJournalSchema(db)).not.toThrow();
    db.execute('DROP TABLE world_public_cursors_v1');
    expect(() => new PublicStreamJournal(options)).toThrow();
    expect(db.queryOne("SELECT name FROM sqlite_master WHERE name='world_public_cursors_v1'")).toBeNull();
  });
  it('binds public-envelope-02 only to a fresh log and rejects legacy and unknown baselines', () => {
    const db = new InMemoryHostDb(); dbs.push(db);
    const v2 = publicOptions(db, 'public-envelope-02');
    expect(() => preparePublicStreamJournal(v2)).not.toThrow();
    v2.controller.abort();
    const old = publicOptions(new InMemoryHostDb(), 'public-envelope-01');
    dbs.push(old.executionDb as InMemoryHostDb);
    expect(() => preparePublicStreamJournal(old)).toThrow('PUBLIC_BASELINE_UNSUPPORTED');
    const unknown = publicOptions(new InMemoryHostDb(), 'public-envelope-99');
    dbs.push(unknown.executionDb as InMemoryHostDb);
    expect(() => preparePublicStreamJournal(unknown)).toThrow('PUBLIC_BASELINE_UNSUPPORTED');
  });
  it('preserves positions and never restores persisted readiness on restart', () => {
    const db = new InMemoryHostDb(); dbs.push(db); const options = publicOptions(db);
    preparePublicStreamJournal(options); const journal = new PublicStreamJournal(options); journal.activate();
    const request = journal.request(); expect(request.publicAfter).toBe('0'); expect(request.cursors[0]!.afterSeq).toBe('0');
    const b = popclaw.world.PublicStreamBoundary.fromObject({ logIncarnation: log, scopes: ['sc_a'], highWaterSeq: '7', fullPublic: true });
    const generation = journal.begin(b, popclaw.world.PublicStreamBoundary.encode(b).finish(), request);
    const c = popclaw.world.PublicStreamCheckpoint.fromObject({ phase: 'replay', publicThroughSeq: '7', scopes: [{scopeId:'sc_a', throughSeq:'7'}] });
    journal.checkpoint(generation, c, popclaw.world.PublicStreamCheckpoint.encode(c).finish());
    expect(journal.receiveStatus().caughtUp).toBe(true);
    journal.end(generation); options.controller.abort();
    const restartOptions = publicOptions(db);
    const restart = new PublicStreamJournal(restartOptions); expect(restart.receiveStatus().caughtUp).toBe(false);
    restart.activate(); expect(restart.request().publicAfter).toBe('7');
    restartOptions.controller.abort(); expect(restart.receiveStatus().caughtUp).toBe(false);
    expect(() => restart.request()).toThrow();
  });
});

import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import type { PublicConsumerContract, PublicConsumer } from '../../../src/world/scoped-stream-journal.js';
import { PublicConsumerRefusal } from '../../../src/world/scoped-stream-journal.js';
const publicKeyPair=nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(81));
const publicActor=bs58.encode(publicKeyPair.publicKey);
function signedPublic(scoped:string[]|null=null,stamp=1){
  const env={actor:{popclawId:publicActor},timestamp:stamp,...(scoped?{houseEvent:{kind:'legacy-.opaque_kind',body:new Uint8Array([255,0]),publicScopes:scoped}}:{profile:{}})};
  const bytes=canonicalizeEnvelope(env);
  return popclaw.event.EventEnvelope.encode({...env,eventId:cidFromCanonical(bytes),signature:nacl.sign.detached(bytes,publicKeyPair.secretKey)}).finish();
}
function publicFrame(seq:string,raw:Uint8Array){
  const env=popclaw.event.EventEnvelope.decode(raw);
  return popclaw.event.WorldStreamFrame.encode(popclaw.event.WorldStreamFrame.fromObject({seq,envelope:raw,kind:env.houseEvent?.kind??'profile',scopes:env.houseEvent?.publicScopes??[]})).finish();
}
function openPublic(db:InMemoryHostDb,contracts:PublicConsumerContract[]=[],fullPublic=true,selected=['sc_a']){
  const options={...publicOptions(db),selection:{fullPublic,scopes:selected},producerPolicy:{house,capabilityRevision:'revision-1',officialActorIds:[publicActor]},consumerContracts:contracts};
  options.approvedConsumerMappingDigest=createHash('sha256').update(JSON.stringify(contracts)).digest('hex');
  preparePublicStreamJournal(options);const journal=new PublicStreamJournal(options);journal.activate();return {journal,options};
}
function beginPublic(journal:PublicStreamJournal,high='120'){
  const req=journal.request();const b=popclaw.world.PublicStreamBoundary.fromObject({logIncarnation:req.incarnation,scopes:req.cursors.map(c=>c.scopeId),highWaterSeq:high,fullPublic:req.publicAfter!==undefined});
  return journal.begin(b,popclaw.world.PublicStreamBoundary.encode(b).finish(),req);
}
function checkpointPublic(journal:PublicStreamJournal,generation:string,high:string,phase='replay'){
  const req=journal.request();const c=popclaw.world.PublicStreamCheckpoint.fromObject({phase,...(req.publicAfter!==undefined?{publicThroughSeq:high}:{}),scopes:req.cursors.map(c=>({scopeId:c.scopeId,throughSeq:high}))});
  journal.checkpoint(generation,c,popclaw.world.PublicStreamCheckpoint.encode(c).finish());
}
const consumerContract=(id:string,mode:'same-db'|'idempotent-effect'='same-db'):PublicConsumerContract=>({consumerId:id,semanticVersion:'1',descriptorDigest:'fixture-descriptor',adapterEntryPoint:'test-only',effectMode:mode,evidenceReference:'actual SQLite fixture below',approvedLegacySourceIds:[]});
describe('PublicStreamJournal actual raw atomicity and consumers',()=>{
  it('adds an older independent scope association without rolling back full-public or repeating delivery',()=>{
    const db=new InMemoryHostDb();dbs.push(db);const {journal}=openPublic(db);
    const binding=journal.bindingId;db.execute("UPDATE world_public_cursors_v1 SET after_seq='100' WHERE lane='public'");
    const generation=beginPublic(journal);const old=signedPublic(['sc_a']);const other=signedPublic(['sc_b'],2);const both=signedPublic(['sc_a'],3);
    const first=publicFrame('50',old);journal.append(generation,first);
    expect(journal.request()).toMatchObject({publicAfter:'100',cursors:[{scopeId:'sc_a',afterSeq:'50'}]});
    journal.append(generation,publicFrame('110',other));expect(journal.request().cursors[0]!.afterSeq).toBe('50');
    journal.append(generation,publicFrame('120',both));checkpointPublic(journal,generation,'120');
    expect(journal.receiveStatus().caughtUp).toBe(true);
    expect(db.queryAll('SELECT lane,scope_id FROM world_public_associations_v1 WHERE binding_id=? AND seq=?',[binding,'50'])).toEqual([{lane:'scope',scope_id:'sc_a'}]);
    expect(Buffer.from(db.queryOne<{frame_bytes:Uint8Array}>('SELECT frame_bytes FROM world_public_frames_v1 WHERE seq=?',['50'])!.frame_bytes)).toEqual(Buffer.from(first));
    expect(db.queryAll('SELECT * FROM world_public_consumers_v1')).toHaveLength(0);
  });
  it('rolls back all receive writes and fences a following checkpoint on a real SQLite failure',()=>{
    const db=new InMemoryHostDb();dbs.push(db);const {journal}=openPublic(db);const generation=beginPublic(journal,'5');
    db.execute("CREATE TRIGGER reject_association BEFORE INSERT ON world_public_associations_v1 BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    expect(()=>journal.append(generation,publicFrame('5',signedPublic(['sc_a'])))).toThrow('fixture failure');
    for(const table of ['events','frames','associations','consumers'])expect(db.queryAll(`SELECT * FROM world_public_${table}_v1`)).toEqual([]);
    expect(journal.request().publicAfter).toBe('0');expect(()=>checkpointPublic(journal,generation,'5')).toThrow();
    expect(journal.receiveStatus().caughtUp).toBe(false);
  });
  it('keeps exact CID/seq bindings immutable and full uint64 checkpoint precision',()=>{
    const db=new InMemoryHostDb();dbs.push(db);const {journal}=openPublic(db,[],true,[]);const generation=beginPublic(journal,'18446744073709551615');
    journal.append(generation,publicFrame('9007199254740993',signedPublic()));
    checkpointPublic(journal,generation,'18446744073709551615');expect(journal.request().publicAfter).toBe('18446744073709551615');
    expect(journal.receiveStatus().scopes).toEqual([]);
  });
  it('commits same-db effect and done together, while later pending rows still run after failure',async()=>{
    const db=new InMemoryHostDb();dbs.push(db);db.execute('CREATE TABLE fixture_effects(event_id TEXT PRIMARY KEY)');
    const contract=consumerContract('local:v1');const {journal,options}=openPublic(db,[contract]);const generation=beginPublic(journal,'2');
    const a=signedPublic(null,1),b=signedPublic(null,2);journal.append(generation,publicFrame('1',a));journal.append(generation,publicFrame('2',b));checkpointPublic(journal,generation,'2');
    const first=db.queryOne<{event_id:string}>('SELECT event_id FROM world_public_events_v1 ORDER BY event_id')!.event_id;
    const consumer:PublicConsumer={contract,mode:'same-db',select:()=> 'accept',apply(tx,d){tx.execute('INSERT INTO fixture_effects VALUES(?)',[d.eventId]);if(d.eventId===first)throw new Error('effect rollback');}};
    await journal.runConsumers([consumer],options.controller.signal);
    expect(db.queryOne('SELECT * FROM fixture_effects WHERE event_id=?',[first])).toBeNull();
    expect(journal.consumerStatus(contract.consumerId)).toMatchObject({pending:1,done:1});expect(journal.receiveStatus().caughtUp).toBe(true);
    await journal.runConsumers([{...consumer,apply(tx,d){tx.execute('INSERT INTO fixture_effects VALUES(?)',[d.eventId]);}}],options.controller.signal);
    expect(journal.consumerStatus(contract.consumerId).done).toBe(2);expect(db.queryAll('SELECT * FROM fixture_effects')).toHaveLength(2);
  });
  it('parks a consumer failure that declares itself permanently refused, and never claims that row again',async()=>{
    const db=new InMemoryHostDb();dbs.push(db);db.execute('CREATE TABLE fixture_effects(event_id TEXT PRIMARY KEY)');
    const contract=consumerContract('refusing:v1');const {journal,options}=openPublic(db,[contract]);const generation=beginPublic(journal,'1');
    journal.append(generation,publicFrame('1',signedPublic()));checkpointPublic(journal,generation,'1');
    let applied=0;
    const consumer:PublicConsumer={contract,mode:'same-db',select:()=> 'accept',apply(){applied++;throw new PublicConsumerRefusal('PUBLIC_RELATION_REFUSED');}};
    await journal.runConsumers([consumer],options.controller.signal);
    expect(applied).toBe(1);
    expect(journal.consumerStatus(contract.consumerId)).toMatchObject({pending:0,running:0,done:0,refused:1});
    expect(db.queryAll('SELECT state,error_code,attempt_token FROM world_public_consumers_v1')).toEqual([{state:'refused',error_code:'PUBLIC_RELATION_REFUSED',attempt_token:null}]);
    // A later sweep whose consumer would have succeeded must not reach the row.
    await journal.runConsumers([{...consumer,apply(tx,d){applied++;tx.execute('INSERT INTO fixture_effects VALUES(?)',[d.eventId]);}}],options.controller.signal);
    expect(applied).toBe(1);expect(db.queryAll('SELECT * FROM fixture_effects')).toHaveLength(0);
    expect(journal.consumerStatus(contract.consumerId)).toMatchObject({pending:0,done:0,refused:1});
  });
  it('keeps retrying a consumer failure that does not declare itself permanent',async()=>{
    const db=new InMemoryHostDb();dbs.push(db);db.execute('CREATE TABLE fixture_effects(event_id TEXT PRIMARY KEY)');
    const contract=consumerContract('transient:v1');const {journal,options}=openPublic(db,[contract]);const generation=beginPublic(journal,'1');
    journal.append(generation,publicFrame('1',signedPublic()));checkpointPublic(journal,generation,'1');
    const consumer:PublicConsumer={contract,mode:'same-db',select:()=> 'accept',apply(){throw new Error('fixture disk busy');}};
    await journal.runConsumers([consumer],options.controller.signal);
    expect(journal.consumerStatus(contract.consumerId)).toMatchObject({pending:1,done:0,refused:0});
    expect(db.queryAll('SELECT state,error_code FROM world_public_consumers_v1')).toEqual([{state:'pending',error_code:'fixture disk busy'}]);
    await journal.runConsumers([{...consumer,apply(tx,d){tx.execute('INSERT INTO fixture_effects VALUES(?)',[d.eventId]);}}],options.controller.signal);
    expect(journal.consumerStatus(contract.consumerId)).toMatchObject({pending:0,done:1,refused:0});
    expect(db.queryAll('SELECT * FROM fixture_effects')).toHaveLength(1);
  });
  it('retries an external committed effect with the same key after owner loss before done',async()=>{
    const db=new InMemoryHostDb();dbs.push(db);const effects=new InMemoryHostDb();dbs.push(effects);effects.execute('CREATE TABLE effects(key TEXT PRIMARY KEY, writes INTEGER NOT NULL)');
    const contract=consumerContract('external:v1','idempotent-effect');let setup=openPublic(db,[contract]);const generation=beginPublic(setup.journal,'1');setup.journal.append(generation,publicFrame('1',signedPublic()));checkpointPublic(setup.journal,generation,'1');
    const keys:string[]=[];let lose=true;
    const consumer:PublicConsumer={contract,mode:'idempotent-effect',select:()=> 'accept',async deliver(_d,context){keys.push(context.idempotencyKey);effects.execute('INSERT OR IGNORE INTO effects VALUES(?,1)',[context.idempotencyKey]);if(lose)setup.options.controller.abort();}};
    await setup.journal.runConsumers([consumer],setup.options.controller.signal);expect(setup.journal.consumerStatus(contract.consumerId).done).toBe(0);
    setup.journal.end(generation);
    lose=false;setup=openPublic(db,[contract]);await setup.journal.runConsumers([consumer],setup.options.controller.signal);
    expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect(effects.queryAll('SELECT * FROM effects')).toHaveLength(1);expect(setup.journal.consumerStatus(contract.consumerId).done).toBe(1);
  });
});

function legacyPublicTable(db:InMemoryHostDb){db.execute(`CREATE TABLE world_stream(seq INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL DEFAULT '',envelope BLOB NOT NULL,projection BLOB,content_done INTEGER NOT NULL,task_done INTEGER NOT NULL,received_at INTEGER NOT NULL)`);}
function insertLegacy(db:InMemoryHostDb,seq:number,raw:Uint8Array,contentDone=1,taskDone=0){const eventId=popclaw.event.EventEnvelope.decode(raw).eventId;db.execute('INSERT INTO world_stream VALUES(?,?,?,?,NULL,?,?,1)',[seq,eventId,'historical',raw,contentDone,taskDone]);return eventId;}
describe('PublicStreamJournal historical import',()=>{
  it('imports raw Profile/opaque original flags once but never imports old cursor, seq or projections as current authority',()=>{
    const db=new InMemoryHostDb();dbs.push(db);legacyPublicTable(db);const a=signedPublic(),b=signedPublic(['sc_a'],2);const eventId=insertLegacy(db,17,a);insertLegacy(db,18,b,0,1);
    db.execute('CREATE TABLE world_stream_cursor(id INTEGER PRIMARY KEY,seq INTEGER)');db.execute('INSERT INTO world_stream_cursor VALUES(1,999)');
    const options={...publicOptions(db),producerPolicy:{house,capabilityRevision:'revision-1',officialActorIds:[publicActor]}};
    const report=preparePublicStreamJournal(options);expect(report).toMatchObject({imported:2,restricted:0});
    expect(db.queryAll('SELECT * FROM world_public_frames_v1')).toEqual([]);expect(db.queryAll('SELECT * FROM world_public_associations_v1')).toEqual([]);
    const journal=new PublicStreamJournal(options);journal.activate();expect(journal.request().publicAfter).toBe('0');
    expect(journal.consumerStatus('legacy-public-content:v1')).toMatchObject({supported:false,done:1,pending:1});expect(journal.consumerStatus('legacy-public-task:v1')).toMatchObject({supported:false,done:1,pending:1});
    db.execute("UPDATE world_public_consumers_v1 SET state='done' WHERE event_id=? AND consumer_id='legacy-public-task:v1'",[eventId]);
    expect(preparePublicStreamJournal(options).imported).toBe(0);expect(journal.consumerStatus('legacy-public-task:v1').done).toBe(2);
    const generation=beginPublic(journal,'17');journal.append(generation,publicFrame('5',a));journal.append(generation,publicFrame('17',signedPublic(null,3)));checkpointPublic(journal,generation,'17');
    expect(db.queryOne<{seq:string}>('SELECT seq FROM world_public_frames_v1 WHERE event_id=?',[eventId])!.seq).toBe('5');
    expect(db.queryAll('SELECT * FROM world_stream')).toHaveLength(2);expect(db.queryOne<{seq:number}>('SELECT seq FROM world_stream_cursor')!.seq).toBe(999);
  });
  it('retains unsafe rows only as restricted receipts and fails reentry when a source changes after quiescence',()=>{
    const db=new InMemoryHostDb();dbs.push(db);legacyPublicTable(db);const raw=signedPublic();const eventId=insertLegacy(db,17,raw);
    const unsafe=popclaw.event.EventEnvelope.decode(signedPublic(null,2));unsafe.signature=new Uint8Array(64);insertLegacy(db,18,popclaw.event.EventEnvelope.encode(unsafe).finish());
    const options=publicOptions(db);expect(preparePublicStreamJournal(options)).toMatchObject({imported:1,restricted:1});
    expect(db.queryAll('SELECT * FROM world_public_events_v1')).toHaveLength(1);expect(db.queryAll("SELECT * FROM world_public_imports_v1 WHERE disposition='restricted'")).toHaveLength(1);
    db.execute("UPDATE world_stream SET kind='mutated' WHERE event_id=?",[eventId]);expect(()=>preparePublicStreamJournal(options)).toThrow('PUBLIC_IMPORT_SOURCE_MUTATED');
    expect(db.queryAll('SELECT * FROM world_public_imports_v1')).toHaveLength(2);
  });
  it('rolls back the entire import on an actual receipt-insert failure and retries idempotently',()=>{
    const db=new InMemoryHostDb();dbs.push(db);legacyPublicTable(db);const options=publicOptions(db);preparePublicStreamJournal(options);insertLegacy(db,1,signedPublic());insertLegacy(db,2,signedPublic(null,2));
    db.execute("CREATE TRIGGER fail_second_receipt BEFORE INSERT ON world_public_imports_v1 WHEN NEW.source_key='2' BEGIN SELECT RAISE(ABORT,'import interrupted'); END");
    expect(()=>preparePublicStreamJournal(options)).toThrow('import interrupted');
    for(const table of ['events','consumers','imports'])expect(db.queryAll(`SELECT * FROM world_public_${table}_v1`)).toEqual([]);
    db.execute('DROP TRIGGER fail_second_receipt');expect(preparePublicStreamJournal(options).imported).toBe(2);expect(preparePublicStreamJournal(options).imported).toBe(0);
  });
  it('preserves scoped source-qualified flags and detects frame-only mutation after import',()=>{
    const db=new InMemoryHostDb();dbs.push(db);const legacy=new ScopedStreamJournal(db,house,validate);legacy.bootstrapLogIncarnation(log);
    const raw=signedPublic(['sc_a']);const eventId=popclaw.event.EventEnvelope.decode(raw).eventId;
    db.execute('INSERT INTO world_scoped_events VALUES(?,?,?,?,?,?)',[JSON.stringify([house.origin,house.houseKey,house.incarnation]),eventId,raw,publicFrame('17',raw),0,1]);
    const options={...publicOptions(db),producerPolicy:{house,capabilityRevision:'revision-1',officialActorIds:[publicActor]}};
    expect(preparePublicStreamJournal(options).imported).toBe(1);const journal=new PublicStreamJournal(options);
    expect(journal.consumerStatus('legacy-scoped-content:v1')).toMatchObject({done:1,supported:false});expect(journal.consumerStatus('legacy-scoped-combined-task:v1').pending).toBe(1);
    db.execute('UPDATE world_scoped_events SET frame_bytes=?',[publicFrame('18',raw)]);expect(()=>preparePublicStreamJournal(options)).toThrow('PUBLIC_IMPORT_SOURCE_MUTATED');
  });
  it('rejects declared identity reuse but adds a new consumer version without inheriting done',async()=>{
    const db=new InMemoryHostDb();dbs.push(db);const first=consumerContract('fixture:v1');let setup=openPublic(db,[first]);const generation=beginPublic(setup.journal,'1');setup.journal.append(generation,publicFrame('1',signedPublic()));checkpointPublic(setup.journal,generation,'1');
    await setup.journal.runConsumers([{contract:first,mode:'same-db',select:()=> 'accept',apply(){}}],setup.options.controller.signal);
    expect(()=>openPublic(db,[{...first,descriptorDigest:'changed'}])).toThrow('PUBLIC_CONSUMER_IDENTITY_CONFLICT');
    setup.journal.end(generation);setup.options.controller.abort();const next=consumerContract('fixture:v2');setup=openPublic(db,[next]);
    expect(setup.journal.consumerStatus(first.consumerId)).toMatchObject({supported:false,done:1});expect(setup.journal.consumerStatus(next.consumerId)).toMatchObject({pending:1,done:0});
  });
});

import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
it('persists exact originals and lane positions across a closed file-backed SQLite restart',()=>{
  const directory=mkdtempSync(join(tmpdir(),'public-journal-restart-'));const path=join(directory,'execution.sqlite');
  let db=new LocalHostDb(path);
  try{
    const controller=new AbortController();const options={...publicOptions(db as unknown as InMemoryHostDb),gate:{origin:house.origin,signal:controller.signal,isActive:()=>!controller.signal.aborted}};
    preparePublicStreamJournal(options);let journal=new PublicStreamJournal(options);journal.activate();const generation=beginPublic(journal,'5');const raw=signedPublic();const frame=publicFrame('5',raw);journal.append(generation,frame);checkpointPublic(journal,generation,'5');
    journal.end(generation);controller.abort();db.close();db=new LocalHostDb(path);const restarted={...publicOptions(db as unknown as InMemoryHostDb)};journal=new PublicStreamJournal(restarted);
    expect(journal.receiveStatus().caughtUp).toBe(false);journal.activate();expect(journal.request()).toMatchObject({publicAfter:'5',cursors:[{scopeId:'sc_a',afterSeq:'5'}]});
    expect(Buffer.from(db.queryOne<{envelope:Uint8Array}>('SELECT envelope FROM world_public_events_v1')!.envelope)).toEqual(Buffer.from(raw));expect(Buffer.from(db.queryOne<{frame_bytes:Uint8Array}>('SELECT frame_bytes FROM world_public_frames_v1')!.frame_bytes)).toEqual(Buffer.from(frame));
    restarted.controller.abort();
  }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});
it('changes authenticated log only through a new gate and preserves all older associations',()=>{
  const db=new InMemoryHostDb();dbs.push(db);const setup=openPublic(db);const first=beginPublic(setup.journal,'17');const raw=signedPublic();setup.journal.append(first,publicFrame('17',raw));checkpointPublic(setup.journal,first,'17');setup.journal.end(first);setup.options.controller.abort();
  // Simulate the persisted profile written by a previous 01 client. It remains
  // historical evidence during a current 02 log switch.
  db.execute("UPDATE world_public_log_profiles_v1 SET envelope_baseline='public-envelope-01' WHERE log_incarnation=?",[log]);
  const controller=new AbortController();const options={...setup.options,controller,gate:{origin:house.origin,signal:controller.signal,isActive:()=>!controller.signal.aborted},capability:{...setup.options.capability,publicStream:{...setup.options.capability.publicStream,log_incarnation:'new-log',envelope_baseline:'public-envelope-02' as const}}};
  const next=new PublicStreamJournal(options);next.activate();expect(next.request().publicAfter).toBe('0');const second=beginPublic(next,'5');next.append(second,publicFrame('5',raw));checkpointPublic(next,second,'5');
  expect(db.queryAll<{log_incarnation:string;seq:string}>('SELECT log_incarnation,seq FROM world_public_frames_v1 ORDER BY seq')).toEqual([{log_incarnation:log,seq:'17'},{log_incarnation:'new-log',seq:'5'}]);
  expect(db.queryAll<{log_incarnation:string;retired:number;envelope_baseline:string}>('SELECT log_incarnation,retired,envelope_baseline FROM world_public_log_profiles_v1 ORDER BY log_incarnation')).toEqual([
    {log_incarnation:log,retired:1,envelope_baseline:'public-envelope-01'},
    {log_incarnation:'new-log',retired:0,envelope_baseline:'public-envelope-02'},
  ]);
  expect(()=>setup.journal.append(first,publicFrame('18',signedPublic(null,2)))).toThrow();expect(next.receiveStatus().caughtUp).toBe(true);
});

import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { PublicWorldStreamClient, rebuildPublicWorldProjection } from '../../../src/ingress/public-world-stream-client.js';
describe('Public journal explicit offline projection rebuild',async()=>{
  it('requires a mode and trusted offline capture; cache deletion rolls back when either is missing',async()=>{
    const db=new InMemoryHostDb();dbs.push(db);const cacheDb=new InMemoryHostDb();dbs.push(cacheDb);const {options}=openPublic(db);options.controller.abort();
    const cache=new WorldFeedCache({db:cacheDb,now:()=>0});await cache.start();cache.record({platform:'popclaw',platformPostId:'old',eventId:'old',envelope:signedPublic()},undefined,100);
    expect(()=>cacheDb.transaction(tx=>{tx.execute('DELETE FROM world_feed');rebuildPublicWorldProjection(db,cache);})).toThrow('PUBLIC_REBUILD_MODE_REQUIRED');
    expect(cacheDb.queryAll('SELECT * FROM world_feed')).toHaveLength(1);
  });
  it('rebuilds the newest checked current-log projection offline with the first fixed observation timestamp',async()=>{
    const db=new InMemoryHostDb();dbs.push(db);const cacheDb=new InMemoryHostDb();dbs.push(cacheDb);const {journal,options}=openPublic(db);const generation=beginPublic(journal,'2');
    const frame=(raw:Uint8Array,seq:string,preview:string)=>{const decoded=popclaw.event.WorldStreamFrame.decode(publicFrame(seq,raw));return popclaw.event.WorldStreamFrame.encode({...decoded,projection:{platform:'popclaw',platformPostId:'same-post',eventId:popclaw.event.EventEnvelope.decode(raw).eventId,textPreview:preview}}).finish();};
    const old=signedPublic([],1),newer=signedPublic([],2);journal.append(generation,frame(old,'1','old'));journal.append(generation,frame(old,'1','duplicate-must-not-overwrite'));journal.append(generation,frame(newer,'2','new'));checkpointPublic(journal,generation,'2');
    db.execute("UPDATE world_public_frames_v1 SET observed_at=CASE seq WHEN '1' THEN 100 ELSE 200 END");options.controller.abort();
    const cache=new WorldFeedCache({db:cacheDb,now:()=>0});await cache.start();let current=true;
    const capture={mode:'public-v1' as const,capability:options.capability,producerPolicy:options.producerPolicy,assertCurrent(){if(!current)throw new Error('MAINTENANCE_CAPTURE_LOST');}};
    cacheDb.transaction(tx=>{tx.execute('DELETE FROM world_feed');rebuildPublicWorldProjection(db,cache,capture);});
    expect(cacheDb.queryOne<{text_preview:string;received_at:number}>('SELECT text_preview,received_at FROM world_feed')).toEqual({text_preview:'new',received_at:200});
    rebuildPublicWorldProjection(db,cache,capture);expect(cacheDb.queryOne<{received_at:number}>('SELECT received_at FROM world_feed')!.received_at).toBe(200);
    current=false;expect(()=>cacheDb.transaction(tx=>{tx.execute('DELETE FROM world_feed');rebuildPublicWorldProjection(db,cache,capture);})).toThrow('MAINTENANCE_CAPTURE_LOST');expect(cacheDb.queryAll('SELECT * FROM world_feed')).toHaveLength(1);
    current=true;
    expect(()=>cacheDb.transaction(tx=>{tx.execute('DELETE FROM world_feed');rebuildPublicWorldProjection(db,{record(item,bytes,at){cache.record(item,bytes,at);current=false;}},capture);})).toThrow('MAINTENANCE_CAPTURE_LOST');
    expect(cacheDb.queryOne<{text_preview:string;received_at:number}>('SELECT text_preview,received_at FROM world_feed')).toEqual({text_preview:'new',received_at:200});
    current=true;const changedCapture={...capture,capability:{...capture.capability,publicStream:{...capture.capability.publicStream,log_incarnation:'other-log'}}};
    expect(()=>cacheDb.transaction(tx=>{tx.execute('DELETE FROM world_feed');rebuildPublicWorldProjection(db,cache,changedCapture);})).toThrow('PUBLIC_REBUILD_CAPTURE_MISMATCH');expect(cacheDb.queryAll('SELECT * FROM world_feed')).toHaveLength(1);
    expect(db.queryAll('SELECT * FROM world_public_consumers_v1')).toEqual([]);expect(journal.request.bind(journal)).toThrow();
  });
  it('retains explicitly selected legacy rebuild even after the new journal exists',async()=>{
    const db=new InMemoryHostDb();dbs.push(db);const cacheDb=new InMemoryHostDb();dbs.push(cacheDb);legacyPublicTable(db);const raw=signedPublic();const eventId=insertLegacy(db,17,raw);db.execute("UPDATE world_stream SET kind='post',projection=?",[popclaw.event.WorldFeedItem.encode({platform:'popclaw',platformPostId:'legacy',eventId}).finish()]);
    preparePublicStreamJournal(publicOptions(db));const cache=new WorldFeedCache({db:cacheDb,now:()=>0});await cache.start();rebuildPublicWorldProjection(db,cache,{mode:'legacy'});
    expect(cacheDb.queryOne<{platform_post_id:string}>('SELECT platform_post_id FROM world_feed')!.platform_post_id).toBe('legacy');
  });
});


import { createPublicStreamSchema, PUBLIC_STREAM_TABLES } from '../../../src/world/scoped-stream-journal.js';
function withTempLocalDb<T>(fn: (db: LocalHostDb) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'public-schema-factory-'));
  const path = join(directory, 'execution.sqlite');
  const db = new LocalHostDb(path);
  try { return fn(db); } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}
describe('createPublicStreamSchema pure factory entry', () => {
  it('creates every public table from empty, verifies, and writes zero rows anywhere', () => {
    withTempLocalDb(db => {
      db.transaction(tx => { createPublicStreamSchema(tx); });
      expect(() => verifyPublicStreamJournalSchema(db)).not.toThrow();
      for (const table of PUBLIC_STREAM_TABLES) expect(db.queryAll(`SELECT * FROM ${table}`)).toHaveLength(0);
    });
  });
  it('is a no-op the second time', () => {
    withTempLocalDb(db => {
      db.transaction(tx => { createPublicStreamSchema(tx); });
      db.transaction(tx => { createPublicStreamSchema(tx); });
      expect(() => verifyPublicStreamJournalSchema(db)).not.toThrow();
      for (const table of PUBLIC_STREAM_TABLES) expect(db.queryAll(`SELECT * FROM ${table}`)).toHaveLength(0);
    });
  });
  it('throws the named maintenance error and writes nothing when the log-profiles table is missing', () => {
    withTempLocalDb(db => {
      db.transaction(tx => { createPublicStreamSchema(tx); });
      db.execute('DROP TABLE world_public_log_profiles_v1');
      expect(() => db.transaction(tx => { createPublicStreamSchema(tx); })).toThrow('PUBLIC_LOG_PROFILE_MAINTENANCE_REQUIRED');
      expect(db.queryOne("SELECT name FROM sqlite_master WHERE name='world_public_log_profiles_v1'")).toBeNull();
      for (const table of PUBLIC_STREAM_TABLES.filter(t => t !== 'world_public_log_profiles_v1')) expect(db.queryAll(`SELECT * FROM ${table}`)).toHaveLength(0);
    });
  });
  it('leaves the pre-existing activation path unchanged: it still binds and writes rows', () => {
    withTempLocalDb(db => {
      const options = publicOptions(db as unknown as InMemoryHostDb);
      const report = preparePublicStreamJournal(options);
      expect(report.tables).toHaveLength(8);
      expect(db.queryOne('SELECT binding_id FROM world_public_bindings_v1')).not.toBeNull();
      expect(db.queryAll('SELECT * FROM world_public_log_profiles_v1')).toHaveLength(1);
      options.controller.abort();
    });
  });
});

describe('Legacy retained projection raw admission', () => {
  it.each(['rebuild', 'retry'] as const)('rejects private original projection before %s replaces it with row.envelope', async (operation) => {
    const db = new InMemoryHostDb(); dbs.push(db);
    legacyPublicTable(db);
    const original = signedPublic();
    insertLegacy(db, 1, original, 0, 0);
    const privateEnvelope = popclaw.event.EventEnvelope.encode({ directMessage: { body: 'private' }, target: { scope: 1 } }).finish();
    const projection = popclaw.event.WorldFeedItem.encode({ platform: 'popclaw', platformPostId: 'private', textPreview: 'private preview', envelope: privateEnvelope }).finish();
    db.execute("UPDATE world_stream SET kind='post',projection=?", [projection]);
    const record = vi.fn();
    if (operation === 'rebuild') {
      expect(() => rebuildPublicWorldProjection(db, { record }, { mode: 'legacy' })).toThrow();
    } else {
      const client = new PublicWorldStreamClient({ baseUrl: house.origin, db, onContent: record });
      await expect(client.retryPending()).rejects.toThrow();
      await client.stop();
    }
    expect(record).not.toHaveBeenCalled();
    expect(db.queryOne('SELECT content_done,task_done FROM world_stream')).toEqual({ content_done: 0, task_done: 0 });
    expect(Buffer.from(db.queryOne<{ projection: Uint8Array }>('SELECT projection FROM world_stream')!.projection)).toEqual(Buffer.from(projection));
  });
});
