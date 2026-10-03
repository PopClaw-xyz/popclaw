import {assertHouseActionActive, withAction, withHouseActions} from '../../../src/runtime/house-lifecycle/action-context.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HouseGate } from '../../../src/runtime/house-lifecycle/manager.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';
import { createHouseStreamFactory } from '../../../src/runtime/house-lifecycle/resource-set.js';

const mocks = vi.hoisted(() => ({ worlds: [] as any[], inboxes: [] as any[] }));
vi.mock('../../../src/ingress/public-world-stream-client.js', () => ({
  PublicWorldStreamClient: class {
    receiving = false;
    constructor(readonly opts: any) { mocks.worlds.push(this); }
    start = vi.fn(async () => { this.receiving = true; });
    stop = vi.fn(async () => { this.receiving = false; });
    isReceiving() { return this.receiving; }
  },
}));
vi.mock('../../../src/messaging/inbox-stream-client.js', () => ({
  InboxStreamClient: class {
    receiving = false;
    constructor(readonly opts: any) { mocks.inboxes.push(this); }
    whenIdle = vi.fn(async () => {});
    start = vi.fn(() => { this.receiving = true; });
    stop = vi.fn(async () => { this.receiving = false; });
    isReceiving() { return this.receiving; }
  },
}));

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function gate(origin: string) {
  const abort = new AbortController();
  return { origin, generation: 1, signal: abort.signal, isActive: () => !abort.signal.aborted, abort };
}
function store(origin: string): HouseStore {
  return { baseUrl: origin, slug: new URL(origin).hostname, db: {} as never, executionDb: {} as never,
    dbPath: '', cache: { record: vi.fn() } as never };
}
function options(overrides: Record<string, unknown> = {}) {
  return { host: {} as never, signer: {} as never, recipientPopclawId: 'self',
    worldStreamMode: true, storeFor: async (origin: string) => store(origin),
    readToken: async (captured: HouseGate) => `token:${captured.origin}`,
    isOfficialActor: () => true, ...overrides };
}
beforeEach(() => { mocks.worlds.length = 0; mocks.inboxes.length = 0; });

describe('shared per-house resource set', () => {
  it('opens both streams with the same captured gate and only tears down A', async () => {
    const factory = createHouseStreamFactory(options());
    const aGate = gate('https://a.invalid'); const bGate = gate('https://b.invalid');
    const a = factory.open(aGate); const b = factory.open(bGate);
    await vi.waitFor(() => expect(mocks.inboxes).toHaveLength(2));
    expect(mocks.worlds[0].opts.gate).toBe(mocks.inboxes[0].opts.gate);
    expect(await mocks.inboxes[0].opts.readToken()).toBe('token:https://a.invalid');
    aGate.abort.abort(); await a.stop();
    expect(a.status?.()).toEqual({world: 'inactive', inbox: 'inactive'});
    expect(b.status?.()).toEqual({world: 'active', inbox: 'active'});
    expect(mocks.inboxes[1].stop).not.toHaveBeenCalled();
    await b.stop();
  });
  it('stop drains delayed initialization without opening late streams', async () => {
    const wait = deferred();
    const factory = createHouseStreamFactory(options({storeFor: async (origin: string) => { await wait.promise; return store(origin); }}));
    const set = factory.open(gate('https://a.invalid'));
    await Promise.resolve();
    let done = false; const stopping = Promise.resolve(set.stop()).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    wait.resolve(); await stopping;
    expect(mocks.worlds).toHaveLength(0); expect(mocks.inboxes).toHaveLength(0);
  });
  it('drains asynchronous inbox work and rejects late callbacks from the old set', async () => {
    const wait = deferred(); const entered = vi.fn();
    const factory = createHouseStreamFactory(options({onInbox: async () => { entered(); await wait.promise; }}));
    const set = factory.open(gate('https://a.invalid'));
    await vi.waitFor(() => expect(mocks.inboxes).toHaveLength(1));
    mocks.inboxes[0].opts.onMessage({}, new Uint8Array(), '');
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(1));
    let done = false; const stopping = Promise.resolve(set.stop()).then(() => { done = true; });
    mocks.inboxes[0].opts.onMessage({}, new Uint8Array(), '');
    await Promise.resolve(); expect(done).toBe(false);
    wait.resolve(); await stopping; expect(entered).toHaveBeenCalledTimes(1);
  });
  it('drains a pending handshake and never starts resources after it settles', async () => {
    const wait = deferred(); const entered = vi.fn();
    const factory = createHouseStreamFactory(options({refresh: async () => { entered(); await wait.promise; }}));
    const set = factory.open(gate('https://a.invalid'));
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    let done = false; const stopping = Promise.resolve(set.stop()).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    wait.resolve(); await stopping;
    expect(mocks.worlds).toHaveLength(0); expect(mocks.inboxes).toHaveLength(0);
  });
});

