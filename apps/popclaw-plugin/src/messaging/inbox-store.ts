import { decodeEnvelope } from '../protocol/public-envelope.js';
/**
 * DM inbox backed by the precious social DB (my-social-assets.db).
 *
 * Each incoming DM (received via InboxStreamClient) is one row in the `inbox`
 * table. `/popclaw inbox` reads the most recent rows.
 *
 * Deduplication is cross-process and house-agnostic: an available event_id
 * is the primary key; legacy rows use (sender, timestamp, plaintext body hash).
 * Relaying the same event through two houses does not create two inbox rows.
 * house_slug records provenance and must not enter the deduplication key.
 * Notification delivery has its own durable state; inbox deduplication alone
 * is not a claim of exactly-once delivery to every external host.
 */

import { createHash } from 'node:crypto';
import type { HostDb } from '../host/host-db.js';

export interface InboxItem {
  /** Unix seconds (from DirectMessage.ts). */
  readonly ts: number;
  readonly mediaCiphertext?: Uint8Array;
  /** Attachment was present on receipt, even if local decryption/write failed. */
  readonly hasMedia?: boolean;
  readonly fromPopclawId: string;
  readonly toPopclawId: string;
  /**
   * ALWAYS plaintext, including for encrypted DMs (#227): the client decrypts
   * once at the delivery-loop chokepoint and stores what it can actually use,
   * so `body_hash` dedupe keeps working (an SSE replay of the same ciphertext
   * — or a re-encryption under a fresh nonce — hashes to the same value).
   * Local at-rest protection is out of scope here; see issue #225.
   */
  readonly body: string;
  /** Optional: a post that triggered this DM. */
  readonly inReplyToPlatform?: string;
  readonly inReplyToPostId?: string;
  /** When the plugin first received this on the wire. */
  readonly receivedAtMs: number;
  /**
   * Spec B slice 4: the house that relayed this message (`hostDbSlug`). Replies
   * go back the same way they came.
   * undefined / empty string = the main house (legacy single-house rows).
   */
  readonly houseSlug?: string;
  /**
   * #231: the local path where the image carried with the message was saved
   * after decryption (`data/dm-media/…`). undefined = no image.
   * Only the path is stored, not the bytes — the image is a disposable layer,
   * the DB is the precious layer.
   */
  readonly mediaPath?: string;
  /**
   * P0-A: the full signed EventEnvelope bytes as received (the actual body
   * relayed by the lore-house, ADR-0029). Stored in the precious layer so a
   * future v0.2 client can reconstruct the canonical envelope and verify "this
   * was really signed by the claimed author" — a bare 64-byte signature alone
   * cannot reconstruct the canonical form. undefined / empty = that message
   * didn't carry an envelope (legacy data / transition period / a synthesized
   * degraded frame) — this doesn't affect display or dedup. This slice does not
   * verify signatures, it only captures the bytes.
   *
   * Hardening 3 (provenance flag, for v0.2): what's stored is **the entire
   * envelope**, and its `signature` field itself doubles as the provenance
   * flag — after v0.2 decodes it: empty signature = never signed (legacy,
   * don't misjudge as forged); non-empty signature that fails verification =
   * forged. The lore-house side's strict_signature guarantees a real DM always
   * carries a valid signature, and an empty signature can only come from a
   * degraded frame synthesized by the lore-house — so this distinction is
   * unambiguous and needs no extra field.
   */
  readonly envelopeBytes?: Uint8Array;
  /** `envelope.actor.nickname` — the sender's own name for themselves (#281).
   *  Absent on legacy rows and on envelope-less frames. UNTRUSTED: always
   *  rendered as `nickname#sigil`, and outranked by the bond book. */
  readonly senderNickname?: string;
}

function bodyHash(item: InboxItem): string {
  const hash = createHash('sha256').update(item.body);
  if (item.mediaCiphertext?.length) hash.update(item.mediaCiphertext);
  return hash.digest('hex').slice(0, 16);
}

function eventIdOf(item: InboxItem): string | null {
  try { return item.envelopeBytes?.length ? decodeEnvelope(item.envelopeBytes).eventId || null : null; }
  catch { return null; }
}

