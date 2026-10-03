/**
 * Frames commit in arrival order, one at a time, per connection.
 *
 * Tracking each frame's promise is not the same as ordering them. The
 * per-frame discipline added earlier makes a FAILED frame tear the connection
 * down, which is right — but it hands every frame to the commit callback the
 * moment it arrives. So a slow F1 and a fast F2 race:
 *
 *   F1 arrives, its commit is still in flight
 *   F2 arrives, commits, and writes the stream position past F1
 *   F1 fails
 *
 * The teardown then reconnects and resumes from F2's position. F1 is behind
 * it, nothing will re-deliver it, and the cursor says everything up to F2 was
 * handled. One slow write becomes a hole that no retry can reach — the exact
 * failure the teardown was added to prevent, arriving through the gap the
 * teardown did not cover.
 *
 * A `cursor-reset` is a statement about the position too, so it shares the
 * queue rather than jumping it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  InboxStreamClient,
  INBOX_ENVELOPE_EVENT,
  INBOX_CURSOR_RESET_EVENT,
  type AnyEventSource,
  type SseFrame,
} from '../../../src/messaging/inbox-stream-client.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';

const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(21));
const AUTHOR = bs58.encode(kp.publicKey);
const ME = 'me-popclaw-id';
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

function frame(seq: string): string {
  const env = {
    actor: { popclawId: AUTHOR }, target: {}, lorehouse: HOUSE_KEY, timestamp: 1_713_657_600,
    followDeclared: { followeePopclawId: ME, order: { seq, houseKey: HOUSE_KEY } },
  };
  const canonical = canonicalizeEnvelope(env);
  return Buffer.from(popclaw.event.EventEnvelope.encode({
    ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, kp.secretKey),
  }).finish()).toString('base64');
}

type FakeES = AnyEventSource & { listeners: Record<string, (e: SseFrame) => void>; closed: number };

function deferred<T = void>() {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function wire(opts: {
  onFrame: (bytes: Uint8Array, position: string | undefined) => void | Promise<void>;
  onCursorReset?: (reset: unknown, serial: number) => void;
  gate?: { isActive(): boolean; signal: AbortSignal };
}) {
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
  const onError = vi.fn();
  const client = new InboxStreamClient({
    baseUrl: 'http://house.test', recipientPopclawId: ME,
    readToken: () => Promise.resolve('token'), onMessage: () => {}, onError,
    reconnectDelayMs: 50_000, eventSourceCtor: Ctor,
    onFrame: opts.onFrame,
    ...(opts.onCursorReset ? { onCursorReset: opts.onCursorReset as never } : {}),
    ...(opts.gate ? { gate: opts.gate } : {}),
  });
  client.start();
  await vi.waitFor(() => expect(made.length).toBe(1));
  const es = made[0]!;
  return {
    client, es, onError,
    feed: (seq: string, position: string) => es.listeners[INBOX_ENVELOPE_EVENT]!({ data: frame(seq), lastEventId: position }),
    reset: () => es.listeners[INBOX_CURSOR_RESET_EVENT]!({
      data: JSON.stringify({ reason: 'generation', log_generation: '2', floor: '0', reconcile: 'snapshot' }),
    }),
  };
}

describe('two frames, the first one slow', () => {
  it('does not start the second while the first is still committing', async () => {
    const first = deferred();
    const started: string[] = [];
    const w = await wire({
      onFrame: (_b, position) => {
        started.push(position!);
        return position === '1.1' ? first.promise : Promise.resolve();
      },
    });

    w.feed('1', '1.1');
    w.feed('2', '1.2');
    await Promise.resolve();
    await Promise.resolve();

    // F2 must be waiting, not committed. If it has already run, its position
    // is durable and F1 is now unreachable behind it.
    expect(started).toEqual(['1.1']);

    first.resolve();
    await vi.waitFor(() => expect(started).toEqual(['1.1', '1.2']));
  });

  it('never commits the second when the first fails', async () => {
    const first = deferred();
    const started: string[] = [];
    const w = await wire({
      onFrame: (_b, position) => {
        started.push(position!);
        return position === '1.1' ? first.promise : Promise.resolve();
      },
    });

    w.feed('1', '1.1');
    w.feed('2', '1.2');
    await Promise.resolve();
    first.reject(new Error('WRITE_FAILED'));

    await vi.waitFor(() => expect(w.es.closed).toBe(1));
    // The queue behind a failed frame is abandoned, not drained. Committing
    // F2 now would write a position past a frame that never landed.
    expect(started).toEqual(['1.1']);
    expect(w.onError.mock.calls.flat().map(String).join(' ')).toContain('WRITE_FAILED');

    // and it stays abandoned — a late arrival on the dead connection does not
    // restart the queue
    w.feed('3', '1.3');
    await Promise.resolve();
    expect(started).toEqual(['1.1']);
  });

  it('holds a cursor-reset behind the frames already queued', async () => {
    const first = deferred();
    const order: string[] = [];
    const w = await wire({
      onFrame: (_b, position) => {
        order.push(`frame:${position}`);
        return position === '1.1' ? first.promise : Promise.resolve();
      },
      onCursorReset: () => { order.push('reset'); },
    });

    w.feed('1', '1.1');
    w.reset();
    await Promise.resolve();
    // The reset says something about the position; announcing it while an
    // earlier frame is still committing puts the two statements out of order.
    expect(order).toEqual(['frame:1.1']);

    first.resolve();
    await vi.waitFor(() => expect(order).toEqual(['frame:1.1', 'reset']));
  });

  it('abandons queued frames when the owner leaves mid-commit', async () => {
    const first = deferred();
    const started: string[] = [];
    let live = true;
    const w = await wire({
      onFrame: (_b, position) => {
        started.push(position!);
        return position === '1.1' ? first.promise : Promise.resolve();
      },
      gate: { isActive: () => live, signal: new AbortController().signal },
    });

    w.feed('1', '1.1');
    w.feed('2', '1.2');
    await Promise.resolve();
    expect(started).toEqual(['1.1']);

    live = false;          // the owner logs out while F1 is mid-commit
    first.resolve();       // F1 finishes anyway
    await Promise.resolve();
    await Promise.resolve();

    // F2 belongs to a session that has ended. Committing it now would write
    // for an owner who is gone.
    expect(started).toEqual(['1.1']);
  });
});
