import { executionDbFor } from '../../ingress/world-feed-store.js';
import { storageDatabasePathAllowed } from '../../host/storage-maintenance.js';
/** The common per-house resource assembly used by every resident root. */
import type { popclaw } from '@popclaw/contracts';
import type { HostAdapter } from '../../host/host-adapter.js';
import type { Signer } from '../../identity/signer.js';
import type { EnvelopeHandler, EventIngress } from '../../ingress/event-ingress.js';
import type { HouseStore } from '../../ingress/world-feed-store.js';
import { PublicWorldStreamClient } from '../../ingress/public-world-stream-client.js';
import { WorldFeedStreamClient, worldFeedResume } from '../../ingress/world-feed-stream-client.js';
import { SseIngress } from '../../ingress/sse-ingress.js';
import { describeSseError } from '../../ingress/sse-error.js';
import { InboxStreamClient, type InboxCursorReset, type InboxReadCredential } from '../../messaging/inbox-stream-client.js';
import type { HouseGate, HouseStatus } from './manager.js';
import type { PerHouseStreams, StreamFactory } from './coordinator.js';
import { withAction, withResourceAction } from './action-context.js';

interface RangerResource { start(): Promise<void>; stop(): Promise<void> }
export interface PublicHouseReceiver extends EventIngress {
  start(onEnvelope?: EnvelopeHandler): Promise<void>;
  isReceiving(): boolean;
  /** Some receivers fence in stop to avoid self-joins from their callbacks. */
  whenIdle?(): Promise<void>;
}
export interface PublicHouseReceiverInput {
  house: HouseStore;
  gate: HouseGate;
  onContent(item: popclaw.event.IWorldFeedItem): void;
  isOfficialActor(actorId: string): boolean;
  onError(error: unknown): void;
}
export interface HouseInboxConsumer {
  receive(dm: popclaw.event.IDirectMessage, envelope: Uint8Array, nickname: string): void | Promise<void>;
  drain(): void | Promise<unknown>;
  /** Lightweight local change check on the existing owner cadence; no I/O timer. */
  poll?(): void;
  /** Fence synchronously; never wait for the callback that triggered stop. */
  stop(): void;
  /** Join existing recovery/timer work without starting new consumption. */
  whenIdle(): Promise<void>;
}
export interface HouseInboxConsumerInput {
  onPlain?(dm: popclaw.event.IDirectMessage, envelope: Uint8Array, nickname: string, authenticatedPlain?: { readonly originalText: string }): void | Promise<void>;
  isOfficialActor?(actorId: string): boolean;
  house: HouseStore;
  gate: HouseGate;
  onError(error: unknown): void;
}
export interface HouseResourceOptions {
  host: HostAdapter;
  signer: Signer;
  recipientPopclawId: string;
  worldStreamMode: boolean;
  publicV1Mode?: boolean;
  storeFor(origin: string): Promise<HouseStore>;
  /**
   * The read credential this house's personal stream opens with, decided
   * under the live gate. A selected session lane never falls back to identity;
   * the per-connection capture is checked by the transport before send.
   */
  readToken(gate: HouseGate): Promise<InboxReadCredential>;
  isOfficialActor(house: HouseStore, actorId: string): boolean;
  onContent?(house: HouseStore, item: popclaw.event.IWorldFeedItem): void;
  onInbox?(house: HouseStore, gate: HouseGate, dm: popclaw.event.IDirectMessage,
    envelope: Uint8Array, nickname: string, authenticatedPlain?: { readonly originalText: string }): void | Promise<void>;
  /**
   * Every VERIFIED non-DM envelope on this house's personal stream — which is
   * how relation originals reach the relation chain.
   *
   * The chain does NOT open its own connection: one personal transport per
   * house, owned here, gated here, reconnected here. It only supplies what to
   * do with a frame. Failure PROPAGATES: a commit that throws takes the
   * transport down, so the reconnect resumes from the position that actually
   * landed instead of reading on past a frame that never did.
   */
  onFrame?(house: HouseStore, gate: HouseGate, envelope: Uint8Array,
    position: string | undefined): void | Promise<void>;
  /**
   * Send VERIFIED DMs to `onFrame` too, so they share the relation chain's
   * commit boundary: one ordered queue, one cursor, one fence, no second path
   * that can advance past a DM that did not land.
   *
   * The hand-over that must be synchronous is the durable queue row written at
   * that boundary. The slow work — decryption, media, notification — still
   * belongs to the existing consumer, driven from the drain afterwards. Only
   * meaningful with `onFrame` wired, and refused without it rather than
   * silently dropping every DM.
   */
  routeDmFramesToOnFrame?: boolean;
  /**
   * Bring this house into the relation chain, before its personal stream
   * opens. It runs where the chain's confirmation belongs — once per house,
   * on the same await path that builds the rest of this set — so that
   * `resumeFrom` below has a handle to read a cursor off, and the first frame
   * has a session to commit under.
   *
   * A refusal is not a failure of this set: a house with no live
   * participation still carries mail. It is reported and the stream opens
   * anyway; relation frames for it are then refused by name rather than
   * committed under a session nobody holds.
   */
  attachRelations?(house: HouseStore, gate: HouseGate): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  /** Where this house's personal stream should resume, when the chain holds a cursor. */
  resumeFrom?(house: HouseStore, gate: HouseGate): string | undefined;
  /** The house could not honour the cursor we resumed from. */
  onCursorReset?(house: HouseStore, gate: HouseGate, reset: InboxCursorReset,
    connectionSerial: number): void;
  /**
   * Hands out this house's live personal transport as soon as it exists.
   *
   * `onCursorReset` carries the serial of the connection that carried it, and
   * telling a current one from a REPLACED one needs the serial in use right
   * now — which only whoever owns the transport knows. Rather than duplicate
   * that judgement here, the owner is published and the consumer that already
   * holds the rule asks it.
   */
  onTransport?(house: HouseStore, transport: { currentConnectionSerial(): number }): void;
  /** Replaces the public receiver; the same instance is the Ranger ingress. */
  createPublicReceiver?(input: PublicHouseReceiverInput): PublicHouseReceiver;
  /** Owns the private consumer and its retries for exactly this resource set. */
  createInboxConsumer?(input: HouseInboxConsumerInput): HouseInboxConsumer | undefined;
  createRanger?(house: HouseStore, gate: HouseGate, ingress: EventIngress): RangerResource;
  /** Includes handshake/namecard work, under this set's captured action. */
  refresh?(house: HouseStore, gate: HouseGate): Promise<void>;
  refreshMs?: number;
  log?(message: string): void;
}

