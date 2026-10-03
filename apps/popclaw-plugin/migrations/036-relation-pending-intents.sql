-- The refusal journal of the ordered relation producer.
--
-- `recordPendingIntent` is a REQUIRED producer dependency precisely so an
-- intent can never quietly disappear — but until this table the only sinks in
-- existence were test arrays. Nothing in production wrote a refusal down.
--
-- Shape follows PendingRelationIntent (relation-producer.ts) exactly. It is an
-- APPEND-ONLY journal, not a state machine: each row is one refusal event
-- (the owner asked, this end could not act, here is the reason), and the
-- count/history is itself information — "asked five times across a week"
-- reads differently from "asked once".
CREATE TABLE relation_pending_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'declare' | 'revoke'
  action TEXT NOT NULL,
  followee_popclaw_id TEXT NOT NULL,
  house_slug TEXT,
  -- RelationRefusalReason verbatim (e.g. HOUSE_BINDING_UNPROVEN).
  reason TEXT NOT NULL,
  detail TEXT,
  -- Unix seconds, producer's `now()`.
  at INTEGER NOT NULL
);

CREATE INDEX idx_relation_pending_intents_followee
  ON relation_pending_intents(followee_popclaw_id, at);
