import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { InMemoryHostDb } from '../../../src/host/in-memory-host-db.js';
import { runMigrations } from '../../../src/host/migrations.js';
import { beginHouseAdd, commitEstablishAndActivate, prepareHouseTrust } from '../../../src/world/house-trust.js';
import { HouseFeedReader, ORDINARY_SNAPSHOT_LIMIT, ordinarySignedMaterial } from '../../../src/ingress/house-feed-reader.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { WorldFeedClient, readVerifiedSnapshotEnvelope, type VerifiedSnapshotEnvelope } from '../../../src/ingress/world-feed-client.js';
import * as capabilities from '../../../src/world/world-capabilities.js';
import type { HouseStore } from '../../../src/ingress/world-feed-store.js';
import type { HouseRuntime } from '../../../src/runtime/house-lifecycle/house-runtime.js';
import { mintHouse } from '../../helpers/signed-manifest.js';

const origin = 'https://ordinary.example.test';
const actorKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
const actorId = bs58.encode(actorKey.publicKey);
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });

function signed(body: Partial<popclaw.event.IEventEnvelope>, timestamp = 100): Uint8Array {
  const envelope = { actor: { popclawId: actorId, nickname: 'Synthetic author' }, timestamp, ...body };
  const canonical = canonicalizeEnvelope(envelope);
  return popclaw.event.EventEnvelope.encode({ ...envelope, eventId: cidFromCanonical(canonical),
    signature: nacl.sign.detached(canonical, actorKey.secretKey) }).finish();
}
function row(envelope: Uint8Array): popclaw.event.IWorldFeedItem {
  return { envelope, eventId: 'relay-id', platform: 'relay-platform', platformPostId: 'relay-post',
    authorPopclawId: 'relay-author', actorNickname: 'relay-name', textPreview: 'relay-only body' };
}
function snapshot(rows: popclaw.event.IWorldFeedItem[]): Uint8Array {
  return popclaw.event.WorldFeedSnapshot.encode({ items: rows }).finish();
}
function field(tag: number, bytes: Uint8Array): Uint8Array {
  const encode = (value: number): number[] => {
    const out: number[] = [];
    do { const byte = value & 127; value >>>= 7; out.push(byte | (value ? 128 : 0)); } while (value);
    return out;
  };
  return new Uint8Array([...encode(tag * 8 + 2), ...encode(bytes.length), ...bytes]);
}
async function fixture(rows: popclaw.event.IWorldFeedItem[], opts: { bytes?: Uint8Array; officialIds?: string[]; currentReadScope?: () => { token: object; isCurrent(): boolean } | undefined } = {}) {
  const db = new InMemoryHostDb(), cacheDb = new InMemoryHostDb();
  cleanup.push(() => db.close(), () => cacheDb.close());
  runMigrations(db, fileURLToPath(new URL('../../../migrations', import.meta.url)));
  const house = mintHouse({ origin, seed: 7, manifest: {
    read_auth: { schemes: ['popclaw-identity-read-v2'] }, official_ids: opts.officialIds ?? [],
  } });
  const prepared = await prepareHouseTrust(db, origin, { attempt: beginHouseAdd(db, origin), fetch: house.fetch as typeof fetch });
  if (!prepared.ok) throw new Error(prepared.refusal);
  const admitted = commitEstablishAndActivate(db, prepared.prepared);
  if (!admitted.ok) throw new Error(admitted.refusal);
  const cache = new WorldFeedCache({ db: cacheDb }); await cache.start();
  let current = true, generation = 0;
  const assertCurrent = vi.fn(() => { if (!current) throw new Error('ORDINARY_FEED_SOURCE_CHANGED'); });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/manifest')) return house.fetch(input);
    return new Response(new Uint8Array(opts.bytes ?? snapshot(rows)));
  });
  const store = { slug: 'ordinary-example-test', baseUrl: origin, cache, db: cacheDb, dbPath: ':memory:' };
  const stores: HouseStore[] = [store];
  const capturePublicDisplay = vi.fn(() => { throw new Error('PUBLIC_DISPLAY_CAPTURE_REFUSED'); });
  const houses = { capturePublicDisplay, captureOrdinaryFeed: () => { const captured = generation; return { authority: 'synthetic-current-source', assertCurrent: () => { assertCurrent(); if (captured !== generation) throw new Error('ORDINARY_FEED_SOURCE_CHANGED'); } }; },
    houseReadFetch: () => fetchMock } as unknown as HouseRuntime;
  const reader = new HouseFeedReader({ db, houses, stores: () => stores, currentReadScope: opts.currentReadScope });
  return { reader, cacheDb, cache, store, stores, fetchMock, assertCurrent, capturePublicDisplay, advance: () => { generation++; }, revoke: () => { current = false; } };
}

