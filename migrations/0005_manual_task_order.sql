ALTER TABLE tasks ADD COLUMN manual_position INTEGER;

CREATE INDEX IF NOT EXISTS tasks_identity_manual_order_idx
  ON tasks(identity_code, completed, pinned, manual_position);
