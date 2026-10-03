-- The explicit end of "this root cannot account for its own history".
--
-- `lower_bound_only` records that originals exist which this end does not hold.
-- It is sticky, and rightly so — it is a fact about history, not a comparison
-- of maxima. But sticky with no way out means a restored backup can never sign
-- on that edge again, which is not a safety property, it is a lockout.
--
-- This column is that way out, and it is the ONLY one. It names the seq
-- through which this edge's history has been re-established from verified
-- originals. Nothing automatic writes it: not reserve, not commitSigned, not
-- observeVerified, and above all not a house reporting a low number. Signing
-- resumes on an edge only once what was re-established reaches what is known
-- to exist.
ALTER TABLE relation_seq ADD COLUMN recovered_through INTEGER NOT NULL DEFAULT 0;

-- Which round of this identity's life produced that proof.
--
-- `recovered_through` alone is carried by the database, and a database can be
-- restored twice. Recover an edge through 4, take a backup, keep signing 5, 6,
-- 7 on the live copy, then restore that backup: it arrives holding its own
-- proof, the gate reads a non-zero value, and it signs into 5 again. A proof
-- has to belong to the act that produced it, and a restore is a new act.
--
-- So a round id is stamped at mint, import and restore — and only there. An
-- ordinary restart does not rotate it, or every reboot would demand a resync.
-- A `recovered_through` stamped in an earlier round stays on the row as
-- history; what it stops being is current authority.
--
-- The residual, stated rather than solved: a restore that does not announce
-- itself is indistinguishable from an ordinary restart, because everything this
-- process can read came out of the same backup. The act has to declare itself.
ALTER TABLE relation_seq ADD COLUMN recovered_in_round TEXT;

-- How far ANY round ever got, kept apart from how far THIS one has.
--
-- One column could not be both. Taking the maximum across rounds and then
-- relabelling it with the current round's id turned a partial recovery into a
-- complete one: recover through 9 in the first round, restore, re-establish
-- only 3 in the second, and the row read "9, recovered in the current round".
-- `recovered_through` is now this round's coverage — it resets when a new round
-- stamps it — and this is the monotonic history, which is what the current
-- round has to catch up to before it may sign.
ALTER TABLE relation_seq ADD COLUMN recovered_ever INTEGER NOT NULL DEFAULT 0;

CREATE TABLE identity_round (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  round_id       TEXT    NOT NULL,
  origin         TEXT    NOT NULL CHECK (origin IN ('minted', 'imported', 'restored')),
  established_at INTEGER NOT NULL
);
