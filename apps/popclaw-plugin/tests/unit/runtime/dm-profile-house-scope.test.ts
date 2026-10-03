import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { InboxStore } from '../../../src/messaging/inbox-store.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import { makeDmNotificationPolicy } from '../../../src/runtime/dm-notification-policy.js';
import { VerifiedFollowersCache } from '../../../src/identity/verified-followers-cache.js';
import { withAction } from '../../../src/runtime/house-lifecycle/action-context.js';
const A = 'https://a.invalid'; const B = 'https://b.invalid';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function gate() { const controller = new AbortController(); return { signal: controller.signal, isActive: () => !controller.signal.aborted, close: () => controller.abort() }; }
const hosts: InMemoryHostAdapter[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.db.close(); });
function setup(fetch: typeof globalThis.fetch) {
  const host = new InMemoryHostAdapter(); hosts.push(host);
  const inbox = new InboxStore(host.db); const notifier = new SqliteNotifier(host.db, () => 123);
  const cache = new VerifiedFollowersCache({ loreHouseUrl: A, fetch }); const gates = { a: gate(), b: gate() };
  const origin = (slug?: string) => slug === 'b' ? B : A;
  const policy = makeDmNotificationPolicy({ inbox, notifier, graph: { following: () => [] }, vipThreshold: 100, nameOf: (id) => id,
    gateForHouse: (slug) => gates[slug as 'a' | 'b'],
    verdictOf: (id, slug?: string) => ({ blocked: false, verifiedFollowerCount: cache.getFresh(id, origin(slug)) }),
    refresh: (id, slug?: string) => cache.refresh(id, origin(slug)),
  });
  const message = (houseSlug: string) => inbox.recordReceived({ ts: 10, fromPopclawId: 'alice', toPopclawId: 'bob', body: `message-${houseSlug}`, houseSlug, receivedAtMs: 100 }).item;
  return { cache, gates, policy, message, inbox, notifier };
}
describe('DM profile authority follows the receiving house', () => {
  it('requests B for a B message even when A has cached the same author as VIP', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => Response.json({ profiles: [{ follower_count: new URL(String(input)).origin === A ? 500 : 0 }] }));
    const { cache, policy, message, notifier, inbox } = setup(fetch);
    await cache.refresh('alice', A); const item = message('b'); await policy.handle(item);
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).origin)).toEqual([A, B]);
    expect(cache.getFresh('alice', A)).toBe(500); expect(cache.getFresh('alice', B)).toBe(0);
    expect(notifier.count()).toBe(0); expect(inbox.get(item.id)?.notificationState).toBe('silent');
  });
  it('discards A body after logout without blocking B profile or notification', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>; const reading = deferred<void>();
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
    const readJson = response.json.bind(response); vi.spyOn(response, 'json').mockImplementation(() => { reading.resolve(); return readJson(); });
    const fetch = vi.fn(async (input: RequestInfo | URL) => new URL(String(input)).origin === A ? response : Response.json({ profiles: [{ follower_count: 600 }] }));
    const { cache, gates, policy, message, notifier, inbox } = setup(fetch); const a = message('a'); const b = message('b');
    const pendingA = policy.handle(a); await reading.promise; gates.a.close();
    const pendingB = policy.handle(b);
    // A owns an uncancellable body promise; B must not share that in-flight key.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pendingB, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('B joined A profile request')), 1000); })]);
      expect(notifier.count()).toBe(1); expect(inbox.get(b.id)?.notificationState).toBe('queued');
    } finally {
      clearTimeout(timeout);
      body.enqueue(new TextEncoder().encode(JSON.stringify({ profiles: [{ follower_count: 999 }] }))); body.close();
      await Promise.all([pendingA, pendingB]);
    }
    expect(cache.getFresh('alice', A)).toBeUndefined(); expect(cache.getFresh('alice', B)).toBe(600);
    expect(inbox.get(a.id)?.notificationState).toBe('pending'); expect(notifier.count()).toBe(1);
  });
  it('does not negative-cache a 404 whose request settles after cancellation', async () => {
    const response = deferred<Response>(); const g = gate();
    const cache = new VerifiedFollowersCache({ loreHouseUrl: A, fetch: () => response.promise });
    const work = withAction(g, () => cache.refresh('unknown', A)); g.close(); response.resolve(new Response(null, { status: 404 })); await work;
    expect(cache.getFresh('unknown', A)).toBeUndefined();
  });
});
