import { decodeEnvelope, canonicalizeEnvelope, L_ENVELOPE_MAX_BYTES } from '../protocol/public-envelope.js';
import { popclaw } from '@popclaw/contracts';
import wrapperSchema from '@popclaw/contracts/world-interaction/private-message.schema.json';
import { cidFromCanonical } from '@popclaw/algorithms';
import Ajv2020 from 'ajv/dist/2020.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { HostDb } from '../host/host-db.js';
import type { Signer } from '../identity/signer.js';
import type { TrustedWorldCapabilities } from './world-capabilities.js';
import { jsonObject, parseWorldJson } from './json-profile.js';
import { validateWorldPayload } from './schema-validator.js';

const utf8 = new TextEncoder();
const validateWrapper = new Ajv2020({ strict: false, validateSchema: false, allErrors: false }).compile(wrapperSchema);
const MAX_ENVELOPE = L_ENVELOPE_MAX_BYTES;
const MAX_MESSAGE = 65536;

/** A captured G0 gate, not a second session lifecycle. */
export interface PrivateMessageGate { readonly origin: string; readonly signal: AbortSignal; isActive(): boolean }
export interface PrivateWorldMessageOptions {
  readonly db: HostDb;
  readonly gate: PrivateMessageGate;
  readonly capabilities: TrustedWorldCapabilities;
  readonly recipientId: string;
  readonly recipient: Pick<Signer, 'openDm'>;
  readonly isOfficialActor: (actorId: string) => boolean;
}
export type PrivateStateStatus = 'none' | 'new' | 'updated' | 'duplicate' | 'old' | 'conflict';
export type PrivateWorldMessageResult =
  | { kind: 'dropped'; reason: string }
  | { kind: 'plain'; originalText: string; reason: string }
  | { kind: 'storage_failed'; reason: 'MESSAGE_STORAGE_FAILED'; retryable: true; messageId: string; eventId: string }
  | { kind: 'conflict'; originalText: string; reason: 'MESSAGE_ID_CONFLICT' }
  | { kind: 'structured'; originalText: string; wrapper: Readonly<Record<string, unknown>>;
      deliveryClass: 'conversation' | 'receipt' | 'state'; messageStatus: 'new' | 'duplicate'; stateStatus: PrivateStateStatus;
      /** Authenticated facts only. A dedicated store must apply monotonic merge
       * and local grants before using these facts for any autonomous work. */
      proposedParticipation?: popclaw.world.ParticipationDescriptor };

export interface StoredPrivateWorldMessage {
  messageId: string; eventId: string; envelopeBytes: Uint8Array; plaintextBytes: Uint8Array;
  envelopeDigest: string; plaintextDigest: string; wrapperDigest: string;
}
export interface PendingPrivateWorldMessage { messageId: string; eventId: string; envelopeBytes: Uint8Array }
interface MessageRow { message_id: string; event_id: string; envelope_bytes: Uint8Array; plaintext_bytes: Uint8Array; envelope_digest: string; plaintext_digest: string; wrapper_digest: string }
interface StateRow { state_ref: string; revision: string; state_digest: string; message_id: string }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
function key(value: unknown): Uint8Array {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) throw new Error('MESSAGE_KEY_INVALID');
  const bytes = bs58.decode(value);
  if (bytes.length !== 32 || bs58.encode(bytes) !== value) throw new Error('MESSAGE_KEY_INVALID');
  return bytes;
}
function uint64(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw new Error('MESSAGE_UINT64_INVALID');
  return value;
}
function time(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) throw new Error('MESSAGE_TIME_INVALID');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace('.000Z', 'Z') !== value) throw new Error('MESSAGE_TIME_INVALID');
  return ms / 1000;
}
function sameHouse(value: unknown, expected: popclaw.world.IHouseBinding): void {
  const house = jsonObject(value);
  key(house.house_key);
  if (house.origin !== expected.origin || house.house_key !== expected.houseKey || house.incarnation !== expected.incarnation) throw new Error('MESSAGE_HOUSE_MISMATCH');
}

/** Shape is checked by the frozen wrapper schema before these cross-field
 * checks. This conversion preserves the entire uint64 range in generated Longs. */
