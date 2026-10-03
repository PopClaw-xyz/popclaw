-- Known follower set ("Follow-notification design" spec 2026-07-27 slice ②).
--
-- A house never volunteers "who follows me" — FollowDeclared is neither
-- projected into the world-feed nor a discovery filter target. The only way
-- to find out is to diff `GET /followers/:me` against this local table; any
-- new id is a new follower.
--
-- Key `(house_slug, follower_id)`: a follower is a **fact**, and every fact
-- must carry its house (ADR-0037 §Generalization). The same person following
-- me at two different houses is two independent facts, each announced once.
CREATE TABLE IF NOT EXISTS known_followers (
  house_slug    TEXT NOT NULL,
  follower_id   TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (house_slug, follower_id)
);

-- Baseline stamp: distinguishes "haven't looked at this house yet" from
-- "this house genuinely has zero followers". Without it, the first run would
-- flood the owner by treating every existing follower as new (spec: the
-- first run only establishes a baseline and sends no notifications).
-- One row per house; an empty table does not mean "first run".
CREATE TABLE IF NOT EXISTS known_followers_baseline (
  house_slug     TEXT PRIMARY KEY,
  established_at INTEGER NOT NULL
);
