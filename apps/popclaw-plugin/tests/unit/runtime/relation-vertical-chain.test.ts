/**
 * The short vertical chain: one real relation frame, from the wire to the edge.
 *
 * Everything here is production code except the socket. The transport is the
 * real `InboxStreamClient` behind a fake EventSource, the verification is the
 * real `verifyInboundEnvelope`, the commit point and the adjudicator are the
 * real relation wiring, and the database is a real SQLite schema built by the
 * real migrations. The frame is a genuinely signed `FollowDeclared`.
 *
 * It exists because every previous step in this work could be reported as
 * "done" while the chain still carried nothing: the modules compiled, the
 * callback was wired, and a legitimate Follow was still being dropped three
 * layers down. A chain is only connected when something actually travels it.
 *
 * What this pins: a write failure does not let the cursor advance past the
 * frame that failed; a replay does not duplicate; a frame from a superseded
 * session has no effect; and leaving ends the participation.
 *
 * What it deliberately does NOT pin is "one connection per house". This file
 * constructs exactly one client itself, so such an assertion could never go
 * red — it would read as coverage while measuring the test's own setup. The
 * real hazard is two DIFFERENT assemblies each opening one (`relation-host`
 * still calls `openHouseInboxStreams` while `resource-set` owns a client),
 * and nothing here can see that. It belongs to whichever change unifies them.
 */
import { describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { createRelationWiring } from '../../../src/social-graph/relation-wiring.js';
import {
  InboxStreamClient,
  INBOX_ENVELOPE_EVENT,
  type AnyEventSource,
  type SseFrame,
} from '../../../src/messaging/inbox-stream-client.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(11));
const FOLLOWER = bs58.encode(kp.publicKey);
const ME = 'me-popclaw-id';
// Deliberately different from the followee: if an implementation fills one
// from the other, identical strings would hide it.
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

function followFrame(seq: string): { bytes: Uint8Array; eventId: string; b64: string } {
  const env = {
    actor: { popclawId: FOLLOWER },
    target: {},
    lorehouse: HOUSE_KEY,
    timestamp: 1_713_657_600,
    followDeclared: { followeePopclawId: ME, order: { seq, houseKey: HOUSE_KEY } },
  };
  const canonical = canonicalizeEnvelope(env);
  const eventId = cidFromCanonical(canonical);
  const bytes = popclaw.event.EventEnvelope.encode({
    ...env, eventId, signature: nacl.sign.detached(canonical, kp.secretKey),
  }).finish();
  return { bytes, eventId, b64: Buffer.from(bytes).toString('base64') };
}

type FakeES = AnyEventSource & { listeners: Record<string, (e: SseFrame) => void>; closed: number };

/** The whole chain, assembled the way resource-set assembles it. */
async function chain(opts: { failFirstCommit?: boolean } = {}) {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const wiring = createRelationWiring({ db, recipientPopclawId: ME });
  const handle = wiring.login({ houseKey: HOUSE_KEY, incarnation: '1', houseSlug: 'h1' });

  const made: FakeES[] = [];
  const Ctor = class {
    onmessage: ((e: SseFrame) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    listeners: Record<string, (e: SseFrame) => void> = {};
    closed = 0;
    constructor(readonly url: string) { made.push(this as unknown as FakeES); }
    addEventListener(type: string, listener: (e: SseFrame) => void): void { this.listeners[type] = listener; }
    close(): void { this.closed += 1; }
  } as unknown as new (url: string) => AnyEventSource;

  let failNext = opts.failFirstCommit === true;
  const received: string[] = [];
  const client = new InboxStreamClient({
    baseUrl: 'http://house.test',
    recipientPopclawId: ME,
    readToken: () => Promise.resolve('token'),
    onMessage: () => {},
    onError: () => {},
    reconnectDelayMs: 50_000,
    eventSourceCtor: Ctor,
    // Exactly what resource-set now passes: the chain says what to do with a
    // frame, the transport stays the transport.
    onFrame: (envelope, position) => {
      if (failNext) { failNext = false; throw new Error('WRITE_FAILED'); }
      const eventId = popclaw.event.EventEnvelope.decode(envelope).eventId;
      received.push(eventId);
      handle.receive({ stream: 'personal', envelopeBytes: envelope, eventId,
        ...(position !== undefined ? { position } : {}) });
    },
    resumeFrom: () => handle.resumeFrom('personal'),
  });
  client.start();
  await vi.waitFor(() => expect(made.length).toBe(1));

  return {
    db, wiring, handle, client, received,
    sources: made,
    es: () => made[made.length - 1]!,
    // The durable stage is serial per connection, so a frame is QUEUED here
    // and committed on the microtask queue. Awaiting the client's own idle
    // join is what makes these assertions about the commit, not about timing.
    feed: async (b64: string, position: string) => {
      made[made.length - 1]!.listeners[INBOX_ENVELOPE_EVENT]!({ data: b64, lastEventId: position });
      await client.whenIdle();
    },
    edges: () => db.queryAll<{ follower_popclaw_id: string; followee_popclaw_id: string; house_key: string; state: string; applied_seq: number | null }>(
      'SELECT follower_popclaw_id, followee_popclaw_id, house_key, state, applied_seq FROM relation_edges'),
    cursor: () => handle.resumeFrom('personal'),
  };
}

describe('one relation frame, wire to edge', () => {
  it('travels the whole chain and lands as an edge', async () => {
    const c = await chain();
    expect(c.edges()).toHaveLength(0); // nothing here before — the run is not vacuous

    const f = followFrame('1');
    await c.feed(f.b64, '1.5');

    // Committed by the frame's arrival...
    expect(c.received).toEqual([f.eventId]);
    // ...and adjudicated by the drain, which is where the projection moves.
    const outcomes = c.wiring.drain();
    expect(outcomes.length).toBeGreaterThan(0);

    const edges = c.edges();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      follower_popclaw_id: FOLLOWER,
      followee_popclaw_id: ME,
      house_key: HOUSE_KEY, // scoped to the house, not to the followee
    });
    expect(c.cursor()).toBe('1.5');
  });

  it('does not duplicate when the house replays the same frame', async () => {
    const c = await chain();
    const f = followFrame('1');
    await c.feed(f.b64, '1.5');
    c.wiring.drain();
    const before = c.edges();

    await c.feed(f.b64, '1.5'); // a reconnect re-delivering is ordinary
    c.wiring.drain();

    expect(c.edges()).toEqual(before);
    expect(c.edges()).toHaveLength(1);
  });

  it('does not let the cursor advance past a frame that failed to commit', async () => {
    const c = await chain({ failFirstCommit: true });
    const f1 = followFrame('1');
    await c.feed(f1.b64, '1.5'); // throws inside onFrame

    // The transport is torn down rather than reading on, and no position was
    // recorded — a reconnect will be handed the frame again.
    expect(c.es().closed).toBe(1);
    expect(c.cursor()).toBeUndefined();
    expect(c.edges()).toHaveLength(0);
  });

  it('gives a superseded session no effect once a new login has taken over', async () => {
    const c = await chain();
    await c.feed(followFrame('1').b64, '1.5');
    c.wiring.drain();
    expect(c.edges()).toHaveLength(1);
    expect(c.edges()[0]?.applied_seq).toBe(1);

    // Another process logs in at the same house. The old handle is NOT closed
    // — deliberately. Calling leave() or detach() on it would short-circuit
    // receive() on its own `closed` flag before the commit point is reached,
    // and this test would then pass with the participation fence deleted,
    // which is exactly what it claims to measure. With the old handle still
    // open, the ONLY thing standing between the late frame and the edge is
    // the owner-generation check inside commitInboundFrame.
    const fresh = c.wiring.login({ houseKey: HOUSE_KEY, incarnation: '1', houseSlug: 'h1' });
    expect(fresh.source.ownerGeneration).toBeGreaterThan(c.handle.source.ownerGeneration);

    const late = followFrame('2');
    const verdict = c.handle.receive({ stream: 'personal', envelopeBytes: late.bytes,
      eventId: late.eventId, position: '1.6' });
    expect(verdict.disposition).not.toBe('accepted');

    c.wiring.drain();

    // The bytes may be kept; the EFFECT must not land, and the cursor must not
    // move for a session that has been superseded.
    expect(c.edges()).toHaveLength(1);
    expect(c.edges()[0]?.applied_seq).toBe(1);
    expect(fresh.resumeFrom('personal')).toBe('1.5');
  });

  it('leaving ends the participation, so a reconnect cannot attach to it', async () => {
    const c = await chain();
    await c.feed(followFrame('1').b64, '1.5');
    c.wiring.drain();
    // Before: an ordinary reconnect finds a live participation to join.
    expect(c.wiring.attach({ houseKey: HOUSE_KEY, incarnation: '1', houseSlug: 'h1' })).toBeDefined();

    c.handle.leave();

    // After: there is nothing to attach to. This is leave's own effect, and
    // the one thing detaching does NOT do — a reconnect must not quietly log
    // the owner back in to a house they left.
    expect(c.wiring.attach({ houseKey: HOUSE_KEY, incarnation: '1', houseSlug: 'h1' })).toBeUndefined();
    // Leaving is not forgetting: the edge it already proved survives.
    expect(c.edges()).toHaveLength(1);
  });
});
