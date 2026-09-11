import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Attachment,
  Copilot,
  CopilotDefaults,
  DocumentParsePolicy,
  DocumentParserKind,
  Message,
  MessageUsage,
  ModelCapability,
  ProviderModel,
  Session,
  SessionSettings,
  ToolCall,
  Workspace,
} from "@guided-learning/shared";

/* ---------------------------------- row shapes ---------------------------------- */

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  dir_path: string;
  created_at: string;
  /**
   * Present only on rows that came back from the stats query. `getWorkspace` and
   * `createWorkspace` select the bare table, and a brand-new workspace is by definition
   * empty — so `mapWorkspace` reads these as 0/null rather than every caller having to
   * join a table for a number it already knows.
   */
  session_count?: number;
  last_activity_at?: string | null;
}

interface CopilotRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  tools: string;
  settings: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  copilot_id: string | null;
  title: string;
  title_source: string | null;
  settings: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  tool_calls: string | null;
  attachments: string | null;
  usage: string | null;
  created_at: string;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  context_window: number | null;
  max_output: number | null;
  capabilities: string;
  sort_order: number;
}

interface DocumentParserRow {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  api_key: string | null;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** A provider as the server sees it — includes the apiKey. Never send this to a client. */
export interface ProviderRecord {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  models: ProviderModel[];
}

/** A configured document-parsing backend. Like `ProviderRecord`, carries the real key. */
export interface DocumentParserRecord {
  id: string;
  name: string;
  kind: DocumentParserKind;
  baseURL: string;
  apiKey?: string;
  enabled: boolean;
}

/** Setting keys stored in `app_settings`. */
export const SETTING_DEFAULT_PROVIDER = "defaultProvider";
export const SETTING_DEFAULT_MODEL = "defaultModel";
export const SETTING_DOCUMENT_POLICY = "documentParsing.policy";
export const SETTING_DOCUMENT_LOCAL_ENABLED = "documentParsing.localEnabled";
export const SETTING_DOCUMENT_FALLBACK = "documentParsing.fallbackEnabled";
export const SETTING_DOCUMENT_DEFAULT_PARSER = "documentParsing.defaultParserId";
/**
 * Marks that `config.yaml`'s parser list has been copied in at least once.
 *
 * Providers can use "the table is empty" as their not-yet-seeded signal, but parsers
 * cannot: running with zero cloud parsers is a perfectly normal state (local-only), so an
 * empty table must not be read as "never seeded" or every boot would resurrect entries
 * the user deliberately deleted.
 */
export const SETTING_DOCUMENT_SEEDED = "documentParsing.seeded";

/**
 * The title a conversation gets at creation, before the auto-titler replaces it. Kept as
 * a constant because the migration uses it to tell "never renamed" from "renamed".
 */
export const DEFAULT_SESSION_TITLE = "New conversation";

const mapWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  dirPath: r.dir_path,
  createdAt: r.created_at,
  sessionCount: r.session_count ?? 0,
  lastActivityAt: r.last_activity_at ?? null,
});

