import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical } from '@popclaw/algorithms';
import { canonicalizeEnvelope, decodeEnvelope } from '../../../src/protocol/public-envelope.js';
import { popclaw as publicProto } from '../../../src/protocol/public-envelope-generated.js';
import { inspectPublicCarrier } from '../../../src/ingress/public-stream-wire.js';
import { verifyInboundEnvelope } from '../../../src/ingress/verify-envelope.js';
import { WorldFeedClient } from '../../../src/ingress/world-feed-client.js';
import { WorldFeedCache } from '../../../src/ingress/world-feed-cache.js';
import { WorldFeedStreamClient } from '../../../src/ingress/world-feed-stream-client.js';
import { PublicWorldStreamClient } from '../../../src/ingress/public-world-stream-client.js';
import { SseIngress, type SseIngressOptions } from '../../../src/ingress/sse-ingress.js';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { LocalHostAdapter } from '../../../src/host/local-host-adapter.js';

const signingKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(91));
const actor = bs58.encode(signingKey.publicKey);
const recipient = bs58.encode(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(92)).publicKey);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function concat(...parts: Uint8Array[]): Uint8Array { return new Uint8Array(Buffer.concat(parts)); }
function varint(value: number): Uint8Array {
  const bytes: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); bytes.push(byte | (value ? 128 : 0)); } while (value);
  return new Uint8Array(bytes);
}
function field(tag: number, bytes: Uint8Array): Uint8Array { return concat(varint(tag * 8 + 2), varint(bytes.length), bytes); }
function signed(body: Record<string, unknown>) {
  const envelope = { actor: { popclawId: actor, nickname: 'Boundary author' }, timestamp: 1789000000, ...body };
  const canonical = canonicalizeEnvelope(envelope), eventId = cidFromCanonical(canonical);
  const bytes = popclaw.event.EventEnvelope.encode({ ...envelope, eventId, signature: nacl.sign.detached(canonical, signingKey.secretKey) }).finish();
  return { bytes, eventId };
}
const post = signed({ post: { blocks: [{ content: 'Signed public message' }] } });
const profile = signed({ profile: { nickname: 'Supported profile' } });
const privateDm = signed({ target: { scope: 1, targetIds: [recipient] },
  directMessage: { fromPopclawId: actor, toPopclawId: recipient, body: 'Private message must not appear in a public preview' } });
// The ordinary signature remains unchanged. A public generated decoder alone
// discards tag 29; a raw guard must reject the original bytes instead.
const reservedBody = concat(post.bytes, field(29, new Uint8Array()));
const profileHeader = popclaw.event.EventEnvelope.encode({ ...popclaw.event.EventEnvelope.decode(profile.bytes), profile: undefined }).finish();
const reservedProfile = concat(profileHeader, field(28, concat(
  popclaw.profile.Profile.encode({ nickname: 'Supported profile' }).finish(), field(8, new Uint8Array()))));