export function createHouseStreamFactory(opts: HouseResourceOptions): StreamFactory {
  return { open: gate => new HouseResourceSet(opts, gate) };
}

class HouseResourceSet implements PerHouseStreams {
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly gate: HouseGate;
  private readonly tasks = new Set<Promise<void>>();
  private readonly startup: Promise<void>;
  private stopTask: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private world: PublicHouseReceiver | WorldFeedStreamClient | null = null;
  private inbox: InboxStreamClient | null = null;
  private inboxConsumer: HouseInboxConsumer | null = null;
  private ranger: RangerResource | null = null;
  private discovery: SseIngress | null = null;

  constructor(private readonly opts: HouseResourceOptions, captured: HouseGate) {
    // Routing DMs onto the shared boundary with nothing wired to take a frame
    // would send every DM to a callback that does not exist. Say so at
    // assembly, not by losing mail.
    if (opts.routeDmFramesToOnFrame === true && opts.onFrame === undefined) {
      throw new Error('routeDmFramesToOnFrame requires onFrame: DMs would be delivered nowhere');
    }
    this.gate = { ...captured, signal: AbortSignal.any([captured.signal, this.abort.signal]),
      isActive: () => !this.stopped && !this.abort.signal.aborted && storageDatabasePathAllowed(opts.host.db, 'consumers') && captured.isActive() };
    captured.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });
    this.startup = this.track(async () => {
      try { await this.start(); }
      catch (error) { void this.stop(); throw error; }
    });
  }

  status(): HouseStatus['streams'] {
    return { world: this.gate.isActive() && this.world?.isReceiving() ? 'active' : 'inactive',
      inbox: this.gate.isActive() && this.inbox?.isReceiving() ? 'active' : 'inactive' };
  }

  refresh(): void {
    // This is the resident's local change check, independent of handshake work.
    if (this.gate.isActive() && this.inboxConsumer?.poll) {
      void this.track(() => this.inboxConsumer?.poll?.());
    }
  }

  private track(work: () => void | Promise<void>, propagateFailure = false): Promise<void> {
    const task = Promise.resolve().then(() => {
      if (this.gate.isActive()) return withResourceAction(this.gate, work);
    }).catch(err => {
      // Inbox persistence failures must reach the transport's replay boundary.
      if (propagateFailure) throw err;
      this.opts.log?.(`house resource (${this.gate.origin}): ${String(err)}`);
    }).finally(() => { this.tasks.delete(task); });
    this.tasks.add(task);
    return task;
  }

  private async start(): Promise<void> {
    const house = await this.opts.storeFor(this.gate.origin);
    if (!this.gate.isActive()) return;
    // A protected public cache does not own ordinary mail or relations:
    // those commit in the global social store under this same live gate.
    if (!house.cacheReadOnly) await this.refreshHandshake(house);
    else this.opts.log?.(`house cache (${house.slug}): read-only; continuing ordinary inbox`);
    if (!this.gate.isActive()) return;
    const onContent = (item: popclaw.event.IWorldFeedItem, bytes?: Uint8Array, cursor?: string) => {
      if (!this.gate.isActive() || house.cacheReadOnly) return;
      withAction(this.gate, () => {
        house.cache.record(item, bytes);
        if (cursor !== undefined) house.cache.recordInsertCursor(cursor);
        this.opts.onContent?.(house, item);
      });
    };
    const common = { baseUrl: house.baseUrl, gate: this.gate,
      isOfficialActor: (id: string) => this.opts.isOfficialActor(house, id), limit: 5000,
      // NOT String(err): every stream on this house reports through here, and
      // an SSE failure arrives as a DOM-ish event object, not an Error — so a
      // whole network outage's worth of these lines said `[object Object]`
      // while the status/code that would have told an operator what to do sat
      // right there on the object. The refusal lines read correctly only
      // because those happen to BE Errors. Same describer the multi-house
      // inbox lane already uses (runtime/inbox-consumer.ts).
      onError: (err: unknown) => this.opts.log?.(`house stream (${house.slug}): ${describeSseError(err)}`) };
    if (house.cacheReadOnly) {
      // No public/cache writer or execution-dependent receiver on this path.
      // Execution readiness remains separate from ordinary inbox readiness.
    } else if (this.opts.publicV1Mode) {
      // The independently captured resident public slot owns this transport.
      // A real business gate may still open its separate inbox below.
    } else if (this.opts.worldStreamMode) {
      this.world = this.opts.createPublicReceiver?.({house, gate: this.gate, onContent,
        isOfficialActor: common.isOfficialActor, onError: common.onError})
        ?? new PublicWorldStreamClient({ ...common, db: executionDbFor(house), onContent });
    } else {
      this.world = new WorldFeedStreamClient({ ...common,
        ...worldFeedResume(house.cache.insertCursor(), house.cache.newestPostCreatedAt()), onItem: onContent });
      if (this.opts.createRanger) this.discovery = new SseIngress(common, this.opts.host);
    }
    this.inboxConsumer = this.opts.createInboxConsumer?.({ house, gate: this.gate, onError: common.onError, isOfficialActor: common.isOfficialActor,
      onPlain: (dm, bytes, nickname, authenticatedPlain) => {
        if (!this.gate.isActive()) throw new Error('PRIVATE_RESOURCE_CHANGED');
        return this.opts.onInbox?.(house, this.gate, dm, bytes, nickname, authenticatedPlain);
      } }) ?? null;
    if (this.inboxConsumer) await this.inboxConsumer.drain();
    if (!this.gate.isActive()) return;
    // Before the transport, never after: a stream that starts reading with no
    // handle attached cannot offer its resume cursor, and reads on from the
    // log's head — losing exactly the frames the cursor existed to keep.
    if (this.opts.attachRelations) {
      const attached = await this.opts.attachRelations(house, this.gate);
      if (!this.gate.isActive()) return;
      if (!attached.ok) {
        this.opts.log?.(`popclaw: ${house.slug} carries mail but no relations — ${attached.reason ?? 'no live participation'}`);
      }
    }
    if (!this.gate.isActive()) return;
    this.inbox = new InboxStreamClient({ baseUrl: house.baseUrl,
      recipientPopclawId: this.opts.recipientPopclawId, gate: this.gate,
      readToken: () => this.opts.readToken(this.gate), onError: common.onError,
      // `propagateFailure` is the whole point: track() rejects, the client
      // catches it and tears the connection down. A frame that did not commit
      // must not be followed by one that does.
      ...(this.opts.onFrame
        ? { onFrame: (envelope: Uint8Array, position: string | undefined) =>
            this.track(() => this.opts.onFrame?.(house, this.gate, envelope, position), true) }
        : {}),
      // Read at connect time, never cached: a cursor the house just refused
      // must not be resent by the next reconnect.
      ...(this.opts.resumeFrom
        ? { resumeFrom: () => this.gate.isActive() ? this.opts.resumeFrom?.(house, this.gate) : undefined }
        : {}),
      ...(this.opts.onCursorReset
        ? { onCursorReset: (reset: InboxCursorReset, serial: number) =>
            void this.track(() => this.opts.onCursorReset?.(house, this.gate, reset, serial)) }
        : {}),
      ...(this.opts.routeDmFramesToOnFrame ? { routeDmFramesToOnFrame: true } : {}),
      onMessage: (dm, bytes, nickname) => {
        if (this.gate.isActive()) return this.track(() => this.inboxConsumer
          ? this.inboxConsumer.receive(dm, bytes, nickname)
          : this.opts.onInbox?.(house, this.gate, dm, bytes, nickname), true);
      } });
    // Published before the first read, so a reset that arrives on the very
    // first connection can still be judged against a known serial.
    this.opts.onTransport?.(house, this.inbox);
    if (!house.cacheReadOnly && !this.opts.publicV1Mode && this.opts.createRanger) {
      const ingress = this.opts.worldStreamMode ? this.world as PublicHouseReceiver : this.discovery!;
      this.ranger = this.opts.createRanger(house, this.gate, ingress);
    }
    if (!this.gate.isActive()) return;
    this.inbox.start();
    // The public receiver is also the Ranger ingress: start it exactly once
    // with its real consumer. The legacy lane retains separate transports.
    if (this.world && (!this.opts.worldStreamMode || !this.ranger)) await this.world.start();
    if (!this.gate.isActive()) return;
    if (this.ranger) await this.ranger.start();
    if (!this.gate.isActive()) return;
    if (!house.cacheReadOnly && this.opts.refresh) {
      this.refreshTimer = setInterval(() => { void this.track(() => this.refreshHandshake(house)); }, this.opts.refreshMs ?? 60_000);
      this.refreshTimer.unref?.();
    }
  }

  private async refreshHandshake(house: HouseStore): Promise<void> {
    if (!this.opts.refresh || this.refreshing || !this.gate.isActive()) return;
    this.refreshing = true;
    try { await this.opts.refresh(house, this.gate); }
    catch (err) { this.opts.log?.(`house refresh (${house.slug}): ${String(err)}`); }
    finally { this.refreshing = false; }
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.abort.abort();
    const stops = [this.inbox, this.world, this.discovery, this.ranger].map(resource => {
      try { return Promise.resolve(resource?.stop()); }
      catch (err) { return Promise.reject(err); }
    });
    try { stops.push(Promise.resolve(this.inbox?.whenIdle())); }
    catch (err) { stops.push(Promise.reject(err)); }
    try {
      if (this.world && 'whenIdle' in this.world) stops.push(Promise.resolve(this.world.whenIdle?.()));
    } catch (err) { stops.push(Promise.reject(err)); }
    try {
      this.inboxConsumer?.stop();
      stops.push(Promise.resolve(this.inboxConsumer?.whenIdle()));
    } catch (err) { stops.push(Promise.reject(err)); }
    this.stopTask = (async () => {
      await this.startup;
      await Promise.allSettled(stops);
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    })();
    return this.stopTask;
  }
}
