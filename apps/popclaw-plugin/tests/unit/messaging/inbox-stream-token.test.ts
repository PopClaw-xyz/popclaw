/**
 * The client half of the inbox stream's credential.
 *
 * The transport no longer mints anything: it is handed a token, or handed a
 * refusal, and a refusal means no connection. The credential's own bytes are
 * pinned in tests/unit/identity/ — what is pinned HERE is that the transport
 * asks once per connection, asks again on every reconnect, and opens nothing
 * when the answer is no. If that last part slips, the inbox subscribes
 * anonymously and looks exactly like a working one.
 */

import { describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InboxStreamClient,
  INBOX_TOKEN_HEADER,
  openHouseInboxStreams,
  type AnyEventSource,
  type EventSourceInit,
} from '../../../src/messaging/inbox-stream-client.js';
import type { Signer } from '../../../src/identity/signer.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { establishTrust } from '../../../src/world/house-binding-pin.js';
import { readCredentialMessage } from '../../../src/identity/read-credential.js';
import {
  declaringReadAuthority,
  silentReadAuthority,
  unknownSchemeReadAuthority,
} from '../../helpers/read-authority.js';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { noDmCrypto } from '../../helpers/test-signer.js';

function testSigner(seed = 7): Signer & { popclawIdSync: string } {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seed));
  const id = bs58.encode(kp.publicKey);
  return {
    popclawIdSync: id,
    publicKey: async () => kp.publicKey,
    popclawId: async () => id,
    sign: async (bytes: Uint8Array) => nacl.sign.detached(bytes, kp.secretKey),
    // S3 added sealDm/openDm to Signer; this fake never carries a DM body.
    ...noDmCrypto,
  };
}

class FakeEventSource implements AnyEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  listeners: Record<string, (e: { data: string }) => void> = {};
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, listener: (e: { data: string }) => void): void {
    this.listeners[type] = listener;
  }
  close(): void {
    this.closed = true;
  }
  /** A method, not an assignment: assigning narrows `last` to `never`. */
  static reset(): void {
    FakeEventSource.last = null;
  }
}

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations');
/**
 * https, not plain http: an address the runtime cannot canonicalise is a house
 * no credential can name, and plain http off loopback is exactly that — the
 * boot would have refused such a house long before a read reached it.
 */
const HOUSE = 'https://house.test';
const HOUSE_KEY = '9xQeWy8P3vNhKd2RmTzA6BcFgJ4LnSuVoXpYrEt5Hw1Z';

/** A house this machine has a verified binding for. */
function trustedDb() {
  const db = new InMemoryHostDb();
  runMigrations(db, MIGRATIONS);
  establishTrust(db, { origin: HOUSE, houseKey: HOUSE_KEY, incarnation: 'inc-1' }, 'tofu', () => 1_700_000_000);
  return db;
}

