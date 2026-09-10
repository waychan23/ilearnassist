import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Copilot, Message, Session, ToolCall, Workspace } from "@guided-learning/shared";

/* ---------------------------------- row shapes ---------------------------------- */

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  dir_path: string;
  created_at: string;
}

interface CopilotRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string | null;
  tools: string;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  copilot_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls: string | null;
  created_at: string;
}

const mapWorkspace = (r: WorkspaceRow): Workspace => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  dirPath: r.dir_path,
  createdAt: r.created_at,
});

const mapCopilot = (r: CopilotRow): Copilot => ({
  id: r.id,
  name: r.name,
  description: r.description,
  systemPrompt: r.system_prompt,
  model: r.model,
  tools: safeParseArray(r.tools),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapSession = (r: SessionRow): Session => ({
  id: r.id,
  workspaceId: r.workspace_id,
  copilotId: r.copilot_id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMessage = (r: MessageRow): Message => ({
  id: r.id,
  sessionId: r.session_id,
  role: r.role,
  content: r.content,
  toolCalls: r.tool_calls ? safeParseArray<ToolCall[]>(r.tool_calls) : undefined,
  createdAt: r.created_at,
});

function safeParseArray<T = string[]>(json: string | null): T {
  if (!json) return [] as T;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as T) : ([] as T);
  } catch {
    return [] as T;
  }
}

export interface AppDb {
  raw: Database.Database;
  listWorkspaces(): Workspace[];
  getWorkspace(id: string): Workspace | undefined;
  createWorkspace(input: { id: string; name: string; slug: string; dirPath: string }): Workspace;
  deleteWorkspace(id: string): void;

  listCopilots(): Copilot[];
  getCopilot(id: string): Copilot | undefined;
  createCopilot(input: {
    id: string;
    name: string;
    description: string;
    systemPrompt: string;
    model: string | null;
    tools: string[];
  }): Copilot;
  updateCopilot(
    id: string,
    input: { name: string; description: string; systemPrompt: string; model: string | null; tools: string[] }
  ): Copilot | undefined;
  deleteCopilot(id: string): void;

  listSessions(workspaceId: string): Session[];
  getSession(id: string): Session | undefined;
  createSession(input: { id: string; workspaceId: string; copilotId: string | null; title: string }): Session;
  deleteSession(id: string): void;
  touchSession(id: string): void;
  setSessionCopilot(id: string, copilotId: string | null): void;

  listMessages(sessionId: string): Message[];
  createMessage(input: {
    id: string;
    sessionId: string;
    role: "user" | "assistant";
    content: string;
    toolCalls?: ToolCall[];
  }): Message;
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id, updated_at);
  `);

  const now = () => new Date().toISOString();

  /* ------------------------------ workspaces ------------------------------ */
  const stmtListWorkspaces = db.prepare("SELECT * FROM workspaces ORDER BY created_at ASC");
  const stmtGetWorkspace = db.prepare("SELECT * FROM workspaces WHERE id = ?");
  const stmtCreateWorkspace = db.prepare(
    "INSERT INTO workspaces (id, name, slug, dir_path, created_at) VALUES (@id, @name, @slug, @dirPath, @createdAt)"
  );
  const stmtDeleteWorkspace = db.prepare("DELETE FROM workspaces WHERE id = ?");

  /* ------------------------------- copilots ------------------------------- */
  const stmtListCopilots = db.prepare("SELECT * FROM copilots ORDER BY created_at ASC");
  const stmtGetCopilot = db.prepare("SELECT * FROM copilots WHERE id = ?");
  const stmtCreateCopilot = db.prepare(
    `INSERT INTO copilots (id, name, description, system_prompt, model, tools, created_at, updated_at)
     VALUES (@id, @name, @description, @systemPrompt, @model, @tools, @createdAt, @updatedAt)`
  );
  const stmtUpdateCopilot = db.prepare(
    `UPDATE copilots SET name = @name, description = @description, system_prompt = @systemPrompt,
     model = @model, tools = @tools, updated_at = @updatedAt WHERE id = @id`
  );
  const stmtDeleteCopilot = db.prepare("DELETE FROM copilots WHERE id = ?");

  /* ------------------------------- sessions ------------------------------- */
  const stmtListSessions = db.prepare(
    "SELECT * FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC"
  );
  const stmtGetSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const stmtCreateSession = db.prepare(
    `INSERT INTO sessions (id, workspace_id, copilot_id, title, created_at, updated_at)
     VALUES (@id, @workspaceId, @copilotId, @title, @createdAt, @updatedAt)`
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
  const stmtCreateMessage = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, tool_calls, created_at)
     VALUES (@id, @sessionId, @role, @content, @toolCalls, @createdAt)`
  );

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
      stmtCreateCopilot.run({ ...input, tools: JSON.stringify(input.tools), createdAt: ts, updatedAt: ts });
      const r = stmtGetCopilot.get(input.id) as CopilotRow;
      return mapCopilot(r);
    },
    updateCopilot(id, input) {
      stmtUpdateCopilot.run({
        id,
        ...input,
        tools: JSON.stringify(input.tools),
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
      const r = stmtGetSession.get(id) as SessionRow | undefined;
      return r ? mapSession(r) : undefined;
    },
    createSession(input) {
      const ts = now();
      stmtCreateSession.run({ ...input, createdAt: ts, updatedAt: ts });
      const r = stmtGetSession.get(input.id) as SessionRow;
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
    createMessage(input) {
      stmtCreateMessage.run({
        id: input.id,
        sessionId: input.sessionId,
        role: input.role,
        content: input.content,
        toolCalls: input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        createdAt: now(),
      });
      const row = db
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(input.id) as MessageRow;
      return mapMessage(row);
    },
  };
}

/** Convenience uuid/id generator shared across routes. */
export const newId = (): string => randomUUID();