/**
 * Plan 12.2b — InboxStreamClient.
 *
 * Live tail of lore-house's GET /inbox/:popclaw_id/stream. Per-recipient
 * SSE channel that emits DirectMessage protobuf frames base64-encoded as
 * SSE data lines (same convention as WorldFeedStreamClient).
 *
 * The plugin subscribes its OWN popclaw_id at boot. Each decoded DM is
 * handed to the `onMessage` callback which appends to inbox.jsonl.
 *
 * ── Auth ────────────────────────────────────────────────────────────────
 * The endpoint used to be open to anyone who knew a popclaw_id, which is
 * public. It now wants a credential in `x-popclaw-inbox-token`, and this
 * client no longer mints one itself: `readToken` is supplied by whoever owns
 * the house, because choosing HOW to prove who is reading is one decision for
 * the whole client (`identity/read-authority.ts`) and not a fallback each
 * transport reinvents. A refusal rejects that promise, so the connection is
 * never opened — the stream never asks anonymously and never falls back.
 *
 * Minted per CONNECT, never reused across one: a credential is fresh for a
 * request, not a budget for a session, and every reconnect re-asks.
 */

import EventSource from 'eventsource';
import { verifyInboundEnvelope } from '../ingress/verify-envelope.js';
import type { HouseGate } from '../runtime/house-lifecycle/manager.js';
import { popclaw } from '@popclaw/contracts';
import { hostDbSlug } from '../ingress/host-slug.js';
import { INBOX_TOKEN_HEADER } from '../identity/read-credential.js';
import type { ReadAuthority } from '../identity/read-authority.js';

// The header name is owned by the credential module now; re-exported here so
// the many existing importers keep one import path.
export { INBOX_TOKEN_HEADER } from '../identity/read-credential.js';

/**
 * SSE `event:` name every DM frame carries (P0-A hardening 1). Must match the
 * house's `INBOX_ENVELOPE_EVENT` in `http/inbox_stream.rs`. A frame that arrives
 * on the DEFAULT (unnamed `message`) event instead means the house is an OLD one
 * still relaying bare DirectMessage frames — a version mismatch we fail loud on
 * rather than mis-decode. Named vs default is the near-zero-cost discriminator.
 */
export const INBOX_ENVELOPE_EVENT = 'envelope';
export const INBOX_CURSOR_RESET_EVENT = 'cursor-reset';

/**
 * Re-auth backoff after a 401. Exponential from 1s, capped at 5 min.
 *
 * A cap-less 1s retry looks fine while the only cause of a 401 is an expired
 * token (one retry, done). It is a disaster for the other cause: a machine
 * whose clock is off by more than the house's 60s window can NEVER mint an
 * acceptable token, so every re-sign fails and the client hammers the house
 * once a second, forever, on battery — while presenting the exact symptom
 * (dead inbox) that this reconnect path exists to prevent.
 */
const REAUTH_BASE_DELAY_MS = 1_000;
const REAUTH_MAX_DELAY_MS = 5 * 60_000;

/**
 * The ladder above, as a function, so the other thing that retries a refused
 * credential against the same house climbs the SAME one.
 *
 * Exported because a second ladder is a second set of numbers to get wrong,
 * and the relation chain's attach retry is the same problem seen one layer up
 * (`relation-host.ts`): a house that refuses now may accept in a moment, and
 * asking again every couple of seconds for as long as the refusal lasts is how
 * a client becomes a beacon. `failures` is the count of consecutive failures
 * INCLUDING the one just seen, so the first retry waits the base delay.
 */
export function reauthBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(REAUTH_BASE_DELAY_MS * 2 ** (failures - 1), REAUTH_MAX_DELAY_MS);
}
/** Consecutive 401s before we stop assuming it's an expired token and say so. */
const REAUTH_ALERT_AFTER = 3;

export type EventSourceInit = { readonly headers?: Record<string, string> };

