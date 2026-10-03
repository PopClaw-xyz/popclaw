/**
 * The relation frame path must obey the same rules the DM path already does.
 *
 * `onMessage` has three disciplines built around it: a synchronous throw tears
 * the connection down and retries, a rejected promise does the same, and the
 * in-flight work is tracked so `whenIdle()` can join it before the owner's
 * resources are released. `onFrame` was added with none of them — it was a
 * bare call, so a persistence failure inside it escaped the listener, the
 * stream stayed up, and the NEXT frame committed a position past the one that
 * never landed. That is the shape that turns one failed write into a
 * permanent hole: nothing retries it, and the cursor says it was done.
 *
 * `cursor-reset` has the same problem from the other direction. The envelope
 * handler next to it checks the gate on every frame; the reset handler
 * checked only the connection's identity, so a reset that arrived after this
 * owner logged out could still mark a debt for the world that replaced them.
 */
import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import {
  InboxStreamClient,
  INBOX_ENVELOPE_EVENT,
  INBOX_CURSOR_RESET_EVENT,
  type AnyEventSource,
  type SseFrame,
} from '../../../src/messaging/inbox-stream-client.js';

const seed = new Uint8Array(32).fill(7);
const kp = nacl.sign.keyPair.fromSeed(seed);
const AUTHOR = bs58.encode(kp.publicKey);
const ME = 'me-popclaw-id';
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

type FakeES = AnyEventSource & {
  listeners: Record<string, (e: SseFrame) => void>;
  closed: number;
};

function fakeSources() {
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
  return { Ctor, made };
}

/** A signed relation frame addressed to ME — the thing that rides this path. */
function relationFrame(): string {
  const env = {
    actor: { popclawId: AUTHOR },
    target: {},
    lorehouse: HOUSE_KEY,
    timestamp: 1_713_657_600,
    followDeclared: { followeePopclawId: ME, order: { seq: '4', houseKey: HOUSE_KEY } },
  };
  const canonical = canonicalizeEnvelope(env);
  const bytes = popclaw.event.EventEnvelope.encode({
    ...env,
    eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, kp.secretKey),
  }).finish();
  return Buffer.from(bytes).toString('base64');
}

async function wire(opts: {
  onFrame?: (bytes: Uint8Array, position: string | undefined) => void;
  onCursorReset?: (reset: unknown, serial: number) => void;
  gate?: { isActive(): boolean; signal: AbortSignal };
  reconnectDelayMs?: number;
}) {
  const { Ctor, made } = fakeSources();
  const onError = vi.fn();
  const client = new InboxStreamClient({
    baseUrl: 'http://house.test',
    recipientPopclawId: ME,
    readToken: () => Promise.resolve('token'),
    onMessage: () => {},
    onError,
    reconnectDelayMs: opts.reconnectDelayMs ?? 50_000, // long: assert the teardown, never race a retry
    eventSourceCtor: Ctor,
    ...(opts.onFrame ? { onFrame: opts.onFrame } : {}),
    ...(opts.onCursorReset ? { onCursorReset: opts.onCursorReset as never } : {}),
    ...(opts.gate ? { gate: opts.gate } : {}),
  });
  client.start();
  await vi.waitFor(() => expect(made.length).toBe(1));
  const es = made[0]!;
  return {
    client,
    es,
    made,
    onError,
    feed: () => es.listeners[INBOX_ENVELOPE_EVENT]!({ data: relationFrame(), lastEventId: '1.9' }),
    reset: () => es.listeners[INBOX_CURSOR_RESET_EVENT]!({
      data: JSON.stringify({ reason: 'generation', log_generation: '2', floor: '0', reconcile: 'snapshot' }),
    }),
  };
}

describe('a relation frame that fails to commit', () => {
  it('tears the connection down when onFrame throws, instead of sailing on', async () => {
    const { es, onError, feed } = await wire({
      onFrame: () => { throw new Error('WRITE_FAILED'); },
    });
    expect(() => feed()).not.toThrow(); // must not escape the SSE listener
    // The durable stage is serial, so the throw surfaces when this frame's
    // turn comes rather than inside feed(). The stream is torn down either
    // way: the next reconnect resumes from the position that actually landed,
    // not past the frame that did not.
    await vi.waitFor(() => expect(es.closed).toBe(1));
    expect(onError.mock.calls.flat().map(String).join(' ')).toContain('WRITE_FAILED');
  });

  /**
   * The consumer that refuses EVERY frame, which is what a relation chain
   * whose house is not trusted yet looks like once its hold is full: each
   * reconnect replays from the retention floor, fills the hold again, and
   * throws again. What keeps that from being a tight loop is this client's
   * own reconnect delay — the frame path has no separate schedule, and must
   * not grow one.
   */
  it('spaces the reconnects when every frame is refused, instead of spinning', async () => {
    vi.useFakeTimers();
    try {
      const { made, feed } = await wire({
        onFrame: () => { throw new Error('RELATION_SESSION_NOT_TRUSTED'); },
        reconnectDelayMs: 5_000,
      });
      feed();
      await vi.waitFor(() => expect(made[0]!.closed).toBe(1));

      // Nothing yet: the retry is on a timer, not on the failure itself.
      expect(made.length).toBe(1);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(made.length).toBe(1);

      // And it does come back — spaced, not abandoned.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(made.length).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tears the connection down when onFrame rejects asynchronously', async () => {
    const { es, onError, feed } = await wire({
      onFrame: () => Promise.reject(new Error('ASYNC_WRITE_FAILED')) as unknown as void,
    });
    feed();
    // `void` in the option's type does not stop an async function being passed,
    // and an unobserved rejection would leave the stream healthy-looking.
    await vi.waitFor(() => expect(es.closed).toBe(1));
    expect(onError.mock.calls.flat().map(String).join(' ')).toContain('ASYNC_WRITE_FAILED');
  });

  it('joins in-flight frame work before whenIdle resolves', async () => {
    let release!: () => void;
    const landed = new Promise<void>((r) => { release = r; });
    let finished = false;
    const { client, feed } = await wire({
      onFrame: () => landed.then(() => { finished = true; }) as unknown as void,
    });
    feed();
    await Promise.resolve(); // let the queue pick the frame up
    await client.stop();
    let idle = false;
    const joining = client.whenIdle().then(() => { idle = true; });
    await Promise.resolve();
    // Still writing: the owner must not reclaim the database underneath it.
    expect(idle).toBe(false);
    expect(finished).toBe(false);
    release();
    await joining;
    expect(finished).toBe(true);
  });
});

describe('a cursor-reset arriving after this owner is gone', () => {
  it('is ignored once the gate is inactive', async () => {
    let live = true;
    const onCursorReset = vi.fn();
    const { reset } = await wire({
      onCursorReset,
      gate: { isActive: () => live, signal: new AbortController().signal },
    });
    reset();
    // Queued behind any frames in flight, so it announces on its turn.
    await vi.waitFor(() => expect(onCursorReset).toHaveBeenCalledTimes(1)); // live: the debt is real

    live = false;
    reset();
    await Promise.resolve();
    await Promise.resolve();
    // The world this reset describes has been replaced. Recording it now would
    // mark a debt against the owner who took over.
    expect(onCursorReset).toHaveBeenCalledTimes(1);
  });
});
