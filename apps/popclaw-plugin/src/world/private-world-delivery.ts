import { decodeEnvelope, L_ENVELOPE_MAX_BYTES } from '../protocol/public-envelope.js';
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { TrustedWorldCapabilities } from './world-capabilities.js';
import { sameWorldHouse, worldPublicKey } from './action-wire.js';
import { participationDescriptorFromProto, validateParticipationDescriptor, type ParticipationDescriptor, type WorldParticipation } from './world-participation.js';
import type { WorldReadiness } from './world-readiness.js';
import type { PendingPrivateWorldMessage, PrivateMessageGate, PrivateWorldMessageResult, PrivateWorldMessages, StoredPrivateWorldMessage } from './private-world-messages.js';

type StructuredMessage = Extract<PrivateWorldMessageResult, { kind: 'structured' }>;
export type PrivateDeliveryResult = PrivateWorldMessageResult & {
  delivery?: 'handled' | 'already_handled' | 'pending';
  failure?: string;
};
/** Authenticated transport metadata. Text and wrapper content remain private
 * content, not commands or independently usable grants. Consumers use the
 * idempotency key because a crash after their effect may retry the callback. */
export interface PrivateDeliveryMessage {
  readonly house: popclaw.world.IHouseBinding;
  readonly actorId: string;
  readonly senderId: string;
  readonly eventId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly originalText: string;
  readonly envelopeBytes: Uint8Array;
  readonly signal: AbortSignal;
}
export interface StructuredPrivateDeliveryMessage extends PrivateDeliveryMessage {
  readonly wrapper: Readonly<Record<string, unknown>>;
  readonly deliveryClass: StructuredMessage['deliveryClass'];
  readonly stateStatus: StructuredMessage['stateStatus'];
}
export interface PrivateDeliveryFailure { readonly messageId?: string; readonly reason: string }
export interface PrivateDrainResult { attempted: number; handled: number; pending: boolean; failures: PrivateDeliveryFailure[] }
export interface PrivateWorldDeliveryOptions {
  readonly cache: PrivateWorldMessages;
  /** Same HostDb handle used by cache, readiness and policyFor. */
  readonly db: HostDb;
  readonly gate: PrivateMessageGate;
  readonly capabilities: TrustedWorldCapabilities;
  readonly currentCapabilities: () => TrustedWorldCapabilities | null;
  readonly actorId: string;
  readonly readiness: Pick<WorldReadiness, 'recordPrivateDescriptor' | 'view' | 'assertBinding' | 'invalidate' | 'clearInvalidation'>;
  readonly policyFor: (participationId: string) => WorldParticipation;
  /** Trusted same-house/actor registry; never derived from message bodies. */
  readonly participationIds: () => readonly string[];
  readonly onConversation: (message: StructuredPrivateDeliveryMessage) => void | Promise<void>;
  /** Recovery only. Initial plain receives return to the existing G0 inbox path. */
  readonly onPlain: (message: PrivateDeliveryMessage) => void | Promise<void>;
  readonly onReceipt?: (message: StructuredPrivateDeliveryMessage) => void | Promise<void>;
  readonly onState?: (message: StructuredPrivateDeliveryMessage) => void | Promise<void>;
  readonly onFailure?: (failure: PrivateDeliveryFailure) => void;
  readonly now?: () => string;
  readonly retryMs?: number;
}
export interface PrivateWorldDelivery {
  receive(envelope: Uint8Array): Promise<PrivateDeliveryResult>;
  /** One bounded keyset pass, coalesced with concurrent drain calls. */
  drain(): Promise<PrivateDrainResult>;
  /** Synchronous fence: never wait for a callback that may itself call stop. */
  stop(): void;
  /** Joins only already queued/in-flight work; callers stop before closing DB. */
  whenIdle(): Promise<void>;
}
interface PendingSource { event_id: string; message_id: string; envelope_bytes: Uint8Array; capability_revision: string }
const PAGE_SIZE = 64;
const MAX_DRAIN = 256;
function reason(error: unknown): string { return error instanceof Error ? error.message : 'MESSAGE_DELIVERY_FAILED'; }
function sameBytes(a: Uint8Array, b: Uint8Array): boolean { return a.length === b.length && a.every((byte, index) => byte === b[index]); }
function requireResult(result: { ok: boolean; code?: string }): void { if (!result.ok) throw new Error(result.code ?? 'MESSAGE_POLICY_FAILED'); }

