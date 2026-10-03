-- Verification requests I initiated (ADR-0040). The lore-house hands back a
-- task_id only once, at intake time — if we don't record it, the owner can
-- never again look up whether their own request was approved or rejected
-- (the silent-flow bug hit on real machines with owl_scribe_7 / blackfeather).
--
-- `notified` is the one and only idempotency gate: the SSE approval event and
-- the rejection poll are two independent legs, and whichever settles first
-- notifies; the second leg's UPDATE then hits notified=1 and goes quiet on
-- its own (copied from reply_pings' "a successful insert/update IS the
-- answer" — never count, never query).
CREATE TABLE IF NOT EXISTS pending_invites (
  task_id     TEXT PRIMARY KEY,
  platform    TEXT NOT NULL,
  handle      TEXT NOT NULL,
  sigil       TEXT NOT NULL DEFAULT '',
  proof_url   TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  notified    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending_invites_open ON pending_invites(created_at) WHERE state = 'pending';
