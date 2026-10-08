/**
 * pick recorder.
 *
 * Append-only JSONL of items the user (or, in dev/harness mode, simulated
 * reactions) reacted to. Wired to `/popclaw feedback`, onboarding, and
 * marks — kept as an audit trail of observed preferences.
 *
 * One line per pick. No edits, no deletes — full audit trail.
 *
 * Storage: `<dataRoot>/popclaw/taste/learned/picks.jsonl`.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Reaction = 'up' | 'down' | 'meh';

export interface PickRecord {
  /** Unix seconds. */
  readonly ts: number;
  /** `<platform>:<platformPostId>` — same shape ScoreCache uses. */
  readonly itemId: string;
  readonly handle: string;
  readonly textPreview: string;
  /** Final aggregated score the cycle assigned. */
  readonly score: number;
  readonly reaction: Reaction;
}

export function recordCyclePicks(file: string, picks: readonly PickRecord[]): void {
  if (picks.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  const lines = picks.map((p) => JSON.stringify(p)).join('\n') + '\n';
  appendFileSync(file, lines, 'utf-8');
}
