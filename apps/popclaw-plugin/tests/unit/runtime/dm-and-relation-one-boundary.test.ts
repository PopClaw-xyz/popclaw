/**
 * DMs and relations through ONE commit boundary, in arrival order.
 *
 * Before this, a house's personal stream had two consumers with two different
 * ideas of how far it had got: relations committed through the shared boundary
 * and moved the cursor, DMs went down their own transport path. A DM that
 * failed to land could therefore be followed by a relation that succeeded and
 * advanced the position past it — the DM unreachable, with the cursor claiming
 * otherwise.
 *
 * With `routeDmFramesToOnFrame` both ride the same queue: one ordered log, one
 * cursor, one participation fence. The hand-over that has to be synchronous is
 * the durable queue row written at that boundary; the slow work stays where it
 * was, on the drain, driven by the existing consumer.
 *
 * Note what is deliberately NOT claimed here: the DM store and the relation
 * tables are not promised to move in one transaction. They are separate
 * databases in production. What makes that safe is that the queue row survives
 * a failed settle and the DM store's own duplicate gate absorbs the replay —
 * recoverable rather than atomic, which is the honest guarantee.
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
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { createRelationWiring } from '../../../src/social-graph/relation-wiring.js';
import {
  InboxStreamClient,
  INBOX_ENVELOPE_EVENT,
  type AnyEventSource,
  type SseFrame,
} from '../../../src/messaging/inbox-stream-client.js';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
const PEER = bs58.encode(kp.publicKey);
const ME = 'me-popclaw-id';
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

function signed(body: Record<string, unknown>): { bytes: Uint8Array; eventId: string; b64: string } {
  const env = { actor: { popclawId: PEER }, target: {}, timestamp: 1_713_657_600, ...body };
  const canonical = canonicalizeEnvelope(env);
  const eventId = cidFromCanonical(canonical);
  const bytes = popclaw.event.EventEnvelope.encode({
    ...env, eventId, signature: nacl.sign.detached(canonical, kp.secretKey),
  }).finish();
  return { bytes, eventId, b64: Buffer.from(bytes).toString('base64') };
}

const followFrame = (seq: string) =>
  signed({ lorehouse: HOUSE_KEY, followDeclared: { followeePopclawId: ME, order: { seq, houseKey: HOUSE_KEY } } });
const dmFrame = (body: string, ts: number) =>
  signed({ directMessage: { fromPopclawId: PEER, toPopclawId: ME, body, ts } });

type FakeES = AnyEventSource & { listeners: Record<string, (e: SseFrame) => void>; closed: number };

async function chain() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  const inbox = new InboxStore(db);
  // The slow half, exactly as the existing consumer does it — called on the
  // drain, never inside the commit.
  const slowWork: string[] = [];

  const wiring = createRelationWiring({
    db,
    recipientPopclawId: ME,
    // Synchronous and recoverable: record into the DM store, then settle. If
    // the settle is lost the row is retried and `record`'s duplicate gate
    // absorbs it, so no cross-database transaction is claimed.
    processDm: (envelopeBytes, source, commit) => {
      const env = popclaw.event.EventEnvelope.decode(envelopeBytes);
      const dm = env.directMessage;
      if (!dm) return;
      const wasNew = inbox.record({
        ts: Number(dm.ts ?? 0),
        fromPopclawId: dm.fromPopclawId ?? '',
        toPopclawId: dm.toPopclawId ?? '',
        body: dm.body ?? '',
        receivedAtMs: 1_700_000_000_000,
        houseSlug: source.houseSlug ?? '',
        envelopeBytes,
      });
      const { committed } = commit(() => wasNew);
      if (committed && wasNew) slowWork.push(dm.body ?? '');
    },
  });
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

  const viaOnMessage: string[] = [];
  const client = new InboxStreamClient({
    baseUrl: 'http://house.test',
    recipientPopclawId: ME,
    readToken: () => Promise.resolve('token'),
    // Must stay silent: with the routing on, nothing reaches the wire path.
    onMessage: (dm) => { viaOnMessage.push(dm.body ?? ''); },
    onError: () => {},
    reconnectDelayMs: 50_000,
    eventSourceCtor: Ctor,
    routeDmFramesToOnFrame: true,
    onFrame: (envelope, position) => {
      const eventId = popclaw.event.EventEnvelope.decode(envelope).eventId;
      handle.receive({ stream: 'personal', envelopeBytes: envelope, eventId,
        ...(position !== undefined ? { position } : {}) });
    },
    resumeFrom: () => handle.resumeFrom('personal'),
  });
  client.start();
  await vi.waitFor(() => expect(made.length).toBe(1));

  return {
    db, wiring, handle, inbox, slowWork, viaOnMessage,
    feed: async (b64: string, position: string) => {
      made[0]!.listeners[INBOX_ENVELOPE_EVENT]!({ data: b64, lastEventId: position });
      await client.whenIdle();
    },
    queued: () => db.queryAll<{ event_id: string }>('SELECT event_id FROM inbound_frames ORDER BY rowid').map(r => r.event_id),
    dms: () => inbox.recent(50).map(i => i.body),
    edges: () => db.queryAll<{ applied_seq: number | null }>('SELECT applied_seq FROM relation_edges'),
    cursor: () => handle.resumeFrom('personal'),
  };
}

describe('DMs and relations on one boundary', () => {
  it('queues both, in arrival order, through the same log', async () => {
    const c = await chain();
    const f1 = followFrame('1');
    const d1 = dmFrame('first', 100);
    const f2 = followFrame('2');

    await c.feed(f1.b64, '1.1');
    await c.feed(d1.b64, '1.2');
    await c.feed(f2.b64, '1.3');

    // One log, in the order the wire delivered them — not two lanes racing.
    expect(c.queued()).toEqual([f1.eventId, d1.eventId, f2.eventId]);
    // One cursor, and it is the last frame's position.
    expect(c.cursor()).toBe('1.3');
    // The old wire path is genuinely unused, not merely also-called.
    expect(c.viaOnMessage).toEqual([]);
  });

  it('delivers the DM and applies the relation from the same drain', async () => {
    const c = await chain();
    await c.feed(followFrame('1').b64, '1.1');
    await c.feed(dmFrame('hello', 100).b64, '1.2');
    expect(c.dms()).toEqual([]); // nothing delivered inside the commit

    c.wiring.drain();

    expect(c.dms()).toEqual(['hello']);
    expect(c.edges()).toHaveLength(1);
    expect(c.edges()[0]?.applied_seq).toBe(1);
    // The slow half ran once, outside the transaction.
    expect(c.slowWork).toEqual(['hello']);
  });

  it('absorbs a replayed DM instead of delivering it twice', async () => {
    const c = await chain();
    const d = dmFrame('once', 100);
    await c.feed(d.b64, '1.1');
    c.wiring.drain();
    expect(c.dms()).toEqual(['once']);

    await c.feed(d.b64, '1.1'); // a reconnect re-delivering is ordinary
    c.wiring.drain();

    expect(c.dms()).toEqual(['once']);
    expect(c.slowWork).toEqual(['once']); // and the slow half did not run again
  });

  it('refuses the routing when nothing is wired to take a frame', async () => {
    // Without this, every DM would be handed to a callback that does not
    // exist and would vanish with the stream still looking healthy.
    expect(() => new InboxStreamClient({
      baseUrl: 'http://house.test', recipientPopclawId: ME,
      readToken: async () => 'token', onMessage: () => {}, routeDmFramesToOnFrame: true,
    })).not.toThrow(); // the client itself is permissive…
    const { createHouseStreamFactory } = await import('../../../src/runtime/house-lifecycle/resource-set.js');
    // …the assembly that owns the transport is where it is refused.
    expect(() => createHouseStreamFactory({
      host: {} as never, signer: {} as never, recipientPopclawId: ME, worldStreamMode: true,
      storeFor: async () => ({}) as never, readToken: async () => 't', isOfficialActor: () => true,
      routeDmFramesToOnFrame: true,
    }).open({ origin: 'https://a.invalid', generation: 1, signal: new AbortController().signal,
      isActive: () => true } as never)).toThrow('routeDmFramesToOnFrame requires onFrame');
  });
});
