import { describe, it, expect } from 'vitest';
import { SseIngress } from '../../../src/ingress/sse-ingress.js';
import { describeSseError } from '../../../src/ingress/sse-error.js';
import { popclaw } from '@popclaw/contracts';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';

type Handlers = {
  onmessage: ((e: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onopen?: ((e: unknown) => void) | null;
  close(): void;
  readonly url: string;
};

/** Collects every EventSource the ingress opens, so a test can drive them. */
function fakeEventSourceFactory() {
  const opened: Handlers[] = [];
  const closed: Handlers[] = [];
  const Ctor = function (this: Handlers, url: string) {
    this.onmessage = null;
    this.onerror = null;
    this.onopen = null;
    Object.defineProperty(this, 'url', { value: url });
    (this as Handlers).close = () => {
      closed.push(this);
    };
    opened.push(this);
  } as unknown as new (url: string) => Handlers;
  return { Ctor, opened, closed };
}


/** A minimal DiscoveryFrame carrying one event id, base64 as the wire does. */
function discoveryFrame(eventId: string): string {
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
  const env = { actor: { popclawId: bs58.encode(key.publicKey) }, post: { blocks: [{ content: eventId }] } };
  const canonical = canonicalizeEnvelope(env);
  const bytes = popclaw.event.DiscoveryFrame.encode({
    frameType: 1,
    event: { ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, key.secretKey) },
  } as never).finish();
  return Buffer.from(bytes).toString('base64');
}

function newIngress(Ctor: new (url: string) => Handlers) {
  const host = new InMemoryHostAdapter();
  const ingress = new SseIngress(
    {
      baseUrl: 'https://house.example',
      eventSourceCtor: Ctor as never,
      baseBackoffMs: 1000,
      maxBackoffMs: 30_000,
    },
    host,
  );
  return { host, ingress };
}

describe('SseIngress onConnected (#144)', () => {
  it('fires on the first open — registration must land after the stream is up, not race it', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const { ingress } = newIngress(Ctor);
    const opens: number[] = [];
    ingress.onConnected(() => opens.push(1));
    await ingress.start(() => {});
    expect(opens).toHaveLength(0); // constructed, not yet open
    opened[0]!.onopen?.({});
    expect(opens).toHaveLength(1);
  });

  it('fires again on every reconnect', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const { host, ingress } = newIngress(Ctor);
    let count = 0;
    ingress.onConnected(() => count++);
    await ingress.start(() => {});
    opened[0]!.onopen?.({});
    expect(count).toBe(1);

    opened[0]!.onerror?.({ status: 502 });
    host.timer.flush(60_000); // run the scheduled reconnect
    expect(opened).toHaveLength(2);
    opened[1]!.onopen?.({});
    expect(count).toBe(2);
  });

  it('a callback registered after the stream is already open runs immediately', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const { ingress } = newIngress(Ctor);
    await ingress.start(() => {});
    opened[0]!.onopen?.({});
    let ran = false;
    ingress.onConnected(() => (ran = true));
    expect(ran).toBe(true);
  });
});

describe('SseIngress error visibility (#142)', () => {
  it('logs the error fields, not [object Object], plus the retry plan', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const { host, ingress } = newIngress(Ctor);
    await ingress.start(() => {});
    opened[0]!.onerror?.({ type: 'error', status: 401, message: 'Unauthorized' });

    const err = host.logger.records.find((r) => r.msg === 'sse-ingress: stream error');
    expect(err).toBeDefined();
    expect(String(err!.obj['err'])).toContain('401');
    expect(String(err!.obj['err'])).toContain('Unauthorized');
    expect(String(err!.obj['err'])).not.toContain('[object Object]');

    const retry = host.logger.records.find((r) => r.msg === 'sse-ingress: retrying');
    expect(retry).toBeDefined();
    expect(typeof retry!.obj['delayMs']).toBe('number');
  });

  it('says so when it comes back, so a self-healing blip is not read as an outage', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const { host, ingress } = newIngress(Ctor);
    await ingress.start(() => {});
    opened[0]!.onopen?.({});
    // A clean first open is not news.
    expect(host.logger.records.some((r) => r.msg === 'sse-ingress: reconnected')).toBe(false);

    opened[0]!.onerror?.({ type: 'error' });
    host.timer.flush(60_000);
    opened[1]!.onopen?.({});
    expect(host.logger.records.some((r) => r.msg === 'sse-ingress: reconnected')).toBe(true);
  });
});

