import { decodeEnvelope, L_ENVELOPE_MAX_BYTES } from '../protocol/public-envelope.js';
/** First-increment private message consumer for the existing G0 inbox lane.
 *
 * One consumer owns one recipient+House execution partition behind a G0-captured
 * gate. It classifies inbox envelopes through the first-release evidence path,
 * persists authenticated structured material durably, keeps the ordinary DM
 * fallback for G0 to route with the original bytes, and exposes
 * `receive`/bounded `drain`/`stop`/`whenIdle` compatible (through
 * {@link adaptPrivateMessageConsumer}) with the existing HouseInboxConsumer
 * contract.
 *
 * Outcome discriminants are fixed: `consumed` (durable structured material,
 * possibly a re-encryption duplicate), `ordinary_fallback` (authenticated
 * ordinary DM text plus reason — G0 alone routes it; an unavailable private
 * board/guide never turns this into a storage failure), `permanent_invalid`
 * (authentication/binding failure: never retried, never thrown into the
 * reconnect loop), `retryable_storage` (storage or durable-currentness
 * failure: safe to redeliver; nothing was acknowledged). The durable effect of
 * this increment is exactly the recipient-private local material record;
 * marking the cache handled is NOT user or peer read acknowledgement. */
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { Signer } from '../identity/signer.js';
import type { HouseInboxConsumer } from '../runtime/house-lifecycle/resource-set.js';
import {
  classifyPrivateMessage, privateMessageBindingId, selectFirstReleasePrivateEvidence,
  type FirstReleasePrivateEvidence, type PrivateMessageDeliveryClass, type FirstReleasePrivateSelection,
} from './private-message-evidence.js';
import {
  assertPrivateMessageJournalSchema, hasPendingPrivateMessages, markPrivateMessageHandled,
  pendingPrivateMessageRows, storeStructuredPrivateMessage, type PrivateStateWriteStatus,
} from './private-message-storage.js';
import type { HouseCapabilityView } from './world-capabilities.js';

const DRAIN_PAGE = 64;
const DRAIN_MAX = 256;
const MAX_ENVELOPE = L_ENVELOPE_MAX_BYTES;

export type PrivateMessageReceiveOutcome =
  | { readonly outcome: 'consumed'; readonly messageId: string; readonly eventId: string;
      readonly deliveryClass: PrivateMessageDeliveryClass; readonly duplicate: boolean;
      readonly stateStatus: PrivateStateWriteStatus }
  | { readonly outcome: 'ordinary_fallback'; readonly reason: string; readonly originalText: string }
  | { readonly outcome: 'permanent_invalid'; readonly reason: string }
  | { readonly outcome: 'retryable_storage'; readonly reason: string; readonly messageId?: string; readonly eventId?: string };

export interface PrivateDrainFallback {
  readonly messageId: string; readonly reason: string; readonly originalText: string;
  readonly dm: popclaw.event.IDirectMessage; readonly envelope: Uint8Array; readonly nickname: string;
}
export type PrivateDrainRouter = (fallback: PrivateDrainFallback) => void | Promise<void>;
export interface PrivateDrainOutcome {
  readonly attempted: number; readonly handled: number; readonly pending: boolean;
  readonly failures: ReadonlyArray<{ readonly messageId?: string; readonly reason: string }>;
  /** Rows downgraded under current facts, routed through the drain router and
   * then completed. Never silently dropped. */
  readonly fallbacks: ReadonlyArray<{ readonly messageId: string; readonly reason: string }>;
}

