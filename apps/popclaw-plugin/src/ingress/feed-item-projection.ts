/** Feed carrier decoding and single-row projection; no storage or scan policy. */
import { popclaw } from '@popclaw/contracts';
import { checkPublicEnvelopeStructure, decodeEnvelope } from '../protocol/public-envelope.js';
import { langOf, ownerLangTag } from '../lexicon/owner-language.js';
import { inspectPublicCarrier } from './public-stream-wire.js';

/**
 * Plain-object form of `popclaw.event.IWorldFeedItem` with all fields
 * normalised to JS primitives so the cache's external surface doesn't
 * leak protobuf null/undefined ambiguity to callers.
 */
export interface CachedFeedItem {
  platform: string;
  platformPostId: string;
  /**
   * ADR-0019 — the lore-house-assigned event_id (WorldFeedItem field 19).
   * '' (empty string) for items that arrived without one — never treated as a
   * discard condition.
   */
  eventId: string;
  platformPostCreatedAt: number;     // seconds since epoch
  authorPopclawId: string;
  handle: string;
  originalUrl: string;
  textPreview: string;
  /**
   * when this cached item is a popclaw-native Reply, these
   * fields identify the post being replied to. Empty strings for normal
   * posts. Recommend cycle / digest renderer can use them to thread
   * "@<author> replied to @<original-author>'s post".
   */
  replyToPlatform?: string;
  replyToPostId?: string;
  replyToAuthorPopclawId?: string;
  /**
   * Spec B slice② — source house slug. Per-house db ownership is inherently
   * self-tagging (one house, one <slug>.db), so this isn't a column and never
   * goes in the table: `WorldFeedCatalog` tags it on when reading. Reading
   * with a standalone `WorldFeedCache` (the SSE-callback side) leaves it undefined.
   */
  houseSlug?: string;
  /** The same event_id has also shown up in these houses (relay scenario). Only appears on cross-house id collisions. */
  alsoInHouses?: string[];
}

export interface MediaRef { kind: 'image' | 'video' | 'gif'; url: string; }

/** A subset of the author's verified platform bindings, baked at ingest into
 * WorldFeedItem.actor_verified. Drives the newspaper author header (real profile
 * link + follower count) and the avatar (handle → unavatar). */
export interface VerifiedRef {
  platform: string;       // 'x' / 'youtube' / 'instagram' / 'github' / ...
  handle: string;         // platform-native handle, no '@'
  profileUrl: string;     // derived platform profile URL, '' if unmapped
  followerCount: number;  // snapshot at verification day; 0 = unknown
}

/** A cached item decoded for READING: full original body + media from the relayed
 * envelope (ADR-0029), plus the relay-index + author-identity fields that live on
 * the outer WorldFeedItem. Use for LLM-facing consumers (newspaper / recommend);
 * the zero-decode display path stays on recent()/byAuthor(). */
export interface ReadableFeedItem extends CachedFeedItem {
  body: string;            // full original; falls back to textPreview for legacy/over-cap rows
  media: MediaRef[];
  replyToAuthorHandle: string;
  replyCount: number;
  markCount: number;
  actorNickname: string;       // envelope.actor.nickname projection ('' if none)
  actorVerified: VerifiedRef[]; // author's verified platforms (profile link + followers)
  /** The field table flattened out of a house event's (HouseEvent) body, with
   *  key names copied verbatim from the JSON Schema the house itself published
   *  in its manifest (`place_name` / `figure.figure_name` / `present.1.owner_popclaw_id`…).
   *  **Carried through, never interpreted**: unrecognized keys are still
   *  included as-is; whether to translate or reorder them is a rendering
   *  decision. Non-house-event / non-JSON body → undefined (behaves exactly
   *  as it would without this field at all). */
  houseFields?: Record<string, string>;
  /** The oneof member name of the envelope body ('post' / 'reply' / …); a
   *  member the local proto doesn't recognize → `unknown:<field number>`; no
   *  envelope → ''. Spec B slice②: cross-house consumption must tolerate
   *  other houses' vocabularies — unrecognized events are still cached, still
   *  tagged with a kind, and left to the agent to interpret via the manifest. */
  kind: string;
}

const MEDIA_KIND: Record<number, MediaRef['kind']> = { 0: 'image', 1: 'video', 2: 'gif' };

/** Max number of fields a house event can flatten out to / max length per
 *  value. A house's self-reported body is external input — being able to
 *  carry it doesn't mean carrying all of it: one event must not eat up an
 *  entire daily paper's material budget. */