/**
 * A network cut once produced a dozen of these lines in a row, every one of
 * them reading `house stream (…): [object Object]`. `EventSource.onerror`
 * hands out a DOM-ish event object, not an Error, so `String(err)` threw away
 * the status/code that tells an operator whether they are looking at a 401, a
 * dropped socket or DNS — while the auth-refusal lines on the same boot read
 * perfectly, because those happen to be real Errors.
 */
describe('the shared per-house stream error line', () => {
  const logFor = async (err: unknown) => {
    const log = vi.fn();
    const set = createHouseStreamFactory(options({ log })).open(gate('https://a.invalid'));
    await vi.waitFor(() => expect(mocks.inboxes).toHaveLength(1));
    mocks.inboxes[0].opts.onError(err);
    await set.stop();
    const line = log.mock.calls.map((c: unknown[]) => String(c[0])).find((l: string) => l.startsWith('house stream ('));
    expect(line, 'no house stream line was logged').toBeTypeOf('string');
    return line!;
  };

  it.each([
    [{ type: 'error', status: 502, message: 'Bad Gateway' }, ['status=502', 'Bad Gateway']],
    [{ code: 'ECONNRESET' }, ['code=ECONNRESET']],
    [{ type: 'error' }, ['type=error']],
  ])('renders the plain object %j with something actionable', async (err, expected) => {
    const line = await logFor(err);
    expect(line).not.toContain('[object Object]');
    for (const part of expected) expect(line).toContain(part);
  });

  it('positive control: a real Error still reports its message', async () => {
    const line = await logFor(new Error('READ_AUTH_HOUSE_NOT_TRUSTED: no verified binding'));
    expect(line).toContain('READ_AUTH_HOUSE_NOT_TRUSTED: no verified binding');
  });

  it('bounds an unrecognised object instead of pouring it into the log', async () => {
    const line = await logFor({ blob: 'x'.repeat(5_000) });
    expect(line).not.toContain('[object Object]');
    expect(line).toContain('truncated');
    expect(line.length).toBeLessThan(500);
  });
});

it('uses the injected public receiver as the sole Ranger ingress', async () => {
  let receiving = false;
  const receiver = {start: vi.fn(async () => { receiving = true; }), stop: vi.fn(async () => { receiving = false; }), isReceiving: () => receiving};
  const createPublicReceiver = vi.fn(() => receiver);
  const createRanger = vi.fn((_house, _gate, ingress) => ({start: () => ingress.start(() => {}), stop: async () => {}}));
  const set = createHouseStreamFactory(options({createPublicReceiver, createRanger})).open(gate('https://a.invalid'));
  await vi.waitFor(() => expect(set.status?.().world).toBe('active'));
  expect(createPublicReceiver).toHaveBeenCalledOnce();
  expect(createRanger.mock.calls[0]?.[2]).toBe(receiver);
  expect(receiver.start).toHaveBeenCalledOnce();
  expect(mocks.worlds).toHaveLength(0);
  await set.stop(); expect(receiver.stop).toHaveBeenCalledOnce();
});
it('closes already-started resources when Ranger startup rejects', async () => {
  const stopRanger = vi.fn(async () => {});
  const set = createHouseStreamFactory(options({createRanger: (_house: unknown, _gate: unknown, ingress: any) => ({
    start: async () => { await ingress.start(() => {}); throw new Error('ranger startup failed'); }, stop: stopRanger,
  })})).open(gate('https://a.invalid'));
  await vi.waitFor(() => expect(mocks.inboxes[0]?.stop).toHaveBeenCalledOnce());
  expect(mocks.worlds[0].stop).toHaveBeenCalledOnce(); expect(stopRanger).toHaveBeenCalledOnce();
  expect(set.status?.()).toEqual({world: 'inactive', inbox: 'inactive'});
  await set.stop();
});

