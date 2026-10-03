import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryHostAdapter } from '../../../src/host/host-adapter.in-memory.js';
import { VerifiedFollowersCache } from '../../../src/identity/verified-followers-cache.js';
import { SqliteNotifier } from '../../../src/notifier/sqlite-notifier.js';
import {
  KnownFollowersStore, syncFollowers, syncFollowersOnce,
  type FollowerSyncDeps, type HouseRef,
} from '../../../src/social-graph/followers-sync.js';
import { grantingReadAuthorityFor } from '../../helpers/read-authority.js';

const A = { slug: 'a', baseUrl: 'https://a.invalid' };
const B = { slug: 'b', baseUrl: 'https://b.invalid' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function gate() {
  const controller = new AbortController();
  return { signal: controller.signal, isActive: () => !controller.signal.aborted, close: () => controller.abort() };
}
function pendingJson() {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const reading = deferred<void>();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
  const json = response.json.bind(response);
  vi.spyOn(response, 'json').mockImplementation(() => { reading.resolve(); return json(); });
  return {
    response, reading: reading.promise,
    finish: (value: unknown) => { body.enqueue(new TextEncoder().encode(JSON.stringify(value))); body.close(); },
  };
}
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('B waited for cancelled A')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}
const hosts: InMemoryHostAdapter[] = [];
afterEach(() => { for (const host of hosts.splice(0)) host.db.close(); });
function setup(fetch: typeof globalThis.fetch) {
  const host = new InMemoryHostAdapter(); hosts.push(host);
  const store = new KnownFollowersStore(host.db, () => 100);
  const notifier = new SqliteNotifier(host.db, () => 100);
  const record = vi.fn();
  const gates = { a: gate(), b: gate() };
  const gateForHouse = vi.fn((house: HouseRef) => gates[house.slug as 'a' | 'b']);
  const cache = new VerifiedFollowersCache({ loreHouseUrl: A.baseUrl, fetch });
  const deps: FollowerSyncDeps = {
    ownerPopclawId: 'owner', store, notifier, fetch, gateForHouse,
    readAuthorityFor: grantingReadAuthorityFor,
    socialGraph: { following: () => [] }, socialLog: { record }, verifiedFollowers: cache,
  };
  return { deps, store, notifier, record, gates, gateForHouse, cache };
}

