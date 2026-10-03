import type { BondsStore } from './bonds-store.js';

/** One-shot: ensure every currently-followed popclaw_id has a bond row with followed=true. */
export function backfillFollows(store: BondsStore, followingIds: readonly string[]): void {
  for (const id of followingIds) {
    // Backfill sets follow state only — no synthetic last_interaction_ts
    // (unlike the live follow path, which also records an interaction ts).
    store.setFollowed(id, true);
  }
}
