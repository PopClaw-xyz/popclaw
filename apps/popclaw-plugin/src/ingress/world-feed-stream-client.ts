import { inspectPublicCarrier } from './public-stream-wire.js';
/**
 * WorldFeedStreamClient — live tail of lore-house's
 * GET /world-feed/stream SSE endpoint.
 *
 * Each SSE `data:` line is base64-encoded `WorldFeedItem` protobuf bytes
 * (same convention as /discovery's `DiscoveryFrame`). This client opens
 * the EventSource, decodes per-frame, and invokes a per-item callback.
 *
 * Reconnects use an application timer (5–10s jitter), checking the captured
 * gate and resuming only after a frame has been verified and consumed.
 */

import EventSource from 'eventsource';
import { verifyInboundEnvelope } from './verify-envelope.js';
import type { HouseGate } from '../runtime/house-lifecycle/manager.js';
import { popclaw } from '@popclaw/contracts';

export interface WorldFeedStreamOptions {
  readonly baseUrl: string;
  readonly isOfficialActor?: (actorId: string) => boolean;
  readonly gate?: Pick<HouseGate, 'isActive' | 'signal'>;
  readonly author?: string;
  readonly platform?: string;
  /** Backfill size on connect (server clamps to 1..=5000). */
  readonly limit?: number;
  /**
   * Resume cursor for the backfill, epoch **seconds** — the same unit the
   * frames carry in `platformPostCreatedAt`. Rows at or after it are re-sent
   * (`>=` server-side; the overlap is dedup'd by the cache's INSERT OR
   * REPLACE). Omit on a fresh install: the house then applies its own default
   * recent window instead.
   *
   * Older houses ignore an unknown query parameter, so sending it degrades to
   * the previous behaviour — a full-window backfill. Harmless, just chattier.
   */
  readonly since?: number;
  /**
   * Resume cursor for the backfill, the house's monotonic `insert_seq` — the
   * value it stamps on every SSE frame's `id:`. Exact `>` semantics, and
   * immune to the timestamp skew `since` suffers from (see below), so this is
   * the cursor to send whenever one is available.
   *
   * Seeds the first connection. Later connections use the latest verified
   * frame whose synchronous onItem consumer completed successfully.
   *
   * Older houses ignore an unknown query parameter and stamp no `id:`, so a
   * plugin talking to one never acquires a cursor and stays on `since`.
   */
  readonly after?: number;
  /**
   * `lastEventId` is the frame's SSE `id:` — the house's `insert_seq`, or ''
   * when the house does not stamp one. Persist it (WorldFeedCache
   * `recordInsertCursor`) or the cursor cannot survive a restart.
   */
  readonly onItem: (
    item: popclaw.event.IWorldFeedItem,
    bytes: Uint8Array,
    lastEventId: string,
  ) => void;
  readonly onError?: (err: unknown) => void;
  readonly reconnectDelayMs?: number;
  /** Injection point for tests (a fake EventSource ctor). */
  readonly eventSourceCtor?: new (url: string) => AnyEventSource;
}

export type AnyEventSource = {
  readonly url: string;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  close(): void;
};

/**
 * How far back of the newest cached row the resume cursor is placed.
 *
 * The margin is not paranoia, it is a unit mismatch we do not control. A frame
 * off the live tail stamps `platformPostCreatedAt` from the ENVELOPE timestamp
 * (when the house relayed it), while the row the house filters on stores, for
 * a mirror post, the ORIGIN timestamp (when the tweet was actually written).
 * A cursor taken raw from the cache therefore sits at relay time, and every
 * mirror post relayed during the outage whose source is older than that would
 * be filtered out of the backfill — silently, permanently.
 *
 * Overshooting costs re-sent frames the cache dedupes; undershooting costs
 * posts. A week absorbs any realistic scrape lag and still cuts the default
 * 30-day window down by 4x.
 *
 * Superseded by the `after` cursor (`world_feed_items.insert_seq`), which is
 * monotonic by construction and has no skew to absorb. This path survives as
 * the fallback for the two cases `after` cannot cover: a house too old to
 * stamp `id:` on its frames, and an existing install's first connection after
 * upgrading, before it has seen a stamped frame.
 */