export interface PrivateMessageConsumerOptions {
  /** Prepared protected execution DB; asserted at construction and per use. */
  readonly executionDb: HostDb;
  /** G0-captured gate; its origin must match the selected view's house. */
  readonly gate: { readonly origin: string; readonly signal: AbortSignal; isActive(): boolean };
  /** G0-supplied durable currentness (actor/origin/pin/incarnation/session/op_seq/
   * fence/lease, current selected view, protected partition, applicable holds).
   * Rechecked before every commit and every material exposure, after awaits. */
  assertCurrent(): void;
  readonly recipientId: string;
  /** Current captured view; read fresh, never cached across awaits. */
  view(): HouseCapabilityView | null;
  readonly recipient: Pick<Signer, 'openDm'>;
  readonly isOfficialActor: (actorId: string) => boolean;
  readonly onError?: (error: unknown) => void;
}
export interface PrivateMessageConsumer {
  /** Classify and persist one inbox envelope. The caller's buffer is snapshot
   * synchronously before any queued work; all trusted facts come from the
   * envelope itself, never from transport dm/nickname arguments. */
  receiveMessage(envelopeBytes: Uint8Array): Promise<PrivateMessageReceiveOutcome>;
  /** One bounded recovery pass over durable pending rows. Rows that downgrade
   * to ordinary text under current facts are routed through `route` (or the
   * configured router) BEFORE their local completion; a routing failure or a
   * missing router leaves the row durably pending and reported — never lost. */
  drain(route?: PrivateDrainRouter): Promise<PrivateDrainOutcome>;
  /** Install the standing router used by poll-driven drains (before traffic). */
  setDrainRouter(route: PrivateDrainRouter | undefined): void;
  /** Lightweight G0-cadence hook: drain only when durable pending work exists. */
  poll(): void;
  /** Synchronous fence; never waits for the callback that triggered stop. */
  stop(): void;
  whenIdle(): Promise<void>;
}

function codeOf(error: unknown, fallback: string): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message) ? error.message : fallback;
}

