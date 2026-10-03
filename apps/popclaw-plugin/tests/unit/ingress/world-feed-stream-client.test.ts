import { describe, it, expect, vi } from 'vitest';
import { popclaw } from '@popclaw/contracts';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import {
  WorldFeedStreamClient,
  worldFeedSince,
  worldFeedResume,
  SINCE_CURSOR_LOOKBACK_SECONDS,
  type AnyEventSource,
} from '../../../src/ingress/world-feed-stream-client';

class FakeEventSource implements AnyEventSource {
  static lastInstance: FakeEventSource | null = null;
  readonly url: string;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.lastInstance = this;
  }
  emit(item: popclaw.event.IWorldFeedItem, lastEventId?: string): void {
    const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(13));
    const env = { actor: { popclawId: bs58.encode(key.publicKey) }, post: { blocks: [{ content: item.textPreview ?? 'fixture' }] } };
    const canonical = canonicalizeEnvelope(env);
    const envelope = popclaw.event.EventEnvelope.encode({ ...env, eventId: cidFromCanonical(canonical), signature: nacl.sign.detached(canonical, key.secretKey) }).finish();
    const buf = popclaw.event.WorldFeedItem.encode({ ...item, envelope: item.envelope ?? envelope }).finish() as Uint8Array;
    const data = Buffer.from(buf).toString('base64');
    this.onmessage?.(lastEventId === undefined ? { data } : { data, lastEventId });
  }
  emitRaw(b64: string): void {
    this.onmessage?.({ data: b64 });
  }
  emitError(err: unknown): void {
    this.onerror?.(err);
  }
  close(): void {
    this.closed = true;
  }
}

