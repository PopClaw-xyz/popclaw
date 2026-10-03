/**
 * A file-based cursor for "when did I last do this thing". Periodic work always asks
 * `[last time → now]`, never "yesterday" — a missed run just makes the next window bigger
 * automatically, and machine sleep / shutdown / cron downtime all self-heal without relying on
 * any scheduler's catch-up-run semantics (spec 2026-07-26 §1; the daily paper and the night
 * digest both share this one cursor).
 *
 * A missing/corrupt file is always treated as "never run": the cursor is an accelerator, not a
 * ledger — losing it at worst just widens one window.
 */
// The cursor is a small local file; HostAdapter has no general fs write surface, so this uses
// node:fs directly (same exemption).
/* eslint-disable no-restricted-imports */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/* eslint-enable no-restricted-imports */

export interface LastRunStore {
  get(): number | null;
  set(ts: number): void;
}

export function fileLastRun(stateFile: string): LastRunStore {
  return {
    get() {
      try {
        const v = JSON.parse(readFileSync(stateFile, 'utf-8')) as { lastRunAt?: unknown };
        return typeof v.lastRunAt === 'number' ? v.lastRunAt : null;
      } catch {
        return null;
      }
    },
    set(ts: number) {
      try {
        mkdirSync(dirname(stateFile), { recursive: true });
        writeFileSync(stateFile, JSON.stringify({ lastRunAt: ts }), 'utf-8');
      } catch {
        /* best-effort; next time it just recalculates the window as "never run" again */
      }
    },
  };
}
