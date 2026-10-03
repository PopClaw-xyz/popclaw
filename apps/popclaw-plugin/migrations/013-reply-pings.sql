-- Pings — replies to me — spec 2026-07-25-pings-replies-to-me-design.md,
-- ADR-0012 Amendment 2026-07-25.
--
-- Two single-purpose ledgers, both written with INSERT OR IGNORE so the
-- "did this already happen?" answer is the insert's own row count — atomic,
-- idempotent, order-independent, restart-proof.
--
-- Strictly forbidden: detecting a first reply by counting how many replies a
-- post already has. SSE reconnects backfill history in one lump with no
-- ordering guarantee, so a counting scheme would double-wake or miss wakes
-- entirely (ADR-0012 amendment §1).

-- One row per reply-to-me event ever routed. PRIMARY KEY = the idempotency gate.
-- read_at is the cursor for "the owner actually picked these up", independent
-- of notification_queue.delivered_at — the latter also gets marked by DM's
-- drain('L1'), so unread status must hang on "the agent actually fetched it".
CREATE TABLE IF NOT EXISTS reply_pings (
  reply_event_id TEXT    PRIMARY KEY,
  target_post_id TEXT    NOT NULL,
  arrived_at     INTEGER NOT NULL,
  read_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reply_pings_unread ON reply_pings(arrived_at) WHERE read_at IS NULL;

-- One row per post of mine that has ever received a reply. Insert succeeds iff this is the first reply.
CREATE TABLE IF NOT EXISTS reply_first_ping (
  target_post_id TEXT    PRIMARY KEY,
  at             INTEGER NOT NULL
);
