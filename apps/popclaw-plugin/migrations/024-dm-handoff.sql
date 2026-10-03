-- Existing history is settled to avoid a notification storm on upgrade.
-- New inserts explicitly start pending; receive and notify are separate facts.
ALTER TABLE inbox ADD COLUMN notification_state TEXT NOT NULL DEFAULT 'legacy'
  CHECK (notification_state IN ('legacy', 'pending', 'silent', 'queued', 'ticket'));
ALTER TABLE inbox ADD COLUMN event_id TEXT;
ALTER TABLE inbox ADD COLUMN has_media INTEGER NOT NULL DEFAULT 0;
UPDATE inbox SET has_media = 1 WHERE media_path IS NOT NULL;
ALTER TABLE inbox ADD COLUMN retrieved_at_ms INTEGER;
ALTER TABLE inbox ADD COLUMN resolved_at_ms INTEGER;
DROP INDEX inbox_dedup;
CREATE UNIQUE INDEX inbox_event_id ON inbox(event_id) WHERE event_id IS NOT NULL;
CREATE UNIQUE INDEX inbox_dedup ON inbox(from_popclaw_id, ts, body_hash) WHERE event_id IS NULL;
CREATE INDEX inbox_pending_policy ON inbox(id) WHERE notification_state = 'pending';

CREATE TABLE notification_consumers (
  consumer_id TEXT PRIMARY KEY,
  start_after_id INTEGER NOT NULL
);
ALTER TABLE notification_queue ADD COLUMN source_message_id INTEGER REFERENCES inbox(id);
CREATE UNIQUE INDEX notification_dm_source ON notification_queue(source_message_id) WHERE source_message_id IS NOT NULL;

-- A transport read is an offer, not a human read or completed collaboration.
CREATE TABLE notification_receipts (
  consumer_id TEXT NOT NULL,
  notification_id INTEGER NOT NULL REFERENCES notification_queue(id),
  offered_at INTEGER NOT NULL, -- 0 = eligible at binding, not yet offered
  acknowledged_at INTEGER,
  PRIMARY KEY (consumer_id, notification_id)
);
