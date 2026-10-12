import { inspectPublicCarrier } from './public-stream-wire.js';
import { decodeEnvelope } from '../protocol/public-envelope.js';
/**
 * PublicWorldStreamClient — issue #553 batch C: one public world subscription
 * per house, the receiving side.
 *
 * Frames off GET /v1/world-stream are `WorldStreamFrame{seq, envelope
 * (verbatim bytes), kind, projection?}`. This receiver does exactly four
 * things: receive → persist (the `world_stream` table, event_id-idempotent) →
 * advance the cursor (`world_stream_cursor`, only after the row is durable) →
 * dispatch by use. **It never decides "what is worth showing the owner"** —
 * the content view (WorldFeedCache), the Ranger quest handlers, and the
 * verification notifications register as consumers.
 *
 * Relationship to the old channels (swapped in when
 * `POPCLAW_WORLD_STREAM=1`; default off keeps the old paths):
 * - Replaces WorldFeedStreamClient: content frames carry the baked
 *   projection, and `onContent` receives an item whose `.envelope` field has
 *   been reloaded with the frame-level verbatim bytes (the raw-BLOB invariant
 *   "every row always has its protobuf" is preserved).
 * - Replaces the Ranger's SseIngress: implements EventIngress, feeding
 *   decoded envelopes to start()'s handler. The persisted event_id idempotency
 *   means reconnects/replays never re-dispatch — stronger than the old
 *   in-memory SeenSet, which reset on every process restart.
 *
 * The server-side overlap at the backfill/live boundary is deduped by
 * event_id (INSERT OR IGNORE reporting changes==0 means "already seen" and
 * skips dispatch). The crash window (stored but not yet completed) is the
 * same class the old SeenSet had, backstopped by existing task idempotency
 * (server-side 409 / watch registry state machine).
 */

import { createHostAsyncScope } from '../host/local-host-adapter.js';
import type { VerifiedPublicStreamCapability } from '../world/world-capabilities.js';
import {
  PublicStreamJournal, rebuildPublicJournalProjection,
  type PublicSelection, type PublicReceiveGate, type VerifiedPublicProducerPolicy,
  type PublicConsumer, type PublicReceiveStatus, type PublicConsumerStatus, type PublicProjectionRebuildOptions,
} from '../world/scoped-stream-journal.js';
export type { PublicProjectionRebuildOptions } from '../world/scoped-stream-journal.js';
import { consumePublicSse, scopedBase64 } from '../world/scoped-sse.js';
import { decodePublicControl } from './public-stream-wire.js';
import EventSource from 'eventsource';
import { verifyInboundEnvelope } from './verify-envelope.js';
import type { HouseGate } from '../runtime/house-lifecycle/manager.js';
import { popclaw } from '@popclaw/contracts';
import type { HostDb } from '../host/host-db.js';
import type { EnvelopeHandler, EventIngress } from './event-ingress.js';
import type { AnyEventSource } from './world-feed-stream-client.js';

/** Content-kind labels (frames that carry a projection into the content cache). */
const CONTENT_KINDS = new Set(['post', 'reply']);

export interface PublicWorldStreamOptions {
  readonly baseUrl: string;
  readonly gate?: Pick<HouseGate, 'isActive' | 'signal'>;
  readonly isOfficialActor?: (actorId: string) => boolean;
  /** This house's SQLite handle (same file as the WorldFeedCache). */
  readonly db: HostDb;
  /** Backfill size (the server clamps to 1..=5000). Default 5000. */
  readonly limit?: number;
  /** Content consumer: item.envelope holds the frame-level verbatim bytes. */
  readonly onContent?: (item: popclaw.event.IWorldFeedItem) => void;
  readonly onError?: (err: unknown) => void;
  /** Application retry delay; defaults to 5–10s jitter. */
  readonly reconnectDelayMs?: number;
  /** Injection point for tests (a fake EventSource ctor). */
  readonly eventSourceCtor?: new (url: string) => AnyEventSource;
}