export function createPrivateMessageConsumer(options: PrivateMessageConsumerOptions): PrivateMessageConsumer {
  const { executionDb, gate, recipientId, recipient, isOfficialActor } = options;
  if (typeof recipientId !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipientId)) throw new Error('PRIVATE_RECIPIENT_INVALID');
  if (typeof gate.origin !== 'string' || !gate.origin.length) throw new Error('PRIVATE_GATE_INVALID');
  // No lazy DDL on the live path: the feature must already be prepared.
  assertPrivateMessageJournalSchema(executionDb);
  const localStop = new AbortController();
  const signal = AbortSignal.any([gate.signal, localStop.signal]);
  let stopped = false;
  let tail = Promise.resolve();
  let drainFlight: Promise<PrivateDrainOutcome> | undefined;
  let drainRouter: PrivateDrainRouter | undefined;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work);
    tail = result.then(() => {}, () => {});
    return result;
  };
  const fence = (): boolean => !stopped && !signal.aborted && gate.isActive();
  const checkedAssert = (): void => {
    if (!fence()) throw new Error('PRIVATE_CONSUMER_STOPPED');
    options.assertCurrent();
  };
  const selection = (): FirstReleasePrivateSelection => {
    const picked = selectFirstReleasePrivateEvidence(options.view(), recipientId);
    if (picked.available && picked.evidence.house.origin !== gate.origin)
      return { available: false, reason: 'PRIVATE_GATE_HOUSE_MISMATCH' };
    return picked;
  };

  async function persistStructured(evidence: FirstReleasePrivateEvidence, classification: {
    wrapper: Readonly<Record<string, unknown>>; eventId: string; envelopeBytes: Uint8Array; plaintextBytes: Uint8Array;
    wrapperDigest: string; deliveryClass: PrivateMessageDeliveryClass;
  }): Promise<PrivateMessageReceiveOutcome> {
    const messageId = classification.wrapper.message_id;
    if (typeof messageId !== 'string' || !/^[A-Za-z0-9_./:-]{1,128}$/.test(messageId)) return { outcome: 'permanent_invalid', reason: 'MESSAGE_ID_INVALID' };
    const binding = privateMessageBindingId(evidence);
    try {
      const stored = executionDb.transaction(() => {
        checkedAssert();
        const result = storeStructuredPrivateMessage(executionDb, {
          binding, messageId, eventId: classification.eventId,
          envelopeBytes: classification.envelopeBytes, plaintextBytes: classification.plaintextBytes,
          wrapperDigest: classification.wrapperDigest, deliveryClass: classification.deliveryClass, wrapper: classification.wrapper,
        });
        checkedAssert();
        return result;
      });
      if (stored.status === 'conflict') return { outcome: 'permanent_invalid', reason: stored.reason };
      return { outcome: 'consumed', messageId, eventId: classification.eventId,
        deliveryClass: classification.deliveryClass, duplicate: stored.messageStatus === 'duplicate', stateStatus: stored.stateStatus };
    } catch (error) {
      if (!fence()) return { outcome: 'retryable_storage', reason: 'PRIVATE_CONSUMER_STOPPED', messageId };
      return { outcome: 'retryable_storage', reason: codeOf(error, 'PRIVATE_STORAGE_FAILED'), messageId, eventId: classification.eventId };
    }
  }

  async function classifyAndStore(raw: Uint8Array): Promise<PrivateMessageReceiveOutcome> {
    if (!fence()) return { outcome: 'retryable_storage', reason: 'PRIVATE_CONSUMER_STOPPED' };
    try { checkedAssert(); } catch (error) { return { outcome: 'retryable_storage', reason: codeOf(error, 'PRIVATE_ASSERT_CURRENT_FAILED') }; }
    const picked = selection();
    let boundaryFailure: string | undefined;
    const classification = await classifyPrivateMessage(raw, {
      recipientId, selection: picked, recipient, isOfficialActor, signal,
      onAsyncBoundary: () => { try { checkedAssert(); } catch (error) { boundaryFailure ??= codeOf(error, 'PRIVATE_ASSERT_CURRENT_FAILED'); } },
    });
    try { checkedAssert(); } catch (error) { return { outcome: 'retryable_storage', reason: codeOf(error, 'PRIVATE_ASSERT_CURRENT_FAILED') }; }
    if (boundaryFailure) return { outcome: 'retryable_storage', reason: boundaryFailure };
    if (classification.kind === 'structured') {
      // Only structured intake depends on structured evidence staying current;
      // ordinary fallback and permanent-invalid dispatch without it.
      const rechecked = selection();
      if (!rechecked.available) return { outcome: 'retryable_storage', reason: rechecked.reason };
      if (!picked.available) return { outcome: 'retryable_storage', reason: 'PRIVATE_EVIDENCE_LOST' };
      if (rechecked.evidence.capabilityRevision !== picked.evidence.capabilityRevision)
        return { outcome: 'retryable_storage', reason: 'CAPABILITY_REVISION_CHANGED' };
      return persistStructured(picked.evidence, classification);
    }
    if (classification.kind === 'dropped') {
      if (!fence()) return { outcome: 'retryable_storage', reason: 'PRIVATE_CONSUMER_STOPPED' };
      return { outcome: 'permanent_invalid', reason: classification.reason };
    }
    return { outcome: 'ordinary_fallback', reason: classification.reason, originalText: classification.originalText };
  }

  const receiveMessage = (originalEnvelope: Uint8Array): Promise<PrivateMessageReceiveOutcome> => {
    if (!(originalEnvelope instanceof Uint8Array) || !originalEnvelope.length || originalEnvelope.length > MAX_ENVELOPE)
      return Promise.resolve({ outcome: 'permanent_invalid', reason: 'MESSAGE_ENVELOPE_SIZE_LIMIT' });
    // Synchronous snapshot before enqueueing: later queue work can never observe
    // a caller mutating its transport buffer after the call returned.
    const raw = new Uint8Array(originalEnvelope);
    return serial(() => classifyAndStore(raw));
  };

  const drain = (route?: PrivateDrainRouter): Promise<PrivateDrainOutcome> => {
    if (drainFlight) return drainFlight;
    drainFlight = serial(async (): Promise<PrivateDrainOutcome> => {
      const activeRoute = route ?? drainRouter;
      const report: { attempted: number; handled: number; pending: boolean; failures: { messageId?: string; reason: string }[]; fallbacks: { messageId: string; reason: string }[] }
        = { attempted: 0, handled: 0, pending: false, failures: [], fallbacks: [] };
      let binding: string | null = null;
      try {
        checkedAssert();
        const picked = selection();
        if (!picked.available) return report;
        const evidence = picked.evidence;
        binding = privateMessageBindingId(evidence);
        let after = '';
        let halted = false;
        while (!halted && report.attempted < DRAIN_MAX) {
          checkedAssert();
          const rows = pendingPrivateMessageRows(executionDb, binding!, Math.min(DRAIN_PAGE, DRAIN_MAX - report.attempted), after);
          if (!rows.length) break;
          for (const row of rows) {
            after = row.message_id; report.attempted++;
            try { checkedAssert(); } catch (error) { report.failures.push({ messageId: row.message_id, reason: codeOf(error, 'PRIVATE_ASSERT_CURRENT_FAILED') }); halted = true; break; }
            let boundaryFailure: string | undefined;
            const classification = await classifyPrivateMessage(row.envelope_bytes, {
              recipientId, selection: picked, recipient, isOfficialActor, signal,
              onAsyncBoundary: () => { try { checkedAssert(); } catch (error) { boundaryFailure ??= codeOf(error, 'PRIVATE_ASSERT_CURRENT_FAILED'); } },
            });
            // Durable currentness is rechecked after EVERY classification await
            // (plain classification never reaches the schema worker, so its
            // onAsyncBoundary hook alone is insufficient) and again below,
            // immediately before any material leaves this module.
            try { checkedAssert(); } catch (error) {
              report.failures.push({ messageId: row.message_id, reason: boundaryFailure ?? codeOf(error, 'PRIVATE_ASSERT_CURRENT_FAILED') });
              halted = true; break;
            }
            if (boundaryFailure || !fence()) { report.failures.push({ messageId: row.message_id, reason: boundaryFailure ?? 'PRIVATE_CONSUMER_STOPPED' }); halted = true; break; }
            if (classification.kind === 'structured') {
              if (classification.wrapper.message_id !== row.message_id) {
                report.failures.push({ messageId: row.message_id, reason: 'PRIVATE_RECOVERY_BINDING_MISMATCH' });
                continue;
              }
              try {
                executionDb.transaction(() => {
                  checkedAssert();
                  const stored = storeStructuredPrivateMessage(executionDb, {
                    binding: binding!, messageId: row.message_id, eventId: row.event_id,
                    envelopeBytes: row.envelope_bytes, plaintextBytes: row.plaintext_bytes,
                    wrapperDigest: row.wrapper_digest, deliveryClass: classification.deliveryClass, wrapper: classification.wrapper,
                  });
                  if (stored.status !== 'stored' || stored.messageStatus !== 'duplicate') throw new Error('PRIVATE_RECOVERY_ROW_MISSING');
                  if (!markPrivateMessageHandled(executionDb, binding!, row.message_id)) throw new Error('PRIVATE_RECOVERY_ROW_MISSING');
                  checkedAssert();
                });
                report.handled++;
              } catch (error) {
                report.failures.push({ messageId: row.message_id, reason: codeOf(error, 'PRIVATE_STORAGE_FAILED') });
                halted = true; break;
              }
            } else if (classification.kind === 'plain') {
              // Downgraded to ordinary text under current facts. Route the
              // ORIGINAL envelope and metadata first; only a successful routing
              // completes the row locally. Without a router the row stays durably
              // pending and reported — never silently dropped.
              if (!activeRoute) { report.failures.push({ messageId: row.message_id, reason: 'PRIVATE_DRAIN_FALLBACK_UNROUTED' }); continue; }
              try {
                // Last durable gate BEFORE decrypted material reaches the host
                // callback: a session revoked after classification must never
                // be routed, and the row must stay durably pending.
                checkedAssert();
                const envelope = decodeEnvelope(row.envelope_bytes);
                const dm = envelope.directMessage;
                if (!dm) throw new Error('PRIVATE_RECOVERY_BINDING_MISMATCH');
                await activeRoute({ messageId: row.message_id, reason: classification.reason, originalText: classification.originalText,
                  dm, envelope: new Uint8Array(row.envelope_bytes), nickname: envelope.actor?.nickname ?? '' });
                executionDb.transaction(() => {
                  checkedAssert();
                  if (!markPrivateMessageHandled(executionDb, binding!, row.message_id)) throw new Error('PRIVATE_RECOVERY_ROW_MISSING');
                  checkedAssert();
                });
                report.handled++;
                report.fallbacks.push({ messageId: row.message_id, reason: classification.reason });
              } catch (error) {
                report.failures.push({ messageId: row.message_id, reason: codeOf(error, 'PRIVATE_DRAIN_FALLBACK_FAILED') });
                continue;
              }
            } else {
              report.failures.push({ messageId: row.message_id, reason: classification.reason });
            }
          }
        }
        report.pending = fence() ? hasPendingPrivateMessages(executionDb, binding!) : true;
      } catch (error) {
        report.pending = true;
        report.failures.push({ messageId: undefined, reason: codeOf(error, 'PRIVATE_DRAIN_FAILED') });
      }
      return report;
    });
    const current = drainFlight;
    void current.then(() => { if (drainFlight === current) drainFlight = undefined; }, () => { if (drainFlight === current) drainFlight = undefined; });
    return current;
  };

  const poll = (): void => {
    if (!fence() || drainFlight) return;
    const picked = selection();
    if (!picked.available) return;
    const binding = privateMessageBindingId(picked.evidence);
    if (!hasPendingPrivateMessages(executionDb, binding)) return;
    void drain().catch(error => options.onError?.(error));
  };

  return {
    receiveMessage,
    drain,
    setDrainRouter(route: PrivateDrainRouter | undefined): void {
      if (drainFlight) throw new Error('PRIVATE_DRAIN_IN_FLIGHT');
      drainRouter = route;
    },
    poll,
    stop(): void { stopped = true; localStop.abort(); },
    whenIdle: () => tail,
  };
}

