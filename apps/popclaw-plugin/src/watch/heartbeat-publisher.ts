/**
 * Emits one WatchHeartbeat payload per active watch on each tick.
 * The caller drives cadence (typically setInterval(60_000)).
 *
 * `emit` is responsible for signing + pushing the envelope; this module
 * just shapes the heartbeat payload from registry state.
 */

import type { WatchRegistry } from './watch-registry.js';

export interface HeartbeatShape {
  watchId: string;
  activeSince: number;  // seconds since epoch
  recentHits: number;
}

export interface HeartbeatPublisherDeps {
  registry: WatchRegistry;
  emit: (heartbeat: HeartbeatShape) => Promise<void> | void;
  now: () => number;
  loggerInfo?: (msg: string) => void;
}

export class HeartbeatPublisher {
  constructor(private readonly deps: HeartbeatPublisherDeps) {}

  async tick(): Promise<void> {
    const nowSecs = Math.floor(this.deps.now() / 1000);
    for (const entry of this.deps.registry.all()) {
      try {
        await this.deps.emit({
          watchId: entry.watchId,
          activeSince: nowSecs,
          recentHits: entry.state.consecutiveHits,
        });
      } catch (err) {
        this.deps.loggerInfo?.(`heartbeat: emit failed for ${entry.watchId}: ${String(err)}`);
      }
    }
  }
}
