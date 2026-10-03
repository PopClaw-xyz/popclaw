/**
 * Resolving "who did the owner mean" against the world feed: the shared caps,
 * the summary+snapshot → AuthorSource mapping, and the disambiguation copy.
 * Same criteria as the onboarding orchestrator's act2 — one aggregation
 * pipeline, not two.
 *
 * Split out of register-tools.ts (2026-08-25).
 */

import { ownerLang } from '../lexicon/owner-language.js';
import { renderCopy } from '../lexicon/index.js';
import {
  WorldSummaryClient,
  type WorldSummaryResponse,
} from '../world/world-summary-client.js';
import type { AuthorSource } from '../world/notable-authors.js';
import type { AuthorCandidate } from '../world/author-resolver.js';
import { platformLabel } from '../world/summary-format.js';
import type { NameChain } from '../identity/person-name.js';
import type { WorldSnapshotItemLike, WorldToolsDeps } from './tools-context.js';

// --- S4.1-T3: shared world-tool helpers (same criteria as act2) ---

/** Default summary time window (same value as act2's SUMMARY_WINDOW_HOURS). */
export const WORLD_SUMMARY_WINDOW_HOURS = 24;
/** Summary hot-post list cap (same value as act2's SUMMARY_LIST_CAP). */
export const WORLD_SUMMARY_LIST_CAP = 8;
/** Cap on active mirror accounts (same value as act2's NOTABLE_CAP; narrowed 5 → 3 in S4.2). */
export const WORLD_NOTABLE_CAP = 3;
/** Snapshot sample size for author resolution (same value as act2's SNAPSHOT_LIMIT). */
export const WORLD_SNAPSHOT_LIMIT = 100;
/** Max items popclaw_author_latest fetches per call. */
export const AUTHOR_LATEST_MAX_COUNT = 100;

/**
 * summary.hot_posts + snapshot entries → AuthorSource[] (same mapping as the
 * orchestrator's presentSummaryStage; the aggregation itself just delegates
 * to aggregateNotableAuthors).
 */
export function buildAuthorSources(
  summary: WorldSummaryResponse | null,
  snapshot: WorldSnapshotItemLike[],
  nameOf?: NameChain,
): AuthorSource[] {
  return [
    ...(summary?.hot_posts ?? []).map((p) => ({
      popclawId: p.author,
      platform: p.platform,
      nickname: summary ? WorldSummaryClient.nicknameFor(summary, p.author, nameOf) : undefined,
    })),
    ...snapshot
      .filter((it) => (it.authorPopclawId ?? '').length > 0)
      .map((it) => ({
        popclawId: it.authorPopclawId ?? '',
        platform: it.platform ?? 'popclaw',
        nickname: it.actorNickname ?? undefined,
      })),
  ];
}

/** Fetch the author-resolution data sources (summary + snapshot in parallel, each fault-tolerant on its own). */
export async function fetchAuthorSources(
  wd: WorldToolsDeps,
): Promise<{ sources: AuthorSource[]; allFailed: boolean }> {
  let snapshotFailed = false;
  const [summary, snapshot] = await Promise.all([
    wd.summaryClient.fetchSummary(WORLD_SUMMARY_WINDOW_HOURS).catch(() => null),
    wd.snapshotClient.fetchSnapshot({ limit: WORLD_SNAPSHOT_LIMIT }).catch(() => {
      snapshotFailed = true;
      return [] as WorldSnapshotItemLike[];
    }),
  ]);
  return {
    sources: buildAuthorSources(summary, snapshot),
    allFailed: summary === null && snapshotFailed,
  };
}

/** Disambiguation list copy: nickname + platform, for the agent to relay to the owner to choose from. (S3 pilot: show_feed shares this function.) */
export function disambiguationText(query: string, candidates: AuthorCandidate[], lang = ownerLang()): string {
  const lines = candidates.map(
    (c, i) => `${i + 1}. ${c.nickname} — ${c.platforms.map(platformLabel).join('/')}`,
  );
  return (
    `${renderCopy(lang, 'world.disambiguation.prompt', { query })}\n${lines.join('\n')}\n` +
    renderCopy(lang, 'world.disambiguation.footer')
  );
}
