import { afterEach, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SocialGraph } from '../../../src/social-graph/social-graph.js';
import { Keystore } from '../../../src/identity/keystore.js';
import { MasterKeySigner } from '../../../src/identity/master-key-signer.js';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { runFollowCommand } from '../../../src/commands/follow.js';
import { runPopclawUnfollowCommand } from '../../../src/commands/popclaw-unfollow.js';
import { fakeRelationProducer } from '../../helpers/fake-relation-producer.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const TARGET = 'BBB', HOUSE = 'synthetic-house';
const databases: InMemoryHostDb[] = [];
afterEach(() => { for (const db of databases) db.close(); databases.length = 0; });

async function setup(action: 'declare' | 'revoke') {
  const db = new InMemoryHostDb();
  databases.push(db);
  runMigrations(db, MIGRATIONS);
  const signer = new MasterKeySigner(await new Keystore(new InMemoryHostAdapter()).loadOrGenerate());
  const push = vi.fn(async (_bytes: Uint8Array, _house?: string) => {});
  const warn = vi.fn();
  // The producer owns the write, so it is what pushes; the graph's own egress
  // seam is not on a relation's path any more. Same spy either way, so what
  // this file is about — a receipt that is not an acceptance must not be read
  // as public success — is measured where it now happens.
  const options = { db, signer, egressPush: push, houseOf: () => HOUSE,
    relationProducer: fakeRelationProducer({ db, houseOf: () => HOUSE, egressPush: push }).producer,
    logger: { info: vi.fn(), warn, error: vi.fn() } };
  const graph = new SocialGraph(options);
  await graph.start();
  if (action === 'revoke') await graph.declareFollow(TARGET);
  push.mockClear();
  return { db, graph, push, warn, options };
}

const cases = (['declare', 'revoke'] as const).flatMap(action =>
  (['failed', 'unknown'] as const).map(outcome => ({ action, outcome })),
);
function outgoingError(outcome: 'failed' | 'unknown'): Error {
  return outcome === 'failed' ? new Error('push rejected by the house')
    : Object.assign(new Error('operation retained-operation: remote result unknown'), {
      result: { status: 0, operationId: 'retained-operation', state: 'unknown', errorCode: 'ACTION_RESULT_UNKNOWN' },
    });
}

it.each(cases)('$action preserves the original $outcome error and committed local state', async ({ action, outcome }) => {
  const s = await setup(action);
  const failure = outgoingError(outcome);
  s.push.mockRejectedValueOnce(failure);
  // The contract changed with the producer, and the change is the point: a
  // signed original that the house did not accept is DURABLE and queued for
  // re-send, so this is no longer an exception the caller must catch. What
  // must not change is that it is not an acceptance.
  const produced = action === 'declare'
    ? await s.graph.declareFollowWithOutcome(TARGET)
    : await s.graph.revokeFollowWithOutcome(TARGET);
  expect(produced.mode).toBe('ordered');
  if (produced.mode === 'ordered') {
    expect(produced.transport).toBe('queued');
    expect(produced.transport).not.toBe('accepted');
    expect(String(produced.failure?.detail)).toContain(failure.message);
  }
  expect(s.push).toHaveBeenCalledTimes(1);
  expect(s.push.mock.calls[0]![1]).toBe(HOUSE);
  expect(s.graph.followsIn(TARGET, HOUSE)).toBe(action === 'declare');
  const events = s.db.queryAll<{ type: string; house_slug: string }>('SELECT type,house_slug FROM follow_events ORDER BY id');
  expect(events.map(event => event.type)).toEqual(action === 'declare' ? ['FollowDeclared'] : ['FollowDeclared', 'FollowRevoked']);
  expect(events.every(event => event.house_slug === HOUSE)).toBe(true);
  const rebuilt = new SocialGraph(s.options);
  await rebuilt.start();
  expect(rebuilt.followsIn(TARGET, HOUSE)).toBe(action === 'declare');
});

it.each(cases)('$action command does not report public success or record a successful action on $outcome', async ({ action, outcome }) => {
  const s = await setup(action);
  const failure = outgoingError(outcome);
  s.push.mockRejectedValueOnce(failure);
  const socialLog = { record: vi.fn() };
  const bondsStore = { recordInteraction: vi.fn(), setFollowed: vi.fn() };
  const pendingFollows = { markConfirmed: vi.fn() };
  const deps = { socialGraph: s.graph, socialLog, bondsStore, pendingFollows, ownPopclawId: 'owner-id-that-is-nobody-here' };
  const reply = action === 'declare' ? await runFollowCommand(TARGET, deps) : await runPopclawUnfollowCommand(TARGET, deps);
  expect(reply.text).not.toMatch(/^✓/);
  // Names the CURRENT success wording: a negative assertion against a phrase
  // the code no longer produces passes for free and guards nothing.
  expect(reply.text).not.toMatch(/has the (follow|unfollow) declaration/);
  // Queued must not name a house either (architect ruling, G1-copy): naming
  // one before it actually landed there would claim something the transport
  // hasn't confirmed.
  expect(reply.text).not.toContain(HOUSE);
  // The owner gets readable copy, not a transport error; the diagnostic is
  // kept in the outcome (asserted above) rather than printed at them.
  expect(reply.text).toMatch(/…/);
  expect(socialLog.record).not.toHaveBeenCalled();
  expect(bondsStore.recordInteraction).not.toHaveBeenCalled();
  expect(bondsStore.setFollowed).not.toHaveBeenCalled();
  expect(pendingFollows.markConfirmed).not.toHaveBeenCalled();
  expect(s.graph.followsIn(TARGET, HOUSE)).toBe(action === 'declare');
  expect(s.push).toHaveBeenCalledTimes(1);
});

it.each(['declare', 'revoke'] as const)('%s command records success after egress resolves', async action => {
  const s = await setup(action);
  const socialLog = { record: vi.fn() };
  const pendingFollows = { markConfirmed: vi.fn() };
  // houseDisplayName resolves the slug to a name (owner acceptance,
  // package 4d07af17: the receipt must never render the raw slug); an
  // identity mapping here keeps this test's house-naming assertions meaningful.
  const deps = {
    socialGraph: s.graph,
    socialLog,
    pendingFollows,
    ownPopclawId: 'owner-id-that-is-nobody-here',
    houseDisplayName: (slug: string) => (slug === HOUSE ? HOUSE : undefined),
  };
  const reply = action === 'declare' ? await runFollowCommand(TARGET, deps) : await runPopclawUnfollowCommand(TARGET, deps);
  expect(reply.text).toMatch(/^✓/);
  // G1-copy: accepted by a known house, so the receipt names it.
  expect(reply.house).toBe(HOUSE);
  expect(reply.text).toContain(HOUSE);
  expect(socialLog.record).toHaveBeenCalledWith({ kind: action === 'declare' ? 'follow_added' : 'follow_removed', house_slug: HOUSE, actor: { id: TARGET } });
  expect(pendingFollows.markConfirmed).toHaveBeenCalledTimes(action === 'declare' ? 1 : 0);
  expect(s.graph.followsIn(TARGET, HOUSE)).toBe(action === 'declare');
  expect(s.push).toHaveBeenCalledTimes(1);
  expect(s.warn).not.toHaveBeenCalled();
});
