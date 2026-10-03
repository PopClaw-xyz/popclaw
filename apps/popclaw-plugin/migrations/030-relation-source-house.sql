-- Trusted source-house context, and the receive queue that replaced
-- migration 029's `relation_consumer_todo` (second-round review, three P1s,
-- all against the relations contract).
--
-- P1-A (round 1): an author's signature (verified by verifyInboundEnvelope)
-- proves WHO wrote an event. It says nothing about WHICH house delivered it,
-- whether that house is trusted, or whether the owner is still authorised
-- there — those are verified out-of-band and must be INJECTED, never read
-- off `envelope.lorehouse` / `order.house_key`, which are both fields the
-- SAME author signs. `source_incarnation` / `source_owner_generation` on
-- `relation_edges` persist what was verified alongside the projection.
--
-- P1 (round 2, "global CID dedup swallows a legitimate current source or
-- generation"): the original `relation_consumer_todo` had ONE row per
-- event_id, `UNIQUE(event_id)` — so whichever (house, incarnation,
-- generation) delivered a given event FIRST owned that row forever. A
-- gen-1 delivery nobody drained yet, followed by logout/login into gen 2,
-- left that event with no reachable row under gen 2. An original that first
-- arrived via the WRONG house and was rejected on scope could never be
-- re-judged when the RIGHT house delivered the identical bytes later — the
-- first delivery's rejection was permanent, poisoning a legitimate one still
-- to come. Two different questions were sharing one key:
--
--   relation_frame_originals    "have we ever seen these exact bytes" — a
--                               pure content-addressed dedup, keyed by
--                               event_id ALONE. Correct to dedup this way:
--                               the same CID always decodes to the same
--                               bytes, so storing the blob once is exact,
--                               never approximate.
--
--   relation_delivery_attempts  "did THIS (house, incarnation, generation)
--                               attempt to deliver this event" — keyed by
--                               the FULL tuple, so a second attempt via a
--                               different source (a different house, or the
--                               same house re-authorised under a new
--                               generation) is its own row, judged on its
--                               own merits, never short-circuited by an
--                               unrelated source's earlier outcome.
--
-- P1 (round 2, "a non-terminal head starves every other edge and house"):
-- the old drain always took `ORDER BY id LIMIT ?` from the front of the
-- pending set. A row that stays non-terminal forever (nothing here decides
-- WHEN a forked or pending event becomes decidable — see relation-
-- consumer.ts) sat at the front of that ordering forever too, so once the
-- backlog ahead of newer work exceeded `limit`, newer work never got a
-- turn. `last_attempted_at` splits the queue into a FIRST PASS (never
-- attempted, ordered by arrival — guaranteed to make progress, never
-- blocked by anything stuck) and a RE-JUDGE pass (already attempted at
-- least once, ordered oldest-attempt-first — a fair rotation instead of a
-- fixation on whichever stuck row happens to sort first).
--
-- The watermark is now per house_key, not a single process-wide row: one
-- persistent cursor cannot stand in for several logical streams, and a
-- drain scoped to one house must never move another house's watermark.

ALTER TABLE relation_edges ADD COLUMN source_incarnation TEXT;
ALTER TABLE relation_edges ADD COLUMN source_owner_generation INTEGER;

-- Content-addressed: the bytes for one event_id, stored once regardless of
-- how many (or how untrustworthy) the sources that delivered it were.
CREATE TABLE relation_frame_originals (
  event_id             TEXT PRIMARY KEY,
  kind                 TEXT    NOT NULL,
  follower_popclaw_id  TEXT    NOT NULL,
  followee_popclaw_id  TEXT    NOT NULL,
  envelope_bytes       BLOB    NOT NULL,
  first_seen_at        INTEGER NOT NULL
);

-- One row per (event, source) actually attempted. A rejection recorded
-- under a wrong or no-longer-authorised source never blocks a legitimate
-- attempt recorded under a different one — they are different rows.
CREATE TABLE relation_delivery_attempts (
  event_id                 TEXT    NOT NULL REFERENCES relation_frame_originals(event_id),
  house_key                TEXT    NOT NULL,
  source_incarnation       TEXT    NOT NULL,
  source_owner_generation  INTEGER NOT NULL,
  -- The transport's own position tag for this delivery, opaque here, kept
  -- for observability only — never compared against a relation payload's
  -- own `seq` (the relation contract's job alone).
  delivery_position        TEXT,
  enqueued_at               INTEGER NOT NULL,
  -- Wall-clock record of the most recent attempt, for observability only.
  -- NOT the ordering key for the re-judge pass — see attempt_seq below.
  last_attempted_at         INTEGER,
  -- NULL until the decision table returns a TERMINAL verdict for this
  -- specific attempt. A non-terminal one (forked, pending) is deliberately
  -- left open so this attempt keeps being reconsidered.
  applied_at                INTEGER,
  -- NULL = never run through the decision table yet (first pass). Otherwise
  -- the value of relation_drain_state.next_attempt_seq at the moment this
  -- attempt was last processed — a STRICT, gapless total order with no
  -- ties possible, unlike last_attempted_at: two attempts processed inside
  -- the same wall-clock second (routine at second resolution, and not rare
  -- under a fast test clock) would otherwise tie, and a tie-break on rowid
  -- alone would let the same lower-rowid row win every time — not a
  -- rotation, a fixed preference wearing a rotation's name.
  attempt_seq                INTEGER,
  PRIMARY KEY (event_id, house_key, source_incarnation, source_owner_generation)
);

-- Drives the first-pass / re-judge split: both scans filter on
-- (applied_at IS NULL) AND partition on whether attempt_seq is NULL, then
-- order the re-judge scan by attempt_seq.
CREATE INDEX idx_relation_delivery_attempts_pending
  ON relation_delivery_attempts (house_key, source_incarnation, source_owner_generation, applied_at, attempt_seq);

-- Per house_key, not a single process-wide counter: a persistent cursor is
-- per house / per stream / per generation, and one row cannot represent
-- several logical streams at once.
CREATE TABLE relation_applied_watermark (
  house_key           TEXT PRIMARY KEY,
  last_attempt_rowid  INTEGER NOT NULL DEFAULT 0
);

-- P2 (third round): re-judgement had no GUARANTEED share of a small drain
-- budget — it only ever got what a first pass over never-attempted rows
-- left behind. Under continuous new traffic and limit=1, first pass always
-- has something (the newest arrival), so it always exhausted the whole
-- budget and a permanently non-terminal row's own attempt_seq never
-- advanced, across any number of rounds. `favor_retry` flips after every
-- `drainRelationAttempts` call: whichever pass goes SECOND only gets
-- whatever budget the other leaves, but going first alternates, so across
-- any two consecutive calls each pass is guaranteed to have gone first (and
-- so guaranteed a share) at least once — a rotation, not a fixed priority
-- in either direction. `next_attempt_seq` backs attempt_seq above.
CREATE TABLE relation_drain_state (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  favor_retry         INTEGER NOT NULL DEFAULT 0,
  next_attempt_seq    INTEGER NOT NULL DEFAULT 1
);
INSERT INTO relation_drain_state (singleton, favor_retry, next_attempt_seq) VALUES (1, 0, 1);