export type NotificationState = 'legacy' | 'pending' | 'silent' | 'queued' | 'ticket';
export interface StoredInboxItem extends InboxItem {
  readonly id: number;
  readonly eventId?: string;
  readonly notificationState: NotificationState;
  readonly retrievedAtMs?: number;
  readonly resolvedAtMs?: number;
}
interface Row {
  id: number; ts: number; from_popclaw_id: string; to_popclaw_id: string; body: string;
  in_reply_to_platform: string | null; in_reply_to_post_id: string | null; received_at_ms: number;
  house_slug: string; media_path: string | null; envelope: Uint8Array | null;
  sender_nickname: string | null; event_id: string | null; notification_state: NotificationState;
  retrieved_at_ms: number | null; resolved_at_ms: number | null; has_media: number;
}
function fromRow(r: Row): StoredInboxItem {
  return {
    id: r.id, ts: r.ts, fromPopclawId: r.from_popclaw_id, toPopclawId: r.to_popclaw_id, body: r.body,
    inReplyToPlatform: r.in_reply_to_platform ?? undefined, inReplyToPostId: r.in_reply_to_post_id ?? undefined,
    receivedAtMs: r.received_at_ms, notificationState: r.notification_state, hasMedia: !!r.has_media,
    ...(r.house_slug ? { houseSlug: r.house_slug } : {}),
    ...(r.media_path ? { mediaPath: r.media_path } : {}),
    ...(r.envelope ? { envelopeBytes: new Uint8Array(r.envelope) } : {}),
    ...(r.sender_nickname ? { senderNickname: r.sender_nickname } : {}),
    ...(r.event_id ? { eventId: r.event_id } : {}),
    ...(r.retrieved_at_ms != null ? { retrievedAtMs: r.retrieved_at_ms } : {}),
    ...(r.resolved_at_ms != null ? { resolvedAtMs: r.resolved_at_ms } : {}),
  };
}

/** Empty bytes = "no envelope" — store NULL so absence looks the same in the
 *  column and on the wire (mirrors the house's non_empty_bytes). */
function nonEmptyBytes(b: Uint8Array | undefined): Uint8Array | null {
  return b && b.length > 0 ? b : null;
}

/** DM inbox backed by the social DB. Dedup enforced by a UNIQUE index
 *  (from_popclaw_id, ts, body_hash) — cross-process safe. */
export class InboxStore {
  constructor(private readonly db: HostDb) {}