const HOUSE_FIELDS_MAX = 12;
const HOUSE_VALUE_MAX = 120;
/** The language-key shape of langtext (`{"zh":"…","en":"…"}`), copied verbatim from the house manifest's JSON Schema. */
const LANG_KEY_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

function isLangText(o: Record<string, unknown>): boolean {
  const keys = Object.keys(o);
  return keys.length > 0 && keys.every((k) => LANG_KEY_RE.test(k) && typeof o[k] === 'string');
}

/** langtext → the entry in the owner's language; if there isn't one, take the first entry and label it with its language code (never pretend it's in the owner's language). */
function pickLangText(o: Record<string, unknown>, langTag: string): string {
  const keys = Object.keys(o);
  const lang = langTag.toLowerCase();
  const hit =
    keys.find((k) => k.toLowerCase() === lang) ??
    keys.find((k) => k.toLowerCase().split('-')[0] === lang.split('-')[0]);
  if (hit) return String(o[hit]);
  const first = keys[0]!;
  return langOf(langTag) === 'zh-CN' ? `${String(o[first])}（${first}）` : `${String(o[first])} (${first})`;
}

/**
 * A house event's body (JSON) → a flat table of `path = value`.
 *
 * A house inlines a JSON Schema for each kind on its own manifest — that's
 * the house's **public commitment** to what each field means, so this
 * function only carries the data through: key names copied verbatim, nesting
 * joined with `.` (arrays get 1-based indices), langtext takes the entry in
 * the owner's language. **Not a single field is inferred**: unrecognized keys
 * are still spread out as-is; whether to translate or order them is a
 * rendering decision.
 *
 * Non-JSON / non-object / empty body → null, and the caller falls back to today's behavior (kind only).
 */
export function houseBodyFields(
  bodyBytes: Uint8Array | null | undefined,
  langTag: string,
): Record<string, string> | null {
  if (!bodyBytes || bodyBytes.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bodyBytes).toString('utf8'));
  } catch {
    return null; // the house's body isn't JSON (or is bad bytes) → degrade silently, never let this event blow up
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  const walk = (v: unknown, path: string): void => {
    if (Object.keys(out).length >= HOUSE_FIELDS_MAX) return;
    if (v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const s = String(v).trim();
      if (path && s) out[path] = s.length > HOUSE_VALUE_MAX ? `${s.slice(0, HOUSE_VALUE_MAX)}…` : s;
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((e, i) => walk(e, `${path}.${i + 1}`));
      return;
    }
    const o = v as Record<string, unknown>;
    if (path && isLangText(o)) {
      out[path] = pickLangText(o, langTag);
      return;
    }
    for (const [k, val] of Object.entries(o)) walk(val, path ? `${path}.${k}` : k);
  };
  walk(parsed, '');
  return Object.keys(out).length ? out : null;
}

/** Decode the relayed EventEnvelope (WorldFeedItem.envelope) → body text + media
 * (+ a house event's own JSON fields). Returns null when there's no envelope
 * (legacy rows / over-cap omission) or the body carries nothing we can read. */
export function decodeEnvelopeBody(
  envelopeBytes: Uint8Array,
): { text: string; media: MediaRef[]; fields?: Record<string, string> } | null {
  if (!envelopeBytes || envelopeBytes.length === 0) return null;
  checkPublicEnvelopeStructure(envelopeBytes);
  let env: popclaw.event.IEventEnvelope;
  try {
    env = decodeEnvelope(envelopeBytes);
  } catch {
    return null;
  }
  if (env.post) {
    const text = (env.post.blocks ?? [])
      .filter((b) => (b.blockType ?? 0) === 0) // ContentBlock.TEXT
      .map((b) => b.content ?? '')
      .join('\n')
      .trim();
    const media: MediaRef[] = (env.post.media ?? [])
      .map((m) => ({ kind: MEDIA_KIND[m.kind ?? 0] ?? 'image', url: m.url ?? '' }))
      .filter((m) => m.url);
    return { text, media };
  }
  if (env.reply) return { text: env.reply.body ?? '', media: [] };
  // House event: there's no body text elsewhere (this kind of event has no "utterance") — all the substance is in the body's JSON fields.
  if (env.houseEvent) {
    const fields = houseBodyFields(env.houseEvent.body as Uint8Array | undefined, ownerLangTag());
    return fields ? { text: '', media: [], fields } : null;
  }
  return null;
}

