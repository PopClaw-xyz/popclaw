-- spec §5.1 favorites — local-private (ADR-0011); never uploaded to lore-house.

CREATE TABLE favorites (
  id         TEXT    PRIMARY KEY,
  item_type  TEXT    NOT NULL,
  item_id    TEXT    NOT NULL,
  note       TEXT,
  tags_json  TEXT,
  saved_at   INTEGER NOT NULL,
  UNIQUE(item_type, item_id)
);

CREATE INDEX idx_favorites_by_type_saved ON favorites(item_type, saved_at DESC);
