import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Attachment,
  Copilot,
  CopilotDefaults,
  CopilotVisibility,
  DocumentParsePolicy,
  DocumentParserKind,
  Message,
  MessageUsage,
  ModelCapability,
  ParseErrorCode,
  ParseStatus,
  PlanNodeStatus,
  PlanStatus,
  ProviderModel,
  Session,
  SessionSettings,
  SessionStats,
  Source,
  ToolCall,
  User,
  WidgetId,
  WidgetScope,
  WidgetState,
  Workspace,
  WorkspaceStats,
} from "@ilearnassist/shared";
import { DEFAULT_WIDGET_IDS, isWidgetId } from "@ilearnassist/shared";
import { workspaceWorkdir } from "./paths.js";
import { applySchema } from "./schema.js";
import { buildSessionStats, buildWorkspaceStats, resolveWidgetStates } from "./widgets.js";

/* ---------------------------------- row shapes ---------------------------------- */

interface SourceRow {
  id: string;
  user_id: string;
  sha256: string;
  name: string;
  mime_type: string;
  size: number;
  kind: string;
  raw_path: string;
  parse_status: string;
  parse_error: string | null;
  parse_error_code: string | null;
  parser_id: string | null;
  parsed_chars: number | null;
  page_count: number | null;
  parse_updated_at: string | null;
  created_at: string;
}

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
  user_id: string | null;
  /** From the `users` join every copilot query carries; null when there is no owner. */
  owner_name: string | null;
  name: string;
  description: string;
  system_prompt: string;
  all_tools: number | null;
  tools: string;
  settings: string | null;
  /** Nullable: `null` is a row written before the column existed, i.e. "never set". */
  widgets: string | null;
  visibility: string | null;
  created_at: string;
  updated_at: string;
}

/** One `widget_instances` row, as it is stored. */
interface WidgetRow {
  widget_id: string;
  enabled: number;
}

interface PlanRow {
  id: string;
  session_id: string;
  version: number;
  status: string;
  created_at: string;
  updated_at: string;
}

interface PlanNodeRow {
  id: string;
  plan_id: string;
  parent_id: string | null;
  position: number;
  title: string;
  status: string;
  introduced_version: number;
  removed_version: number | null;
  // The node's start anchor: the progress call that first marked it in_progress (before the
  // teaching content), falling back to the completion call when no separate start was made.
  // Column name predates that widening; see `plans.ts`.
  done_tool_call_id: string | null;
  done_at: string | null;
}

interface PlanVersionRow {
  version: number;
  created_at: string;
}

