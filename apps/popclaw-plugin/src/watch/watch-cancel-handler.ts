/**
 * Receives inbound WatchCancel events; removes the slice from the local
 * WatchRegistry. Unknown watch_id is a no-op.
 */

import type { InboundEnvelope } from '../ingress/event-ingress.js';
import type { WatchRegistry } from './watch-registry.js';

export interface WatchCancelHandlerDeps {
  registry: WatchRegistry;
  loggerInfo?: (msg: string) => void;
}

interface WatchCancelShape {
  watchId?: string;
  reason?: string;
}

export function handleWatchCancel(
  inbound: InboundEnvelope,
  deps: WatchCancelHandlerDeps,
): void {
  const raw = (inbound.envelope['watchCancel'] ?? null) as WatchCancelShape | null;
  if (!raw || !raw.watchId) return;
  const had = deps.registry.has(raw.watchId);
  deps.registry.remove(raw.watchId);
  if (had) {
    deps.loggerInfo?.(`watch-cancel: watch=${raw.watchId} reason=${raw.reason ?? 'unknown'}`);
  }
}
