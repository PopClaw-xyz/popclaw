-- One reservation binds one original.
--
-- 026 made event_id unique, which stops the same original being stored twice —
-- but says nothing about two DIFFERENT originals at the same seq, and that is
-- the shape the whole file exists to prevent: two event_ids at one position is
-- a fork, self-inflicted, on the sending side where it is still preventable.
--
-- With this index, a retry of the same original is idempotent and a different
-- original at a taken seq fails loudly instead of quietly queueing a second
-- event. Fork evidence from ANOTHER device is a receiving-path concern and is
-- not relaxed by this — it never passes through this outbox.
CREATE UNIQUE INDEX idx_relation_outbox_one_original_per_seq
  ON relation_outbox (house_key, followee_popclaw_id, seq);
