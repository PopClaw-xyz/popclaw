/** Local public display only: no receiver, cache writer or business consumer. */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { VerifiedPublicStreamCapability } from '../world/world-capabilities.js';
import { verifyPublicStreamJournalSchema, type VerifiedPublicProducerPolicy } from '../world/scoped-stream-journal.js';
import { decodePublicFrame, inspectPublicCarrier } from './public-stream-wire.js';
import { decodeEnvelopeBody, numberOrZero } from './feed-item-projection.js';
import type { WorldFeedQuery } from './world-feed-client.js';

export interface PublicDisplayCapture {
  readonly executionDb: HostDb;
  readonly capability: VerifiedPublicStreamCapability;
  readonly producerPolicy: VerifiedPublicProducerPolicy;
  readonly history: boolean;
  assertCurrent(): void;
}
export interface PublicDisplaySource {
  readonly origin: string;
  readonly slug: string;
  readonly capabilityRevision: string;
  readonly logIncarnation: string;
  readonly history: boolean;
  readonly incomplete: boolean;
  readonly unavailable: boolean;
  readonly truncated: boolean;
  readonly observedAt: number | null;
  readonly code?: string;
}
export interface PublicDisplayItem {
  readonly item: popclaw.event.IWorldFeedItem;
  readonly body: string;
  readonly kind: string;
  readonly media?: readonly { kind: string; url: string }[];
  readonly bodyUnavailable?: boolean;
  readonly relaySnapshot: boolean;
  readonly mirrorSigner: boolean;
  readonly source: { readonly origin: string; readonly slug: string; readonly observedAt: number; readonly sequence: string; readonly logIncarnation: string };
  readonly alsoInHouses?: readonly string[];
}
export interface PublicDisplayResult {
  readonly items: readonly PublicDisplayItem[];
  readonly sources: readonly PublicDisplaySource[];
  readonly truncated: boolean;
}
export interface PublicDisplayQuery extends WorldFeedQuery { readonly includeThreads?: boolean }
export interface PublicFeedDisplayOptions {
  sources(): readonly { origin: string; slug: string; capture(): PublicDisplayCapture }[];
}
interface FrameRow {
  seq: string; event_id: string; frame_bytes: Uint8Array; observed_at: number; envelope: Uint8Array;
  current_projection: Uint8Array | null; projection_log: string | null; projection_seq: string | null;
}
const PAGE_SIZE = 32;
const MAX_FRAMES = 2048;
const MAX_BYTES = 8 * 1024 * 1024;
function uint64(value: unknown): string {
  const text = String(value);
  if (!/^(0|[1-9][0-9]{0,19})$/.test(text) || BigInt(text) > 18446744073709551615n) throw new Error('PUBLIC_DISPLAY_SEQUENCE_INVALID');
  return text;
}
function same(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((value, i) => value === b[i]); }
function time(value: unknown): number {
  const n = numberOrZero(value);
  return Number.isSafeInteger(n) && n >= 0 && n <= 253402300799 ? n : 0;
}
function fallback(envelope: popclaw.event.EventEnvelope, body: string): popclaw.event.IWorldFeedItem {
  const origin = envelope.post?.origin;
  const reply = envelope.reply?.inReplyTo;
  return {
    eventId: envelope.eventId, platform: origin?.platform || 'popclaw', platformPostId: origin?.postId || envelope.eventId,
    platformPostCreatedAt: origin ? time(origin.createdAt) : time(envelope.timestamp),
    authorPopclawId: envelope.actor?.popclawId ?? '', actorNickname: envelope.actor?.nickname ?? '',
    textPreview: body.slice(0, 280), originalUrl: origin?.url ?? '', ...(origin ? { origin } : {}),
    ...(reply ? { replyToPlatform: reply.platform, replyToPostId: reply.platformPostId, replyToAuthorPopclawId: reply.authorPopclawId } : {}),
  };
}

/** The shared field renderer is recursive. Opaque signed bodies are valid
 * events, but only small, shallow JSON objects enter that presentation helper. */
