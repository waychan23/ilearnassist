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
  User,
  Workspace,
} from "@ilearnassist/shared";
import { workspaceWorkdir } from "./paths.js";
import { applySchema } from "./schema.js";

/* ---------------------------------- row shapes ---------------------------------- */

interface UserRow {
  id: string;
  username: string;
  slug: string;
  created_at: string;
}

interface WorkspaceRow {
  id: string;
  user_id: string;
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
 * The secret session cookies are signed with, created on first use.
 *
 * In the database rather than in a file or an environment variable, so that it travels with
 * the data root it protects: a cookie issued against one installation's accounts means
 * nothing to another's. Deleting the row rotates it and signs everyone out, which is the
 * lever to reach for if one ever leaks.
 */
export const SETTING_AUTH_SECRET = "auth.secret";

/**
 * The title a conversation gets at creation, before the auto-titler replaces it.
 *
 * A constant because two places have to agree on it: the create route, which writes it, and
 * anything asking whether a title is still the placeholder rather than something a person
 * typed. Spelled twice, the two would drift and a rename would start looking like a default.
 */
export const DEFAULT_SESSION_TITLE = "New conversation";

const mapUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  slug: r.slug,
  createdAt: r.created_at,
});

const mapWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  dirPath: r.dir_path,
  // Derived, not stored: `dir_path` is the workspace's own directory, and the sandbox is
  // always its `workdir/` child. Computing it here is what lets a row move between the two
  // meanings without the column having to say which one it now holds.
  workdirPath: workspaceWorkdir(r.dir_path),
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

  /**
   * Accounts. There is no password yet, so `findUserByUsername` + `createUser` *is* signing
   * in — the login route looks the name up and makes the account if it is new. The lookup
   * is case-insensitive (`idx_users_username` is `COLLATE NOCASE`), so "Ada" and "ada" are
   * one account rather than two that look identical on the login screen.
   */
  listUsers(): User[];
  getUser(id: string): User | undefined;
  findUserByUsername(username: string): User | undefined;
  createUser(input: { id: string; username: string; slug: string }): User;

  /**
   * Workspaces — and the pattern every user-owned accessor below follows.
   *
   * Each one takes the owner and puts it in the `WHERE`, so an id on its own can never
   * reach a row. The alternative — look the row up, then compare its owner — is a check
   * somebody will eventually forget on a new route, and the failure is another user's data
   * rather than an error. Naming these `ForUser` keeps that visible at every call site.
   *
   * "Not yours" and "does not exist" are the same answer, deliberately: a route turns both
   * into a 404, so probing an id cannot tell you whether someone else's workspace is there.
   */
  listWorkspaces(userId: string): Workspace[];
  getWorkspaceForUser(id: string, userId: string): Workspace | undefined;
  createWorkspace(input: {
    id: string;
    userId: string;
    name: string;
    slug: string;
    dirPath: string;
  }): Workspace;
  /**
   * Rename only. The directory on disk keeps the slug it was created with — a rename that
   * moved files would break every path the agent has already written into a conversation.
   */
  renameWorkspaceForUser(id: string, userId: string, name: string): Workspace | undefined;
  /** Returns false when no such workspace existed, or it belonged to someone else. */
  deleteWorkspaceForUser(id: string, userId: string): boolean;

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

  listSessionsForUser(workspaceId: string, userId: string): Session[];
  /**
   * A session together with the workspace holding it.
   *
   * They are almost always wanted as a pair — the chat, answers and file routes each
   * resolve a session and then immediately need its workspace — and returning both is what
   * removes the second, unscoped lookup those routes used to make. Ownership is checked
   * through the workspace join, so a session from another account simply is not found.
   */
  getSessionForUser(
    id: string,
    userId: string
  ): { session: Session; workspace: Workspace } | undefined;
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
  updateSessionForUser(
    id: string,
    userId: string,
    input: { title?: string; settings?: SessionSettings }
  ): Session | undefined;
  /** Replace the title on behalf of the auto-titler, keeping `titleSource: "auto"`. */
  setAutoTitleForUser(id: string, userId: string, title: string): Session | undefined;
  /** Returns false when no such session existed, or it belonged to someone else. */
  deleteSessionForUser(id: string, userId: string): boolean;

  /*
   * The session-id-only accessors below — this pair, and `createMessage`,
   * `findAwaitingToolCall`, `updateMessageToolCalls` and `skipAwaitingToolCalls` further
   * down — take an id and nothing else on purpose. Every caller reaches them *after* a
   * `...ForUser` read has
   * resolved the session, so they act by primary key on a path that is already guarded, and
   * a second join here would buy nothing at the cost of a query on every turn. This is the
   * one deliberate asymmetry in the scoping: a comment rather than a signature, because the
   * guard is genuinely upstream rather than merely inconvenient here.
   */
  touchSession(id: string): void;
  setSessionCopilot(id: string, copilotId: string | null): void;

  listMessagesForUser(sessionId: string, userId: string): Message[];
  getMessageForUser(id: string, userId: string): Message | undefined;
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

  /**
   * Find a suspended `ask_user` call, with the id of the message holding it.
   *
   * Scoped to one session rather than looked up by tool-call id alone, because the id
   * comes from the client and a bare lookup would let one session answer another's
   * question. Returns undefined once the call is no longer `awaiting` — which is what
   * makes a repeat submission a 409 rather than a silent overwrite.
   */
  findAwaitingToolCall(
    sessionId: string,
    toolCallId: string
  ): { messageId: string; call: ToolCall } | undefined;

  /** Write a message's whole `toolCalls` array back, after an answer was filled in. */
  updateMessageToolCalls(messageId: string, toolCalls: ToolCall[]): void;

  /**
   * Retire every still-awaiting `ask_user` call in a session, returning how many.
   *
   * Called when the user sends a new message instead of answering: the turn those
   * questions belonged to is over, and a card that stayed answerable would resume a
   * conversation the user has already moved on from.
   */
  skipAwaitingToolCalls(sessionId: string): number;

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

  // Creates the tables, or refuses a file this build cannot read. See `schema.ts`.
  applySchema(db);

  const now = () => new Date().toISOString();

  /* --------------------------------- users -------------------------------- */
  const stmtListUsers = db.prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE ASC");
  const stmtGetUser = db.prepare("SELECT * FROM users WHERE id = ?");
  // `COLLATE NOCASE` on the comparison, not just on the index: the index is what makes it
  // fast, but spelling it here is what makes it true for a `username` written by anything
  // other than this statement.
  const stmtFindUserByUsername = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE");
  const stmtCreateUser = db.prepare(
    "INSERT INTO users (id, username, slug, created_at) VALUES (@id, @username, @slug, @createdAt)"
  );

  /* ------------------------------ workspaces ------------------------------ */
  /*
   * The list carries each workspace's conversation count and most recent activity, so the
   * management page renders from one request. `MAX(s.updated_at)` rides the existing
   * `idx_sessions_workspace (workspace_id, updated_at)` index; the LEFT JOIN is what keeps a
   * workspace with no conversations in the result at all, with a count of 0 and no activity
   * — an inner join would silently drop the empty ones, which are exactly the workspaces a
   * user has just created and is looking for.
   *
   * The `user_id` filter rides `idx_workspaces_user` and comes before the grouping, so it
   * narrows the rows the join sees rather than filtering its result.
   */
  const stmtListWorkspaces = db.prepare(
    `SELECT w.*, COUNT(s.id) AS session_count, MAX(s.updated_at) AS last_activity_at
     FROM workspaces w LEFT JOIN sessions s ON s.workspace_id = w.id
     WHERE w.user_id = ? GROUP BY w.id ORDER BY w.created_at ASC`
  );
  const stmtGetWorkspaceForUser = db.prepare(
    "SELECT * FROM workspaces WHERE id = ? AND user_id = ?"
  );
  /*
   * The same row as `stmtGetWorkspaceForUser`, with the stats a card needs. Separate rather
   * than folded in because the plain lookup is mostly an existence check on the hot path of
   * every session route, where a join for a number nobody reads is a cost with no payer. It
   * exists for the rename response: handing the client back a workspace whose
   * `sessionCount` had collapsed to 0 would blank the card it was written to refresh.
   */
  const stmtGetWorkspaceWithStatsForUser = db.prepare(
    `SELECT w.*, COUNT(s.id) AS session_count, MAX(s.updated_at) AS last_activity_at
     FROM workspaces w LEFT JOIN sessions s ON s.workspace_id = w.id
     WHERE w.id = ? AND w.user_id = ? GROUP BY w.id`
  );
  const stmtCreateWorkspace = db.prepare(
    `INSERT INTO workspaces (id, user_id, name, slug, dir_path, created_at)
     VALUES (@id, @userId, @name, @slug, @dirPath, @createdAt)`
  );
  const stmtRenameWorkspaceForUser = db.prepare(
    "UPDATE workspaces SET name = ? WHERE id = ? AND user_id = ?"
  );
  const stmtDeleteWorkspaceForUser = db.prepare(
    "DELETE FROM workspaces WHERE id = ? AND user_id = ?"
  );

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
  /*
   * A session's owner is reached through its workspace, so these joins *are* the scoping.
   * There is no `sessions.user_id` and deliberately so: a second copy of the owner is a
   * second thing that has to stay in agreement, and the day the two disagree is the day one
   * account reads another's conversation.
   */
  const stmtListSessionsForUser = db.prepare(
    `SELECT s.* FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.workspace_id = ? AND w.user_id = ? ORDER BY s.updated_at DESC`
  );
  const stmtGetSessionForUser = db.prepare(
    `SELECT s.* FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.id = ? AND w.user_id = ?`
  );
  /** Unscoped: for the accessors documented as taking an already-resolved session id. */
  const stmtGetSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const stmtCreateSession = db.prepare(
    `INSERT INTO sessions (id, workspace_id, copilot_id, title, title_source, settings, created_at, updated_at)
     VALUES (@id, @workspaceId, @copilotId, @title, @titleSource, @settings, @createdAt, @updatedAt)`
  );
  const stmtUpdateSessionForUser = db.prepare(
    `UPDATE sessions SET title = ?, title_source = ?, settings = ?, updated_at = ?
      WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = ?)`
  );
  const stmtSetAutoTitleForUser = db.prepare(
    `UPDATE sessions SET title = ?, updated_at = ?
      WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = ?)`
  );
  const stmtDeleteSessionForUser = db.prepare(
    `DELETE FROM sessions
      WHERE id = ? AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = ?)`
  );
  const stmtTouchSession = db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
  const stmtSetSessionCopilot = db.prepare(
    "UPDATE sessions SET copilot_id = ?, updated_at = ? WHERE id = ?"
  );

  /* ------------------------------- messages ------------------------------- */
  /*
   * Two ways to read the same rows, and the pair is the point: `stmtListMessages` is the
   * unscoped one, used only by the session-id-only accessors above, and the `ForUser` pair
   * is what a route can reach. They are not interchangeable.
   */
  const stmtListMessages = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC"
  );
  const stmtListMessagesForUser = db.prepare(
    `SELECT m.* FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE m.session_id = ? AND w.user_id = ?
      ORDER BY m.created_at ASC`
  );
  const stmtGetMessageForUser = db.prepare(
    `SELECT m.* FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE m.id = ? AND w.user_id = ?`
  );
  /** `createMessage`'s read-back, by primary key on a row this same call just inserted. */
  const stmtGetMessageById = db.prepare("SELECT * FROM messages WHERE id = ?");
  const stmtCreateMessage = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, attachments, usage, created_at)
     VALUES (@id, @sessionId, @role, @content, @reasoning, @toolCalls, @attachments, @usage, @createdAt)`
  );
  const stmtUpdateToolCalls = db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?");

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

  const workspaceForUser = (id: string, userId: string): Workspace | undefined => {
    const r = stmtGetWorkspaceForUser.get(id, userId) as WorkspaceRow | undefined;
    return r ? mapWorkspace(r) : undefined;
  };

  const getSessionRowForUser = (id: string, userId: string) =>
    stmtGetSessionForUser.get(id, userId) as SessionRow | undefined;

  /** Unscoped, for the session-id-only accessors listed in `AppDb`. */
  const listMessagesOf = (sessionId: string): Message[] =>
    (stmtListMessages.all(sessionId) as MessageRow[]).map(mapMessage);

  return {
    raw: db,

    listUsers() {
      return (stmtListUsers.all() as UserRow[]).map(mapUser);
    },
    getUser(id) {
      const r = stmtGetUser.get(id) as UserRow | undefined;
      return r ? mapUser(r) : undefined;
    },
    findUserByUsername(username) {
      const r = stmtFindUserByUsername.get(username) as UserRow | undefined;
      return r ? mapUser(r) : undefined;
    },
    createUser(input) {
      stmtCreateUser.run({ ...input, createdAt: now() });
      const r = stmtGetUser.get(input.id) as UserRow;
      return mapUser(r);
    },

    listWorkspaces(userId) {
      return (stmtListWorkspaces.all(userId) as WorkspaceRow[]).map(mapWorkspace);
    },
    getWorkspaceForUser(id, userId) {
      return workspaceForUser(id, userId);
    },
    createWorkspace(input) {
      stmtCreateWorkspace.run({ ...input, createdAt: now() });
      const r = stmtGetWorkspaceForUser.get(input.id, input.userId) as WorkspaceRow;
      return mapWorkspace(r);
    },
    renameWorkspaceForUser(id, userId, name) {
      stmtRenameWorkspaceForUser.run(name, id, userId);
      const r = stmtGetWorkspaceWithStatsForUser.get(id, userId) as WorkspaceRow | undefined;
      return r ? mapWorkspace(r) : undefined;
    },
    deleteWorkspaceForUser(id, userId) {
      return stmtDeleteWorkspaceForUser.run(id, userId).changes > 0;
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

    listSessionsForUser(workspaceId, userId) {
      return (stmtListSessionsForUser.all(workspaceId, userId) as SessionRow[]).map(mapSession);
    },
    getSessionForUser(id, userId) {
      const r = getSessionRowForUser(id, userId);
      if (!r) return undefined;
      const session = mapSession(r);
      // Through the workspace's own scoped accessor rather than read off the join: the
      // caller wants a whole `Workspace` (stats included), and the row was just proved
      // reachable, so the second lookup is one indexed read that cannot come back empty.
      const workspace = workspaceForUser(session.workspaceId, userId);
      return workspace ? { session, workspace } : undefined;
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
    updateSessionForUser(id, userId, input) {
      const existing = getSessionRowForUser(id, userId);
      if (!existing) return undefined;

      const renamed = input.title !== undefined && !!input.title.trim();
      const title = renamed ? input.title!.trim() : existing.title;
      const settings = input.settings
        ? { ...safeParseObject<SessionSettings>(existing.settings), ...input.settings }
        : safeParseObject<SessionSettings>(existing.settings);

      stmtUpdateSessionForUser.run(
        title,
        renamed ? "user" : existing.title_source ?? "auto",
        JSON.stringify(settings),
        now(),
        id,
        userId
      );
      const r = stmtGetSession.get(id) as SessionRow;
      return mapSession(r);
    },
    setAutoTitleForUser(id, userId, title) {
      const { changes } = stmtSetAutoTitleForUser.run(title, now(), id, userId);
      if (changes === 0) return undefined;
      const r = stmtGetSession.get(id) as SessionRow;
      return mapSession(r);
    },
    deleteSessionForUser(id, userId) {
      return stmtDeleteSessionForUser.run(id, userId).changes > 0;
    },
    touchSession(id) {
      stmtTouchSession.run(now(), id);
    },
    setSessionCopilot(id, copilotId) {
      stmtSetSessionCopilot.run(copilotId, now(), id);
    },

    listMessagesForUser(sessionId, userId) {
      return (stmtListMessagesForUser.all(sessionId, userId) as MessageRow[]).map(mapMessage);
    },
    getMessageForUser(id, userId) {
      const r = stmtGetMessageForUser.get(id, userId) as MessageRow | undefined;
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
      const row = stmtGetMessageById.get(input.id) as MessageRow;
      return mapMessage(row);
    },

    findAwaitingToolCall(sessionId, toolCallId) {
      for (const message of listMessagesOf(sessionId)) {
        const call = (message.toolCalls ?? []).find(
          (tc) => tc.id === toolCallId && tc.status === "awaiting"
        );
        if (call) return { messageId: message.id, call };
      }
      return undefined;
    },

    updateMessageToolCalls(messageId, toolCalls) {
      stmtUpdateToolCalls.run(JSON.stringify(toolCalls), messageId);
    },

    skipAwaitingToolCalls(sessionId) {
      let skipped = 0;
      for (const message of listMessagesOf(sessionId)) {
        const calls = message.toolCalls ?? [];
        if (!calls.some((tc) => tc.status === "awaiting")) continue;
        const next = calls.map((tc) => {
          if (tc.status !== "awaiting") return tc;
          skipped++;
          // No `output`: the model must not be told about a question it asked in a turn
          // the user moved on from. See `ToolCall.status`.
          return { ...tc, status: "skipped" as const };
        });
        stmtUpdateToolCalls.run(JSON.stringify(next), message.id);
      }
      return skipped;
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