export const SINCE_CURSOR_LOOKBACK_SECONDS = 7 * 24 * 3600;

/**
 * Turn "newest row this house's cache holds" into the `since` option, or into
 * nothing at all when the cache is empty (a fresh install must not pin itself
 * to an arbitrary floor — it wants the house's default window).
 */
export function worldFeedSince(newestCached: number | null): { since?: number } {
  if (newestCached === null || !Number.isFinite(newestCached) || newestCached <= 0) return {};
  return { since: Math.max(0, Math.floor(newestCached) - SINCE_CURSOR_LOOKBACK_SECONDS) };
}

/**
 * Pick this house's resume cursor: the persisted insert-order one if there is
 * one, else the timestamp fallback, else nothing (fresh install → the house's
 * default recent window).
 *
 * The fallback rung is the upgrade path and is expected to be taken exactly
 * once per existing install: a cache full of rows but no cursor yet is the
 * normal state on the first boot after upgrading, and one connection later
 * there is a cursor.
 */
export function worldFeedResume(
  insertCursor: number | null,
  newestCached: number | null,
): { after?: number; since?: number } {
  if (insertCursor !== null && Number.isFinite(insertCursor) && insertCursor > 0) {
    return { after: Math.floor(insertCursor) };
  }
  return worldFeedSince(newestCached);
}

export class WorldFeedStreamClient {
  private es: AnyEventSource | null = null;

  private stopped = false;
  private receiving = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private after: number | undefined;

  constructor(private readonly opts: WorldFeedStreamOptions) {
    this.after = opts.after;
    opts.gate?.signal.addEventListener('abort', () => this.stop(), { once: true });
  }

  private active(): boolean { return !this.stopped && (!this.opts.gate || this.opts.gate.isActive()); }
  isReceiving(): boolean { return this.active() && this.receiving; }

  start(): void {
    if (this.es || this.retryTimer || !this.active()) return; // idempotent
    const qs = new URLSearchParams();
    if (this.opts.author) qs.set('author', this.opts.author);
    if (this.opts.platform) qs.set('platform', this.opts.platform);
    if (this.opts.limit !== undefined) qs.set('limit', String(this.opts.limit));
    if (this.opts.since !== undefined) qs.set('since', String(this.opts.since));
    if (this.after !== undefined) qs.set('after', String(this.after));
    const url = `${this.opts.baseUrl}/world-feed/stream${qs.toString() ? `?${qs.toString()}` : ''}`;
    const Ctor =
      this.opts.eventSourceCtor ??
      (EventSource as unknown as new (url: string) => AnyEventSource);
    const es = new Ctor(url);
    (es as AnyEventSource & { onopen?: () => void }).onopen = () => {
      if (this.es !== es) return;
      if (!this.active()) { this.reconnect(es); return; }
      this.receiving = true;
    };
    es.onmessage = (e) => {
      if (this.es !== es) return;
      if (!this.active()) { this.reconnect(es); return; }
      try {
        const bytes = decodeBase64(e.data);
        inspectPublicCarrier(bytes, 'projection');
        const item = popclaw.event.WorldFeedItem.decode(bytes);
        verifyInboundEnvelope(item.envelope ?? new Uint8Array(), { publicStream: true, isOfficialActor: this.opts.isOfficialActor });
        this.opts.onItem(item, bytes, e.lastEventId ?? '');
        const seq = Number(e.lastEventId);
        if (Number.isSafeInteger(seq) && seq > (this.after ?? 0)) this.after = seq;
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
    this.es = es;
  }

  private reconnect(es: AnyEventSource): void {
    es.close();
    if (this.es !== es) return;
    this.es = null;
    this.receiving = false;
    if (!this.active() || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.active()) this.start();
    }, this.opts.reconnectDelayMs ?? 5000 + Math.floor(Math.random() * 5000));
    this.retryTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.receiving = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }
}

function decodeBase64(s: string): Uint8Array {
  // Node + browsers both have atob/Buffer; favour the most portable.
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(s, 'base64'));
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