export interface InboxStreamOptions {
  readonly baseUrl: string;
  readonly recipientPopclawId: string;
  /** `envelopeBytes` is the full signed EventEnvelope this DM arrived in
   *  (ADR-0029 / P0-A) — persist it so v0.2 can verify the sender's signature. */
  /** `senderNickname` is `envelope.actor.nickname` — the sender's own name for
   *  themselves. The envelope is decoded here anyway; dropping it was why a real
   *  owner's first feedback DM announced itself as a bare `#n3tzfhnt` (#281).
   *  Untrusted by nature, which is why every surface renders it as
   *  `nickname#sigil` — the sigil is derived from the key and cannot be claimed. */
  readonly onMessage: (
    dm: popclaw.event.IDirectMessage,
    envelopeBytes: Uint8Array,
    senderNickname: string,
  ) => void | Promise<void>;
  readonly onError?: (err: unknown) => void;
  /**
   * The credential for ONE connection, minted by whoever owns this house.
   *
   * Required and the only source: a client that could mint its own would be
   * a second place deciding how to authenticate, and the one that decides
   * least often is the one that stays wrong the longest. Rejecting means the
   * connection is not opened at all.
   */
  readonly readToken: () => Promise<string>;
  readonly gate?: Pick<HouseGate, 'isActive' | 'signal'>;
  /**
   * Every VERIFIED envelope on this stream that is not a DM.
   *
   * The house serves relations down the same connection as private messages,
   * so this callback is how they reach the relation wiring. Without it the
   * handler says `if (!env.directMessage) return` and every relation event
   * the house delivered is dropped on the floor without a word.
   *
   * `position` is the frame's SSE `id:`, which is what the commit boundary
   * persists so a RESTART can resume — `eventsource@2` replays the id by
   * itself across a reconnect, but its memory dies with the process.
   */
  readonly onFrame?: (envelopeBytes: Uint8Array, position: string | undefined) => void | Promise<void>;
  /**
   * Route VERIFIED DM frames to `onFrame` too, instead of `onMessage`.
   *
   * With this set, a verified DM goes to `onFrame` with its transport
   * position — into the same commit boundary as relation events (raw frame,
   * durable todo, one cursor) — and its slow business work happens on the
   * drain. `onMessage` then never fires from the wire directly; a root
   * without this option keeps the exact behaviour it has always had.
   */
  readonly routeDmFramesToOnFrame?: boolean;
  /**
   * What the house says when it could not honour the cursor we resumed from.
   * Carries the SERIAL of the connection it arrived on: a reset from a
   * connection that has since been replaced (reconnect) is a stale
   * connection's word and must not mark debts for the world that now is.
   */
  readonly onCursorReset?: (reset: InboxCursorReset, connectionSerial: number) => void;
  /**
   * The position to resume from on connect, when we have one stored.
   *
   * For restarts, and for OUR reconnects: the client tears down on error and
   * re-runs start(), which re-reads this — so a cursor the house just refused
   * must not be resent by an ordinary reconnect.
   */
  readonly resumeFrom?: () => string | undefined;
  readonly reconnectDelayMs?: number;
  /** Injection point for tests (a fake EventSource ctor). */
  readonly eventSourceCtor?: new (url: string, init?: EventSourceInit) => AnyEventSource;
}

/** One SSE frame. `lastEventId` is the `id:` line, absent when there is none. */
export interface SseFrame {
  readonly data: string;
  readonly lastEventId?: string;
}

export type AnyEventSource = {
  readonly url: string;
  onmessage: ((e: SseFrame) => void) | null;
  onerror: ((e: unknown) => void) | null;
  addEventListener(type: string, listener: (e: SseFrame) => void): void;
  close(): void;
};

/** What the house says when it could not honour the cursor we resumed from. */
export interface InboxCursorReset {
  readonly reason: string;
  /** Quoted on the wire, and kept a string here: it spans the whole i64 range
   *  and `Number` would round it into a log that does not exist. */
  readonly logGeneration: string;
  readonly floor: string;
  /** How the house says to recover. Today: `snapshot`. */
  readonly reconcile: string;
}

/** One connection's durable stage: its queue, and whether it was abandoned. */
interface ConnectionQueue {
  readonly es: AnyEventSource;
  chain: Promise<void>;
  abandoned: boolean;
}

export class InboxStreamClient {
  private es: AnyEventSource | null = null;
  private connecting = false;
  private stopped = false;
  private receiving = false;
  /** Consecutive 401s; reset by any frame that actually arrives. */
  private authFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** One legacy-frame alarm per connection — enough to be loud, not a flood. */
  private warnedLegacyHouse = false;
  /** One alarm per connection for relation frames nothing is wired to take. */
  private warnedUnwiredFrame = false;
  /**
   * Monotonic, NEVER reused: open() takes ++nextSerial, so a stop/open cycle
   * can never hand a new connection the same serial an old one held. With
   * -1/+1 arithmetic it returned to 0 every cycle and a stale serial-0 reset
   * could impersonate the new connection.
   */
  private nextSerial = 0;
  private connectionSerial = 0;