const mapCopilot = (r: CopilotRow): Copilot => ({
  id: r.id,
  name: r.name,
  description: r.description,
  systemPrompt: r.system_prompt,
  tools: safeParseArray<string>(r.tools),
  settings: safeParseObject<CopilotDefaults>(r.settings),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapSession = (r: SessionRow): Session => ({
  id: r.id,
  workspaceId: r.workspace_id,
  copilotId: r.copilot_id,
  title: r.title,
  titleSource: r.title_source === "user" ? "user" : "auto",
  settings: safeParseObject<SessionSettings>(r.settings),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMessage = (r: MessageRow): Message => ({
  id: r.id,
  sessionId: r.session_id,
  role: r.role,
  content: r.content,
  reasoning: r.reasoning ?? undefined,
  toolCalls: r.tool_calls ? safeParseArray<ToolCall>(r.tool_calls) : undefined,
  attachments: r.attachments ? safeParseArray<Attachment>(r.attachments) : undefined,
  usage: r.usage ? safeParseObject<MessageUsage>(r.usage) : undefined,
  createdAt: r.created_at,
});

const mapDocumentParser = (r: DocumentParserRow): DocumentParserRecord => ({
  id: r.id,
  name: r.name,
  kind: r.kind as DocumentParserKind,
  baseURL: r.base_url,
  apiKey: r.api_key ?? undefined,
  enabled: r.enabled !== 0,
});

const mapModel = (r: ModelRow): ProviderModel => ({
  id: r.id,
  modelId: r.model_id,
  name: r.name,
  contextWindow: r.context_window,
  maxOutput: r.max_output,
  capabilities: safeParseArray<ModelCapability>(r.capabilities),
});

function safeParseArray<T = string>(json: string | null): T[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function safeParseObject<T extends object>(json: string | null): T {
  if (!json) return {} as T;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

/**
 * Add a column to an existing table when it is missing. `CREATE TABLE IF NOT EXISTS`
 * silently skips tables that already exist, so databases created before a schema
 * change would otherwise never gain the new columns.
 *
 * Returns whether the column was actually added — callers use that to run one-off
 * backfills only on the boot that performs the migration.
 */
function ensureColumn(db: Database.Database, table: string, column: string, ddl: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

export interface AppDb {
  raw: Database.Database;
  listWorkspaces(): Workspace[];
  getWorkspace(id: string): Workspace | undefined;
  createWorkspace(input: { id: string; name: string; slug: string; dirPath: string }): Workspace;
  /**
   * Rename only. The directory on disk keeps the slug it was created with — a rename that
   * moved files would break every path the agent has already written into a conversation.
   */
  renameWorkspace(id: string, name: string): Workspace | undefined;
  deleteWorkspace(id: string): void;

  listCopilots(): Copilot[];
  getCopilot(id: string): Copilot | undefined;
  createCopilot(input: {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    settings: CopilotDefaults;
  }): Copilot;
  updateCopilot(
    id: string,
    input: {
      name: string;
      description: string;
      systemPrompt: string;
      tools: string[];
      settings: CopilotDefaults;
    }
  ): Copilot | undefined;
  deleteCopilot(id: string): void;

  listSessions(workspaceId: string): Session[];
  getSession(id: string): Session | undefined;
  createSession(input: {
    id: string;
    workspaceId: string;
    copilotId: string | null;
    title: string;
    settings?: SessionSettings;
  }): Session;
  /**
   * A supplied `title` also marks the session as user-titled, which stops the
   * auto-titler from ever overwriting it. Settings-only updates leave the flag alone.
   */
  updateSession(
    id: string,
    input: { title?: string; settings?: SessionSettings }
  ): Session | undefined;
  /** Replace the title on behalf of the auto-titler, keeping `titleSource: "auto"`. */
  setAutoTitle(id: string, title: string): Session | undefined;
  deleteSession(id: string): void;
  touchSession(id: string): void;
  setSessionCopilot(id: string, copilotId: string | null): void;

  listMessages(sessionId: string): Message[];
  getMessage(id: string): Message | undefined;
  createMessage(input: {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    reasoning?: string;
    toolCalls?: ToolCall[];
    attachments?: Attachment[];
    usage?: MessageUsage;
  }): Message;

  listProviders(): ProviderRecord[];
  getProvider(id: string): ProviderRecord | undefined;
  createProvider(input: { id: string; name: string; baseURL: string; apiKey?: string }): ProviderRecord;
  updateProvider(
    id: string,
    input: { name?: string; baseURL?: string; apiKey?: string }
  ): ProviderRecord | undefined;
  deleteProvider(id: string): void;

  createModel(input: {
    id: string;
    providerId: string;
    modelId: string;
    name: string;
    contextWindow?: number | null;
    maxOutput?: number | null;
    capabilities: ModelCapability[];
  }): ProviderModel;
  updateModel(
    id: string,
    input: {
      modelId?: string;
      name?: string;
      contextWindow?: number | null;
      maxOutput?: number | null;
      capabilities?: ModelCapability[];
    }
  ): ProviderModel | undefined;
  /** Returns false when no such model existed. */
  deleteModel(id: string): boolean;

  listDocumentParsers(): DocumentParserRecord[];
  getDocumentParser(id: string): DocumentParserRecord | undefined;
  createDocumentParser(input: {
    id: string;
    name: string;
    kind: DocumentParserKind;
    baseURL: string;
    apiKey?: string;
    enabled?: boolean;
  }): DocumentParserRecord;
  updateDocumentParser(
    id: string,
    input: {
      name?: string;
      kind?: DocumentParserKind;
      baseURL?: string;
      apiKey?: string;
      enabled?: boolean;
    }
  ): DocumentParserRecord | undefined;
  deleteDocumentParser(id: string): void;

  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
}

export function createDb(dbPath: string): AppDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      dir_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS copilots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL,
      model TEXT,
      tools TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      copilot_id TEXT REFERENCES copilots(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      title_source TEXT NOT NULL DEFAULT 'auto',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning TEXT,
      tool_calls TEXT,
      created_at TEXT NOT NULL
    );
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
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id, sort_order);
  `);

  // --- in-place migrations for databases created by an earlier schema ---
  ensureColumn(db, "messages", "attachments", "attachments TEXT");
  ensureColumn(db, "messages", "usage", "usage TEXT");
  ensureColumn(db, "messages", "reasoning", "reasoning TEXT");
  ensureColumn(db, "sessions", "settings", "settings TEXT NOT NULL DEFAULT '{}'");
  const addedTitleSource = ensureColumn(db, "sessions", "title_source", "title_source TEXT NOT NULL DEFAULT 'auto'");
  ensureColumn(db, "copilots", "settings", "settings TEXT NOT NULL DEFAULT '{}'");

  // Everything that already existed predates auto-titling. A title that is not the
  // create-time placeholder was almost certainly typed by hand, so protect it from the
  // auto-titler by marking it as user-owned.
  //
  // Gated on the migration that just added the column: run unconditionally it would also
  // rewrite every *model-written* title on each subsequent boot (the auto-titler stores
  // its result with `title_source = 'auto'`), silently locking conversations that were
  // never renamed by a person.
  if (addedTitleSource) {
    db.prepare(
      `UPDATE sessions SET title_source = 'user'
       WHERE title_source = 'auto' AND title IS NOT NULL AND title != '' AND title != ?`
    ).run(DEFAULT_SESSION_TITLE);
  }

  // Fold the legacy `copilots.model` column into `settings.modelId`. The old column is
  // left dormant rather than dropped (DROP COLUMN is version-sensitive in SQLite).
  const legacyModels = db
    .prepare("SELECT id, model, settings FROM copilots WHERE model IS NOT NULL AND model != ''")
    .all() as { id: string; model: string; settings: string | null }[];
  for (const row of legacyModels) {
    const settings = safeParseObject<CopilotDefaults>(row.settings);
    if (!settings.modelId) {
      settings.modelId = row.model;
      db.prepare("UPDATE copilots SET settings = ? WHERE id = ?").run(JSON.stringify(settings), row.id);
    }
  }

  const now = () => new Date().toISOString();

  /* ------------------------------ workspaces ------------------------------ */
  /*
   * The list carries each workspace's conversation count and most recent activity, so the
   * management page renders from one request. `MAX(s.updated_at)` rides the existing
   * `idx_sessions_workspace (workspace_id, updated_at)` index; the LEFT JOIN is what keeps a
   * workspace with no conversations in the result at all, with a count of 0 and no activity
   * — an inner join would silently drop the empty ones, which are exactly the workspaces a
   * user has just created and is looking for.
   */
  const stmtListWorkspaces = db.prepare(
    `SELECT w.*, COUNT(s.id) AS session_count, MAX(s.updated_at) AS last_activity_at
     FROM workspaces w LEFT JOIN sessions s ON s.workspace_id = w.id
     GROUP BY w.id ORDER BY w.created_at ASC`
  );
  const stmtGetWorkspace = db.prepare("SELECT * FROM workspaces WHERE id = ?");
  /*
   * The same row as `stmtGetWorkspace`, with the stats a card needs. Separate rather than
   * folded in because `getWorkspace` is mostly an existence check on the hot path of every
   * session route, where a join for a number nobody reads is a cost with no payer. It exists
   * for the rename response: handing the client back a workspace whose `sessionCount` had
   * collapsed to 0 would blank the card it was written to refresh.
   */
  const stmtGetWorkspaceWithStats = db.prepare(
    `SELECT w.*, COUNT(s.id) AS session_count, MAX(s.updated_at) AS last_activity_at
     FROM workspaces w LEFT JOIN sessions s ON s.workspace_id = w.id
     WHERE w.id = ? GROUP BY w.id`
  );
  const stmtCreateWorkspace = db.prepare(
    "INSERT INTO workspaces (id, name, slug, dir_path, created_at) VALUES (@id, @name, @slug, @dirPath, @createdAt)"
  );
  const stmtRenameWorkspace = db.prepare("UPDATE workspaces SET name = ? WHERE id = ?");
  const stmtDeleteWorkspace = db.prepare("DELETE FROM workspaces WHERE id = ?");

  /* ------------------------------- copilots ------------------------------- */
  const stmtListCopilots = db.prepare("SELECT * FROM copilots ORDER BY created_at ASC");
  const stmtGetCopilot = db.prepare("SELECT * FROM copilots WHERE id = ?");
  const stmtCreateCopilot = db.prepare(
    `INSERT INTO copilots (id, name, description, system_prompt, tools, settings, created_at, updated_at)
     VALUES (@id, @name, @description, @systemPrompt, @tools, @settings, @createdAt, @updatedAt)`
  );
  const stmtUpdateCopilot = db.prepare(
    `UPDATE copilots SET name = @name, description = @description, system_prompt = @systemPrompt,
     tools = @tools, settings = @settings, updated_at = @updatedAt WHERE id = @id`
  );
  const stmtDeleteCopilot = db.prepare("DELETE FROM copilots WHERE id = ?");

  /* ------------------------------- sessions ------------------------------- */
  const stmtListSessions = db.prepare(
    "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC"
  );
  const stmtGetSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const stmtCreateSession = db.prepare(
    `INSERT INTO sessions (id, workspace_id, copilot_id, title, title_source, settings, created_at, updated_at)
     VALUES (@id, @workspaceId, @copilotId, @title, @titleSource, @settings, @createdAt, @updatedAt)`
  );
  const stmtSetAutoTitle = db.prepare(
    "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?"
  );
  const stmtDeleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
  const stmtTouchSession = db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
  const stmtSetSessionCopilot = db.prepare(
    "UPDATE sessions SET copilot_id = ?, updated_at = ? WHERE id = ?"
  );

  /* ------------------------------- messages ------------------------------- */
  const stmtListMessages = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC"
  );
  const stmtGetMessage = db.prepare("SELECT * FROM messages WHERE id = ?");
  const stmtCreateMessage = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, attachments, usage, created_at)
     VALUES (@id, @sessionId, @role, @content, @reasoning, @toolCalls, @attachments, @usage, @createdAt)`
  );

  /* ------------------------------ providers ------------------------------- */
  const stmtListProviders = db.prepare("SELECT * FROM providers ORDER BY sort_order ASC, created_at ASC");
  const stmtGetProvider = db.prepare("SELECT * FROM providers WHERE id = ?");
  const stmtCreateProvider = db.prepare(
    `INSERT INTO providers (id, name, base_url, api_key, sort_order, created_at, updated_at)
     VALUES (@id, @name, @baseURL, @apiKey, @sortOrder, @createdAt, @updatedAt)`
  );
  const stmtDeleteProvider = db.prepare("DELETE FROM providers WHERE id = ?");
  const stmtNextProviderOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM providers"
  );

  /* -------------------------------- models -------------------------------- */
  const stmtModelsByProvider = db.prepare(
    "SELECT * FROM models WHERE provider_id = ? ORDER BY sort_order ASC"
  );
  const stmtGetModel = db.prepare("SELECT * FROM models WHERE id = ?");
  const stmtCreateModel = db.prepare(
    `INSERT INTO models (id, provider_id, model_id, name, context_window, max_output, capabilities, sort_order)
     VALUES (@id, @providerId, @modelId, @name, @contextWindow, @maxOutput, @capabilities, @sortOrder)`
  );
  const stmtDeleteModel = db.prepare("DELETE FROM models WHERE id = ?");
  const stmtNextModelOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM models WHERE provider_id = ?"
  );

  /* --------------------------- document parsers --------------------------- */
  const stmtListDocumentParsers = db.prepare(
    "SELECT * FROM document_parsers ORDER BY sort_order ASC, created_at ASC"
  );
  const stmtGetDocumentParser = db.prepare("SELECT * FROM document_parsers WHERE id = ?");
  const stmtCreateDocumentParser = db.prepare(
    `INSERT INTO document_parsers (id, name, kind, base_url, api_key, enabled, sort_order, created_at, updated_at)
     VALUES (@id, @name, @kind, @baseURL, @apiKey, @enabled, @sortOrder, @createdAt, @updatedAt)`
  );
  const stmtDeleteDocumentParser = db.prepare("DELETE FROM document_parsers WHERE id = ?");
  const stmtNextDocumentParserOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM document_parsers"
  );

  /* ------------------------------ app settings ---------------------------- */
  const stmtGetSetting = db.prepare("SELECT value FROM app_settings WHERE key = ?");
  const stmtSetSetting = db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );

  const modelsFor = (providerId: string): ProviderModel[] =>
    (stmtModelsByProvider.all(providerId) as ModelRow[]).map(mapModel);

  const readProvider = (row: ProviderRow): ProviderRecord => ({
    id: row.id,
    name: row.name,
    baseURL: row.base_url,
    apiKey: row.api_key ?? undefined,
    models: modelsFor(row.id),
  });

  const getSessionRow = (id: string) => stmtGetSession.get(id) as SessionRow | undefined;

  return {
    raw: db,

    listWorkspaces() {
      return (stmtListWorkspaces.all() as WorkspaceRow[]).map(mapWorkspace);
    },
    getWorkspace(id) {
      const r = stmtGetWorkspace.get(id) as WorkspaceRow | undefined;
      return r ? mapWorkspace(r) : undefined;
    },
    createWorkspace(input) {
      stmtCreateWorkspace.run({ ...input, createdAt: now() });
      const r = stmtGetWorkspace.get(input.id) as WorkspaceRow;
      return mapWorkspace(r);
    },
    renameWorkspace(id, name) {
      stmtRenameWorkspace.run(name, id);
      const r = stmtGetWorkspaceWithStats.get(id) as WorkspaceRow | undefined;
      return r ? mapWorkspace(r) : undefined;
    },
    deleteWorkspace(id) {
      stmtDeleteWorkspace.run(id);
    },

    listCopilots() {
      return (stmtListCopilots.all() as CopilotRow[]).map(mapCopilot);
    },
    getCopilot(id) {
      const r = stmtGetCopilot.get(id) as CopilotRow | undefined;
      return r ? mapCopilot(r) : undefined;
    },
    createCopilot(input) {
      const ts = now();
      stmtCreateCopilot.run({
        ...input,
        tools: JSON.stringify(input.tools),
        settings: JSON.stringify(input.settings),
        createdAt: ts,
        updatedAt: ts,
      });
      const r = stmtGetCopilot.get(input.id) as CopilotRow;
      return mapCopilot(r);
    },
    updateCopilot(id, input) {
      stmtUpdateCopilot.run({
        id,
        ...input,
        tools: JSON.stringify(input.tools),
        settings: JSON.stringify(input.settings),
        updatedAt: now(),
      });
      const r = stmtGetCopilot.get(id) as CopilotRow | undefined;
      return r ? mapCopilot(r) : undefined;
    },
    deleteCopilot(id) {
      stmtDeleteCopilot.run(id);
    },

    listSessions(workspaceId) {
      return (stmtListSessions.all(workspaceId) as SessionRow[]).map(mapSession);
    },
    getSession(id) {
      const r = getSessionRow(id);
      return r ? mapSession(r) : undefined;
    },
    createSession(input) {
      const ts = now();
      stmtCreateSession.run({
        ...input,
        titleSource: "auto",
        settings: JSON.stringify(input.settings ?? {}),
        createdAt: ts,
        updatedAt: ts,
      });
      const r = stmtGetSession.get(input.id) as SessionRow;
      return mapSession(r);
    },
    updateSession(id, input) {
      const existing = getSessionRow(id);
      if (!existing) return undefined;

      const renamed = input.title !== undefined && !!input.title.trim();
      const title = renamed ? input.title!.trim() : existing.title;
      const settings = input.settings
        ? { ...safeParseObject<SessionSettings>(existing.settings), ...input.settings }
        : safeParseObject<SessionSettings>(existing.settings);

      db.prepare(
        "UPDATE sessions SET title = ?, title_source = ?, settings = ?, updated_at = ? WHERE id = ?"
      ).run(
        title,
        renamed ? "user" : existing.title_source ?? "auto",
        JSON.stringify(settings),
        now(),
        id
      );
      const r = stmtGetSession.get(id) as SessionRow;
      return mapSession(r);
    },
    setAutoTitle(id, title) {
      if (!stmtGetSession.get(id)) return undefined;
      stmtSetAutoTitle.run(title, now(), id);
      const r = stmtGetSession.get(id) as SessionRow;
      return mapSession(r);
    },
    deleteSession(id) {
      stmtDeleteSession.run(id);
    },
    touchSession(id) {
      stmtTouchSession.run(now(), id);
    },
    setSessionCopilot(id, copilotId) {
      stmtSetSessionCopilot.run(copilotId, now(), id);
    },

    listMessages(sessionId) {
      return (stmtListMessages.all(sessionId) as MessageRow[]).map(mapMessage);
    },
    getMessage(id) {
      const r = stmtGetMessage.get(id) as MessageRow | undefined;
      return r ? mapMessage(r) : undefined;
    },
    createMessage(input) {
      stmtCreateMessage.run({
        id: input.id,
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        reasoning: input.reasoning?.trim() ? input.reasoning : null,
        toolCalls: input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        attachments: input.attachments?.length ? JSON.stringify(input.attachments) : null,
        usage: input.usage ? JSON.stringify(input.usage) : null,
        createdAt: now(),
      });
      const row = stmtGetMessage.get(input.id) as MessageRow;
      return mapMessage(row);
    },

    listProviders() {
      return (stmtListProviders.all() as ProviderRow[]).map(readProvider);
    },
    getProvider(id) {
      const r = stmtGetProvider.get(id) as ProviderRow | undefined;
      return r ? readProvider(r) : undefined;
    },
    createProvider(input) {
      const ts = now();
      const { next } = stmtNextProviderOrder.get() as { next: number };
      stmtCreateProvider.run({
        id: input.id,
        name: input.name,
        baseURL: input.baseURL,
        apiKey: input.apiKey ?? null,
        sortOrder: next,
        createdAt: ts,
        updatedAt: ts,
      });
      const r = stmtGetProvider.get(input.id) as ProviderRow;
      return readProvider(r);
    },
    updateProvider(id, input) {
      const existing = stmtGetProvider.get(id) as ProviderRow | undefined;
      if (!existing) return undefined;
      db.prepare(
        "UPDATE providers SET name = ?, base_url = ?, api_key = ?, updated_at = ? WHERE id = ?"
      ).run(
        input.name?.trim() || existing.name,
        input.baseURL?.trim() || existing.base_url,
        input.apiKey === undefined ? existing.api_key : input.apiKey || null,
        now(),
        id
      );
      const r = stmtGetProvider.get(id) as ProviderRow;
      return readProvider(r);
    },
    deleteProvider(id) {
      stmtDeleteProvider.run(id);
    },

    createModel(input) {
      const { next } = stmtNextModelOrder.get(input.providerId) as { next: number };
      stmtCreateModel.run({
        id: input.id,
        providerId: input.providerId,
        modelId: input.modelId,
        name: input.name,
        contextWindow: input.contextWindow ?? null,
        maxOutput: input.maxOutput ?? null,
        capabilities: JSON.stringify(input.capabilities),
        sortOrder: next,
      });
      const r = stmtGetModel.get(input.id) as ModelRow;
      return mapModel(r);
    },
    updateModel(id, input) {
      const existing = stmtGetModel.get(id) as ModelRow | undefined;
      if (!existing) return undefined;
      db.prepare(
        `UPDATE models SET model_id = ?, name = ?, context_window = ?, max_output = ?, capabilities = ?
         WHERE id = ?`
      ).run(
        input.modelId?.trim() || existing.model_id,
        input.name?.trim() || existing.name,
        input.contextWindow === undefined ? existing.context_window : input.contextWindow,
        input.maxOutput === undefined ? existing.max_output : input.maxOutput,
        input.capabilities ? JSON.stringify(input.capabilities) : existing.capabilities,
        id
      );
      const r = stmtGetModel.get(id) as ModelRow;
      return mapModel(r);
    },
    deleteModel(id) {
      return stmtDeleteModel.run(id).changes > 0;
    },

    listDocumentParsers() {
      return (stmtListDocumentParsers.all() as DocumentParserRow[]).map(mapDocumentParser);
    },
    getDocumentParser(id) {
      const r = stmtGetDocumentParser.get(id) as DocumentParserRow | undefined;
      return r ? mapDocumentParser(r) : undefined;
    },
    createDocumentParser(input) {
      const ts = now();
      const { next } = stmtNextDocumentParserOrder.get() as { next: number };
      stmtCreateDocumentParser.run({
        id: input.id,
        name: input.name,
        kind: input.kind,
        baseURL: input.baseURL,
        apiKey: input.apiKey ?? null,
        enabled: input.enabled === false ? 0 : 1,
        sortOrder: next,
        createdAt: ts,
        updatedAt: ts,
      });
      const r = stmtGetDocumentParser.get(input.id) as DocumentParserRow;
      return mapDocumentParser(r);
    },
    updateDocumentParser(id, input) {
      const existing = stmtGetDocumentParser.get(id) as DocumentParserRow | undefined;
      if (!existing) return undefined;
      db.prepare(
        `UPDATE document_parsers SET name = ?, kind = ?, base_url = ?, api_key = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        input.name?.trim() || existing.name,
        input.kind ?? existing.kind,
        input.baseURL?.trim() || existing.base_url,
        // Same contract as providers: an absent key keeps the stored one, "" clears it.
        input.apiKey === undefined ? existing.api_key : input.apiKey || null,
        input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
        now(),
        id
      );
      const r = stmtGetDocumentParser.get(id) as DocumentParserRow;
      return mapDocumentParser(r);
    },
    deleteDocumentParser(id) {
      stmtDeleteDocumentParser.run(id);
    },

    getSetting(key) {
      const r = stmtGetSetting.get(key) as { value: string } | undefined;
      return r?.value;
    },
    setSetting(key, value) {
      stmtSetSetting.run(key, value);
    },
  };
}

/** Convenience uuid/id generator shared across routes. */
export const newId = (): string => randomUUID();

/* --------------------------------- seeding --------------------------------- */

/** The shape `seedFromConfig` needs from `config.yaml` (structurally = `ProviderDef`). */
export interface SeedProviderDef {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  models: { id: string; name: string }[];
}

/**
 * Best-effort capability guess for a model seeded from config. It only pre-fills the
 * checkboxes in Settings → Providers; the user can correct it there, and it drives
 * nothing but the vision placeholder and the UI badges.
 */
export function guessCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase();
  const caps: ModelCapability[] = ["tool_use"];
  if (/(gpt-4o|gpt-4\.1|gpt-5|claude|gemini|vision|llava|-vl|vl-|omni|pixtral)/.test(id)) {
    caps.push("vision");
  }
  if (/(^|[-_/])o[1-9]|reason|(^|[-_/])r1|think/.test(id)) caps.push("reasoning");
  return caps;
}

/**
 * Copy `config.yaml` providers/models into the database on first boot. Afterwards the
 * database is the source of truth — this never overwrites what the UI saved, so a later
 * edit to `config.yaml` (or the disappearance of an env var) cannot clobber user state.
 */
export function seedFromConfig(
  db: AppDb,
  input: { providers: SeedProviderDef[]; defaultProvider: string; defaultModel: string }
): boolean {
  if (db.listProviders().length > 0) {
    // Already seeded (or fully user-managed) — only fill in missing defaults.
    if (!db.getSetting(SETTING_DEFAULT_PROVIDER)) {
      db.setSetting(SETTING_DEFAULT_PROVIDER, input.defaultProvider);
    }
    if (!db.getSetting(SETTING_DEFAULT_MODEL)) {
      db.setSetting(SETTING_DEFAULT_MODEL, input.defaultModel);
    }
    return false;
  }

  for (const p of input.providers) {
    // The YAML `id` becomes the record id so `defaultProvider: deepseek` stays valid
    // and re-seeding is idempotent.
    db.createProvider({ id: p.id, name: p.name, baseURL: p.baseURL, apiKey: p.apiKey });
    for (const m of p.models) {
      db.createModel({
        id: newId(),
        providerId: p.id,
        modelId: m.id,
        name: m.name,
        capabilities: guessCapabilities(m.id),
      });
    }
  }

  db.setSetting(SETTING_DEFAULT_PROVIDER, input.defaultProvider);
  db.setSetting(SETTING_DEFAULT_MODEL, input.defaultModel);
  return true;
}

/* ---------------------------- document parsing ---------------------------- */

/** The shape `seedDocumentParsersFromConfig` needs from `config.yaml`. */
export interface SeedDocumentParserDef {
  id: string;
  name: string;
  kind: DocumentParserKind;
  baseURL: string;
  apiKey?: string;
  enabled?: boolean;
}

export interface SeedDocumentParsingDef {
  localEnabled: boolean;
  policy: DocumentParsePolicy;
  fallbackEnabled: boolean;
  defaultParserId?: string | null;
}

/**
 * Copy `config.yaml`'s document parsers into the database on first boot.
 *
 * Gated on an explicit marker rather than "the table is empty" — a user who deleted every
 * cloud parser (running local-only) has a legitimately empty table, and re-seeding it on
 * the next restart would undo their decision.
 *
 * `defaultParserId` is deliberately *not* seeded as a setting unless explicitly given:
 * absent means "try every enabled parser in preference order", which is the better default
 * for someone who never opened the settings screen.
 */
export function seedDocumentParsersFromConfig(
  db: AppDb,
  input: { parsers: SeedDocumentParserDef[]; parsing: SeedDocumentParsingDef }
): boolean {
  const alreadySeeded = db.getSetting(SETTING_DOCUMENT_SEEDED) !== undefined;

  if (!alreadySeeded) {
    for (const p of input.parsers) {
      db.createDocumentParser({
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseURL: p.baseURL,
        apiKey: p.apiKey,
        enabled: p.enabled,
      });
    }
    db.setSetting(SETTING_DOCUMENT_SEEDED, "1");
  }

  // Policy settings are backfilled independently: a config file that only gains a
  // `documentParsing:` block should take effect without a database reset.
  if (!db.getSetting(SETTING_DOCUMENT_POLICY)) {
    db.setSetting(SETTING_DOCUMENT_POLICY, input.parsing.policy);
  }
  if (!db.getSetting(SETTING_DOCUMENT_LOCAL_ENABLED)) {
    db.setSetting(SETTING_DOCUMENT_LOCAL_ENABLED, input.parsing.localEnabled ? "1" : "0");
  }
  if (!db.getSetting(SETTING_DOCUMENT_FALLBACK)) {
    db.setSetting(SETTING_DOCUMENT_FALLBACK, input.parsing.fallbackEnabled ? "1" : "0");
  }
  if (input.parsing.defaultParserId && !db.getSetting(SETTING_DOCUMENT_DEFAULT_PARSER)) {
    db.setSetting(SETTING_DOCUMENT_DEFAULT_PARSER, input.parsing.defaultParserId);
  }

  return !alreadySeeded;
}

/** Current parsing policy, falling back to the config file for anything unset. */
export function readDocumentParsing(
  db: AppDb,
  defaults: SeedDocumentParsingDef
): {
  localEnabled: boolean;
  policy: DocumentParsePolicy;
  fallbackEnabled: boolean;
  defaultParserId: string | null;
} {
  const policy = db.getSetting(SETTING_DOCUMENT_POLICY);
  return {
    localEnabled: (db.getSetting(SETTING_DOCUMENT_LOCAL_ENABLED) ?? (defaults.localEnabled ? "1" : "0")) !== "0",
    policy: isParsePolicy(policy) ? policy : defaults.policy,
    fallbackEnabled:
      (db.getSetting(SETTING_DOCUMENT_FALLBACK) ?? (defaults.fallbackEnabled ? "1" : "0")) !== "0",
    // An empty setting means "no pin" — normalise it to null so callers get one
    // representation of "try everything" rather than two that both behave the same.
    defaultParserId:
      db.getSetting(SETTING_DOCUMENT_DEFAULT_PARSER) || defaults.defaultParserId || null,
  };
}

function isParsePolicy(value: string | undefined): value is DocumentParsePolicy {
  return (
    value === "local-only" ||
    value === "local-first" ||
    value === "cloud-first" ||
    value === "cloud-only"
  );
}
