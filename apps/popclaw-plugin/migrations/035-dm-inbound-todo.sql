-- The DM half of the reliable reception boundary.

-- Personal carries two event types — mail and relations — and both enter the
-- same commit: verified, stored as raw frames, their cursor advanced. A DM's
-- business work (decrypt, attachments, chat inbox, notification hand-over) is
-- SLOW, so it cannot run inside that transaction without holding a database
-- lock for as long as an attachment takes. This table is the hand-off: the
-- transaction records that a DELIVERY is owed its slow work, and the drain
-- does that work later, one frame at a time.
--
-- The key is (event_id, house_key, owner_generation) — per DELIVERY, not per
-- event. Global "these bytes exist once" dedup lives in inbound_frames and,
-- downstream, in the chat inbox's own event gate; what this table tracks is
-- EXECUTION ELIGIBILITY: which trusted delivery may still do the slow work.
-- The owner logging out with work pending does not cancel the event — it ends
-- that delivery's standing — and a later legitimate delivery of the same
-- bytes (a relogin, another authorized house) gets its own row rather than
-- being swallowed by the departed one.
--
-- Consumption states: drained_at IS NOT NULL means handed over durably.
-- drained_at IS NULL means still owed — never tried (failed IS NULL), or
-- tried and TRANSIENTLY failed (failed names the last error): every failure
-- sets a bounded, exponentially growing backoff (next_retry_at) instead of
-- retiring the row, so an unadjudicated task retains recovery eligibility
-- and the ordinary schedule IS the controlled retry path.

CREATE TABLE dm_inbound_todo (
  event_id        TEXT NOT NULL,
  house_key       TEXT NOT NULL,
  incarnation     TEXT NOT NULL,
  owner_generation INTEGER NOT NULL,
  position        TEXT,
  queued_at       INTEGER NOT NULL,
  drained_at      INTEGER,
  failed          TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  claimed_at      INTEGER,
  claim_token     TEXT,
  -- Bounded backoff, not a dead letter: a row that keeps failing is PAUSED
  -- (skipped until this instant) rather than retired — an unadjudicated task
  -- never loses its recovery eligibility. The ordinary drain schedule is the
  -- controlled retry path.
  next_retry_at   INTEGER,
  PRIMARY KEY (event_id, house_key, owner_generation)
);

-- The drain's working set: pending rows for one house+generation. Rows of a
-- departed generation are nobody's to do and stay untouched — visible as
-- pending, selected by nobody.
--
-- claimed_at + claim_token are the cross-process execution right, held only
-- between claim and settle: an active participation is NOT a right to consume
-- (two processes on one data root can both be attached), so a drain claims a
-- row with a conditional UPDATE and only the winner processes it. Each claim
-- carries its OWN token, and settling is a CAS on that token — an executor
-- whose stale claim was taken over cannot settle, or un-settle, the new
-- claimant's work. A claim whose holder died mid-work goes stale (older than
-- CLAIM_STALE_SECS) and is reclaimable — recovered, never lost.
CREATE INDEX idx_dm_inbound_todo_pending
  ON dm_inbound_todo(house_key, owner_generation, drained_at)
  WHERE drained_at IS NULL;
