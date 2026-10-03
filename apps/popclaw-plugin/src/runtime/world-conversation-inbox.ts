import { decodeEnvelope, canonicalizeEnvelope } from '../protocol/public-envelope.js';
/** Durable local conversation rendering; no notification or policy authority. */
import { popclaw } from '@popclaw/contracts';
import { cidFromCanonical, L_ENVELOPE_MAX_BYTES } from '@popclaw/algorithms';
import type { HostDb } from '../host/host-db.js';
import { InboxStore } from '../messaging/inbox-store.js';
import { hostDbSlug } from '../ingress/host-slug.js';
import { worldPublicKey } from '../world/action-wire.js';
import { jsonObject, parseWorldJson } from '../world/json-profile.js';
import type { StructuredPrivateDeliveryMessage } from '../world/private-world-delivery.js';

export interface WorldConversationKey {
  house: popclaw.world.IHouseBinding; actorId: string; messageId: string;
}
export interface WorldConversationInboxOptions {
  /** The existing social host DB, never the per-house private cache DB. */
  hostDb: HostDb; actorId: string;
  /** Synchronous original resource-scope check, e.g. assertHouseActionActive.
   * The caller must retain its actual G0 resource scope, not mint a new gate. */
  authorizeCurrent(house: popclaw.world.IHouseBinding): void;
  /** Local arrival time in milliseconds; never derived from message content. */
  now?: () => number;
}
export interface StoredWorldConversation extends WorldConversationKey {
  inboxId: number; senderId: string; eventId: string; summary: string;
  originalText: string; wrapper: Readonly<Record<string, unknown>>;
  envelopeBytes: Uint8Array; receivedAtMs: number;
}
interface Row { binding: string; inbox_id: number; metadata: string; original_text: string; envelope_bytes: Uint8Array; received_at_ms: number }
const TABLE = 'world_conversation_inbox_v1', utf8 = new TextEncoder();
function fail(code: string): never { throw new Error(code); }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
function opaque(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,128}$/.test(value); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
/** Copy data descriptors only: a caller cannot substitute getters/toJSON while
 * the supplied synchronous authorization callback executes. */
function snapshotJson(value: unknown): unknown {
  let nodes = 0;
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 65536 || depth > 8) fail('CONVERSATION_JSON_LIMIT');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isSafeInteger(item)) return item;
    if (!item || typeof item !== 'object' || Object.getOwnPropertySymbols(item).length) fail('CONVERSATION_JSON_INVALID');
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail('CONVERSATION_JSON_INVALID');
    const descriptors = Object.entries(Object.getOwnPropertyDescriptors(item)).filter(([key]) => !Array.isArray(item) || key !== 'length');
    const result: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : Object.create(null);
    if (Array.isArray(item) && descriptors.length !== item.length) fail('CONVERSATION_JSON_INVALID');
    for (const [key, descriptor] of descriptors) {
      if (!descriptor.enumerable || !('value' in descriptor) || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('CONVERSATION_JSON_INVALID');
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) fail('CONVERSATION_JSON_INVALID');
      (result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  }
  return copy(value, 1);
}
function captureKey(input: WorldConversationKey, actorId: string) {
  const house = { origin: input.house.origin, houseKey: input.house.houseKey, incarnation: input.house.incarnation };
  if (input.actorId !== actorId || !opaque(input.messageId) || typeof house.origin !== 'string'
    || !/^https?:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(house.origin)
    || house.origin.length > 253 || new URL(house.origin).origin !== house.origin
    || typeof house.incarnation !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(house.incarnation)) fail('CONVERSATION_BINDING_MISMATCH');
  worldPublicKey(house.houseKey);
  return { house, actorId, messageId: input.messageId, binding: JSON.stringify([house.origin, house.houseKey, house.incarnation, actorId, input.messageId]) };
}