describe('describeSseError', () => {
  it('renders what String() threw away', () => {
    expect(describeSseError({ type: 'error', status: 502, message: 'Bad Gateway' }))
      .toBe('status=502 Bad Gateway');
    expect(describeSseError({ code: 'ECONNRESET' })).toBe('code=ECONNRESET');
    expect(describeSseError({ type: 'error' })).toBe('type=error');
    expect(describeSseError(new Error('boom'))).toBe('boom');
    expect(describeSseError('plain')).toBe('plain');
    // The shape the field logs actually hit: no message, no status, no type.
    expect(describeSseError({ a: 1 })).toBe('{"a":1}');
  });

  it('never returns [object Object] for a cyclic object', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(describeSseError(cyclic)).not.toBe('[object Object]');
  });
});

describe('SseIngress reconnect replay (#182 factor 3)', () => {
  it('first connect asks for no replay', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const { ingress } = newIngress(Ctor);
    await ingress.start(() => {});
    expect(opened[0]!.url).toBe('https://house.example/v1/discovery');
  });

  it('a reconnect asks the house to replay what the blip swallowed', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const { host, ingress } = newIngress(Ctor);
    await ingress.start(() => {});
    opened[0]!.onopen?.({});
    opened[0]!.onerror?.({ type: 'error' });
    host.timer.flush(60_000);
    expect(opened[1]!.url).toBe('https://house.example/v1/discovery?snapshot=last100');
  });

  it('a stream that errors before it ever opened still asks for nothing', async () => {
    // Never opened => SeenSet is empty => replaying would re-run handlers for
    // events an earlier process already handled (a re-verify costs real money).
    const { Ctor, opened } = fakeEventSourceFactory();
    const { host, ingress } = newIngress(Ctor);
    await ingress.start(() => {});
    opened[0]!.onerror?.({ type: 'error' });
    host.timer.flush(60_000);
    expect(opened[1]!.url).toBe('https://house.example/v1/discovery');
  });

  it('replay is deduped by the seen set, so a replayed event is handled once', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const { host, ingress } = newIngress(Ctor);
    const seen: string[] = [];
    await ingress.start((e) => { seen.push(e.eventId); });
    opened[0]!.onopen?.({});
    const frame = discoveryFrame('evt-1');
    opened[0]!.onmessage?.({ data: frame });
    opened[0]!.onerror?.({ type: 'error' });
    host.timer.flush(60_000);
    opened[1]!.onopen?.({});
    opened[1]!.onmessage?.({ data: frame }); // the house replays it
    await Promise.resolve();
    expect(seen).toEqual([popclaw.event.DiscoveryFrame.decode(Buffer.from(frame, 'base64')).event!.eventId]);
  });
});


describe('discovery lifecycle gate', () => {
  it('logout rejects late frames and reconnect timers from the old source', async () => {
    const { Ctor, opened } = fakeEventSourceFactory();
    const host = new InMemoryHostAdapter();
    const controller = new AbortController();
    const ingress = new SseIngress({ baseUrl: 'https://a.invalid', eventSourceCtor: Ctor as never, gate: { signal: controller.signal, isActive: () => !controller.signal.aborted } }, host);
    let received = 0;
    await ingress.start(() => { received++; });
    controller.abort();
    opened[0]!.onmessage?.({ data: discoveryFrame('late') });
    opened[0]!.onerror?.(new Error('late disconnect'));
    host.timer.flush(100_000);
    await Promise.resolve();
    expect(received).toBe(0);
    expect(opened).toHaveLength(1);
    await ingress.stop();
  });
});
