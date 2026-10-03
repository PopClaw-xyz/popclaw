-- spec §5.1 notification_preferences — ADR-0012 VIP/quiet/dm_level overrides.
-- O-9 (Phase 2) fills the L1/L2/L3 routing logic; this table holds the
-- owner-side overrides that O-9 will read.

CREATE TABLE notification_preferences (
  popclaw_id        TEXT    PRIMARY KEY,
  vip_list_json     TEXT,
  blocked_list_json TEXT,
  dm_level          TEXT    DEFAULT 'L1' CHECK(dm_level IN ('L1','L2','L3')),
  quiet_until       INTEGER,
  updated_at        INTEGER NOT NULL
);