  /** The serial of the CURRENT connection (0 before the first open). */
  currentConnectionSerial(): number {
    return this.connectionSerial;
  }
  private readonly authTasks = new Set<Promise<void>>();
  private readonly messageTasks = new Set<Promise<void>>();

  constructor(private readonly opts: InboxStreamOptions) {
    opts.gate?.signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  private active(): boolean {
    return !this.stopped && (!this.opts.gate || this.opts.gate.isActive());
  }

  isReceiving(): boolean { return this.active() && this.receiving; }

  start(): void {
    if (this.es || this.connecting || this.retryTimer || (this.opts.gate && !this.opts.gate.isActive())) return; // idempotent
    this.stopped = false;
    this.connecting = true;
    const token = Promise.resolve().then(() => this.active() ? this.opts.readToken() : '');
    const task = token
      .then((token) => {
        if (!this.active()) return;
        // An empty credential opens nothing, and used to say nothing either.
        // Silent AND final is the worst of both: climb the ladder instead.
        if (!token) { this.retryUnopened(); return; }
        // A stored position only matters across a restart. Sending it is how
        // a process that died resumes where it stopped instead of replaying
        // the whole backlog or skipping it.
        const resume = this.opts.resumeFrom?.();
        this.open({
          [INBOX_TOKEN_HEADER]: token,
          ...(resume !== undefined ? { 'Last-Event-ID': resume } : {}),
        });
      })
      .catch((err) => { this.opts.onError?.(err); this.retryUnopened(); })
      .finally(() => {
        this.connecting = false;
        this.authTasks.delete(task);
      });
    this.authTasks.add(task);
  }

  /**
   * Queue one unit of the connection's DURABLE stage, and run it only when
   * everything that arrived before it has finished.
   *
   * Tracking each frame's promise is not the same as ordering them. Handing
   * every frame to the callback on arrival lets a slow F1 and a fast F2 race:
   * F2 commits and writes the stream position past F1, then F1 fails. The
   * teardown reconnects and resumes from F2's position — F1 is behind it,
   * nothing re-delivers it, and the cursor says it was handled. One slow write
   * becomes a hole no retry can reach.
   *
   * So the durable stage is serial per connection. The SLOW half is not: a
   * consumer that wants to decrypt, fetch or notify does that after its own
   * commit returns, off this queue.
   *
   * A failure ABANDONS the rest of the queue rather than draining it —
   * committing the frames behind a failed one is the very thing that writes a
   * position past a frame that never landed. And every unit re-checks the
   * connection, the gate and the abandon flag when its turn comes, because
   * all three can change while it waits.
   */
  private enqueueDurable(conn: ConnectionQueue, run: () => void | Promise<void>): void {
    const task = (conn.chain = conn.chain.then(async () => {
      if (conn.abandoned || this.es !== conn.es || !this.active()) return;
      try {
        await run();
      } catch (err) {
        conn.abandoned = true;
        this.reconnect(conn.es, err);
      }
    }));
    this.messageTasks.add(task);
    void task.finally(() => { this.messageTasks.delete(task); });
  }

  private deliverFrame(conn: ConnectionQueue, bytes: Uint8Array, position: string | undefined): void {
    this.enqueueDurable(conn, () => this.opts.onFrame?.(bytes, position));
  }

  private open(headers: Record<string, string>): void {
    if (!this.active()) return;
    const url = `${this.opts.baseUrl}/inbox/${encodeURIComponent(this.opts.recipientPopclawId)}/stream`;
    const Ctor =
      this.opts.eventSourceCtor ??
      (EventSource as unknown as new (url: string, init?: EventSourceInit) => AnyEventSource);
    const es = new Ctor(url, { headers });
    // All retries are application-controlled, so each request checks the gate
    // and obtains a fresh token instead of replaying EventSource's old headers.
    this.warnedLegacyHouse = false;
    this.warnedUnwiredFrame = false;
    this.connectionSerial = ++this.nextSerial;
    // One queue per connection. A reconnect gets a fresh one, so a frame that
    // was waiting behind a failure on the old connection cannot resume on the
    // new one under the new connection's position.
    const conn: ConnectionQueue = { es, chain: Promise.resolve(), abandoned: false };
    // Captured NOW, not read at delivery time: the listener closure outlives
    // this connection (a replaced EventSource may still fire it late), and a
    // late read of the field would carry the NEW connection's serial.
    const connectionSerial = this.connectionSerial;
    // The house could not honour the cursor we asked to resume from. Carries
    // no `id:`, so announcing it cannot itself move a cursor.
    es.addEventListener(INBOX_CURSOR_RESET_EVENT, (e) => {
      if (this.es !== es) return;
      if (!this.active()) { this.stop(); return; }
      try {
        const parsed = JSON.parse(e.data) as Record<string, unknown>;
        const reset: InboxCursorReset = {
          reason: String(parsed.reason ?? ''),
          logGeneration: String(parsed.log_generation ?? ''),
          floor: String(parsed.floor ?? ''),
          reconcile: String(parsed.reconcile ?? ''),
        };
        if (this.opts.onCursorReset) {
          // Behind the frames already queued: a reset speaks about the
          // position, and announcing it while an earlier frame is still
          // committing puts the two statements out of order.
          this.enqueueDurable(conn, () => this.opts.onCursorReset?.(reset, connectionSerial));
          return;
        }
        // Unwired is not the same as nothing happening: the house has just
        // said it skipped past us. Say so rather than resume as if healthy.
        this.opts.onError?.(
          new Error(
            `inbox stream: ${this.opts.baseUrl} could not honour our cursor (${reset.reason}) ` +
              'and no handler is wired to reconcile — relation state may have a gap',
          ),
        );
      } catch (err) {
        this.opts.onError?.(err);
      }
    });
    (es as AnyEventSource & { onopen?: () => void }).onopen = () => {
      if (this.es !== es) return;
      if (!this.active()) { this.stop(); return; }
      this.receiving = true;
    };
    // Normal path: every DM frame arrives on the named `envelope` event.
    es.addEventListener(INBOX_ENVELOPE_EVENT, (e) => {
      if (this.es !== es) return;
      if (!this.active()) { this.stop(); return; }
      // A frame arrived, so the token was accepted — forget the failure streak.
      this.authFailures = 0;
      let bytes: Uint8Array;
      let env: popclaw.event.IEventEnvelope;
      try {
        // P0-A: the frame is the full signed EventEnvelope (ADR-0029), not a bare
        // DirectMessage. Decode it, hand the DM (ciphertext/nonce ride inside —
        // encryption dual-read unaffected) plus the raw envelope bytes for
        // persistence. A non-DM envelope here is not expected; skip it rather
        // than throw (never poison the loop).
        bytes = decodeBase64(e.data);
        env = verifyInboundEnvelope(bytes, { recipientPopclawId: this.opts.recipientPopclawId });
      } catch (err) {
        // Invalid wire data cannot be repaired by retrying the consumer.
        this.opts.onError?.(err);
        return;
      }
      if (!env.directMessage) {
        // Relations ride this same connection. This used to be a bare
        // `return`, so every relation event the house delivered vanished
        // without a word — the stream looked healthy and the graph never
        // moved.
        if (this.opts.onFrame) {
          this.deliverFrame(conn, bytes, e.lastEventId);
          return;
        }
        if (!this.warnedUnwiredFrame) {
          this.warnedUnwiredFrame = true;
          this.opts.onError?.(
            new Error(
              `inbox stream: ${this.opts.baseUrl} delivered a non-DM envelope and nothing is ` +
                'wired to take it; relation events are being dropped',
            ),
          );
        }
        return;
      }
      if (this.opts.routeDmFramesToOnFrame && this.opts.onFrame) {
        // Same boundary as relation events: the position travels with the
        // frame, and the business work happens after the commit, on drain.
        this.deliverFrame(conn, bytes, e.lastEventId);
        return;
      }
      try {
        const received = this.opts.onMessage(env.directMessage, bytes, (env.actor?.nickname ?? '').trim());
        if (received) {
          const task = Promise.resolve(received)
            .catch(err => this.reconnect(es, err))
            .finally(() => { this.messageTasks.delete(task); });
          this.messageTasks.add(task);
        }
      } catch (err) {
        this.reconnect(es, err);
      }
    });
    // Alarm path (hardening 1): a DEFAULT (unnamed) event means an OLD house is
    // relaying bare DirectMessage frames — version mismatch. Fail LOUD; never
    // decode or silently skip. The DM is not stored, so once the house/plugin
    // are back in sync the next reconnect's backfill re-delivers it (dropped →
    // delayed, not lost).
    es.onmessage = () => {
      if (this.es !== es) return;
      if (!this.active()) { this.stop(); return; }
      if (this.warnedLegacyHouse) return; // one loud alarm per connection
      this.warnedLegacyHouse = true;
      this.opts.onError?.(
        new Error(
          `inbox stream: detected a legacy-format lore-house frame (no named "${INBOX_ENVELOPE_EVENT}" event) from ` +
            `${this.opts.baseUrl} — lore-house and plugin versions are out of sync, please upgrade both. DMs will be ` +
            `redelivered by backfill after the reconnect, nothing is lost.`,
        ),
      );
    };
    es.onerror = err => this.reconnect(es, err, true);
    this.es = es;
  }

  private reconnect(es: AnyEventSource, err: unknown, networkFailure = false): void {
    es.close();
    if (this.es !== es) return;
    this.es = null;
    this.receiving = false;
    if (!this.active()) return;
    // Reconnect after a failed consumer as well as a network error. The house
    // replays retained DMs from the beginning on each new connection; there is
    // no acknowledged inbox cursor to advance before local persistence.
    // Always refresh the token instead of EventSource reusing old headers.
    try { this.opts.onError?.(err); }
    finally {
      if (networkFailure && (err as { status?: number } | null)?.status === 401) this.reauth();
      else this.scheduleRetry(this.opts.reconnectDelayMs ?? 5000 + Math.floor(Math.random() * 5000));
    }
  }

  /** Rebuild the connection with a freshly signed token, backing off. */
  private reauth(): void {
    if (!this.active()) return;
    this.authFailures += 1;
    // A fresh token that is STILL rejected is not an expiry problem, and no
    // amount of retrying will fix it. Say so once, loudly, through the same
    // channel the owner already sees — silent spinning is the failure mode
    // this whole path exists to avoid.
    if (this.authFailures === REAUTH_ALERT_AFTER) {
      this.opts.onError?.(
        new Error(
          `inbox stream: ${this.authFailures} freshly-signed tokens rejected in a row by ` +
            `${this.opts.baseUrl}. Most likely this machine's clock is off by more than 60s ` +
            `(the house's freshness window); otherwise the identity key no longer matches ` +
            `${this.opts.recipientPopclawId}. Retrying with backoff, but DMs will not arrive ` +
            `until this is fixed.`,
        ),
      );
    }
    this.scheduleRetry(this.reauthDelayMs());
  }

  /**
   * The connection was never opened: the authority refused the credential, or
   * handed back an empty one. Both used to end the promise chain right there.
   *
   * `reconnect()` is unreachable from here — there is no socket to tear down —
   * so nothing else would ever call `start()` again, and the one caller there
   * is (`house-lifecycle/resource-set.ts`) calls it once per process. On a
   * fresh data root the house's trust pin lands milliseconds after this first
   * ask, so a brand-new user's very first launch is exactly the case that lost
   * the race and kept a dead inbox for the life of the process.
   *
   * So climb the SAME ladder a 401 climbs: it counts the failure, so a house
   * that is genuinely untrusted is retried slowly (1s → 5min cap) and forever
   * rather than hammered or given up on, and the first frame that arrives
   * resets the streak. The delay is deliberately shared with `reauth()` — a
   * refused read token and a rejected read token are the same problem seen
   * before and after the socket.
   */
  private retryUnopened(): void {
    if (!this.active()) return;
    this.authFailures += 1;
    this.scheduleRetry(this.reauthDelayMs());
  }

  private reauthDelayMs(): number {
    return reauthBackoffMs(this.authFailures);
  }

  private scheduleRetry(delay: number): void {
    if (!this.active() || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.active()) this.start();
    }, delay);
    // Never hold the process open for a retry.
    (this.retryTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** Fence immediately. A consumer may await this without joining itself. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.receiving = false;
    // A pending re-auth must die with the client; otherwise an explicit stop()
    // is silently undone a few seconds later by the timer calling start().
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    await Promise.allSettled([...this.authTasks]);
  }

