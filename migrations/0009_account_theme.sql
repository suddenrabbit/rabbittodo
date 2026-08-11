ALTER TABLE identities ADD COLUMN theme_color TEXT NOT NULL DEFAULT 'violet'
  CHECK (theme_color IN ('violet', 'mint', 'orange', 'blue', 'rose'));
