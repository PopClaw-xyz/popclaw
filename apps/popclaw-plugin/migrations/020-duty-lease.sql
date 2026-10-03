-- Duty lease: among the several popclaw processes alive at once under one
-- POPCLAW_DATA_ROOT, which one does the background work that must run
-- exactly once globally (world-feed SSE subscription + echo routing).
--
-- This is the real shape of "one key, every AI tool": the OpenClaw plugin
-- stays resident while popclaw-mcp comes up under Claude Code / Codex, both
-- pointing at the same data root. Any process can make a tool call (post /
-- reply / look up the bond book) — SQLite coordinates that on its own (WAL +
-- busy_timeout). Only **receiving mail** needs exactly one owner: three SSE
-- connections copying back the same batch of events is pure waste, and echo
-- routing running three times taps the owner on the shoulder three times.
--
-- Deliberately a single row (id is always 1): this isn't a table, it's a
-- sign on the wall.
CREATE TABLE IF NOT EXISTS duty_lease (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  holder       TEXT    NOT NULL,  -- a random token, not a pid: pids get reused, tokens don't
  renewed_at   INTEGER NOT NULL   -- epoch ms — once stale it can be taken over, which naturally cleans up crash leftovers
);
