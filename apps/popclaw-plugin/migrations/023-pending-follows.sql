CREATE TABLE followable_authors (
  issue_date TEXT NOT NULL,
  popclaw_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  descriptor TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (issue_date, popclaw_id)
);
CREATE TABLE pending_follows (
  followee_popclaw_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  descriptor TEXT,
  source_issue_date TEXT,
  first_ts INTEGER NOT NULL,
  latest_ts INTEGER NOT NULL,
  first_surfaced_ts INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
);
