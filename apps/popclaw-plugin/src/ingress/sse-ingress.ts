import { inspectPublicCarrier } from './public-stream-wire.js';
import EventSource from 'eventsource';
import { verifyInboundEnvelope } from './verify-envelope.js';
import type { HouseGate } from '../runtime/house-lifecycle/manager.js';
import type { EventIngress, EnvelopeHandler } from './event-ingress.js';
import { SeenSet } from './seen-set.js';
import type { HostAdapter, CancelHandle } from '../host/host-adapter.js';
import { describeSseError } from './sse-error.js';

export interface SseIngressOptions {
  readonly baseUrl: string;
  readonly isOfficialActor?: (actorId: string) => boolean;
  readonly gate?: Pick<HouseGate, 'isActive' | 'signal'>;
  /** How long of radio silence forces a reconnect. Default 60s. */
  readonly silenceBudgetMs?: number;
  /** Base backoff delay. Each failure doubles up to maxBackoffMs. */
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /**
   * How many recent events to ask the house to replay **on a reconnect**
   * (`?snapshot=lastN`). Default 100; 0 disables.
   */
  readonly reconnectSnapshot?: number;
  /** Source of EventSource class (injectable for tests). */
  readonly eventSourceCtor?: typeof EventSource;
}

type AnyEventSource = {
  readonly url: string;
  onmessage: ((e: { data: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onopen?: ((e: unknown) => void) | null;
  close(): void;
};

export class SseIngress implements EventIngress {
  private readonly seen = new SeenSet();
  private readonly silenceBudgetMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly reconnectSnapshot: number;
  private readonly eventSourceCtor: new (url: string) => AnyEventSource;

  private es: AnyEventSource | null = null;
  private silenceHandle: CancelHandle | null = null;
  private reconnectHandle: CancelHandle | null = null;
  private consecutiveFailures = 0;
  private stopped = false;
  private readonly inFlight = new Set<Promise<void>>();
  private handler: EnvelopeHandler = () => {};
  /** #144: fired after every stream open, so the caller can re-announce itself. */
  private connectedCb: (() => void) | null = null;
  private isOpen = false;
  /** False until the first stream opens; gates the reconnect-only replay. */
  private hasConnectedOnce = false;

  constructor(
    private readonly opts: SseIngressOptions,
    private readonly host: HostAdapter,
  ) {
    opts.gate?.signal.addEventListener('abort', () => { void this.stop(); }, { once: true });
    this.silenceBudgetMs = opts.silenceBudgetMs ?? 60_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.reconnectSnapshot = opts.reconnectSnapshot ?? 100;
    this.eventSourceCtor = (opts.eventSourceCtor ??
      (EventSource as unknown as typeof EventSource)) as unknown as new (
      url: string,
    ) => AnyEventSource;
  }

  private active(): boolean { return !this.stopped && (!this.opts.gate || this.opts.gate.isActive()); }

  async start(onEnvelope: EnvelopeHandler): Promise<void> {
    if (!this.active()) return;
    this.handler = onEnvelope;
    this.connect();
  }

  /**
   * #144: run `cb` after every (re)connect. The ranger uses it to re-send its
   * RangerRegistration, which is what makes the lore-house re-emit WatchDispatch
   * for its pinned assignments — recovery rides an at-most-once channel, so it
   * has to be re-asked for on the near side of a subscription, never before it.
   *
   * Registering late is fine: if the stream is already open, `cb` runs now. That
   * removes the ordering trap for callers who only learn what to announce after
   * `start()` has been called.
   */
  onConnected(cb: () => void): void {
    this.connectedCb = cb;
    if (this.isOpen) cb();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.isOpen = false;
    this.silenceHandle?.cancel();
    this.reconnectHandle?.cancel();
    this.es?.close();
    this.es = null;
    await Promise.allSettled([...this.inFlight]);
  }

  private connect(): void {
    if (!this.active()) return;
    // A stream is at-most-once: whatever the house sent while we were
    // disconnected is gone. `/v1/discovery` already serves `?snapshot=lastN`
    // (it replays N recent events before the live tail), and the plugin simply
    // never asked for it — so a quest dispatched during a blip was lost until
    // the task expired 48h later (#182 factor 3, which is a client-side gap,
    // not the protocol gap the issue assumed).
    //
    // Only on RECONNECT, never on the first connect. `SeenSet` is what makes
    // replay free — it dedupes by event_id — and it lives in this process, so
    // it is populated on a reconnect and empty at startup. Replaying into an
    // empty SeenSet would re-run handlers for events already handled in an
    // earlier process: a re-verify costs a real scrape (money), and a
    // re-submitted result is a 409. Startup recovery is a different mechanism
    // (re-registration, #144); this is only for the gap a blip opens.
    const replay = this.hasConnectedOnce && this.reconnectSnapshot > 0
      ? `?snapshot=last${this.reconnectSnapshot}`
      : '';
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/v1/discovery${replay}`;
    const es = new this.eventSourceCtor(url);
    this.es = es;
    this.isOpen = false;
    this.armSilenceWatchdog();

    es.onopen = () => {
      if (this.es !== es) return;
      if (!this.active()) { void this.stop(); return; }
      this.isOpen = true;
      this.hasConnectedOnce = true;
      // A reconnect that nobody can see reads as an outage. Say it happened,
      // at info — the level the owner's host actually shows (#142).
      if (this.consecutiveFailures > 0) {
        this.host.logger.info(
          { url, afterFailures: this.consecutiveFailures },
          'sse-ingress: reconnected',
        );
      }
      this.consecutiveFailures = 0;
      this.connectedCb?.();
    };

    es.onmessage = (ev) => {
      if (this.es !== es) return;
      if (!this.active()) { void this.stop(); return; }
      this.consecutiveFailures = 0;
      this.armSilenceWatchdog();
      this.onData(ev.data);
    };

    es.onerror = (err) => {
      // close() must precede the gate check: native retries bypass that gate.
      es.close();
      if (this.es !== es) return;
      this.es = null;
      this.isOpen = false;
      this.silenceHandle?.cancel();
      if (!this.active()) return;
      // #142: the error object carries status/code/message; String() renders it
      // `[object Object]` and a whole day of field logs said exactly that.
      this.host.logger.warn(
        { url, err: describeSseError(err) },
        'sse-ingress: stream error',
      );
      // Close BEFORE scheduling: `eventsource` reconnects on its own after 1s,
      // so an unclosed errored stream comes back to life while our backoff
      // opens a second one. Every network blip then leaks one connection
      // permanently (26 orphans observed on a real host, exhausting the mux).
      // Closing here makes scheduleReconnect() the only reconnect layer.
      this.scheduleReconnect();
    };
  }

  private armSilenceWatchdog(): void {
    if (!this.active()) return;
    this.silenceHandle?.cancel();
    this.silenceHandle = this.host.timer.schedule(this.silenceBudgetMs, () => {
      this.host.logger.warn(
        { budgetMs: this.silenceBudgetMs },
        'sse-ingress: silence budget exceeded; forcing reconnect',
      );
      this.es?.close();
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    this.es?.close();
    this.es = null;
    this.isOpen = false;
    this.silenceHandle?.cancel();
    if (!this.active()) return;
    this.consecutiveFailures++;
    const exponent = Math.min(this.consecutiveFailures, 10);
    let delay = Math.min(this.baseBackoffMs * Math.pow(2, exponent - 1), this.maxBackoffMs);
    const jitter = delay * 0.5 * (Math.random() * 2 - 1);
    delay = Math.max(100, Math.round(delay + jitter));
    // #142: "dropped but healing itself" must be readable as such. Without the
    // plan, a reconnect log is indistinguishable from a stall.
    this.host.logger.info(
      { delayMs: delay, attempt: this.consecutiveFailures },
      'sse-ingress: retrying',
    );
    this.reconnectHandle?.cancel();
    this.reconnectHandle = this.host.timer.schedule(delay, () => this.connect());
  }

  private onData(data: string): void {
    if (!this.active()) return;
    let bytes: Uint8Array;
    try {
      bytes = base64Decode(data.trim());
    } catch (err) {
      this.host.logger.warn({ err: String(err) }, 'sse-ingress: base64 decode failed');
      this.scheduleReconnect();
      return;
    }
    let envelope;
    try {
      const originals = inspectPublicCarrier(bytes, 'discovery');
      if (!originals.length) return;
      envelope = verifyInboundEnvelope(originals[0]!, { publicStream: true, isOfficialActor: this.opts.isOfficialActor });
    } catch (err) {
      this.host.logger.warn({ err: String(err) }, 'sse-ingress: envelope rejected');
      this.scheduleReconnect();
      return;
    }
    const frame = { event: envelope };
    const { eventId } = frame.event;
    if (this.seen.has(eventId)) return;
    this.seen.add(eventId);
    const task = Promise.resolve().then(async () => {
      if (this.active()) await this.handler({ eventId, envelope: frame.event! as unknown as Record<string, unknown> });
    }).catch((err) => {
      this.host.logger.error({ err: String(err) }, 'sse-ingress: handler threw');
    }).finally(() => { this.inFlight.delete(task); });
    this.inFlight.add(task);
  }
}

function base64Decode(b64: string): Uint8Array {
  // atob is a global in Node 20+; avoids pulling in node:buffer.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
