-- The durable "this house's relation projection is unknown since its reset"
-- marker — the missing half of the cursor-reset chain (work-order C's map §1).
--
-- Without it a reset frame is a loud error that changes nothing: the client
-- keeps resending the dead Last-Event-ID, every reconnect earns another
-- reset, and nothing anywhere remembers that the projection behind the cursor
-- may be missing edges. With it, the reset handler records the facts the
-- house named (reason, log generation, floor), the resume read suppresses the
-- dead cursor while a gap is open, and the recovery consumer (the next slice)
-- owns clearing it — only once a snapshot checkpoint has completed.
--
-- Keyed (house_key, incarnation): a restored house is a different log, and
-- resumePosition already refuses to carry a cursor across an incarnation
-- change, so a gap belongs to exactly one (house, incarnation) pair.
-- log_generation and floor are TEXT on purpose: they span the whole i64
-- range and the wire keeps them as strings — a Number would round into a
-- log that does not exist.
CREATE TABLE relation_stream_gaps (
  house_key      TEXT NOT NULL,
  incarnation    TEXT NOT NULL,
  reason         TEXT NOT NULL,
  log_generation TEXT NOT NULL,
  floor          TEXT NOT NULL,
  marked_at      INTEGER NOT NULL,
  PRIMARY KEY (house_key, incarnation)
);
