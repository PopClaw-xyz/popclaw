/**
 * "The last time a notification could not be delivered, and why" (issue #236).
 *
 * Real machine, 2026-07-28: one L1 sat in the queue for two days. Nothing was
 * lost — receive, decrypt, gate, enqueue, attempt, requeue all worked — but the
 * owner just felt "nothing is happening" and had nowhere to look. The reason
 * (WeChat's push window had closed: `sendMessage ret=-2 prepare failed`) went
 * only into the plugin's own log under /tmp, which is not even the gateway log.
 *
 * A silent failure is the worst kind of failure, so this makes it sayable in
 * `/popclaw status`. The file mirrors `last-run.ts`: best-effort, and a
 * missing or corrupt one means "nothing to report" — it is a note for the
 * owner, never a ledger anything depends on.
 */
// Small local state file; HostAdapter has no general fs write surface (same
// exemption as last-run.ts).
/* eslint-disable no-restricted-imports */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
/* eslint-enable no-restricted-imports */

export interface DeliveryFailure {
  /** Unix seconds. */
  readonly at: number;
  /** One line, already trimmed — the channel's own words, not ours. */
  readonly reason: string;
}

export interface DeliveryFailureStore {
  get(): DeliveryFailure | null;
  /** Record a failure. */
  set(f: DeliveryFailure): void;
  /** A successful delivery clears it — the owner should not be shown a stale
   *  worry after the channel came back. */
  clear(): void;
}

/** Keep the stored reason short: it is one line in a status page, and a channel
 *  error can be a whole stack. */
const REASON_MAX = 160;

export function fileDeliveryFailure(stateFile: string): DeliveryFailureStore {
  return {
    get() {
      try {
        const v = JSON.parse(readFileSync(stateFile, 'utf-8')) as { at?: unknown; reason?: unknown };
        if (typeof v.at !== 'number' || typeof v.reason !== 'string') return null;
        return { at: v.at, reason: v.reason };
      } catch {
        return null;
      }
    },
    set(f) {
      try {
        mkdirSync(dirname(stateFile), { recursive: true });
        writeFileSync(
          stateFile,
          JSON.stringify({ at: f.at, reason: f.reason.slice(0, REASON_MAX) }),
          'utf-8',
        );
      } catch {
        /* best-effort: failing to record a failure must not become a second failure */
      }
    },
    clear() {
      try {
        rmSync(stateFile, { force: true });
      } catch {
        /* same */
      }
    },
  };
}
