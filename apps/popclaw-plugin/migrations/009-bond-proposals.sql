-- Bond report/review (follow-on ③): a lightweight rolling interaction-density
-- signal feeding "close interaction → tier upgrade" proposals, plus the
-- bond_proposals table the master confirms via 1 (agree) / 2 (disagree) /
-- 3 (let me think). Local-private (ADR-0011/0022).
-- Design: docs/superpowers/plans/2026-06-15-bond-book-report-review.md

-- Rolling window of the master's recent OUTGOING interaction timestamps per bond
-- (capped JSON array of unix seconds). Drives the relative-value interaction-density signal.
ALTER TABLE bonds ADD COLUMN recent_interactions_json TEXT NOT NULL DEFAULT '[]';

-- Tier up/down-grade proposals awaiting the master's decision.
CREATE TABLE bond_proposals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  popclaw_id   TEXT    NOT NULL REFERENCES bonds(popclaw_id) ON DELETE CASCADE,
  from_tier    TEXT    NOT NULL,
  to_tier      TEXT    NOT NULL,
  rationale    TEXT    NOT NULL DEFAULT '',
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','accepted','rejected','deferred')),
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER
);
CREATE INDEX idx_bond_proposals_status ON bond_proposals(status, created_at);
CREATE INDEX idx_bond_proposals_person ON bond_proposals(popclaw_id, to_tier, created_at DESC);
