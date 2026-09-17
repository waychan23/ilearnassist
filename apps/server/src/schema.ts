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
 *
 * ### `deleted_at` is the soft delete, and it is additive
 *
 * Every application entity carries a nullable `deleted_at`. Set means soft-deleted: the row
 * stays, every read filters `IS NULL`, and the relations pointing at it stay too — nothing
 * cascades any more, so a foreign key that used to clean up is now only ever a filter at query
 * time. On-disk bytes (workspace and session directories, a source's raw and parsed files) are
 * retained for the same reason.
 *
 * It is added by `ensureColumn`, so it needs no `SCHEMA_VERSION` bump: NULL is "live" and a
 * row written before the column existed means exactly that. That is the same test as any other
 * additive column — see the `users.disabled` and `auth_tokens.revoked_at` precedents, which are
 * the same idea one entity at a time.
 */

/*
 * The versions this file has been through, newest first. There are three:
 *
 * 1 — the original schema.
 * 2 — `messages.attachments[].id` stops being an upload id and becomes a **source** id. Same
 *     field, same JSON column, different referent: nothing about the row says which kind of id
 *     it holds, so an old file cannot be detected by shape and is refused instead. That is the
 *     case the guard exists for.
 * 3 — a source stops being an upload and becomes the record for every piece of material an
 *     account holds; below.
 */

/**
 * 3 — a source stops being "an uploaded file" and becomes **the one record for every piece of
 * material an account holds**: an upload, a page the agent fetched, a file it wrote into a
 * workspace, and a file it wrote into a conversation's own directory.
 *
 * Three things change at once, and each is a genuine meaning change rather than an addition —
 * which is why this is a rebuild of the table and a version bump rather than a few
 * `ensureColumn` calls:
 *
 * - **Identity splits in two.** `UNIQUE (user_id, sha256)` was the whole rule while a source
 *   was always a blob; it is now one of *two* rules. Identical uploaded bytes are still one
 *   row (and a re-upload still revives a deleted one), while a file is identified by where it
 *   is — so moving it keeps its row, its summary and its parse state, and two identical files
 *   in two directories are two sources. Two partial unique indexes express that; the old
 *   table-wide constraint cannot.
 * - **`raw_path` is retired.** An absolute path was the one stored fact that silently breaks
 *   when a data root is copied or moved, and it was never needed: an upload's location is
 *   already derived from its id and its MIME type, as `paths.ts` has always insisted
 *   ("derived, never stored as a fact in its own right"). What is stored instead is
 *   `rel_path`, the path *within a root*, which is load-bearing only where nothing else can
 *   supply it.
 * - **`kind` is derived.** `category` supersedes it — `image`/`file` is `category === "image"`
 *   or not — so the column is dropped and computed in `mapSource`, the way `workdirPath` is
 *   computed from `dir_path`.
 *
 * `session_sources` and `workspace_sources` are deliberately untouched: they answer *who may
 * read it*, which is a different question from *who owns it*, and the read whitelist built
 * from them must not change.
 *
 * The upgrade is `migrations.ts`'s `migrateV2ToV3` — the first migration this project has
 * ever had. See the note on `applySchema` there for why relaxing the guard is safe.
 */
export const SCHEMA_VERSION = 3;

/**
 * Every table, with the columns that earlier releases added by migration folded back in.
 *
 * That folding is why this file can be read as the schema rather than as the schema plus a
 * pile of corrections. It is safe because a database from before the version guard can
 * never reach this code (see below), so there is nothing to upgrade in place — and a database
 * from *after* it is either current or is walked forward by `MIGRATIONS`, which is the one
 * thing that changed when v3 arrived.
 *
 * `copilots.model` is gone rather than dormant: it was superseded by `settings.modelId` and
 * only existed to be folded forward by a migration that no longer runs.
 *
 * ### A source is one row for one piece of material
 *
 * Owned by a **workspace or a conversation** — and so by an account — rather than by the
 * message that happened to use it, because one file can be referenced by several. `origin`
 * says how it came to exist; `storage` says which root its bytes are under, and is the one
 * field that changes; `category` is what the browser filters on. Two partial unique indexes
 * carry the two identity rules: identical uploaded bytes are one row (`idx_sources_blob`),
 * and a file is placed by its owner and its path (`idx_sources_place`).
 *
 * Where the bytes are is answered in two steps rather than one, and neither step is a stored
 * absolute path. `storage` picks the root and `rel_path` says where in it — both re-validated
 * before every read, because a database row is not a trust boundary and a path that travelled
 * through a backup, or through a future bug, is not the same thing as one this code wrote. An
 * `upload` or a `web` source stores no path at all: its filename is `<id>.<ext>`, derived from
 * the id and the MIME type, exactly as `paths.ts` says every path here is.
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
export const DDL = `
  -- An account carries a password now, which is what changed this table's meaning: a
  -- username used to *be* the credential, so the login route created the row if the name was
  -- new. It identifies nobody now — the row has to exist first, and only an administrator
  -- makes one.
  --
  -- password_hash is nullable, and the null is load-bearing rather than transitional: it is
  -- what "this account has never been given a password" looks like, which is both every row
  -- carried over from the build without passwords and the state that reopens the first-run
  -- screen. See hasPasswordAccounts in db.ts, which is the predicate that decides.
  --
  -- roles is a JSON array, not a single value, so "which roles does this account hold" is one
  -- shape whether somebody holds one or three. The DEFAULT is the least privilege, because a
  -- row inserted by something that forgot to name the roles should not be an administrator.
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    roles TEXT NOT NULL DEFAULT '["user"]',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    -- The account's own description of itself, in its own words, sent to the model as context on
    -- every turn. '' rather than NULL: every account written before this column existed genuinely
    -- *has* no introduction, so the default preserves what those rows already meant where NULL
    -- would say "we do not know". See chat.system.about in the prompt catalog.
    about TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE);

  -- One row per issued token. The primary key is the token's **SHA-256**, never the token:
  -- a database that is read — a backup, a stray copy, this file opened in a sqlite browser —
  -- would otherwise be a list of working credentials. Nothing needs the plaintext back, so
  -- there is nothing the hash costs.
  --
  -- 'kind' separates the two lifetimes: an access token is accepted by the gate, a refresh
  -- token only by the refresh route. Without it a refresh token would be a bearer credential
  -- for the whole API, which is the opposite of the point of having a short-lived one.
  --
  -- Revocation is a timestamp rather than a DELETE, so "this token was spent" and "this
  -- account was signed out everywhere" are both auditable after the fact and neither depends
  -- on a row surviving elsewhere. expires_at is an ISO string compared lexically, which is
  -- exact for fixed-width UTC timestamps and is the same thing every other time comparison
  -- in this codebase does.
  --
  -- New table, so no SCHEMA_VERSION bump: the DDL above runs on every open, and the columns
  -- added to users alongside it go through ensureColumn. Neither changes what an existing
  -- column means, which is the rule the bump is for — see the note at the top of this file.
  CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind);

  CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    dir_path TEXT NOT NULL UNIQUE,
    -- The workspace's own settings, as a JSON object — the defaults its conversations inherit.
    -- Nullable on the copilots.settings precedent: NULL is "never set", which is a different
    -- claim from "set to nothing", and a NOT NULL default would have told every workspace
    -- written before the column existed that somebody had chosen something.
    settings TEXT,
    -- What the workspace is for, in the account's own words. Display-only: nothing reads it
    -- into a prompt, so it says what its author meant rather than feeding a model. Defaulted
    -- to the empty string rather than nullable, on the copilots.description precedent — an
    -- absent description and an empty one are the same claim, and a NULL would make every
    -- reader branch on two spellings of it.
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    -- Soft delete. The directory stays on disk, so 'uniqueSlug''s filesystem loop is what
    -- keeps a re-created name off a deleted one's path; these two UNIQUEs are the backstop
    -- they always were.
    deleted_at TEXT,
    UNIQUE (user_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id, created_at);

  -- Every piece of material the account holds. See the note above on ownership, the two
  -- identity rules, storage/rel_path and parse state.
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Who holds it: 'session' | 'workspace', and that row's id.
    --
    -- No foreign key, and the cost is real: SQLite cannot point one column at two tables. It
    -- is affordable because ownership is only ever *reached through* — every read resolves the
    -- owner first (getSessionForUser / getWorkspaceForUser) and then reads its sources — so an
    -- orphan is invisible rather than handed to whoever asked. The cascade a foreign key would
    -- have provided is not wanted anyway: relations are never dismantled.
    owner_kind TEXT NOT NULL,
    owner_id TEXT NOT NULL,

    -- How it came to exist. Provenance: fixed for the life of the row.
    -- 'session_attachment' | 'workspace_upload' | 'agent_workspace' | 'agent_session' | 'web'
    origin TEXT NOT NULL,

    -- Which root the bytes are under: 'upload' | 'web' | 'workspace' | 'session' | 'trash'.
    -- The one field here that changes — deleting a file from the manager moves it to 'trash'
    -- rather than erasing it — and the one the resolver switches on.
    storage TEXT NOT NULL,

    -- The path within that root. NULL for 'upload' and 'web', whose filename is
    -- '<id>.<ext>' and therefore derived from the id and the MIME type; non-NULL for
    -- 'workspace' and 'session', where it is the only record of the file's name.
    rel_path TEXT,

    -- The display name. For an upload, the name it arrived under; for a file, the last path
    -- segment. Never used to address the bytes — that is "rel_path".
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    -- 'page' | 'text' | 'code' | 'markdown' | 'diagram' | 'image' | 'document' | 'other'.
    -- A label for the browser's filters, not an access-control decision: what decides whether
    -- anything is *parsed* is still "isDocumentMime", which this does not replace.
    category TEXT NOT NULL,
    size INTEGER NOT NULL,
    -- The page this source is, when it is one.
    source_url TEXT,
    -- The model's one-liner, where something has produced one. "session_diagrams.summary" is
    -- the precedent: the thing the bytes cannot answer, stored beside them rather than in them.
    summary TEXT,

    -- The content hash, for account blobs only. See idx_sources_blob.
    sha256 TEXT,

    parse_status TEXT NOT NULL DEFAULT 'none',
    parse_error TEXT,
    parse_error_code TEXT,
    parser_id TEXT,
    parsed_chars INTEGER,
    page_count INTEGER,
    parse_updated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT,

    -- Soft delete. On the byte side too: the file stays on disk, so a delete costs no disk
    -- and a future restore has something to restore.
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sources_user ON sources(user_id, created_at);
  -- The listing query: one owner's sources, in path order.
  CREATE INDEX IF NOT EXISTS idx_sources_owner ON sources(owner_kind, owner_id, rel_path);
  -- Identical *uploaded bytes* are one row — and this one is deliberately NOT filtered on
  -- 'deleted_at', because that is what makes a re-upload of deleted bytes revive the row
  -- rather than insert beside it. See 'findDeletedSourceByHash' / 'reviveSourceForUser'.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_blob
    ON sources(user_id, sha256) WHERE sha256 IS NOT NULL;
  -- One row per file at one path, per owner. A rename is an UPDATE of 'rel_path' on this row,
  -- which is the whole reason identity is the id and not a hash of either the path or the
  -- bytes. Filtered on 'deleted_at' so a deleted file does not block a new one at the same
  -- path. SQLite treats NULLs as distinct in a unique index, so the predicate and the NULL are
  -- belt and braces — but the predicate is the *documentation*.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_place
    ON sources(user_id, owner_kind, owner_id, rel_path)
    WHERE deleted_at IS NULL AND rel_path IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_sources_web
    ON sources(user_id, source_url) WHERE source_url IS NOT NULL;

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

  -- user_id is nullable here *and* in the migration that adds it to older databases. Not slack:
  -- ALTER TABLE ADD COLUMN with NOT NULL demands a default, and any default is a landmine for a
  -- later insert that forgets the owner. Every read names the owner in its WHERE and requires
  -- one rather than trusting the disjunction alone — see the copilot SELECT in db.ts — so a row
  -- with no owner goes missing rather than being handed to whoever asked. Fail closed.
  CREATE TABLE IF NOT EXISTS copilots (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL,
    -- all_tools is authoritative over tools, which is why the default is 1: an empty tools list
    -- used to mean "every tool", so a Copilot nobody touched has to keep meaning that. With the
    -- flag, "no tools" became expressible — all_tools = 0 and tools = '[]' — which it was not
    -- before. Where all_tools is 1, tools is stored empty and carries no authority.
    all_tools INTEGER NOT NULL DEFAULT 1,
    tools TEXT NOT NULL DEFAULT '[]',
    settings TEXT NOT NULL DEFAULT '{}',
    -- A Copilot's widget selection for the conversations it starts. **Nullable, and that is the
    -- all_tools lesson in a new dress**: NULL means "never set — use the defaults", while a JSON
    -- array (including '[]') is an explicit selection. A NOT NULL DEFAULT '[]' would say "install
    -- nothing" for every Copilot written before this column existed, silently narrowing
    -- conversations nobody ever re-edited. The DB layer always writes an array, so NULL can only
    -- come from a row that predates the column.
    widgets TEXT,
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Soft delete. A conversation that copied this Copilot keeps working untouched: the
    -- snapshot is what it reads, and 'copilot_id' was only ever a link.
    deleted_at TEXT
  );
  -- Deliberately no index on user_id, and it cannot be added here even if one were wanted:
  -- applySchema runs this DDL *before* the ensureColumn call that gives an older database the
  -- column, so an index on it would fail with "no such column" on exactly the upgrade it was
  -- meant to ease. Nothing needs one either — the owned lookup is by primary key, and the
  -- own-or-public listing cannot use a single index.

  -- The Copilot columns are a snapshot of the Copilot this conversation was started from, so the
  -- conversation keeps behaving as it did after that Copilot is edited or deleted. copilot_id
  -- stays only as a link for the UI and may dangle (SET NULL); copilot_name is what the badge
  -- reads, precisely because it survives that.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    copilot_id TEXT REFERENCES copilots(id) ON DELETE SET NULL,
    copilot_name TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    -- Copied from the Copilot alongside tools, and authoritative over it in the same way. A
    -- conversation with no Copilot defaults to every tool, which is what it had before.
    all_tools INTEGER NOT NULL DEFAULT 1,
    tools TEXT NOT NULL DEFAULT '[]',
    title TEXT NOT NULL,
    title_source TEXT NOT NULL DEFAULT 'auto',
    settings TEXT NOT NULL DEFAULT '{}',
    -- What this conversation is about, in the user's own words — the same display-only field
    -- a workspace carries, and defaulted the same way. It deliberately has nothing to do with
    -- title_source: a description is not a name, so writing one neither offers nor costs the
    -- auto-titler its turn.
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Soft delete. The reserved 'sessions/<id>/' directory and every row that hangs off this
    -- one — messages, links, plans, quiz questions — stay; they are reached through this row,
    -- so filtering it here is what hides them.
    deleted_at TEXT
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
    stopped INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    -- Soft delete. This is the one users reach directly (delete / regenerate in the message
    -- actions), and the filter on it is load bearing in two places at once: it hides the row
    -- from the conversation *and* from the turn's history, which is what keeps a deleted
    -- message out of the model's context. 'stmtListMessages' is where both arrive.
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- Soft delete, and the API key stays in the row: this is a single-operator installation
    -- whose database is already the thing that holds every key, so there is nothing a DELETE
    -- protects that the file does not. 'softDeleteProvider' marks this provider's models in
    -- the same transaction, because the cascade that used to do it no longer fires.
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    context_window INTEGER,
    max_output INTEGER,
    capabilities TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL DEFAULT 0,
    -- Soft delete. No table hangs off a model, so nothing else needs marking with it; a
    -- dangling 'sessions.settings.modelId' already falls through 'resolveModelId''s chain.
    deleted_at TEXT
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
    updated_at TEXT NOT NULL,
    -- Soft delete, and a second concept beside 'enabled' rather than a replacement for it:
    -- disabled is a parser that is configured and not in use, deleted is one that is gone.
    -- 'sources.parser_id' has no foreign key, so nothing points at this row either way.
    deleted_at TEXT
  );

  -- Monotonically increasing counters, one row per sequence. "value" is the highest number
  -- issued so far and nothing reads it as anything else; a sequence is named by all three
  -- of (scope, scope_id, name), so the same counter can exist per session, per user or per
  -- workspace without the callers agreeing on anything beyond that triple.
  --
  -- Deliberately no foreign key: scope/scope_id name any entity at all, so there is no table
  -- to point at, and a row left behind for a deleted session is a few bytes that nothing can
  -- reach — ids are never reused, so a stale counter is not a hazard.
  --
  -- This is a new table, which is why it needs no SCHEMA_VERSION bump: the DDL above runs on
  -- every open, so a database created before the table existed gains it. The bump rule is for
  -- changing what an existing column means — see the note at the top of this file.
  CREATE TABLE IF NOT EXISTS counters (
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    name TEXT NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY (scope, scope_id, name)
  );

  -- One row per (object, widget): which widgets an object has, and whether each one is on.
  --
  -- The row's *existence* is the record that somebody decided something; "enabled" is what they
  -- decided. Uninstalling writes 0 and never deletes, which is what makes the fallback in
  -- defaultWidgetEnabled unreachable for an object that has already said no — a deleted row
  -- would fall back to the default and silently reinstall a widget the user turned off. It is
  -- also why the write is an upsert: install / uninstall / install on the same pair is one row,
  -- not a duplicate-key error.
  --
  -- "scope" is the level and "scope_id" names the object at it. There is deliberately no copilot
  -- scope: a Copilot's selection lives in copilots.widgets and is copied into the session it
  -- starts, so it is session state reached through a template.
  --
  -- Deliberately no foreign key, for the counters reason above: scope_id names any entity at
  -- all, so there is no table to point at. Nothing cleans up after a deleted session, and
  -- nothing needs to — ids are never reused, so an orphaned row is a few bytes nothing can reach.
  --
  -- New table, so no SCHEMA_VERSION bump (see the note on counters).
  CREATE TABLE IF NOT EXISTS widget_instances (
    scope TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    widget_id TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope, scope_id, widget_id)
  );

  -- The plan widget's versioned tree. One plan per session (the UNIQUE below); a conversation
  -- that wants a second plan gets one in another conversation, decided through ila_make_plan's
  -- conflict card.
  --
  -- Versions are *structural* snapshots: plan_versions.tree_json is the full tree (ids,
  -- titles, parent order) as each edit left it, and that is all a history browse shows.
  -- Progress lives once, on plan_nodes, keyed by the node's stable id — a server-assigned
  -- UUID that survives renames and moves — so the current tree carries live status while old
  -- versions never change. There is deliberately no node-level version number: nothing about
  -- a node's progress is versioned, only the tree's shape is.
  --
  -- Deletion is a status, not a row deletion. A node missing from a new submission is kept as
  -- a tombstone (removed_version set, parent/position frozen at its last place), rendered
  -- struck through in the current tree; it drops out of that version's snapshot, which is
  -- exactly what makes Vn browseable as what Vn was.
  --
  -- New tables, so no SCHEMA_VERSION bump (see the note on counters).
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'not_started',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plan_versions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    tree_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (plan_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_plan_versions_plan ON plan_versions(plan_id, version);

  CREATE TABLE IF NOT EXISTS plan_nodes (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    parent_id TEXT,
    position INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_started',
    introduced_version INTEGER NOT NULL,
    removed_version INTEGER,
    -- The progress tool call that last marked this node completed: the message the widget
    -- jumps to. Cleared if the node ever leaves the completed status.
    done_tool_call_id TEXT,
    done_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_plan_nodes_plan ON plan_nodes(plan_id, parent_id, position);

  -- The quiz widget's questions. One row per question, created when 'ila_quiz' suspends —
  -- BEFORE the user answers — so that a question the learner walked away from is already a
  -- thing the panel can list and later re-answer.
  --
  -- Two ids on purpose: 'id' is a global UUID, the row's identity for the grading tool and
  -- the make-up route; 'qid' is the session-scoped Qn number the model and the card use
  -- (counter 'quiz_question', unique within one session). 'position' equals that number, so
  -- questions list in ask order without a second column.
  --
  -- 'node_id'/'node_title' bind the question to the plan chapter it was asked under; both
  -- null means a session-level question (outside the plan). The title is a snapshot with no
  -- FK, so the row survives a plan edit that tombstones the node and still groups under it.
  --
  -- Status answers the question's lifecycle independently of the tool call that posed it:
  -- pending → answered (submitted, possibly later made up) / skipped (walked away) /
  -- dismissed (the whole quiz explicitly cancelled). A make-up updates the SAME row, so a
  -- re-answered question is never a duplicate; grading clears with it, since the old verdict
  -- judged a different answer.
  --
  -- New table, so no SCHEMA_VERSION bump (see the note on counters).
  CREATE TABLE IF NOT EXISTS quiz_questions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    node_id TEXT,
    node_title TEXT,
    tool_call_id TEXT NOT NULL,
    qid TEXT NOT NULL,
    position INTEGER NOT NULL,
    header TEXT NOT NULL,
    question TEXT NOT NULL,
    multi_select INTEGER NOT NULL DEFAULT 0,
    options_json TEXT NOT NULL,
    --
    -- The answer key, supplied by the model at question time and never shown to the
    -- client: toView() omits both columns. NULL means the model gave no key; an answered
    -- (or made-up) question is graded by a resumed tool result / system note that reads
    -- them here. Added with ensureColumn for files written before the columns existed.
    --
    reference_answer_json TEXT,
    explanation TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    user_answer_json TEXT,
    verdict TEXT,
    feedback TEXT,
    grade_tool_call_id TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT,
    graded_at TEXT,
    UNIQUE (session_id, qid)
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_session ON quiz_questions(session_id, position);
  CREATE INDEX IF NOT EXISTS idx_quiz_call ON quiz_questions(tool_call_id);

  -- The thread widget's derived topic chains. Classification is an out-of-band model call
  -- that runs after every turn (like the auto-titler), so these rows are derived data the
  -- way plan_nodes and quiz_questions are: no deleted_at, owner-scoped through sessions in
  -- the reads.
  --
  -- Only REAL threads are stored. The 计划 / 其他 headings are a rendering fact with
  -- translated labels, so they are never rows (a stored label would freeze in the
  -- conversation's language). A plan thread is one plan node, and the partial unique index
  -- is the idempotency key that makes "one node, one thread" survive a re-sync.
  --
  -- A message names its thread through messages.thread_id (added by ensureColumn). Turns,
  -- not messages, are classified: a user message and the assistant reply of one turn share
  -- a thread, so an exchange can never be split across two.
  --
  -- New table, so no SCHEMA_VERSION bump (see the note on counters).
  CREATE TABLE IF NOT EXISTS session_threads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    title TEXT NOT NULL,
    plan_node_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_threads_session ON session_threads(session_id, branch, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_plan_node
    ON session_threads(session_id, plan_node_id) WHERE plan_node_id IS NOT NULL;

  -- The notes widget's records: what the learner marked and what they wrote about it.
  --
  -- Unlike quiz_questions and session_threads above, this one DOES carry deleted_at: a note
  -- is not derived from the conversation, it is the user's own writing, which puts it on the
  -- same side as messages rather than on the same side as a classification. (Being the user's
  -- own writing is also why no tool may write one: the model reads notes through ila_query's
  -- "note" kind and has no way to create, edit or delete one.) Its bytes are
  -- kept for the same reason a deleted message's are — a delete costs no disk, and a future
  -- restore has something to restore.
  --
  -- session_id is NOT NULL and message_id is nullable, and that asymmetry is the entity:
  -- every note belongs to a conversation, only an annotation belongs to a message. The
  -- session FK is house style for a child table, but note what it does and does not do —
  -- sessions are soft-deleted, so the cascade is a backstop that normal use never fires;
  -- hiding follows the reads filtering IS NULL, exactly as it does for messages.
  --
  -- message_id has NO foreign key, deliberately. A regenerate or a tail delete soft-deletes
  -- a message, and the note must survive it: the quote column is the record of what was
  -- annotated and still displays. A dangling id is a state the reads report (messageMissing)
  -- rather than a state the schema forbids. Same shape as plan_nodes.done_tool_call_id.
  --
  -- quote/occurrence are the anchor (see NoteAnchor in packages/shared): a text-quote anchor
  -- over the message's visible text, not a character offset, because offsets into rendered
  -- HTML do not survive a re-render. quote = '' is "no annotation", which is one signal and
  -- not two, so occurrence is NOT NULL DEFAULT 0 rather than nullable.
  --
  -- New table, so no SCHEMA_VERSION bump (see the note on counters).
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT,
    type TEXT NOT NULL DEFAULT 'annotation',
    quote TEXT NOT NULL DEFAULT '',
    occurrence INTEGER NOT NULL DEFAULT 0,
    content TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_notes_message ON notes(message_id);

  -- A conversation's diagrams: one row per .mmd file in that conversation's own folder.
  --
  -- The split with the file is "the file holds the source, the row holds what the file cannot
  -- answer": the canonical file name (the join key to a FileEntry, so the client never derives
  -- a name of its own), the model's one-line summary, the tool call that wrote or last revised
  -- it, and the thread the classifier put it in. It is never a second copy of the bytes — a
  -- row whose source disagrees with the file is the exact drift a row exists to make
  -- impossible, so source and source_path are deliberately absent. The path is a pure
  -- function of the session and the name, and storing it would bake a data-root-dependent
  -- absolute path into a database that travels through backups.
  --
  -- Derived data, like quiz_questions and session_threads above, so it carries NO deleted_at:
  -- the model wrote it in a turn, nothing in the product deletes a diagram, and a soft-deleted
  -- session keeps its on-disk bytes anyway. A column no read filtered on would make the
  -- soft-delete invariant false the moment it was written. A delete control arrives later by
  -- ensureColumn plus IS NULL on every read, the house path. There is no message_id either:
  -- the assistant message does not exist when the tool runs (finishTurn creates it after the
  -- turn), and once the classifier assigns the thread directly nothing needs it.
  --
  -- name is the CANONICAL file name (auth-flow.mmd), not the model's raw "Auth Flow". That is
  -- what makes (session_id, name) a real identity rather than a coincidence: three model names
  -- that slugify alike are one file and one row — and it is the same value a FileEntry.name
  -- carries, so a read matches a row to a file by identity. ON CONFLICT is therefore the
  -- revise rule: a second call with the same name is the same diagram.
  --
  -- thread_id has NO foreign key. The classifier creates the thread in the same transaction it
  -- assigns it in, so an FK only adds a way for that transaction to fail; and a revise clears
  -- it back to NULL so the new shape is judged. tool_call_id is nullable the same way
  -- plan_nodes.done_tool_call_id is: a call whose invoke config carried no id is a real state,
  -- and '' in an id column is a value a later join silently matches.
  --
  -- New table, so no SCHEMA_VERSION bump (see the note on counters).
  CREATE TABLE IF NOT EXISTS session_diagrams (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    thread_id TEXT,
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    tool_call_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- The identity and the read path in one index: the list is by session (the leftmost column),
  -- and the unique constraint enforces one row per file. No (session_id, thread_id) index yet —
  -- nothing groups a conversation's diagrams by thread; add one when that grouping exists.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_diagrams_session_name
    ON session_diagrams(session_id, name);
  CREATE INDEX IF NOT EXISTS idx_diagrams_call ON session_diagrams(tool_call_id);

  -- A conversation's tables: one row per markdown table the model recorded, and the first
  -- derived row in this schema that holds **the artifact's own content**.
  --
  -- That inversion of the rule above is the whole argument for this table, so it is worth
  -- stating rather than leaving to be discovered: session_diagrams.summary is the precedent
  -- for "what the bytes cannot answer, stored beside them rather than in them", and there are no
  -- bytes here to store beside. A diagram's source is a *file* — the file tools can write one,
  -- the library browses it, @ can reference it — so a second copy in the row would be two
  -- copies free to disagree, which is the drift the whole split exists to prevent. A table has no
  -- file: its display is the assistant's own reply, rendered inline as Markdown (see
  -- docs/tables.md), and content is the copy the panel, the viewer and the clipboard read.
  -- Nothing can disagree with it because there is nothing else. notes.body is the same shape
  -- for the same reason.
  --
  -- No deleted_at, no message_id, and no FK on thread_id: all three are session_diagrams'
  -- argument unchanged. Derived data the model wrote in a turn, nothing in the product deletes a
  -- table, and the assistant message does not exist when the tool runs — the classifier assigns
  -- the thread directly, in the same transaction as the turn's own.
  --
  -- name is a slug with NO extension, unlike a diagram's, because there is no file name for it to
  -- match: it is the row's identity and the label the panel shows. (session_id, name) is
  -- therefore the revise rule — calling the tool again with the same name corrects that table
  -- rather than adding a second one — and ON CONFLICT is where that lives.
  --
  -- New table, so no SCHEMA_VERSION bump (see the note on counters).
  CREATE TABLE IF NOT EXISTS session_tables (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    thread_id TEXT,
    name TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_call_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- The two indexes session_diagrams has, for the same two reads: the list is by session, and a
  -- tool call is looked up by the thread classifier's own join.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_session_name
    ON session_tables(session_id, name);
  CREATE INDEX IF NOT EXISTS idx_tables_call ON session_tables(tool_call_id);

  -- The insight panel's observations: typed things a pass over the conversation noticed.
  --
  -- Derived data, and the FIRST derived table here with a delete control — which is why the
  -- absence of deleted_at is argued rather than assumed. The line this file draws is
  -- quiz_questions / session_threads / session_diagrams on one side, notes on the other, and
  -- the test is whether a rerun can reproduce the row: a note cannot be recovered from the
  -- conversation because it is the learner's own writing, and an insight can, because the same
  -- kinds are regenerated from the same material. So it belongs on the derived side, and the
  -- "delete" is not an application deletion at all — "drop this observation" is the same
  -- statement the next pass's wipe makes, one item at a time. One hard DELETE shape, reached
  -- from two places:
  --
  --   DELETE ... WHERE session_id = ? AND id = ?        -- the user dropping one
  --   DELETE ... WHERE session_id = ? AND adopted = 0   -- a pass replacing the last one
  --
  -- A deleted_at column would be worse than useless here, not merely unnecessary: the wipe
  -- hard-deletes unadopted rows INCLUDING soft-deleted ones, so the column would be written by
  -- one path and swept by another. A filter that is not the read rule is exactly what makes a
  -- soft-delete claim false. The consequence is stated out loud in docs: a deleted item can
  -- come back on the next pass. Delete is not suppression; suppression would be a new column
  -- and a new rule.
  --
  -- ordinal is the model's position within its own answer, so ordering never depends on two
  -- created_at strings comparing equal — the whole pass is written in one transaction and
  -- therefore shares a timestamp to the millisecond. adopted is 0/1 like
  -- widget_instances.enabled, and it is the ONLY thing that survives a rerun.
  --
  -- New table, so no SCHEMA_VERSION bump (see the note on counters).
  CREATE TABLE IF NOT EXISTS insight_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    adopted INTEGER NOT NULL DEFAULT 0,
    ordinal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  -- The read path and the wipe in one index: the list is by session, and the wipe is
  -- session + adopted. Ordering is the read's own (adopted DESC, created_at, ordinal), which the
  -- list is small enough for — one conversation's observations, tens of rows at most.
  CREATE INDEX IF NOT EXISTS idx_insights_session
    ON insight_items(session_id, adopted, created_at);

  /*
   * One conversation's note export: the state of its last — or current — run.
   *
   * Derived data, like session_threads and session_diagrams, so no deleted_at: nothing in the
   * product deletes a run, and a column no read filters on would make the soft-delete invariant
   * false the moment it was written.
   *
   * The primary key IS the session. The row answers one question — "what is this conversation's
   * export doing" — in a single statement, and it is also the lock: 'running' is written before
   * any work starts, with no await between the read and the write, so of two concurrent starts
   * exactly one wins. A log of runs would be a different table with a different question, and it
   * could not be the lock.
   *
   * No summary column: that belongs to the conversation, not to the run, and it is regenerated
   * on every sync — see sessions.summary.
   */
  CREATE TABLE IF NOT EXISTS session_note_syncs (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    -- 'running' | 'ok' | 'empty' | 'failed'.
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    -- What the run did: rows created, rows rewritten, rows soft-deleted.
    added INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    -- The provider's or the parser's own sentence. Untranslated, like every raw failure string.
    error TEXT
  );

  /*
   * Who may write to a conversation: one lease per session, held by one client.
   *
   * Ephemeral, like session_threads and session_note_syncs, so no deleted_at — and the reason is
   * sharper here than for those. A row's whole meaning is "this client holds the pen *now*", so a
   * soft-deleted row would be a claim about the present that outlived its truth. Release and
   * expiry are the only two exits, and both are real DELETEs.
   *
   * The primary key IS the session, which is what makes "at most one holder" the table's shape
   * rather than an invariant some future statement has to remember. client_id is generated by
   * the client and scoped to one browser tab — deliberately not the auth token, which is
   * reissued on every refresh (see issueTokens), so a lease keyed on it would change holder
   * underneath a client that refreshed. It is not a secret and the lock is not a security
   * boundary: the account check on the session is what protects the row.
   *
   * expires_at is an ISO string compared lexically, like auth_tokens.expires_at. There is
   * deliberately no sweep job: the acquire statement's upsert reclaims an expired row in place,
   * so an expiry needs no timer and an abandoned lease costs one row until somebody wants the
   * conversation.
   *
   * New table, so no SCHEMA_VERSION bump (see the note on counters).
   */
  CREATE TABLE IF NOT EXISTS session_locks (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    -- When *this* client first took it, kept across heartbeats — which is what makes "how long
    -- has this one held it" answerable instead of resetting every minute.
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
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
  const problem = schemaProblem(db);
  if (problem) throw new SchemaUnreadableError(problem.found, problem.needed);

  /*
   * The DDL and the version stamp are **one write**, and that is not tidiness.
   *
   * Two of these can now run at once — the administrator CLI is designed to be run twice, and
   * the control panel and a terminal can both be open — and the pair as separate statements has
   * a window in which the tables exist and the version has not been written. From outside, that
   * is *indistinguishable from a pre-versioning database*: tables present, `user_version` still
   * 0. So the second process would read it as an old file and refuse it, with a message about a
   * schema version that never existed.
   *
   * Inside a transaction a reader sees the file either before the DDL or after the stamp, and
   * both of those are states this build reads correctly.
   */
  db.transaction(() => {
    db.exec(DDL);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}

/**
 * A database this build will not open, as a value rather than a thrown sentence.
 *
 * The thrown form carries the same two numbers, and both exist because the *refusal* has two
 * callers with different needs: `applySchema` has to stop, and the administrator CLI's read-only
 * `status` has to *report* — it must answer "this file is a schema I cannot read" rather than
 * either throwing a stack at a control panel or, far worse, opening the file and creating a
 * second empty database beside the real one. Splitting the decision from the throwing is what
 * keeps those two from being two implementations of the same rule.
 */
export class SchemaUnreadableError extends Error {
  constructor(
    readonly found: number,
    readonly needed: number
  ) {
    super(
      `The data directory holds an ilearnassist database created by schema v${found} ` +
        `(this build needs v${needed}). This build changes where things are stored ` +
        `and cannot read the old layout. Move it aside, or point ILA_DATA_DIR at a new directory.`
    );
    this.name = "SchemaUnreadableError";
  }
}

/**
 * Whether this file's schema is one this build can read, without touching it.
 *
 * Read-only by construction — one `pragma` and one `sqlite_master` count — so it is safe on a
 * handle opened `{ readonly: true }`, and safe to call on a file you have no intention of
 * writing to. `applySchema` is the only thing that writes, and it calls this first.
 */
export function schemaProblem(
  db: Database.Database
): { found: number; needed: number } | undefined {
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
    return { found, needed: SCHEMA_VERSION };
  }
  return undefined;
}
