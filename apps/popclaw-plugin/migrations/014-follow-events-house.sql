-- Spec B slice ③ (write-side routing by house): follow events now record
-- their target house.
-- FollowDeclared goes to "the house where this person was discovered";
-- FollowRevoked must return to the same house it was declared at — otherwise
-- the unfollow lands at the wrong house and that house's follower count can
-- never come back down.
-- Existing rows default to an empty string = the primary house (semantics
-- for existing single-house users are unchanged).
ALTER TABLE follow_events ADD COLUMN house_slug TEXT NOT NULL DEFAULT '';