it('joins a fenced public receiver before reporting resource quiescence', async () => {
  const callback = deferred(); let receiving = false;
  const receiver = { start: vi.fn(async () => { receiving = true; }),
    stop: vi.fn(() => { receiving = false; }), isReceiving: () => receiving,
    whenIdle: vi.fn(() => callback.promise) };
  const set = createHouseStreamFactory(options({createPublicReceiver: () => receiver})).open(gate('https://a.invalid'));
  try {
    await vi.waitFor(() => expect(set.status?.().world).toBe('active'));
    let finished = false;
    const stopping = Promise.resolve(set.stop()).then(() => { finished = true; });
    expect(receiver.stop).toHaveBeenCalledOnce();
    expect(receiver.whenIdle).toHaveBeenCalledOnce();
    expect(set.status?.().world).toBe('inactive');
    await Promise.resolve(); await Promise.resolve();
    expect(finished).toBe(false);
    callback.resolve(); await stopping;
    expect(finished).toBe(true);
  } finally { callback.resolve(); await set.stop(); }
});

it('runs resident resources under their own gate after the triggering command expires', async () => {
  const origin = 'https://b.invalid'; const resourceGate = gate(origin);
  let commandActive = true;
  const commandGate = {signal: new AbortController().signal, isActive: () => commandActive};
  const refresh = vi.fn(async () => { assertHouseActionActive(origin); });
  const set = withHouseActions(new Map([[origin, commandGate]]), () => withAction(commandGate,
    () => createHouseStreamFactory(options({refresh, refreshMs: 10})).open(resourceGate)));
  commandActive = false;
  await vi.waitFor(() => expect(refresh.mock.calls.length).toBeGreaterThan(1));
  expect(set.status?.()).toEqual({world:'active', inbox:'active'});
  resourceGate.abort.abort(); await set.stop();
  expect(set.status?.()).toEqual({world:'inactive', inbox:'inactive'});
});


describe('owned inbox consumer lifecycle', () => {
  it('drains recovery before opening the inbox and routes messages through the same consumer', async () => {
    const recovery = deferred(); const received = vi.fn(); const fallback = vi.fn();
    const consumer = { receive: received, drain: vi.fn(() => recovery.promise), stop: vi.fn(), whenIdle: vi.fn(async () => {}) };
    const createInboxConsumer = vi.fn((_input: {house: HouseStore; gate: HouseGate}) => consumer);
    const set = createHouseStreamFactory(options({createInboxConsumer, onInbox: fallback})).open(gate('https://a.invalid'));
    try {
      await vi.waitFor(() => expect(consumer.drain).toHaveBeenCalledOnce());
      expect(mocks.inboxes).toHaveLength(0);
      const captured = createInboxConsumer.mock.calls[0]![0];
      expect(captured.house.baseUrl).toBe('https://a.invalid');
      expect(captured.gate.isActive()).toBe(true);
      recovery.resolve();
      await vi.waitFor(() => expect(mocks.inboxes[0]?.receiving).toBe(true));
      const dm = { body: 'wire body' }; const bytes = new Uint8Array([1, 2, 3]);
      mocks.inboxes[0].opts.onMessage(dm, bytes, 'sender');
      await vi.waitFor(() => expect(received).toHaveBeenCalledWith(dm, bytes, 'sender'));
      expect(fallback).not.toHaveBeenCalled();
      await set.stop();
      expect(consumer.stop).toHaveBeenCalledOnce();
      expect(consumer.whenIdle).toHaveBeenCalledOnce();
      expect(captured.gate.isActive()).toBe(false);
    } finally { recovery.resolve(); await set.stop(); }
  });

  it('fences synchronously and joins autonomous consumer work before reporting quiescence', async () => {
    const background = deferred();
    const consumer = { receive: vi.fn(), drain: vi.fn(async () => {}), stop: vi.fn(), whenIdle: vi.fn(() => background.promise) };
    const set = createHouseStreamFactory(options({createInboxConsumer: () => consumer})).open(gate('https://a.invalid'));
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(mocks.inboxes[0]?.receiving).toBe(true));
      let finished = false;
      stopping = Promise.resolve(set.stop()).then(() => { finished = true; });
      expect(consumer.stop).toHaveBeenCalledOnce();
      expect(consumer.whenIdle).toHaveBeenCalledOnce();
      mocks.inboxes[0].opts.onMessage({}, new Uint8Array(), 'late');
      await Promise.resolve(); await Promise.resolve();
      expect(finished).toBe(false);
      expect(consumer.receive).not.toHaveBeenCalled();
      background.resolve(); await stopping;
      expect(finished).toBe(true);
    } finally { background.resolve(); await (stopping ?? set.stop()); }
  });

  it('stops a pending recovery without opening late streams', async () => {
    const recovery = deferred();
    const consumer = { receive: vi.fn(), drain: vi.fn(() => recovery.promise), stop: vi.fn(), whenIdle: vi.fn(() => recovery.promise) };
    const set = createHouseStreamFactory(options({createInboxConsumer: () => consumer})).open(gate('https://a.invalid'));
    try {
      await vi.waitFor(() => expect(consumer.drain).toHaveBeenCalledOnce());
      let finished = false;
      const stopping = Promise.resolve(set.stop()).then(() => { finished = true; });
      expect(consumer.stop).toHaveBeenCalledOnce();
      await Promise.resolve(); expect(finished).toBe(false);
      recovery.resolve(); await stopping;
      expect(mocks.inboxes).toHaveLength(0);
      expect(mocks.worlds[0].start).not.toHaveBeenCalled();
      expect(consumer.receive).not.toHaveBeenCalled();
    } finally { recovery.resolve(); await set.stop(); }
  });
});