export interface PrivateFallbackRouting {
  /** G0's sole ordinary-fallback owner: called once per receive attempt with
   * the ORIGINAL bytes and metadata plus the authenticated plaintext. */
  route(fallback: {
    readonly dm: popclaw.event.IDirectMessage; readonly envelope: Uint8Array; readonly nickname: string;
    readonly originalText: string; readonly reason: string;
  }): void | Promise<void>;
  /** Diagnostics only; never an acknowledgement. */
  onError?(error: unknown): void;
}
/** Small G0 adapter to the existing HouseInboxConsumer contract: consumed and
 * permanently-invalid outcomes settle silently (the latter reported through
 * onError so it can never loop the transport), retryable storage failures
 * throw to the transport's replay boundary, and ordinary fallback routes
 * through G0's original handler. Routing work is tracked: whenIdle joins both
 * the consumer and in-flight routings, and a stopped adapter begins no new
 * callbacks. A routing failure stays retryable and can never duplicate
 * already-durable structured material. */
export function adaptPrivateMessageConsumer(consumer: PrivateMessageConsumer, routing: PrivateFallbackRouting): HouseInboxConsumer {
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  const track = (task: Promise<void>): Promise<void> => {
    inFlight.add(task);
    void task.finally(() => { inFlight.delete(task); }).catch(() => {});
    return task;
  };
  const route: PrivateDrainRouter = fallback => routing.route({
    dm: fallback.dm, envelope: fallback.envelope, nickname: fallback.nickname,
    originalText: fallback.originalText, reason: fallback.reason,
  });
  consumer.setDrainRouter(route);
  return {
    receive: (dm, envelope, nickname) => {
      if (stopped) return Promise.reject(new Error('PRIVATE_ADAPTER_STOPPED'));
      const raw = new Uint8Array(envelope);
      return track((async () => {
        const outcome = await consumer.receiveMessage(raw);
        if (outcome.outcome === 'consumed') return;
        if (outcome.outcome === 'permanent_invalid') { routing.onError?.(new Error(outcome.reason)); return; }
        if (outcome.outcome === 'retryable_storage') throw new Error(outcome.reason);
        await routing.route({ dm, envelope: raw, nickname, originalText: outcome.originalText, reason: outcome.reason });
      })());
    },
    drain: () => consumer.drain(route),
    poll: () => consumer.poll(),
    stop: () => { stopped = true; consumer.stop(); },
    whenIdle: async () => { await consumer.whenIdle(); await Promise.allSettled([...inFlight]); },
  };
}
