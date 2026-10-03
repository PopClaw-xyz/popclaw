-- The relation chain's per-house session participation — the table 031 once
-- created under the name `house_participation`, renamed because that name
-- already belongs to the old 2316 runtime's lifecycle table (created AT
-- RUNTIME by runtime/house-lifecycle/participation-store.ts, so no migration
-- ever recorded it, and an unconditional CREATE here collided on every real
-- upgrade — HOST-BOOT-01).
--
-- Same shape 031 intended: house_key names the namespace, owner_generation
-- is the login generation (both begin and end bump it, rows are never
-- deleted — the tombstone that fences work in flight), active is whether
-- anyone is home. One row per house, not per connection.
--
-- IF NOT EXISTS is correct here (idempotent restarts), and installs that
-- already hold an 031-era `house_participation` in THIS shape get their rows
-- ported by the migration runner's port step, which then clears that table
-- out of the old name's way. The OLD runtime's lifecycle table, when
-- present, is never touched by any of this.
CREATE TABLE IF NOT EXISTS relation_participation (
  house_key        TEXT PRIMARY KEY,
  owner_generation INTEGER NOT NULL,
  active           INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
