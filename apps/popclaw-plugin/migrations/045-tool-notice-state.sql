-- Presentation rate limiting, never a delivery/read acknowledgement.
CREATE TABLE notification_notice_state (
  consumer_id TEXT PRIMARY KEY,
  last_offered_at INTEGER NOT NULL
);
