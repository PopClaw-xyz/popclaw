/** Verified, bounded protected-journal reads shared by display and one-issue collection. No writes. */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { PublicDisplayCapture, PublicDisplayItem, PublicDisplaySource } from './public-feed-display.js';
import { verifyPublicStreamJournalSchema } from '../world/scoped-stream-journal.js';
import { decodePublicFrame, inspectPublicCarrier } from './public-stream-wire.js';
import { decodeEnvelopeBody, numberOrZero } from './feed-item-projection.js';

export interface PublicMaterialCapture extends PublicDisplayCapture {
  /** Durable non-secret participation, protected partition and trusted producer identity. */
  readonly authority: string;
}
/** A deferred SQLite snapshot works on both read-only and shared writable handles.
 * SAVEPOINT nests inside an existing transaction without taking a writer lock. */
export function readPublicJournalSnapshot<T>(db: HostDb, read: (db: HostDb) => T): T {
  db.execute('SAVEPOINT popclaw_public_journal_read');
  try {
    const result = read(db);
    db.execute('RELEASE popclaw_public_journal_read');
    return result;
  } catch (error) {
    db.execute('ROLLBACK TO popclaw_public_journal_read');
    db.execute('RELEASE popclaw_public_journal_read');
    throw error;
  }
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
export function readPublicJournal(db: HostDb, capture: PublicDisplayCapture, source: { origin: string; slug: string }, options: { ownProjection?: boolean; reference?: { eventId: string; sequence: string } } = {}): { items: PublicDisplayItem[]; status: PublicDisplaySource } {
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
       WHERE f.binding_id=? AND f.log_incarnation=? ${options.reference ? 'AND f.event_id=? AND f.seq=?' : ''} ${before === null ? '' : 'AND (length(f.seq) < ? OR (length(f.seq)=? AND f.seq COLLATE BINARY < ?))'}
       ORDER BY length(f.seq) DESC,f.seq COLLATE BINARY DESC LIMIT ?`,
      [binding, log, ...(options.reference ? [options.reference.eventId, options.reference.sequence] : []), ...(before === null ? [] : [before.length, before.length, before]), PAGE_SIZE]);
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
      const retainedProjection = options.ownProjection
        ? (verified.frame.projection ? popclaw.event.WorldFeedItem.encode(verified.frame.projection).finish() : null)
        : frame.projection_log === log ? frame.current_projection : null;
      if (retainedProjection) {
        if (!options.ownProjection && uint64(frame.projection_seq) !== frame.seq) throw new Error('PUBLIC_DISPLAY_PROJECTION_SEQUENCE_MISMATCH');
        inspectPublicCarrier(retainedProjection, 'projection', true);
        const projection = popclaw.event.WorldFeedItem.decode(retainedProjection);
        if (verified.frame.projection && !same(popclaw.event.WorldFeedItem.encode(verified.frame.projection).finish(), popclaw.event.WorldFeedItem.encode(projection).finish())) throw new Error('PUBLIC_DISPLAY_PROJECTION_CONFLICT');
        decodePublicFrame(popclaw.event.WorldStreamFrame.encode({ ...verified.frame, projection }).finish(), capture.producerPolicy);
        if (!projection.platform || !projection.platformPostId) throw new Error('PUBLIC_DISPLAY_PROJECTION_INVALID');
        item = { ...(options.ownProjection ? item : {}), ...projection, originalUrl: projection.origin?.url || projection.originalUrl || '' };
        relaySnapshot = true;
      }
      // Relay metadata cannot rename or merge signed content. Mirrors keep
      // their signed external source identity; native content uses its CID.
      const canonical = fallback(envelope, body);
      item = { ...item, platform: canonical.platform, platformPostId: canonical.platformPostId,
        ...(options.ownProjection && !time(item.platformPostCreatedAt) ? { platformPostCreatedAt: canonical.platformPostCreatedAt } : {}),
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
