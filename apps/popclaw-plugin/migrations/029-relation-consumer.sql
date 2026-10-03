-- Client-side relation CONSUMER: the receiving projection for verified
-- FollowDeclared / FollowRevoked events. Independent of both the DM inbox path
-- (runtime/inbox-consumer.ts) and the author-side allocator (relation-
-- allocator.ts, migrations 026-028) — this is what happens to an edge once a
-- verified relation event, someone else's or the owner's own echoed one,
-- arrives.
--
-- Two tables here — the PROJECTION and its JUDGEMENT HISTORY. The durable
-- receive queue (originals + per-source delivery attempts + watermark) moved
-- to migration 030 after review found the queue's original shape conflated
-- two different questions (P1, see 030's header); this file now holds only
-- what that queue feeds.
--
--   relation_edges          the projection the relation contract asks for: current state per
--                           (house_key, follower, followee), the relation contract's
--                           applied_seq / applied_event_id, and the
--                           conflicted flag. NULL applied_seq means either a
--                           legacy edge (no order-bearing event has ever
--                           landed) or an edge that forked before any event
--                           ever applied — both are real states, not errors.
--
--   relation_event_log       one row per event_id ever judged on an edge,
--                           terminal verdict included. This is what answers
--                           the relation contract step 2 ("same event_id already on this
--                           edge") by primary-key lookup, and the relation contract step 3
--                           (fork: same seq, different event_id) by an index
--                           scan — without replaying history. A non-terminal
--                           verdict ('pending', 'fork_branch') is
--                           deliberately NOT a stop condition on replay:
--                           re-delivery of the same event_id re-enters the
--                           decision table, which is the only re-judgement
--                           mechanism this slice has (the relation contract's full recovery
--                           machinery is out of scope here).

CREATE TABLE relation_edges (
  house_key            TEXT    NOT NULL,
  follower_popclaw_id  TEXT    NOT NULL,
  followee_popclaw_id  TEXT    NOT NULL,
  -- 'following' | 'revoked' | 'unknown'. 'unknown' only occurs when an edge
  -- forked before any event of it ever reached step 5/6 of the relation contract
  state                TEXT    NOT NULL DEFAULT 'unknown',
  applied_seq          INTEGER,
  applied_event_id     TEXT,
  conflicted           INTEGER NOT NULL DEFAULT 0,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (house_key, follower_popclaw_id, followee_popclaw_id)
);

CREATE TABLE relation_event_log (
  house_key            TEXT    NOT NULL,
  follower_popclaw_id  TEXT    NOT NULL,
  followee_popclaw_id  TEXT    NOT NULL,
  event_id             TEXT    NOT NULL,
  -- NULL for a legacy (order-absent) event, and for an event rejected before
  -- a usable seq could be established (e.g. seq out of domain).
  seq                  INTEGER,
  kind                 TEXT    NOT NULL,
  verdict              TEXT    NOT NULL,
  reason               TEXT,
  recorded_at          INTEGER NOT NULL,
  PRIMARY KEY (house_key, follower_popclaw_id, followee_popclaw_id, event_id)
);

-- Answers the relation contract step 3 (sibling/fork test) without a table scan: every
-- event ever logged at a given (edge, seq) is one query away.
CREATE INDEX idx_relation_event_log_seq
  ON relation_event_log (house_key, follower_popclaw_id, followee_popclaw_id, seq);

-- event_id is a CID (content-addressed): unique in practice without the rest
-- of the composite key. This lets a caller recover an already-drained
-- frame's verdict (a duplicate delivery arriving after its first drain)
-- without needing to re-derive its edge key.
CREATE INDEX idx_relation_event_log_event_id ON relation_event_log (event_id);
