-- Ordinary chat manuscripts survive waiting and process restart. Consumption
-- is recorded before any outbound effect, including unknown transport results.
CREATE TABLE IF NOT EXISTS social_chat_drafts (
  actor_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  payload TEXT,
  digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  PRIMARY KEY (actor_id, draft_id)
);
-- Keep the existing short, non-secret handle contract. A process-local
-- sequence would overwrite an older manuscript after restart.
CREATE TABLE IF NOT EXISTS social_chat_draft_counter (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO social_chat_draft_counter (singleton,value) VALUES (1,0);