  /** After stop, the external resource owner joins already-started callbacks. */
  async whenIdle(): Promise<void> {
    while (this.authTasks.size || this.messageTasks.size) {
      await Promise.allSettled([...this.authTasks, ...this.messageTasks]);
    }
  }
}

/** One house's DM channel: slug (the inbound-message tag = the reply target) +
 *  baseUrl + its own stream. */
export interface HouseInboxStream {
  readonly slug: string;
  readonly baseUrl: string;
  readonly client: InboxStreamClient;
}

/**
 * Spec B slice 4: subscribe to one DM stream per house in `lore_houses`.
 *
 * Same discipline as the world stream: each stream reconnects on its own
 * (application-controlled retries), and callbacks and errors both carry the
 * source house's slug — one house being unreachable only affects that house.
 * **Cross-house dedup does not happen at this layer** — when two houses each
 * relay the same DM, `InboxStore`'s house-agnostic UNIQUE gate is what judges
 * the duplicate, so consumption only runs once (exactly-once).
 */
/**
 * An authority, as this transport wants it: a token, or a rejection naming
 * the refusal. The rejection is what keeps the connection from being opened —
 * an anonymous SSE subscription would be accepted by a house that has not
 * locked its inbox yet, and would look exactly like a working inbox.
 */
export function readTokenVia(authority: ReadAuthority): () => Promise<string> {
  return async () => {
    const outcome = await authority('inbox-stream');
    if (!outcome.ok) throw new Error(`${outcome.refusal}: ${outcome.message}`);
    return outcome.headers[INBOX_TOKEN_HEADER]!;
  };
}

