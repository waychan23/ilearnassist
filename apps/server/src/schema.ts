import type Database from "better-sqlite3";

/**
 * The database schema, and the one guard that lets a breaking change be a refusal instead
 * of a silent misread.
 *
 * Two rules govern changes here, and they cover different things:
 *
 * - **Adding** a column goes through `ensureColumn` in `db.ts`. `CREATE TABLE IF NOT
 *   EXISTS` skips tables that already exist, so a database created before the column
 *   would never gain it, and the additive change would apply to new installs only.
 * - **Changing what an existing column means** bumps `SCHEMA_VERSION`. No missing column
 *   can signal that, so without a version an old file is simply opened and read wrong —
 *   paths that resolve to the wrong directory, rows whose ids refer to a different kind of
 *   thing — with no error anywhere to explain it.
 *
 * `SCHEMA_VERSION` is deliberately the only history that survives a break: the file at a
 * refused version is left exactly as it was.
 */

/**
 * 2 — `messages.attachments[].id` stops being an upload id and becomes a **source** id.
 *
 * Same field, same JSON column, different referent: nothing about the row says which kind of
 * id it holds, so an old file cannot be detected by shape and is refused instead. That is the
 * case this guard exists for.
 */
export const SCHEMA_VERSION = 2;

/**
 * Every table, with the columns that earlier releases added by migration folded back in.
 *
 * That folding is why this file can be read as the schema rather than as the schema plus a
 * pile of corrections. It is safe because a database from before the version guard can
 * never reach this code (see below), so there is nothing to upgrade in place.
 *
 * `copilots.model` is gone rather than dormant: it was superseded by `settings.modelId` and
 * only existed to be folded forward by a migration that no longer runs.
 *
 * ### Uploaded files are `sources`
 *
 * Owned by an **account** rather than by the conversation they arrived in, because one file
 * can be referenced by several. `UNIQUE (user_id, sha256)` is what makes identical bytes one
 * row, one file and two references — and it is also why the hash is *scoped*: a lookup by
 * hash alone would hand one account's bytes to another who uploaded the same content, which
 * is exactly the case dedupe makes common.
 *
 * `raw_path` is where the bytes are. Storing it (rather than deriving and globbing for it)
 * is what retired a whole class of collision — nothing has to list a directory to find a
 * file any more. It is still validated against the account's sources root before every read:
 * a database row is not a trust boundary, and a path that travelled through a backup, or
 * through a future bug, is not the same thing as one this code wrote.
 *
 * Parse state lives in **columns** here rather than in a `parsed/<id>.json` sidecar. That is
 * the "index it in the database" half of the design: a reparse is then visible in every
 * conversation at once rather than only in the messages written after it, and a source shared
 * by two conversations is parsed once. Only the extracted *text* stays a file — it is large,
 * and `read_document` streams it by offset.
 *
 * ### The two link tables are not the same thing
 *
 * `session_sources` is the authority on what the model may read: a query, answered fresh
 * every turn, so a source unlinked a moment ago is gone from the next turn's whitelist.
 * `workspace_sources` is the same one level up, and is how a document uploaded in one
 * conversation is readable from another in the same workspace.
 *
 * Neither is what a *message* shows. `messages.attachments` stays a JSON snapshot of the
 * source as it was sent, so a chip does not vanish from history because the source was
 * unlinked or deleted afterwards — and it carries the name that upload used, which the source
 * itself deliberately does not (it keeps the first name it ever saw).
 */
const DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    dir_path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (user_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id, created_at);

  -- Uploaded files. See the note above on ownership, dedupe, raw_path and parse state.
  CREATE TABLE IF NOT EXISTS sources (
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
    UNIQUE (user_id, sha256)
  );
  CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id, created_at);

  -- What a source is referenced by. Two tables, and both are needed — see the note above.
  CREATE TABLE IF NOT EXISTS session_sources (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_sources_source ON session_sources(source_id);

  CREATE TABLE IF NOT EXISTS workspace_sources (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, source_id)
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_sources_source ON workspace_sources(source_id);

  CREATE TABLE IF NOT EXISTS copilots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL,
    tools TEXT NOT NULL DEFAULT '[]',
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    copilot_id TEXT REFERENCES copilots(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'auto',
    settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at);

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    tool_calls TEXT,
    attachments TEXT,
    usage TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    context_window INTEGER,
    max_output INTEGER,
    capabilities TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id, sort_order);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS document_parsers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/**
 * Create the tables, refusing a file this build cannot read.
 *
 * Refusing is the feature. The alternative — opening whatever is there — is a database
 * whose `workspaces.dir_path` means something this code does not expect, and the failure
 * that produces surfaces much later as files that cannot be found.
 *
 * `user_version` rather than a row in `app_settings`, because it lives in the file header
 * and can therefore be read *before* anything is created. A version row cannot: reading it
 * means having already opened the file you meant to refuse.
 */
export function applySchema(db: Database.Database): void {
  const found = db.pragma("user_version", { simple: true }) as number;

  // A file that has tables but still reports version 0 predates versioning — it is not a
  // new database that happens to be empty, and treating it as one is how an old file gets
  // stamped with the current version and then misread forever.
  const hasTables =
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
        .get() as { n: number }
    ).n > 0;

  if (found !== SCHEMA_VERSION && (found !== 0 || hasTables)) {
    throw new Error(
      `The data directory holds an ilearnassist database created by schema v${found} ` +
        `(this build needs v${SCHEMA_VERSION}). This build changes where things are stored ` +
        `and cannot read the old layout. Move it aside, or point ILA_DATA_DIR at a new directory.`
    );
  }

  db.exec(DDL);
  db.pragma(`user_version = ${SCHEMA_VERSION}`);
}
