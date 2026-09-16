-- A frozen copy of schema version 2, and a few rows in it.
--
-- Checked in as SQL rather than built in TypeScript, because it is *supposed* to be a copy of
-- a past schema and should read as one: a fixture assembled from today's helpers would follow
-- today's code every time that code changed, and would stop being a test of the upgrade at
-- all. Nothing here may be modernised — the point is that it is old.
--
-- The tables are the ones the migration reads. The rest of the schema is absent on purpose:
-- `applySchema` creates whatever is missing after the walk, which is exactly what a real
-- upgrade of an older file does too.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  roles TEXT NOT NULL DEFAULT '["user"]',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  dir_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (user_id, slug)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  copilot_id TEXT,
  copilot_name TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  all_tools INTEGER NOT NULL DEFAULT 1,
  tools TEXT NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  title_source TEXT NOT NULL DEFAULT 'auto',
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  tool_calls TEXT,
  attachments TEXT,
  usage TEXT,
  stopped INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

-- The v2 shape: one identity rule (the hash), an absolute path, and a `kind` column that
-- version 3 derives instead. Both link tables are the same as they are today.
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  kind TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  parse_status TEXT NOT NULL DEFAULT 'none',
  parse_error TEXT,
  parse_error_code TEXT,
  parser_id TEXT,
  parsed_chars INTEGER,
  page_count INTEGER,
  parse_updated_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (user_id, sha256)
);
CREATE INDEX idx_sources_user ON sources(user_id, created_at);

CREATE TABLE session_sources (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, source_id)
);
CREATE INDEX idx_session_sources_source ON session_sources(source_id);

CREATE TABLE workspace_sources (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_id)
);
CREATE INDEX idx_workspace_sources_source ON workspace_sources(source_id);

INSERT INTO users (id, username, slug, password_hash, roles, created_at)
VALUES ('u1', 'Ada', 'ada', 'scrypt$16384$8$1$c2FsdA==$ZGVhZGJlZWY=', '["superadmin"]', '2025-01-01T00:00:00.000Z');

INSERT INTO workspaces (id, user_id, name, slug, dir_path, created_at)
VALUES ('w1', 'u1', 'Study', 'study', '/data/users/ada/workspaces/study', '2025-01-01T00:00:00.000Z');

INSERT INTO sessions (id, workspace_id, title, created_at, updated_at)
VALUES ('s1', 'w1', 'A conversation', '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z');

-- A parsed PDF, linked to both a conversation and its workspace, as the upload route writes
-- them: the parse state is what the copy has to carry, and `raw_path` is what it must not.
INSERT INTO sources
  (id, user_id, sha256, name, mime_type, size, kind, raw_path, parse_status,
   parser_id, parsed_chars, page_count, parse_updated_at, created_at)
VALUES
  ('srcA', 'u1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'paper.pdf', 'application/pdf', 4096, 'file',
   '/data/users/ada/sources/raw/srcA.pdf', 'ready', 'local', 12345, 7,
   '2025-01-03T00:00:00.000Z', '2025-01-03T00:00:00.000Z');

-- An image: `kind: 'image'` is the one thing about the old row that version 3 derives, so
-- the copy has to end up with the same answer without the column.
INSERT INTO sources
  (id, user_id, sha256, name, mime_type, size, kind, raw_path, parse_status, created_at)
VALUES
  ('srcB', 'u1', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
   'shot.png', 'image/png', 2048, 'image',
   '/data/users/ada/sources/raw/srcB.png', 'none', '2025-01-04T00:00:00.000Z');

-- A deleted one, so the copy has to carry `deleted_at` across rather than resurrect it.
INSERT INTO sources
  (id, user_id, sha256, name, mime_type, size, kind, raw_path, parse_status, created_at, deleted_at)
VALUES
  ('srcC', 'u1', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
   'old.csv', 'text/csv', 12, 'file',
   '/data/users/ada/sources/raw/srcC.csv', 'none', '2025-01-05T00:00:00.000Z',
   '2025-01-06T00:00:00.000Z');

INSERT INTO session_sources (session_id, source_id, created_at) VALUES
  ('s1', 'srcA', '2025-01-03T00:00:00.000Z'),
  ('s1', 'srcB', '2025-01-04T00:00:00.000Z'),
  ('s1', 'srcC', '2025-01-05T00:00:00.000Z');
INSERT INTO workspace_sources (workspace_id, source_id, created_at) VALUES
  ('w1', 'srcA', '2025-01-03T00:00:01.000Z'),
  ('w1', 'srcB', '2025-01-04T00:00:01.000Z'),
  ('w1', 'srcC', '2025-01-05T00:00:01.000Z');

-- A message whose attachment snapshot names srcA by **source id**. That is what version 2
-- changed, and it is the reason the copy has to keep the ids rather than mint new ones: a
-- snapshot is a persisted reference, and a row that came back under a different id would be
-- an attachment no message could find.
INSERT INTO messages (id, session_id, role, content, attachments, created_at)
VALUES ('m1', 's1', 'user', 'have a look', '[{"id":"srcA","name":"paper.pdf","mimeType":"application/pdf","size":4096,"kind":"file","parseStatus":"ready","parserId":"local","parsedChars":12345,"pageCount":7}]', '2025-01-03T00:00:02.000Z');

PRAGMA user_version = 2;