function canPresentHouseBody(body: Uint8Array | null | undefined): boolean {
  if (!body?.length || body.length > 65_536) return false;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const pending: Array<{ value: unknown; depth: number }> = [{ value: parsed, depth: 0 }];
    let visited = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      if (++visited > 2048 || depth > 32) return false;
      if (value && typeof value === 'object') {
        const children = Object.values(value);
        if (visited + pending.length + children.length > 2048) return false;
        for (const child of children) pending.push({ value: child, depth: depth + 1 });
      }
    }
    return true;
  } catch { return false; }
}
function unavailable(source: { origin: string; slug: string }, capture: PublicDisplayCapture | undefined, error: unknown): PublicDisplaySource {
  return { origin: source.origin, slug: source.slug, capabilityRevision: capture?.capability.capabilityRevision ?? '',
    logIncarnation: capture?.capability.publicStream.log_incarnation ?? '', history: capture?.history ?? true,
    incomplete: true, unavailable: true, truncated: false, observedAt: null,
    code: error instanceof Error ? error.message : 'PUBLIC_DISPLAY_UNAVAILABLE' };
}

/** Every query owns its result. The sources callback follows later mounts but
 * never opens a house itself or borrows the global catalog's snapshot path. */
export class PublicFeedDisplay {
  constructor(private readonly options: PublicFeedDisplayOptions) {}
  read(query: PublicDisplayQuery = {}): PublicDisplayResult { return this.query(query); }
  search(query: string, limit = 10): PublicDisplayResult { return this.query({ limit }, query); }

  private query(query: PublicDisplayQuery, search?: string): PublicDisplayResult {
    const limit = Number.isSafeInteger(query.limit) && query.limit! > 0 ? Math.min(query.limit!, 100) : 20;
    const sources: PublicDisplaySource[] = [], merged = new Map<string, PublicDisplayItem>();
    const houses: Array<{ source: { origin: string; slug: string }; capture?: PublicDisplayCapture;
      status: PublicDisplaySource; items: PublicDisplayItem[] }> = [];
    const terms = (search ?? '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    for (const source of this.options.sources()) {
      let capture: PublicDisplayCapture | undefined;
      try {
        capture = source.capture();
        if (capture.capability.house.origin !== source.origin || capture.producerPolicy.house.origin !== source.origin
          || capture.producerPolicy.house.houseKey !== capture.capability.house.houseKey
          || capture.producerPolicy.house.incarnation !== capture.capability.house.incarnation
          || capture.producerPolicy.capabilityRevision !== capture.capability.capabilityRevision) throw new Error('PUBLIC_DISPLAY_CAPTURE_MISMATCH');
        capture.assertCurrent();
        const captured = capture;
        const result = captured.executionDb.transaction(tx => this.readHouse(tx, captured, source));
        captured.assertCurrent();
        houses.push({ source, capture, ...result });
      } catch (error) {
        houses.push({ source, status: unavailable(source, capture, error), items: [] });
      }
    }
    // A later House may take time to scan. Recheck every earlier capture at
    // publication, before deduplication can retain its body or attribution.
    for (const house of houses) {
      if (house.capture) {
        try { house.capture.assertCurrent(); }
        catch (error) { house.status = unavailable(house.source, house.capture, error); house.items = []; }
      }
      sources.push(house.status);
      for (const hit of house.items) {
        const item = hit.item;
        if (query.includeThreads === false && item.replyToPostId && !item.quotedEventId) continue;
        if (query.author && item.authorPopclawId !== query.author) continue;
        if (query.platform && item.platform !== query.platform) continue;
        const text = [hit.kind, hit.body, item.textPreview, item.handle, item.actorNickname, item.originalUrl, item.origin?.url].join(' ').toLocaleLowerCase();
        if (terms.some(term => !text.includes(term))) continue;
        const id = item.eventId!;
        const first = merged.get(id);
        if (first) merged.set(id, { ...first, alsoInHouses: [...(first.alsoInHouses ?? []), house.source.slug] });
        else merged.set(id, hit);
      }
    }
    const items = [...merged.values()].sort((a, b) => time(b.item.platformPostCreatedAt) - time(a.item.platformPostCreatedAt)
      || String(a.item.platformPostId).localeCompare(String(b.item.platformPostId)));
    return { items: items.slice(0, limit), sources, truncated: items.length > limit || sources.some(source => source.truncated) };
  }

