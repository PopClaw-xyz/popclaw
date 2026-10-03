-- spec §9.3 dream-feedback feed. O-8 weekly dream aggregates over this.
-- High write-volume (each daily-brief interaction → 1 row), so index for
-- the GROUP BY tag/action access pattern (anticipated O-8 query).

CREATE TABLE daily_brief_feedback (
  brief_id       TEXT    NOT NULL,
  brief_date     TEXT    NOT NULL,                       -- ISO date YYYY-MM-DD
  item_id        TEXT    NOT NULL,
  item_taste_tag TEXT,
  action         TEXT    NOT NULL,                       -- 'expand'|'favorite'|'no-interest'|'followup'|'no-action'
  followup_text  TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (brief_id, item_id)
);

CREATE INDEX idx_dbf_by_tag_action ON daily_brief_feedback(item_taste_tag, action, created_at);
