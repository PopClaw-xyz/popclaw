-- Plan 2: DM inbox moves from inbox/incoming.jsonl into the precious social DB.
-- The UNIQUE index is the real fix: cross-process dedup (the in-memory `seen`
-- Set never crossed processes → the same DM got recorded N times when >1
-- gateway/subscription was live; see host-b 3×/9× duplicate records).
CREATE TABLE IF NOT EXISTS inbox (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                   INTEGER NOT NULL,
  from_popclaw_id      TEXT    NOT NULL,
  to_popclaw_id        TEXT    NOT NULL,
  body                 TEXT    NOT NULL,
  body_hash            TEXT    NOT NULL,
  in_reply_to_platform TEXT,
  in_reply_to_post_id  TEXT,
  received_at_ms       INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_dedup ON inbox (from_popclaw_id, ts, body_hash);
CREATE INDEX IF NOT EXISTS inbox_recent ON inbox (ts DESC);