describe('followers sync retains its house generation across awaits', () => {
  it('does not establish a baseline from JSON arriving after logout', async () => {
    const body = pendingJson();
    const h = setup(async () => body.response);
    const work = syncFollowers(h.deps, [A]);
    await body.reading; h.gates.a.close(); h.gates.a = gate();
    body.finish([{ popclaw_id: 'late-follower' }]);
    expect(await work).toBe(0);
    expect(h.store.hasBaseline(A.slug)).toBe(false);
    expect(h.store.list(A.slug)).toEqual([]);
    expect(h.notifier.count()).toBe(0); expect(h.record).not.toHaveBeenCalled();
    expect(h.gateForHouse).toHaveBeenCalledTimes(1);
  });

  it('guards the standalone diff and preserves existing followers after logout', async () => {
    const body = pendingJson(); const h = setup(async () => body.response);
    h.store.markBaseline(A.slug); h.store.reconcile(A.slug, ['existing']);
    const work = syncFollowersOnce(h.deps, A);
    const rejected = expect(work).rejects.toThrow('no longer active');
    await body.reading; h.gates.a.close(); body.finish([]);
    await rejected;
    expect(h.store.list(A.slug)).toEqual(['existing']);
    expect(h.gateForHouse).toHaveBeenCalledTimes(1);
  });

  it('discards cancelled profile enrichment while B finishes before A drains', async () => {
    const profileA = pendingJson();
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/followers/')) return Response.json([{ popclaw_id: 'same-follower' }]);
      return url.origin === A.baseUrl ? profileA.response : Response.json({ profiles: [{ follower_count: 600 }] });
    });
    const h = setup(fetch);
    for (const house of [A, B]) h.store.markBaseline(house.slug);
    const queuedB = deferred<void>();
    const enqueue = h.notifier.enqueue.bind(h.notifier);
    vi.spyOn(h.notifier, 'enqueue').mockImplementation((item) => {
      enqueue(item); if (item.payload.houseSlug === B.slug) queuedB.resolve();
    });
    const work = syncFollowers(h.deps, [A, B]);
    await profileA.reading; h.gates.a.close(); h.gates.a = gate();
    try {
      await deadline(queuedB.promise);
      expect(h.store.list(B.slug)).toEqual(['same-follower']);
      expect(h.cache.getFresh('same-follower', B.baseUrl)).toBe(600);
    } finally {
      profileA.finish({ profiles: [{ follower_count: 999 }] });
      await work;
    }
    expect(await work).toBe(1);
    expect(h.store.list(A.slug)).toEqual([]);
    expect(h.cache.getFresh('same-follower', A.baseUrl)).toBeUndefined();
    const notifications = h.notifier.drain('L2');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.payload).toMatchObject({ houseSlug: B.slug, verifiedFollowerCount: 600 });
    expect(h.record).toHaveBeenCalledTimes(1);
    expect(h.gateForHouse.mock.calls.map(([house]) => house.slug).sort()).toEqual(['a', 'b']);
  });

  it('does not notify twice when rounds overlap during profile enrichment', async () => {
    const profile = pendingJson(); const bothRefreshing = deferred<void>();
    const h = setup(async (input) => new URL(String(input)).pathname.startsWith('/followers/')
      ? Response.json([{ popclaw_id: 'same-follower' }]) : profile.response);
    h.store.markBaseline(A.slug);
    const refresh = h.cache.refresh.bind(h.cache); let calls = 0;
    vi.spyOn(h.cache, 'refresh').mockImplementation((...args) => {
      const work = refresh(...args);
      if (++calls === 2) bothRefreshing.resolve();
      return work;
    });
    const first = syncFollowers(h.deps, [A]); await profile.reading;
    const second = syncFollowers(h.deps, [A]); await bothRefreshing.promise;
    profile.finish({ profiles: [{ follower_count: 500 }] });
    expect((await Promise.all([first, second])).reduce((sum, n) => sum + n, 0)).toBe(1);
    expect(h.notifier.count()).toBe(1); expect(h.record).toHaveBeenCalledTimes(1);
  });

  it('uses each fresh house profile and keeps first-run and unfollow behavior', async () => {
    const followers = { a: ['same-follower'], b: ['same-follower'] };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); const slug = url.origin === A.baseUrl ? 'a' : 'b';
      return url.pathname.startsWith('/followers/')
        ? Response.json(followers[slug].map((popclaw_id) => ({ popclaw_id })))
        : Response.json({ profiles: [{ follower_count: slug === 'a' ? 500 : 200 }] });
    });
    const h = setup(fetch);
    expect(await syncFollowers(h.deps, [A, B])).toBe(0);
    followers.a = []; followers.b = [];
    expect(await syncFollowers(h.deps, [A, B])).toBe(0);
    await h.cache.refresh('same-follower', A.baseUrl); await h.cache.refresh('same-follower', B.baseUrl);
    const refresh = vi.spyOn(h.cache, 'refresh'); const fresh = vi.spyOn(h.cache, 'getFresh');
    followers.a = ['same-follower']; followers.b = ['same-follower'];
    expect(await syncFollowers(h.deps, [A, B])).toBe(2);
    for (const house of [A, B]) {
      expect(refresh).toHaveBeenCalledWith('same-follower', house.baseUrl);
      expect(fresh).toHaveBeenCalledWith('same-follower', house.baseUrl);
    }
    const queued = h.notifier.drain('L2');
    expect(queued.find((item) => item.payload.houseSlug === A.slug)?.payload.verifiedFollowerCount).toBe(500);
    expect(queued.find((item) => item.payload.houseSlug === B.slug)?.payload.verifiedFollowerCount).toBe(200);
    expect(h.record).toHaveBeenCalledTimes(2);
  });
});
