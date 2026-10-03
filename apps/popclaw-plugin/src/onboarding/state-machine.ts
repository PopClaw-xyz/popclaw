import type { OnboardingStage } from './stages.js';
import { legalNextStages } from './stages.js';
import type { OnboardingStateRepository, UpdateStageOptions } from './state-repository.js';

export class IllegalTransitionError extends Error {
  constructor(public readonly from: OnboardingStage, public readonly to: OnboardingStage) {
    super(`Illegal onboarding transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * State machine façade over OnboardingStateRepository.
 *
 * Plan C's six acts (spec 2026-07-29 §1): the machine executes over
 * `legalNextStages` as idle → arrival → passport → lantern → attune → errand →
 * cadence → completed, and any in-progress stage can bail straight to
 * `completed` (the owner can say "that's enough for now" at any time). State
 * is persisted in the `onboarding_state` table; transitioning to `completed`
 * goes through repo.markCompleted() (stage and completed_at land together).
 * Old enum values are migrated on the read path (state-repository +
 * normalizeStage), which is also where graduation is judged if 7 days pass
 * without finishing.
 */
export class OnboardingStateMachine {
  constructor(private readonly repo: OnboardingStateRepository) {}

  /** Insert idle row if absent. Idempotent. */
  ensureStarted(popclaw_id: string): void {
    if (this.repo.get(popclaw_id) === null) {
      this.repo.create(popclaw_id);
    }
  }

  current(popclaw_id: string): OnboardingStage {
    const row = this.repo.get(popclaw_id);
    if (row === null) {
      throw new Error(`OnboardingStateMachine.current: no state for popclaw_id=${popclaw_id}`);
    }
    return row.stage;
  }

  /**
   * Transition to the target stage.
   *
   * Default behavior: drafts get cleared (`opts.drafts ?? {}`) — within-act
   * sub-state should not survive across stages. If a caller needs to keep or
   * write drafts in the new stage, pass `opts.drafts` explicitly.
   */
  transition(popclaw_id: string, to: OnboardingStage, opts: UpdateStageOptions = {}): void {
    const from = this.current(popclaw_id);
    if (!legalNextStages[from].includes(to)) {
      throw new IllegalTransitionError(from, to);
    }
    if (to === 'completed') {
      this.repo.markCompleted(popclaw_id);
    } else {
      this.repo.updateStage(popclaw_id, to, { ...opts, drafts: opts.drafts ?? {} });
    }
  }

  /**
   * S3-T4: thin read/write for within-act sub-state (drafts_json) — the
   * orchestrator accesses it through here, not directly through the
   * repository (layering discipline). Malformed JSON is tolerated as {}
   * (just re-run this step).
   */
  drafts(popclaw_id: string): Record<string, unknown> {
    const row = this.repo.get(popclaw_id);
    if (!row?.drafts_json) return {};
    try {
      const parsed: unknown = JSON.parse(row.drafts_json);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  setDrafts(popclaw_id: string, drafts: Record<string, unknown>): void {
    this.repo.setDrafts(popclaw_id, drafts);
  }
}