  /** Insert one item. Returns true if it was new, false if a duplicate. */
  record(item: InboxItem): boolean {
    const incomingId = eventIdOf(item);
    if (incomingId) {
      // Upgrade replay: an older client stored the same signed envelope under
      // the text key. Adopt its event ID without creating another notification.
      const legacy = this.db.queryOne<Row>('SELECT * FROM inbox WHERE event_id IS NULL AND from_popclaw_id = ? AND ts = ? AND body_hash = ?',
        [item.fromPopclawId, item.ts, bodyHash({ ...item, mediaCiphertext: undefined })]);
      if (legacy?.envelope && eventIdOf({ ...item, envelopeBytes: legacy.envelope }) === incomingId) {
        this.db.execute('UPDATE inbox SET event_id = ? WHERE id = ? AND event_id IS NULL', [incomingId, legacy.id]);
        return false;
      }
    }
    const res = this.db.execute(
      `INSERT OR IGNORE INTO inbox
         (ts, from_popclaw_id, to_popclaw_id, body, body_hash,
          in_reply_to_platform, in_reply_to_post_id, received_at_ms, house_slug, media_path,
          envelope, sender_nickname, event_id, notification_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [item.ts, item.fromPopclawId, item.toPopclawId, item.body, bodyHash(item),
       item.inReplyToPlatform ?? null, item.inReplyToPostId ?? null, item.receivedAtMs,
       item.houseSlug ?? '', item.mediaPath ?? null, nonEmptyBytes(item.envelopeBytes),
       item.senderNickname?.trim() || null, eventIdOf(item)],
    );
    return res.changes === 1;
  }

  /** Store first, then recover policy after crashes/reconnects from any host. */
  recordReceived(item: InboxItem): { wasNew: boolean; item: StoredInboxItem } {
    return this.db.transaction(() => {
      const wasNew = this.record(item);
      const eventId = eventIdOf(item);
      const row = eventId
        ? this.db.queryOne<Row>('SELECT * FROM inbox WHERE event_id = ?', [eventId])
        : this.db.queryOne<Row>('SELECT * FROM inbox WHERE event_id IS NULL AND from_popclaw_id = ? AND ts = ? AND body_hash = ?', [item.fromPopclawId, item.ts, bodyHash(item)]);
      if (!row) throw new Error('DM insert did not produce an inbox row');
      // A verified replay repairs both missing and legacy collision-prone paths.
      if (item.mediaPath && row.media_path !== item.mediaPath) {
        this.db.execute('UPDATE inbox SET media_path = ? WHERE id = ?', [item.mediaPath, row.id]);
        row.media_path = item.mediaPath;
      }
      if (!row.has_media && (item.mediaCiphertext?.length || item.mediaPath || item.hasMedia)) {
        this.db.execute('UPDATE inbox SET has_media = 1 WHERE id = ?', [row.id]);
        row.has_media = 1;
      }
      return { wasNew, item: fromRow(row) };
    });
  }

  get(id: number): StoredInboxItem | null {
    const row = this.db.queryOne<Row>('SELECT * FROM inbox WHERE id = ?', [id]);
    return row ? fromRow(row) : null;
  }

  pendingPolicy(afterId = 0, limit = 200): StoredInboxItem[] {
    return this.db.queryAll<Row>("SELECT * FROM inbox WHERE notification_state = 'pending' AND id > ? ORDER BY id LIMIT ?", [afterId, limit]).map(fromRow);
  }

  /** State and enqueue commit together on the same social DB, across processes. */
  settleNotification(id: number, state: NotificationState, enqueue?: () => void): boolean {
    return this.db.transaction(() => {
      const changed = this.db.execute("UPDATE inbox SET notification_state = ? WHERE id = ? AND notification_state = 'pending'", [state, id]).changes;
      if (!changed) return false;
      enqueue?.();
      return true;
    });
  }

  /**
   * What an owner-facing list should say about each message's notice.
   * `queued` is the policy decision and never changes afterwards; whether a
   * host session then acknowledged the notice lives on its receipts. Reading
   * it here keeps `show_inbox` in step with `popclaw_acknowledge_notifications`
   * without adding a state to the inbox. (The native leg's `delivered_at` is
   * not read: a discarded claim stamps it too, so it does not mean delivered.)
   */
  notificationStatesOf(items: readonly StoredInboxItem[]): Map<number, NotificationState | 'acknowledged'> {
    const out = new Map<number, NotificationState | 'acknowledged'>(items.map((i) => [i.id, i.notificationState]));
    const queued = items.filter((i) => i.notificationState === 'queued').map((i) => i.id);
    if (queued.length === 0) return out;
    const rows = this.db.queryAll<{ id: number }>(
      `SELECT DISTINCT q.source_message_id AS id
       FROM notification_queue q JOIN notification_receipts r ON r.notification_id = q.id
       WHERE r.acknowledged_at IS NOT NULL AND q.source_message_id IN (${queued.map(() => '?').join(',')})`,
      queued,
    );
    for (const r of rows) out.set(r.id, 'acknowledged');
    return out;
  }

  markRetrieved(id: number): void {
    this.db.execute('UPDATE inbox SET retrieved_at_ms = COALESCE(retrieved_at_ms, ?) WHERE id = ?', [Date.now(), id]);
  }

  resolve(id: number): boolean {
    return this.db.execute('UPDATE inbox SET resolved_at_ms = COALESCE(resolved_at_ms, ?) WHERE id = ?', [Date.now(), id]).changes === 1;
  }

  /** How many distinct people have ever DM'd the owner (`/popclaw status`). */
  distinctSenderCount(): number {
    return (
      this.db.queryOne<{ n: number }>(
        'SELECT COUNT(DISTINCT from_popclaw_id) AS n FROM inbox',
        [],
      )?.n ?? 0
    );
  }

  /** Return the most recent N items, newest first. */
  recent(n: number, beforeId?: number): StoredInboxItem[] {
    return this.db.queryAll<Row>(
      'SELECT * FROM inbox' + (beforeId == null ? '' : ' WHERE id < ?') + (beforeId == null ? ' ORDER BY ts DESC, id DESC LIMIT ?' : ' ORDER BY id DESC LIMIT ?'),
      beforeId == null ? [n] : [beforeId, n],
    ).map(fromRow);
  }

  /** Stable arrival cursor; sender timestamps cannot reorder a paginated handoff. */
  page(limit: number, beforeId?: number): StoredInboxItem[] {
    return this.db.queryAll<Row>('SELECT * FROM inbox WHERE id < ? ORDER BY id DESC LIMIT ?', [beforeId ?? Number.MAX_SAFE_INTEGER, limit]).map(fromRow);
  }

  /**
   * How many rows sit strictly above an arrival cursor, and the newest of them.
   * `page()` only walks older than its cursor; this is what lets a listing say
   * "there is newer mail you did not ask for" instead of implying there is none.
   */
  newerThan(id: number): { count: number; latestId: number | null } {
    const row = this.db.queryOne<{ n: number; latest: number | null }>(
      'SELECT COUNT(*) AS n, MAX(id) AS latest FROM inbox WHERE id > ?',
      [id],
    );
    return { count: row?.n ?? 0, latestId: row?.latest ?? null };
  }

  /**
   * The ts (unix seconds) of this person's previous incoming message, **strictly
   * before** `beforeTs`. null if there is none.
   *
   * The bond-context trailer line (bond-context.ts) uses this to say "they
   * messaged you yesterday." `beforeTs` isn't an optional nicety: the inbound
   * loop writes to the DB before enqueueing, so it can't be ruled out that this
   * very message would otherwise always say "today" forever. This walks the
   * `inbox_dedup(from_popclaw_id, ts, body_hash)` prefix — one index hit on the
   * notification hot path, not a full table scan.
   */
  lastIncomingTs(fromPopclawId: string, beforeTs: number): number | null {
    const row = this.db.queryOne<{ ts: number }>(
      `SELECT ts FROM inbox WHERE from_popclaw_id = ? AND ts < ? ORDER BY ts DESC LIMIT 1`,
      [fromPopclawId, beforeTs],
    );
    return row?.ts ?? null;
  }

  /**
   * Whether this house's official account has ever messaged the owner — the
   * "already started" determination for onboarding R1 (a message received =
   * the owner really did something over there, never bring up the first thing
   * again).
   *
   * `officialIds` already locks the sender to this house's own official
   * account(s), so legacy rows with an empty `house_slug` also count (those
   * are rows laid down back when only the main house was mounted). Empty
   * officialIds = cannot be looked up → false, and the caller must treat
   * "could not be looked up" as distinct from "not present", never treating it
   * as "already started".
   */
  hasIncomingFrom(houseSlug: string, officialIds: readonly string[]): boolean {
    if (officialIds.length === 0) return false;
    const placeholders = officialIds.map(() => '?').join(',');
    return (
      this.db.queryOne<{ n: number }>(
        `SELECT 1 AS n FROM inbox
          WHERE from_popclaw_id IN (${placeholders})
            AND (house_slug = ? OR house_slug = '') LIMIT 1`,
        [...officialIds, houseSlug],
      ) !== null
    );
  }

  /**
   * Spec B slice 4: which house this person's most recent incoming message came
   * from — replies go back to that same house.
   * No incoming record / legacy row (empty string) → undefined = the main house
   * (proactively starting a cross-house chat is phase 2).
   * Same shape as `FollowEventStore.declaredHouseOf`.
   */
  houseOf(fromPopclawId: string): string | undefined {
    const row = this.db.queryOne<{ house_slug: string }>(
      `SELECT house_slug FROM inbox
        WHERE from_popclaw_id = ? ORDER BY ts DESC, id DESC LIMIT 1`,
      [fromPopclawId],
    );
    return row?.house_slug ? row.house_slug : undefined;
  }
}