/**
 * EventEnvelope body-oneof field number → kind name. Fields 1..7 are the
 * envelope header (event_id / actor / … / prev_event_id), 10 is the retired
 * feed field, and ≥11 is always a body oneof member.
 * A ≥11 field not in this table = an event this version of the proto doesn't
 * recognize (another house's vocabulary / a future extension slot).
 */
const ENVELOPE_KINDS: Record<number, string> = {
  11: 'invite_request', 12: 'quest_dispatch', 13: 'quest_result', 14: 'invite_verified',
  15: 'ranger_registration', 16: 'watch_dispatch', 17: 'watch_heartbeat', 18: 'watch_cancel',
  20: 'follow_declared', 21: 'follow_revoked', 25: 'reply', 26: 'direct_message',
  27: 'post', 28: 'profile', 29: 'red_packet', 30: 'mark', 31: 'mark_revoked',
  32: 'poll_dispatch', 33: 'poll_report', 34: 'house_event', 35: 'intent',
};
const BODY_FIELD_MIN = 11;
/** HouseEvent's (extension slot, #188) field number. Its kind lives in the body, not in the field number. */
const HOUSE_EVENT_FIELD = 34;

/** Read one varint; unable to read to completion / overlong → null (bad bytes are always treated as end-of-buffer, never throw). */
function readVarint(buf: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  for (let i = at; i < buf.length && i - at < 10; i++) {
    const b = buf[i]!;
    value += (b & 0x7f) * scale;
    if ((b & 0x80) === 0) return { value, next: i + 1 };
    scale *= 128;
  }
  return null;
}

/**
 * envelope bytes → kind identifier, independent of whether the generated code
 * recognizes this member. Hand-written top-level-field varint walk: protobufjs's
 * decode() just skips unknown fields, so it never surfaces the field number —
 * and the field number is precisely the unique identity of "an event from
 * another house's vocabulary." Scans only up to the first field ≥11 and stops
 * there; any malformed bytes return ''; never throws.
 */