/** A plan as the server layer holds it. One per session. */
export interface PlanRecord {
  id: string;
  sessionId: string;
  version: number;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * One plan node. `parentId`/`position` are the node's last place — frozen when the node
 * becomes a tombstone (`removedVersion` set), which is what lets the current view render it
 * struck through where it used to be. Progress lives here, never on a version snapshot.
 */
export interface PlanNodeRecord {
  id: string;
  planId: string;
  parentId: string | null;
  position: number;
  title: string;
  status: PlanNodeStatus;
  introducedVersion: number;
  removedVersion: number | null;
  anchorToolCallId: string | null;
  anchorAt: string | null;
}

export interface PlanVersionRecord {
  version: number;
  createdAt: string;
}

export interface PlanVersionData extends PlanVersionRecord {
  treeJson: string;
}

export interface PlanNodeInsert {
  id: string;
  planId: string;
  parentId: string | null;
  position: number;
  title: string;
  status: PlanNodeStatus;
  introducedVersion: number;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  copilot_id: string | null;
  copilot_name: string | null;
  system_prompt: string | null;
  all_tools: number | null;
  tools: string | null;
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
  /** SQLite has no boolean: 0/1, and `null` on rows written before the column existed. */
  stopped: number | null;
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

/**
 * A source as the **server** sees it: the wire shape plus the two fields that never leave.
 *
 * Same split as `ProviderRecord` and its `apiKey` — and for a stronger reason, because
 * `rawPath` is a filesystem path inside the data root. A client has no use for it (it asks
 * `/api/sources/:id/raw`) and knowing it would tell them the layout of a directory they are
 * not allowed to browse.
 */
export interface SourceRecord extends Source {
  userId: string;
  /** Where the bytes are. Validated by `resolveInSources` before every read. */
  rawPath: string;
}

const mapSource = (r: SourceRow): SourceRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  mimeType: r.mime_type,
  size: r.size,
  kind: r.kind === "image" ? "image" : "file",
  parseStatus: r.parse_status as ParseStatus,
  // Each of these is absent rather than null when there is nothing to say, matching the
  // wire type — a JSON `null` for `parseError` would reach the client as an empty tooltip.
  parseError: r.parse_error ?? undefined,
  parseErrorCode: (r.parse_error_code ?? undefined) as ParseErrorCode | undefined,
  parserId: r.parser_id ?? undefined,
  parsedChars: r.parsed_chars ?? undefined,
  pageCount: r.page_count ?? undefined,
  rawPath: r.raw_path,
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

/**
 * A stored `all_tools`.
 *
 * `null` is a row written before the column existed, and `v !== 0` is true for it — which is
 * the correct reading, because an absent flag has to mean "every tool": that is what an empty
 * tool list meant before the flag existed, and the migration's default says the same thing.
 */
const asAllTools = (v: number | null): boolean => v !== 0;

/**
 * The stored tool pair, with the flag made authoritative.
 *
 * `allTools` wins, and the list is dropped when it does, so a row cannot be left holding a
 * selection nothing consults. Readers derive from the flag as well — this is what keeps the
 * database free of the contradictory state rather than merely tolerant of it.
 */
const storeTools = (input: { allTools: boolean; tools: string[] }): {
  allTools: number;
  tools: string;
} =>
  input.allTools
    ? { allTools: 1, tools: "[]" }
    : { allTools: 0, tools: JSON.stringify(input.tools) };

const mapCopilot = (r: CopilotRow): Copilot => ({
  id: r.id,
  // Unreachable in practice: every query that can return a row names the owner in its `WHERE`
  // (`user_id = ?` or `visibility = 'public'`), and an ownerless row matches neither.
  userId: r.user_id ?? "",
  ownerName: r.owner_name ?? undefined,
  name: r.name,
  description: r.description,
  systemPrompt: r.system_prompt,
  allTools: asAllTools(r.all_tools),
  tools: safeParseArray<string>(r.tools),
  settings: safeParseObject<CopilotDefaults>(r.settings),
  // `null` is "never set" and resolves to the defaults; an array (including `[]`) is a decision.
  // An id this build does not know is dropped rather than handed on, because a reader derives
  // from the registry — the same move `all_tools` makes against a stale `tools` list.
  widgets:
    r.widgets === null
      ? [...DEFAULT_WIDGET_IDS]
      : safeParseArray<string>(r.widgets).filter(isWidgetId),
  visibility: r.visibility === "public" ? "public" : "private",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapSession = (r: SessionRow): Session => ({
  id: r.id,
  workspaceId: r.workspace_id,
  copilotId: r.copilot_id,
  copilotName: r.copilot_name ?? "",
  systemPrompt: r.system_prompt ?? "",
  allTools: asAllTools(r.all_tools),
  tools: safeParseArray<string>(r.tools),
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
  stopped: r.stopped ? true : undefined,
  createdAt: r.created_at,
});

const mapPlan = (r: PlanRow): PlanRecord => ({
  id: r.id,
  sessionId: r.session_id,
  version: r.version,
  status: r.status as PlanStatus,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapPlanNode = (r: PlanNodeRow): PlanNodeRecord => ({
  id: r.id,
  planId: r.plan_id,
  parentId: r.parent_id,
  position: r.position,
  title: r.title,
  status: r.status as PlanNodeStatus,
  introducedVersion: r.introduced_version,
  removedVersion: r.removed_version,
  anchorToolCallId: r.done_tool_call_id,
  anchorAt: r.done_at,
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
 * One message's usage, or `null` when the column held nothing.
 *
 * `null` and `{}` are different answers, and the difference is load-bearing for the statistics:
 * those count messages by their entries in an array, so a message with no usage has to arrive as
 * `null` rather than as a zeroed object — otherwise a user message and a turn the user stopped
 * would both look like turns that recorded figures.
 *
 * A column holding *malformed* JSON is the tolerant case and parses to `{}`, which sums to zero
 * and is what a damaged row should contribute.
 */
function parseUsage(json: string | null): MessageUsage | null {
  return json ? safeParseObject<MessageUsage>(json) : null;
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

  /*
   * Sources — uploaded files, owned by the account rather than by the conversation they
   * arrived in. Same `ForUser` discipline as everything below, and it matters more here than
   * anywhere: these rows carry a path, so a lookup that forgot the owner would not merely
   * leak a name, it would hand over a file.
   */

  /**
   * The account's copy of these bytes, if it has one.
   *
   * Scoped by owner *and* hash, not by hash alone. `WHERE sha256 = ?` would hand one
   * account's file to another who happened to upload the same content — which is exactly the
   * case dedupe makes common, since the whole point is that identical bytes are one row.
   */
  findSourceByHash(userId: string, sha256: string): SourceRecord | undefined;
  getSourceForUser(id: string, userId: string): SourceRecord | undefined;
  listSourcesForUser(userId: string): SourceRecord[];
  createSource(input: {
    id: string;
    userId: string;
    sha256: string;
    name: string;
    mimeType: string;
    size: number;
    kind: "image" | "file";
    rawPath: string;
  }): SourceRecord;
  /** Returns false when no such source existed, or it belonged to someone else. */
  deleteSourceForUser(id: string, userId: string): boolean;

  /**
   * Record what a parse did, in place.
   *
   * In place rather than appended, because the row is what every reader consults: a reparse
   * is then reflected in every conversation at once, instead of only in the messages sent
   * after it. The alternative — folding state into each message at the time it was written —
   * is what made a reparse invisible to history.
   */
  updateSourceParse(
    id: string,
    userId: string,
    patch: {
      status: ParseStatus;
      error?: string | null;
      code?: ParseErrorCode | null;
      parserId?: string | null;
      parsedChars?: number | null;
      pageCount?: number | null;
    }
  ): void;

  /**
   * Reference a source from a session or a workspace.
   *
   * The statement asserts **both** ends in one `INSERT … SELECT`, so a cross-account link is
   * unrepresentable rather than merely unwritten — the same defensive move as the scoped
   * readers, for the case where a future caller forgets to check. Returns whether a row was
   * inserted, so `false` covers both "not yours" and "already linked"; a route that needs to
   * tell them apart resolves both ends itself first, which it has to do anyway to answer 404.
   */
  linkSourceToSession(userId: string, sessionId: string, sourceId: string): boolean;
  linkSourceToWorkspace(userId: string, workspaceId: string, sourceId: string): boolean;

  /** A conversation's own sources, for the parse-state the composer polls. */
  listSessionSources(userId: string, sessionId: string): SourceRecord[];
  /**
   * Everything the model may read in one conversation: its own sources plus its workspace's.
   *
   * The union is the widening this change is about — a document uploaded in one conversation
   * is readable from another in the same workspace — and it is deliberately a *query* rather
   * than a snapshot, so unlinking takes effect on the next turn. A workspace is already a
   * shared sandbox (every session in it can `read_file` the same tree), so a document there
   * is not more privileged than a file there; this rests on a workspace never being shared
   * between accounts, which the scoping here is what enforces.
   */
  listReadableSources(userId: string, sessionId: string, workspaceId: string): SourceRecord[];

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

  /*
   * Copilots are owned. The two *reads* below take the wider predicate — the account's own
   * Copilots plus every public one — while the two *writes* take the narrower one and are
   * owner-only. That asymmetry is the whole policy, and it is why neither write is expressed by
   * looking a row up and then comparing its owner: that check is one somebody eventually forgets
   * on a new route, and the failure is another account's data rather than an error.
   */
  /** Own or public, and owned by someone — everything this account may see. */
  listCopilotsForUser(userId: string): Copilot[];
  /**
   * Everything this account may *use*: its own, or a public one that has an owner.
   *
   * Not an ownership check. `undefined` covers both "no such Copilot" and "someone else's
   * private one", because a route turns both into a 404 and an id cannot be probed.
   */
  getCopilotForUser(id: string, userId: string): Copilot | undefined;
  /**
   * `id = ? AND user_id = ?` — the *owned* set, for a caller that needs a Copilot's current
   * values in order to patch them.
   *
   * A separate accessor rather than "read it, then compare its owner": that comparison is the
   * check that gets forgotten on a new route, and the failure is another account's data rather
   * than an error. Here the owner is in the `WHERE`, so there is nothing to remember.
   */
  getOwnedCopilot(id: string, userId: string): Copilot | undefined;
  createCopilot(input: {
    id: string;
    userId: string;
    name: string;
    description: string;
    systemPrompt: string;
    /** Authoritative over `tools`, which is stored empty when this is true. */
    allTools: boolean;
    tools: string[];
    settings: CopilotDefaults;
    /**
     * Widgets a conversation started from this Copilot installs, at session scope.
     *
     * Required here rather than optional, matching the rest of this input: the *route* decides
     * what "absent" means (leave the stored value alone) and passes the resolved list, so this
     * layer only ever writes a decision.
     */
    widgets: WidgetId[];
    visibility: CopilotVisibility;
  }): Copilot;
  /** Owner-only (`id = ? AND user_id = ?`). `undefined` for a Copilot someone else owns. */
  updateCopilotForUser(
    id: string,
    userId: string,
    input: {
      name: string;
      description: string;
      systemPrompt: string;
      allTools: boolean;
      tools: string[];
      settings: CopilotDefaults;
      widgets: WidgetId[];
      visibility: CopilotVisibility;
    }
  ): Copilot | undefined;
  /** Owner-only. Returns false when no such Copilot existed, or it belonged to someone else. */
  deleteCopilotForUser(id: string, userId: string): boolean;

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
  /**
   * The Copilot fields are a snapshot the caller supplies, not a reference this resolves: the
   * route has already read the Copilot through `getCopilotForUser`, and copying here is what
   * makes the conversation independent of it. Pass empty values for a Copilotless session.
   */
  createSession(input: {
    id: string;
    workspaceId: string;
    copilotId: string | null;
    copilotName: string;
    systemPrompt: string;
    /** Authoritative over `tools`, which is stored empty when this is true. */
    allTools: boolean;
    tools: string[];
    title: string;
    settings?: SessionSettings;
  }): Session;
  /**
   * A supplied `title` also marks the session as user-titled, which stops the
   * auto-titler from ever overwriting it. Settings-only updates leave the flag alone.
   *
   * `systemPrompt`, `allTools` and `tools` are the conversation's own persona, editable
   * independently of the Copilot it was copied from — that is the point of snapshotting rather
   * than referencing. Absent `allTools` leaves the stored flag alone; present, it wins over
   * `tools` and clears the stored list.
   */
  updateSessionForUser(
    id: string,
    userId: string,
    input: {
      title?: string;
      settings?: SessionSettings;
      systemPrompt?: string;
      allTools?: boolean;
      tools?: string[];
    }
  ): Session | undefined;
  /** Replace the title on behalf of the auto-titler, keeping `titleSource: "auto"`. */
  setAutoTitleForUser(id: string, userId: string, title: string): Session | undefined;
  /** Returns false when no such session existed, or it belonged to someone else. */
  deleteSessionForUser(id: string, userId: string): boolean;

  /*
   * The session-id-only accessors below — `touchSession`, and `createMessage`,
   * `findAwaitingToolCall`, `updateMessageToolCalls` and `skipAwaitingToolCalls` further
   * down — take an id and nothing else on purpose. Every caller reaches them *after* a
   * `...ForUser` read has
   * resolved the session, so they act by primary key on a path that is already guarded, and
   * a second join here would buy nothing at the cost of a query on every turn. This is the
   * one deliberate asymmetry in the scoping: a comment rather than a signature, because the
   * guard is genuinely upstream rather than merely inconvenient here.
   */
  touchSession(id: string): void;

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
    /** The user cut this turn short; `content` is whatever had streamed by then. */
    stopped?: boolean;
  }): Message;

  /**
   * Find a suspended call by the tool-call id the client sent back, with the id of the
   * message holding it.
   *
   * Scoped to one session rather than looked up by tool-call id alone, because the id
   * comes from the client and a bare lookup would let one session answer another's
   * question. Returns undefined once the call is no longer `awaiting` — which is what
   * makes a repeat submission a 409 rather than a silent overwrite. Name-agnostic: which
   * tool suspends, and how its answer is read, is the registry's business.
   */
  findAwaitingToolCall(
    sessionId: string,
    toolCallId: string
  ): { messageId: string; call: ToolCall } | undefined;

  /** Write a message's whole `toolCalls` array back, after an answer was filled in. */
  updateMessageToolCalls(messageId: string, toolCalls: ToolCall[]): void;

  /**
   * Retire every still-awaiting call in a session, returning how many.
   *
   * Called when the user sends a new message instead of answering: the turn those
   * questions belonged to is over, and a card that stayed answerable would resume a
   * conversation the user has already moved on from.
   */
  skipAwaitingToolCalls(sessionId: string): number;

  /**
   * Reserve `count` consecutive numbers from one sequence, returned in ascending order.
   *
   * A sequence is named by all three of `scope`, `scope_id` and `name` — the caller says
   * what kind of thing it is counting against, which one, and what is being counted — so
   * two sequences cannot collide by accident and neither needs a schema of its own.
   */
  reserveCounter(scope: string, scopeId: string, name: string, count: number): number[];

  /*
   * Widgets.
   *
   * The reads return the **resolved** list — one entry per widget the registry knows at that
   * level, with `enabled` already settled — rather than the stored rows, because a stored row
   * and a defaulted row must not be distinguishable at a call site. That resolution is the whole
   * reason `widget_instances` can hold only decisions.
   *
   * Rows are never deleted by anything here. An uninstall is `setWidgetEnabled(…, false)`.
   */
  listWorkspaceWidgetsForUser(userId: string, workspaceId: string): WidgetState[];
  listSessionWidgetsForUser(userId: string, sessionId: string): WidgetState[];
  /**
   * Record a decision, upserting. Returns false when the object is not the caller's — a foreign
   * id inserts nothing, which is the same answer a missing one gives.
   *
   * A caller reaching this has already read the object for its 404; the statement's own owner
   * check is the guarantee that survives someone removing that read.
   */
  setWorkspaceWidgetForUser(
    userId: string,
    workspaceId: string,
    widgetId: WidgetId,
    enabled: boolean
  ): boolean;
  setSessionWidgetForUser(
    userId: string,
    sessionId: string,
    widgetId: WidgetId,
    enabled: boolean
  ): boolean;

  /*
   * Plans (the plan widget). One per session; ownership is reached through the session's
   * workspace like everything else. The `ForUser` pair is what the routes read; the
   * session-id-only accessors below run inside a turn whose session was already resolved
   * `ForUser`, with a session id the server bound (the plan tools never accept one from the
   * model) — the same documented exception `touchSession` and the message-id accessors use.
   */
  getPlanForSessionForUser(userId: string, sessionId: string): PlanRecord | undefined;
  /** Unscoped session lookup — server-bound session id on an already-resolved turn only. */
  getPlanBySession(sessionId: string): PlanRecord | undefined;
  insertPlan(input: {
    id: string;
    sessionId: string;
    version: number;
    status: PlanStatus;
    createdAt: string;
    updatedAt: string;
  }): PlanRecord;
  /** Write the new status alongside the version bump. Returns the new version number. */
  bumpPlanVersion(planId: string, status: PlanStatus, updatedAt: string): number;
  setPlanStatus(planId: string, status: PlanStatus, updatedAt: string): void;
  insertPlanVersion(input: {
    id: string;
    planId: string;
    version: number;
    treeJson: string;
    createdAt: string;
  }): void;
  listPlanVersions(planId: string): PlanVersionRecord[];
  getPlanVersionForUser(
    userId: string,
    sessionId: string,
    version: number
  ): PlanVersionData | undefined;
  listPlanNodes(planId: string): PlanNodeRecord[];
  insertPlanNode(input: PlanNodeInsert): void;
  updatePlanNodeStructure(input: {
    id: string;
    planId: string;
    parentId: string | null;
    position: number;
    title: string;
  }): void;
  /** Turn a node into a tombstone: `deleted`, last parent/position frozen. */
  softDeletePlanNode(planId: string, nodeId: string, removedVersion: number): void;
  updatePlanNodeProgress(
    planId: string,
    nodeId: string,
    status: PlanNodeStatus,
    anchorToolCallId: string | null,
    anchorAt: string | null
  ): void;

  /** Per-conversation message counts and summed usage for one workspace, newest first. */
  statsForWorkspace(userId: string, workspaceId: string): WorkspaceStats | undefined;
  /** The same numbers for one conversation. `undefined` when it is not the caller's. */
  statsForSessionForUser(userId: string, sessionId: string): SessionStats | undefined;

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

  // Columns added since `messages` was first written. `applySchema` is `CREATE TABLE IF NOT
  // EXISTS`, so a database that already has the table never gains them from the DDL alone —
  // which is exactly the gap `ensureColumn` exists to close. Nothing to backfill, so the
  // return value is ignored.
  ensureColumn(db, "messages", "stopped", "stopped INTEGER NOT NULL DEFAULT 0");

  /*
   * Copilots became owned and publishable, and a conversation now snapshots the Copilot it was
   * started from instead of re-reading it every turn.
   *
   * `user_id` carries no default on purpose — see the note in `schema.ts`. Every read names the
   * owner in its `WHERE`, so an ownerless row is matched by nothing and goes missing rather
   * than being handed to whoever asked.
   */
  const copilotOwnerAdded = ensureColumn(
    db,
    "copilots",
    "user_id",
    "user_id TEXT REFERENCES users(id) ON DELETE CASCADE"
  );
  ensureColumn(db, "copilots", "visibility", "visibility TEXT NOT NULL DEFAULT 'private'");
  // Defaulting to 1 preserves the meaning those rows already had: an empty tools list used to
  // mean "every tool", and it still does wherever all_tools is set.
  ensureColumn(db, "copilots", "all_tools", "all_tools INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "sessions", "copilot_name", "copilot_name TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "sessions", "system_prompt", "system_prompt TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "sessions", "all_tools", "all_tools INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "sessions", "tools", "tools TEXT NOT NULL DEFAULT '[]'");
  // No `NOT NULL` and no default, unlike its neighbours above, and the difference is deliberate:
  // those columns were given a default that *preserved* the meaning their rows already had, and
  // there is no such value here. `'[]'` would read as "this Copilot installs nothing" for every
  // Copilot written before the column existed — a decision nobody made, silently narrowing
  // conversations that were never re-edited. NULL means "never set", which resolves to the
  // defaults in `mapCopilot`, so an untouched Copilot behaves exactly as it did before.
  ensureColumn(db, "copilots", "widgets", "widgets TEXT");

  /*
   * The one-off that `ensureColumn`'s return value exists for, and it runs on the single boot
   * that gives Copilots an owner.
   *
   * Rows written before that column have no owner and no way to infer one, so they are dropped
   * rather than guessed at. `foreign_keys` is ON, so this fires `sessions.copilot_id`'s
   * `ON DELETE SET NULL` and no conversation is removed. Two consequences are worth knowing and
   * are the reason this comment is long:
   *
   * - A conversation keeps its copied generation `settings` but loses its Copilot's persona,
   *   falling back to the built-in system prompt.
   * - A conversation that was running under a **tool-restricted** Copilot becomes unrestricted,
   *   because its snapshot is empty and an empty allowlist reads as "all tools". That widening
   *   is real; it is accepted here because the alternative was refusing the database outright.
   */
  if (copilotOwnerAdded) db.exec("DELETE FROM copilots");

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

  /* -------------------------------- sources -------------------------------- */
  const stmtFindSourceByHash = db.prepare(
    "SELECT * FROM sources WHERE user_id = ? AND sha256 = ?"
  );
  const stmtGetSourceForUser = db.prepare("SELECT * FROM sources WHERE id = ? AND user_id = ?");
  const stmtListSourcesForUser = db.prepare(
    "SELECT * FROM sources WHERE user_id = ? ORDER BY created_at ASC"
  );
  const stmtCreateSource = db.prepare(
    `INSERT INTO sources
       (id, user_id, sha256, name, mime_type, size, kind, raw_path, parse_status, created_at)
     VALUES (@id, @userId, @sha256, @name, @mimeType, @size, @kind, @rawPath, 'none', @createdAt)`
  );
  const stmtDeleteSourceForUser = db.prepare("DELETE FROM sources WHERE id = ? AND user_id = ?");
  const stmtUpdateSourceParse = db.prepare(
    `UPDATE sources
        SET parse_status = @status, parse_error = @error, parse_error_code = @code,
            parser_id = @parserId, parsed_chars = @parsedChars, page_count = @pageCount,
            parse_updated_at = @updatedAt
      WHERE id = @id AND user_id = @userId`
  );
  /*
   * Both links assert their two owners in one statement. `INSERT OR IGNORE` because
   * re-uploading the same bytes into the same conversation is normal, and the link it would
   * duplicate is already exactly right.
   */
  const stmtLinkSourceToSession = db.prepare(
    `INSERT OR IGNORE INTO session_sources (session_id, source_id, created_at)
     SELECT s.id, src.id, @createdAt
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
       JOIN sources src ON src.id = @sourceId
      WHERE s.id = @sessionId AND w.user_id = @userId AND src.user_id = @userId`
  );
  const stmtLinkSourceToWorkspace = db.prepare(
    `INSERT OR IGNORE INTO workspace_sources (workspace_id, source_id, created_at)
     SELECT w.id, src.id, @createdAt
       FROM workspaces w
       JOIN sources src ON src.id = @sourceId
      WHERE w.id = @workspaceId AND w.user_id = @userId AND src.user_id = @userId`
  );
  /*
   * The read whitelist: the conversation's own sources unioned with its workspace's. Reached
   * through the session so the owner check happens once, on the join that every arm shares.
   */
  const stmtListSessionSources = db.prepare(
    `SELECT src.* FROM session_sources ss
       JOIN sources src ON src.id = ss.source_id
       JOIN sessions s ON s.id = ss.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE ss.session_id = ? AND w.user_id = ?
      ORDER BY ss.created_at ASC, src.id ASC`
  );
  /*
   * `UNION ALL` under an explicit `MIN(linked_at)`, not a bare `UNION`.
   *
   * An upload links a source to the conversation *and* to its workspace, as two rows written
   * by two separate `now()` calls. A `UNION` dedupes whole rows, so it collapsed these two
   * arms only while the timestamps happened to agree to the millisecond — and the moment they
   * did not, the same file came back twice, which is one file rendering as two chips. The
   * union was never what made a source appear once; the id was. Collapsing on it and keeping
   * the earliest link is what the ordering always meant, and it is the only version of this
   * that cannot return one file twice.
   */
  const stmtListReadableSources = db.prepare(
    `SELECT src.*, arm.linked_at FROM (
       SELECT source_id, MIN(linked_at) AS linked_at FROM (
         SELECT ss.source_id AS source_id, ss.created_at AS linked_at FROM session_sources ss
           JOIN sessions s ON s.id = ss.session_id
           JOIN workspaces w ON w.id = s.workspace_id
          WHERE ss.session_id = @sessionId AND w.user_id = @userId
         UNION ALL
         SELECT ws.source_id AS source_id, ws.created_at AS linked_at FROM workspace_sources ws
           JOIN workspaces w2 ON w2.id = ws.workspace_id
          WHERE ws.workspace_id = @workspaceId AND w2.user_id = @userId
       ) GROUP BY source_id
     ) arm
     JOIN sources src ON src.id = arm.source_id
     ORDER BY arm.linked_at ASC, src.id ASC`
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
  /*
   * All three reads share one `SELECT`, so the owner name can never be missing from a row that
   * needs it. The two predicates are the policy, spelled out in the `WHERE` rather than applied
   * afterwards: own-or-public is the *usable* set, `user_id = ?` alone is the *owned* set, and
   * the writes below take only the second.
   *
   * `user_id IS NOT NULL` is not decoration. A Copilot with no owner can only come from a bug or
   * a database predating ownership, and the disjunction alone would still hand one over if it
   * happened to be marked public — `visibility = 'public'` is true however absent the owner is.
   * Requiring an owner is what makes "a forgotten owner goes missing rather than leaking" a
   * statement about this SQL rather than an intention.
   */
  const copilotSelect = `SELECT c.*, u.username AS owner_name FROM copilots c
     LEFT JOIN users u ON u.id = c.user_id`;
  const stmtListCopilotsForUser = db.prepare(
    `${copilotSelect} WHERE c.user_id IS NOT NULL AND (c.user_id = ? OR c.visibility = 'public')
     ORDER BY c.created_at ASC`
  );
  const stmtGetCopilotForUser = db.prepare(
    `${copilotSelect} WHERE c.id = ? AND c.user_id IS NOT NULL
       AND (c.user_id = ? OR c.visibility = 'public')`
  );
  const stmtGetOwnedCopilot = db.prepare(`${copilotSelect} WHERE c.id = ? AND c.user_id = ?`);
  const stmtCreateCopilot = db.prepare(
    `INSERT INTO copilots (id, user_id, name, description, system_prompt, all_tools, tools, settings, widgets, visibility, created_at, updated_at)
     VALUES (@id, @userId, @name, @description, @systemPrompt, @allTools, @tools, @settings, @widgets, @visibility, @createdAt, @updatedAt)`
  );
  /*
   * `AND user_id = @userId` is redundant with the owned read the accessor does first, and kept
   * anyway: it is the statement that would still be correct if that read were ever removed.
   */
  const stmtUpdateCopilotForUser = db.prepare(
    `UPDATE copilots SET name = @name, description = @description, system_prompt = @systemPrompt,
     all_tools = @allTools, tools = @tools, settings = @settings, widgets = @widgets,
     visibility = @visibility, updated_at = @updatedAt
     WHERE id = @id AND user_id = @userId`
  );
  const stmtDeleteCopilotForUser = db.prepare("DELETE FROM copilots WHERE id = ? AND user_id = ?");

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
    `INSERT INTO sessions (id, workspace_id, copilot_id, copilot_name, system_prompt, all_tools,
       tools, title, title_source, settings, created_at, updated_at)
     VALUES (@id, @workspaceId, @copilotId, @copilotName, @systemPrompt, @allTools,
       @tools, @title, @titleSource, @settings, @createdAt, @updatedAt)`
  );
  const stmtUpdateSessionForUser = db.prepare(
    `UPDATE sessions SET title = @title, title_source = @titleSource, settings = @settings,
       system_prompt = @systemPrompt, all_tools = @allTools, tools = @tools,
       updated_at = @updatedAt
      WHERE id = @id AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = @userId)`
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
    `INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, attachments, usage, stopped, created_at)
     VALUES (@id, @sessionId, @role, @content, @reasoning, @toolCalls, @attachments, @usage, @stopped, @createdAt)`
  );
  const stmtUpdateToolCalls = db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?");

  /* ------------------------------- counters ------------------------------- */
  /**
   * Reserve a block from one counter, returning the highest number issued.
   *
   * An upsert rather than the `SELECT max(…) + 1` this file uses for provider ordering
   * (`stmtNextProviderOrder`), and the difference is not a preference: that one reads and
   * then writes, which is a race between two callers, whereas this is a single statement
   * and therefore atomic on its own. `excluded.value` is the `count` from the INSERT arm,
   * so the conflicting arm adds the whole block rather than one.
   */
  const stmtReserveCounter = db.prepare(
    `INSERT INTO counters (scope, scope_id, name, value) VALUES (?, ?, ?, ?)
     ON CONFLICT (scope, scope_id, name) DO UPDATE SET value = value + excluded.value
     RETURNING value`
  );

  /* ------------------------------- widgets -------------------------------- */
  /*
   * The owner is reached through the object the row hangs off — a workspace directly, a session
   * through its workspace — which is how `sessions` reaches its owner too. Every statement below
   * asserts it in the SQL rather than leaving it to the caller to have checked first: the read
   * that a route does for its 404 and the write's own `WHERE` are two independent guarantees,
   * and the second is the one that still holds if someone removes the first.
   */
  const stmtWorkspaceWidgetRowsForUser = db.prepare(
    `SELECT wi.widget_id, wi.enabled FROM widget_instances wi
       JOIN workspaces w ON w.id = @scopeId
      WHERE wi.scope = 'workspace' AND wi.scope_id = @scopeId AND w.user_id = @userId`
  );
  const stmtSessionWidgetRowsForUser = db.prepare(
    `SELECT wi.widget_id, wi.enabled FROM widget_instances wi
       JOIN sessions s ON s.id = @scopeId
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE wi.scope = 'session' AND wi.scope_id = @scopeId AND w.user_id = @userId`
  );
  /*
   * An upsert, so install / uninstall / install on the same pair is one row rather than a
   * duplicate-key error, and so `created_at` keeps the first decision's timestamp while
   * `updated_at` moves. `SELECT … FROM <owner>` is what makes the owner part of the write: a
   * foreign id inserts nothing, and `changes` then reports 0.
   */
  const stmtSetWorkspaceWidgetForUser = db.prepare(
    `INSERT INTO widget_instances (scope, scope_id, widget_id, enabled, created_at, updated_at)
     SELECT 'workspace', w.id, @widgetId, @enabled, @now, @now FROM workspaces w
      WHERE w.id = @scopeId AND w.user_id = @userId
     ON CONFLICT (scope, scope_id, widget_id)
       DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  );
  const stmtSetSessionWidgetForUser = db.prepare(
    `INSERT INTO widget_instances (scope, scope_id, widget_id, enabled, created_at, updated_at)
     SELECT 'session', s.id, @widgetId, @enabled, @now, @now
       FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = @scopeId AND w.user_id = @userId
     ON CONFLICT (scope, scope_id, widget_id)
       DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`
  );

  /* --------------------------------- plans -------------------------------- */
  /*
   * The plan's owner is reached through plans → sessions → workspaces, so the ForUser reads
   * carry that join. `stmtGetPlanBySession` deliberately does not: the plan tools run with a
   * server-bound session id on an already-resolved turn, the same exception the bare
   * `stmtGetSession` exists for.
   */
  const stmtGetPlanForSessionForUser = db.prepare(
    `SELECT p.* FROM plans p
       JOIN sessions s ON s.id = p.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE p.session_id = @sessionId AND w.user_id = @userId`
  );
  const stmtGetPlanBySession = db.prepare("SELECT * FROM plans WHERE session_id = ?");
  const stmtInsertPlan = db.prepare(
    `INSERT INTO plans (id, session_id, version, status, created_at, updated_at)
     VALUES (@id, @sessionId, @version, @status, @createdAt, @updatedAt)`
  );
  const stmtBumpPlanVersion = db.prepare(
    `UPDATE plans SET version = version + 1, status = @status, updated_at = @updatedAt
     WHERE id = @id RETURNING version`
  );
  const stmtSetPlanStatus = db.prepare(
    "UPDATE plans SET status = @status, updated_at = @updatedAt WHERE id = @id"
  );
  const stmtInsertPlanVersion = db.prepare(
    `INSERT INTO plan_versions (id, plan_id, version, tree_json, created_at)
     VALUES (@id, @planId, @version, @treeJson, @createdAt)`
  );
  const stmtListPlanVersions = db.prepare(
    "SELECT version, created_at FROM plan_versions WHERE plan_id = ? ORDER BY version ASC"
  );
  const stmtGetPlanVersionForUser = db.prepare(
    `SELECT pv.version, pv.created_at, pv.tree_json FROM plan_versions pv
       JOIN plans p ON p.id = pv.plan_id
       JOIN sessions s ON s.id = p.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE p.session_id = @sessionId AND pv.version = @version AND w.user_id = @userId`
  );
  const stmtListPlanNodes = db.prepare(
    "SELECT * FROM plan_nodes WHERE plan_id = ? ORDER BY introduced_version ASC, rowid ASC"
  );
  const stmtInsertPlanNode = db.prepare(
    `INSERT INTO plan_nodes
       (id, plan_id, parent_id, position, title, status, introduced_version, removed_version,
        done_tool_call_id, done_at)
     VALUES (@id, @planId, @parentId, @position, @title, @status, @introducedVersion,
             @removedVersion, @doneToolCallId, @doneAt)`
  );
  const stmtUpdatePlanNodeStructure = db.prepare(
    `UPDATE plan_nodes SET parent_id = @parentId, position = @position, title = @title
     WHERE id = @id AND plan_id = @planId`
  );
  // No parent/position write here on purpose: a tombstone keeps its last place so the current
  // view can strike it through where it used to be.
  const stmtSoftDeletePlanNode = db.prepare(
    `UPDATE plan_nodes SET removed_version = @removedVersion, status = 'deleted'
     WHERE id = @id AND plan_id = @planId`
  );
  const stmtUpdatePlanNodeProgress = db.prepare(
    `UPDATE plan_nodes SET status = @status, done_tool_call_id = @doneToolCallId, done_at = @doneAt
     WHERE id = @id AND plan_id = @planId`
  );

  /*
   * Two narrow projections for the statistics: the role (so a count can tell the two apart if it
   * ever wants to) and the usage blob. `usage` is read whole and parsed in `widgets.ts` rather
   * than summed here — see the note on `sumUsage` for why the arithmetic is not in SQL.
   *
   * Ordered ascending by `created_at`, because `contextTokens` is the *last* turn's figure and
   * "last" has to mean the same thing to the query as it does to the reader.
   */
  const stmtSessionUsageRows = db.prepare(
    `SELECT m.role, m.usage FROM messages m WHERE m.session_id = ? ORDER BY m.created_at ASC`
  );
  const stmtWorkspaceUsageRows = db.prepare(
    `SELECT m.session_id, m.role, m.usage FROM messages m
       JOIN sessions s ON s.id = m.session_id
      WHERE s.workspace_id = ? ORDER BY m.created_at ASC`
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

    findSourceByHash(userId, sha256) {
      const r = stmtFindSourceByHash.get(userId, sha256) as SourceRow | undefined;
      return r ? mapSource(r) : undefined;
    },
    getSourceForUser(id, userId) {
      const r = stmtGetSourceForUser.get(id, userId) as SourceRow | undefined;
      return r ? mapSource(r) : undefined;
    },
    listSourcesForUser(userId) {
      return (stmtListSourcesForUser.all(userId) as SourceRow[]).map(mapSource);
    },
    createSource(input) {
      stmtCreateSource.run({ ...input, createdAt: now() });
      const r = stmtGetSourceForUser.get(input.id, input.userId) as SourceRow;
      return mapSource(r);
    },
    deleteSourceForUser(id, userId) {
      return stmtDeleteSourceForUser.run(id, userId).changes > 0;
    },
    updateSourceParse(id, userId, patch) {
      stmtUpdateSourceParse.run({
        id,
        userId,
        status: patch.status,
        error: patch.error ?? null,
        code: patch.code ?? null,
        parserId: patch.parserId ?? null,
        parsedChars: patch.parsedChars ?? null,
        pageCount: patch.pageCount ?? null,
        updatedAt: now(),
      });
    },
    linkSourceToSession(userId, sessionId, sourceId) {
      return (
        stmtLinkSourceToSession.run({ userId, sessionId, sourceId, createdAt: now() }).changes > 0
      );
    },
    linkSourceToWorkspace(userId, workspaceId, sourceId) {
      return (
        stmtLinkSourceToWorkspace.run({ userId, workspaceId, sourceId, createdAt: now() })
          .changes > 0
      );
    },
    listSessionSources(userId, sessionId) {
      return (stmtListSessionSources.all(sessionId, userId) as SourceRow[]).map(mapSource);
    },
    listReadableSources(userId, sessionId, workspaceId) {
      return (
        stmtListReadableSources.all({ userId, sessionId, workspaceId }) as SourceRow[]
      ).map(mapSource);
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

    listCopilotsForUser(userId) {
      return (stmtListCopilotsForUser.all(userId) as CopilotRow[]).map(mapCopilot);
    },
    getCopilotForUser(id, userId) {
      const r = stmtGetCopilotForUser.get(id, userId) as CopilotRow | undefined;
      return r ? mapCopilot(r) : undefined;
    },
    getOwnedCopilot(id, userId) {
      const r = stmtGetOwnedCopilot.get(id, userId) as CopilotRow | undefined;
      return r ? mapCopilot(r) : undefined;
    },
    createCopilot(input) {
      /*
       * Refused rather than written.
       *
       * `undefined` binds as SQL NULL in silence — only a *missing* key throws — and the column
       * is nullable because the migration that adds it must be. So a caller that had lost the
       * owner would get a row that every read then refuses: invisible to its own author, with
       * nothing logged anywhere to say why. That is a genuinely confusing failure to debug from
       * the outside, and it has happened once. Failing here instead names the cause.
       */
      if (!input.userId) throw new Error("createCopilot: a Copilot must have an owner");
      const ts = now();
      stmtCreateCopilot.run({
        ...input,
        ...storeTools(input),
        settings: JSON.stringify(input.settings),
        widgets: JSON.stringify(input.widgets),
        createdAt: ts,
        updatedAt: ts,
      });
      const r = stmtGetOwnedCopilot.get(input.id, input.userId) as CopilotRow;
      return mapCopilot(r);
    },
    updateCopilotForUser(id, userId, input) {
      // Two independent owner checks, for two different reasons: the read decides the return
      // value, and the statement's own `AND user_id` is the one that would still hold if someone
      // later removed the read.
      if (!stmtGetOwnedCopilot.get(id, userId)) return undefined;
      stmtUpdateCopilotForUser.run({
        id,
        userId,
        ...input,
        ...storeTools(input),
        settings: JSON.stringify(input.settings),
        widgets: JSON.stringify(input.widgets),
        updatedAt: now(),
      });
      const r = stmtGetOwnedCopilot.get(id, userId) as CopilotRow;
      return mapCopilot(r);
    },
    deleteCopilotForUser(id, userId) {
      return stmtDeleteCopilotForUser.run(id, userId).changes > 0;
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
        ...storeTools(input),
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
      const settings = input.settings
        ? { ...safeParseObject<SessionSettings>(existing.settings), ...input.settings }
        : safeParseObject<SessionSettings>(existing.settings);

      // A conversation's persona is its own once created, so these are plain assignments with no
      // fallback to the Copilot — the Copilot is not consulted again after this. `allTools` set
      // here wins over the supplied list and clears it, exactly as on the write paths above.
      const stored = storeTools({
        allTools: input.allTools ?? asAllTools(existing.all_tools),
        tools: input.tools ?? safeParseArray<string>(existing.tools),
      });

      stmtUpdateSessionForUser.run({
        id,
        userId,
        title: renamed ? input.title!.trim() : existing.title,
        titleSource: renamed ? "user" : existing.title_source ?? "auto",
        settings: JSON.stringify(settings),
        systemPrompt: input.systemPrompt ?? existing.system_prompt ?? "",
        ...stored,
        updatedAt: now(),
      });
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
        stopped: input.stopped ? 1 : 0,
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

    reserveCounter(scope, scopeId, name, count) {
      // Returning before the statement is what keeps an empty block from writing a row: a
      // counter at 0 for something that never asked for a number is a row nothing can use.
      if (count <= 0) return [];
      const row = stmtReserveCounter.get(scope, scopeId, name, count) as { value: number };
      // `value` is the *last* number in the block, so the block is counted back from it.
      const end = row.value;
      return Array.from({ length: count }, (_, i) => end - count + i + 1);
    },

    listWorkspaceWidgetsForUser(userId, workspaceId) {
      const rows = stmtWorkspaceWidgetRowsForUser.all({
        userId,
        scopeId: workspaceId,
      }) as WidgetRow[];
      // An empty set is also what a foreign workspace id produces, which is correct here: the
      // caller's 404 comes from its own scoped read, and this is not the layer that decides it.
      return resolveWidgetStates("workspace", rows);
    },
    listSessionWidgetsForUser(userId, sessionId) {
      const rows = stmtSessionWidgetRowsForUser.all({
        userId,
        scopeId: sessionId,
      }) as WidgetRow[];
      return resolveWidgetStates("session", rows);
    },
    setWorkspaceWidgetForUser(userId, workspaceId, widgetId, enabled) {
      return (
        stmtSetWorkspaceWidgetForUser.run({
          userId,
          scopeId: workspaceId,
          widgetId,
          enabled: enabled ? 1 : 0,
          now: now(),
        }).changes > 0
      );
    },
    setSessionWidgetForUser(userId, sessionId, widgetId, enabled) {
      return (
        stmtSetSessionWidgetForUser.run({
          userId,
          scopeId: sessionId,
          widgetId,
          enabled: enabled ? 1 : 0,
          now: now(),
        }).changes > 0
      );
    },

    getPlanForSessionForUser(userId, sessionId) {
      const r = stmtGetPlanForSessionForUser.get({ userId, sessionId }) as
        | PlanRow
        | undefined;
      return r ? mapPlan(r) : undefined;
    },
    getPlanBySession(sessionId) {
      const r = stmtGetPlanBySession.get(sessionId) as PlanRow | undefined;
      return r ? mapPlan(r) : undefined;
    },
    insertPlan(input) {
      stmtInsertPlan.run({
        id: input.id,
        sessionId: input.sessionId,
        version: input.version,
        status: input.status,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      const r = stmtGetPlanBySession.get(input.sessionId) as PlanRow;
      return mapPlan(r);
    },
    bumpPlanVersion(planId, status, updatedAt) {
      const row = stmtBumpPlanVersion.get({ id: planId, status, updatedAt }) as {
        version: number;
      };
      return row.version;
    },
    setPlanStatus(planId, status, updatedAt) {
      stmtSetPlanStatus.run({ id: planId, status, updatedAt });
    },
    insertPlanVersion(input) {
      stmtInsertPlanVersion.run({
        id: input.id,
        planId: input.planId,
        version: input.version,
        treeJson: input.treeJson,
        createdAt: input.createdAt,
      });
    },
    listPlanVersions(planId) {
      return (stmtListPlanVersions.all(planId) as PlanVersionRow[]).map((r) => ({
        version: r.version,
        createdAt: r.created_at,
      }));
    },
    getPlanVersionForUser(userId, sessionId, version) {
      const r = stmtGetPlanVersionForUser.get({ userId, sessionId, version }) as
        | (PlanVersionRow & { tree_json: string })
        | undefined;
      return r
        ? { version: r.version, createdAt: r.created_at, treeJson: r.tree_json }
        : undefined;
    },
    listPlanNodes(planId) {
      return (stmtListPlanNodes.all(planId) as PlanNodeRow[]).map(mapPlanNode);
    },
    insertPlanNode(input) {
      stmtInsertPlanNode.run({
        id: input.id,
        planId: input.planId,
        parentId: input.parentId,
        position: input.position,
        title: input.title,
        status: input.status,
        introducedVersion: input.introducedVersion,
        // A fresh node is alive with no completion anchor; every version insert says so
        // explicitly rather than relying on column defaults the reader cannot see here.
        removedVersion: null,
        doneToolCallId: null,
        doneAt: null,
      });
    },
    updatePlanNodeStructure(input) {
      stmtUpdatePlanNodeStructure.run({
        id: input.id,
        planId: input.planId,
        parentId: input.parentId,
        position: input.position,
        title: input.title,
      });
    },
    softDeletePlanNode(planId, nodeId, removedVersion) {
      stmtSoftDeletePlanNode.run({ id: nodeId, planId, removedVersion });
    },
    updatePlanNodeProgress(planId, nodeId, status, anchorToolCallId, anchorAt) {
      stmtUpdatePlanNodeProgress.run({
        id: nodeId,
        planId,
        status,
        doneToolCallId: anchorToolCallId,
        doneAt: anchorAt,
      });
    },

    statsForWorkspace(userId, workspaceId) {
      const workspace = workspaceForUser(workspaceId, userId);
      if (!workspace) return undefined;

      const rows = stmtWorkspaceUsageRows.all(workspaceId) as {
        session_id: string;
        usage: string | null;
      }[];
      const bySession = new Map<string, (MessageUsage | null)[]>();
      for (const row of rows) {
        const list = bySession.get(row.session_id) ?? [];
        list.push(parseUsage(row.usage));
        bySession.set(row.session_id, list);
      }

      // Driven by the session list rather than by the rows, so a conversation with no messages
      // still appears with zeros — a widget that silently omitted it would read as the
      // conversation not existing. `listSessionsForUser` already orders newest first.
      return buildWorkspaceStats({
        workspaceId,
        sessions: (stmtListSessionsForUser.all(workspaceId, userId) as SessionRow[]).map((s) => ({
          sessionId: s.id,
          title: s.title,
          usages: bySession.get(s.id) ?? [],
        })),
      });
    },
    statsForSessionForUser(userId, sessionId) {
      const row = getSessionRowForUser(sessionId, userId);
      if (!row) return undefined;
      const rows = stmtSessionUsageRows.all(sessionId) as { usage: string | null }[];
      return buildSessionStats({
        sessionId,
        title: row.title,
        usages: rows.map((r) => parseUsage(r.usage)),
      });
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
