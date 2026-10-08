import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { popclaw } from '@popclaw/contracts';
import { canonicalizeEnvelope } from '../../../src/protocol/public-envelope.js';
import { cidFromCanonical } from '@popclaw/algorithms';
import { LocalHostDb } from '../../../src/host/local-host-db.js';
import { PublicFeedDisplay, type PublicDisplayCapture } from '../../../src/ingress/public-feed-display.js';
import { preparePublicStreamJournal, PublicStreamJournal, EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST } from '../../../src/world/scoped-stream-journal.js';
import { readPublicJournal } from '../../../src/ingress/public-journal-reader.js';

const clean: Array<() => void> = [];
afterEach(() => { for (const close of clean.splice(0).reverse()) close(); });
const signer = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(54)), actor = bs58.encode(signer.publicKey);
function signed(body: popclaw.event.IEventEnvelope, timestamp = 100) {
  const e = { actor: { popclawId: actor, nickname: 'Local author' }, timestamp, ...body };
  const bytes = canonicalizeEnvelope(e), eventId = cidFromCanonical(bytes);
  return { eventId, raw: new Uint8Array(popclaw.event.EventEnvelope.encode({ ...e, eventId, signature: nacl.sign.detached(bytes, signer.secretKey) }).finish()) };
}
function fixture(log = 'log_display', highWater = '100') {
  const root = mkdtempSync(join(tmpdir(), 'public-display-')); clean.push(() => rmSync(root, { recursive: true, force: true }));
  const db = new LocalHostDb(join(root, 'journal.db')); clean.push(() => db.close());
  const capability = { house: { origin: 'https://display.invalid', houseKey: actor, incarnation: 'house_display' }, capabilityRevision: 'a'.repeat(64),
    publicStream: { endpoint: '/v1/world-stream' as const, mode: 'public-v1' as const, log_incarnation: log, envelope_baseline: 'public-envelope-01' as const, initial_public_scopes: [] } };
  const producerPolicy = { house: capability.house, capabilityRevision: capability.capabilityRevision, officialActorIds: [actor] };
  const options = { executionDb: db, capability, producerPolicy, selection: { fullPublic: true, scopes: [] }, consumerContracts: [], approvedConsumerMappingDigest: EMPTY_PUBLIC_CONSUMER_MAPPING_DIGEST };
  preparePublicStreamJournal(options);
  const journal = new PublicStreamJournal({ ...options, gate: { origin: capability.house.origin, signal: new AbortController().signal, isActive: () => true } });
  journal.activate();
  const boundary = popclaw.world.PublicStreamBoundary.fromObject({ logIncarnation: log, highWaterSeq: highWater, fullPublic: true });
  const generation = journal.begin(boundary, popclaw.world.PublicStreamBoundary.encode(boundary).finish(), journal.request());
  let current = true, history = false;
  const capture = (): PublicDisplayCapture => ({ executionDb: db, capability, producerPolicy, history,
    assertCurrent() { if (!current) throw new Error('DISPLAY_CAPTURE_CHANGED'); } });
  const display = new PublicFeedDisplay({ sources: () => [{ origin: capability.house.origin, slug: 'display', capture }] });
  function append(seq: number | string, event: ReturnType<typeof signed>, projection?: popclaw.event.IWorldFeedItem) {
    const envelope = popclaw.event.EventEnvelope.decode(event.raw);
    journal.append(generation, popclaw.event.WorldStreamFrame.encode(popclaw.event.WorldStreamFrame.fromObject({ seq, kind: envelope.houseEvent?.kind ?? envelope.body!, scopes: envelope.houseEvent?.publicScopes ?? [], envelope: event.raw, ...(projection ? { projection } : {}) })).finish());
  }
  function live() { const c = { phase: 'replay', publicThroughSeq: 100 }; journal.checkpoint(generation, c, popclaw.world.PublicStreamCheckpoint.encode(c).finish()); }
  return { db, capability, display, append, live, capture, setCurrent: (v: boolean) => { current = v; }, setHistory: (v: boolean) => { history = v; } };
}
function stored(db: LocalHostDb) {
  return db.queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(({ name }) => [name, db.queryAll(`SELECT * FROM ${name}`)]);
}

