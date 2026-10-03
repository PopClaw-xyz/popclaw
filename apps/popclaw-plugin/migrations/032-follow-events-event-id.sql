-- Identify a local intent-ledger row by the event it records.
--
-- The producer commits the signed original and its send todo first, then writes
-- the ledger row. A process that dies in between leaves a house able to hold
-- the event while local `following` is empty — and the unfollow command then
-- answers "not currently following", so the owner cannot take it back.
--
-- The repair re-derives that row from the stored original on the next resend
-- sweep; it re-signs nothing. What it needs is a way to ask "is this event
-- already in the ledger?" without guessing from (type, followee, timestamp),
-- which is two independent clock reads apart and would duplicate or skip.
--
-- Nullable, and the unique index tolerates many NULLs (SQLite treats NULLs as
-- distinct): every row written before this column existed, and every row the
-- legacy FollowEventStore.append path still writes, keeps working untouched.
ALTER TABLE follow_events ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX idx_follow_events_event_id ON follow_events (event_id);
