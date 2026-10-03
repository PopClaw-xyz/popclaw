/**
 * Receives inbound WatchDispatch events and registers the (target, platform)
 * slice to the local WatchRegistry. Malformed payloads logged, no-op.
 *
 * pbjs emits oneof variants as camelCase on the envelope object.
 */

import type { InboundEnvelope } from '../ingress/event-ingress.js';
import { defaultEntry, type WatchRegistry } from './watch-registry.js';

export interface WatchDispatchHandlerDeps {
  registry: WatchRegistry;
  now: () => number;
  loggerInfo?: (msg: string) => void;
}

interface WatchDispatchShape {
  watchId?: string;
  targetPopclawId?: string;
  platform?: string;
  handle?: string;
  /** Epoch seconds this watch starts from; pbjs may hand an int64 back as a string. */
  since?: number | string;
}

export function handleWatchDispatch(
  inbound: InboundEnvelope,
  deps: WatchDispatchHandlerDeps,
): void {
  const raw = (inbound.envelope['watchDispatch'] ?? null) as WatchDispatchShape | null;
  if (!raw || !raw.watchId || !raw.targetPopclawId || !raw.platform) {
    deps.loggerInfo?.('watch-dispatch: malformed payload, ignoring');
    return;
  }
  // `handle` is required for any remote-API scraping; a WatchDispatch
  // without it is from an older lore-house and can't drive a useful
  // scrape (base58 popclaw_id is not a platform username).
  if (!raw.handle) {
    deps.loggerInfo?.(
      `watch-dispatch: missing handle for ${raw.platform}/${raw.targetPopclawId}, ignoring`,
    );
    return;
  }
  const nowMs = deps.now();
  const since = Number(raw.since ?? 0);
  deps.registry.add(
    raw.watchId,
    raw.targetPopclawId,
    raw.handle,
    raw.platform,
    defaultEntry(nowMs, Number.isFinite(since) ? since : 0, raw.platform),
  );
  deps.loggerInfo?.(
    `watch-dispatch: ${raw.platform}/${raw.handle} (watch=${raw.watchId}) registered`,
  );
}
