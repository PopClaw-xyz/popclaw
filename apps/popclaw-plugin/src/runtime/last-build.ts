/**
 * Install-verification evidence — `openclaw plugins install` restarts the gateway, which kills
 * the agent turn that was doing the install; when the agent comes back with no memory of it,
 * there's no trace on the machine that "popclaw was just installed/upgraded", so it falsely
 * reports "install failed". This file (`data/last-build.json`) is that trace: at boot it
 * persists the current build, reports an upgrade once when the build changes, and leaves a
 * line of evidence in `popclaw status`.
 *
 * `data/` rather than `vault/` — this is regenerable state (delete it and a restart refills
 * it), not a valuable asset.
 *
 * The dev build (`'dev (unbundled)'`) skips the whole mechanism: a direct tsx run has no
 * stable build number, and treating it as "changed" every time would flood status with fake
 * upgrade notices.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEV_BUILD = 'dev (unbundled)';

export interface LastBuildSnapshot {
  readonly build: string;
  readonly recordedAt: string; // ISO 8601
}

export interface LastBuildRecord extends LastBuildSnapshot {
  readonly previous?: LastBuildSnapshot;
  /**
   * Install-echo once-only gate (issue #270): once this build's notification has successfully
   * gone through deliverNow once, this field gets set = the build itself. Only when it equals
   * `build` does it count as "already announced" — one build transition sends only once;
   * deliverNow()===false (no channel bound) doesn't write it, so the next boot retries
   * naturally. See markBuildAnnounced / runtime/install-notice.ts.
   */
  readonly announcedBuild?: string;
}

function readRecord(file: string): LastBuildRecord | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LastBuildRecord>;
    if (typeof v.build !== 'string' || typeof v.recordedAt !== 'string') return null;
    return {
      build: v.build,
      recordedAt: v.recordedAt,
      ...(v.previous ? { previous: v.previous } : {}),
      ...(typeof v.announcedBuild === 'string' ? { announcedBuild: v.announcedBuild } : {}),
    };
  } catch {
    return null;
  }
}

function writeRecord(file: string, rec: LastBuildRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rec), 'utf-8');
}

/** `popclaw status` reads this to render the upgrade-evidence line. Missing/corrupt both count as absent — silently skip that line, never crash. */
export function readLastBuild(file: string): LastBuildRecord | null {
  return readRecord(file);
}

/**
 * Called once early in boot (runs on every gateway start, including the vast majority of
 * ordinary restarts where "nothing changed").
 *
 * - File doesn't exist → just persist, don't call `onUpgrade` (can't tell a fresh install
 *   apart from an upgrade from an old version that predates this feature, so don't guess).
 * - Same build → no-op (no write, no `onUpgrade` call) — this is the steady-state path on
 *   every restart.
 * - Build changed → update the file (with a `previous` snapshot) + call `onUpgrade(from, to)`
 *   once; the caller is responsible for posting to the social log / logging.
 * - File corrupt/wrong shape → treat as if it doesn't exist, rewrite, don't call `onUpgrade`
 *   (same as "file doesn't exist").
 */
export function recordBuildOnBoot(
  file: string,
  build: string,
  onUpgrade?: (from: LastBuildSnapshot, to: LastBuildSnapshot) => void,
  now: () => Date = () => new Date(),
): void {
  if (build === DEV_BUILD) return;
  const prev = readRecord(file);
  const recordedAt = now().toISOString();
  if (prev === null) {
    writeRecord(file, { build, recordedAt });
    return;
  }
  if (prev.build === build) return;
  const previous: LastBuildSnapshot = { build: prev.build, recordedAt: prev.recordedAt };
  const to: LastBuildSnapshot = { build, recordedAt };
  writeRecord(file, { ...to, previous });
  onUpgrade?.(previous, to);
}

/**
 * Writes back once "this one has already been announced" (issue #270) after the install echo
 * has actually been delivered. Only called on the success path where deliverNow() returns
 * true — if the caller fails or has no channel bound, this isn't called, letting the next
 * boot retry naturally without needing a separate retry queue.
 *
 * Re-validates against the current build before writing: in the rare case the file was already
 * moved to a new build by the next recordBuildOnBoot between the two reads (theoretically a
 * very rare overlapping-boot scenario), it's better to let this echo's mark fall through than
 * to contaminate the new build's record as "old build already notified".
 */
export function markBuildAnnounced(file: string, build: string): void {
  const rec = readRecord(file);
  if (rec === null || rec.build !== build) return;
  writeRecord(file, { ...rec, announcedBuild: build });
}