/** Builds no timer or job. G0 starts recovery with drain after its factory is
 * installed. Only durable pending consumers or source facts cause a bounded retry timer;
 * a failed initial cache write is returned to ingress for transport redelivery. */
export function createPrivateWorldDelivery(options: PrivateWorldDeliveryOptions): PrivateWorldDelivery {
  const captured = structuredClone(options.capabilities);
  const house = captured.house;
  worldPublicKey(house.houseKey); worldPublicKey(options.actorId);
  if (house.origin !== options.gate.origin || !house.incarnation) throw new Error('MESSAGE_HOUSE_MISMATCH');
  const retryMs = options.retryMs ?? 1000;
  if (!Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 60000) throw new Error('MESSAGE_RETRY_INVALID');
  options.cache.assertBinding(options.db, house, options.actorId);
  options.readiness.assertBinding(options.db, house, options.actorId);
  const binding = JSON.stringify([house.origin, house.houseKey, house.incarnation, options.actorId]);
  options.db.execute(`CREATE TABLE IF NOT EXISTS world_private_delivery_sources (
    binding TEXT NOT NULL, event_id TEXT NOT NULL, message_id TEXT NOT NULL,
    envelope_bytes BLOB NOT NULL, capability_revision TEXT NOT NULL, PRIMARY KEY(binding,event_id))`);
  const localStop = new AbortController();
  const signal = AbortSignal.any([options.gate.signal, localStop.signal]);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tail = Promise.resolve();
  let flight: Promise<PrivateDrainResult> | undefined;
  let cursor: string | undefined;
  let sourceCursor: string | undefined;
  const active = (): boolean => !stopped && !signal.aborted && options.gate.isActive();
  function assertCurrent(): void {
    if (!active()) throw new Error('HOUSE_GATE_CLOSED');
    const current = options.currentCapabilities();
    if (!current || !sameWorldHouse(current.house, house) || current.capabilityRevision !== captured.capabilityRevision) throw new Error('WORLD_CAPABILITIES_CHANGED');
  }
  function notify(failure: PrivateDeliveryFailure): void { try { options.onFailure?.(failure); } catch { /* Diagnostics never acknowledge delivery. */ } }
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = tail.then(work);
    tail = result.then(() => {}, () => {});
    return result;
  }
  function stop(): void {
    stopped = true; options.gate.signal.removeEventListener('abort', stop); localStop.abort();
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  }
  // The lifecycle signal fences timers too, even when no callback is running.
  options.gate.signal.addEventListener('abort', stop, { once: true });
  function isPending(messageId: string): boolean {
    assertCurrent();
    return options.cache.isPending(messageId);
  }
  function sourceRows(limit: number, after = ''): PendingSource[] {
    return options.db.queryAll<PendingSource>(`SELECT event_id,message_id,envelope_bytes,capability_revision
      FROM world_private_delivery_sources WHERE binding=? AND event_id>? ORDER BY event_id LIMIT ?`, [binding, after, limit]);
  }
  function forgetSource(eventId: string): void {
    options.db.execute('DELETE FROM world_private_delivery_sources WHERE binding=? AND event_id=?', [binding, eventId]);
  }
  function pending(): boolean { return options.cache.pending(1).length > 0 || sourceRows(1).length > 0; }
  function armRetry(): void {
    try { assertCurrent(); } catch {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      return;
    }
    let needed = true;
    try { needed = pending(); } catch { /* Unknown storage state needs another bounded attempt. */ }
    if (!needed) {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
      cursor = undefined; sourceCursor = undefined; return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; void drain(); }, retryMs);
    timer.unref?.();
  }
  function metadata(stored: StoredPrivateWorldMessage, originalText: string): PrivateDeliveryMessage {
    const envelope = decodeEnvelope(stored.envelopeBytes);
    const senderId = envelope.actor?.popclawId, targets = envelope.target?.targetIds ?? [];
    if (!senderId || envelope.eventId !== stored.eventId || envelope.directMessage?.fromPopclawId !== senderId
      || envelope.directMessage.toPopclawId !== options.actorId || envelope.target?.scope !== 1
      || targets.length !== 1 || targets[0] !== options.actorId) throw new Error('MESSAGE_RECOVERY_BINDING_MISMATCH');
    return { house: structuredClone(house), actorId: options.actorId, senderId, eventId: envelope.eventId,
      messageId: stored.messageId, idempotencyKey: JSON.stringify([house.origin, house.houseKey, house.incarnation, options.actorId, stored.messageId]),
      originalText, envelopeBytes: new Uint8Array(stored.envelopeBytes), signal };
  }
  function policiesFor(descriptor?: ParticipationDescriptor): Map<string, WorldParticipation> {
    const ids = new Set(options.participationIds());
    if (descriptor) ids.add(descriptor.participation_id);
    const policies = new Map([...ids].map(id => [id, options.policyFor(id)]));
    for (const [id, policy] of policies) policy.assertBinding(options.db, house, options.actorId, id);
    return policies;
  }
  function commitFacts(eventIds: readonly string[], messageId?: string, descriptor?: ParticipationDescriptor, plain = false): void {
    assertCurrent();
    // Initialize memoized policy objects outside the transaction so rollback
    // cannot leave cached objects whose initial durable row was rolled back.
    const policies = policiesFor(descriptor);
    options.db.transaction(() => {
      assertCurrent();
      for (const policy of policies.values()) {
        for (const eventId of new Set(eventIds)) requireResult(policy.sourceArrived(eventId));
      }
      if (descriptor) {
        options.readiness.recordPrivateDescriptor(descriptor.participation_id);
        options.readiness.clearInvalidation(descriptor.participation_id);
        const trustedCurrent = options.readiness.view(descriptor.participation_id).ready;
        requireResult(policies.get(descriptor.participation_id)!.mergeAuthenticatedDescriptor(descriptor,
          { source: 'verified_private_state', trustedCurrent, capabilityRevision: captured.capabilityRevision },
          options.now?.() ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')));
      }
      assertCurrent();
      for (const eventId of new Set(eventIds)) forgetSource(eventId);
      if (messageId !== undefined) {
        options.cache.markHandled(messageId);
        if (plain) options.db.execute('DELETE FROM world_private_delivery_sources WHERE binding=? AND message_id=?', [binding, messageId]);
      }
      assertCurrent();
    });
  }
  async function attempt(raw: Uint8Array, recovery?: PendingPrivateWorldMessage, source?: PendingSource): Promise<PrivateDeliveryResult> {
    let result: PrivateWorldMessageResult | undefined;
    let messageId = recovery?.messageId ?? source?.message_id;
    const affected = new Set<string>();
    try {
      assertCurrent();
      result = await options.cache.receive(raw);
      assertCurrent();
      if (result.kind === 'structured') {
        messageId = result.wrapper.message_id as string;
        if (recovery && messageId !== recovery.messageId) throw new Error('MESSAGE_RECOVERY_BINDING_MISMATCH');
        const currentEventId = decodeEnvelope(raw).eventId;
        if (source && (source.event_id !== currentEventId || source.message_id !== messageId)) throw new Error('MESSAGE_RECOVERY_BINDING_MISMATCH');
        try {
          options.db.execute(`INSERT INTO world_private_delivery_sources(binding,event_id,message_id,envelope_bytes,capability_revision)
            VALUES(?,?,?,?,?) ON CONFLICT(binding,event_id) DO NOTHING`, [binding, currentEventId, messageId, raw, captured.capabilityRevision]);
        } catch {
          notify({ messageId, reason: 'MESSAGE_SOURCE_STORAGE_FAILED' });
          return { kind: 'storage_failed', reason: 'MESSAGE_STORAGE_FAILED', retryable: true, messageId, eventId: currentEventId, failure: 'MESSAGE_SOURCE_STORAGE_FAILED' };
        }
        if (!isPending(messageId)) {
          // The original delivery already recorded its CID transactionally.
          // A re-encrypted duplicate can supply a new, independently verified CID.
          for (const id of options.participationIds()) affected.add(id);
          commitFacts([currentEventId]);
          return { ...result, delivery: 'already_handled' };
        }
        const stored = options.cache.readMessage(messageId);
        if (!stored) throw new Error('MESSAGE_STORAGE_MISSING');
        let original = result;
        if (!sameBytes(stored.envelopeBytes, raw)) {
          // A callback must never receive cache bytes that were not revalidated
          // under this captured context. Timer recovery handles a plain downgrade.
          assertCurrent();
          const revalidated = await options.cache.receive(stored.envelopeBytes);
          assertCurrent();
          if (revalidated.kind !== 'structured' || revalidated.wrapper.message_id !== messageId) throw new Error('MESSAGE_ORIGINAL_REVALIDATION_FAILED');
          original = revalidated;
        }
        // Only the cache's authenticated, actor/house-bound proposal identifies
        // the policy to fence. Never infer this identity from wrapper/body text.
        const proposal = original.stateStatus !== 'old' && original.stateStatus !== 'conflict' ? original.proposedParticipation : undefined;
        if (proposal) affected.add(proposal.participationId);
        const descriptor = proposal ? validateParticipationDescriptor(participationDescriptorFromProto(proposal), house, options.actorId) : undefined;
        policiesFor(descriptor); // Reject cross-database wiring before consumer effects.
        const message: StructuredPrivateDeliveryMessage = { ...metadata(stored, original.originalText), wrapper: structuredClone(original.wrapper),
          deliveryClass: original.deliveryClass, stateStatus: original.stateStatus };
        const consumer = original.deliveryClass === 'conversation' ? options.onConversation
          : original.deliveryClass === 'receipt' ? options.onReceipt : options.onState;
        // Receipt/state are already durably readable through readMessage. Their
        // optional UI consumers do not manufacture conversation notifications.
        if (consumer) { assertCurrent(); await consumer(message); assertCurrent(); }
        for (const id of options.participationIds()) affected.add(id);
        commitFacts([stored.eventId, currentEventId], messageId, descriptor);
        return { ...result, delivery: 'handled' };
      }
      if (source && result.kind !== 'storage_failed') {
        // This separately queued CID no longer has structured authority under
        // current authentication/schema. Its consumer ACK remains untouched.
        // In particular, revoked officials never create source-arrival facts.
        assertCurrent(); forgetSource(source.event_id); assertCurrent();
        return { ...result, delivery: 'already_handled' };
      }
      if (result.kind === 'plain' && recovery) {
        const stored = options.cache.readMessage(recovery.messageId);
        if (!stored || !sameBytes(stored.envelopeBytes, raw) || stored.eventId !== recovery.eventId) throw new Error('MESSAGE_RECOVERY_BINDING_MISMATCH');
        const message = metadata(stored, result.originalText);
        assertCurrent(); await options.onPlain(message); assertCurrent();
        commitFacts([], stored.messageId, undefined, true);
        return { ...result, delivery: 'handled' };
      }
      return result;
    } catch (error) {
      // The outer transaction rolls back a nested merge's invalidation too.
      // Reapply the fence after rollback, independently of retaining cache ACK
      // and source work. These stores latch memory before attempting SQLite so
      // even a persistent write failure cannot leave old execution authority.
      for (const id of affected) {
        try {
          const policy = options.policyFor(id); policy.assertBinding(options.db, house, options.actorId, id);
          const invalidated = policy.invalidate('untrusted');
          if (!invalidated.ok) notify({ messageId, reason: invalidated.code ?? 'MESSAGE_POLICY_INVALIDATION_FAILED' });
        } catch (failure) { notify({ messageId, reason: reason(failure) }); }
        try { options.readiness.invalidate(id); } catch (failure) { notify({ messageId, reason: reason(failure) }); }
      }
      const failure = { ...(messageId ? { messageId } : {}), reason: reason(error) };
      notify(failure);
      if (!active() || failure.reason === 'WORLD_CAPABILITIES_CHANGED') return { kind: 'dropped', reason: failure.reason };
      return result ? { ...result, delivery: 'pending', failure: failure.reason } : { kind: 'dropped', reason: failure.reason };
    }
  }
  function receive(envelope: Uint8Array): Promise<PrivateDeliveryResult> {
    if (!(envelope instanceof Uint8Array) || !envelope.length || envelope.length > L_ENVELOPE_MAX_BYTES) return Promise.resolve({ kind: 'dropped', reason: 'MESSAGE_ENVELOPE_SIZE_LIMIT' });
    const raw = new Uint8Array(envelope);
    return serial(async () => {
      try { return await attempt(raw); }
      finally { armRetry(); }
    });
  }
  function drain(): Promise<PrivateDrainResult> {
    if (flight) return flight;
    flight = serial(async () => {
      const report: PrivateDrainResult = { attempted: 0, handled: 0, pending: false, failures: [] };
      try {
        assertCurrent();
        while (report.attempted < MAX_DRAIN / 2) {
          assertCurrent();
          const rows = options.cache.pending(Math.min(PAGE_SIZE, MAX_DRAIN / 2 - report.attempted), cursor);
          if (!rows.length) { cursor = undefined; break; }
          for (const row of rows) {
            assertCurrent();
            const outcome = await attempt(new Uint8Array(row.envelopeBytes), row);
            cursor = row.messageId; report.attempted++;
            if (outcome.delivery === 'handled' || outcome.delivery === 'already_handled') report.handled++;
            else report.failures.push({ messageId: row.messageId, reason: outcome.failure ?? (outcome.kind === 'structured' ? 'MESSAGE_DELIVERY_FAILED' : outcome.reason) });
            assertCurrent();
          }
        }
        let sourceScanned = 0;
        while (sourceScanned < MAX_DRAIN / 2) {
          assertCurrent();
          const rows = sourceRows(Math.min(PAGE_SIZE, MAX_DRAIN / 2 - sourceScanned), sourceCursor);
          if (!rows.length) { sourceCursor = undefined; break; }
          for (const row of rows) {
            assertCurrent(); sourceCursor = row.event_id; sourceScanned++;
            // Pending consumers were already visited by the other bounded lane.
            // The source lane retries only independently ACKed duplicates.
            if (isPending(row.message_id)) continue;
            const outcome = await attempt(new Uint8Array(row.envelope_bytes), undefined, row);
            report.attempted++;
            if (outcome.delivery === 'handled' || outcome.delivery === 'already_handled') report.handled++;
            else report.failures.push({ messageId: row.message_id, reason: outcome.failure ?? (outcome.kind === 'structured' ? 'MESSAGE_DELIVERY_FAILED' : outcome.reason) });
            assertCurrent();
          }
        }
        report.pending = pending();
      } catch (error) {
        const failure = { reason: reason(error) }; report.failures.push(failure); report.pending = true; notify(failure);
      } finally { armRetry(); }
      return report;
    });
    const current = flight;
    void current.then(() => { if (flight === current) flight = undefined; }, () => { if (flight === current) flight = undefined; });
    return current;
  }
  return { receive, drain, stop, whenIdle: () => tail };
}