it.each(['sync', 'async'] as const)('returns %s inbox consumer failures to the stream instead of swallowing them', async (mode) => {
  const failure = new Error('first structured inbox persistence failed');
  const fallback = vi.fn();
  const consumer = { receive: vi.fn(() => { if (mode === 'sync') throw failure; return Promise.reject(failure); }),
    drain: vi.fn(async () => {}), stop: vi.fn(), whenIdle: vi.fn(async () => {}) };
  const set = createHouseStreamFactory(options({createInboxConsumer: () => consumer, onInbox: fallback})).open(gate('https://a.invalid'));
  try {
    await vi.waitFor(() => expect(mocks.inboxes[0]?.receiving).toBe(true));
    await expect(Promise.resolve(mocks.inboxes[0].opts.onMessage({}, new Uint8Array([1]), 'sender'))).rejects.toBe(failure);
    expect(consumer.receive).toHaveBeenCalledOnce(); expect(fallback).not.toHaveBeenCalled();
  } finally { await set.stop(); }
});

it('joins the fenced inbox transport before reporting resource quiescence', async () => {
  const callback = deferred();
  const set = createHouseStreamFactory(options()).open(gate('https://a.invalid'));
  try {
    await vi.waitFor(() => expect(mocks.inboxes[0]?.receiving).toBe(true));
    mocks.inboxes[0].whenIdle = vi.fn(() => callback.promise);
    let done = false; const stopping = Promise.resolve(set.stop()).then(() => { done = true; });
    expect(mocks.inboxes[0].stop).toHaveBeenCalledOnce();
    expect(mocks.inboxes[0].whenIdle).toHaveBeenCalledOnce();
    await Promise.resolve(); await Promise.resolve(); expect(done).toBe(false);
    callback.resolve(); await stopping; expect(done).toBe(true);
  } finally { callback.resolve(); await set.stop(); }
});


it('uses lifecycle refresh only for the owned inbox poll, keeping handshake cadence separate', async () => {
  const poll = vi.fn(), handshake = vi.fn(async () => {});
  const consumer = { receive: vi.fn(), drain: vi.fn(async () => {}), stop: vi.fn(), whenIdle: vi.fn(async () => {}), poll };
  const set = createHouseStreamFactory(options({ createInboxConsumer: () => consumer, refresh: handshake })).open(gate('https://a.invalid'));
  try {
    await vi.waitFor(() => expect(mocks.inboxes[0]?.receiving).toBe(true));
    const initial = handshake.mock.calls.length;
    set.refresh?.(); await Promise.resolve(); await Promise.resolve();
    expect(poll).toHaveBeenCalledOnce(); expect(handshake).toHaveBeenCalledTimes(initial);
    await set.stop(); set.refresh?.(); await Promise.resolve();
    expect(poll).toHaveBeenCalledOnce();
  } finally { await set.stop(); }
});

