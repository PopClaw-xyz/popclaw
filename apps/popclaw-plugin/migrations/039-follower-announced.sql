-- Whether the owner has been TOLD about a known follower, as opposed to
-- whether we know about them.
--
-- These were one fact until relations arrived on the personal stream. The poll
-- learned and announced in the same breath, so "in the table" meant "already
-- told". The stream learns in a different process from the one holding the
-- notifier: every root on a data root shares this table, and whichever
-- process wins the drain writes the row. If that process has nothing to
-- announce with, the owner is simply never told — and the poll then finds no
-- difference, because the row is already there. Two consumers were worse than
-- one, and the reason was that "known" was being used to mean "announced".
--
-- NULL means learned but not yet announced. Anything else is a decision that
-- has been made — including a deliberate decision NOT to tell (the relative
-- value gate), because a row nobody will ever announce must not be swept for
-- ever.
ALTER TABLE known_followers ADD COLUMN announced_at INTEGER;

-- Everyone already in this table was learned by the poll, which announced in
-- the same breath. Leaving them NULL would make the first run after this
-- migration sweep every follower anyone has ever had and introduce them all
-- again — precisely the flood the baseline row exists to prevent, arriving by
-- a different door.
UPDATE known_followers SET announced_at = first_seen_at WHERE announced_at IS NULL;

-- The sweep asks one question: which rows at this house are still unannounced.
CREATE INDEX IF NOT EXISTS known_followers_unannounced
  ON known_followers (house_slug) WHERE announced_at IS NULL;