function participation(value: unknown, house: popclaw.world.IHouseBinding, recipientId: string): popclaw.world.ParticipationDescriptor {
  const descriptor = jsonObject(value);
  sameHouse(descriptor.house, house); key(descriptor.actor_id);
  if (descriptor.actor_id !== recipientId) throw new Error('MESSAGE_PARTICIPATION_ACTOR_MISMATCH');
  const revision = uint64(descriptor.revision);
  const window = jsonObject(descriptor.window);
  const opens = time(window.opens_at); const closes = time(window.closes_at);
  if (opens >= closes) throw new Error('MESSAGE_WINDOW_INVALID');
  const groups = descriptor.action_groups as Record<string, unknown>[];
  const budgets = descriptor.budgets as Record<string, unknown>[];
  const opportunities = descriptor.opportunities as Record<string, unknown>[];
  for (const rows of [groups, budgets, opportunities]) if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('MESSAGE_DESCRIPTOR_DUPLICATE');
  if (budgets.some(budget => budget.window_id !== window.id)) throw new Error('MESSAGE_BUDGET_WINDOW_MISMATCH');
  for (const opportunity of opportunities) {
    const group = groups.find(row => row.id === opportunity.action_group_id);
    const budget = budgets.find(row => row.id === opportunity.budget_group_id && row.window_id === opportunity.budget_window_id);
    const start = time(opportunity.not_before); const end = time(opportunity.expires_at);
    if (!group || !budget || start < opens || start >= end || end > closes) throw new Error('MESSAGE_OPPORTUNITY_INVALID');
    const dm = (group.channels as string[] | undefined)?.includes('direct_message') && (opportunity.channels as string[] | undefined)?.includes('direct_message');
    if (dm && descriptor.dm_response_slot_key !== undefined && opportunity.dedupe_key !== descriptor.dm_response_slot_key) throw new Error('MESSAGE_RESPONSE_SLOT_INVALID');
  }
  return popclaw.world.ParticipationDescriptor.fromObject({ version: 1, house, actorId: descriptor.actor_id,
    participationId: descriptor.participation_id, revision, windowId: window.id, windowOpensAt: opens, windowClosesAt: closes,
    actionGroups: groups.map(group => ({ id: group.id, intentKinds: group.intent_kinds, controlReset: group.control_reset, channels: group.channels })),
    budgets: budgets.map(budget => ({ id: budget.id, windowId: budget.window_id, resource: budget.resource, suggestedLimit: budget.suggested_limit })),
    opportunities: opportunities.map(opportunity => ({ id: opportunity.id, sourceEventId: opportunity.source_event_id,
      actionGroupId: opportunity.action_group_id, budgetGroupId: opportunity.budget_group_id, budgetWindowId: opportunity.budget_window_id,
      notBefore: time(opportunity.not_before), expiresAt: time(opportunity.expires_at), dedupeKey: opportunity.dedupe_key, channels: opportunity.channels })),
    dmResponseSlotKey: descriptor.dm_response_slot_key });
}

function tables(tx: HostDb): void {
  // The unreleased v1 tables lacked recipient isolation. Never import or read
  // their rows: their ownership cannot safely be reconstructed from the cache.
  tx.execute(`CREATE TABLE IF NOT EXISTS world_private_messages_v2 (
    binding TEXT NOT NULL, message_id TEXT NOT NULL, event_id TEXT NOT NULL,
    envelope_bytes BLOB NOT NULL, plaintext_bytes BLOB NOT NULL, envelope_digest TEXT NOT NULL,
    plaintext_digest TEXT NOT NULL, wrapper_digest TEXT NOT NULL,
    consumer_pending INTEGER NOT NULL CHECK(consumer_pending IN (0,1)), PRIMARY KEY(binding,message_id))`);
  tx.execute(`CREATE TABLE IF NOT EXISTS world_private_states_v2 (
    binding TEXT NOT NULL, state_ref TEXT NOT NULL, revision TEXT NOT NULL,
    state_digest TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(binding,state_ref))`);
}

/** Private, durable facts only. No notifier, action result, local policy/grant,
 * public event projection or engine invocation is created by this receiver. */
export class PrivateWorldMessages {
  private readonly options: PrivateWorldMessageOptions;
  private readonly bindingId: string;
  constructor(options: PrivateWorldMessageOptions) {
    this.options = { ...options, capabilities: structuredClone(options.capabilities) };
    key(options.recipientId);
    const house = this.options.capabilities.house;
    key(house.houseKey);
    if (house.origin !== options.gate.origin || !house.incarnation) throw new Error('MESSAGE_HOUSE_MISMATCH');
    this.bindingId = JSON.stringify([house.origin, house.houseKey, house.incarnation, options.recipientId]);
  }
  assertBinding(db: HostDb, house: popclaw.world.IHouseBinding, recipientId: string): void {
    if (db !== this.options.db || this.bindingId !== JSON.stringify([house.origin, house.houseKey, house.incarnation, recipientId])) throw new Error('MESSAGE_CACHE_BINDING_MISMATCH');
  }
  private active(): boolean {
    const { gate } = this.options;
    return !gate.signal.aborted && gate.isActive();
  }
  private assertActive(): void { if (!this.active()) throw new Error('HOUSE_GATE_CLOSED'); }

