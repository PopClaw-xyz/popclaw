-- Watch watermarks: where each watch slice had got to, on disk.
--
-- The WatchRegistry is in-memory, so a ranger restart used to drop the exact
-- `since_id` cursor and fall back to the day-granularity `since:` operator the
-- lore-house re-dispatches. That costs a full billed page per target per
-- restart ($0.003 each) for posts the client then filters out anyway — linear
-- in the number of watch targets (#181).
--
-- One row per watch_id (the lore-house's stable monitor_assignments uuid).
-- Rows for cancelled watches are harmless: a watch_id is never reused, and a
-- stale row is only ever read back by that same watch_id.
CREATE TABLE IF NOT EXISTS watch_watermarks (
  watch_id                   TEXT    PRIMARY KEY,
  last_seen_created_at       INTEGER NOT NULL,  -- epoch seconds of the newest post forwarded
  last_seen_platform_post_id TEXT    NOT NULL   -- '' until the first hit
);
