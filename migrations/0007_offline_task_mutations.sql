-- Preserve all existing tasks while allowing offline create retries to be idempotent.
ALTER TABLE tasks ADD COLUMN client_mutation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_identity_client_mutation_idx
  ON tasks(identity_code, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;
