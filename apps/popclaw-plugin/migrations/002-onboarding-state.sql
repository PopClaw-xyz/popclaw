-- spec §5.1 onboarding_state.
-- One row per popclaw_id (single-instance assumption per spec §15.1 —
-- "multiple devices sharing one popclaw_id is Phase 3").
-- stage values constrained at app layer (OnboardingStage union); no CHECK here to keep
-- migrations decoupled from TS enum drift.

CREATE TABLE onboarding_state (
  popclaw_id      TEXT    PRIMARY KEY,
  stage           TEXT    NOT NULL,
  drafts_json     TEXT,
  pending_card_id TEXT,
  started_at      INTEGER NOT NULL,
  completed_at    INTEGER
);