it.each(['intact', 'bad-signature', 'wrong-projection'] as const)('newspaper complete window reads and verifies evidence beyond the former 2048-frame scan: %s', mode => {
  const f = fixture('log_long_window', '2050');
  const tail = signed({ post: { blocks: [{ content: 'The oldest complete newspaper window item.' }] } }, 1);
  f.append(1, tail);
  for (let seq = 2; seq <= 2050; seq++) f.append(seq, signed({ post: { blocks: [{ content: 'Newer window item.' }] } }, seq));
  const source = { origin: f.capability.house.origin, slug: 'display' };
  const ordinary = readPublicJournal(f.db, f.capture(), source, { ownProjection: true });
  expect(ordinary.status.truncated).toBe(true);
  expect(ordinary.items.some(i => i.item.eventId === tail.eventId)).toBe(false);
  if (mode !== 'intact') {
    const row = f.db.queryOne<{ frame_bytes: Uint8Array }>("SELECT frame_bytes FROM world_public_frames_v1 WHERE seq='1'")!;
    const frame = popclaw.event.WorldStreamFrame.decode(row.frame_bytes);
    if (mode === 'bad-signature') {
      const envelope = popclaw.event.EventEnvelope.decode(frame.envelope!);
      envelope.signature![0] = envelope.signature![0]! ^ 255;
      frame.envelope = popclaw.event.EventEnvelope.encode(envelope).finish();
      f.db.execute('UPDATE world_public_events_v1 SET envelope=? WHERE event_id=?', [frame.envelope, tail.eventId]);
    } else frame.projection = { eventId: 'f'.repeat(64), platform: 'popclaw', platformPostId: tail.eventId };
    f.db.execute("UPDATE world_public_frames_v1 SET frame_bytes=? WHERE seq='1'", [popclaw.event.WorldStreamFrame.encode(frame).finish()]);
    expect(() => readPublicJournal(f.db, f.capture(), source, { ownProjection: true, completeWindow: true } as never)).toThrow();
    return;
  }
  const complete = readPublicJournal(f.db, f.capture(), source, { ownProjection: true, completeWindow: true } as never);
  expect(complete.items.some(i => i.item.eventId === tail.eventId)).toBe(true);
  expect(complete.status.truncated).toBe(false);
  // This fixture deliberately remains replaying: exhaustive local reads cannot claim remote coverage.
  expect(complete.status.incomplete).toBe(true);
}, 60000);
it('shows exact signed native content without projection and does not write any journal state', () => {
  const f = fixture(), event = signed({ post: { blocks: [{ content: 'Public text beyond old snapshots' }] } });
  f.append(1, event); f.live(); const before = stored(f.db);
  const result = f.display.read({ limit: 20 });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ body: 'Public text beyond old snapshots', relaySnapshot: false, item: { eventId: event.eventId, platformPostId: event.eventId, authorPopclawId: actor } });
  expect(result.items[0]!.item.envelope).toEqual(event.raw);
  expect(result.sources[0]).toMatchObject({ history: false, incomplete: false, unavailable: false });
  expect(f.display.search('beyond snapshots', 10).items).toHaveLength(1);
  expect(stored(f.db)).toEqual(before);
});
it('retains local history after logout and marks replay/gap as incomplete', () => {
  const f = fixture(); f.append(1, signed({ reply: { body: 'Already received reply', inReplyTo: { platform: 'popclaw', platformPostId: 'f'.repeat(64) } } }));
  expect(f.display.read({}).sources[0]!.incomplete).toBe(true);
  f.live(); f.setHistory(true);
  expect(f.display.read({})).toMatchObject({ items: [{ body: 'Already received reply' }], sources: [{ history: true, incomplete: false }] });
  f.db.execute("UPDATE world_public_cursors_v1 SET stale=1,gap_reason='retention'");
  expect(f.display.read({}).sources[0]!.incomplete).toBe(true);
});
it('does not use a previous log when current trusted observation rotates', () => {
  const f = fixture(); f.append(1, signed({ post: { blocks: [{ content: 'Old observation' }] } })); f.live();
  f.capability.publicStream.log_incarnation = 'log_new';
  expect(f.display.read({})).toMatchObject({ items: [], sources: [{ incomplete: true }] });
});
it('never presents a raw mirror signer as verified external author', () => {
  const f = fixture(); f.append(1, signed({ post: { blocks: [{ content: 'Mirrored text' }], origin: { platform: 'x', postId: 'external-1', url: 'https://x.invalid/post/1' } } }));
  const hit = f.display.read({}).items[0]!;
  expect(hit).toMatchObject({ mirrorSigner: true, relaySnapshot: false, item: { platform: 'x', platformPostId: 'external-1', authorPopclawId: actor, originalUrl: 'https://x.invalid/post/1' } });
  expect(hit.item.actorVerified).toBeUndefined(); expect(hit.item.markCount).toBeUndefined();
});
it('uses checked same-log projection as a dated relay observation and retains signed body', () => {
  const f = fixture(), e = signed({ post: { blocks: [{ content: 'Signed full body' }] } });
  f.append(1, e, { eventId: e.eventId, platform: 'popclaw', platformPostId: e.eventId, textPreview: 'Relay preview', authorPopclawId: actor, actorNickname: 'Observed name', markCount: 3 });
  const hit = f.display.read({}).items[0]!;
  expect(hit).toMatchObject({ body: 'Signed full body', relaySnapshot: true, item: { actorNickname: 'Observed name' } });
  expect(Number(hit.item.markCount)).toBe(3);
  expect(hit.source.observedAt).toBeTypeOf('number');
  f.db.execute("UPDATE world_public_events_v1 SET projection_log='old_log'");
  const raw = f.display.read({}).items[0]!;
  expect(raw.relaySnapshot).toBe(false); expect(raw.item.markCount).toBeUndefined();
});
it('rejects changed capture and corrupt protected evidence instead of falling back', () => {
  const f = fixture(), e = signed({ post: { blocks: [{ content: 'Visible only while trusted' }] } }); f.append(1, e);
  f.setCurrent(false); expect(f.display.read({})).toMatchObject({ items: [], sources: [{ unavailable: true }] });
  f.setCurrent(true); f.db.execute("UPDATE world_public_events_v1 SET envelope=x'00'");
  expect(f.display.read({})).toMatchObject({ items: [], sources: [{ unavailable: true }] });
});
it('rechecks capture after the consistent read and discards all rows on invalidation', () => {
  const f = fixture(); f.append(1, signed({ post: { blocks: [{ content: 'Late trust change' }] } }));
  let checks = 0;
  const display = new PublicFeedDisplay({ sources: () => [{ origin: f.capability.house.origin, slug: 'display', capture: () => ({ ...f.capture(), assertCurrent() { if (++checks > 1) throw new Error('CHANGED'); } }) }] });
  expect(display.read({})).toMatchObject({ items: [], sources: [{ unavailable: true }] });
});
it('filters before limit and reports truncation without claiming exhaustive search', () => {
  const f = fixture();
  for (let seq = 1; seq <= 3; seq++) f.append(seq, signed({ post: { blocks: [{ content: `Entry ${seq}` }] } }, seq));
  expect(f.display.read({ limit: 1 })).toMatchObject({ items: [{ body: 'Entry 3' }], truncated: true });
  expect(f.display.search('Entry 1', 1)).toMatchObject({ items: [{ body: 'Entry 1' }], truncated: false });
});
it('does not expose an event without matching current-lane association', () => {
  const f = fixture(); f.append(1, signed({ post: { blocks: [{ content: 'No lane membership' }] } }));
  f.db.execute('DELETE FROM world_public_associations_v1');
  expect(f.display.read({}).items).toEqual([]);
});
it('retains signed media and rejects a same-log projection with inconsistent sequence', () => {
  const f = fixture(), e = signed({ post: { blocks: [{ content: 'Repeated signed text' }], media: [{ url: 'https://media.invalid/image.png' }] } });
  f.append(1, e, { eventId: e.eventId, platform: 'popclaw', platformPostId: e.eventId, authorPopclawId: actor });
  f.live();
  const result = f.display.read();
  expect(result.items).toHaveLength(1); expect(result.sources[0]!.unavailable).toBe(false);
  expect(result.items[0]).toMatchObject({ relaySnapshot: true, media: [{ url: 'https://media.invalid/image.png' }], source: { sequence: '1' } });
  f.db.execute("UPDATE world_public_events_v1 SET projection_seq='2'");
  expect(f.display.read()).toMatchObject({ items: [], sources: [{ unavailable: true }] });
});
it('deduplicates checked native events across sources while retaining secondary attribution', () => {
  const f = fixture(), g = fixture(), e = signed({ post: { blocks: [{ content: 'Shared event' }] } });
  f.append(1, e); g.append(1, e);
  const display = new PublicFeedDisplay({ sources: () => [
    { origin: f.capability.house.origin, slug: 'first', capture: f.capture },
    { origin: g.capability.house.origin, slug: 'second', capture: g.capture },
  ] });
  expect(display.read()).toMatchObject({ items: [{ body: 'Shared event', alsoInHouses: ['second'] }] });
  expect(display.read().items).toHaveLength(1);
});

