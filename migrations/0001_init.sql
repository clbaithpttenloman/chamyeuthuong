-- Data model per plan.md § Decision
CREATE TABLE teacher (
  id         INTEGER PRIMARY KEY,
  token      TEXT    UNIQUE NOT NULL,
  name       TEXT           NOT NULL,
  subject    TEXT           NOT NULL DEFAULT '',
  created_at TEXT           NOT NULL
);

CREATE TABLE card (
  teacher_id INTEGER PRIMARY KEY REFERENCES teacher(id) ON DELETE CASCADE,
  message    TEXT    NOT NULL,
  status     TEXT    NOT NULL CHECK (status IN ('draft', 'published')),
  updated_at TEXT    NOT NULL
);