function item(envelope = post.bytes): popclaw.event.IWorldFeedItem {
  return { platform: 'popclaw', platformPostId: post.eventId, eventId: post.eventId,
    platformPostCreatedAt: 1789000000, authorPopclawId: actor, textPreview: 'Unsafe cached preview must never escape', envelope };
}
function itemBytes(envelope = post.bytes) { return popclaw.event.WorldFeedItem.encode(item(envelope)).finish(); }
const hiddenItem = () => concat(field(22, reservedBody), itemBytes());
const hiddenDiscovery = () => concat(field(2, reservedBody), field(2, post.bytes));
const hiddenFrame = () => concat(field(2, reservedBody), popclaw.event.WorldStreamFrame.encode({ seq: 9, kind: 'post', envelope: post.bytes }).finish());
const publicBaselineVectors = JSON.parse(readFileSync(new URL('../../../../../protocol/packages/contracts/fixtures/public-baseline.json', import.meta.url), 'utf8')) as {
  signed: Array<{ name: string; cid: string; wire_hex: string }>;
};
async function cacheFixture() {
  const db = new LocalHostDb(':memory:'); cleanup.push(() => db.close());
  const cache = new WorldFeedCache({ db }); await cache.start(); return { db, cache };
}
class RawEventSource {
  static latest: RawEventSource;
  onmessage: ((event: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { RawEventSource.latest = this; }
  emit(bytes: Uint8Array, lastEventId = '9') { this.onmessage?.({ data: Buffer.from(bytes).toString('base64'), lastEventId }); }
  close() { this.closed = true; }
}

describe('public-envelope-02 original wire ingress boundaries', () => {
  it('uses valid signed public controls and an authenticated private control', () => {
    expect(verifyInboundEnvelope(post.bytes, { publicStream: true }).eventId).toBe(post.eventId);
    expect(verifyInboundEnvelope(profile.bytes, { publicStream: true }).eventId).toBe(profile.eventId);
    expect(verifyInboundEnvelope(privateDm.bytes, { recipientPopclawId: recipient }).eventId).toBe(privateDm.eventId);
  });

  it.each([
    ['invite_wait_request_house_helper', 'request', { verificationMode: 1 }],
    ['invite_wait_cancel_signed', 'request', { verificationMode: 1, cancelTaskId: '00000000-0000-4000-8000-000000000001' }],
    ['invite_wait_dispatch_signed', 'dispatch', { verificationMode: 1 }],
    ['invite_wait_ready_progress_signed', 'result', { verificationProgress: 2, progressRevision: '1' }],
  ] as const)('verifies the original signed %s wait envelope and retains its added fields', (name, payload, expected) => {
    const vector = publicBaselineVectors.signed.find(item => item.name === name)!;
    const raw = Buffer.from(vector.wire_hex, 'hex');
    const env = verifyInboundEnvelope(raw, { publicStream: true, isOfficialActor: () => true });
    expect(env.eventId).toBe(vector.cid);
    const actual = payload === 'request' ? env.inviteRequest : payload === 'dispatch' ? env.questDispatch?.verifyInvite : env.questResult;
    for (const [key, value] of Object.entries(expected)) {
      const received = (actual as Record<string, unknown> | undefined)?.[key];
      expect(key === 'progressRevision' ? String(received) : received).toEqual(value);
    }
  });

  it.each([['EventEnvelope 29', reservedBody, post.eventId], ['Profile 8', reservedProfile, profile.eventId]] as const)(
    'rejects raw %s even though lossy decoding recovers a valid signed envelope', (_name, raw, eventId) => {
      const lossy = publicProto.event.EventEnvelope.encode(publicProto.event.EventEnvelope.decode(raw)).finish();
      expect(verifyInboundEnvelope(lossy, { publicStream: true }).eventId).toBe(eventId);
      expect(() => decodeEnvelope(raw)).toThrow('RESERVED_OCCURRENCE');
      expect(() => verifyInboundEnvelope(raw, { publicStream: true })).toThrow('RESERVED_OCCURRENCE');
    });

  it.each([
    ['WorldFeedItem field 22', 'projection', hiddenItem, (raw: Uint8Array) => popclaw.event.WorldFeedItem.decode(raw).envelope],
    ['DiscoveryFrame field 2', 'discovery', hiddenDiscovery, (raw: Uint8Array) => popclaw.event.EventEnvelope.encode(popclaw.event.DiscoveryFrame.decode(raw).event!).finish()],
    ['WorldStreamFrame field 2', 'frame', hiddenFrame, (raw: Uint8Array) => popclaw.event.WorldStreamFrame.decode(raw).envelope],
  ] as const)('rejects %s hiding a reserved envelope before a valid last occurrence', (_name, shape, makeRaw, decodeLast) => {
    const raw = makeRaw(), before = new Uint8Array(raw);
    expect(verifyInboundEnvelope(decodeLast(raw), { publicStream: true }).eventId).toBe(post.eventId);
    expect(() => inspectPublicCarrier(raw, shape)).toThrow();
    expect(raw).toEqual(before);
  });

  it.each([
    ['private message', () => itemBytes(privateDm.bytes)],
    ['reserved body', () => itemBytes(reservedBody)],
    ['reserved profile member', () => itemBytes(reservedProfile)],
    ['hidden first envelope', hiddenItem],
  ] as const)('rejects an entire snapshot containing %s after a valid item', async (_name, unsafe) => {
    const raw = concat(field(1, itemBytes()), field(1, unsafe()));
    const fetch = vi.fn(async () => new Response(Buffer.from(raw), { status: 200 }));
    const client = new WorldFeedClient({ baseUrl: 'https://snapshot.invalid', fetch });
    await expect(client.fetchSnapshot({ limit: 2 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns a supported snapshot with the exact original envelope', async () => {
    const raw = field(1, itemBytes());
    const client = new WorldFeedClient({ baseUrl: 'https://snapshot.invalid', fetch: async () => new Response(Buffer.from(raw)) });
    const result = await client.fetchSnapshot({ limit: 1 });
    expect(result).toHaveLength(1); expect(new Uint8Array(result[0]!.envelope!)).toEqual(new Uint8Array(post.bytes));
  });

  it('closes the legacy projection stream before callback or later cursor delivery', () => {
    const onItem = vi.fn(), onError = vi.fn();
    const client = new WorldFeedStreamClient({ baseUrl: 'https://stream.invalid', onItem, onError, eventSourceCtor: RawEventSource });
    cleanup.push(() => client.stop()); client.start();
    const stream = RawEventSource.latest;
    stream.emit(hiddenItem(), '9'); stream.emit(itemBytes(), '10');
    expect(stream.closed).toBe(true); expect(onItem).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalled();
  });

  it('closes the legacy world stream without persisting or advancing across hidden wire', async () => {
    const db = new LocalHostDb(':memory:'); cleanup.push(() => db.close());
    const onContent = vi.fn(), client = new PublicWorldStreamClient({ baseUrl: 'https://world.invalid', db, onContent, eventSourceCtor: RawEventSource });
    cleanup.push(() => client.stop()); await client.start();
    const stream = RawEventSource.latest;
    stream.emit(hiddenFrame(), '9');
    stream.emit(popclaw.event.WorldStreamFrame.encode({ seq: 10, kind: 'post', envelope: post.bytes }).finish(), '10');
    expect(stream.closed).toBe(true); expect(client.cursor()).toBe(0);
    expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM world_stream')?.n).toBe(0);
    expect(onContent).not.toHaveBeenCalled();
  });

  it('closes discovery rather than verifying a re-encoded replacement and dispatching the next frame', async () => {
    const root = mkdtempSync(join(tmpdir(), 'public-discovery-boundary-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const host = new LocalHostAdapter({ dataRoot: root, logger: { info() {}, warn() {}, error() {} } }); cleanup.push(() => host.db.close());
    const handler = vi.fn(), ingress = new SseIngress({ baseUrl: 'https://discovery.invalid',
      eventSourceCtor: RawEventSource as unknown as SseIngressOptions['eventSourceCtor'] }, host);
    cleanup.push(() => ingress.stop()); await ingress.start(handler);
    const stream = RawEventSource.latest;
    stream.emit(hiddenDiscovery());
    expect(stream.closed).toBe(true);
    stream.emit(field(2, post.bytes));
    await Promise.resolve(); await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([['private DM', privateDm.bytes], ['reserved body', reservedBody], ['reserved Profile member', reservedProfile]] as const)(
    'rejects %s before writing a public cache row', async (_name, envelope) => {
      const { db, cache } = await cacheFixture();
      expect(() => cache.record(item(envelope))).toThrow();
      expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM world_feed')?.n).toBe(0);
    });

  it('validates the supplied raw cache carrier rather than trusting the separately supplied safe item', async () => {
    const { db, cache } = await cacheFixture();
    expect(() => cache.record(item(), hiddenItem())).toThrow();
    expect(db.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM world_feed')?.n).toBe(0);
  });

  it.each([
    ['unparseable protobuf', new Uint8Array([0xff])],
    ['missing original envelope', popclaw.event.WorldFeedItem.encode({ ...item(), envelope: undefined }).finish()],
    ['reserved envelope', itemBytes(reservedBody)],
    ['reserved Profile member', itemBytes(reservedProfile)],
    ['private payload', itemBytes(privateDm.bytes)],
    ['hidden first envelope', hiddenItem()],
  ] as const)('never falls back to stored textPreview when old cache raw contains %s', async (_name, raw) => {
    const { db, cache } = await cacheFixture();
    cache.record(item());
    expect(cache.recentForReading(1)[0]?.body).toBe('Signed public message');
    // Simulate an old on-disk row. No live admission helper can protect this read.
    db.execute('UPDATE world_feed SET raw=?', [raw]);
    for (const read of [() => cache.recent(1), () => cache.search('Unsafe', 1),
      () => cache.byAuthor(actor, 1), () => cache.byPlatform('popclaw', 1), () => cache.lookup('popclaw', post.eventId)]) {
      expect(read).toThrow();
    }
    // The bulk reading scans (the daily paper, the digest) drop the row and
    // count it instead of throwing — one unreadable row must not cost the whole
    // edition — but they still never surface the stored preview.
    expect(cache.recentForReading(1)).toEqual([]);
    expect(cache.authorFirstSeen().size).toBe(0);
    expect(db.queryOne<{ raw: Uint8Array }>('SELECT raw FROM world_feed')?.raw).toEqual(Buffer.from(raw));
  });
});