/** A frame as the receiver sees it. */
interface ReceivedFrame {
  readonly seq: number;
  readonly eventId: string;
  readonly kind: string;
  readonly envelope: Uint8Array;
  readonly projection: popclaw.event.IWorldFeedItem | null;
}

export class PublicWorldStreamClient implements EventIngress {
  private es: AnyEventSource | null = null;
  private stopped = false;
  private receiving = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private handler: EnvelopeHandler | null = null;
  private connectedCallbacks: Array<() => void> = [];
  /** Per-event in-flight dispatch promises (acceptance F1). Without this
   * coordination, a redelivered frame or a reconnect sweep re-entering a
   * still-running handler would execute the same task twice (reproduced in
   * the review). */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly opts: PublicWorldStreamOptions) {
    opts.gate?.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });
  }

  private active(): boolean {
    return !this.stopped && (!this.opts.gate || this.opts.gate.isActive());
  }

  isReceiving(): boolean { return this.active() && this.receiving; }

  /** Idempotent schema setup (disposable inline pattern, same db as world_feed). */
  ensureSchema(): void {
    const db = this.opts.db;
    db.execute(`CREATE TABLE IF NOT EXISTS world_stream (
      seq INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT '',
      envelope BLOB NOT NULL,
      projection BLOB,
      content_done INTEGER NOT NULL DEFAULT 0,
      task_done INTEGER NOT NULL DEFAULT 0,
      received_at INTEGER NOT NULL
    )`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_ws_kind ON world_stream(kind)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_ws_pending ON world_stream(task_done, content_done, seq)`);
    db.execute(`CREATE TABLE IF NOT EXISTS world_stream_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL DEFAULT 0)`);
    db.execute(`INSERT OR IGNORE INTO world_stream_cursor (id, seq) VALUES (1, 0)`);
  }

  /** The durable cursor (survives restarts; sent as `after` on first connect). */
  cursor(): number {
    const row = this.opts.db.queryOne<{ seq: number }>(
      `SELECT seq FROM world_stream_cursor WHERE id = 1`,
    );
    return row?.seq ?? 0;
  }

  async start(onEnvelope?: EnvelopeHandler): Promise<void> {
    if (!this.active()) return;
    // G1: a handler is a REAL task consumer. Preferred boot order (index.ts)
    // is start() content-only, then IngressProxy.bind -> start(rangerHandler)
    // — with no handler bound, tasks stay task_done=0 until a real one binds
    // (citizen and gateway share this db). The LEGACY order
    // start(placeholder) -> bind(real) is also made safe: a handler REPLACED
    // by a different one re-arms every task row the old handler marked done —
    // a placeholder's "done" speaks for nobody.
    //
    // ⚠️ Semantic limit (fourth review): re-arming is a LEGACY-BOOT-ORDER
    // compatibility measure, not a general contract — rebinding a DIFFERENT
    // REAL handler re-runs tasks the previous real handler already completed
    // (bounded by server-side idempotency: 409s, watch registry state).
    // Production never rebinds real handlers; see the rebind characterization
    // test pinning exactly this behavior.
    if (onEnvelope && this.handler !== null && this.handler !== onEnvelope) {
      // Let dispatches still running under the OLD handler settle first —
      // their completion marks speak for the placeholder and the re-arm
      // below must not race them (their UPDATE lands after bind ran).
      const inFlight = [...this.inflight.values()];
      if (inFlight.length > 0) await Promise.allSettled(inFlight);
      if (!this.active()) return;
      this.opts.db.execute(`UPDATE world_stream SET task_done = 0 WHERE task_done = 1`);
    }
    if (onEnvelope) this.handler = onEnvelope;
    // Connect first (sync — the EventSource must exist the moment start's
    // first await yields), then sweep pending dispatches.
    this.connect();
    await this.retryPending();
  }

  private connect(): void {
    if (this.es || this.retryTimer || !this.active()) return;
    this.ensureSchema();
    const qs = new URLSearchParams();
    qs.set('limit', String(this.opts.limit ?? 5000));
    const cursor = this.cursor();
    if (cursor > 0) qs.set('after', String(cursor));
    const url = `${this.opts.baseUrl}/v1/world-stream?${qs.toString()}`;
    const Ctor =
      this.opts.eventSourceCtor ??
      (EventSource as unknown as new (url: string) => AnyEventSource);
    const es = new Ctor(url);
    // Never let EventSource reconnect itself: its implicit Last-Event-ID
    // advances before verification. Every new instance uses our durable cursor.
    es.onmessage = (e) => {
      if (this.es !== es) return;
      if (!this.active()) { this.reconnect(es); return; }
      try {
        const bytes = decodeBase64(e.data);
        inspectPublicCarrier(bytes, 'frame');
        const frame = popclaw.event.WorldStreamFrame.decode(bytes);
        const received = normalizeFrame(frame, e.lastEventId);
        if (!received) throw new Error('INVALID_WORLD_STREAM_FRAME');
        // Verify and persist synchronously, so a rejected frame closes the
        // stream before another frame in the same network chunk is accepted.
        // Dispatch errors leave durable rows pending for a later retry.
        void this.persistFrame(received).catch((err) => {
          if (this.opts.onError) this.opts.onError(err);
        });
      } catch (err) {
        this.reconnect(es);
        if (this.opts.onError) this.opts.onError(err);
      }
    };
    es.onerror = (err) => {
      const current = this.es === es;
      this.reconnect(es);
      if (current && this.active()) this.opts.onError?.(err);
    };
    const esWithOpen = es as { onopen?: (() => void) | null };
    esWithOpen.onopen = () => {
      if (this.es !== es) return;
      if (!this.active()) { this.reconnect(es); return; }
      this.receiving = true;
      void this.retryPending().catch(() => {});
      for (const cb of this.connectedCallbacks) {
        try {
          cb();
        } catch {
          /* a consumer's connected callback must never crash the receiver */
        }
      }
    };
    this.es = es;
  }

  private reconnect(es: AnyEventSource): void {
    es.close(); // Also close stale/disabled instances before any early return.
    if (this.es !== es) return;
    this.es = null;
    this.receiving = false;
    if (!this.active() || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.active()) this.connect();
    }, this.opts.reconnectDelayMs ?? 5000 + Math.floor(Math.random() * 5000));
    this.retryTimer.unref?.();
  }

  onConnected(cb: () => void): void {
    this.connectedCallbacks.push(cb);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.receiving = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    await Promise.allSettled([...this.inflight.values()]);
  }

  /** Persist + advance + dispatch. Also the direct entry point for tests.
   *
   * Receiving and processing are separate watermarks (acceptance R3/G1):
   * the cursor records "seen"; `content_done` / `task_done` record which
   * consumer class actually completed. A dispatch failure or a crash between
   * store and dispatch leaves the row pending, retried on every
   * start/reconnect via `retryPending`. With NO task handler bound, task
   * events stay task_done=0 — a stand-in no-op must never consume them
   * (G1); whichever process owns a real handler picks them up from the
   * shared per-house db. */
  async absorb(frame: ReceivedFrame): Promise<void> {
    return this.persistFrame(frame);
  }

  private persistFrame(frame: ReceivedFrame): Promise<void> {
    if (!this.active()) return Promise.resolve();
    const verified = verifyInboundEnvelope(frame.envelope, { publicStream: true, isOfficialActor: this.opts.isOfficialActor });
    if (verified.eventId !== frame.eventId) throw new Error('CID_MISMATCH');
    const db = this.opts.db;
    const now = Math.floor(Date.now() / 1000);
    // Persist the projection alongside: a retry after restart has nothing
    // else to rebuild the content consumer's item from.
    const projectionBytes = frame.projection
      ? Buffer.from(popclaw.event.WorldFeedItem.encode(frame.projection).finish() as Uint8Array)
      : null;
    const res = db.execute(
      `INSERT OR IGNORE INTO world_stream (seq, event_id, kind, envelope, projection, content_done, task_done, received_at)
       VALUES (?,?,?,?,?,0,0,?)`,
      [frame.seq, frame.eventId, frame.kind, Buffer.from(frame.envelope), projectionBytes, now],
    );
    // The cursor only moves forward (backfill/live overlap may redeliver
    // out of order).
    if (frame.seq > this.cursor()) {
      db.execute(`UPDATE world_stream_cursor SET seq = ? WHERE id = 1`, [frame.seq]);
    }
    if (res.changes === 0) {
      // Redelivery: skip only if BOTH consumer classes completed. Pending
      // rows get their retry right here — through the per-event coordination
      // below, so an in-flight attempt is awaited rather than re-entered.
      const row = db.queryOne<{ content_done: number; task_done: number }>(
        `SELECT content_done, task_done FROM world_stream WHERE event_id = ?`,
        [frame.eventId],
      );
      if (row?.content_done && row?.task_done) return Promise.resolve();
    }
    return this.runExclusive(frame.eventId, () =>
      this.dispatchStored(frame.eventId, frame.kind, frame.envelope, frame.projection),
    );
  }

  /** Re-dispatch stored-but-undone rows (startup + every reconnect). */
  async retryPending(): Promise<void> {
    if (!this.active()) return;
    const rows = this.opts.db.queryAll<{
      event_id: string;
      kind: string;
      envelope: Buffer;
      projection: Buffer | null;
    }>(
      `SELECT event_id, kind, envelope, projection FROM world_stream
       WHERE task_done = 0 OR content_done = 0 ORDER BY seq ASC`,
    );
    for (const r of rows) {
      if (!this.active()) return;
      if (r.projection) inspectPublicCarrier(new Uint8Array(r.projection), 'projection', true);
      const projection = r.projection
        ? popclaw.event.WorldFeedItem.decode(new Uint8Array(r.projection))
        : null;
      await this.runExclusive(r.event_id, () =>
        this.dispatchStored(r.event_id, r.kind, new Uint8Array(r.envelope), projection),
      );
    }
  }

  /** Serialized dispatch per event_id in this process: a concurrent entry
   * CHAINS AFTER the in-flight execution and then runs `fn` itself — the
   * persisted done-state recheck inside `fn` (G2) decides whether a fresh
   * execution is actually needed. Reusing the in-flight promise directly
   * (returning it) would skip that recheck: an earlier entry that had
   * nothing to do (e.g. no handler bound yet, G1's boot order) would poison
   * the next sweep into a silent no-op. */
  private runExclusive(eventId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.inflight.get(eventId);
    const run = (async () => {
      if (prev) await prev.catch(() => {});
      if (this.active()) await fn();
    })()
      .finally(() => {
        if (this.inflight.get(eventId) === run) this.inflight.delete(eventId);
      });
    this.inflight.set(eventId, run);
    return run;
  }

  /** Run the still-pending consumers for one stored event.
   *
   * G2: the persisted done-state is RE-READ here, inside the exclusive
   * section — the snapshot this entry came from may be stale (another entry
   * point completed the event while we were queued behind an earlier one).
   * Each consumer's flag is set right after it succeeds; any throw leaves
   * that flag 0 and retryable. */
  private async dispatchStored(
    eventId: string,
    kind: string,
    envelope: Uint8Array,
    projection: popclaw.event.IWorldFeedItem | null,
  ): Promise<void> {
    if (!this.active()) return;
    const verified = verifyInboundEnvelope(envelope, { publicStream: true, isOfficialActor: this.opts.isOfficialActor });
    if (verified.eventId !== eventId) throw new Error('CID_MISMATCH');
    const db = this.opts.db;
    const row = db.queryOne<{ content_done: number; task_done: number }>(
      `SELECT content_done, task_done FROM world_stream WHERE event_id = ?`,
      [eventId],
    );
    const contentPending =
      !!this.opts.onContent && !!projection && isContentKind(kind) && !row?.content_done;
    const taskPending = !!this.handler && !row?.task_done;
    if (!contentPending && !taskPending) return;

    // Content consumer: reload the frame-level verbatim bytes into the
    // projection's envelope field (the raw-BLOB invariant).
    if (contentPending) {
      this.opts.onContent!({ ...projection!, envelope });
      if (!this.active()) return;
      db.execute(`UPDATE world_stream SET content_done = 1 WHERE event_id = ?`, [eventId]);
    }
    // Ranger/verification consumer: decode the whole envelope and hand it to
    // the EventIngress handler ("who cares" is the dispatcher's call —
    // unclassifyable kinds are silently dropped there).
    if (taskPending && this.active()) {
      const env = decodeEnvelope(envelope);
      await this.handler!({ eventId, envelope: env as unknown as Record<string, unknown> });
      if (!this.active()) return;
      db.execute(`UPDATE world_stream SET task_done = 1 WHERE event_id = ?`, [eventId]);
    }
  }
}

function isContentKind(kind: string): boolean {
  // House vocabulary (kinds like "world.postcard") is content too — when the
  // server attached a projection it goes to the content consumer. The two
  // typed content labels are fixed strings.
  return CONTENT_KINDS.has(kind) || kind.includes('.');
}

function normalizeFrame(
  frame: popclaw.event.IWorldStreamFrame,
  lastEventId: string | undefined,
): ReceivedFrame | null {
  const envBytes = frame.envelope ?? new Uint8Array(0);
  if (envBytes.length === 0) return null;
  // Prefer the server's SSE id: for seq (frame field and id: share a source;
  // fall back to the frame field when the id: is missing).
  const seq = Number(frame.seq ?? 0) || Number(lastEventId ?? 0) || 0;
  if (seq <= 0) return null;
  let eventId = '';
  const kind = frame.kind && frame.kind.length > 0 ? frame.kind : 'unknown';
  try {
    const env = decodeEnvelope(envBytes);
    eventId = env.eventId ?? '';
  } catch {
    return null;
  }
  if (!eventId) return null;
  return { seq, eventId, kind, envelope: envBytes, projection: frame.projection ?? null };
}

function decodeBase64(s: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Late-binding EventIngress proxy — the roots construct the Ranger BEFORE the
 * steps that can hard-fail (see the construction-order comment in index.ts),
 * and the house stores/receivers open later. In flag-on mode the Ranger's
 * ingress is this proxy; start/onConnected calls made before a real receiver
 * exists are buffered and replayed on bind.
 */
export class IngressProxy implements EventIngress {
  private impl: EventIngress | null = null;
  private pendingHandler: EnvelopeHandler | null = null;
  private pendingConnected: Array<() => void> = [];
  private stopped = false;

  bind(impl: EventIngress): void {
    this.impl = impl;
    if (this.stopped) return;
    if (this.pendingHandler) void impl.start(this.pendingHandler);
    for (const cb of this.pendingConnected) impl.onConnected?.(cb);
    this.pendingConnected = [];
  }

  async start(onEnvelope: EnvelopeHandler): Promise<void> {
    this.pendingHandler = onEnvelope;
    this.stopped = false;
    if (this.impl) await this.impl.start(onEnvelope);
  }

  onConnected(cb: () => void): void {
    if (this.impl) {
      this.impl.onConnected?.(cb);
    } else {
      this.pendingConnected.push(cb);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.pendingHandler = null;
    this.pendingConnected = [];
    if (this.impl) await this.impl.stop();
  }
}

/** Rebuild only the disposable view from retained receipts. Never invokes an event
 * handler or changes receipt/consumer completion; a cache clear cannot re-arm tasks.
 */
export function rebuildPublicWorldProjection(
  db: HostDb,
  cache: Pick<import('./world-feed-cache.js').WorldFeedCache, 'record'>,
  options?: PublicProjectionRebuildOptions,
): void {
  if (rebuildPublicJournalProjection(db, cache, options)) return;
  if (!db.queryOne("SELECT name FROM sqlite_master WHERE type='table' AND name='world_stream'")) return;
  for (const row of db.queryAll<{kind: string; envelope: Uint8Array; projection: Uint8Array; received_at: number}>(
    'SELECT kind,envelope,projection,received_at FROM world_stream WHERE projection IS NOT NULL ORDER BY seq',
  )) {
    if (!isContentKind(row.kind)) continue;
    inspectPublicCarrier(row.projection, 'projection', true);
    const projection = popclaw.event.WorldFeedItem.decode(row.projection);
    cache.record({...projection, envelope: new Uint8Array(row.envelope)}, undefined, row.received_at);
  }
}

export interface PublicV1ReceiverOptions {
  readonly capability: VerifiedPublicStreamCapability;
  readonly gate: PublicReceiveGate;
  readonly executionDb: HostDb;
  readonly selection: PublicSelection;
  readonly producerPolicy: VerifiedPublicProducerPolicy;
  readonly approvedConsumerMappingDigest: string;
  readonly consumers: readonly PublicConsumer[];
  readonly taskConsumerId?: string;
  readonly onStatus?: (status: PublicReceiveStatus) => void;
  readonly onError?: (error: unknown) => void;
  readonly fetch?: typeof globalThis.fetch;
  /** Internal transport liveness budget; any received bytes, including SSE
   * heartbeat comments, keep the connection alive. It does not expire reads. */
  readonly idleTimeoutMs?: number;
}

/** One anonymous transport. Only synchronous journal transactions participate
 * in receive progress; approved consumers run independently of socket reads. */
export class PublicV1Receiver implements EventIngress {
  readonly journal: PublicStreamJournal;
  private readonly options: PublicV1ReceiverOptions;
  private readonly lifetime = new AbortController();
  private readonly callbacks = createHostAsyncScope<boolean>();
  private readonly callbackWork = new Set<Promise<unknown>>();
  private readonly connectedCallbacks: Array<() => void> = [];
  private started = false;
  private receiving = false;
  private startup: Promise<void> | null = null;
  private network: Promise<void> | null = null;
  private consuming: Promise<void> | null = null;
  private consumerRequested = false;
  private consumerTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly abortListener = () => { void this.stop(); };

  constructor(options: PublicV1ReceiverOptions) {
    const idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2_147_483_647)
      throw new Error('PUBLIC_STREAM_IDLE_TIMEOUT_INVALID');
    // Capture declarations and verified observation, while retaining the actual
    // gate/DB and concrete adapter functions supplied by the resource owner.
    this.options = { ...options, idleTimeoutMs,
      capability: structuredClone(options.capability),
      selection: structuredClone(options.selection),
      producerPolicy: structuredClone(options.producerPolicy),
      consumers: options.consumers.map(consumer => ({ ...consumer, contract: structuredClone(consumer.contract) })),
    };
    for (const consumer of this.options.consumers) {
      if (consumer.mode !== consumer.contract.effectMode || typeof consumer.select !== 'function'
        || (consumer.mode === 'same-db' ? typeof consumer.apply !== 'function' : typeof consumer.deliver !== 'function')) {
        throw new Error('PUBLIC_CONSUMER_CONTRACT_INVALID');
      }
    }
    this.journal = new PublicStreamJournal({ ...this.options,
      consumerContracts: this.options.consumers.map(consumer => consumer.contract),
      gate: { origin: options.gate.origin,
        signal: AbortSignal.any([options.gate.signal, this.lifetime.signal]),
        isActive: () => this.active() },
    });
    options.gate.signal.addEventListener('abort', this.abortListener, { once: true });
  }

  private active(): boolean {
    return !this.lifetime.signal.aborted && !this.options.gate.signal.aborted && this.options.gate.isActive();
  }
  private requireActive(): void { if (!this.active()) throw new Error('PUBLIC_RECEIVE_GATE_CLOSED'); }
  isReceiving(): boolean { return this.receiving && this.active(); }
  receiveStatus(): PublicReceiveStatus { return this.journal.receiveStatus(); }
  consumerStatus(id: string): PublicConsumerStatus { return this.journal.consumerStatus(id); }
  onConnected(callback: () => void): void { this.connectedCallbacks.push(callback); }

  async start(handler?: EnvelopeHandler): Promise<void> {
    // The approved initial mapping is raw-only. A string ID cannot establish
    // that an arbitrary EventIngress handler is an approved durable adapter.
    if (handler) throw new Error('PUBLIC_TASK_HANDLER_UNSUPPORTED');
    this.requireActive();
    if (this.started) { await this.startup; this.requireActive(); return; }
    this.journal.activate();
    this.started = true;
    this.startup = Promise.resolve().then(() => {
      this.requireActive();
      this.network = this.run().catch(error => { if (this.active()) this.report(error); });
      this.requestConsumers();
    });
    await this.startup;
    this.requireActive();
  }

  /** Fence synchronously. A callback may await stop without waiting on itself;
   * the external resource owner completes the full join via stop/whenIdle. */
  stop(): Promise<void> {
    this.lifetime.abort(); this.receiving = false;
    this.options.gate.signal.removeEventListener('abort', this.abortListener);
    if (this.consumerTimer) clearTimeout(this.consumerTimer);
    this.consumerTimer = null; this.consumerRequested = false;
    return this.callbacks.getStore() ? Promise.resolve() : this.whenIdle();
  }

  async whenIdle(): Promise<void> {
    if (this.callbacks.getStore()) return;
    // Startup may still be about to publish its network promise. Join it first.
    await Promise.allSettled(this.startup ? [this.startup] : []);
    await Promise.allSettled([this.network, this.consuming].filter((p): p is Promise<void> => p !== null));
    while (this.callbackWork.size) await Promise.allSettled([...this.callbackWork]);
  }

  private invoke(callback: () => unknown, reportFailure = true): void {
    try {
      const result = this.callbacks.run(true, callback);
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        const work = Promise.resolve(result).catch(error => { if (reportFailure) this.report(error); })
          .finally(() => { this.callbackWork.delete(work); });
        this.callbackWork.add(work);
      }
    } catch (error) { if (reportFailure) this.report(error); }
  }
  private report(error: unknown): void {
    // Never expose peer bytes, URLs, tokens or arbitrary database diagnostics.
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
      ? error.message : 'PUBLIC_STREAM_UNAVAILABLE';
    this.invoke(() => this.options.onError?.(new Error(code)), false);
  }
  private notify(): void { this.invoke(() => this.options.onStatus?.(this.journal.receiveStatus())); }

  private async run(): Promise<void> {
    while (this.active()) {
      let generation: string | null = null, response: Response | undefined;
      let errorCode = 'PUBLIC_STREAM_EOF';
      let gap = false;
      const connection = new AbortController();
      let idle = false, idleTimer: ReturnType<typeof setTimeout> | undefined;
      const progress = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (connection.signal.aborted) return;
        idleTimer = setTimeout(() => { idle = true; connection.abort(); }, this.options.idleTimeoutMs!);
      };
      try {
        this.requireActive();
        const request = this.journal.request();
        const params = new URLSearchParams({ mode: 'public-v1', incarnation: request.incarnation });
        if (request.publicAfter !== undefined) params.set('public_after', request.publicAfter);
        params.set('cursors', request.cursors.map(cursor => `${cursor.scopeId}:${cursor.afterSeq}`).join(','));
        params.set('limit', '256');
        const signal = AbortSignal.any([this.lifetime.signal, this.options.gate.signal, connection.signal]);
        this.requireActive();
        progress();
        response = await (this.options.fetch ?? globalThis.fetch)(
          this.options.capability.house.origin + this.options.capability.publicStream.endpoint + '?' + params.toString(),
          { signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { accept: 'text/event-stream' } },
        );
        this.requireActive();
        if (!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream') {
          throw new Error('PUBLIC_STREAM_UNAVAILABLE');
        }
        await consumePublicSse(response, signal, event => {
          this.requireActive();
          const raw = scopedBase64(event.data);
          if (event.type === 'public_boundary') {
            if (generation !== null) throw new Error('PUBLIC_BOUNDARY_REPEATED');
            generation = this.journal.begin(decodePublicControl('public_boundary', raw), raw, request);
            this.requireActive(); this.receiving = true; this.notify();
            for (const callback of this.connectedCallbacks) {
              if (!this.active()) break;
              this.invoke(callback);
            }
          } else if (event.type === 'public_gap') {
            const decoded = decodePublicControl('public_gap', raw);
            if (generation === null) this.journal.startupGap(decoded, raw, request);
            else this.journal.gap(generation, decoded, raw);
            gap = true; this.receiving = false; this.notify();
            // Close immediately, even when another event is buffered in this
            // same network chunk. The journal retains the real gap evidence.
            throw new Error('PUBLIC_STREAM_GAP');
          } else {
            if (generation === null) throw new Error('PUBLIC_BOUNDARY_REQUIRED');
            if (event.type === 'public_frame') {
              this.journal.append(generation, raw); this.requestConsumers();
            } else if (event.type === 'public_checkpoint') {
              this.journal.checkpoint(generation, decodePublicControl('public_checkpoint', raw), raw);
            } else throw new Error('PUBLIC_EVENT_UNSUPPORTED');
            this.notify();
          }
          this.requireActive();
        }, progress);
        this.requireActive();
      } catch (error) {
        errorCode = gap ? 'PUBLIC_STREAM_GAP' : idle ? 'PUBLIC_STREAM_IDLE' : error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
          ? error.message : 'PUBLIC_STREAM_UNAVAILABLE';
        if (this.active() && !gap) this.report(idle ? new Error(errorCode) : error);
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
        // Also cancel a fetch which resolved after stop, before parser entry.
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
        this.receiving = false;
        try { this.journal.end(generation, this.active() ? errorCode : 'PUBLIC_RECEIVE_GATE_CLOSED'); }
        catch (error) { this.report(error); }
        this.notify();
      }
      if (!this.active() || gap || this.journal.receiveStatus().phase === 'gap') return;
      await this.delay(1000);
    }
  }

  private requestConsumers(): void {
    if (!this.active() || !this.options.consumers.length) return;
    this.consumerRequested = true;
    if (this.consuming || this.consumerTimer) return;
    this.consumerRequested = false;
    this.consuming = Promise.resolve().then(async () => {
      this.requireActive();
      await this.callbacks.run(true, () => this.journal.runConsumers(this.options.consumers, this.lifetime.signal));
      this.requireActive();
    }).catch(error => { if (this.active()) this.report(error); }).finally(() => {
      this.consuming = null;
      if (!this.active()) return;
      this.consumerTimer = setTimeout(() => {
        this.consumerTimer = null;
        if (this.active()) this.requestConsumers();
      }, this.consumerRequested ? 0 : 1000);
      this.consumerTimer.unref?.();
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => {
      const signal = AbortSignal.any([this.lifetime.signal, this.options.gate.signal]);
      const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, ms); timer.unref?.();
      signal.addEventListener('abort', finish, { once: true });
      if (!this.active()) finish();
    });
  }
}
