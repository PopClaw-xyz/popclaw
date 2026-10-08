import { ActionInactiveError } from '../runtime/house-lifecycle/action-context.js';
import { RemoteHouseReadError, houseReadFailure } from '../runtime/house-lifecycle/read-failure.js';
import { verifyInboundEnvelope } from './verify-envelope.js';
import { inspectPublicCarrier } from './public-stream-wire.js';
/**
 * WorldFeedClient — read client for lore-house's
 * GET /world-feed protobuf endpoint.
 *
 * Mirrors ServerPushEgress's shape (just GET instead of POST). Decodes
 * `WorldFeedSnapshot` via the generated TS bindings — wire format stays
 * protobuf end-to-end.
 */

import { popclaw } from '@popclaw/contracts';
import { LORE_HOUSE_TIMEOUT_MS } from '../world/http-timeout.js';

export interface WorldFeedClientOptions {
  readonly baseUrl: string;
  readonly isOfficialActor?: (actorId: string) => boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface WorldFeedQuery {
  readonly limit?: number;
  readonly author?: string;
  readonly platform?: string;
}

/** The snapshot read-side common surface: implemented by both a single house's
 *  `WorldFeedClient` and the cross-house `WorldFeedCatalog`.
 *  (The class has private fields = nominal typing, so downstream code must
 *  annotate against this interface if it's ever going to be swappable for the catalog.) */
export interface SnapshotSource {
  fetchSnapshot(q: WorldFeedQuery): Promise<popclaw.event.IWorldFeedItem[]>;
}

export class WorldFeedClient implements SnapshotSource {
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(private readonly opts: WorldFeedClientOptions) {
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async fetchSnapshot(q: WorldFeedQuery): Promise<popclaw.event.IWorldFeedItem[]> {
    const qs = new URLSearchParams();
    if (q.limit !== undefined) qs.set('limit', String(q.limit));
    if (q.author) qs.set('author', q.author);
    if (q.platform) qs.set('platform', q.platform);
    const qStr = qs.toString();
    const url = `${this.opts.baseUrl}/world-feed${qStr ? `?${qStr}` : ''}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        headers: { 'accept': 'application/x-protobuf' },
        signal: AbortSignal.timeout(LORE_HOUSE_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof ActionInactiveError) throw error;
      throw new RemoteHouseReadError(houseReadFailure(error,this.opts.baseUrl));
    }
    if (!res.ok) {
      throw new RemoteHouseReadError({code:'HOUSE_REMOTE_HTTP',origin:this.opts.baseUrl,status:res.status});
    }
    let buf: Uint8Array;
    try { buf = new Uint8Array(await res.arrayBuffer()); }
    catch (error) {
      if (error instanceof ActionInactiveError) throw error;
      throw new RemoteHouseReadError(houseReadFailure(error,this.opts.baseUrl));
    }
    try {
    const envelopes = inspectPublicCarrier(buf, 'snapshot');
    for (const envelope of envelopes) verifyInboundEnvelope(envelope, { publicStream: true, isOfficialActor: this.opts.isOfficialActor });
    const snap = popclaw.event.WorldFeedSnapshot.decode(buf);
    return snap.items ?? [];
    } catch (error) {
      if (error instanceof ActionInactiveError) throw error;
      throw new RemoteHouseReadError({code:'HOUSE_REMOTE_PARSE',origin:this.opts.baseUrl});
    }
  }
}
