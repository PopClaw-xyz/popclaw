-- ADR-0012 three-tier notification threshold backing store.
-- ADR-0011 local-private domain: never forwarded to the lore-house.
--
-- MVP-stage Notifier is downgraded to inbox-on-next-interaction (spec §10.5):
-- all L1/L2/L3 go into the queue, and drain() flushes them together the next
-- time the owner speaks.
--
-- delivered_at IS NULL means pending. drain flips pending rows to
-- delivered_at = unixepoch().
-- We keep delivered rows as an audit trail (ADR-0012 §Consequences: "every
-- L1 push must be logged").

CREATE TABLE notification_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  level        TEXT    NOT NULL CHECK(level IN ('L1','L2','L3')),
  kind         TEXT    NOT NULL,
  payload_json TEXT    NOT NULL,
  enqueued_at  INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX idx_notification_queue_pending
  ON notification_queue(enqueued_at)
  WHERE delivered_at IS NULL;
