ALTER TABLE identities ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled';
ALTER TABLE identities ADD COLUMN reviewed_at TEXT;

CREATE INDEX IF NOT EXISTS identities_status_created_idx
  ON identities(status, created_at);