export function createWorldConversationInbox(options: WorldConversationInboxOptions) {
  const { hostDb: db, actorId, authorizeCurrent } = options;
  worldPublicKey(actorId);
  if (typeof authorizeCurrent !== 'function') fail('CONVERSATION_AUTHORITY_REQUIRED');
  // A facade over the supplied handle; it never opens/closes a database or
  // changes InboxStore's schema/ordinary-DM policy.
  const inbox = new InboxStore(db);
  db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    binding TEXT PRIMARY KEY, inbox_id INTEGER NOT NULL REFERENCES inbox(id),
    metadata TEXT NOT NULL, original_text TEXT NOT NULL, envelope_bytes BLOB NOT NULL,
    received_at_ms INTEGER NOT NULL)`);
  const read = (binding: string) => db.queryOne<Row>(`SELECT * FROM ${TABLE} WHERE binding=?`, [binding]);
  return {
    onConversation(message: StructuredPrivateDeliveryMessage): void {
      const fixed = captureKey(message, actorId), senderId = message.senderId, eventId = message.eventId;
      const signal = message.signal, idempotencyKey = message.idempotencyKey, deliveryClass = message.deliveryClass;
      const originalText = message.originalText;
      if (typeof originalText !== 'string' || utf8.encode(originalText).length > 65536
        || !(message.envelopeBytes instanceof Uint8Array) || !message.envelopeBytes.length || message.envelopeBytes.length > L_ENVELOPE_MAX_BYTES) fail('CONVERSATION_SIZE_INVALID');
      const envelopeBytes = new Uint8Array(message.envelopeBytes), wrapper = jsonObject(snapshotJson(message.wrapper));
      const parsed = jsonObject(parseWorldJson(utf8.encode(originalText), 65536));
      if (canonical(parsed) !== canonical(wrapper)) fail('CONVERSATION_WRAPPER_MISMATCH');
      if (deliveryClass !== 'conversation' || wrapper.delivery_class !== 'conversation') fail('CONVERSATION_CLASS_INVALID');
      if (wrapper.format !== 'popclaw.world-message' || wrapper.version !== 1 || wrapper.message_id !== fixed.messageId
        || !opaque(wrapper.conversation_ref) || typeof wrapper.summary !== 'string' || [...wrapper.summary].length > 280
        || idempotencyKey !== fixed.binding) fail('CONVERSATION_BINDING_MISMATCH');
      if (wrapper.house !== undefined) {
        const bound = jsonObject(wrapper.house);
        if (bound.origin !== fixed.house.origin || bound.house_key !== fixed.house.houseKey || bound.incarnation !== fixed.house.incarnation) fail('CONVERSATION_BINDING_MISMATCH');
      }
      worldPublicKey(senderId);
      const envelope = decodeEnvelope(envelopeBytes), dm = envelope.directMessage;
      // Check coherence with already authenticated core metadata, using the
      // existing CID algorithm. Signature verification/decryption stays upstream.
      if (!dm || envelope.body !== 'directMessage' || envelope.eventId !== eventId || !/^[a-f0-9]{64}$/.test(eventId)
        || cidFromCanonical(canonicalizeEnvelope(envelope)) !== eventId || envelope.actor?.popclawId !== senderId
        || dm.fromPopclawId !== senderId || dm.toPopclawId !== actorId || envelope.target?.scope !== 1
        || envelope.target.targetIds?.length !== 1 || envelope.target.targetIds[0] !== actorId || envelope.target.filterCriteria
        || (envelope.lorehouse && envelope.lorehouse !== fixed.house.origin)) fail('CONVERSATION_ENVELOPE_MISMATCH');
      const ts = Number(dm.ts?.toString());
      if (!Number.isSafeInteger(ts) || ts < 0) fail('CONVERSATION_TIME_INVALID');
      const metadata = canonical({ house: fixed.house, actorId, messageId: fixed.messageId, senderId, eventId, wrapper });
      const check = () => {
        if (!signal || signal.aborted) fail('CONVERSATION_INACTIVE');
        // Copy the binding per check so authorization cannot alter the snapshot.
        const result: unknown = authorizeCurrent({ ...fixed.house });
        if (result && (typeof result === 'object' || typeof result === 'function') && 'then' in result) {
          void Promise.resolve(result).catch(() => {});
          fail('CONVERSATION_AUTHORIZATION_MUST_BE_SYNCHRONOUS');
        }
        if (signal.aborted) fail('CONVERSATION_INACTIVE');
      };
      check();
      db.transaction(tx => {
        if (tx !== db) fail('CONVERSATION_HOST_DB_MISMATCH');
        check();
        const previous = read(fixed.binding);
        if (previous) {
          if (previous.metadata !== metadata || previous.original_text !== originalText || !sameBytes(previous.envelope_bytes, envelopeBytes)) fail('CONVERSATION_ID_CONFLICT');
          check(); return;
        }
        // Older ordinary-DM rows may contain the full wrapper instead of the
        // new summary rendering. Preserve their body and all settled notice state.
        const existing = tx.queryAll<{ id: number }>(`SELECT id FROM inbox WHERE event_id=? OR (event_id IS NULL AND envelope=?) LIMIT 2`, [eventId, envelopeBytes]);
        if (existing.length > 1) fail('CONVERSATION_INBOX_CONFLICT');
        const old = existing[0] && inbox.get(existing[0].id);
        if (old && (old.fromPopclawId !== senderId || old.toPopclawId !== actorId || old.ts !== ts
          || (old.envelopeBytes && !sameBytes(old.envelopeBytes, envelopeBytes)))) fail('CONVERSATION_INBOX_CONFLICT');
        const receivedAtMs = options.now?.() ?? Date.now();
        if (!Number.isSafeInteger(receivedAtMs) || receivedAtMs < 0) fail('CONVERSATION_TIME_INVALID');
        const stored = inbox.recordReceived({ ts, fromPopclawId: senderId, toPopclawId: actorId,
          body: old?.body ?? wrapper.summary as string, receivedAtMs, houseSlug: hostDbSlug(fixed.house.origin!), envelopeBytes,
          senderNickname: envelope.actor?.nickname ?? undefined, inReplyToPlatform: dm.inReplyToPost?.platform ?? undefined,
          inReplyToPostId: dm.inReplyToPost?.platformPostId ?? undefined });
        tx.execute(`INSERT INTO ${TABLE}(binding,inbox_id,metadata,original_text,envelope_bytes,received_at_ms) VALUES(?,?,?,?,?,?)`,
          [fixed.binding, stored.item.id, metadata, originalText, envelopeBytes, receivedAtMs]);
        if (stored.wasNew || stored.item.notificationState === 'pending') inbox.settleNotification(stored.item.id, 'silent');
        check(); // Still inside the transaction: a failed original-scope check rolls everything back.
      });
    },
    /** One exact full-tuple lookup; no unbounded scan and no authority object. */
    get(input: WorldConversationKey): StoredWorldConversation | null {
      const fixed = captureKey(input, actorId), row = read(fixed.binding);
      if (!row) return null;
      const metadata = JSON.parse(row.metadata) as { house: popclaw.world.IHouseBinding; actorId: string; messageId: string; senderId: string; eventId: string; wrapper: Record<string, unknown> };
      return { ...metadata, inboxId: row.inbox_id, summary: metadata.wrapper.summary as string,
        originalText: row.original_text, envelopeBytes: new Uint8Array(row.envelope_bytes), receivedAtMs: row.received_at_ms };
    },
  };
}