describe('InboxStreamClient auth wiring', () => {
  it('sends the credential its house authority minted, under the inbox purpose', async () => {
    const signer = testSigner();
    const db = trustedDb();
    const [stream] = openHouseInboxStreams([HOUSE], {
      recipientPopclawId: signer.popclawIdSync,
      readAuthorityFor: declaringReadAuthority(db, signer),
      onMessage: () => {},
      eventSourceCtor: FakeEventSource,
    });
    const client = stream!.client;
    client.start();
    await vi.waitFor(() => expect(FakeEventSource.last?.init?.headers).toBeDefined());

    const header = FakeEventSource.last!.init!.headers![INBOX_TOKEN_HEADER]!;
    const [version, id, ts, sig] = header.split('.');
    expect([version, id]).toEqual(['v2', signer.popclawIdSync]);
    // The purpose is not on the wire, so the only way to see the stream asked
    // under its own is to rebuild the message the house will rebuild.
    expect(nacl.sign.detached.verify(
      new TextEncoder().encode(
        readCredentialMessage('inbox-stream', signer.popclawIdSync, { origin: HOUSE, houseKey: HOUSE_KEY }, Number(ts)),
      ),
      Buffer.from(sig!, 'base64'),
      bs58.decode(signer.popclawIdSync),
    )).toBe(true);
    client.stop();
    db.close();
  });

  it.each([
    ['declares no scheme', silentReadAuthority, 'READ_AUTH_NOT_DECLARED'],
    ['names a scheme this build does not speak', unknownSchemeReadAuthority, 'READ_AUTH_SCHEME_UNSUPPORTED'],
  ] as const)('opens nothing when the house %s', async (_name, authority, code) => {
    FakeEventSource.reset();
    const signer = testSigner();
    const db = trustedDb();
    const errors: unknown[] = [];
    const [stream] = openHouseInboxStreams([HOUSE], {
      recipientPopclawId: signer.popclawIdSync,
      readAuthorityFor: authority(db, signer),
      onMessage: () => {},
      onError: (_slug, err) => errors.push(err),
      eventSourceCtor: FakeEventSource,
    });
    stream!.client.start();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(String(errors[0])).toContain(code);
    // The refusal is the end of it. An anonymous subscription would be
    // accepted by a house that has not locked its inbox yet, and would look
    // exactly like a working inbox until the day it did.
    expect(FakeEventSource.last).toBeNull();
    stream!.client.stop();
    db.close();
  });

  it.each([0, 0.9])('network reconnect checks the gate and refreshes its token (random=%s)', async (random) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(random);
    FakeEventSource.reset();
    let active = true;
    const readToken = vi.fn().mockResolvedValueOnce('token-1').mockResolvedValue('token-2');
    const client = new InboxStreamClient({
      baseUrl: 'https://house.test', recipientPopclawId: 'recipient',
      readToken, gate: { isActive: () => active, signal: new AbortController().signal },
      onMessage: () => {}, eventSourceCtor: FakeEventSource,
    });
    try {
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      const first = FakeEventSource.last!;
      expect(first.init!.headers![INBOX_TOKEN_HEADER]).toBe('token-1');
      first.onerror!(new Error('offline'));
      expect(first.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(5000 + Math.floor(random * 5000) - 1);
      expect(FakeEventSource.last).toBe(first);
      await vi.advanceTimersByTimeAsync(1);
      const second = FakeEventSource.last!;
      expect(second).not.toBe(first);
      expect(second.init!.headers![INBOX_TOKEN_HEADER]).toBe('token-2');
      second.onerror!(new Error('offline again'));
      active = false;
      await vi.advanceTimersByTimeAsync(10000);
      expect(FakeEventSource.last).toBe(second);
      expect(readToken).toHaveBeenCalledTimes(2);
    } finally { client.stop(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('reconnects with a fresh token after a 401 instead of retrying a stale one', async () => {
    vi.useFakeTimers();
    try {
      const signer = testSigner();
      const client = new InboxStreamClient({
        baseUrl: 'https://house.test',
        recipientPopclawId: signer.popclawIdSync,
        onMessage: () => {},
        readToken: async () => 'fresh-each-connect',
        eventSourceCtor: FakeEventSource,
      });
      client.start();
      await vi.waitFor(() => expect(FakeEventSource.last?.init?.headers).toBeDefined(), {
        interval: 0,
      });
      const first = FakeEventSource.last!;

      first.onerror!({ status: 401 });
      expect(first.closed).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.waitFor(() => expect(FakeEventSource.last).not.toBe(first), { interval: 0 });
      expect(FakeEventSource.last!.init!.headers![INBOX_TOKEN_HEADER]).toBeTruthy();
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A clock skewed past the house's 60s window rejects every freshly signed
   * token. Without backoff that is a 1 Hz retry loop against the house, on
   * battery, forever — presenting the same dead inbox it was meant to fix.
   */
  it('backs off exponentially while every fresh token keeps getting 401d', async () => {
    vi.useFakeTimers();
    try {
      const signer = testSigner();
      const errors: unknown[] = [];
      const client = new InboxStreamClient({
        baseUrl: 'https://house.test',
        recipientPopclawId: signer.popclawIdSync,
        onMessage: () => {},
        onError: (e) => errors.push(e),
        readToken: async () => 'fresh-each-connect',
        eventSourceCtor: FakeEventSource,
      });

      // NOT vi.waitFor: under fake timers it advances the clock to make the
      // condition true, which would fire the very retry timer under test.
      // Only microtasks may be flushed here.
      const connect = async (previous: FakeEventSource | null) => {
        for (let i = 0; i < 10 && FakeEventSource.last === previous; i++) await Promise.resolve();
        expect(FakeEventSource.last).not.toBe(previous);
        return FakeEventSource.last!;
      };

      FakeEventSource.reset();
      client.start();
      let es = await connect(null);

      // 1st 401 → retry after 1s.
      es.onerror!({ status: 401 });
      await vi.advanceTimersByTimeAsync(999);
      expect(FakeEventSource.last).toBe(es);
      await vi.advanceTimersByTimeAsync(1);
      es = await connect(es);

      // 2nd 401 → 1s is no longer enough; it takes 2s.
      es.onerror!({ status: 401 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(FakeEventSource.last).toBe(es);
      await vi.advanceTimersByTimeAsync(600);
      es = await connect(es);

      // 3rd 401 → the streak is no longer explainable as an expired token,
      // so it must reach the owner instead of spinning silently.
      es.onerror!({ status: 401 });
      const alert = errors.find((e) => e instanceof Error && /clock/.test(e.message));
      expect(alert, 'persistent 401 never surfaced').toBeInstanceOf(Error);

      // ...and it keeps backing off rather than settling into a tight loop.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(FakeEventSource.last).toBe(es);

      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The FIRST start is the one that had no ladder under it.
   *
   * On a fresh data root the house's trust pin is written milliseconds AFTER
   * the stream asks for its read token, so `readToken` rejects with
   * READ_AUTH_HOUSE_NOT_TRUSTED. That rejection used to end the chain in a
   * lone `onError` log: no socket was ever opened, and nothing calls `start()`
   * a second time, so the inbox stayed dead for the life of the process while
   * `show_inbox` honestly reported "no messages". The follower poll lost the
   * same race at the same boot and healed on its next tick, which is exactly
   * why follows worked and DMs did not.
   */
  it('retries a first start whose readToken was refused, then opens on the later success', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    const readToken = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('READ_AUTH_HOUSE_NOT_TRUSTED: no verified binding yet'))
      .mockResolvedValue('token-once-the-pin-landed');
    const errors: unknown[] = [];
    const client = new InboxStreamClient({
      baseUrl: HOUSE,
      recipientPopclawId: 'recipient',
      readToken,
      onMessage: () => {},
      onError: (err) => errors.push(err),
      eventSourceCtor: FakeEventSource,
    });
    try {
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(readToken).toHaveBeenCalledTimes(1);
      expect(String(errors[0])).toContain('READ_AUTH_HOUSE_NOT_TRUSTED');
      // A refusal still opens nothing — that part was never the defect.
      expect(FakeEventSource.last).toBeNull();
      expect(client.currentConnectionSerial()).toBe(0);

      // The ladder starts at 1s, so it must not have asked again before then.
      await vi.advanceTimersByTimeAsync(999);
      expect(readToken).toHaveBeenCalledTimes(1);
      expect(FakeEventSource.last).toBeNull();

      await vi.advanceTimersByTimeAsync(1);
      // A scheduled timer is NOT the thing to assert. What the owner gets back
      // is a CONNECTION: the token is re-read, a socket is constructed with
      // the fresh credential, the client's own connection generation moves off
      // zero for the first time, and the stream reports itself as receiving
      // once the house answers.
      expect(readToken).toHaveBeenCalledTimes(2);
      const opened = FakeEventSource.last;
      expect(opened).not.toBeNull();
      expect(opened!.init?.headers?.[INBOX_TOKEN_HEADER]).toBe('token-once-the-pin-landed');
      expect(opened!.url).toContain('/inbox/recipient/stream');
      expect(client.currentConnectionSerial()).toBe(1);
      expect(client.isReceiving()).toBe(false);
      (opened as unknown as { onopen?: () => void }).onopen?.();
      expect(client.isReceiving()).toBe(true);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  /**
   * The twin dead end, and the quieter of the two: an empty credential never
   * even reached `onError`. `open()` was simply not called and the boot log
   * said nothing at all.
   */
  it('retries a first start whose readToken handed back an empty credential', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    const readToken = vi.fn<() => Promise<string>>()
      .mockResolvedValueOnce('')
      .mockResolvedValue('token-on-the-second-ask');
    const client = new InboxStreamClient({
      baseUrl: HOUSE,
      recipientPopclawId: 'recipient',
      readToken,
      onMessage: () => {},
      eventSourceCtor: FakeEventSource,
    });
    try {
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(readToken).toHaveBeenCalledTimes(1);
      expect(FakeEventSource.last).toBeNull();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(readToken).toHaveBeenCalledTimes(2);
      expect(FakeEventSource.last?.init?.headers?.[INBOX_TOKEN_HEADER]).toBe('token-on-the-second-ask');
      expect(client.currentConnectionSerial()).toBe(1);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  it('a second start() while the first-start retry is pending does not open a second stream', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    const readToken = vi.fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('READ_AUTH_HOUSE_NOT_TRUSTED: no verified binding yet'))
      .mockResolvedValue('token-once-the-pin-landed');
    const client = new InboxStreamClient({
      baseUrl: HOUSE,
      recipientPopclawId: 'recipient',
      readToken,
      onMessage: () => {},
      onError: () => {},
      eventSourceCtor: FakeEventSource,
    });
    try {
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(readToken).toHaveBeenCalledTimes(1);

      // The ladder owns the next attempt. A caller that starts again while it
      // is pending must be absorbed, exactly as one that starts again while a
      // socket is open already is.
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(readToken).toHaveBeenCalledTimes(1);

      // ...and exactly one attempt is made when the ladder does fire — not two.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(readToken).toHaveBeenCalledTimes(2);
      const opened = FakeEventSource.last;
      expect(opened?.init?.headers?.[INBOX_TOKEN_HEADER]).toBe('token-once-the-pin-landed');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(FakeEventSource.last).toBe(opened);
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  /**
   * "Nothing happened" is the same observation as "the retry was cancelled",
   * so this case carries its own control: an identical client that is NOT
   * stopped, on the same clock, must ask again.
   */
  it('an explicit stop() cancels the pending retry of a failed first start', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    const refuse = () =>
      vi.fn<() => Promise<string>>()
        .mockRejectedValue(new Error('READ_AUTH_HOUSE_NOT_TRUSTED: no verified binding yet'));
    const make = (readToken: () => Promise<string>) =>
      new InboxStreamClient({
        baseUrl: HOUSE,
        recipientPopclawId: 'recipient',
        readToken,
        onMessage: () => {},
        onError: () => {},
        eventSourceCtor: FakeEventSource,
      });
    const stoppedToken = refuse();
    const runningToken = refuse();
    const stopped = make(stoppedToken);
    const running = make(runningToken);
    try {
      stopped.start();
      running.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(stoppedToken).toHaveBeenCalledTimes(1);
      expect(runningToken).toHaveBeenCalledTimes(1);

      await stopped.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(stoppedToken).toHaveBeenCalledTimes(1);
      expect(runningToken.mock.calls.length).toBeGreaterThan(1);
      expect(FakeEventSource.last).toBeNull();
    } finally {
      await running.stop();
      vi.useRealTimers();
    }
  });

  /**
   * Positive control for the three above: with the same harness and the same
   * clock, a first start that IS granted a token opens a socket. Without it,
   * "no stream appeared" would be indistinguishable from a test that cannot
   * see a stream appear at all.
   */
  it('positive control: a first start whose readToken succeeds opens a stream straight away', async () => {
    vi.useFakeTimers();
    FakeEventSource.reset();
    const readToken = vi.fn<() => Promise<string>>().mockResolvedValue('granted-on-the-first-ask');
    const client = new InboxStreamClient({
      baseUrl: HOUSE,
      recipientPopclawId: 'recipient',
      readToken,
      onMessage: () => {},
      eventSourceCtor: FakeEventSource,
    });
    try {
      client.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(readToken).toHaveBeenCalledTimes(1);
      expect(FakeEventSource.last?.init?.headers?.[INBOX_TOKEN_HEADER]).toBe('granted-on-the-first-ask');
    } finally {
      await client.stop();
      vi.useRealTimers();
    }
  });

  it('an explicit stop() cancels a pending re-auth instead of being undone by it', async () => {
    vi.useFakeTimers();
    try {
      const signer = testSigner();
      const client = new InboxStreamClient({
        baseUrl: 'https://house.test',
        recipientPopclawId: signer.popclawIdSync,
        onMessage: () => {},
        readToken: async () => 'fresh-each-connect',
        eventSourceCtor: FakeEventSource,
      });
      FakeEventSource.reset();
      client.start();
      for (let i = 0; i < 10 && !FakeEventSource.last; i++) await Promise.resolve();
      const es = FakeEventSource.last!;

      es.onerror!({ status: 401 });
      client.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeEventSource.last).toBe(es);
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('actual inbox trust and lifecycle', () => {
  it('rejects bad signatures and foreign recipients before the message consumer', async () => {
    FakeEventSource.reset();
    const signer = testSigner();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const client = new InboxStreamClient({ baseUrl: 'https://a.invalid', recipientPopclawId: signer.popclawIdSync, readToken: async () => 'token', onMessage, onError, eventSourceCtor: FakeEventSource });
    client.start();
    await vi.waitFor(() => expect(FakeEventSource.last).not.toBeNull());
    const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
    const send = (to: string, corrupt: boolean) => {
      const env = { actor: { popclawId: signer.popclawIdSync }, directMessage: { fromPopclawId: signer.popclawIdSync, toPopclawId: to, body: 'message' } };
      const canonical = canonicalizeEnvelope(env);
      const signature = nacl.sign.detached(canonical, key.secretKey);
      if (corrupt) signature[0] = signature[0]! ^ 1;
      const bytes = popclaw.event.EventEnvelope.encode({ ...env, eventId: cidFromCanonical(canonical), signature }).finish();
      FakeEventSource.last!.listeners.envelope!({ data: Buffer.from(bytes).toString('base64') });
    };
    send(signer.popclawIdSync, true);
    send('another-recipient', false);
    expect(onMessage).not.toHaveBeenCalled();
    expect(onError.mock.calls.map(args => String(args[0]))).toEqual(['Error: SIGNATURE_INVALID', 'Error: RECIPIENT_MISMATCH']);
    send(signer.popclawIdSync, false);
    expect(onMessage).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it('a delayed session token cannot open a socket after logout', async () => {
    FakeEventSource.reset();
    const controller = new AbortController();
    let release!: (token: string) => void;
    const readToken = vi.fn(() => new Promise<string>(r => { release = r; }));
    const signer = testSigner();
    const client = new InboxStreamClient({ baseUrl: 'https://a.invalid', recipientPopclawId: signer.popclawIdSync, readToken, gate: { signal: controller.signal, isActive: () => !controller.signal.aborted }, onMessage: vi.fn(), eventSourceCtor: FakeEventSource });
    client.start();
    await Promise.resolve();
    controller.abort();
    release('bound-v2-token');
    await new Promise(r => setImmediate(r));
    expect(FakeEventSource.last).toBeNull();
    expect(client.isReceiving()).toBe(false);
  });
});


/** Signed wire bytes are replayed verbatim by every fresh server connection. */
function replayFrame() {
  const signer = testSigner();
  const env = { actor: { popclawId: signer.popclawIdSync, nickname: 'sender' },
    directMessage: { fromPopclawId: signer.popclawIdSync, toPopclawId: signer.popclawIdSync, body: 'retained message' } };
  const canonical = canonicalizeEnvelope(env);
  const signature = nacl.sign.detached(canonical, nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey);
  const bytes = popclaw.event.EventEnvelope.encode({ ...env, eventId: cidFromCanonical(canonical), signature }).finish();
  return { signer, bytes, frame: { data: Buffer.from(bytes).toString('base64') } };
}
function pendingConsumer() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // The RED version ignores the returned promise; keep its rejection observed.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

describe('inbox consumer failure replay', () => {
  it.each(['sync', 'async'] as const)('reconnects after %s failure and hands the identical retained envelope to the consumer', async (mode) => {
    vi.useFakeTimers(); FakeEventSource.reset();
    const { signer, bytes, frame } = replayFrame();
    const failure = new Error('durable write failed');
    const pending = pendingConsumer();
    const consumed: Uint8Array[] = [];
    let attempts = 0;
    const onMessage = vi.fn((_dm, envelope: Uint8Array) => {
      attempts++;
      if (attempts === 1) { if (mode === 'sync') throw failure; return pending.promise; }
      consumed.push(envelope);
    });
    const readToken = vi.fn().mockResolvedValueOnce('first').mockResolvedValue('fresh');
    const onError = vi.fn();
    const client = new InboxStreamClient({ baseUrl: 'https://house.test', recipientPopclawId: signer.popclawIdSync,
      readToken, onMessage, onError, reconnectDelayMs: 10, eventSourceCtor: FakeEventSource });
    try {
      client.start(); await vi.advanceTimersByTimeAsync(0);
      const first = FakeEventSource.last!;
      first.listeners.envelope!(frame);
      if (mode === 'async') { expect(first.closed).toBe(false); pending.reject(failure); }
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledWith(failure);
      expect(first.closed).toBe(true);
      first.listeners.envelope!(frame); // A buffered callback from the old socket is fenced.
      expect(onMessage).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      const replay = FakeEventSource.last!;
      expect(replay).not.toBe(first);
      expect(replay.init?.headers?.[INBOX_TOKEN_HEADER]).toBe('fresh');
      expect(Object.keys(replay.init?.headers ?? {})).toEqual([INBOX_TOKEN_HEADER]);
      replay.listeners.envelope!(frame);
      await vi.advanceTimersByTimeAsync(0);
      expect(onMessage).toHaveBeenCalledTimes(2);
      expect(consumed).toHaveLength(1);
      expect(Array.from(consumed[0]!)).toEqual(Array.from(bytes));
      expect(replay.closed).toBe(false);
    } finally { pending.resolve(); await client.stop(); vi.useRealTimers(); }
  });

  it('does not disconnect a replacement socket for an old asynchronous rejection', async () => {
    vi.useFakeTimers(); FakeEventSource.reset();
    const { signer, frame } = replayFrame(); const pending = pendingConsumer();
    const client = new InboxStreamClient({ baseUrl: 'https://house.test', recipientPopclawId: signer.popclawIdSync,
      readToken: async () => 'token', onMessage: () => pending.promise,
      reconnectDelayMs: 10, eventSourceCtor: FakeEventSource });
    try {
      client.start(); await vi.advanceTimersByTimeAsync(0);
      const old = FakeEventSource.last!; old.listeners.envelope!(frame);
      old.onerror!(new Error('network disconnect'));
      await vi.advanceTimersByTimeAsync(10);
      const current = FakeEventSource.last!; expect(current).not.toBe(old);
      pending.reject(new Error('late write failure')); await vi.advanceTimersByTimeAsync(20);
      expect(FakeEventSource.last).toBe(current); expect(current.closed).toBe(false);
    } finally { pending.resolve(); await client.stop(); vi.useRealTimers(); }
  });

  it('fences immediately on abort and joins the rejected callback without reconnecting', async () => {
    vi.useFakeTimers(); FakeEventSource.reset();
    const { signer, frame } = replayFrame(); const pending = pendingConsumer(); const abort = new AbortController();
    const onMessage = vi.fn(() => pending.promise);
    const client = new InboxStreamClient({ baseUrl: 'https://house.test', recipientPopclawId: signer.popclawIdSync,
      readToken: async () => 'token', onMessage, gate: {signal: abort.signal, isActive: () => !abort.signal.aborted},
      reconnectDelayMs: 10, eventSourceCtor: FakeEventSource });
    try {
      client.start(); await vi.advanceTimersByTimeAsync(0);
      const old = FakeEventSource.last!; old.listeners.envelope!(frame);
      abort.abort(); expect(old.closed).toBe(true); expect(client.isReceiving()).toBe(false);
      old.listeners.envelope!(frame); expect(onMessage).toHaveBeenCalledOnce();
      let idle = false; const joining = client.whenIdle().then(() => { idle = true; });
      await vi.advanceTimersByTimeAsync(0); expect(idle).toBe(false);
      pending.reject(new Error('write interrupted')); await joining;
      expect(idle).toBe(true); await vi.advanceTimersByTimeAsync(100);
      expect(FakeEventSource.last).toBe(old);
    } finally { pending.resolve(); await client.stop(); vi.useRealTimers(); }
  });

  it('allows a consumer to await stop while an external join waits for that consumer', async () => {
    vi.useFakeTimers(); FakeEventSource.reset();
    const { signer, frame } = replayFrame(); const pending = pendingConsumer(); const stoppedInside = vi.fn();
    const client = new InboxStreamClient({ baseUrl: 'https://house.test', recipientPopclawId: signer.popclawIdSync,
      readToken: async () => 'token', onMessage: async () => { await client.stop(); stoppedInside(); await pending.promise; },
      eventSourceCtor: FakeEventSource });
    try {
      client.start(); await vi.advanceTimersByTimeAsync(0);
      FakeEventSource.last!.listeners.envelope!(frame);
      let idle = false; const joining = client.whenIdle().then(() => { idle = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(stoppedInside).toHaveBeenCalledOnce(); expect(idle).toBe(false);
      pending.resolve(); await joining; expect(idle).toBe(true);
    } finally { pending.resolve(); await client.stop(); vi.useRealTimers(); }
  });

  it('preserves Promise failures through the legacy multi-house callback wrapper', async () => {
    vi.useFakeTimers(); FakeEventSource.reset();
    const { signer, frame } = replayFrame(); const pending = pendingConsumer(); const onError = vi.fn();
    const streams = openHouseInboxStreams(['https://house.test'], { recipientPopclawId: signer.popclawIdSync,
      readAuthorityFor: () => async () => ({ ok: true as const, headers: { [INBOX_TOKEN_HEADER]: 'token' } }),
      onMessage: () => pending.promise, onError, eventSourceCtor: FakeEventSource });
    const client = streams[0]!.client;
    try {
      client.start(); await vi.advanceTimersByTimeAsync(0);
      const first = FakeEventSource.last!; first.listeners.envelope!(frame);
      const failure = new Error('legacy async write failed'); pending.reject(failure);
      await vi.advanceTimersByTimeAsync(0);
      expect(first.closed).toBe(true);
      expect(onError).toHaveBeenCalledWith(streams[0]!.slug, failure);
    } finally { pending.resolve(); await client.stop(); vi.useRealTimers(); }
  });
});