  /** Local cache reads confer no permission to execute, notify or install a grant. */
  readMessage(messageId: string): StoredPrivateWorldMessage | null {
    const db = this.options.db;
    if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_private_messages_v2'")) return null;
    const row = db.queryOne<MessageRow>('SELECT * FROM world_private_messages_v2 WHERE binding=? AND message_id=?', [this.bindingId, messageId]);
    return row ? { messageId: row.message_id, eventId: row.event_id, envelopeBytes: new Uint8Array(row.envelope_bytes),
      plaintextBytes: new Uint8Array(row.plaintext_bytes), envelopeDigest: row.envelope_digest, plaintextDigest: row.plaintext_digest, wrapperDigest: row.wrapper_digest } : null;
  }
  readState(stateRef: string): { stateRef: string; revision: string; messageId: string } | null {
    const db = this.options.db;
    if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_private_states_v2'")) return null;
    const row = db.queryOne<StateRow>('SELECT * FROM world_private_states_v2 WHERE binding=? AND state_ref=?', [this.bindingId, stateRef]);
    return row ? { stateRef: row.state_ref, revision: row.revision, messageId: row.message_id } : null;
  }

  /** A bounded recovery page, not validated privileges. Replay envelopeBytes
   * through receive under the current captured context before handling them.
   * The caller may page past a failed item without acknowledging that item. */
  pending(limit = 100, afterMessageId?: string): PendingPrivateWorldMessage[] {
    this.assertActive();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('PENDING_LIMIT_INVALID');
    if (afterMessageId !== undefined && !/^[A-Za-z0-9_./:-]{1,128}$/.test(afterMessageId)) throw new Error('PENDING_CURSOR_INVALID');
    const db = this.options.db;
    if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_private_messages_v2'")) return [];
    const rows = db.queryAll<Pick<MessageRow, 'message_id' | 'event_id' | 'envelope_bytes'>>(
      `SELECT message_id,event_id,envelope_bytes FROM world_private_messages_v2
       WHERE binding=? AND consumer_pending=1 AND message_id>? ORDER BY message_id LIMIT ?`, [this.bindingId, afterMessageId ?? '', limit]);
    this.assertActive();
    return rows.map(row => ({ messageId: row.message_id, eventId: row.event_id, envelopeBytes: new Uint8Array(row.envelope_bytes) }));
  }

  /** Indexed acknowledgement lookup for bounded delivery passes. */
  isPending(messageId: string): boolean {
    this.assertActive();
    if (!/^[A-Za-z0-9_./:-]{1,128}$/.test(messageId)) throw new Error('MESSAGE_ID_INVALID');
    const db = this.options.db;
    if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_private_messages_v2'")) return false;
    const row = db.queryOne<{ consumer_pending: number }>('SELECT consumer_pending FROM world_private_messages_v2 WHERE binding=? AND message_id=?', [this.bindingId, messageId]);
    this.assertActive();
    return row?.consumer_pending === 1;
  }

