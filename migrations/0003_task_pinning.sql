ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN pinned_at TEXT;

CREATE INDEX IF NOT EXISTS tasks_identity_pinned_idx
  ON tasks(identity_code, pinned, pinned_at);
