/**
 * Issue #553 batch C: PublicWorldStreamClient behavior regressions.
 *
 * Covers raw frame BLOB persistence and cursor advancement; idempotent replay without
 * duplicate dispatch; content onContent receiving projections with restored raw bytes;
 * Ranger onEnvelope receiving decoded envelopes; unknown kinds persisted without dispatch;
 * restart cursors included in the URL; and deferred IngressProxy binding.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
const fixtureKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
const fixtureActor = bs58.encode(fixtureKey.publicKey);
let fixtureSequence = 0;
import { LocalHostDb } from '../../../src/host/local-host-db';
import type { HostDb } from '../../../src/host/host-db';
import {
  IngressProxy,
  PublicWorldStreamClient,
} from '../../../src/ingress/public-world-stream-client';
import type { AnyEventSource } from '../../../src/ingress/world-feed-stream-client';
import type { EnvelopeHandler } from '../../../src/ingress/event-ingress';
import type { InboundEnvelope } from '../../../src/ingress/event-ingress';

class FakeEventSource implements AnyEventSource {
  static lastInstance: FakeEventSource | null = null;
  readonly url: string;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.lastInstance = this;
  }
  emit(frame: popclaw.event.IWorldStreamFrame, lastEventId?: string): void {
    const buf = popclaw.event.WorldStreamFrame.encode(frame).finish() as Uint8Array;
    const data = Buffer.from(buf).toString('base64');
    this.onmessage?.(lastEventId === undefined ? { data } : { data, lastEventId });
  }
  close(): void {
    this.closed = true;
  }
}

/** absorb() is async — let pending microtasks (dispatch + flag update) settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function envelopeBytes(body: Record<string, unknown>): { bytes: Uint8Array; eventId: string } {
  const env = new popclaw.event.EventEnvelope({
    eventId: '',
    actor: new popclaw.identity.ActorInfo({
      popclawId: fixtureActor,
      nickname: 'A',
    }),
    timestamp: 1700000000 + fixtureSequence++,
    ...(body as object),
  } as popclaw.event.IEventEnvelope);
  const canonical = canonicalizeEnvelope(env);
  env.eventId = cidFromCanonical(canonical);
  env.signature = nacl.sign.detached(canonical, fixtureKey.secretKey);
  return { bytes: popclaw.event.EventEnvelope.encode(env).finish() as Uint8Array, eventId: env.eventId };
}

function postEnvelope(): { bytes: Uint8Array; eventId: string } {
  return envelopeBytes({
    post: new popclaw.event.Post({
      blocks: [new popclaw.event.ContentBlock({ blockType: 0, content: 'hello stream' })],
    }),
  } as unknown as Record<string, unknown>);
}

function questEnvelope(): { bytes: Uint8Array; eventId: string } {
  return envelopeBytes({
    questDispatch: new popclaw.quest.QuestDispatch({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      kind: 1,
      expiresAt: '4000000000',
    }),
    target: new popclaw.event.Recipient({ scope: 2, targetIds: ['rangerA'] }),
  } as unknown as Record<string, unknown>);
}

function makeClient(
  db: HostDb,
  opts: {
    onContent?: (item: popclaw.event.IWorldFeedItem) => void;
    gate?: ConstructorParameters<typeof PublicWorldStreamClient>[0]['gate'];
  } = {},
): PublicWorldStreamClient {
  return new PublicWorldStreamClient({
    baseUrl: 'http://house.test',
    isOfficialActor: id => id === fixtureActor,
    db,
    eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    ...opts,
  });
}

describe('PublicWorldStreamClient', () => {
  it('rejects bad signatures and false IDs before persistence, cursor or dispatch', async () => {
    const db = new LocalHostDb(':memory:');
    const client = makeClient(db);
    await client.start(() => { throw new Error('must not dispatch'); });
    const good = postEnvelope();
    const env = popclaw.event.EventEnvelope.decode(good.bytes);
    env.signature = Uint8Array.from(env.signature);
    env.signature[0] = env.signature[0]! ^ 1;
    await assert.rejects(client.absorb({ seq: 1, eventId: good.eventId, kind: 'post', envelope: popclaw.event.EventEnvelope.encode(env).finish(), projection: null }), /SIGNATURE_INVALID/);
    await assert.rejects(client.absorb({ seq: 2, eventId: 'false-id', kind: 'post', envelope: good.bytes, projection: null }), /CID_MISMATCH/);
    assert.equal(client.cursor(), 0);
    assert.equal(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM world_stream')?.n, 0);
    await client.stop(); db.close();
  });

  it('closing the captured gate suppresses queued work and late completion marks', async () => {
    const db = new LocalHostDb(':memory:');
    const controller = new AbortController();
    const client = makeClient(db, { gate: { signal: controller.signal, isActive: () => !controller.signal.aborted } });
    let release!: () => void;
    let calls = 0;
    await client.start(async () => { calls++; await new Promise<void>(r => { release = r; }); });
    const event = questEnvelope();
    const frame = { seq: 1, eventId: event.eventId, kind: 'quest_dispatch', envelope: event.bytes, projection: null };
    const first = client.absorb(frame);
    const queued = client.absorb(frame);
    controller.abort();
    release();
    await Promise.all([first, queued]);
    assert.equal(calls, 1);
    assert.equal(db.queryOne<{ task_done: number }>('SELECT task_done FROM world_stream')?.task_done, 0);
    await client.retryPending();
    assert.equal(calls, 1);
    await client.stop(); db.close();
  });

  let db: HostDb;

  beforeEach(() => {
    db = new LocalHostDb(':memory:');
    FakeEventSource.lastInstance = null;
  });

  it('stores frames verbatim, advances the cursor, and dispatches content+envelope', async () => {
    const seenContent: popclaw.event.IWorldFeedItem[] = [];
    const seenEnvelopes: InboundEnvelope[] = [];
    const client = makeClient(db, {
      onContent: (item) => seenContent.push(item),
    });
    const handler: EnvelopeHandler = (inbound) => {
      seenEnvelopes.push(inbound);
    };
    await client.start(handler);
    const es = FakeEventSource.lastInstance!;
    assert.ok(es.url.includes('/v1/world-stream?'), `url: ${es.url}`);
    assert.ok(es.url.includes('limit='), 'sends a backfill limit');

    const post = postEnvelope();
    es.emit(
      {
        seq: 1,
        envelope: post.bytes,
        kind: 'post',
        projection: new popclaw.event.WorldFeedItem({
          platform: 'popclaw',
          platformPostId: 'pid-1',
          eventId: post.eventId,
          authorPopclawId: 'authorA',
          textPreview: 'hello stream',
        }),
      },
      '1',
    );
    await flush();

    assert.equal(seenContent.length, 1, 'content consumer called once');
    const contentItem = seenContent[0]!;
    assert.deepEqual(
      Buffer.from(contentItem.envelope as Uint8Array),
      Buffer.from(post.bytes),
      'frame-level verbatim bytes ride back inside the projection',
    );
    assert.equal(seenEnvelopes.length, 1);
    assert.equal(seenEnvelopes[0]!.eventId, post.eventId);

    const row = db.queryOne<{ event_id: string; kind: string; envelope: Buffer }>(
      `SELECT event_id, kind, envelope FROM world_stream WHERE seq = 1`,
    );
    assert.ok(row);
    assert.equal(row.event_id, post.eventId);
    assert.equal(row.kind, 'post');
    assert.deepEqual(row.envelope, Buffer.from(post.bytes), 'stored blob is verbatim');
    assert.equal(client.cursor(), 1);
  });

  it('redelivered frames are idempotent: stored once, dispatched once', async () => {
    const seen: InboundEnvelope[] = [];
    const client = makeClient(db);
    await client.start((inbound) => {
      seen.push(inbound);
    });
    const es = FakeEventSource.lastInstance!;

    const quest = questEnvelope();
    const frame = { seq: 7, envelope: quest.bytes, kind: 'quest_dispatch' };
    es.emit(frame, '7');
    await flush();
    es.emit(frame, '7'); // Replay at the server replay/live boundary (already dispatched → skip).
    await flush();

    assert.equal(seen.length, 1, 'duplicate delivery must not re-dispatch');
    const n = db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM world_stream`);
    assert.equal(n?.n, 1);
    assert.equal(client.cursor(), 7);
  });

  it('unknown kinds are stored and never dispatched', async () => {
    const seen: InboundEnvelope[] = [];
    const seenContent: popclaw.event.IWorldFeedItem[] = [];
    const client = makeClient(db, { onContent: (i) => seenContent.push(i) });
    await client.start((inbound) => {
      seen.push(inbound);
    });
    const es = FakeEventSource.lastInstance!;

    const worldEvent = envelopeBytes({
      houseEvent: new popclaw.event.HouseEvent({ kind: 'world.postcard', body: new Uint8Array([1]) }),
    } as unknown as Record<string, unknown>);
    es.emit({ seq: 2, envelope: worldEvent.bytes, kind: 'world.postcard' }, '2');
    await flush();

    const row = db.queryOne<{ kind: string }>(`SELECT kind FROM world_stream WHERE seq = 2`);
    assert.ok(row);
    assert.equal(row.kind, 'world.postcard');
    // House vocabulary: without a projection, skip content consumers but still pass the envelope to the handler.
    // EventDispatcher decides who consumes it (unrecognized classify results are silently dropped).
    assert.equal(seenContent.length, 0);
    assert.equal(seen.length, 1, 'envelope still reaches the dispatcher-boundary handler');
  });

  it('resume cursor from a restarted process lands in the URL', async () => {
    const first = makeClient(db);
    await first.start(() => {});
    const es = FakeEventSource.lastInstance!;
    const post = postEnvelope();
    es.emit({ seq: 42, envelope: post.bytes, kind: 'post' }, '42');
    await flush();
    await first.stop();

    const second = makeClient(db);
    await second.start(() => {});
    const url = FakeEventSource.lastInstance!.url;
    assert.ok(url.includes('after=42'), `resume cursor expected in url: ${url}`);
  });

  it('content kinds without a projection still reach the envelope consumer only', async () => {
    const seenContent: popclaw.event.IWorldFeedItem[] = [];
    const client = makeClient(db, { onContent: (i) => seenContent.push(i) });
    await client.start(() => {});
    const post = postEnvelope();
    FakeEventSource.lastInstance!.emit({ seq: 3, envelope: post.bytes, kind: 'post' }, '3');
    await flush();
    assert.equal(seenContent.length, 0, 'no projection → not a content dispatch');
    const row = db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM world_stream`);
    assert.equal(row?.n, 1, 'still stored');
  });

  it('IngressProxy replays start/onConnected across late bind', async () => {
    const proxy = new IngressProxy();
    const seen: InboundEnvelope[] = [];
    let connected = 0;
    await proxy.start((inbound) => {
      seen.push(inbound);
    });
    proxy.onConnected(() => {
      connected += 1;
    });

    // No receiver before bind; start one first (Ranger scenario).
    const real = makeClient(db);
    proxy.bind(real);
    const es = FakeEventSource.lastInstance!;
    es.onopen?.();
    assert.equal(connected, 1, 'connected callback fired via the bound receiver');

    const quest = questEnvelope();
    es.emit({ seq: 9, envelope: quest.bytes, kind: 'quest_dispatch' }, '9');
    await flush();
    assert.equal(seen.length, 1, 'handler registered before bind still receives frames');

    await proxy.stop();
    assert.equal(FakeEventSource.lastInstance!.closed, true, 'stop closes the receiver');
  });

  // Recheck G1 using the real index.ts assembly order: start() (content-only) →
  // proxy.bind. The real Ranger handler must execute retained pending tasks exactly once;
  // starting without a handler must not mark them complete.
  it('boot-order no-op start must not consume pending tasks (G1)', async () => {
    // First leave a failed pending task.
    const quest = questEnvelope();
    {
      const seed = makeClient(db);
      await seed.start(() => {
        throw new Error('previous run failed');
      });
      await seed
        .absorb({
          seq: 7,
          eventId: quest.eventId,
          kind: 'quest_dispatch',
          envelope: quest.bytes,
          projection: null,
        })
        .catch(() => {});
      await seed.stop();
    }

    // Real assembly order: IngressProxy receives start(handler), the receiver starts in content-only
    // mode, then bind runs.
    let realCalls = 0;
    const proxy = new IngressProxy();
    await proxy.start(() => {
      realCalls += 1;
    });
    const receiver = makeClient(db);
    const boot = receiver.start(); // content-only: G1 fix point, do not pass a no-op.
    proxy.bind(receiver);
    await boot;
    // bind does not await its internal start/retryPending; allow an extra microtask.
    await flush();
    await flush();

    assert.equal(realCalls, 1, 'the REAL handler runs the pending task exactly once');
    assert.equal(
      db.queryOne<{ task_done: number }>(
        `SELECT task_done FROM world_stream WHERE event_id = ?`,
        [quest.eventId],
      )?.task_done,
      1,
    );
    await receiver.stop();
  });

  // Recheck G2: while a sweep's old task list is waiting, tasks completed through another entry point must not
  // run again (recheck the persisted flag inside the exclusive section).
  it('a stale sweep list must not re-execute an event completed elsewhere (G2)', async () => {
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const calls = { a: 0, b: 0 };
    const qa = questEnvelope();
    const qb = questEnvelope();
    const client = makeClient(db);
    let seeded = true;
    await client.start(async (inbound) => {
      if (seeded) throw new Error('seed pending');
      calls[inbound.eventId === qa.eventId ? 'a' : 'b'] += 1;
      if (inbound.eventId === qa.eventId) await gate;
    });
    const mk = (id: string, bytes: Uint8Array, seq: number) => ({
      seq,
      eventId: id,
      kind: 'quest_dispatch',
      envelope: bytes,
      projection: null,
    });
    await client.absorb(mk(qa.eventId, qa.bytes, 1)).catch(() => {});
    await client.absorb(mk(qb.eventId, qb.bytes, 2)).catch(() => {});
    seeded = false;

    // Start the sweep: run a first (blocked at the gate), while b completes through the live path.
    const sweep = client.retryPending();
    await flush(); // a enters the gate.
    await client.absorb(mk(qb.eventId, qb.bytes, 2)); // Live processing completes b (the old sweep would execute b again later).
    releaseA();
    await sweep;

    assert.deepEqual(calls, { a: 1, b: 1 }, 'each task executed exactly once');
    assert.equal(
      db.queryOne<{ task_done: number }>(
        `SELECT task_done FROM world_stream WHERE event_id = ?`,
        [qb.eventId],
      )?.task_done,
      1,
    );
    await client.stop();
  });

  // Recheck F1: replayed frames and reconnect sweeps must not reenter the handler while the first attempt is in flight.
  it('an in-flight dispatch is not re-entered by redelivery or a retry sweep', async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = makeClient(db);
    await client.start(() => {
      calls += 1;
      return gate;
    });
    const quest = questEnvelope();
    const frame = {
      seq: 7,
      eventId: quest.eventId,
      kind: 'quest_dispatch',
      envelope: quest.bytes,
      projection: null,
    };
    // First attempt in flight (handler blocked at the gate), then replay the same frame and start a reconnect sweep.
    const first = client.absorb(frame);
    const second = client.absorb(frame); // Replay while in flight.
    await flush(); // Let the first attempt actually enter the handler.
    const sweep = client.retryPending(); // Reconnect sweep: do not await, since it waits on the same in-flight Promise.
    await flush();
    assert.equal(calls, 1, 'in-flight redelivery/retry must await, not re-enter');

    release();
    await Promise.all([first, second, sweep]);
    assert.equal(calls, 1, 'after settle, still exactly one execution');
    assert.equal(
      db.queryOne<{ task_done: number }>(
        `SELECT task_done FROM world_stream WHERE event_id = ?`,
        [quest.eventId],
      )?.task_done,
      1,
    );

    // Once in-flight state clears, failures remain retryable: dispatch fails → dispatched stays 0 → next sweep retries.
    let failNext = true;
    const flaky = makeClient(db);
    await flaky.start(() => {
      if (failNext) {
        failNext = false;
        throw new Error('first attempt fails');
      }
      calls += 100;
      return undefined;
    });
    const quest2 = questEnvelope();
    await flaky
      .absorb({
        seq: 8,
        eventId: quest2.eventId,
        kind: 'quest_dispatch',
        envelope: quest2.bytes,
        projection: null,
      })
      .catch(() => {}); // Direct callers catch failures themselves (onmessage catches them on the SSE path).
    assert.equal(calls, 1, 'failed attempt consumed');
    await flaky.retryPending(); // Retry in the same process, simulating a reconnect sweep.
    assert.equal(calls, 101, 'retry after in-process failure succeeds');
  });

  // Acceptance report R3: dispatch failure → restart → successful retry; replay of dispatched events does not execute again.
  it('a failed dispatch is retried after restart; completed work is not re-run', async () => {
    const errors: unknown[] = [];
    const quest = questEnvelope();
    let failFirst = true;
    let successes = 0;

    // Phase one: handler throws synchronously; event persisted, cursor advanced, dispatched still 0.
    const first = new PublicWorldStreamClient({
      baseUrl: 'http://house.test',
    isOfficialActor: id => id === fixtureActor,
      db,
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
      onError: (e) => errors.push(e),
    });
    await first.start(() => {
      if (failFirst) throw new Error('simulated handler failure');
      successes += 1;
    });
    const es1 = FakeEventSource.lastInstance!;
    es1.emit({ seq: 7, envelope: quest.bytes, kind: 'quest_dispatch' }, '7');
    await flush();
    await first.stop();

    assert.equal(successes, 0, 'first run failed');
    assert.equal(errors.length, 1, 'the async rejection was captured, not dropped');
    assert.equal(db.queryOne<{ task_done: number }>(
      `SELECT task_done FROM world_stream WHERE event_id = ?`, [quest.eventId])?.task_done, 0);
    assert.equal(first.cursor(), 7, 'receive cursor advanced (receive ≠ processed)');

    // Phase two: restart with the same DB; start() uses retryPending to redispatch the pending row successfully.
    failFirst = false;
    const second = makeClient(db);
    await second.start(() => {
      successes += 1;
    });
    await flush();
    assert.equal(successes, 1, 'restart recovered the pending dispatch');
    assert.equal(db.queryOne<{ task_done: number }>(
      `SELECT task_done FROM world_stream WHERE event_id = ?`, [quest.eventId])?.task_done, 1);

    // Replay of a dispatched event (server overlap) does not repeat side effects.
    FakeEventSource.lastInstance!.emit({ seq: 7, envelope: quest.bytes, kind: 'quest_dispatch' }, '7');
    await flush();
    assert.equal(successes, 1, 'completed dispatch is not re-run on redelivery');
  });

  // Nonblocking fourth-review finding: pin reset-on-rebind semantics with a characterization test. It supports
  // the old assembly order (start(placeholder) → bind(real)). Rebinding to another real
  // handler reruns tasks completed by the previous real handler (server idempotency protects side effects).
  // Production assembly never rebinds real handlers. This test makes future semantic changes explicit.
  it('rebinding a DIFFERENT real handler re-arms completed tasks (pinned legacy semantics)', async () => {
    const quest = questEnvelope();
    const mkFrame = (seq: number) => ({
      seq,
      eventId: quest.eventId,
      kind: 'quest_dispatch',
      envelope: quest.bytes,
      projection: null,
    });
    let callsA = 0;
    let callsB = 0;
    const client = makeClient(db);
    await client.start(() => {
      callsA += 1;
    });
    await client.absorb(mkFrame(1));
    assert.equal(callsA, 1);
    assert.equal(
      db.queryOne<{ task_done: number }>(
        `SELECT task_done FROM world_stream WHERE event_id = ?`,
        [quest.eventId],
      )?.task_done,
      1,
    );

    // Rebind to another real handler: reset all task_done flags and rerun tasks once for B.
    await client.start(() => {
      callsB += 1;
    });
    assert.equal(callsA, 1, 'the old handler is not invoked again');
    assert.equal(callsB, 1, 'the new real handler re-runs the re-armed task exactly once');
    // Restore flags after rerunning; subsequent sweeps/replays do not execute again.
    await client.retryPending();
    assert.equal(callsB, 1, 're-armed execution completes once, then settles');
  });
});


// Public-v1 exercises the protected journal on actual SQLite, separately from
// the preserved legacy EventSource behavior above.
import { afterEach, expect, vi } from 'vitest';
import { PublicV1Receiver, type PublicV1ReceiverOptions } from '../../../src/ingress/public-world-stream-client.js';
import { preparePublicStreamJournal, EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST } from '../../../src/world/scoped-stream-journal.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
const publicResources: { receiver: PublicV1Receiver; db: InMemoryHostDb }[] = [];
const publicHouse = { origin: 'https://public.example', houseKey: fixtureActor, incarnation: 'house_1' };
function publicFixture(overrides: Partial<PublicV1ReceiverOptions> = {}) {
  const db = (overrides.executionDb as InMemoryHostDb | undefined) ?? new InMemoryHostDb();
  const abort = new AbortController(); const errors: unknown[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: { url: string; options: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    requests.push({ url: String(url), options: options! });
    return new Response(new ReadableStream<Uint8Array>({ start(c) { streams.push(c); } }), { headers: { 'content-type': 'text/event-stream' } });
  }) as unknown as typeof fetch;
  const options: PublicV1ReceiverOptions = {
    capability: { house: publicHouse, capabilityRevision: 'verified_rev_1', publicStream: { endpoint: '/v1/world-stream', mode: 'public-v1', log_incarnation: 'public_log_1', envelope_baseline: 'public-envelope-02' as const, initial_public_scopes: ['sc_a'] } },
    gate: { origin: publicHouse.origin, signal: abort.signal, isActive: () => !abort.signal.aborted },
    executionDb: db, selection: { fullPublic: true, scopes: ['sc_a'] },
    producerPolicy: { house: publicHouse, capabilityRevision: 'verified_rev_1', officialActorIds: [fixtureActor] },
    approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST, consumers: [], onError: error => errors.push(error), fetch: fetcher, ...overrides,
  };
  preparePublicStreamJournal({ ...options, consumerContracts: options.consumers.map(consumer => consumer.contract) });
  const receiver = new PublicV1Receiver(options); publicResources.push({ receiver, db });
  const send = (type: string, raw: Uint8Array) => streams.at(-1)!.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${Buffer.from(raw).toString('base64')}\n\n`));
  const boundary = (high = '0') => send('public_boundary', popclaw.world.PublicStreamBoundary.encode(popclaw.world.PublicStreamBoundary.fromObject({ logIncarnation: 'public_log_1', scopes: [...options.selection.scopes].sort(), highWaterSeq: high, fullPublic: options.selection.fullPublic })).finish());
  const checkpoint = (high = '0', phase = 'replay') => send('public_checkpoint', popclaw.world.PublicStreamCheckpoint.encode(popclaw.world.PublicStreamCheckpoint.fromObject({ phase, scopes: [...options.selection.scopes].sort().map(scopeId => ({ scopeId, throughSeq: high })), ...(options.selection.fullPublic ? { publicThroughSeq: high } : {}) })).finish());
  return { receiver, db, abort, errors, requests, streams, options, send, boundary, checkpoint };
}
afterEach(async () => {
  for (const { receiver } of publicResources) { await receiver.stop(); await receiver.whenIdle(); }
  for (const db of new Set(publicResources.splice(0).map(row => row.db))) db.close();
  vi.restoreAllMocks();
});
const publicEventually = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 5 });
describe('PublicV1Receiver', () => {
  it('constructs without writes and starts one anonymous explicit public/scope request', async () => {
    const f = publicFixture(); const before = f.db.queryOne('SELECT * FROM world_public_bindings_v1');
    expect(f.requests).toHaveLength(0); expect(f.receiver.isReceiving()).toBe(false);
    await f.receiver.start(); await f.receiver.start();
    await publicEventually(() => expect(f.requests).toHaveLength(1));
    const request = f.requests[0]!; const url = new URL(request.url);
    expect(url.origin).toBe(publicHouse.origin);
    expect(Object.fromEntries(url.searchParams)).toEqual({ mode: 'public-v1', incarnation: 'public_log_1', public_after: '0', cursors: 'sc_a:0', limit: '256' });
    expect(request.options).toMatchObject({ credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { accept: 'text/event-stream' } });
    expect(f.receiver.receiveStatus().caughtUp).toBe(false); expect(before).not.toBeNull();
    f.boundary(); await publicEventually(() => expect(f.receiver.isReceiving()).toBe(true));
    expect(f.receiver.receiveStatus().caughtUp).toBe(false); f.checkpoint();
    await publicEventually(() => expect(f.receiver.receiveStatus().caughtUp).toBe(true));
    expect(f.receiver.consumerStatus('task')).toMatchObject({ supported: false, done: 0 });
  });
  it('rejects an unapproved task handler before transport or completion', async () => {
    const f = publicFixture(); await expect(f.receiver.start(vi.fn())).rejects.toThrow('PUBLIC_TASK_HANDLER_UNSUPPORTED');
    expect(f.requests).toHaveLength(0);
  });
});

import { createHash } from 'node:crypto';
import type { PublicConsumer } from '../../../src/world/scoped-stream-journal.js';
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function publicRawFrame(seq = '1', scopes: string[] = [], typed = false) {
  const env = popclaw.event.EventEnvelope.fromObject({ actor: { popclawId: fixtureActor }, timestamp: '1700000000',
    ...(typed ? { profile: { nickname: 'Raw profile' } } : { houseEvent: { kind: 'unknown.raw', schemaVersion: 7, body: Uint8Array.of(255, 0, 1), publicScopes: scopes } }),
  });
  const canonical = canonicalizeEnvelope(env); env.eventId = cidFromCanonical(canonical); env.signature = nacl.sign.detached(canonical, fixtureKey.secretKey);
  const envelope = popclaw.event.EventEnvelope.encode(env).finish();
  const raw = popclaw.event.WorldStreamFrame.encode(popclaw.event.WorldStreamFrame.fromObject({ seq, envelope, kind: typed ? 'profile' : 'unknown.raw', scopes })).finish();
  return { raw, envelope, eventId: env.eventId };
}
function publicConsumer(deliver: Extract<PublicConsumer, { mode: 'idempotent-effect' }>['deliver']): PublicConsumer {
  return { contract: { consumerId: 'transport-effect:v1', semanticVersion: '1', descriptorDigest: 'synthetic-idempotent-effect', adapterEntryPoint: 'tests/unit/ingress/public-world-stream-client.test.ts', effectMode: 'idempotent-effect', evidenceReference: 'same-test-sql-dedupe', approvedLegacySourceIds: [] },
    select: () => 'accept', mode: 'idempotent-effect', deliver };
}
const consumerDigest = (consumer: PublicConsumer) => createHash('sha256').update(JSON.stringify([consumer.contract])).digest('hex');

describe('PublicV1Receiver durable transport and lifetime', () => {
  it('does not initialize missing protected tables and never writes from construction', () => {
    const f = publicFixture(); const execute = vi.spyOn(f.db, 'execute'), transaction = vi.spyOn(f.db, 'transaction');
    const second = new PublicV1Receiver(f.options); publicResources.push({ receiver: second, db: f.db });
    expect(execute).not.toHaveBeenCalled(); expect(transaction).not.toHaveBeenCalled();
    const missing = new InMemoryHostDb();
    try {
      expect(() => new PublicV1Receiver({ ...f.options, executionDb: missing })).toThrow('PUBLIC_JOURNAL_SCHEMA_INVALID');
      expect(missing.queryAll("SELECT name FROM sqlite_master WHERE type='table'")).toEqual([]);
    } finally { missing.close(); }
  });
  it.each([true, false])('uses independent full-public presence for fullPublic=%s', async fullPublic => {
    const f = publicFixture({ selection: { fullPublic, scopes: fullPublic ? [] : ['sc_a'] } });
    await f.receiver.start(); await publicEventually(() => expect(f.requests).toHaveLength(1));
    const query = new URL(f.requests[0]!.url).searchParams;
    expect(query.get('public_after')).toBe(fullPublic ? '0' : null); expect(query.get('cursors')).toBe(fullPublic ? '' : 'sc_a:0');
    f.boundary('2'); f.checkpoint('2'); await publicEventually(() => expect(f.receiver.receiveStatus().caughtUp).toBe(true));
    expect(f.receiver.receiveStatus().publicAfter).toBe(fullPublic ? '2' : null);
  });
  it('persists exact original unknown bytes before checkpoint without interpreting business schema', async () => {
    const f = publicFixture({ selection: { fullPublic: true, scopes: ['sc_a', 'sc_b'] } });
    await f.receiver.start(); f.boundary('9007199254740994');
    const frame = publicRawFrame('9007199254740993', ['sc_b', 'sc_a']); f.send('public_frame', frame.raw);
    await publicEventually(() => expect(f.receiver.receiveStatus().publicAfter).toBe('9007199254740993'));
    expect(f.receiver.receiveStatus().caughtUp).toBe(false);
    const stored = f.db.queryOne<{ frame_bytes: Uint8Array }>('SELECT frame_bytes FROM world_public_frames_v1');
    const event = f.db.queryOne<{ envelope: Uint8Array }>('SELECT envelope FROM world_public_events_v1');
    expect([...stored!.frame_bytes]).toEqual([...frame.raw]); expect([...event!.envelope]).toEqual([...frame.envelope]);
    expect(f.db.queryAll('SELECT * FROM world_public_consumers_v1')).toHaveLength(0);
    f.checkpoint('9007199254740994'); await publicEventually(() => expect(f.receiver.receiveStatus().caughtUp).toBe(true));
    expect(f.receiver.receiveStatus().scopes.map(scope => scope.afterSeq)).toEqual(['9007199254740994', '9007199254740994']);
  });
  it('does not advance a scope from a full-public-only typed fact', async () => {
    const f = publicFixture(); await f.receiver.start(); f.boundary('7'); f.send('public_frame', publicRawFrame('7', [], true).raw);
    await publicEventually(() => expect(f.receiver.receiveStatus().publicAfter).toBe('7'));
    expect(f.receiver.receiveStatus().scopes[0]!.afterSeq).toBe('0');
    expect(f.db.queryAll('SELECT lane FROM world_public_associations_v1')).toEqual([{ lane: 'public' }]);
  });
  it.each(['frame-first', 'checkpoint-first', 'boundary-twice', 'invalid-envelope', 'checkpoint-too-low', 'scope-mismatch', 'replay-twice'])(
    'fences %s and prevents a following checkpoint from advancing', async fault => {
      const f = publicFixture(); await f.receiver.start();
      if (fault === 'frame-first') f.send('public_frame', publicRawFrame().raw);
      else if (fault === 'checkpoint-first') f.checkpoint('9');
      else {
        f.boundary('9');
        if (fault === 'boundary-twice') f.boundary('9');
        if (fault === 'invalid-envelope') {
          const raw = publicRawFrame().raw.slice(); raw[raw.length - 1]! ^= 255; f.send('public_frame', raw);
        }
        if (fault === 'checkpoint-too-low') f.checkpoint('8');
        if (fault === 'scope-mismatch') f.send('public_checkpoint', popclaw.world.PublicStreamCheckpoint.encode(popclaw.world.PublicStreamCheckpoint.fromObject({ phase: 'replay', scopes: [], publicThroughSeq: '9' })).finish());
        if (fault === 'replay-twice') { f.checkpoint('9'); f.checkpoint('9'); }
      }
      f.checkpoint('10', 'live');
      await publicEventually(() => expect(f.errors.length).toBeGreaterThan(0));
      expect(f.receiver.isReceiving()).toBe(false); expect(f.receiver.receiveStatus().caughtUp).toBe(false);
      expect(f.receiver.receiveStatus().publicAfter).toBe(fault === 'replay-twice' ? '9' : '0');
    },
  );
  it('records startup log mismatch as a gap and never adopts its recovery hint', async () => {
    const f = publicFixture(); await f.receiver.start();
    f.send('public_gap', popclaw.world.PublicStreamGap.encode(popclaw.world.PublicStreamGap.fromObject({ reason: 'log_incarnation_changed', lane: 'connection', boundary: { logIncarnation: 'untrusted_new_log', scopes: ['sc_a'], fullPublic: true, highWaterSeq: '900' } })).finish());
    f.boundary('900'); f.checkpoint('900');
    await publicEventually(() => expect(f.receiver.receiveStatus().phase).toBe('gap'));
    expect(f.receiver.receiveStatus().logIncarnation).toBe('public_log_1'); expect(f.receiver.receiveStatus().publicAfter).toBe('0');
    await new Promise(resolve => setTimeout(resolve, 1050)); expect(f.requests).toHaveLength(1);
  });
  it('reconnects after EOF with only committed lane cursors and no Last-Event-ID', async () => {
    const f = publicFixture(); await f.receiver.start(); f.boundary('12'); f.checkpoint('12');
    await publicEventually(() => expect(f.receiver.receiveStatus().caughtUp).toBe(true)); f.streams[0]!.close();
    await publicEventually(() => expect(f.requests).toHaveLength(2));
    expect(new URL(f.requests[1]!.url).searchParams.get('cursors')).toBe('sc_a:12');
    expect(new URL(f.requests[1]!.url).searchParams.get('public_after')).toBe('12');
    expect(f.requests[1]!.options.headers).toEqual({ accept: 'text/event-stream' });
    expect(f.receiver.receiveStatus().caughtUp).toBe(false);
  });
  it('reconnects a silent public stream from its committed cursors', async () => {
    const f = publicFixture({ idleTimeoutMs: 50 });
    await f.receiver.start(); f.boundary('12'); f.checkpoint('12');
    await publicEventually(() => expect(f.receiver.receiveStatus().caughtUp).toBe(true));
    await publicEventually(() => expect(f.requests[0]!.options.signal!.aborted).toBe(true));
    expect(f.receiver.receiveStatus().caughtUp).toBe(false);
    expect(f.receiver.receiveStatus().errorCode).toBe('PUBLIC_STREAM_IDLE');
    await publicEventually(() => expect(f.requests).toHaveLength(2));
    const resumed = new URL(f.requests[1]!.url);
    expect(resumed.searchParams.get('public_after')).toBe('12');
    expect(resumed.searchParams.get('cursors')).toBe('sc_a:12');
    expect(f.requests[1]!.options.headers).toEqual({ accept: 'text/event-stream' });
  });
  it('keeps an idle public stream open while heartbeat bytes arrive', async () => {
    const f = publicFixture({ idleTimeoutMs: 150 });
    await f.receiver.start(); f.boundary('12'); f.checkpoint('12');
    await publicEventually(() => expect(f.receiver.receiveStatus().caughtUp).toBe(true));
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 60));
      f.streams[0]!.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
    }
    await flush();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.options.signal!.aborted).toBe(false);
    expect(f.receiver.receiveStatus()).toMatchObject({ caughtUp: true, checkpointHighWater: '12' });
    expect(f.errors).toEqual([]);
  });
  it('retries a public fetch that never returns headers', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init!.signal!; signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })) as unknown as typeof fetch;
    const f = publicFixture({ idleTimeoutMs: 50, fetch: fetcher });
    await f.receiver.start();
    await publicEventually(() => expect(signals[0]!.aborted).toBe(true));
    await publicEventually(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(f.receiver.receiveStatus().caughtUp).toBe(false);
    expect(f.errors.some(error => error instanceof Error && error.message === 'PUBLIC_STREAM_IDLE')).toBe(true);
  });
  it('clears the public idle timer when its owner stops reception', async () => {
    const f = publicFixture({ idleTimeoutMs: 50 });
    await f.receiver.start(); f.boundary(); f.checkpoint();
    await publicEventually(() => expect(f.receiver.receiveStatus().caughtUp).toBe(true));
    await f.receiver.stop();
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(f.requests).toHaveLength(1);
    expect(f.errors).toEqual([]);
  });
  it('joins late fetch resolution and cancellation before stop resolves', async () => {
    const pending = deferred<Response>(); const cancelPending = deferred(); const cancel = vi.fn(() => cancelPending.promise);
    const fetcher = vi.fn(() => pending.promise) as unknown as typeof fetch;
    const f = publicFixture({ fetch: fetcher }); await f.receiver.start();
    let stopped = false; const joining = f.receiver.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    pending.resolve(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } }));
    await publicEventually(() => expect(cancel).toHaveBeenCalledOnce()); expect(stopped).toBe(false);
    cancelPending.resolve(); await joining; expect(stopped).toBe(true); expect(f.receiver.receiveStatus().caughtUp).toBe(false);
  });
  it('fences stop during scheduled startup without opening fetch', async () => {
    const f = publicFixture(); const start = f.receiver.start(); const stop = f.receiver.stop();
    await expect(start).rejects.toThrow('PUBLIC_RECEIVE_GATE_CLOSED'); await stop;
    expect(f.requests).toHaveLength(0);
  });
  it('joins an asynchronous connected callback but allows it to await reentrant stop', async () => {
    const f = publicFixture(); const entered = deferred(); const release = deferred(); const afterStop = vi.fn(); const second = vi.fn();
    f.receiver.onConnected(async () => { await f.receiver.stop(); afterStop(); entered.resolve(); await release.promise; }); f.receiver.onConnected(second);
    await f.receiver.start(); f.boundary('9'); f.checkpoint('9'); await entered.promise;
    expect(afterStop).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    let stopped = false; const join = f.receiver.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    release.resolve(); await join; expect(f.receiver.receiveStatus().publicAfter).toBe('0');
  });
  it('drains and checkpoints while a real idempotent SQL consumer waits, then stop joins its effect', async () => {
    const entered = deferred(), release = deferred();
    const consumer = publicConsumer(async (_delivery, context) => {
      f.db.execute('INSERT OR IGNORE INTO transport_effects(id) VALUES(?)', [context.idempotencyKey]); entered.resolve(); await release.promise;
    });
    const f = publicFixture({ consumers: [consumer], approvedConsumerMappingDigest: consumerDigest(consumer) }); f.db.execute('CREATE TABLE transport_effects(id TEXT PRIMARY KEY)');
    await f.receiver.start(); f.boundary('2'); f.send('public_frame', publicRawFrame('1').raw); await entered.promise;
    f.send('public_frame', publicRawFrame('2', ['sc_a']).raw); f.checkpoint('2');
    await publicEventually(() => expect(f.receiver.receiveStatus().caughtUp).toBe(true));
    expect(f.db.queryAll('SELECT * FROM world_public_frames_v1')).toHaveLength(2);
    let stopped = false; const stop = f.receiver.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    release.resolve(); await stop;
    expect(f.receiver.consumerStatus(consumer.contract.consumerId).done).toBe(0); expect(f.db.queryAll('SELECT * FROM transport_effects')).toHaveLength(1);
  });
  it('allows an effect callback to await stop without recording false completion', async () => {
    const finished = deferred();
    const consumer = publicConsumer(async (_delivery, context) => {
      f.db.execute('INSERT OR IGNORE INTO transport_effects(id) VALUES(?)', [context.idempotencyKey]); await f.receiver.stop(); finished.resolve();
    });
    const f = publicFixture({ consumers: [consumer], approvedConsumerMappingDigest: consumerDigest(consumer) }); f.db.execute('CREATE TABLE transport_effects(id TEXT PRIMARY KEY)');
    await f.receiver.start(); f.boundary('1'); f.send('public_frame', publicRawFrame().raw); await finished.promise; await f.receiver.whenIdle();
    expect(f.receiver.consumerStatus(consumer.contract.consumerId).done).toBe(0); expect(f.receiver.isReceiving()).toBe(false);
  });
});