  /** Acknowledge only after the root's consumer succeeds. Its own effects must
   * be idempotent: a crash between handling and this commit retries delivery.
   * An old consumer cannot acknowledge through a revoked captured G0 gate. */
  markHandled(messageId: string): boolean {
    this.assertActive();
    return this.options.db.transaction(tx => {
      this.assertActive();
      if (!tx.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_private_messages_v2'")) return false;
      const result = tx.execute('UPDATE world_private_messages_v2 SET consumer_pending=0 WHERE binding=? AND message_id=? AND consumer_pending=1', [this.bindingId, messageId]);
      this.assertActive();
      return result.changes > 0;
    });
  }

  async receive(originalEnvelope: Uint8Array): Promise<PrivateWorldMessageResult> {
    let originalText: string | undefined;
    let storageIdentity: { messageId: string; eventId: string } | undefined;
    try {
      this.assertActive();
      if (!(originalEnvelope instanceof Uint8Array) || !originalEnvelope.length || originalEnvelope.length > MAX_ENVELOPE) throw new Error('MESSAGE_ENVELOPE_SIZE_LIMIT');
      // Capture before the first await; callers may reuse their SSE buffer.
      const raw = new Uint8Array(originalEnvelope);
      const envelope = decodeEnvelope(raw);
      const allowed = new Set(['eventId', 'actor', 'target', 'lorehouse', 'timestamp', 'signature', 'prevEventId', 'directMessage']);
      if (Object.keys(envelope).some(name => !allowed.has(name)) || envelope.body !== 'directMessage' || !envelope.directMessage) throw new Error('MESSAGE_ENVELOPE_BODY_INVALID');
      // Verify the decoded original envelope using the existing canonical CID
      // algorithm. Unknown protobuf fields remain ignored under frozen C §5;
      // they never contribute metadata or substitute a known non-DM body.
      const actor = envelope.actor?.popclawId;
      const actorKey = key(actor);
      const canonical = canonicalizeEnvelope(envelope);
      if (!/^[0-9a-f]{64}$/.test(envelope.eventId) || envelope.signature.length !== 64 || cidFromCanonical(canonical) !== envelope.eventId || !nacl.sign.detached.verify(canonical, envelope.signature, actorKey)) throw new Error('MESSAGE_ENVELOPE_SIGNATURE_INVALID');
      const dm = envelope.directMessage;
      if (dm.fromPopclawId !== actor || dm.toPopclawId !== this.options.recipientId || envelope.target?.scope !== 1 || envelope.target.targetIds?.length !== 1 || envelope.target.targetIds[0] !== this.options.recipientId || envelope.target.filterCriteria) throw new Error('MESSAGE_RECIPIENT_MISMATCH');
      this.assertActive();
      if (!dm.ciphertext?.length) return { kind: 'plain', originalText: dm.body ?? '', reason: 'MESSAGE_UNENCRYPTED' };
      // Bounds apply before nacl's synchronous conversion/decryption. Larger
      // ordinary DMs remain supported up to the existing envelope byte limit.
      if (dm.ciphertext.length > MAX_ENVELOPE || dm.nonce?.length !== 24) throw new Error('MESSAGE_CIPHERTEXT_INVALID');
      const decrypted = this.options.recipient.openDm(dm, actor!);
      if (!decrypted.ok) throw new Error('MESSAGE_DECRYPT_FAILED');
      originalText = decrypted.plaintext;
      this.assertActive();
      // Older Signers expose only a lossy string (BOM removed, invalid UTF-8
      // replaced). They retain ordinary DM support but cannot grant metadata
      // privilege. The crypto owner supplies these exact authenticated bytes.
      const decryptedBytes = decrypted.plaintextBytes;
      if (!(decryptedBytes instanceof Uint8Array)) return this.plain(originalText, 'MESSAGE_STRICT_BYTES_UNAVAILABLE');
      if (decryptedBytes.length > MAX_MESSAGE) return this.plain(originalText, 'MESSAGE_SIZE_LIMIT');
      const plaintextBytes = new Uint8Array(decryptedBytes);
      originalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintextBytes);
      const caps = this.options.capabilities;
      const board = caps.manifest.world_interaction as { features?: { structured_private_messages?: unknown } } | undefined;
      if (board?.features?.structured_private_messages !== 1) return this.plain(originalText, 'MESSAGE_FEATURE_UNAVAILABLE');
      if (!Array.isArray(caps.manifest.official_ids) || !caps.manifest.official_ids.includes(actor) || !this.options.isOfficialActor(actor!)) return this.plain(originalText, 'MESSAGE_SOURCE_UNPRIVILEGED');
      if (originalText.length > MAX_MESSAGE) return this.plain(originalText, 'MESSAGE_SIZE_LIMIT');
      const wrapper = jsonObject(parseWorldJson(plaintextBytes, MAX_MESSAGE));
      if (!validateWrapper(wrapper)) return this.plain(originalText, 'MESSAGE_WRAPPER_INVALID');
      if (wrapper.capability_revision !== caps.capabilityRevision) return this.plain(originalText, 'MESSAGE_REVISION_UNSUPPORTED');
      const entries = caps.manifest.event_kinds;
      const entry = Array.isArray(entries) ? entries.find(row => row.kind === wrapper.kind && row.transport === 'house' && row.schema_version === wrapper.schema_version) : undefined;
      if (!entry) return this.plain(originalText, 'MESSAGE_KIND_UNSUPPORTED');
      if (wrapper.house !== undefined) sameHouse(wrapper.house, caps.house);
      if (wrapper.delivery_class === 'state' && (!wrapper.house || wrapper.state_ref === undefined || wrapper.state_revision === undefined)) throw new Error('MESSAGE_STATE_BINDING_REQUIRED');
      if ((wrapper.state_ref === undefined) !== (wrapper.state_revision === undefined)) throw new Error('MESSAGE_STATE_ANCHOR_REQUIRED');
      if (wrapper.state_revision !== undefined) uint64(wrapper.state_revision);
      const proposed = wrapper.participation === undefined ? undefined : participation(wrapper.participation, caps.house, this.options.recipientId);
      await validateWorldPayload(jsonObject(entry.body_schema), utf8.encode(JSON.stringify(wrapper.body)), { maxBytes: MAX_MESSAGE, signal: this.options.gate.signal });
      this.assertActive();
      // Policies can change during schema-worker execution too.
      if (!this.options.isOfficialActor(actor!)) return this.plain(originalText, 'MESSAGE_SOURCE_UNPRIVILEGED');
      const wrapperDigest = cidFromCanonical(utf8.encode(canonicalJson(wrapper)));
      // Everything above is authentication/validation. Failure from this point
      // is retryable storage failure, never successful ordinary-DM delivery.
      storageIdentity = { messageId: wrapper.message_id as string, eventId: envelope.eventId };
      const result = this.options.db.transaction(tx => {
        this.assertActive(); tables(tx);
        const messageId = wrapper.message_id as string;
        const previous = tx.queryOne<MessageRow>('SELECT * FROM world_private_messages_v2 WHERE binding=? AND message_id=?', [this.bindingId, messageId]);
        if (previous && previous.wrapper_digest !== wrapperDigest) return { kind: 'conflict', originalText: originalText!, reason: 'MESSAGE_ID_CONFLICT' } as const;
        if (!previous) tx.execute('INSERT INTO world_private_messages_v2 VALUES(?,?,?,?,?,?,?,?,1)', [this.bindingId, messageId, envelope.eventId, raw, plaintextBytes,
          cidFromCanonical(raw), cidFromCanonical(plaintextBytes), wrapperDigest]);
        let stateStatus: PrivateStateStatus = 'none';
        if (wrapper.delivery_class === 'state') {
          const stateRef = wrapper.state_ref as string; const revision = wrapper.state_revision as string;
          const digest = cidFromCanonical(utf8.encode(canonicalJson({ kind: wrapper.kind, schema_version: wrapper.schema_version, body: wrapper.body, participation: wrapper.participation ?? null })));
          const previousState = tx.queryOne<StateRow>('SELECT * FROM world_private_states_v2 WHERE binding=? AND state_ref=?', [this.bindingId, stateRef]);
          stateStatus = !previousState ? 'new' : BigInt(revision) < BigInt(previousState.revision) ? 'old' : BigInt(revision) > BigInt(previousState.revision) ? 'updated' : previousState.state_digest === digest ? 'duplicate' : 'conflict';
          if (previous && (stateStatus === 'new' || stateStatus === 'updated')) stateStatus = 'duplicate';
          if (!previous && (stateStatus === 'new' || stateStatus === 'updated')) tx.execute(`INSERT INTO world_private_states_v2 VALUES(?,?,?,?,?)
            ON CONFLICT(binding,state_ref) DO UPDATE SET revision=excluded.revision,state_digest=excluded.state_digest,message_id=excluded.message_id`, [this.bindingId, stateRef, revision, digest, messageId]);
        }
        this.assertActive();
        // Descriptor revision is independent of the private card's revision.
        // Return revalidated facts on replay too; only the dedicated descriptor
        // store decides monotonic merge, conflict handling and local authority.
        return { kind: 'structured', originalText: originalText!, wrapper, deliveryClass: wrapper.delivery_class as 'conversation' | 'receipt' | 'state', messageStatus: previous ? 'duplicate' : 'new', stateStatus,
          ...(proposed ? { proposedParticipation: proposed } : {}) } as const;
      });
      this.assertActive();
      return result;
    } catch {
      if (!this.active()) return { kind: 'dropped', reason: 'HOUSE_GATE_CLOSED' };
      if (storageIdentity) return { kind: 'storage_failed', reason: 'MESSAGE_STORAGE_FAILED', retryable: true, ...storageIdentity };
      return originalText === undefined ? { kind: 'dropped', reason: 'MESSAGE_AUTHENTICATION_FAILED' } : this.plain(originalText, 'MESSAGE_PARSE_PRESERVED');
    }
  }
  private plain(originalText: string, reason: string): PrivateWorldMessageResult {
    return this.active() ? { kind: 'plain', originalText, reason } : { kind: 'dropped', reason: 'HOUSE_GATE_CLOSED' };
  }
}