it('pages beyond 32 frames using exact uint64 order before filtering and final limit', () => {
  const f = fixture('large_sequence_log', '18446744073709551615');
  for (let offset = 0; offset < 40; offset++) f.append((18446744073709551575n + BigInt(offset)).toString(),
    signed({ post: { blocks: [{ content: `Paged content [${offset}]` }] } }, offset + 1));
  const before = stored(f.db), result = f.display.search('content [0]', 1);
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ body: 'Paged content [0]', source: { sequence: '18446744073709551575' } });
  expect(result.truncated).toBe(false); expect(stored(f.db)).toEqual(before);
});
it('keeps opaque or deeply nested signed HouseEvents visible without failing other content', () => {
  const f = fixture();
  const deep = new TextEncoder().encode('{"x":'.repeat(6000) + '1' + '}'.repeat(6000));
  f.append(1, signed({ houseEvent: { kind: 'custom.notice', body: new TextEncoder().encode('opaque bytes') } }));
  f.append(2, signed({ houseEvent: { kind: 'custom.notice', body: deep } }));
  f.append(3, signed({ post: { blocks: [{ content: 'Ordinary content stays readable' }] } }));
  const result = f.display.read();
  expect(result.sources[0]!.unavailable).toBe(false); expect(result.items).toHaveLength(3);
  expect(result.items.filter(hit => hit.kind === 'custom.notice')).toEqual([
    expect.objectContaining({ bodyUnavailable: true }), expect.objectContaining({ bodyUnavailable: true }),
  ]);
});
it('derives native identity and deduplication from signed event IDs despite shared short relay identifiers', () => {
  const f = fixture();
  const events = [1, 2].map(n => signed({ post: { blocks: [{ content: `Native event ${n}` }] } }, n));
  events.forEach((e, index) => f.append(index + 1, e, { eventId: e.eventId, platform: 'popclaw', platformPostId: 'short-id' }));
  const result = f.display.read();
  expect(result.items).toHaveLength(2);
  expect(result.items.map(hit => hit.item.platformPostId).sort()).toEqual(events.map(e => e.eventId).sort());
  expect(result.items.every(hit => hit.item.platform === 'popclaw')).toBe(true);
});
it('retains signed mirror source identity even when observed relay metadata names another platform or ID', () => {
  const f = fixture(), e = signed({ post: { origin: { platform: 'x', postId: 'signed-external-id', url: 'https://source.invalid/original' }, blocks: [{ content: 'Shared content' }] } });
  f.append(1, e, { eventId: e.eventId, platform: 'popclaw', platformPostId: 'wrong-relay-id', originalUrl: 'https://metadata.invalid/other' });
  expect(f.display.read().items[0]!.item).toMatchObject({ platform: 'x', platformPostId: 'signed-external-id', originalUrl: 'https://source.invalid/original' });
});
it('rechecks earlier House captures at final merge and removes revoked content and attribution', () => {
  const f = fixture(), g = fixture(), e = signed({ post: { blocks: [{ content: 'Shared checked content' }] } });
  f.append(1, e); g.append(1, e);
  const display = new PublicFeedDisplay({ sources: () => [
    { origin: f.capability.house.origin, slug: 'first', capture: f.capture },
    { origin: g.capability.house.origin, slug: 'second', capture: () => { f.setCurrent(false); return g.capture(); } },
  ] });
  const result = display.read();
  expect(result.sources[0]!.unavailable).toBe(true);
  expect(result.items).toHaveLength(1); expect(result.items[0]!.source.slug).toBe('second');
  expect(result.items[0]!.alsoInHouses).toBeUndefined();
});
it('does not substitute relay preview for an empty signed body', () => {
  const f = fixture(), e = signed({ post: { media: [{ url: 'https://media.invalid/only.png' }] } });
  f.append(1, e, { eventId: e.eventId, platform: 'popclaw', platformPostId: e.eventId, textPreview: 'Relay-only text' });
  expect(f.display.read().items[0]).toMatchObject({ body: '', media: [{ url: 'https://media.invalid/only.png' }] });
});