export function openHouseInboxStreams(
  urls: readonly string[],
  opts: {
    readonly recipientPopclawId: string;
    readonly onMessage: (
      dm: popclaw.event.IDirectMessage,
      houseSlug: string,
      envelopeBytes: Uint8Array,
      senderNickname: string,
    ) => void | Promise<void>;
    readonly onError?: (houseSlug: string, err: unknown) => void;
    /**
     * How each house's reads prove who is asking, by that house's base URL.
     * One decision, made per house, re-made on every reconnect.
     */
    readonly readAuthorityFor: (baseUrl: string) => ReadAuthority;
    /** Every verified non-DM envelope, tagged with the house it came down. */
    readonly onFrame?: (
      envelopeBytes: Uint8Array,
      houseSlug: string,
      position: string | undefined,
    ) => void;
    /** See InboxStreamOptions.routeDmFramesToOnFrame — passed through per stream. */
    readonly routeDmFramesToOnFrame?: boolean;
    readonly onCursorReset?: (houseSlug: string, reset: InboxCursorReset, connectionSerial: number) => void;
    readonly resumeFrom?: (houseSlug: string) => string | undefined;
    readonly eventSourceCtor?: new (url: string, init?: EventSourceInit) => AnyEventSource;
  },
): HouseInboxStream[] {
  if (urls.length === 0) throw new Error('config.lore_houses must have at least one URL');
  return urls.map((baseUrl) => {
    const slug = hostDbSlug(baseUrl);
    return {
      slug,
      baseUrl,
      client: new InboxStreamClient({
        baseUrl,
        recipientPopclawId: opts.recipientPopclawId,
        onMessage: (dm, envelopeBytes, senderNickname) => opts.onMessage(dm, slug, envelopeBytes, senderNickname),
        onError: (err) => opts.onError?.(slug, err),
        readToken: readTokenVia(opts.readAuthorityFor(baseUrl)),
        ...(opts.onFrame
          ? { onFrame: (bytes: Uint8Array, position: string | undefined) => opts.onFrame?.(bytes, slug, position) }
          : {}),
        ...(opts.routeDmFramesToOnFrame ? { routeDmFramesToOnFrame: true } : {}),
        ...(opts.onCursorReset
          ? { onCursorReset: (reset: InboxCursorReset, serial: number) => opts.onCursorReset?.(slug, reset, serial) }
          : {}),
        ...(opts.resumeFrom ? { resumeFrom: () => opts.resumeFrom?.(slug) } : {}),
        ...(opts.eventSourceCtor ? { eventSourceCtor: opts.eventSourceCtor } : {}),
      }),
    };
  });
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