  private readHouse(db: HostDb, capture: PublicDisplayCapture, source: { origin: string; slug: string }): { items: PublicDisplayItem[]; status: PublicDisplaySource } {
    verifyPublicStreamJournalSchema(db);
    const capability = capture.capability, log = capability.publicStream.log_incarnation;
    const binding = JSON.stringify([capability.house.origin, capability.house.houseKey, capability.house.incarnation]);
    const row = db.queryOne<{ active_log: string; capability_revision: string; selection_json: string; phase: string }>(
      'SELECT active_log,capability_revision,selection_json,phase FROM world_public_bindings_v1 WHERE binding_id=?', [binding]);
    const status = { origin: source.origin, slug: source.slug, capabilityRevision: capability.capabilityRevision, logIncarnation: log,
      history: capture.history, incomplete: true, unavailable: false, truncated: false, observedAt: null as number | null };
    if (!row || row.active_log !== log || row.capability_revision !== capability.capabilityRevision) return { items: [], status };
    const selection = JSON.parse(row.selection_json) as { fullPublic: boolean; scopes: string[] };
    if (!selection || typeof selection.fullPublic !== 'boolean' || !Array.isArray(selection.scopes) || selection.scopes.length > 32
      || selection.scopes.some(scope => typeof scope !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(scope))
      || new Set(selection.scopes).size !== selection.scopes.length) throw new Error('PUBLIC_DISPLAY_SELECTION_INVALID');
    const cursors = db.queryAll<{ lane: string; scope_id: string; stale: number; after_seq: string }>(
      'SELECT lane,scope_id,stale,after_seq FROM world_public_cursors_v1 WHERE binding_id=? AND log_incarnation=?', [binding, log]);
    const lanes = [{ lane: 'public', scope: '', selected: selection.fullPublic }, ...selection.scopes.map(scope => ({ lane: 'scope', scope, selected: true }))].filter(lane => lane.selected);
    status.incomplete = row.phase !== 'live' || lanes.some(lane => {
      const cursor = cursors.find(cursor => cursor.lane === lane.lane && cursor.scope_id === lane.scope);
      if (cursor) uint64(cursor.after_seq);
      return !cursor || cursor.stale !== 0;
    });
    const newest = new Map<string, PublicDisplayItem>();
    let before: string | null = null, scanned = 0, bytes = 0, finished = false;
    while (!finished && scanned < MAX_FRAMES && bytes < MAX_BYTES) {
      const page: FrameRow[] = db.queryAll<FrameRow>(
        `SELECT f.seq,f.event_id,f.frame_bytes,f.observed_at,e.envelope,e.current_projection,e.projection_log,e.projection_seq
         FROM world_public_frames_v1 f JOIN world_public_events_v1 e USING(binding_id,event_id)
         WHERE f.binding_id=? AND f.log_incarnation=? ${before === null ? '' : 'AND (length(f.seq) < ? OR (length(f.seq)=? AND f.seq COLLATE BINARY < ?))'}
         ORDER BY length(f.seq) DESC,f.seq COLLATE BINARY DESC LIMIT ?`,
        [binding, log, ...(before === null ? [] : [before.length, before.length, before]), PAGE_SIZE]);
      if (!page.length) { finished = true; break; }
      for (const frame of page) {
        if (scanned >= MAX_FRAMES || bytes + frame.frame_bytes.length + frame.envelope.length > MAX_BYTES) { status.truncated = true; finished = true; break; }
        scanned++; bytes += frame.frame_bytes.length + frame.envelope.length;
        before = uint64(frame.seq);
        const memberships = db.queryAll<{ lane: string; scope_id: string }>(
          'SELECT lane,scope_id FROM world_public_associations_v1 WHERE binding_id=? AND log_incarnation=? AND seq=? AND event_id=?', [binding, log, frame.seq, frame.event_id]);
        const selected = memberships.filter(member => lanes.some(lane => lane.lane === member.lane && lane.scope === member.scope_id));
        if (!selected.length) continue;
        const verified = decodePublicFrame(new Uint8Array(frame.frame_bytes), capture.producerPolicy);
        if (verified.eventId !== frame.event_id || uint64(verified.frame.seq) !== frame.seq || !same(new Uint8Array(verified.frame.envelope), new Uint8Array(frame.envelope))
          || selected.some(member => member.lane === 'scope' && !verified.publicScopes.includes(member.scope_id))) throw new Error('PUBLIC_DISPLAY_FRAME_CONFLICT');
        if (!Number.isSafeInteger(frame.observed_at) || frame.observed_at < 0 || frame.observed_at > 253402300799) throw new Error('PUBLIC_DISPLAY_OBSERVATION_INVALID');
        status.observedAt = Math.max(status.observedAt ?? 0, frame.observed_at);
        const envelope = verified.envelope;
        if (!envelope.post && !envelope.reply && !envelope.houseEvent) continue;
        let decoded: ReturnType<typeof decodeEnvelopeBody> = null;
        if (!envelope.houseEvent || canPresentHouseBody(envelope.houseEvent.body)) {
          try { decoded = decodeEnvelopeBody(new Uint8Array(frame.envelope)); }
          catch (error) { if (!envelope.houseEvent) throw error; }
        }
        const bodyUnavailable = !!envelope.houseEvent && !decoded?.fields;
        const body = decoded?.text || (decoded?.fields ? Object.entries(decoded.fields).map(([key, value]) => `${key}: ${value}`).join('\n') : '');
        let item = fallback(envelope, body), relaySnapshot = false;
        if (frame.current_projection && frame.projection_log === log) {
          if (uint64(frame.projection_seq) !== frame.seq) throw new Error('PUBLIC_DISPLAY_PROJECTION_SEQUENCE_MISMATCH');
          inspectPublicCarrier(frame.current_projection, 'projection', true);
          const projection = popclaw.event.WorldFeedItem.decode(frame.current_projection);
          if (verified.frame.projection && !same(popclaw.event.WorldFeedItem.encode(verified.frame.projection).finish(), popclaw.event.WorldFeedItem.encode(projection).finish())) throw new Error('PUBLIC_DISPLAY_PROJECTION_CONFLICT');
          decodePublicFrame(popclaw.event.WorldStreamFrame.encode({ ...verified.frame, projection }).finish(), capture.producerPolicy);
          if (!projection.platform || !projection.platformPostId) throw new Error('PUBLIC_DISPLAY_PROJECTION_INVALID');
          item = { ...projection, originalUrl: projection.origin?.url || projection.originalUrl || '' };
          relaySnapshot = true;
        }
        // Relay metadata cannot rename or merge signed content. Mirrors keep
        // their signed external source identity; native content uses its CID.
        const canonical = fallback(envelope, body);
        item = { ...item, platform: canonical.platform, platformPostId: canonical.platformPostId,
          ...(envelope.post?.origin ? { origin: envelope.post.origin, originalUrl: envelope.post.origin.url ?? '' } : {}),
          eventId: envelope.eventId, envelope: new Uint8Array(frame.envelope) };
        const id = JSON.stringify([item.platform, item.platformPostId]);
        // Descending sequence chooses the newest checked source observation for
        // this content key; older frames never overwrite it by arrival time.
        if (!newest.has(id)) newest.set(id, { item, body, kind: verified.kind,
          relaySnapshot, bodyUnavailable, media: decoded?.media ?? [], mirrorSigner: !!envelope.post?.origin && !relaySnapshot,
          source: { origin: source.origin, slug: source.slug, observedAt: frame.observed_at, sequence: frame.seq, logIncarnation: log } });
      }
      if (page.length < PAGE_SIZE) finished = true;
    }
    if (!finished) status.truncated = true;
    if (status.truncated) status.incomplete = true;
    return { items: [...newest.values()], status };
  }
}
