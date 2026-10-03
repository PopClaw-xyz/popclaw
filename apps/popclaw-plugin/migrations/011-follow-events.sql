-- Plan 2: follow/revoke event log moves from social-graph/declared.jsonl into
-- the social DB. Append-only (P-004: social action log never deleted); a Revoke
-- is a new row, not a delete. projectState folds the rows in insertion order.
CREATE TABLE IF NOT EXISTS follow_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT    NOT NULL,
  followee         TEXT    NOT NULL,
  follow_type      TEXT    NOT NULL,
  taste_subscribed INTEGER NOT NULL DEFAULT 0,
  timestamp        INTEGER NOT NULL,
  signature        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS follow_events_followee ON follow_events (followee, id);
