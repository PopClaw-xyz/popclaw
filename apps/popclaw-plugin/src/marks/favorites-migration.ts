/**
 * Retirement migration of favorites.jsonl (the old onboarding favorites, rows of
 * {ts, event_id, summary_line}): if it exists at startup, INSERT each row into the local marks
 * table (platform='popclaw', body unknown so summary_line stands in for bodySnapshot), then
 * rename to favorites.jsonl.migrated to prevent re-running.
 * Old favorites don't get retroactively signed as historical Mark events (spec §7) — this is a
 * pure local import.
 */
// A local-private-domain file; same exemption as favorites-writer.ts / taste-writer.ts:
/* eslint-disable no-restricted-imports */
import { existsSync, readFileSync, renameSync } from 'node:fs';
/* eslint-enable no-restricted-imports */
import type { MarksStore } from './marks-store.js';

/** FavoriteRecord (favorites.jsonl row shape, originally from favorites-writer.ts). */
interface LegacyFavoriteRecord {
  ts?: number;
  event_id?: string;
  summary_line?: string;
}

/**
 * Reads favorites.jsonl (favorites.jsonl under PopclawPaths.data()), imports it into the marks
 * table, and renames it to .migrated. Existing rows with the same event_id aren't overwritten
 * (idempotent).
 * @param favoritesFile Absolute path to favorites.jsonl (the caller gets this from PopclawPaths).
 * @returns The number of rows actually migrated (0 = no file, or all duplicates).
 */
export function migrateFavoritesJsonl(favoritesFile: string, store: MarksStore): number {
  const file = favoritesFile;
  if (!existsSync(file)) return 0;
  let migrated = 0;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as LegacyFavoriteRecord;
      if (!r.event_id) continue;
      if (!store.has(r.event_id)) {
        store.upsert({
          eventId: r.event_id,
          platform: 'popclaw',
          platformPostId: r.event_id,
          authorPopclawId: '',
          handle: '',
          summaryLine: r.summary_line ?? '',
          bodySnapshot: r.summary_line ?? '',
          sourceUrl: '',
          markedAt: r.ts ?? 0,
        });
        migrated++;
      }
    } catch {
      // skip malformed row
    }
  }
  renameSync(file, file + '.migrated');
  return migrated;
}