describe('WorldFeedStreamClient', () => {
  it('logout stops the transport and refuses its queued late callback', () => {
    const controller = new AbortController();
    const received: unknown[] = [];
    const client = new WorldFeedStreamClient({ baseUrl: 'https://a.invalid', gate: { signal: controller.signal, isActive: () => !controller.signal.aborted }, onItem: item => received.push(item), eventSourceCtor: FakeEventSource });
    client.start();
    const es = FakeEventSource.lastInstance!;
    controller.abort();
    es.emit({ textPreview: 'late event' });
    expect(es.closed).toBe(true);
    expect(received).toEqual([]);
    client.start();
    expect(FakeEventSource.lastInstance).toBe(es);
  });

  it('builds URL with no query string when no filters', () => {
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: () => {},
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    expect(FakeEventSource.lastInstance!.url).toBe('http://localhost:8080/world-feed/stream');
  });

  it('combines all 3 filters into encoded URL', () => {
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      author: 'a+b/c=',
      platform: 'youtube',
      limit: 30,
      onItem: () => {},
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    const url = FakeEventSource.lastInstance!.url;
    expect(url).toContain('/world-feed/stream?');
    expect(url).toContain('author=a%2Bb%2Fc%3D');
    expect(url).toContain('platform=youtube');
    expect(url).toContain('limit=30');
  });

  it('decodes a single SSE frame and invokes onItem', () => {
    const items: popclaw.event.IWorldFeedItem[] = [];
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: (item) => items.push(item),
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    FakeEventSource.lastInstance!.emit({
      platform: 'x',
      platformPostId: 'p1',
      platformPostCreatedAt: 1700000000,
      authorPopclawId: 'A',
      handle: 'elonmusk',
      originalUrl: 'https://x.com/elonmusk/status/p1',
      textPreview: 'hello',
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.platform).toBe('x');
    expect(items[0]!.handle).toBe('elonmusk');
    expect(items[0]!.textPreview).toBe('hello');
  });

  it('multiple consecutive frames invoke onItem per frame', () => {
    const items: popclaw.event.IWorldFeedItem[] = [];
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: (item) => items.push(item),
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    const fake = FakeEventSource.lastInstance!;
    fake.emit({ platform: 'x', platformPostId: 'p1', textPreview: 'one' });
    fake.emit({ platform: 'youtube', platformPostId: 'v1', textPreview: 'two' });
    fake.emit({ platform: 'tiktok', platformPostId: 't1', textPreview: 'three' });
    expect(items.map((i) => i.textPreview)).toEqual(['one', 'two', 'three']);
  });

  it('malformed base64 → onError, onItem NOT called', () => {
    const items: popclaw.event.IWorldFeedItem[] = [];
    const errors: unknown[] = [];
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: (item) => items.push(item),
      onError: (err) => errors.push(err),
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    FakeEventSource.lastInstance!.emitRaw('not_valid_protobuf_bytes_xxx');
    expect(items).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('EventSource error → onError', () => {
    const errors: unknown[] = [];
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: () => {},
      onError: (err) => errors.push(err),
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    FakeEventSource.lastInstance!.emitError(new Error('connection lost'));
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('connection lost');
  });

  it('passes the raw decoded bytes as the second onItem arg', () => {
    const seen: { item: popclaw.event.IWorldFeedItem; bytes?: Uint8Array }[] = [];
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: (item, bytes) => seen.push({ item, bytes }),
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    FakeEventSource.lastInstance!.emit({ platform: 'x', platformPostId: 'p1', textPreview: 'hi' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.bytes).toBeInstanceOf(Uint8Array);
    // round-trips back to the same item
    const again = popclaw.event.WorldFeedItem.decode(seen[0]!.bytes!);
    expect(again.platformPostId).toBe('p1');
  });

  it.each([0, 0.9])('reconnects once after application jitter (random=%s)', async (random) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const client = new WorldFeedStreamClient({ baseUrl: 'http://house.test', onItem: () => {}, eventSourceCtor: FakeEventSource });
    try {
      client.start();
      const first = FakeEventSource.lastInstance!;
      first.emit({}, '12');
      first.emitError(new Error('offline'));
      expect(first.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(5000 + Math.floor(random * 5000) - 1);
      expect(FakeEventSource.lastInstance).toBe(first);
      await vi.advanceTimersByTimeAsync(1);
      const second = FakeEventSource.lastInstance!;
      expect(second).not.toBe(first);
      expect(new URL(second.url).searchParams.get('after')).toBe('12');
      first.emitError(new Error('stale'));
      expect(second.closed).toBe(false);
      client.stop();
      await vi.advanceTimersByTimeAsync(10000);
      expect(FakeEventSource.lastInstance).toBe(second);
    } finally { client.stop(); vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('stop() closes the EventSource and is idempotent', () => {
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: () => {},
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    const fake = FakeEventSource.lastInstance!;
    expect(fake.closed).toBe(false);
    client.stop();
    expect(fake.closed).toBe(true);
    // Idempotent: second stop is a no-op
    client.stop();
    expect(fake.closed).toBe(true);
  });

  it('omits since when no cursor is given (fresh install → house default window)', () => {
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      limit: 5000,
      onItem: () => {},
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    expect(FakeEventSource.lastInstance!.url).not.toContain('since=');
  });

  it('puts the cursor in the query when given', () => {
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      limit: 5000,
      since: 1_700_000_000,
      onItem: () => {},
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    expect(FakeEventSource.lastInstance!.url).toContain('since=1700000000');
  });
});

describe('worldFeedSince', () => {
  it('an empty cache asks for no cursor at all', () => {
    // A fresh install must not pin itself to an arbitrary floor — it wants
    // whatever recent window the house serves by default.
    expect(worldFeedSince(null)).toEqual({});
  });

  it('backs the cursor off the newest cached row by the lookback', () => {
    const newest = 1_700_000_000;
    expect(worldFeedSince(newest)).toEqual({
      since: newest - SINCE_CURSOR_LOOKBACK_SECONDS,
    });
  });

  // Cache younger than the lookback (a days-old install): floor at 0 rather
  // than sending a negative second, which the house would read as 1969.
  it('never goes negative', () => {
    expect(worldFeedSince(1000)).toEqual({ since: 0 });
  });
});

describe('insert-order cursor (`after`)', () => {
  it('puts `after` in the query when given', () => {
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      limit: 5000,
      after: 4242,
      onItem: () => {},
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    expect(FakeEventSource.lastInstance!.url).toContain('after=4242');
  });

  it('hands the frame`s SSE id to onItem as the third arg', () => {
    // That id IS the cursor — without it nothing can be persisted, and the
    // next boot silently falls back to the timestamp window.
    const seen: string[] = [];
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: (_i, _b, lastEventId) => seen.push(lastEventId),
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    FakeEventSource.lastInstance!.emit({ platform: 'x', platformPostId: 'p1' }, '77');
    expect(seen).toEqual(['77']);
  });

  it('an unstamped frame (old house) yields an empty id, not a crash', () => {
    const seen: string[] = [];
    const client = new WorldFeedStreamClient({
      baseUrl: 'http://localhost:8080',
      onItem: (_i, _b, lastEventId) => seen.push(lastEventId),
      eventSourceCtor: FakeEventSource as unknown as new (url: string) => AnyEventSource,
    });
    client.start();
    FakeEventSource.lastInstance!.emit({ platform: 'x', platformPostId: 'p1' });
    expect(seen).toEqual(['']);
  });
});

describe('worldFeedResume', () => {
  it('prefers the insert cursor over the timestamp one', () => {
    expect(worldFeedResume(500, 1_700_000_000)).toEqual({ after: 500 });
  });

  it('falls back to `since` when there is no insert cursor yet', () => {
    // The upgrade path: an existing install`s cache has rows but has never
    // seen an `id:`-stamped frame. It resumes on the old cursor for one
    // connection, and has an insert cursor from the first frame onward.
    expect(worldFeedResume(null, 1_700_000_000)).toEqual({
      since: 1_700_000_000 - SINCE_CURSOR_LOOKBACK_SECONDS,
    });
  });

  it('a fresh install sends no cursor at all', () => {
    expect(worldFeedResume(null, null)).toEqual({});
  });

  it('ignores a junk insert cursor rather than pinning to it', () => {
    expect(worldFeedResume(0, null)).toEqual({});
    expect(worldFeedResume(-1, null)).toEqual({});
    expect(worldFeedResume(Number.NaN, null)).toEqual({});
  });
});
