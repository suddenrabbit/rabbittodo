ALTER TABLE identities ADD COLUMN task_sort_mode TEXT NOT NULL DEFAULT 'manual'
  CHECK (task_sort_mode IN ('manual', 'auto'));