describe('ordinary House snapshot verification', () => {
  it('verifies each envelope once while preserving signed content, filtering, ordering and fixed coverage', async () => {
    const post = signed({ post: { blocks: [{ content: 'Signed native post' }] } }, 100);
    const mirror = signed({ post: { blocks: [{ content: 'Signed mirror post' }], origin: {
      platform: 'x', postId: 'external-1', url: 'https://example.test/external-1', createdAt: 200,
    } } }, 200);
    const reply = signed({ reply: { body: 'Signed reply', inReplyTo: { platform: 'popclaw', platformPostId: 'parent' } } }, 300);
    const f = await fixture([row(post), row(reply), row(mirror)]);
    const verify = vi.spyOn(nacl.sign.detached, 'verify');
    const prepared = await f.reader.prepare({ limit: 1 });
    const result = prepared.read({ limit: 1, includeThreads: false });
    expect(result.sources[0]).toMatchObject({ protocol: 'ordinary-snapshot', unavailable: false, incomplete: true });
    expect(result.items.map(hit => hit.body)).toEqual(['Signed mirror post']);
    expect(result.items[0]).toMatchObject({ mirrorSigner: true, item: { authorPopclawId: '', actorNickname: '', platform: 'x' } });
    expect(result.truncated).toBe(true);
    expect(prepared.read({ author: actorId, includeThreads: false }).items.map(hit => hit.body)).toEqual(['Signed native post']);
    expect(prepared.read({ platform: 'x' }).items.map(hit => hit.body)).toEqual(['Signed mirror post']);
    expect(prepared.read({ includeThreads: true }).items.map(hit => hit.body)).toEqual(['Signed reply', 'Signed mirror post', 'Signed native post']);
    expect(f.fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${origin}/v1/manifest`, `${origin}/world-feed?limit=${ORDINARY_SNAPSHOT_LIMIT}`,
    ]);
    const contentChecks = verify.mock.calls.filter(([, , key]) => Buffer.from(key).equals(Buffer.from(actorKey.publicKey)));
    expect(contentChecks).toHaveLength(3);
  });

  it.each(['signature', 'cid', 'private', 'carrier'] as const)('rejects the whole snapshot before cache effects for invalid %s', async invalid => {
    const valid = signed({ post: { blocks: [{ content: 'Good member of a bad batch' }] } });
    let broken: Uint8Array;
    if (invalid === 'private') broken = signed({ directMessage: { fromPopclawId: actorId, toPopclawId: actorId, body: 'Private synthetic text' }, target: { scope: 1, targetIds: [actorId] } });
    else {
      const envelope = popclaw.event.EventEnvelope.decode(valid);
      if (invalid === 'signature') envelope.signature[0] = envelope.signature[0]! ^ 1;
      else envelope.eventId = '0'.repeat(64);
      broken = popclaw.event.EventEnvelope.encode(envelope).finish();
    }
    const duplicateCarrier = new Uint8Array([...popclaw.event.WorldFeedItem.encode(row(valid)).finish(), ...field(22, broken)]);
    const f = await fixture([row(valid), row(broken)], invalid === 'carrier'
      ? { bytes: new Uint8Array([...field(1, popclaw.event.WorldFeedItem.encode(row(valid)).finish()), ...field(1, duplicateCarrier)]) } : {});
    const prepared = await f.reader.prepare();
    const result = prepared.read();
    expect(result.items).toEqual([]);
    expect(result.sources[0]).toMatchObject({ protocol: 'ordinary-snapshot', unavailable: true });
    expect(f.cacheDb.queryAll('SELECT * FROM world_feed')).toEqual([]);
  });

  it('requires this House to authorize official envelopes even when they are not display posts', async () => {
    const official = signed({ houseEvent: { kind: 'fixture.notice', schemaVersion: 1, body: new TextEncoder().encode('{}') } });
    const post = signed({ post: { blocks: [{ content: 'Normal signed material' }] } });
    const refused = await fixture([row(post), row(official)]);
    expect((await refused.reader.prepare()).read().sources[0]?.unavailable).toBe(true);
    expect(refused.cacheDb.queryAll('SELECT * FROM world_feed')).toEqual([]);
    const accepted = await fixture([row(post), row(official)], { officialIds: [actorId] });
    expect((await accepted.reader.prepare()).read().items.map(hit => hit.body)).toEqual(['Normal signed material']);
  });

  it('still checks current authority when exposing a prepared snapshot', async () => {
    const f = await fixture([row(signed({ post: { blocks: [{ content: 'Current source only' }] } }))]);
    const prepared = await f.reader.prepare(); f.revoke();
    expect(prepared.read()).toMatchObject({ items: [], sources: [{ unavailable: true, code: 'ORDINARY_FEED_SOURCE_CHANGED' }] });
  });

  it('retains immutable proof material and rejects cloned or forged handles', async () => {
    const original = signed({ post: { blocks: [{ content: 'Owned signed material' }] } });
    const client = new WorldFeedClient({ baseUrl: origin, fetch: vi.fn(async () => new Response(new Uint8Array(snapshot([row(original)])))) });
    const [handle] = await client.fetchVerifiedSnapshot({});
    const first = readVerifiedSnapshotEnvelope(handle!);
    first.raw.fill(0); first.envelope.post!.blocks![0]!.content = 'Changed by caller';
    const second = readVerifiedSnapshotEnvelope(handle!);
    expect(Buffer.from(second.raw)).toEqual(Buffer.from(original));
    expect(second.envelope.post!.blocks![0]!.content).toBe('Owned signed material');
    expect(() => readVerifiedSnapshotEnvelope({ ...handle! })).toThrow('WORLD_FEED_VERIFICATION_REQUIRED');
    expect(() => readVerifiedSnapshotEnvelope({} as VerifiedSnapshotEnvelope)).toThrow('WORLD_FEED_VERIFICATION_REQUIRED');
  });

  it('verifies a new transport request even when its signed bytes are identical', async () => {
    const original = signed({ post: { blocks: [{ content: 'Fresh validation for each request' }] } });
    const fetch = vi.fn(async () => new Response(new Uint8Array(snapshot([row(original)]))));
    const client = new WorldFeedClient({ baseUrl: origin, fetch });
    const verify = vi.spyOn(nacl.sign.detached, 'verify');
    const first = await client.fetchVerifiedSnapshot({}), second = await client.fetchVerifiedSnapshot({});
    expect(first[0]).not.toBe(second[0]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('keeps the raw-material entry point responsible for its own signature', () => {
    const raw = signed({ post: { blocks: [{ content: 'Standalone material' }] } });
    const source = { origin, slug: 'ordinary-example-test', observedAt: 1, sequence: '', logIncarnation: '' };
    expect(ordinarySignedMaterial(raw, [], source)?.body).toBe('Standalone material');
    const changed = popclaw.event.EventEnvelope.decode(raw); changed.signature[0] = changed.signature[0]! ^ 1;
    expect(() => ordinarySignedMaterial(popclaw.event.EventEnvelope.encode(changed).finish(), [], source)).toThrow('SIGNATURE_INVALID');
  });
});


function requestScope() {
  let current = true;
  return { token: {}, isCurrent: () => current, end: () => { current = false; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const scopeRows = () => [100, 200, 300].map(time => row(signed({ post: { blocks: [{ content: `Post ${time}` }] } }, time)));

describe('ordinary House snapshot request reuse', () => {
  it('shares fixed coverage across sequential feed, summary and search while each view owns its limit', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const feed = await f.reader.prepare({ limit: 1 });
    expect(feed.read({ limit: 1 }).items).toHaveLength(1);
    expect(await f.reader.fetchSnapshot({ limit: 100 })).toHaveLength(3);
    expect((await f.reader.prepare()).search('Post 100').items).toHaveLength(1);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shares pending transport within one request and does not share without a request identity', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const [one, two] = await Promise.all([f.reader.prepare(), f.reader.prepare({ limit: 1 })]);
    expect(one.read().items).toHaveLength(3); expect(two.read({ limit: 1 }).items).toHaveLength(1);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    const unscoped = await fixture(scopeRows());
    await unscoped.reader.prepare(); await unscoped.reader.prepare();
    expect(unscoped.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('uses fresh transport for a different request, author or platform and normalizes empty filters', async () => {
    let scope = requestScope();
    const f = await fixture(scopeRows(), { currentReadScope: () => scope });
    await f.reader.prepare(); await f.reader.prepare({ author: '', platform: '' });
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
    await f.reader.prepare({ author: actorId }); await f.reader.prepare({ platform: 'popclaw' });
    expect(f.fetchMock).toHaveBeenCalledTimes(6);
    scope = requestScope(); await f.reader.prepare();
    expect(f.fetchMock).toHaveBeenCalledTimes(8);
  });

  it('captures store identity, order and values rather than retaining a mutable stores array', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const first = await f.reader.prepare();
    f.stores[0] = { ...f.store }; await f.reader.prepare();
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
    expect(first.read().sources[0]?.unavailable).toBe(true);
    Object.assign(f.stores[0]!, { slug: 'renamed-store' }); await f.reader.prepare();
    expect(f.fetchMock).toHaveBeenCalledTimes(6);
    f.stores.push({ ...f.store, slug: 'second-store' }); await f.reader.prepare();
    expect(f.fetchMock).toHaveBeenCalledTimes(10);
    f.stores.reverse(); await f.reader.prepare();
    expect(f.fetchMock).toHaveBeenCalledTimes(14);
  });

  it('reacquires after authority changes and refuses disabled authority even on a cache hit', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    await f.reader.prepare(); f.advance();
    expect((await f.reader.prepare()).read().items).toHaveLength(3);
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
    f.revoke();
    expect((await f.reader.prepare()).read()).toMatchObject({ items: [], sources: [{ unavailable: true }] });
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('shares a replacement acquisition after simultaneous stale-authority hits', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    await f.reader.prepare(); f.advance();
    const views = await Promise.all([f.reader.prepare(), f.reader.prepare()]);
    expect(views.every(view => view.read().items.length === 3)).toBe(true);
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('preserves typed refusal in mixed Houses and does not retain an ordinary partial result', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const journalOrigin = 'https://journal.example.test', original = capabilities.readHouseCapabilityView;
    vi.spyOn(capabilities, 'readHouseCapabilityView').mockImplementation((db, requestedOrigin) =>
      requestedOrigin === journalOrigin ? {} as never : original(db, requestedOrigin));
    f.stores.push({ ...f.store, slug: 'journal-house', baseUrl: journalOrigin });
    for (let i = 0; i < 2; i++) {
      const result = (await f.reader.prepare()).read();
      expect(result.items).toHaveLength(3);
      expect(result.sources[1]).toMatchObject({ unavailable: true, code: 'PUBLIC_DISPLAY_CAPTURE_REFUSED' });
    }
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
    expect(f.capturePublicDisplay).toHaveBeenCalledTimes(2);
  });

  it('invalidates already prepared results and refuses new transport after scope end', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const prepared = await f.reader.prepare(), exported = prepared.ordinarySources[0]!;
    scope.end();
    expect(prepared.read()).toMatchObject({ items: [], sources: [{ unavailable: true, code: 'READ_REQUEST_SCOPE_ENDED' }] });
    expect(() => exported.assertCurrent()).toThrow('READ_REQUEST_SCOPE_ENDED');
    expect(prepared.ordinarySources[0]?.items).toHaveLength(0);
    expect((await f.reader.prepare()).read().items).toHaveLength(0);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache or deliver a transport that completes after its original scope ends', async () => {
    let scope = requestScope();
    const f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const started = deferred<void>(), release = deferred<void>(), fetch = f.fetchMock.getMockImplementation()!;
    f.fetchMock.mockImplementation(async input => {
      if (String(input).includes('/world-feed')) { started.resolve(); await release.promise; }
      return fetch(input);
    });
    const pending = f.reader.prepare(); await started.promise;
    scope.end(); scope = requestScope(); release.resolve();
    expect((await pending).read()).toMatchObject({ items: [], sources: [{ unavailable: true }] });
    expect(f.cacheDb.queryAll('SELECT * FROM world_feed')).toHaveLength(0);
    expect((await f.reader.prepare()).read().items).toHaveLength(3);
    expect(f.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retain failed or partially unavailable acquisitions', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const fetch = f.fetchMock.getMockImplementation()!;
    let fail = true;
    f.fetchMock.mockImplementation(async input => {
      if (fail && String(input).includes('/world-feed')) { fail = false; return new Response('', { status: 503 }); }
      return fetch(input);
    });
    expect((await f.reader.prepare()).read().sources[0]?.unavailable).toBe(true);
    expect((await f.reader.prepare()).read().items).toHaveLength(3);
    await f.reader.prepare(); expect(f.fetchMock).toHaveBeenCalledTimes(4);
    f.stores.push({ ...f.store, slug: 'second-store' }); fail = true;
    expect((await f.reader.prepare()).read().sources.some(source => source.unavailable)).toBe(true);
    await f.reader.prepare(); expect(f.fetchMock).toHaveBeenCalledTimes(12);
  });

  it('does not let an old pending failure delete a replacement entry for the same query', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const started = deferred<void>(), release = deferred<void>(), fetch = f.fetchMock.getMockImplementation()!;
    let first = true;
    f.fetchMock.mockImplementation(async input => {
      if (first && String(input).includes('/world-feed')) { first = false; started.resolve(); await release.promise; return new Response('', { status: 503 }); }
      return fetch(input);
    });
    const old = f.reader.prepare(); await started.promise;
    f.stores[0] = { ...f.store };
    expect((await f.reader.prepare()).read().items).toHaveLength(3);
    release.resolve(); expect((await old).read().items).toHaveLength(0);
    await f.reader.prepare(); expect(f.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('isolates returned items, status and manifest evidence between consumers', async () => {
    const scope = requestScope(), f = await fixture(scopeRows(), { currentReadScope: () => scope });
    const prepared = await f.reader.prepare(), ordinary = prepared.ordinarySources[0]!;
    ordinary.items[0]!.item.envelope!.fill(0);
    Object.assign(ordinary.items[0]!, { body: 'mutated' });
    Object.assign(ordinary.status, { unavailable: true });
    Object.assign(ordinary.evidence, { manifest: 'broken', proof: 'broken' });
    const view = prepared.read(); expect(view.items).toHaveLength(3); view.items[0]!.item.envelope!.fill(0);
    const later = await f.reader.prepare();
    expect(later.read().items.map(hit => hit.body)).toEqual(['Post 300', 'Post 200', 'Post 100']);
    expect(later.ordinarySources[0]!.status.unavailable).toBe(false);
    expect(() => later.ordinarySources[0]!.assertCurrent()).not.toThrow();
    expect(later.ordinarySources[0]!.evidence.manifest).not.toBe('broken');
    expect(later.ordinarySources[0]!.items[0]!.item.envelope!.some(byte => byte !== 0)).toBe(true);
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });
});
