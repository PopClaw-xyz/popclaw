-- spec §5.1 guide_cache — lore-house's guide.md ETag cache.
-- One row per lore-house URL (single lore-house is the MVP norm but
-- schema future-proofs the "multi lore-house" case).

CREATE TABLE guide_cache (
  lore_house_url TEXT    PRIMARY KEY,
  content        TEXT    NOT NULL,
  etag           TEXT,
  fetched_at     INTEGER NOT NULL
);
