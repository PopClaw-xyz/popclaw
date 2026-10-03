-- The followee's own declared nickname (distinct from remark_name, the owner's
-- private note). Denormalized here at follow time so /popclaw status can render
-- `nickname#sigil` locally/offline. See spec 2026-06-18-follow-id-validation.
ALTER TABLE bonds ADD COLUMN nickname TEXT NOT NULL DEFAULT '';
