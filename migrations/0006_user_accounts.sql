-- Keep the legacy identity and task tables intact. Legacy six-digit codes are
-- replaced atomically with 256-bit random internal codes when their users upgrade.
ALTER TABLE identities ADD COLUMN username TEXT;
ALTER TABLE identities ADD COLUMN username_normalized TEXT;
ALTER TABLE identities ADD COLUMN password_hash TEXT;
ALTER TABLE identities ADD COLUMN password_salt TEXT;
ALTER TABLE identities ADD COLUMN password_params TEXT;
ALTER TABLE identities ADD COLUMN upgraded_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS identities_username_normalized_idx
  ON identities(username_normalized) WHERE username_normalized IS NOT NULL;

-- Approval is retired. Preserve explicitly disabled accounts.
UPDATE identities SET status = 'enabled' WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  identity_code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_code) REFERENCES identities(code)
);
CREATE INDEX IF NOT EXISTS sessions_identity_idx ON sessions(identity_code);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS password_reset_codes (
  code_hash TEXT PRIMARY KEY,
  identity_code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_code) REFERENCES identities(code)
);
CREATE INDEX IF NOT EXISTS password_reset_identity_idx ON password_reset_codes(identity_code);
