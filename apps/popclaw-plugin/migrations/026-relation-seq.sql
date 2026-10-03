-- Author-side seq allocation for ordered relation events.
--
-- The ordinary way to fork your own edge is not an attack, it is a timeout:
-- sign seq 8, the push times out, re-sign, and the second attempt carries a
-- different event_id at the same position. These two tables exist so that
-- cannot happen — the original is durable before the first network attempt,
-- and a retry re-sends those exact bytes rather than producing new ones.

-- Three numbers per edge, kept apart on purpose.
--   reserved: handed out, maybe never signed. Only ever goes up.
--   signed:   an original exists locally at this number.
--   observed: the highest seq VERIFIED from any source, including another
--             device of the owner's. Raised only from author-verified
--             evidence — never from a house's bare claim, which is a
--             statement and not an allocation.
CREATE TABLE relation_seq (
  house_key           TEXT    NOT NULL,
  followee_popclaw_id TEXT    NOT NULL,
  reserved            INTEGER NOT NULL DEFAULT 0,
  signed              INTEGER NOT NULL DEFAULT 0,
  observed            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (house_key, followee_popclaw_id)
);

-- The signed original, written before the first send. A retry ships
-- signed_payload verbatim, so the CID is unchanged and the house's own dedup
-- absorbs it. sent_at is set once the push is confirmed; a row with sent_at
-- NULL after a crash is the work that still has to happen.
CREATE TABLE relation_outbox (
  event_id            TEXT    PRIMARY KEY,
  house_key           TEXT    NOT NULL,
  followee_popclaw_id TEXT    NOT NULL,
  seq                 INTEGER NOT NULL,
  signed_payload      BLOB    NOT NULL,
  house_slug          TEXT,
  created_at          INTEGER NOT NULL,
  sent_at             INTEGER
);

CREATE INDEX idx_relation_outbox_unsent ON relation_outbox (created_at) WHERE sent_at IS NULL;
