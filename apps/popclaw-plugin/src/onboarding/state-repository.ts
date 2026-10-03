import type { HostDb } from '../host/host-db.js';
import { normalizeStage, type OnboardingStage } from './stages.js';

export interface OnboardingState {
  popclaw_id: string;
  stage: OnboardingStage;
  drafts_json: string | null;
  started_at: number;
  completed_at: number | null;
}

export interface UpdateStageOptions {
  drafts?: Record<string, unknown>;
}

/**
 * The 7-day fallback (spec §1): if it's been started but not finished after
 * seven days, the next **any read path** whatsoever judges it completed in
 * passing. The judgment is attached to the DAO's get() rather than to each
 * call site: status / currentCardText / orchestrator all fetch state through
 * here, so one judgment point gives full coverage, with **zero new timers**
 * (ADR-0035: register() must be cheap).
 */
const STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;

/**
 * DAO over the `onboarding_state` table (migration 002).
 *
 * Single-row-per-popclaw-id semantics. Stage transitions enforce
 * `legalNextStages` AT THE STATE MACHINE LAYER (state-machine.ts); this
 * repo trusts callers and only does CRUD.
 */
export class OnboardingStateRepository {
  constructor(
    private readonly db: HostDb,
    private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  get(popclaw_id: string): OnboardingState | null {
    const row = this.db.queryOne<OnboardingState>(
      'SELECT popclaw_id, stage, drafts_json, started_at, completed_at ' +
      'FROM onboarding_state WHERE popclaw_id = ?',
      [popclaw_id],
    );
    if (!row) return null;
    const normalized = normalizeStage(row.stage as string);
    if (normalized !== row.stage) {
      // Three-act reordering migration: an old intermediate state resets to idle
      // and re-runs (spec §1.2), written back to the persistence layer.
      // Drafts from the old eight-stage flow don't align with the three-act
      // flow, so they're cleared too (a clean re-run).
      // pending_card_id column kept (NULL) but no longer read/written by this repo.
      this.db.execute(
        'UPDATE onboarding_state SET stage = ?, drafts_json = NULL, pending_card_id = NULL WHERE popclaw_id = ?',
        [normalized, popclaw_id],
      );
      return { ...row, stage: normalized, drafts_json: null };
    }
    if (normalized !== 'completed' && normalized !== 'idle') {
      const now = this.nowSeconds();
      if (now - row.started_at >= STALE_AFTER_SECONDS) {
        this.markCompleted(popclaw_id);
        return { ...row, stage: 'completed', completed_at: now };
      }
    }
    return row;
  }

  create(popclaw_id: string): OnboardingState {
    const startedAt = this.nowSeconds();
    this.db.execute(
      'INSERT INTO onboarding_state (popclaw_id, stage, started_at) VALUES (?, ?, ?)',
      [popclaw_id, 'idle', startedAt],
    );
    return {
      popclaw_id,
      stage: 'idle',
      drafts_json: null,
      started_at: startedAt,
      completed_at: null,
    };
  }

  updateStage(popclaw_id: string, stage: OnboardingStage, opts: UpdateStageOptions = {}): void {
    const draftsJson = opts.drafts !== undefined ? JSON.stringify(opts.drafts) : undefined;
    const setPart: string[] = ['stage = ?'];
    const params: (string | null)[] = [stage];

    if (draftsJson !== undefined) {
      setPart.push('drafts_json = ?');
      params.push(draftsJson);
    }

    params.push(popclaw_id);
    const result = this.db.execute(
      `UPDATE onboarding_state SET ${setPart.join(', ')} WHERE popclaw_id = ?`,
      params,
    );
    if (result.changes === 0) {
      throw new Error(`OnboardingStateRepository.updateStage: no row for popclaw_id=${popclaw_id}`);
    }
  }

  /** S3-T4: writes within-act sub-state — touches only drafts_json, never stage. */
  setDrafts(popclaw_id: string, drafts: Record<string, unknown>): void {
    const result = this.db.execute(
      'UPDATE onboarding_state SET drafts_json = ? WHERE popclaw_id = ?',
      [JSON.stringify(drafts), popclaw_id],
    );
    if (result.changes === 0) {
      throw new Error(`OnboardingStateRepository.setDrafts: no row for popclaw_id=${popclaw_id}`);
    }
  }

  markCompleted(popclaw_id: string): void {
    const completedAt = this.nowSeconds();
    const result = this.db.execute(
      'UPDATE onboarding_state SET stage = ?, completed_at = ? WHERE popclaw_id = ?',
      ['completed', completedAt, popclaw_id],
    );
    if (result.changes === 0) {
      throw new Error(`OnboardingStateRepository.markCompleted: no row for popclaw_id=${popclaw_id}`);
    }
  }
}
