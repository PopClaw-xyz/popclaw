-- 007-marks.sql — local mark snapshot (ADR-0019).
-- The favorites table (003) was never read or written by any code (a dead
-- table) and is superseded by marks; the local copy holds only active marks
-- (unmark deletes the row) — the server-side marks ledger is the complete
-- one, with revoked_at.

DROP TABLE IF EXISTS favorites;

CREATE TABLE marks (
  event_id           TEXT    PRIMARY KEY,
  platform           TEXT    NOT NULL,
  platform_post_id   TEXT    NOT NULL,
  author_popclaw_id  TEXT    NOT NULL DEFAULT '',
  handle             TEXT    NOT NULL DEFAULT '',
  summary_line       TEXT    NOT NULL DEFAULT '',
  body_snapshot      TEXT    NOT NULL DEFAULT '',
  source_url         TEXT    NOT NULL DEFAULT '',
  marked_at          INTEGER NOT NULL
);

CREATE INDEX idx_marks_marked_at ON marks(marked_at DESC);
