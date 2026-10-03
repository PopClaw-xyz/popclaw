-- Bond Book: one row per popclaw_id the master has a real relationship with
-- ("people you have a real bond with"). Strangers = no row. Local-private
-- (ADR-0011), never sent to lore-house.
-- Design: docs/superpowers/specs/2026-06-14-bond-book-social-asset-redesign.md

CREATE TABLE bonds (
  popclaw_id           TEXT    PRIMARY KEY,
  -- Relative value / distance: reject < blocked < stranger < acquaintance < friend < close (+ close_plus reserved)
  tier                 TEXT    NOT NULL DEFAULT 'acquaintance'
                         CHECK (tier IN ('reject','blocked','stranger','acquaintance','friend','close','close_plus')),
  tier_source          TEXT    NOT NULL DEFAULT 'auto'   CHECK (tier_source IN ('auto','manual')),
  -- highest tier ever held — drives "occasionally resurface a blocked old friend" in the report plan
  peak_tier            TEXT    NOT NULL DEFAULT 'acquaintance',
  -- remark name: master's own alias for this person
  remark_name          TEXT    NOT NULL DEFAULT '',
  -- AI knowledge (absolute value). Filled by the dreamer (follow-on plan); empty for now.
  description          TEXT    NOT NULL DEFAULT '',
  tags                 TEXT    NOT NULL DEFAULT '[]',      -- JSON array of strings
  contact_json         TEXT    NOT NULL DEFAULT '{}',      -- JSON: phones / cross-platform handles
  -- follow is a projection of signed FollowDeclared (source of truth stays in social-graph)
  followed             INTEGER NOT NULL DEFAULT 0,
  last_interaction_ts  INTEGER,
  last_dream_ts        INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE INDEX idx_bonds_tier               ON bonds(tier);
CREATE INDEX idx_bonds_last_interaction   ON bonds(last_interaction_ts DESC);

-- Time-series of notable things this person did / that happened to them.
-- Source for the daily report (follow-on plan). is_milestone = an absolute-value event.
CREATE TABLE bond_dynamics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  popclaw_id    TEXT    NOT NULL REFERENCES bonds(popclaw_id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  summary       TEXT    NOT NULL,
  is_milestone  INTEGER NOT NULL DEFAULT 0,
  reported      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_bond_dynamics_person_ts ON bond_dynamics(popclaw_id, ts DESC);

-- Retrieval: "find my business partners". Contentless FTS5 rebuilt by the
-- dreamer (description/tags only change in the nightly pass → no triggers).
CREATE VIRTUAL TABLE bonds_fts USING fts5(
  popclaw_id UNINDEXED,
  remark_name,
  description,
  tags
);