it('provides the private consumer the sole original inbox callback and fences late fallback', async () => {
  const origin = 'https://a.invalid', captured = gate(origin), fallback = vi.fn(async () => {});
  let input!: import('../../../src/runtime/house-lifecycle/resource-set.js').HouseInboxConsumerInput;
  const consumer = { receive: vi.fn(), drain: vi.fn(), stop: vi.fn(), whenIdle: vi.fn(async () => {}) };
  const set = createHouseStreamFactory(options({ onInbox: fallback,
    createInboxConsumer: (value: typeof input) => { input = value; return consumer; } })).open(captured);
  await vi.waitFor(() => expect(mocks.inboxes).toHaveLength(1));
  const dm = { body: 'ordinary' }, bytes = new Uint8Array([1, 2, 3]);
  await input.onPlain!(dm, bytes, 'Sender');
  expect(fallback).toHaveBeenCalledOnce();
  expect(fallback.mock.calls[0]).toEqual([input.house, input.gate, dm, bytes, 'Sender', undefined]);
  captured.abort.abort(); await set.stop();
  expect(() => input.onPlain!(dm, bytes, 'Sender')).toThrow('PRIVATE_RESOURCE_CHANGED');
  expect(fallback).toHaveBeenCalledOnce(); expect(mocks.inboxes).toHaveLength(1);
});

describe('the relation reception seam', () => {
  it('hands the one per-house transport its frame, resume and reset hooks', async () => {
    const onFrame = vi.fn();
    const onCursorReset = vi.fn();
    const resumeFrom = vi.fn(() => '3.7');
    const g = gate('https://a.invalid');
    const set = createHouseStreamFactory(options({onFrame, resumeFrom, onCursorReset})).open(g);
    await vi.waitFor(() => expect(mocks.inboxes).toHaveLength(1));
    const opts = mocks.inboxes[0].opts;
    // ONE client for this house — the relation chain does not open a second.
    expect(mocks.inboxes).toHaveLength(1);

    opts.onFrame(new Uint8Array([1, 2]), '3.8');
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledOnce());
    // The chain is handed the SAME gate the transport runs under — not the
    // outer captured one, and not a second gate that could disagree with it.
    expect(onFrame.mock.calls[0]?.[1]).toBe(opts.gate);
    expect(onFrame.mock.calls[0]?.[1].origin).toBe(g.origin);
    expect(onFrame.mock.calls[0]?.[3]).toBe('3.8');

    expect(opts.resumeFrom()).toBe('3.7');
    opts.onCursorReset({reason: 'generation'}, 4);
    await vi.waitFor(() => expect(onCursorReset).toHaveBeenCalledOnce());
    expect(onCursorReset.mock.calls[0]?.[3]).toBe(4);
    await set.stop();
  });

  it('propagates a failed commit so the transport can tear down', async () => {
    const onFrame = vi.fn(() => { throw new Error('WRITE_FAILED'); });
    const set = createHouseStreamFactory(options({onFrame})).open(gate('https://a.invalid'));
    await vi.waitFor(() => expect(mocks.inboxes).toHaveLength(1));
    // The returned promise must REJECT. Swallowing it here is what would let
    // the next frame commit a position past the one that never landed.
    await expect(mocks.inboxes[0].opts.onFrame(new Uint8Array([1]), '1.1')).rejects.toThrow('WRITE_FAILED');
    await set.stop();
  });

  it('offers no resume position once the gate is closed', async () => {
    const resumeFrom = vi.fn(() => '9.9');
    const g = gate('https://a.invalid');
    const set = createHouseStreamFactory(options({resumeFrom})).open(g);
    await vi.waitFor(() => expect(mocks.inboxes).toHaveLength(1));
    expect(mocks.inboxes[0].opts.resumeFrom()).toBe('9.9'); // live: a real cursor
    g.abort.abort();
    // A departed session must not hand a reconnect its old position.
    expect(mocks.inboxes[0].opts.resumeFrom()).toBeUndefined();
    await set.stop();
  });

  it('passes no hooks at all when nothing wires the chain', async () => {
    const set = createHouseStreamFactory(options()).open(gate('https://a.invalid'));
    await vi.waitFor(() => expect(mocks.inboxes).toHaveLength(1));
    // Absent, not present-and-undefined: a root that has not wired relations
    // keeps exactly the transport behaviour it had.
    expect('onFrame' in mocks.inboxes[0].opts).toBe(false);
    expect('resumeFrom' in mocks.inboxes[0].opts).toBe(false);
    expect('onCursorReset' in mocks.inboxes[0].opts).toBe(false);
    await set.stop();
  });
});