export function envelopeKind(bytes?: Uint8Array | null): string {
  if (!bytes || bytes.length === 0) return '';
  let i = 0;
  while (i < bytes.length) {
    const key = readVarint(bytes, i);
    if (!key) return '';
    i = key.next;
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (field === 0) return '';
    if (field >= BODY_FIELD_MIN) {
      // HouseEvent is "a recognized envelope slot, an unrecognized vocabulary":
      // its real kind is the house-prefixed verb inside its body (e.g.
      // "world.postcard"). Reporting just 'house_event' would lump a postcard
      // and a random encounter into the same bucket, and the agent would have
      // no way to tell them apart via the manifest — so we unpack it to get the inner kind.
      if (field === HOUSE_EVENT_FIELD && wire === 2) {
        const len = readVarint(bytes, i);
        if (!len) return 'house_event';
        try {
          const inner = popclaw.event.HouseEvent.decode(bytes.subarray(len.next, len.next + len.value));
          if (inner.kind) return `house:${inner.kind}`;
        } catch { /* bad body → fall back to the slot name, still doesn't crash */ }
        return 'house_event';
      }
      return ENVELOPE_KINDS[field] ?? `unknown:${field}`;
    }
    if (wire === 0) {
      const v = readVarint(bytes, i);
      if (!v) return '';
      i = v.next;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else if (wire === 2) {
      const len = readVarint(bytes, i);
      if (!len) return '';
      i = len.next + len.value;
    } else return ''; // group (deprecated) or a bad wire type
  }
  return '';
}

/** Single stored row: columns remain authoritative; raw carries the public evidence. */
export interface FeedCacheRow {
  raw: Uint8Array;
  platform: string;
  platform_post_id: string;
  event_id: string;
  platform_post_created_at: number;
  author_popclaw_id: string;
  handle: string;
  original_url: string;
  text_preview: string;
  reply_to_platform: string | null;
  reply_to_post_id: string | null;
  reply_to_author_popclaw_id: string | null;
}

/** Project authoritative database columns after checking their retained public evidence. */
export function projectCachedRow(r: FeedCacheRow): CachedFeedItem {
  inspectPublicCarrier(r.raw, 'projection');
  const base: CachedFeedItem = {
    platform: r.platform,
    platformPostId: r.platform_post_id,
    eventId: r.event_id,
    platformPostCreatedAt: r.platform_post_created_at,
    authorPopclawId: r.author_popclaw_id,
    handle: r.handle,
    originalUrl: r.original_url,
    textPreview: r.text_preview,
  };
  if (r.reply_to_post_id) {
    base.replyToPlatform = r.reply_to_platform ?? '';
    base.replyToPostId = r.reply_to_post_id;
    base.replyToAuthorPopclawId = r.reply_to_author_popclaw_id ?? '';
  }
  return base;
}

/** Decode one row for reading, preserving column authority and retained-byte evidence. */
export function projectReadableRow(r: FeedCacheRow): ReadableFeedItem {
  const base = projectCachedRow(r);
  let wfi: popclaw.event.IWorldFeedItem | null = null;
  try {
    wfi = popclaw.event.WorldFeedItem.decode(r.raw);
  } catch {
    /* corrupt BLOB → fall back to projection columns below */
  }
  const decoded =
    wfi?.envelope && wfi.envelope.length > 0 ? decodeEnvelopeBody(wfi.envelope) : null;
  return {
    ...base,
    kind: envelopeKind(wfi?.envelope as Uint8Array | undefined),
    body: decoded?.text || base.textPreview, // legacy/over-cap rows → preview
    media: decoded?.media ?? [],
    ...(decoded?.fields ? { houseFields: decoded.fields } : {}),
    replyToAuthorHandle: typeof wfi?.replyToAuthorHandle === 'string' ? wfi.replyToAuthorHandle : '',
    replyCount: numberOrZero(wfi?.replyCount),
    markCount: numberOrZero(wfi?.markCount),
    actorNickname: typeof wfi?.actorNickname === 'string' ? wfi.actorNickname : '',
    actorVerified: (wfi?.actorVerified ?? []).map((v) => ({
      platform: typeof v.platform === 'string' ? v.platform : '',
      handle: typeof v.handle === 'string' ? v.handle : '',
      profileUrl: typeof v.profileUrl === 'string' ? v.profileUrl : '',
      followerCount: numberOrZero(v.followerCount),
    })),
  };
}

/**
 * Normalize a retained carrier after its bytes have passed the public gate.
 * This mapping does not replace carrier inspection.
 * Coerce a protobuf-shaped item (with possibly null/undefined fields, Long
 * timestamps, etc.) into a clean CachedFeedItem. Returns null if essential
 * keys are missing — bad data is dropped silently rather than poisoning
 * the cache.
 */
export function normalizeFeedItem(raw: Partial<popclaw.event.IWorldFeedItem> | null | undefined): CachedFeedItem | null {
  if (!raw) return null;
  const platform = typeof raw.platform === 'string' ? raw.platform : '';
  const platformPostId = typeof raw.platformPostId === 'string' ? raw.platformPostId : '';
  if (!platform || !platformPostId) return null;
  const created = numberOrZero(raw.platformPostCreatedAt);
  const replyToPostId = typeof raw.replyToPostId === 'string' ? raw.replyToPostId : '';
  return {
    platform,
    platformPostId,
    // ADR-0019: '' when field 19 absent; never dropped.
    eventId: typeof raw.eventId === 'string' ? raw.eventId : '',
    platformPostCreatedAt: created,
    authorPopclawId: typeof raw.authorPopclawId === 'string' ? raw.authorPopclawId : '',
    handle: typeof raw.handle === 'string' ? raw.handle : '',
    // WorldFeedItem.original_url is a dead server field (always ''); the live
    // source-post URL is Origin.url (ADR-0025). Keep the explicit field first
    // for legacy rows, then fall back.
    originalUrl:
      (typeof raw.originalUrl === 'string' && raw.originalUrl) ||
      (typeof raw.origin?.url === 'string' ? raw.origin.url : ''),
    textPreview: typeof raw.textPreview === 'string' ? raw.textPreview : '',
    // only set the reply_to_* fields when this is actually a
    // reply (replyToPostId non-empty). Keeps cached posts undisturbed.
    ...(replyToPostId
      ? {
          replyToPlatform: typeof raw.replyToPlatform === 'string' ? raw.replyToPlatform : '',
          replyToPostId,
          replyToAuthorPopclawId:
            typeof raw.replyToAuthorPopclawId === 'string' ? raw.replyToAuthorPopclawId : '',
        }
      : {}),
  };
}

export function numberOrZero(v: unknown): number {
  if (typeof v === 'number') return v;
  // protobuf-emitted int64 sometimes appears as { low, high, unsigned } (Long.js) or as string.
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v === 'object' && 'low' in (v as Record<string, unknown>)) {
    const obj = v as { low: number; high: number; unsigned?: boolean };
    return obj.high * 0x1_0000_0000 + (obj.low >>> 0);
  }
  return 0;
}
