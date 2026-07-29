CREATE TABLE IF NOT EXISTS identities (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_code TEXT NOT NULL,
  title TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'violet',
  tags TEXT NOT NULL DEFAULT '[]',
  due_date TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (identity_code) REFERENCES identities(code)
);

CREATE INDEX IF NOT EXISTS tasks_identity_position_idx ON tasks(identity_code, position, id);
