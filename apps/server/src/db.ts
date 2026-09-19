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
  FileCategory,
  FileSourceType,
  Insight,
  InsightType,
  Message,
  MessageModel,
  MessageUsage,
  ModelCapability,
  Note,
  NoteTargetKind,
  NoteType,
  ParseErrorCode,
  ParseStatus,
  PlanNodeStatus,
  PlanStatus,
  ProviderModel,
  QuizAnswer,
  QuizOption,
  QuizQuestionStatus,
  QuizVerdict,
  Session,
  SessionLockView,
  SessionSettings,
  SessionStats,
  StoredFile,
  ThreadBranch,
  TitleState,
  ToolCall,
  TurnReference,
  User,
  UserRole,
  WebPage,
  WebPageSourceType,
  WidgetId,
  WidgetScope,
  WidgetState,
  WorkResource,
  WorkResourceOwnerType,
  WorkResourceType,
  Workspace,
  WorkspaceSettings,
  WorkspaceStats,
} from "@ilearnassist/shared";
import {
  DEFAULT_USER_ROLES,
  defaultWidgetIdsForScope,
  isEnabledSuperadmin,
  isUserRole,
  isWidgetId,
  MAX_ATTACHMENT_BYTES,
  MAX_UPLOAD_CEILING_BYTES,
  MIN_UPLOAD_LIMIT_BYTES,
} from "@ilearnassist/shared";
import { workspaceWorkdir } from "./paths.js";
import type { ScopeQuery } from "./workspaceScope.js";
import { applySchema } from "./schema.js";
import { buildSessionStats, buildWorkspaceStats, resolveWidgetStates } from "./widgets.js";

/**
 * What a source listing may be narrowed by. Every field is optional and independent.
 *
 * Plain strings rather than the shared unions, because a query string is a string: the *route*
 * validates each against the union it knows and refuses an unknown value, and this layer
 * carries what it was given. A type here would only be a promise the caller could not keep.
 */

/**
 * The library's filters, as the statement takes them.
 *
 * `category` and `mime` read the **entity's** columns, not the reference's — they describe what
 * the bytes are, which is a fact about a file rather than about somebody's use of it. So both
 * are silently inapplicable to a page, and the statement's `@category IS NULL OR f.category = …`
 * arm is false for one: filtering by `document` correctly returns no pages.
 */
export interface WorkResourceFilter {
  resourceType?: WorkResourceType;
  ownerType?: WorkResourceOwnerType;
  category?: FileCategory;
  mime?: string;
  /** A substring of the title, matched literally — see the escape in the query. */
  name?: string;
  workspaceId?: string;
  sessionId?: string;
}

/* ---------------------------------- row shapes ---------------------------------- */


interface UserRow {
  id: string;
  username: string;
  slug: string;
  password_hash: string | null;
  roles: string;
  must_change_password: number;
  disabled: number;
  about: string;
  created_at: string;
}

interface AuthTokenRow {
  id: string;
  user_id: string;
  kind: string;
  expires_at: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface WorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  dir_path: string;
  /** The workspace's own settings as stored JSON, or null for "never set". */
  settings: string | null;
  /** The account's own note about this workspace. Always written; empty means none. */
  description: string;
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

interface ThreadRow {
  id: string;
  session_id: string;
  branch: string;
  title: string;
  plan_node_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One derived topic chain. Only real threads are stored — the 计划 / 其他 headings are a
 * rendering fact, never rows. A plan thread is one plan node (`planNodeId`).
 */
export interface ThreadRecord {
  id: string;
  sessionId: string;
  branch: ThreadBranch;
  title: string;
  planNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A note as stored, plus one column the reads add.
 *
 * `message_missing` is not in the table: the reads LEFT JOIN `messages`, so it answers "the
 * message this points at is gone" in the same query that answers everything else. A note
 * with no message at all is NOT missing — see `Note.messageMissing`.
 */
interface NoteRow {
  id: string;
  session_id: string;
  message_id: string | null;
  type: string;
  quote: string;
  occurrence: number;
  content: string;
  target_kind: string;
  target_ref: string | null;
  created_at: string;
  updated_at: string;
  message_missing: number;
  target_missing: number;
}

/** Input to `createNote`. The id is the caller's, as it is for every insert here. */
export interface NoteInsert {
  id: string;
  sessionId: string;
  messageId: string | null;
  type: NoteType;
  quote: string;
  occurrence: number;
  content: string;
  targetKind: NoteTargetKind;
  targetRef: string | null;
}

/**
 * A diagram as stored, plus the one column a read adds.
 *
 * `thread_title` is not in the table: a read that LEFT JOINs `session_threads` answers "which
 * thread is this in and what is it called" in the same query. A read with no join simply leaves
 * it undefined, which maps to null.
 */
interface DiagramRow {
  id: string;
  session_id: string;
  thread_id: string | null;
  file_id: string | null;
  name: string;
  summary: string;
  tool_call_id: string | null;
  created_at: string;
  updated_at: string;
  thread_title?: string | null;
}

interface TableRow {
  id: string;
  session_id: string;
  thread_id: string | null;
  name: string;
  summary: string;
  content: string;
  tool_call_id: string | null;
  created_at: string;
  updated_at: string;
  thread_title?: string | null;
}

interface InsightItemRow {
  id: string;
  session_id: string;
  type: string;
  title: string;
  body: string;
  adopted: number;
  ordinal: number;
  created_at: string;
  updated_at: string;
}

/**
 * One insight to write, from a pass.
 *
 * `ordinal` rather than a timestamp for ordering: a pass writes all its rows in one
 * transaction, so they share a `created_at` to the millisecond and the model's own order would
 * be lost without it.
 */
export interface InsightInsert {
  id: string;
  sessionId: string;
  type: InsightType;
  title: string;
  body: string;
  ordinal: number;
}

/**
 * The row as the rest of the server reads it.
 *
 * No `deleted_at` and no `sessionId`: the row is derived data (the DDL comment argues it), and
 * the only read is already scoped to one conversation, so a field repeating that would be a
 * second copy of what the WHERE already says. This is the shared `Insight` — nothing is added
 * on the way out, unlike `Diagram`, whose route adds `fileMissing` from a `stat`.
 */
export type InsightRecord = Insight;

/** A diagram as the rest of the server reads it. The route adds `fileMissing`. */
export interface DiagramRecord {
  id: string;
  sessionId: string;
  threadId: string | null;
  /** The `.mmd` this row drew. See `Diagram.fileId`. */
  fileId?: string;
  name: string;
  summary: string;
  toolCallId: string | null;
  threadTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input to `upsertDiagram`, from the tool. The id is the caller's. */
export interface DiagramUpsert {
  id: string;
  sessionId: string;
  /** The canonical file name — `auth-flow.mmd`, not the model's "Auth Flow". */
  name: string;
  /** The `.mmd` file's id. Written in the same transaction, which is why there is no FK. */
  fileId: string;
  summary: string;
  toolCallId: string | null;
}

/**
 * A table as the rest of the server reads it.
 *
 * The twin of `DiagramRecord`, with one field in place of the other's file: `content` holds the
 * markdown, because there is no file for the bytes to live in. See the `session_tables` DDL for
 * why that is the right inversion rather than an inconsistency.
 */
export interface TableRecord {
  id: string;
  sessionId: string;
  threadId: string | null;
  name: string;
  summary: string;
  content: string;
  toolCallId: string | null;
  threadTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input to `upsertSessionTable`, from the tool. The id is the caller's. */
export interface TableUpsert {
  id: string;
  sessionId: string;
  /** The slug the row is keyed by — no extension, because there is no file. */
  name: string;
  summary: string;
  content: string;
  toolCallId: string | null;
}

/** A message as it joins into a thread for the widget's read model. */
export interface ThreadMessageRow {
  threadId: string;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface QuizQuestionRow {
  id: string;
  session_id: string;
  node_id: string | null;
  node_title: string | null;
  tool_call_id: string;
  qid: string;
  position: number;
  header: string;
  question: string;
  multi_select: number;
  options_json: string;
  reference_answer_json: string | null;
  explanation: string | null;
  status: string;
  user_answer_json: string | null;
  verdict: string | null;
  feedback: string | null;
  grade_tool_call_id: string | null;
  created_at: string;
  answered_at: string | null;
  graded_at: string | null;
}

/**
 * One persisted quiz question. Created in `pending` when `ila_quiz` suspends, answered by
 * the card or a later make-up, and graded by `ila_review_quiz`.
 */
export interface QuizQuestionRecord {
  id: string;
  sessionId: string;
  nodeId: string | null;
  nodeTitle: string | null;
  toolCallId: string;
  qid: string;
  position: number;
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuizOption[];
  /** The model's answer-key labels; null when the question was posed without a key. */
  referenceAnswer: string[] | null;
  /** The model's answer analysis; never sent to the client. */
  explanation: string | null;
  status: QuizQuestionStatus;
  answer: QuizAnswer | null;
  verdict: QuizVerdict | null;
  feedback: string | null;
  gradeToolCallId: string | null;
  createdAt: string;
  answeredAt: string | null;
  gradedAt: string | null;
}

export interface QuizQuestionInsert {
  id: string;
  sessionId: string;
  nodeId: string | null;
  nodeTitle: string | null;
  toolCallId: string;
  qid: string;
  position: number;
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuizOption[];
  referenceAnswer?: string[];
  explanation?: string;
  createdAt: string;
}

/**
 * One row per live conversation, with the workspace it belongs to, for labelling a list.
 *
 * Names and ids only: the source browser groups and labels by owner, and a *session* owner is
 * not something the client can name — it holds the workspaces, but fetching every conversation
 * of every workspace to label a list is a request per workspace.
 */
export interface SessionLabelRow {
  id: string;
  title: string;
  workspace_id: string;
  workspace_name: string;
}

/** The same, with the ordering field a reader of the whole list wants. */
export interface SessionOverviewRow extends SessionLabelRow {
  updated_at: string;
}

/**
 * One message that matched a search, with enough of its conversation to name it.
 *
 * The label columns are carried rather than looked up per row for `SessionLabelRow`'s reason: a
 * result spanning the account would otherwise be one conversation lookup per hit, and the caller
 * has no way to batch them — it does not know which conversations matched until it has the rows.
 *
 * `content` is the whole stored body and is **clipped by the caller**, not here: what counts as
 * too long depends on which tool asked, and a statement that truncated would make the model's
 * paging arithmetic wrong rather than merely verbose.
 */
export interface MessageSearchRow extends SessionLabelRow {
  message_id: string;
  role: string;
  content: string;
  created_at: string;
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
  title_state: string | null;
  /** SQLite's integer spelling of a boolean; see `Session.pinned`. */
  pinned: number | null;
  settings: string | null;
  /** The user's own note about this conversation. Always written; empty means none. */
  description: string;
  created_at: string;
  updated_at: string;
}

interface SessionLockRow {
  session_id: string;
  client_id: string;
  acquired_at: string;
  expires_at: string;
}

/**
 * A usage ledger row, as stored.
 *
 * The names come from a **join**, not from the row: `provider_name`/`model_name` are denormalized
 * on the row and travel with it, while a workspace's title and a session's title are properties of
 * entities that may since have been renamed — and a statistics table showing today's name against
 * last month's spend is the right way round, because the reader is looking at the workspace they
 * have, not the one they had.
 */
export interface UsageRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  sessionId: string | null;
  messageId: string | null;
  purpose: string;
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  modelName: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number | null;
  createdAt: string;
  /** From the join; absent when the row names no workspace, or names one that is gone. */
  workspaceName?: string;
  /** From the join, for the per-session table. */
  sessionTitle?: string;
  /** From the join, for the console's per-account breakdown. */
  userName?: string;
}

/** What `insertUsageEvent` writes. Every token column defaults to zero at the call site. */
export interface UsageEventInput {
  id: string;
  userId: string;
  workspaceId: string | null;
  sessionId: string | null;
  messageId: string | null;
  purpose: string;
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  modelName: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  durationMs: number | null;
}

/**
 * The window a ledger read is cut to.
 *
 * Deliberately *narrower* than the `/api/stats` query it is built from: the instants are already
 * resolved (see `usage.ts`) and the zone is not this layer's business. `userId` absent means
 * every account, which only an administrator's route may ask for.
 */
export interface UsageQuery {
  userId?: string;
  workspaceId?: string;
  fromIso: string | null;
  toIso: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  tool_calls: string | null;
  attachments: string | null;
  /** JSON, nullable: absent on every row written before the `@`-reference existed. */
  /** JSON, nullable for the same reason: written only by a turn that pointed at something. */
  refs: string | null;
  usage: string | null;
  /**
   * Which model wrote this message, stored as four columns rather than one JSON blob.
   *
   * Columns because the statistics group by them, and because the *names* are the point: a
   * provider renamed or removed later must not rewrite what the transcript says about a turn it
   * already had. Null on every row written before the columns existed, which reads as "not
   * recorded" rather than as a default the app invented.
   */
  provider_id: string | null;
  provider_name: string | null;
  model_id: string | null;
  model_name: string | null;
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
 * The largest file an account may upload, in bytes, as an administrator set it.
 *
 * A row rather than a `config.yaml` key, unlike the document-parsing limits: this one is a
 * *setting* an administrator edits from the console, and `config.yaml` is a bootstrap file whose
 * values are read once. Nothing seeds it, deliberately — the default is `MAX_ATTACHMENT_BYTES`,
 * which both sides already share, so an installation that has never been touched behaves exactly
 * as it did before the setting existed.
 */
export const SETTING_MAX_UPLOAD_BYTES = "upload.maxFileBytes";

/**
 * Which installation this database is.
 *
 * A value in the database rather than a hash of the data root's path, and the difference is the
 * whole of what it is for: **a folder that was moved is the same installation** — its accounts,
 * its sessions and its `auth_tokens` all travelled with it — while a different folder is a
 * different one. A path-derived id would call a copy of the same data a new installation and sign
 * everybody out of a browser that had never left.
 *
 * What it answers: a client holding a bearer token has no way to tell "my token expired" from
 * "this origin is now serving somebody else's database", and the second is what a data-root switch
 * looks like from a tab that was already open. The comparison is the client's — see
 * `apps/web/src/composables/instance.ts` — and this is only the fact it compares against.
 */
export const SETTING_INSTANCE_ID = "instance.id";

/**
 * The installation's id, minted on first ask.
 *
 * Written on read rather than at creation because `createDb` is called by tests, by the CLI and by
 * the server, and a value none of them reads does not need to exist. The race it could lose is
 * against a second *process*, which this codebase already assumes away for DDL (see
 * `resetAdmin`); two concurrent readers of one file would mint two ids and one would win, which is
 * the same outcome as minting one.
 */
export function instanceId(db: AppDb): string {
  const known = db.getSetting(SETTING_INSTANCE_ID);
  if (known) return known;
  const minted = newId();
  db.setSetting(SETTING_INSTANCE_ID, minted);
  return minted;
}
/*
 * `SETTING_AUTH_SECRET` ("auth.secret") is gone, and the *row* it wrote is deliberately left
 * alone rather than cleaned up. It signed the session cookie, which a bearer token replaced —
 * and the lever it was, "rotate this and everybody is signed out", is now
 * `revokeAllTokens()`/the console's sign-out button, which acts on rows that mean something.
 * Deleting a leftover `app_settings` row would be a migration with no reader at the far end
 * of it, so a database that has one simply keeps an unused string in a settings table.
 */

/**
 * The title a conversation gets at creation, before the auto-titler replaces it.
 *
 * **A fallback, not the name a user sees.** The web client sends `session.fallbackTitle` — the
 * same placeholder, in the language the account is reading — and this is what a caller that
 * names nothing gets: the CLI, a script, a client of another language. It stays English for the
 * reason every server-side string does, which is that the server has no reader to ask.
 *
 * A constant rather than a literal in the route because the tests and the route have to agree
 * on it; a title spelled twice would drift into a rename that looks like a default.
 */
export const DEFAULT_SESSION_TITLE = "(Untitled) Session";

/**
 * Which lifetime a row in `auth_tokens` was issued for.
 *
 * The gate accepts `access` and the refresh route accepts `refresh`, and neither accepts the
 * other. Without the distinction a refresh token would be a full bearer credential for the
 * whole API, which is exactly what a short-lived access token exists to avoid.
 */
export type AuthTokenKind = "access" | "refresh";

export interface AuthTokenRecord {
  /** The token's SHA-256 — what the row is keyed by. The token itself is never stored. */
  id: string;
  userId: string;
  kind: AuthTokenKind;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * An account as the **server** sees it: the wire shape plus the two fields that never leave.
 *
 * The same split as `ProviderRecord` and its `apiKey`, and for a stronger reason: a password
 * hash is a credential. `mapUser` is the only place one is read, and a route returns `User`
 * by stripping these with a destructuring rest — the pattern `toResource` uses for `userId`.
 * That is what makes "the hash is never serialised" a property of the shapes rather than of
 * every route remembering to leave a field out.
 */
export interface UserRecord extends User {
  /** `null` means this account has never been given a password, so it cannot sign in. */
  passwordHash: string | null;
  disabled: boolean;
}

/**
 * The stored roles, tolerating anything a hand-edited row might hold.
 *
 * Exported because the administrator CLI's `status` reads this column on a handle it must not
 * migrate, so it cannot go through `mapUser` — but it must not grow a second reading of the
 * same JSON either, or the two would disagree about what a malformed row means.
 *
 * Unknown names are dropped rather than kept: a role this build does not know is one whose
 * checks do not exist, so carrying it forward would be carrying forward nothing. An empty
 * result falls back to the column's own default — the least privilege — because a row whose
 * roles were somehow unreadable should be an ordinary account rather than a privileged one.
 */
export function parseStoredRoles(raw: string): UserRole[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_USER_ROLES];
  }
  if (!Array.isArray(parsed)) return ["user"];
  const roles = parsed.filter(isUserRole);
  return roles.length ? roles : [...DEFAULT_USER_ROLES];
}

export function toAuthTokenRecord(r: AuthTokenRow): AuthTokenRecord {
  return {
    id: r.id,
    userId: r.user_id,
    // Anything that is not the refresh kind is an access token, so a row whose kind was
    // written by some other build is treated as the *shorter* lifetime rather than the
    // longer one.
    kind: r.kind === "refresh" ? "refresh" : "access",
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
  };
}

/**
 * A search term as a `LIKE` pattern: a substring, with what the caller typed taken literally.
 *
 * `%` and `_` are wildcards to SQLite, and the material this searches has both in it — a file
 * named `report_final.docx`, a query containing `%` — so a term that was not escaped would match
 * things the user did not ask for, and would do it silently. The `\` itself goes first in the
 * character class for that reason: escaping it last would double the backslashes the other two
 * substitutions just added.
 *
 * One implementation, used by every `LIKE` in this file: the paired `ESCAPE '\'` spent a while
 * written out at each statement, which is a place for the two halves to disagree.
 */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

const mapUser = (r: UserRow): UserRecord => ({
  id: r.id,
  username: r.username,
  slug: r.slug,
  roles: parseStoredRoles(r.roles),
  mustChangePassword: r.must_change_password !== 0,
  about: r.about,
  createdAt: r.created_at,
  passwordHash: r.password_hash,
  disabled: r.disabled !== 0,
});


/* ------------------- files, web pages and work resources (v4) ------------------- */

/*
 * The three new row shapes, and the one place a snake_case row becomes the wire type.
 *
 * `WorkResourceRecord` carries the entity **inline** rather than as a second lookup, because
 * every reader of a list needs it: the library draws a size column and a URL control from it,
 * and one request per row is the N+1 the v3 listing already refused. That is why its statements
 * join both entity tables rather than selecting from `work_resources` alone.
 */
interface FileRow {
  id: string;
  user_id: string;
  source_type: string;
  title: string;
  path: string;
  mime_type: string;
  category: string;
  size: number;
  summary: string | null;
  sha256: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

interface WebPageRow {
  id: string;
  user_id: string;
  source_type: string;
  url: string;
  title: string;
  summary: string | null;
  sha256: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
}

/**
 * A work resource joined to its entity, with the entity's columns prefixed.
 *
 * Both entity joins are `LEFT` and both are conditional on `resource_type`, so exactly one of
 * the two column sets is populated and the other is NULL — which is also how a reference to a
 * soft-deleted entity reads. `mapWorkResource` turns that into "no entity", and the listing
 * treats it as gone.
 */
interface WorkResourceRow {
  id: string;
  user_id: string;
  resource_type: string;
  resource_id: string;
  owner_type: string;
  owner_id: string;
  title: string;
  summary: string | null;
  parsed_file_id: string | null;
  parse_status: string;
  parse_error: string | null;
  parse_error_code: string | null;
  parser_id: string | null;
  parsed_chars: number | null;
  page_count: number | null;
  parse_updated_at: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
  /** Present only when `resource_type = 'file'` and the file is live. */
  file_entity_id: string | null;
  file_source_type: string | null;
  file_title: string | null;
  file_path: string | null;
  file_mime_type: string | null;
  file_category: string | null;
  file_size: number | null;
  file_summary: string | null;
  file_created_at: string | null;
  file_updated_at: string | null;
  /** Present only when `resource_type = 'web_page'` and the page is live. */
  page_entity_id: string | null;
  page_source_type: string | null;
  page_url: string | null;
  page_title: string | null;
  page_summary: string | null;
  page_created_at: string | null;
  page_updated_at: string | null;
}

/** A file as the rest of the server reads it. */
export interface FileRecord extends StoredFile {
  userId: string;
  sha256?: string;
}

/** A work resource with its entity resolved. The route adds `missing` and the owner labels. */
export interface WorkResourceRecord extends Omit<WorkResource, "resource" | "missing"> {
  userId: string;
  resource: StoredFile | WebPage;
}

const mapFile = (r: FileRow): FileRecord => ({
  id: r.id,
  userId: r.user_id,
  sourceType: r.source_type as FileSourceType,
  title: r.title,
  path: r.path,
  mimeType: r.mime_type,
  category: r.category as FileCategory,
  size: r.size,
  summary: r.summary ?? undefined,
  sha256: r.sha256 ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? undefined,
});

const mapWebPage = (r: WebPageRow): WebPage => ({
  id: r.id,
  sourceType: r.source_type as WebPageSourceType,
  url: r.url,
  title: r.title,
  summary: r.summary ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? undefined,
});

/**
 * The entity a joined row carries, or `undefined` when there is none.
 *
 * `undefined` means the entity was soft-deleted between the reference being written and this
 * read — the reference is not dismantled when its entity goes, so this is a reachable state
 * rather than a defensive branch. Callers treat it as gone; the listing drops the row.
 */
function entityOf(r: WorkResourceRow): StoredFile | WebPage | undefined {
  if (r.file_entity_id) {
    return {
      id: r.file_entity_id,
      sourceType: r.file_source_type as FileSourceType,
      title: r.file_title ?? "",
      path: r.file_path ?? "",
      mimeType: r.file_mime_type ?? "application/octet-stream",
      category: r.file_category as FileCategory,
      size: r.file_size ?? 0,
      summary: r.file_summary ?? undefined,
      createdAt: r.file_created_at ?? r.created_at,
      updatedAt: r.file_updated_at ?? undefined,
    };
  }
  if (r.page_entity_id) {
    return {
      id: r.page_entity_id,
      sourceType: r.page_source_type as WebPageSourceType,
      url: r.page_url ?? "",
      title: r.page_title ?? "",
      summary: r.page_summary ?? undefined,
      createdAt: r.page_created_at ?? r.created_at,
      updatedAt: r.page_updated_at ?? undefined,
    };
  }
  return undefined;
}

const mapWorkResource = (r: WorkResourceRow, entity: StoredFile | WebPage): WorkResourceRecord => ({
  id: r.id,
  userId: r.user_id,
  resourceType: r.resource_type as WorkResourceType,
  resourceId: r.resource_id,
  ownerType: r.owner_type as WorkResourceOwnerType,
  ownerId: r.owner_id,
  title: r.title,
  summary: r.summary ?? undefined,
  parsedFileId: r.parsed_file_id ?? undefined,
  parseStatus: r.parse_status as ParseStatus,
  parseError: r.parse_error ?? undefined,
  parseErrorCode: (r.parse_error_code ?? undefined) as ParseErrorCode | undefined,
  parserId: r.parser_id ?? undefined,
  parsedChars: r.parsed_chars ?? undefined,
  pageCount: r.page_count ?? undefined,
  parseUpdatedAt: r.parse_updated_at ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at ?? undefined,
  resource: entity,
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
  settings: r.settings ? safeParseObject<WorkspaceSettings>(r.settings) : undefined,
  // `?? ""` for a row read before the column existed, which is the same claim an empty one
  // makes — see the `ensureColumn` comment for why this field is not nullable.
  description: r.description ?? "",
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
  //
  // The session-scope defaults specifically, not the raw list: a Copilot installs into a session,
  // and its selection is replayed through `widgetRowsForSelection("session", …)` on create. A
  // workspace-scope id reaching there would not be filtered — it would be refused, and the
  // conversation would fail to start.
  widgets:
    r.widgets === null
      ? defaultWidgetIdsForScope("session")
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
  // A value nothing recognises reads as "never attempted" rather than as a title that landed —
  // which is the safe direction, since the only thing the answer decides is whether a retry is
  // worth making. Adding a state to `TitleState` means adding it here too: this list is the whole
  // of what reaches the wire, and a member left out is a state the client cannot see.
  titleState:
    r.title_state === "model" || r.title_state === "unnamed" || r.title_state === "fallback"
      ? r.title_state
      : undefined,
  // `=== 1`, not a truthiness test: a row written before the column existed reads `NULL`, and
  // `Boolean(null)` would be the right answer by accident rather than by rule.
  pinned: r.pinned === 1,
  settings: safeParseObject<SessionSettings>(r.settings),
  description: r.description ?? "",
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * A lease as the wire shows it.
 *
 * `mine` is computed against the asking client rather than stored, because it is the one part
 * that is a fact about the *request* — the row knows who holds the lock, not who is asking.
 */
const mapSessionLock = (r: SessionLockRow, clientId: string): SessionLockView => ({
  sessionId: r.session_id,
  clientId: r.client_id,
  mine: r.client_id === clientId,
  acquiredAt: r.acquired_at,
  expiresAt: r.expires_at,
});

/**
 * A ledger row, snake_case columns into the shape `usage.ts` reads.
 *
 * The three joined labels keep their `undefined` rather than becoming `""`: a bucket with no
 * label falls back to its key, and an empty string would render as a blank table cell instead.
 */
const mapUsageRow = (r: UsageDbRow): UsageRow => {
  const row: UsageRow = {
    id: r.id,
    userId: r.user_id,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    messageId: r.message_id,
    purpose: r.purpose,
    providerId: r.provider_id,
    providerName: r.provider_name,
    modelId: r.model_id,
    modelName: r.model_name,
    inputTokens: r.input_tokens,
    cachedInputTokens: r.cached_input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    totalTokens: r.total_tokens,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
  };
  if (r.workspace_name) row.workspaceName = r.workspace_name;
  if (r.session_title) row.sessionTitle = r.session_title;
  if (r.user_name) row.userName = r.user_name;
  return row;
};

/** The stored row, as better-sqlite3 hands it back. */
interface UsageDbRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  session_id: string | null;
  message_id: string | null;
  purpose: string;
  provider_id: string | null;
  provider_name: string | null;
  model_id: string | null;
  model_name: string | null;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  total_tokens: number;
  duration_ms: number | null;
  created_at: string;
  workspace_name: string | null;
  session_title: string | null;
  user_name: string | null;
}

const mapMessage = (r: MessageRow): Message => ({
  id: r.id,
  sessionId: r.session_id,
  role: r.role,
  content: r.content,
  reasoning: r.reasoning ?? undefined,
  toolCalls: r.tool_calls ? safeParseArray<ToolCall>(r.tool_calls) : undefined,
  attachments: r.attachments ? safeParseArray<Attachment>(r.attachments) : undefined,
  refs: r.refs ? safeParseArray<TurnReference>(r.refs) : undefined,
  usage: r.usage ? safeParseObject<MessageUsage>(r.usage) : undefined,
  model: messageModelOf(r),
  stopped: r.stopped ? true : undefined,
  createdAt: r.created_at,
});

/**
 * The model that wrote a message, or `undefined` when it was not recorded.
 *
 * All four columns or nothing: a row with an id and no name is a row from a half-finished write,
 * and handing back a partial object would put a message on screen claiming a model with no name
 * to show. `undefined` is the honest answer for every message written before these columns
 * existed — see `Message.model`.
 */
function messageModelOf(r: MessageRow): MessageModel | undefined {
  if (!r.provider_id || !r.provider_name || !r.model_id || !r.model_name) return undefined;
  return {
    providerId: r.provider_id,
    providerName: r.provider_name,
    modelId: r.model_id,
    modelName: r.model_name,
  };
}

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

const mapThread = (r: ThreadRow): ThreadRecord => ({
  id: r.id,
  sessionId: r.session_id,
  branch: r.branch as ThreadBranch,
  title: r.title,
  planNodeId: r.plan_node_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapNote = (r: NoteRow): Note => ({
  id: r.id,
  sessionId: r.session_id,
  messageId: r.message_id,
  type: r.type as NoteType,
  quote: r.quote,
  occurrence: r.occurrence,
  content: r.content,
  targetKind: r.target_kind as NoteTargetKind,
  targetRef: r.target_ref,
  messageMissing: r.message_missing !== 0,
  targetMissing: r.target_missing !== 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapInsight = (r: InsightItemRow): InsightRecord => ({
  id: r.id,
  type: r.type as InsightType,
  title: r.title,
  body: r.body,
  adopted: r.adopted !== 0,
  createdAt: r.created_at,
});

const mapDiagram = (r: DiagramRow): DiagramRecord => ({
  id: r.id,
  sessionId: r.session_id,
  threadId: r.thread_id,
  fileId: r.file_id ?? undefined,
  name: r.name,
  summary: r.summary,
  toolCallId: r.tool_call_id,
  threadTitle: r.thread_title ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapTable = (r: TableRow): TableRecord => ({
  id: r.id,
  sessionId: r.session_id,
  threadId: r.thread_id,
  name: r.name,
  summary: r.summary,
  content: r.content,
  toolCallId: r.tool_call_id,
  threadTitle: r.thread_title ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapQuizQuestion = (r: QuizQuestionRow): QuizQuestionRecord => ({
  id: r.id,
  sessionId: r.session_id,
  nodeId: r.node_id,
  nodeTitle: r.node_title,
  toolCallId: r.tool_call_id,
  qid: r.qid,
  position: r.position,
  header: r.header,
  question: r.question,
  multiSelect: r.multi_select !== 0,
  options: safeParseArray<QuizOption>(r.options_json),
  referenceAnswer: r.reference_answer_json
    ? safeParseArray<string>(r.reference_answer_json)
    : null,
  explanation: r.explanation,
  status: r.status as QuizQuestionStatus,
  answer: r.user_answer_json ? safeParseObject<QuizAnswer>(r.user_answer_json) : null,
  verdict: (r.verdict as QuizVerdict | null) ?? null,
  feedback: r.feedback,
  gradeToolCallId: r.grade_tool_call_id,
  createdAt: r.created_at,
  answeredAt: r.answered_at,
  gradedAt: r.graded_at,
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
   * Accounts.
   *
   * These return `UserRecord`, which carries the password hash and the disabled flag — see
   * its note. The lookup is case-insensitive (`idx_users_username` is `COLLATE NOCASE`), so
   * "Ada" and "ada" are one account rather than two that look identical on the login screen.
   *
   * Accounts are **created by an administrator** now and never by a login. The old route
   * made the row when a name was new, which was the whole of signing in at the time; with a
   * password there is nothing to sign in to until somebody with the console has made one.
   */
  listUsers(): UserRecord[];
  getUser(id: string): UserRecord | undefined;
  findUserByUsername(username: string): UserRecord | undefined;
  createUser(input: {
    id: string;
    username: string;
    slug: string;
    roles?: UserRole[];
    passwordHash?: string | null;
    mustChangePassword?: boolean;
  }): UserRecord;
  /**
   * Set an account's password, and say whether it has to be changed on the way in.
   *
   * One statement rather than two, because the two are never written apart: a password set
   * by an administrator is one the account was told to replace, and a password an account
   * chose for itself is not. Splitting them would allow the combination that means nothing.
   */
  setUserPassword(
    id: string,
    passwordHash: string,
    mustChangePassword: boolean
  ): UserRecord | undefined;
  setUserRoles(id: string, roles: UserRole[]): UserRecord | undefined;
  /** Disable or re-enable an account. Never a delete: the row owns workspaces and history. */
  setUserDisabled(id: string, disabled: boolean): UserRecord | undefined;
  /**
   * The account's own description of itself — the one field of its own record it may write.
   *
   * Not scoped to an actor and not an admin operation: this is the account writing about itself,
   * which is why it is the only mutator here with no console route behind it.
   */
  setUserAbout(id: string, about: string): UserRecord | undefined;
  /**
   * Whether anybody on this installation can sign in at all.
   *
   * The predicate behind the **sign-in** guard, and it asks about the *password* rather than
   * about the row count on purpose: a data root carried over from the build where a username
   * was the credential has accounts and no credentials, and such an installation has nobody
   * who could sign in. See `hasSuperadmin` for the question the bootstrap actually asks — the
   * two coincide today only because the bootstrap always grants the role.
   */
  hasPasswordAccounts(): boolean;
  /**
   * Whether anybody on this installation can *administer* it.
   *
   * Deliberately not `hasPasswordAccounts`, which is a sign-in predicate. On a database where
   * an account holds a credential but no superadmin role — a partial restore, a hand-edit, a
   * future bug — that one answers yes, so the server would boot, the control panel would hide
   * the create-administrator control, and the installation would be one nobody could manage.
   * Roles and the disabled flag are two columns, so this reads both.
   */
  hasSuperadmin(): boolean;

  /* ------------------------------- auth tokens ------------------------------ */

  /**
   * Issued tokens, keyed by the token's SHA-256.
   *
   * Every read here is by that hash or by owner, and the owner one is what makes "sign this
   * account out everywhere" a single statement. Nothing ever selects a token *value*: only a
   * hash is stored, so there is no plaintext to select.
   */
  createAuthToken(input: {
    id: string;
    userId: string;
    kind: AuthTokenKind;
    expiresAt: string;
  }): AuthTokenRecord;
  getAuthToken(id: string): AuthTokenRecord | undefined;
  /** Record that a token was used, for the diagnostics the console shows. Best effort. */
  touchAuthToken(id: string, at: string): void;
  revokeAuthToken(id: string, at: string): boolean;
  /** Revoke every live token an account holds, and report how many that was. */
  revokeUserTokens(userId: string, at: string): number;
  /** Revoke every live token an account holds of one kind. Used by the refresh rotation. */
  revokeUserTokensOfKind(userId: string, kind: AuthTokenKind, at: string): number;
  /** Delete rows that expired or were revoked before `before`, so the table stays small. */
  pruneAuthTokens(before: string): number;


  /**
   * Every live conversation's id, title and workspace name, for labelling a list.
   *
   * Not `listSessionsForUser` repeated per workspace: the library lists the whole account's
   * material at once, and a request per workspace to find out what to call a conversation would
   * be a request per workspace.
   */
  listSessionLabels(userId: string): SessionLabelRow[];
  /** The same, newest first — what a reader of the whole list wants and a labeller does not. */
  listSessionOverviews(userId: string): SessionOverviewRow[];
  /**
   * Messages whose **text** contains `query`, across the given workspaces.
   *
   * `workspaceIds` is the `@` grant as a set, and it is a parameter rather than a filter the
   * caller applies afterwards because the query is what makes this affordable: an account's whole
   * transcript history is not something to page in memory and then narrow. An empty set returns
   * nothing rather than everything — the safe reading, and the one a caller who forgot to resolve
   * a grant should get.
   *
   * The match is a literal substring, case-insensitive, over `messages.content` only: tool output
   * is not message text, and reasoning is not replayed into a model's context anywhere else in
   * the app — searching it here would be the one place it leaks into one.
   */
  searchMessages(
    userId: string,
    workspaceIds: readonly string[],
    query: string
  ): MessageSearchRow[];

  /* ----------------- files, web pages and work resources (v4) ----------------- */

  /** One file by id, owner-scoped. "Not yours" and "does not exist" answer alike. */
  getFileForUser(userId: string, id: string): FileRecord | undefined;
  /**
   * The live file at one path, or undefined.
   *
   * **By path, not by id**, and that is the whole of the rename story: a file the user moves is
   * the same file, and the caller that wants it back asks by the new path. `deleted_at IS NULL`
   * is what lets a file be deleted and a new one written at the same path.
   */
  getFileByPath(userId: string, path: string): FileRecord | undefined;
  /** Every live file the account holds, in path order — the reconciler's read. */
  listFilesForUser(userId: string): FileRecord[];
  findFileByHash(userId: string, sha256: string): FileRecord | undefined;
  /** The soft-deleted twin of the above, which is what a re-upload revives. */
  findDeletedFileByHash(userId: string, sha256: string): FileRecord | undefined;
  createFile(input: {
    id: string;
    userId: string;
    sourceType: FileSourceType;
    title: string;
    path: string;
    mimeType: string;
    category: FileCategory;
    size: number;
    summary?: string;
    sha256?: string;
    now?: string;
  }): FileRecord;
  /**
   * Update a file's place or its description of itself, in place.
   *
   * One statement for a rename, a rewrite and a size change because they are one operation: the
   * row keeps its id and every reference to it, and only these columns move. Returns whether
   * anything matched, so a caller can tell "not yours" from "done".
   */
  updateFilePath(
    id: string,
    userId: string,
    patch: {
      path?: string;
      title?: string;
      mimeType?: string;
      category?: FileCategory;
      size?: number;
      summary?: string | null;
      now?: string;
    }
  ): boolean;
  /** Marks the file deleted. Returns false when no live file existed, or it was not theirs. */
  softDeleteFileForUser(id: string, userId: string): boolean;
  /**
   * Clears the marker on a soft-deleted file and returns it, or undefined if there was nothing
   * to revive. The bytes and every reference to it are untouched — the row was never dismantled,
   * only hidden.
   */
  reviveFileForUser(id: string, userId: string): FileRecord | undefined;

  getWebPageForUser(userId: string, id: string): WebPage | undefined;
  /**
   * Marks the page deleted — the material half of deleting the reference that names it.
   *
   * The file's rule, applied to the other entity: a delete of a reference takes the material with
   * it, and the fetched body under `sources/web/` stays where it is (a soft delete costs no disk).
   * There was no such accessor until the delete was unified, because a page could only ever lose
   * its *reference* — which left the row live and unreachable, the state this closes.
   */
  softDeleteWebPageForUser(id: string, userId: string): boolean;
  /** The live page whose reading hashes to this, which is what makes keeping it again a no-op. */
  findWebPageByHash(userId: string, sha256: string): WebPage | undefined;
  createWebPage(input: {
    id: string;
    userId: string;
    sourceType: WebPageSourceType;
    url: string;
    title: string;
    summary?: string;
    sha256: string;
    now?: string;
  }): WebPage;
  updateWebPage(
    id: string,
    userId: string,
    patch: { url?: string; title?: string; summary?: string | null; now?: string }
  ): boolean;

  /**
   * Make an entity referenceable by one owner, and return the reference.
   *
   * **The only write that may create a `work_resources` row**, and it is idempotent on
   * (owner, entity): calling it twice is one row whose title is refreshed. `undefined` means the
   * entity is not this account's or is not there at all — the ownership check and the insert are
   * one statement, so an id from another account cannot become a row.
   */
  upsertWorkResource(input: {
    id: string;
    userId: string;
    resourceType: WorkResourceType;
    resourceId: string;
    ownerType: WorkResourceOwnerType;
    ownerId: string;
    title: string;
    summary?: string;
    now?: string;
  }): WorkResourceRecord | undefined;
  getWorkResourceForUser(userId: string, id: string): WorkResourceRecord | undefined;
  /**
   * Every live reference to one entity, with the entity attached.
   *
   * The reverse lookup the delete paths need: it is what answers "does anything still reference
   * this file", which no foreign key can answer here because `resource_id` is polymorphic.
   */
  listWorkResourcesForResource(
    userId: string,
    resourceType: WorkResourceType,
    resourceId: string
  ): WorkResourceRecord[];

  /* ----------------------- session references (参考) ----------------------- */

  /**
   * Record that a conversation is *about* a work resource it does not hold.
   *
   * The handle is the **reference**, not the entity it resolves to — v5's change, and the one
   * sentence to keep in mind about this relation: everything else in the model reaches material
   * through `work_resources`, and this table used not to. Idempotent on
   * `(session_id, work_resource_id)`, which is what makes `@`-ing the same thing on a later turn
   * one statement rather than a duplicate row. There is no title and no parse state to keep in
   * step — the row it names carries both, and this row is only the fact that the conversation
   * reached it.
   */
  addSessionReference(input: {
    id: string;
    sessionId: string;
    workResourceId: string;
    now?: string;
  }): void;

  /**
   * Every reference a conversation points at, by id.
   *
   * The ids rather than rows, because a caller resolving them wants the row itself — the one
   * with a title and a parse state — and the SQL that widens a listing resolves it in the query
   * rather than by fetching these at all. This is for the callers that need the set itself, and
   * for the tests that assert what a turn wrote.
   */
  listSessionReferences(sessionId: string): string[];
  listWorkResourcesFiltered(
    userId: string,
    filter: WorkResourceFilter
  ): WorkResourceRecord[];
  /**
   * The read whitelist: what the model may read this turn.
   *
   * The same three arms the v3 statement had, over one table — see its docblock for what each
   * covers and why arm 3 must not gain an `@workspaceId` clause.
   */
  listReadableWorkResources(
    userId: string,
    sessionId: string,
    workspaceId: string,
    scope: ScopeQuery
  ): WorkResourceRecord[];
  /** Marks the reference deleted. The entity and its bytes are untouched. */
  softDeleteWorkResourceForUser(id: string, userId: string): boolean;
  /** Records what a parse did. `parsedFileId` is only ever set, never cleared. */
  /**
   * How many places each of these entities is reachable from, keyed by entity id.
   *
   * **Both relations, and that is what the number is for.** A holding row is one place; a
   * conversation pointing at it with `@` is another — under v5 those references are *kept* when
   * the material goes, so what the number says is how many places will start reporting "the
   * object is gone". Counting only holdings would answer "nobody else is working from this" about
   * material two panels were built around.
   *
   * The reference half is counted *through* the entity (`session_references` joins
   * `work_resources`), because a link names a reference and the question is about a file.
   *
   * One statement per entity *type* rather than one per row, because the question is asked by a
   * listing — the library answers it for every row it draws, so a lookup per row would be a query
   * per row. `resourceIds` travels as JSON for `listReadableWorkResources`' reason:
   * `json_each('')` raises, and a raise on a listing is a 500.
   *
   * **Live rows only**, which is what makes the answer mean something: a holding the user deleted
   * is not a second copy of anything. `idx_wr_resource` and `idx_sref_resource` carry the pair.
   * A reference needs no owner filter — the entity id is already this account's.
   */
  countReferencesForEntities(
    userId: string,
    resourceType: WorkResourceType,
    resourceIds: readonly string[]
  ): Map<string, number>;

  updateWorkResourceParse(input: {
    id: string;
    userId: string;
    status: ParseStatus;
    error?: string | null;
    code?: ParseErrorCode | null;
    parserId?: string | null;
    parsedChars?: number | null;
    pageCount?: number | null;
    parsedFileId?: string | null;
    now?: string;
  }): boolean;

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
    /**
     * The workspace's own note about itself. Optional, and absent means `''` — the column is
     * `NOT NULL DEFAULT ''`, so a caller that has nothing to say says nothing.
     */
    description?: string;
  }): Workspace;
  /**
   * The two text fields a workspace carries, either or both.
   *
   * One statement for a rename and a description because they are one resource's `PATCH`, and
   * because they are the same kind of write: a `COALESCE` per column, where a field the caller
   * did not mention keeps the row's own value and an empty string is a value. Splitting them
   * into a `rename…` and a `set…Description` would put the "which one did I send" question at
   * the route, which is exactly the shape this avoids.
   *
   * Renaming is display-only. The directory on disk keeps the slug it was created with — a
   * rename that moved files would break every path the agent has already written into a
   * conversation — and the description was never a path at all.
   */
  patchWorkspaceForUser(
    id: string,
    userId: string,
    patch: { name?: string; description?: string }
  ): Workspace | undefined;
  /**
   * Replace the workspace's settings.
   *
   * A whole-object write rather than a merge, unlike the session's, and the difference is
   * deliberate: a workspace's settings are the *default* a conversation inherits at creation,
   * so the only writer is the settings control that drew every field on screen. A merge would
   * make "clear this back to the built-in default" inexpressible without a sentinel.
   */
  setWorkspaceSettingsForUser(
    id: string,
    userId: string,
    settings: WorkspaceSettings
  ): Workspace | undefined;
  /**
   * Marks the workspace deleted. Returns false when no live workspace existed, or it was not
   * this account's. The directory on disk stays — including the `sessions/` beside `workdir/`
   * — and so does every row that hangs off it; they are reached through this one, so hiding it
   * here is what hides them.
   */
  softDeleteWorkspaceForUser(id: string, userId: string): boolean;

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
  /**
   * Owner-only, and a soft delete. Returns false when no live Copilot existed, or it belonged
   * to someone else. Conversations already started from it are unaffected — they read their
   * own snapshot, and `copilot_id` was only ever a link the UI may show.
   */
  softDeleteCopilotForUser(id: string, userId: string): boolean;

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
   *
   * A `description` is neither of those things: it changes no behaviour, so it is a plain
   * assignment with an empty string meaning "cleared" and `undefined` meaning "not mentioned".
   */
  updateSessionForUser(
    id: string,
    userId: string,
    input: {
      title?: string;
      description?: string;
      settings?: SessionSettings;
      systemPrompt?: string;
      allTools?: boolean;
      tools?: string[];
    }
  ): Session | undefined;
  /**
   * Replace the title on behalf of the auto-titler, keeping `titleSource: "auto"`, and record how
   * the pass fared (`titleState`).
   *
   * Returns `undefined` when nothing was written, and the interesting half of that is a **lost
   * race**: the statement carries `title_source = 'auto'` in its own `WHERE`, so a rename landing
   * between the caller's read and this write refuses the automatic title rather than overwriting
   * the name a person chose. A caller must therefore treat `undefined` as "do not report a new
   * title", not as "the session is gone".
   */
  setAutoTitleForUser(
    id: string,
    userId: string,
    title: string,
    titleState: TitleState
  ): Session | undefined;
  /**
   * Record what the auto-titler decided **without writing a title** — the `"unnamed"` half of how
   * a pass can end, where the model looked at the conversation and found nothing to name yet.
   *
   * The title column is untouched, so the conversation keeps the placeholder it was created with,
   * which is the state the requirement asks for. Returns false when nothing was written: no live
   * session of this account has that id, or a user rename has since taken the title out of the
   * titler's hands — the same `title_source = 'auto'` guard `setAutoTitleForUser` carries, and for
   * the same reason.
   */
  setTitleStateForUser(id: string, userId: string, titleState: TitleState): boolean;
  /**
   * Marks the conversation deleted. Returns false when no live session existed, or it belonged
   * to someone else. Its messages, links, plans and quiz rows all stay, as does the reserved
   * `sessions/<id>/` directory — every one of them is reached through this row, so filtering
   * it here is what takes them out of view.
   */
  softDeleteSessionForUser(id: string, userId: string): boolean;
  /**
   * Pin or unpin the conversation, and return the row as it now reads.
   *
   * One statement whose own `WHERE` carries the owner, like `setAutoTitleForUser`, so `undefined`
   * means exactly one thing: no live session of this account has that id. There is deliberately
   * **no** `updated_at` write — see the statement for why pinning is not activity.
   */
  setSessionPinnedForUser(id: string, userId: string, pinned: boolean): Session | undefined;

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

  /*
   * Session write locks. All three are owner-scoped, and the two writes assert `ForUser` in
   * their own `WHERE` rather than relying on a read that came before: these are the statements
   * the routes consult *instead of* a lock table's own permission check, so they are the wrong
   * place for the documented bare-id asymmetry above.
   *
   * `acquireSessionLock` answers `undefined` when a live lease is held by another client — the
   * route turns that into 409 — and the lease when it took or renewed it. `releaseSessionLock`
   * answers whether this client's lease was the one removed.
   */
  acquireSessionLock(input: {
    sessionId: string;
    userId: string;
    clientId: string;
    ttlSeconds: number;
    now?: Date;
  }): SessionLockView | undefined;
  releaseSessionLock(input: {
    sessionId: string;
    userId: string;
    clientId: string;
    now?: Date;
  }): boolean;
  /**
   * The live lease on this session, or undefined when it is free, expired, or not this account's.
   *
   * `clientId` is the *asking* client, and it is what `mine` is computed from — passed in rather
   * than attached by the route so that the one field about the request is filled at the same
   * place as the fields about the row.
   */
  sessionLockFor(
    sessionId: string,
    userId: string,
    clientId: string,
    now?: Date
  ): SessionLockView | undefined;
  /** Every live lease in the workspace. Empty for a workspace this account does not own. */
  listSessionLocksForUser(
    workspaceId: string,
    userId: string,
    clientId: string,
    now?: Date
  ): SessionLockView[];

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
    /** What the turn pointed at, as the client sent it. See `ChatInput.refs`. */
    refs?: TurnReference[];
    usage?: MessageUsage;
    /**
     * Which model produced this message. Absent writes four NULLs, which is what every caller
     * that is not a turn does — a `⚠️` failure row is attributed by its caller, and a message
     * written by a test does not claim a model at all.
     */
    model?: MessageModel;
    /** The user cut this turn short; `content` is whatever had streamed by then. */
    stopped?: boolean;
  }): Message;

  /**
   * Mark one message deleted, scoped to its owner. Returns false when it was not there, was
   * not this account's, or was already deleted.
   *
   * The *caller* decides whether it is the tail and does the two together in one transaction —
   * this is the write, `listMessagesForUser` is the read, and the pair has to be atomic or two
   * tabs can both see themselves as last and both peel. Nothing cascades and nothing cascades
   * *to* a message: the row stays, the history read stops seeing it, and that is the whole
   * effect.
   */
  softDeleteMessageForUser(sessionId: string, messageId: string, userId: string): boolean;

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
   * Every call still `awaiting` in a session, as `{id, name}`. The name lets callers act
   * on one tool's calls (the quiz rows are retired by the `ila_quiz` ones) without a second
   * message scan.
   */
  listAwaitingToolCalls(sessionId: string): { id: string; name: string }[];

  /**
   * Retire every still-awaiting call in a session, returning the retired calls.
   *
   * Called when the user sends a new message instead of answering: the turn those
   * questions belonged to is over, and a card that stayed answerable would resume a
   * conversation the user has already moved on from.
   */
  skipAwaitingToolCalls(sessionId: string): { id: string; name: string }[];

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
   * Whether this conversation has *answered* for this widget, and what it said: `true` /
   * `false`, or `undefined` when nothing has ever decided.
   *
   * The question the resolved lists above cannot answer, and they cannot **on purpose** — they
   * iterate the registry so a stored row and a defaulted one are indistinguishable, which is
   * what makes them the only thing a reader may derive "what is installed" from. This is the
   * narrower question, and it exists for exactly one caller: `installWidgetForToolUse`, which
   * installs a widget the conversation has never been asked about and must never touch one that
   * has said no.
   *
   * It is deliberately **not** a second source of truth for `enabled` — the existence of a
   * decision is what `widgetRowsForSelection` already writes, and that is all this reports.
   */
  getSessionWidgetDecisionForUser(
    userId: string,
    sessionId: string,
    widgetId: WidgetId
  ): boolean | undefined;
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

  /*
   * Quiz questions (quiz widget). Ownership is reached through the session like plans: the
   * ForUser pair is what routes read; the session-id-only accessors run on an
   * already-resolved turn, over rows the turn itself created.
   */
  insertQuizQuestions(rows: QuizQuestionInsert[]): void;
  listQuizQuestionsForUser(userId: string, sessionId: string): QuizQuestionRecord[];
  listQuizQuestionsBySession(sessionId: string): QuizQuestionRecord[];
  getQuizQuestionForUser(
    userId: string,
    sessionId: string,
    id: string
  ): QuizQuestionRecord | undefined;
  /** Retire pending quiz rows posed by the named suspending calls. Empty list is a no-op. */
  skipQuizQuestions(sessionId: string, toolCallIds: string[]): void;
  /**
   * Conditional status transition, only from `expectedStatus`. Clears grading on an
   * answered transition, so a make-up never displays the previous answer's verdict.
   * Returns whether a row changed; false is the lost-race signal.
   */
  transitionQuizQuestion(input: {
    sessionId: string;
    id: string;
    expectedStatus: QuizQuestionStatus;
    status: QuizQuestionStatus;
    answerJson?: string | null;
    answeredAt?: string | null;
  }): boolean;
  /** Record the model's verdict; answered questions only. Returns whether it landed. */
  gradeQuizQuestion(input: {
    sessionId: string;
    id: string;
    verdict: QuizVerdict;
    feedback: string;
    gradeToolCallId: string;
    gradedAt: string;
  }): boolean;

  /*
   * Threads (thread widget). Derived topic chains, the plan/quiz shape: no deleted_at,
   * owner-scoped reads join through to the workspace, while the sync that runs on an
   * already-resolved turn uses the bare session-id accessors.
   */
  listThreadsForUser(userId: string, sessionId: string): ThreadRecord[];
  /** Unscoped — post-turn sync on an already-resolved session only. */
  listThreadsBySession(sessionId: string): ThreadRecord[];
  /** Unscoped — the sync's ordered join of messages into threads. */
  listThreadMessagesBySession(sessionId: string): ThreadMessageRow[];
  /** Unscoped live messages of a session, oldest first — the sync's segmentation input. */
  listSessionMessages(sessionId: string): Message[];
  insertThread(input: {
    id: string;
    sessionId: string;
    branch: ThreadBranch;
    title: string;
    planNodeId?: string | null;
  }): ThreadRecord;
  /** The one thread this session has for a plan node, if any — the plan branch's idempotency. */
  getThreadByPlanNode(sessionId: string, planNodeId: string): ThreadRecord | undefined;
  listThreadMessagesForUser(userId: string, sessionId: string): ThreadMessageRow[];
  /**
   * Oldest live, still-unassigned messages of a session, capped. The classifier segments a
   * run of these into turns. Bare session id: the sync's caller resolved the owner.
   */
  listPendingThreadMessages(sessionId: string, limit: number): Message[];
  countPendingThreadMessagesForUser(userId: string, sessionId: string): number;
  countPendingThreadMessages(sessionId: string): number;
  /**
   * Attach the named live messages to a thread. Only still-unassigned messages of THIS
   * session move, so a stale id list can never hijack another session's message or reassign
   * one a concurrent sync already placed. Returns how many moved.
   */
  assignMessagesToThread(sessionId: string, messageIds: string[], threadId: string): number;

  /**
   * Attach one diagram to a thread. Bare session id like `assignMessagesToThread`: the
   * thread sync is the only caller, and it has resolved ownership before it runs. Only an
   * unassigned diagram moves (a revise cleared it), so a re-run never re-homes one.
   */
  assignDiagramToThread(sessionId: string, diagramId: string, threadId: string): number;

  /*
   * Notes (notes widget). User-authored, so unlike the plan/quiz/thread rows above these carry
   * `deleted_at` and every read filters it.
   *
   * Both reads return `Note` — the same shape the wire carries, `messageMissing` included —
   * because unlike a thread there is nothing to restructure: the row IS the record.
   */
  listNotesForUser(userId: string, sessionId: string): Note[];
  /**
   * One note, owner-scoped. `undefined` for "not yours" and for "does not exist" alike, the
   * same answer the routes turn into one 404 — so a note id cannot be probed.
   */
  getNoteForUser(userId: string, sessionId: string, noteId: string): Note | undefined;
  createNote(input: NoteInsert): Note;
  /**
   * A partial edit: an absent field keeps its stored value, so a body that mentions only the
   * text cannot silently reset the type. `undefined` when the note is not this session's.
   *
   * Bare session id, like `assignMessagesToThread`: every caller has already resolved the
   * session through a `ForUser` read, and the session scoping here is what keeps a note id
   * from one conversation out of another's route.
   */
  updateNote(
    sessionId: string,
    noteId: string,
    input: { type?: NoteType; content?: string }
  ): Note | undefined;
  /** Marks the note deleted. The row and its bytes stay; every read filters it out. */
  softDeleteNote(sessionId: string, noteId: string): boolean;

  /**
   * A conversation's insight observations, in the order the panel renders them: adopted first,
   * then the current pass in the model's own order. Owner-scoped, the route's read.
   */
  listInsightsForUser(userId: string, sessionId: string): InsightRecord[];
  /**
   * One observation, owner-scoped. `undefined` for "not yours" and for "does not exist" alike —
   * and for one the last pass replaced, which is the same answer by design.
   */
  getInsightForUser(userId: string, sessionId: string, insightId: string): InsightRecord | undefined;
  /**
   * Replace everything a pass did not keep, in **one transaction**: the wipe and the insert
   * cannot be separated, because a crash between them would leave the panel empty with the
   * model's answer already discarded. Called only AFTER a usable parse — a failed pass must
   * leave every row exactly as it was.
   *
   * Bare session id like `skipAwaitingToolCalls`: every caller has resolved the session through
   * a `ForUser` read, and the wipe's scoping by session is what keeps one conversation's pass
   * from clearing another's.
   */
  replaceUnadoptedInsights(sessionId: string, items: InsightInsert[]): void;
  /** Adopt or release one observation. `undefined` when the id is not this session's. */
  setInsightAdoptedForUser(
    userId: string,
    sessionId: string,
    insightId: string,
    adopted: boolean
  ): InsightRecord | undefined;
  /**
   * Drop one observation. A real DELETE rather than a soft one — the DDL comment on
   * `insight_items` carries the argument for why derived data is the exception.
   */
  deleteInsightForUser(userId: string, sessionId: string, insightId: string): boolean;

  /**
   * A conversation's diagrams, by session. Bare session id like `listThreadsBySession`: every
   * caller has already resolved the session through a `ForUser` read, and the thread sync
   * runs inside the server with no request. Ordered newest-first.
   */
  listDiagramsBySession(sessionId: string): DiagramRecord[];
  /**
   * Owner-scoped list. The route resolves the session through a `ForUser` read first (so a
   * foreign id is a 404), and this puts the owner in the WHERE too — the rule is not the
   * resolution. Used to build the API view.
   */
  listDiagramsForUser(userId: string, sessionId: string): DiagramRecord[];
  /**
   * One row by session and canonical file name, no owner. Bare session id like
   * `getNote`: every caller has already resolved ownership, and the file-content read
   * attaches a summary by the file it is serving.
   */
  getDiagramBySessionName(sessionId: string, name: string): DiagramRecord | undefined;
  /**
   * Insert, or revise in place when the conversation already has a diagram with this file name.
   * A revise keeps the id and created_at, moves the tool-call anchor to the new call, and
   * clears `thread_id` so the new shape is judged.
   */
  upsertDiagram(input: DiagramUpsert): DiagramRecord;

  /**
   * A conversation's tables, by session, newest first. Bare session id, `listDiagramsBySession`'s
   * argument exactly: every caller has resolved the session through a `ForUser` read.
   *
   * Includes `content`, so this is the *route's* read as well as the tool's.
   */
  listTablesBySession(sessionId: string): TableRecord[];
  /**
   * The same rows with `content` blanked, for the thread classifier.
   *
   * A separate statement rather than a flag on the one above, and the reason is size: a table's
   * markdown is thousands of characters, the classifier is shown a name and a summary, and
   * reading what it cannot be shown into memory once per turn is the cost this avoids. The empty
   * string is deliberate — `TableRecord.content` is a required field, and the callers of this
   * read are the two that never look at it.
   */
  listTableBriefsBySession(sessionId: string): TableRecord[];
  /**
   * Owner-scoped list, the API view's own read. Owner in the `WHERE`, not only in the resolution
   * the route performs first.
   */
  listTablesForUser(userId: string, sessionId: string): TableRecord[];
  /**
   * Insert, or revise in place when the conversation already has a table with this name.
   *
   * The same rule as `upsertDiagram`, plus the field this row has and that one does not: a revise
   * moves `content` as well as `summary`, because the row *is* the artifact.
   */
  upsertSessionTable(input: TableUpsert): TableRecord;
  /**
   * Place a table in a thread, once. Returns the rows changed, which is 0 for one already
   * placed — the `thread_id IS NULL` guard is the statement's own, so this is idempotent
   * without a read.
   */
  assignTableToThread(sessionId: string, tableId: string, threadId: string): number;

  /** Per-conversation message counts and summed usage for one workspace, newest first. */
  statsForWorkspace(userId: string, workspaceId: string): WorkspaceStats | undefined;

  /*
   * The usage ledger. Four methods, and the split between them is the permission model rather
   * than a preference: `listUsageRows` with a `userId` is an account reading its own, and the
   * same method without one is an administrator reading everybody's. Nothing here decides which
   * caller may do that — the routes do, exactly as they do for every other owner-scoped read.
   */

  /** Append one call's cost. The one write to the ledger, and it never updates. */
  insertUsageEvent(input: UsageEventInput): void;
  /**
   * The rows in a window, oldest first.
   *
   * Every aggregate on the statistics pages is built from this one read, which is deliberate: a
   * query per breakdown would be four more chances for the totals and the tables beside them to
   * disagree about what the window contains.
   */
  listUsageRows(query: UsageQuery): UsageRow[];
  /** The instant of the first row ever written, or null. How a page says when counting began. */
  usageSince(userId?: string): string | null;
  /** The same numbers for one conversation. `undefined` when it is not the caller's. */
  statsForSessionForUser(userId: string, sessionId: string): SessionStats | undefined;

  listProviders(): ProviderRecord[];
  getProvider(id: string): ProviderRecord | undefined;
  createProvider(input: { id: string; name: string; baseURL: string; apiKey?: string }): ProviderRecord;
  updateProvider(
    id: string,
    input: { name?: string; baseURL?: string; apiKey?: string }
  ): ProviderRecord | undefined;
  /**
   * Marks the provider deleted, and its models with it, in one transaction.
   *
   * The models are the part that needs saying: `models.provider_id` is `ON DELETE CASCADE`,
   * and a soft delete fires no cascade, so without the second `UPDATE` a removed provider
   * would leave its models resolvable and enumerable. They are the same act.
   */
  softDeleteProvider(id: string): void;

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
  /** Marks the model deleted. Returns false when no live model existed. */
  softDeleteModel(id: string): boolean;

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
  /** Marks the parser deleted. Distinct from `enabled`, which is configured-but-not-in-use. */
  softDeleteDocumentParser(id: string): void;

  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;

  /**
   * Run several writes as one.
   *
   * Exposed because a transaction cannot always live *inside* a single accessor. A diagram is
   * two rows written by two domain modules — its own, and the source row for the same file —
   * and a half-landed pair is a file the conversation draws and the registry cannot name. The
   * alternative was a method on `AppDb` that knew about both tables, which would move a domain
   * rule into the table layer to buy atomicity.
   *
   * Nested calls are safe: better-sqlite3 enters a savepoint when a transaction is already
   * open, so a caller that wraps writes another caller also wraps is not an error.
   */
  transaction<T>(fn: () => T): T;
}

export function createDb(dbPath: string): AppDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  /*
   * WAL, so a reader does not block the writer.
   *
   * **Tolerant on purpose**, and the reason is a race this codebase now creates itself: the
   * administrator CLI is designed to be run twice, and the control panel and a terminal can
   * both be open on the same data root. Two processes opening the same *new* file both find it
   * in the default rollback mode and both try to convert — and converting takes an exclusive
   * lock that SQLite will **not** queue for, so the loser gets "database is locked"
   * immediately rather than after the busy timeout.
   *
   * Swallowing that is correct rather than merely convenient: the journal mode is a property of
   * the **file**, not of the connection, so the winner's conversion is the loser's too, and the
   * loser simply carries on in the mode that was just set for it. The alternative — failing —
   * would make one of two identical commands report that the data directory is unreadable.
   */
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // See above: the other process has already put the file in the mode we wanted.
  }
  db.pragma("foreign_keys = ON");

  /*
   * Everything that changes the file's *shape* is one write, with the lock taken up front.
   *
   * Two processes can now do this at once — the administrator CLI is designed to be run
   * twice, and the control panel and a terminal can both be open — and as separate
   * statements the sequence is not safe. `ensureColumn` reads `PRAGMA table_info` and then
   * runs `ALTER TABLE`, so two of them racing both decide the column is missing and one
   * fails; and a write that has to wait for another connection's lock can surface as
   * "database is locked" rather than waiting, when it is an *upgrade* SQLite refuses to
   * retry. `BEGIN IMMEDIATE` is what makes the wait happen at the start, where the busy
   * timeout applies.
   *
   * `journal_mode` above stays outside, deliberately: SQLite will not change it from inside
   * a transaction.
   */
  db.transaction(() => {
    // Creates the tables, or refuses a file this build cannot read. See `schema.ts`.
    applySchema(db);

    // Columns added since `messages` was first written. `applySchema` is `CREATE TABLE IF NOT
    // EXISTS`, so a database that already has the table never gains them from the DDL alone —
    // which is exactly the gap `ensureColumn` exists to close. Nothing to backfill, so the
    // return value is ignored.
    ensureColumn(db, "messages", "stopped", "stopped INTEGER NOT NULL DEFAULT 0");
    /*
     * What the turn *pointed at* — a diagram, a table, a note, or a passage selected in an earlier
     * message. Beside `attachments` rather than merged with it because the two answer different
     * questions: a source is material the model may read on any later turn, a reference is the
     * object of the one question that was asked. Nullable for the same reason: NULL is "this turn
     * pointed at nothing", which is what every message written before the column means.
     */
    ensureColumn(db, "messages", "refs", "refs TEXT");
    /*
     * Which model wrote each message. Additive and nullable: NULL is "this message predates the
     * columns", which is what every row already written means, and a default would have been this
     * app inventing a model for a turn it never recorded.
     */
    ensureColumn(db, "messages", "provider_id", "provider_id TEXT");
    ensureColumn(db, "messages", "provider_name", "provider_name TEXT");
    ensureColumn(db, "messages", "model_id", "model_id TEXT");
    ensureColumn(db, "messages", "model_name", "model_name TEXT");

    /*
     * What a note is *about*, for a note about a 图 or a 表 rather than a passage.
     *
     * `NOT NULL DEFAULT 'text'` rather than a nullable column, and the default is the whole point:
     * every note written before this existed genuinely is a text note, so the default *preserves*
     * what those rows already meant — the `copilots.all_tools NOT NULL DEFAULT 1` argument. NULL
     * would say "we do not know", which is false about every one of them.
     *
     * `target_ref` is nullable, and there NULL is honest: a text note names no figure, so it has
     * no name. The pair is stored beside `message_id`/`quote` rather than replacing them, because
     * the two anchors are alternatives — a note names one thing, and which kind of thing it is, is
     * what `target_kind` says.
     */
    ensureColumn(db, "notes", "target_kind", "target_kind TEXT NOT NULL DEFAULT 'text'");
    ensureColumn(db, "notes", "target_ref", "target_ref TEXT");

    /*
     * Accounts grew a credential, and the four columns are added rather than version-bumped
     * because none of them changes what an existing column means — `username` still names the
     * same person, and `slug` still names the same directory. See the note at the top of
     * `schema.ts` for where the line is.
     *
     * `password_hash` is the one addition with no default, and that is the point: NULL means
     * "this account has never been given a password", which is every row carried over from the
     * build where a username was the credential. `hasPasswordAccounts` reads exactly that, so
     * such an installation reopens the first-run screen instead of becoming one nobody can
     * enter. The other three take defaults that *preserve* what those rows already meant:
     * an account with no roles declared is an ordinary user, and no existing account is
     * disabled or owes a password change.
     */
    ensureColumn(db, "users", "password_hash", "password_hash TEXT");
    ensureColumn(db, "users", "roles", `roles TEXT NOT NULL DEFAULT '["user"]'`);
    ensureColumn(db, "users", "must_change_password", "must_change_password INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "users", "disabled", "disabled INTEGER NOT NULL DEFAULT 0");
    // The account's self-description, which reaches the model as `chat.system.about`. A column
    // rather than a row in `app_settings` because it is per account, and `CREATE TABLE IF NOT
    // EXISTS` skips a table that already exists — so the DDL above only ever reaches a new install.
    ensureColumn(db, "users", "about", "about TEXT NOT NULL DEFAULT ''");

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
     * Workspaces grew settings of their own — the defaults a conversation in them inherits.
     *
     * Nullable and with no default, for the `copilots.widgets` reason exactly: there is no
     * value that preserves what existing rows "already meant", because they meant nothing.
     * NULL is "nobody has chosen", which resolves down the chain to the built-in default.
     */
    ensureColumn(db, "workspaces", "settings", "settings TEXT");

    /*
     * The two descriptions, added together because they are one feature: a workspace and a
     * conversation each gained a note the account writes for itself.
     *
     * `NOT NULL DEFAULT ''` rather than nullable, unlike `settings` right above — and the
     * difference is what the column means. "Nobody chose" and "chose nothing" are genuinely
     * different claims about a *setting*, which changes behaviour; a description changes no
     * behaviour, so an empty one and an absent one would be two spellings of the same fact.
     */
    ensureColumn(db, "workspaces", "description", "description TEXT NOT NULL DEFAULT ''");
    ensureColumn(db, "sessions", "description", "description TEXT NOT NULL DEFAULT ''");

    /*
     * How the auto-titler last left the row: `'model'`, `'fallback'`, or `NULL` for never
     * attempted.
     *
     * `title_source` beside it says *who owns* the title, which is a different question — and the
     * one this answers is the retry's: a conversation whose title came out as the user's own
     * clipped words had a model call that failed, and nothing else recorded that. The two values
     * are a closed set the readers compare exactly, so an unknown one (a downgrade) reads as "no
     * attempt" and is offered a retry rather than trusted.
     */
    ensureColumn(db, "sessions", "title_state", "title_state TEXT");

    /*
     * Whether the reader pinned this conversation to the top of the sidebar's list.
     *
     * A boolean column rather than a `pinned_at` timestamp, because the ordering inside the
     * pinned group is the ordinary `updated_at DESC` one — pinning lifts a conversation into the
     * group, it does not decide where it sits in it, and pinning is not activity, so it must not
     * move the row within a group either. See `stmtSetSessionPinnedForUser`.
     */
    ensureColumn(db, "sessions", "pinned", "pinned INTEGER NOT NULL DEFAULT 0");

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

    /*
     * Quiz questions gained the model's answer key. Both columns are nullable and stay
     * server-side: nothing to backfill, and a row written before them simply has no key,
     * which is the same quiz posed without one.
     */
    ensureColumn(db, "quiz_questions", "reference_answer_json", "reference_answer_json TEXT");
    ensureColumn(db, "quiz_questions", "explanation", "explanation TEXT");

    /*
     * The soft delete, on every application entity. Nullable and nothing to backfill: NULL is
     * "live", which is what a row written before this column existed means. Added by
     * `ensureColumn` rather than by the DDL above for the usual reason — `CREATE TABLE IF NOT
     * EXISTS` skips a table that is already there, so an existing install would never gain it
     * and would keep hard-deleting.
     *
     * The on-disk side is deliberately untouched: workspace and session directories, and a
     * source's raw and parsed files, all stay. A deleted row is hidden, not destroyed.
     */
    for (const table of [
      "workspaces",
      "copilots",
      "sessions",
      "messages",
      "providers",
      "models",
      "document_parsers",
    ]) {
      ensureColumn(db, table, "deleted_at", "deleted_at TEXT");
    }

    /*
     * The thread widget names the topic chain a message belongs to. Nullable and nothing to
     * backfill: a message written before the column simply reads as "not classified yet",
     * which is the same state a freshly-sent message is in until the post-turn sync runs.
     * The index covers both the pending read (thread_id IS NULL) and the thread join.
     */
    ensureColumn(db, "messages", "thread_id", "thread_id TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(session_id, thread_id, created_at)"
    );
  }).immediate();

  const now = () => new Date().toISOString();

  /* --------------------------------- users -------------------------------- */
  const stmtListUsers = db.prepare("SELECT * FROM users ORDER BY username COLLATE NOCASE ASC");
  const stmtGetUser = db.prepare("SELECT * FROM users WHERE id = ?");
  // `COLLATE NOCASE` on the comparison, not just on the index: the index is what makes it
  // fast, but spelling it here is what makes it true for a `username` written by anything
  // other than this statement.
  const stmtFindUserByUsername = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE");
  const stmtCreateUser = db.prepare(
    `INSERT INTO users (id, username, slug, password_hash, roles, must_change_password, created_at)
     VALUES (@id, @username, @slug, @passwordHash, @roles, @mustChangePassword, @createdAt)`
  );
  const stmtSetUserPassword = db.prepare(
    "UPDATE users SET password_hash = @passwordHash, must_change_password = @mustChangePassword WHERE id = @id"
  );
  const stmtSetUserRoles = db.prepare("UPDATE users SET roles = @roles WHERE id = @id");
  const stmtSetUserDisabled = db.prepare("UPDATE users SET disabled = @disabled WHERE id = @id");
  const stmtSetUserAbout = db.prepare("UPDATE users SET about = @about WHERE id = @id");
  // `EXISTS` rather than a count: the question is yes or no, and the plan stops at the first
  // row instead of walking an index over every account.
  const stmtHasPasswordAccounts = db.prepare(
    "SELECT EXISTS (SELECT 1 FROM users WHERE password_hash IS NOT NULL) AS found"
  );

  /* ------------------------------- auth tokens ------------------------------ */
  const stmtCreateAuthToken = db.prepare(
    `INSERT INTO auth_tokens (id, user_id, kind, expires_at, created_at)
     VALUES (@id, @userId, @kind, @expiresAt, @createdAt)`
  );
  const stmtGetAuthToken = db.prepare("SELECT * FROM auth_tokens WHERE id = ?");
  const stmtTouchAuthToken = db.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE id = ?");
  const stmtRevokeAuthToken = db.prepare(
    "UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL"
  );
  // Scoped to rows that are still live, so the count means "sessions ended" rather than
  // "rows touched", and re-running it is honestly zero.
  const stmtRevokeUserTokens = db.prepare(
    "UPDATE auth_tokens SET revoked_at = @at WHERE user_id = @userId AND revoked_at IS NULL"
  );
  const stmtRevokeUserTokensOfKind = db.prepare(
    `UPDATE auth_tokens SET revoked_at = @at
      WHERE user_id = @userId AND kind = @kind AND revoked_at IS NULL`
  );
  const stmtPruneAuthTokens = db.prepare(
    "DELETE FROM auth_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)"
  );



  /*
   * Labelling a list that spans the account, which is what the library and `ila_explore` both
   * need: a *conversation* is not something the client can name, and fetching every conversation
   * of every workspace to label a row is a request per workspace. Two statements rather than one
   * with a nullable ordering column, because the ordering is what one reader wants and the other
   * has no use for.
   */
  const stmtListSessionLabels = db.prepare(
    `SELECT s.id, s.title, w.id AS workspace_id, w.name AS workspace_name
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE w.user_id = ? AND s.deleted_at IS NULL AND w.deleted_at IS NULL`
  );
  const stmtListSessionOverviews = db.prepare(
    `SELECT s.id, s.title, s.updated_at, w.id AS workspace_id, w.name AS workspace_name
       FROM sessions s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE w.user_id = ? AND s.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY s.updated_at DESC, s.id DESC`
  );
  /*
   * The message search, and every clause in it is a rule from somewhere else in this file.
   *
   * `deleted_at IS NULL` on **all three** tables — a peeled message, a deleted conversation and a
   * deleted workspace each hide their rows, and the conversation arm is what makes "deleting one
   * workspace hides a whole tree" true here as everywhere else.
   *
   * `LIKE ... ESCAPE '\'` with the pattern escaped by the caller (`likePattern`), so a `%` or an
   * `_` the user actually typed is a character rather than a wildcard — the same escaping the work
   * resource listing does.
   *
   * `LOWER(m.content) LIKE LOWER(@query)` rather than `LIKE` with a collation: SQLite's built-in
   * `NOCASE` is ASCII-only, and the material this searches is as likely to be Chinese as not,
   * where case does not arise. `LOWER` uppercases nothing there and leaves an ASCII query working.
   *
   * The workspace set arrives as JSON through `json_each`, the shape `stmtListReadableWorkResources`
   * already uses for the same purpose. An empty array matches nothing, which is the answer a
   * caller with no grant should get.
   *
   * Ordered by the *message's* own time, newest first: a search is a "when did anybody say this"
   * question, and the conversation a hit belongs to is on the row either way.
   */
  const stmtSearchMessages = db.prepare(
    `SELECT m.id AS message_id, m.role, m.content, m.created_at,
            s.id, s.title, w.id AS workspace_id, w.name AS workspace_name
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE w.user_id = @userId
        AND m.deleted_at IS NULL AND s.deleted_at IS NULL AND w.deleted_at IS NULL
        AND s.workspace_id IN (SELECT value FROM json_each(@workspaceIds))
        AND LOWER(m.content) LIKE LOWER(@query) ESCAPE '\\'
      ORDER BY m.created_at DESC, m.id DESC`
  );

  /*
   * The join every work-resource read shares.
   *
   * Both entity joins are conditional on `resource_type` **inside the ON clause**, which is what
   * makes one statement serve a polymorphic foreign key: SQLite evaluates the constant against
   * the outer row, so exactly one side can match and the other's columns are all NULL. The
   * alternative — a `UNION ALL` of two nearly identical selects — is what the v3 listing did for
   * its three arms, and the duplication it costs is a second place for a filter to be added to
   * only one of them.
   *
   * `*_deleted_at IS NULL` is in the ON clause rather than the WHERE, deliberately: putting it
   * in the WHERE would turn the LEFT JOIN into an INNER one and *hide* a reference whose entity
   * was deleted, which would make `entityOf`'s undefined branch unreachable and the caller's
   * reasoning a lie. Here the entity's columns come back NULL and the caller decides.
   */
  const WR_SELECT = `
    SELECT wr.*,
           f.id          AS file_entity_id,
           f.source_type AS file_source_type,
           f.title       AS file_title,
           f.path        AS file_path,
           f.mime_type   AS file_mime_type,
           f.category    AS file_category,
           f.size        AS file_size,
           f.summary     AS file_summary,
           f.created_at  AS file_created_at,
           f.updated_at  AS file_updated_at,
           p.id          AS page_entity_id,
           p.source_type AS page_source_type,
           p.url         AS page_url,
           p.title       AS page_title,
           p.summary     AS page_summary,
           p.created_at  AS page_created_at,
           p.updated_at  AS page_updated_at
      FROM work_resources wr
      LEFT JOIN files f
        ON wr.resource_type = 'file' AND f.id = wr.resource_id AND f.deleted_at IS NULL
      LEFT JOIN web_pages p
        ON wr.resource_type = 'web_page' AND p.id = wr.resource_id AND p.deleted_at IS NULL`;

  const stmtGetFileForUser = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  );
  const stmtGetFileByPath = db.prepare(
    "SELECT * FROM files WHERE user_id = ? AND path = ? AND deleted_at IS NULL"
  );
  const stmtListFilesForUser = db.prepare(
    "SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at ASC"
  );
  /*
   * The live hash lookup and the deleted one, the pair the soft delete's revive policy needs.
   * `source_type IN ('upload','attachment')` restates what `idx_files_blob` already encodes —
   * the dedupe rule is about bytes a person supplied, and a parse result is not one.
   */
  const stmtFindFileByHash = db.prepare(
    `SELECT * FROM files
      WHERE user_id = ? AND sha256 = ? AND sha256 IS NOT NULL
        AND source_type IN ('upload', 'attachment') AND deleted_at IS NULL`
  );
  const stmtFindDeletedFileByHash = db.prepare(
    `SELECT * FROM files
      WHERE user_id = ? AND sha256 = ? AND sha256 IS NOT NULL
        AND source_type IN ('upload', 'attachment') AND deleted_at IS NOT NULL`
  );
  const stmtCreateFile = db.prepare(
    `INSERT INTO files
       (id, user_id, source_type, title, path, mime_type, category, size, summary, sha256, created_at)
     VALUES (@id, @userId, @sourceType, @title, @path, @mimeType, @category, @size, @summary,
             @sha256, @createdAt)`
  );
  /*
   * Every column written on every update, with the row's own value as the fallback — the
   * `stmtUpdateSourcePlace` shape, and the same reason: the patch is partial and the row is the
   * default, so one statement says "whatever the caller did not mention stays". `summary` keeps
   * its separate `@summarySet` flag, because a caller may legitimately want to *clear* it.
   */
  const stmtUpdateFilePath = db.prepare(
    `UPDATE files
        SET path = COALESCE(@path, path),
            title = COALESCE(@title, title),
            mime_type = COALESCE(@mimeType, mime_type),
            category = COALESCE(@category, category),
            size = COALESCE(@size, size),
            summary = CASE WHEN @summarySet = 1 THEN @summary ELSE summary END,
            updated_at = @updatedAt
      WHERE id = @id AND user_id = @userId AND deleted_at IS NULL`
  );
  const stmtSoftDeleteFileForUser = db.prepare(
    "UPDATE files SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  );
  /*
   * A rename moves the *name* as well as the place, and a reference carries its own copy of it.
   *
   * Without this the library would go on showing the name a file had when it was first
   * referenced — a rename in the file tree that visibly did not take effect in the panel that
   * lists the same file. One statement per file rather than a join in every read, because a
   * rename is rare and a listing is not.
   */
  const stmtRetitleWorkResourcesForFile = db.prepare(
    `UPDATE work_resources SET title = @title, updated_at = @updatedAt
      WHERE user_id = @userId AND resource_type = 'file' AND resource_id = @fileId
        AND deleted_at IS NULL`
  );
  const stmtReviveFileForUser = db.prepare(
    `UPDATE files SET deleted_at = NULL WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL
       RETURNING *`
  );

  const stmtGetWebPageForUser = db.prepare(
    "SELECT * FROM web_pages WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  );
  const stmtSoftDeleteWebPageForUser = db.prepare(
    "UPDATE web_pages SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  );
  const stmtFindWebPageByHash = db.prepare(
    "SELECT * FROM web_pages WHERE user_id = ? AND sha256 = ? AND deleted_at IS NULL"
  );
  const stmtCreateWebPage = db.prepare(
    `INSERT INTO web_pages (id, user_id, source_type, url, title, summary, sha256, created_at)
     VALUES (@id, @userId, @sourceType, @url, @title, @summary, @sha256, @createdAt)`
  );
  const stmtUpdateWebPage = db.prepare(
    `UPDATE web_pages
        SET url = COALESCE(@url, url),
            title = COALESCE(@title, title),
            summary = CASE WHEN @summarySet = 1 THEN @summary ELSE summary END,
            updated_at = @updatedAt
      WHERE id = @id AND user_id = @userId AND deleted_at IS NULL`
  );

  /*
   * The write that makes a file referenceable, and **the only one that may**.
   *
   * One statement, with the ownership check and the insert together, which is the shape
   * `stmtLinkSourceToWorkspace` had and for the reason its docblock gives: an id from another
   * account must not be able to become a row. `ON CONFLICT DO UPDATE` rather than
   * `INSERT OR IGNORE`, because re-referencing is the ordinary case (an `@`-reference to
   * something already held) and the caller wants the row back either way — but only the title
   * moves, so a re-reference does not reset a parse or a summary somebody already has.
   *
   * The partial index means the conflict target has to repeat its predicate.
   */
  const stmtUpsertWorkResource = db.prepare(
    `INSERT INTO work_resources
       (id, user_id, resource_type, resource_id, owner_type, owner_id, title, summary,
        parse_status, created_at)
     SELECT @id, @userId, @resourceType, @resourceId, @ownerType, @ownerId, @title, @summary,
            'none', @createdAt
       FROM (SELECT 1) WHERE (
         @resourceType = 'file' AND EXISTS (
           SELECT 1 FROM files f WHERE f.id = @resourceId AND f.user_id = @userId AND f.deleted_at IS NULL)
       ) OR (
         @resourceType = 'web_page' AND EXISTS (
           SELECT 1 FROM web_pages p WHERE p.id = @resourceId AND p.user_id = @userId AND p.deleted_at IS NULL)
       )
     ON CONFLICT(user_id, owner_type, owner_id, resource_type, resource_id)
       WHERE deleted_at IS NULL
       DO UPDATE SET title = excluded.title, updated_at = @createdAt
     RETURNING *`
  );
  const stmtGetWorkResourceForUser = db.prepare(
    `${WR_SELECT} WHERE wr.id = ? AND wr.user_id = ? AND wr.deleted_at IS NULL`
  );
  /*
   * The listing's "how many owners hold this", for every row at once.
   *
   * Grouped by entity rather than by owner, because the question the library asks is about the
   * *file*: one reference per row would answer "does this owner hold it" — which is true of every
   * row it was asked about — and the fact that matters is whether anybody else does.
   */
  const stmtCountReferences = db.prepare(
    `SELECT resource_id, COUNT(*) AS n
       FROM work_resources
      WHERE user_id = @userId AND deleted_at IS NULL
        AND resource_type = @resourceType
        AND resource_id IN (SELECT value FROM json_each(@resourceIds))
      GROUP BY resource_id`
  );

  /*
   * The reference relation's statements. Small on purpose: a reference is the fact that a
   * conversation is about a work resource, so there is nothing to update and nothing to
   * soft-delete — the row is either there or it is not. See `session_references` in the schema.
   *
   * **There is no delete-sweep among them, and its absence is the v5 rule.** v4 swept this table
   * when a file's bytes went; a link now survives that, because what it names is a *reference* —
   * one that may itself be revived — and because a conversation's record of having been about
   * something is not the delete's to rewrite. Every reader reports a dangling link instead: the
   * panel and the whitelist omit it, and the chip in a message says the object is gone.
   */
  const stmtUpsertSessionReference = db.prepare(
    `INSERT INTO session_references (id, session_id, work_resource_id, created_at)
     VALUES (@id, @sessionId, @workResourceId, @createdAt)
     ON CONFLICT(session_id, work_resource_id) DO NOTHING`
  );
  const stmtListSessionReferences = db.prepare(
    `SELECT work_resource_id FROM session_references WHERE session_id = ?`
  );
  /**
   * The reference half of `countReferencesForEntities` — see there for why both are counted.
   *
   * Through the entity rather than by it: a link names a work resource, so the link belongs to
   * entity E when the row it names *is* a reference to E. That join is what makes this count the
   * same number it counted in v4 — every holder, plus every conversation pointing at any of them.
   */
  const stmtCountSessionReferences = db.prepare(
    `SELECT wr.resource_id AS resource_id, COUNT(*) AS n
       FROM session_references sr
       JOIN work_resources wr ON wr.id = sr.work_resource_id
      WHERE wr.user_id = @userId
        AND wr.resource_type = @resourceType
        AND wr.resource_id IN (SELECT value FROM json_each(@resourceIds))
      GROUP BY wr.resource_id`
  );

  /** Every live reference to one entity — what answers "is this file still referenced". */
  const stmtListWorkResourcesForResource = db.prepare(
    `${WR_SELECT} WHERE wr.user_id = @userId AND wr.resource_type = @resourceType
        AND wr.resource_id = @resourceId AND wr.deleted_at IS NULL`
  );
  /*
   * The library's list, filtered.
   *
   * Filtered **in the query**, not over the result, because the reader `stat`s every row it is
   * given — the v3 argument, unchanged: a workspace with a thousand files would otherwise make
   * "show me my documents" cost a thousand metadata calls to then discard them all.
   *
   * One statement with `@x IS NULL OR …` guards rather than a statement per combination: each
   * filter is independent, and eight of them is a combinatorial number of statements. The
   * `resource_type`/`owner_type` pair rides `idx_wr_resource` and `idx_wr_owner`; the `user_id`
   * index carries the query.
   *
   * **A reference whose entity is gone is hidden**, not returned with a null entity: the entity
   * is what the row is *about*, and a row about nothing is not a row the library can draw. That
   * is the `f.id IS NOT NULL OR p.id IS NOT NULL` arm, and it is why the joins are LEFT in the
   * shared prefix — an INNER JOIN would silently do the same thing for a different reason and
   * make `entityOf`'s undefined branch look dead.
   *
   * The two scope filters read wider than ownership, and both directions are the v3 ones:
   *
   * - **A workspace** holds what it owns *and* what its conversations own, because a file
   *   uploaded into a conversation is readable from the whole workspace.
   * - **A conversation** holds what it owns, plus **the references it points at** — see below.
   *
   * Neither looks at whether the owning conversation is soft-deleted: deleting a conversation
   * hides the conversation, not the files it produced.
   *
   * **A session-scoped listing is "what this conversation holds or points at", one row per
   * relation.** The second half is a `session_references` lookup by *reference id*, which is what
   * makes the panel's answer exactly the rows the user's `@` chose: it used to store the entity,
   * so this arm matched every holder of anything the conversation had referred to — a file held
   * by three owners arrived in a fourth conversation's panel as three identical rows. It is one
   * row per link now, and no dedupe is needed to get there: the link is the row.
   *
   * The link is followed *through* `work_resources` rather than being trusted: a link whose row
   * was deleted (or whose entity was) resolves to nothing here, which is how a dangling reference
   * reports itself. See `session_references` in the schema.
   */
  const stmtListWorkResourcesFiltered = db.prepare(
    `${WR_SELECT}
      WHERE wr.user_id = @userId AND wr.deleted_at IS NULL
        AND (f.id IS NOT NULL OR p.id IS NOT NULL)
        AND (@resourceType IS NULL OR wr.resource_type = @resourceType)
        AND (@category IS NULL OR f.category = @category)
        AND (@ownerType IS NULL OR wr.owner_type = @ownerType)
        AND (@mime IS NULL OR f.mime_type = @mime)
        AND (@name IS NULL OR wr.title LIKE @name ESCAPE '\\')
        AND (@workspaceId IS NULL OR (
              (wr.owner_type = 'workspace' AND wr.owner_id = @workspaceId)
              OR (wr.owner_type = 'session' AND wr.owner_id IN (
                    SELECT s.id FROM sessions s WHERE s.workspace_id = @workspaceId))
            ))
        AND (@sessionId IS NULL OR (
              (wr.owner_type = 'session' AND wr.owner_id = @sessionId)
              OR wr.id IN (
                SELECT sr.work_resource_id FROM session_references sr
                 WHERE sr.session_id = @sessionId)))
      ORDER BY wr.created_at ASC, wr.id ASC`
  );
  const stmtSoftDeleteWorkResourceForUser = db.prepare(
    "UPDATE work_resources SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  );
  const stmtUpdateWorkResourceParse = db.prepare(
    `UPDATE work_resources
        SET parse_status = @status, parse_error = @error, parse_error_code = @code,
            parser_id = @parserId, parsed_chars = @parsedChars, page_count = @pageCount,
            parsed_file_id = COALESCE(@parsedFileId, parsed_file_id),
            parse_updated_at = @updatedAt
      WHERE id = @id AND user_id = @userId AND deleted_at IS NULL`
  );
  /*
   * The read whitelist, and the three arms are the v3 ones over a single table.
   *
   * - **Arm 1** is the conversation's own material.
   * - **Arm 2** is the current workspace's own, plus any granted one.
   * - **Arm 3** is what the workspace's *conversations* hold — and it covers the current
   *   workspace as well as the granted ones.
   *
   * That last clause is the v4 replacement for a mechanism v3 had in the *writer*: an upload
   * wrote a `session_sources` row and a `workspace_sources` row, and arm 2 read the second, which
   * is what made a document uploaded in one conversation readable from a sibling. Here the
   * reference is one row owned by the conversation, so the *reader* is what has to widen — and
   * there is one row rather than two, which is also why the library lists an upload once.
   *
   * **The arms are ranked, and it is the *entity* they must not repeat.** Several references can
   * point at one file — a conversation's own upload and the reference a sibling holds to the same
   * bytes are two rows — so "what may the model read" has to answer once per file or the same
   * document reaches the prompt twice. Arm 1 wins, then the workspace's, then a sibling's, and
   * each arm skips an entity a nearer arm already answered for. Arm 3 also excludes `@sessionId`
   * outright: arm 1 is that arm.
   *
   * The v3 statement got the same answer out of a `UNION ALL` under `MIN(linked_at)` and a
   * `GROUP BY`. This is the same ranking expressed as an exclusion, which needs no aggregate and
   * no bare-column-with-`MIN` trick.
   *
   * Without arm 3's conversations-of-a-granted-workspace clause, `ila_explore`'s `messages` would
   * name ids that resolve to nothing, which reads as a broken tool.
   *
   * **Both arms check that the workspace is live, and arm 2 only needs to under `all`.** A named
   * grant is live by construction — `resolveWorkspaceScope` re-derives the ids from the account's
   * workspaces every turn, so a deleted one never reaches `@scopeIds`. But `all` is a *flag*, and
   * arm 2's disjunction short-circuits on it, so "every workspace" admitted one that had been
   * deleted: deletion is soft and dismantles nothing, so the material stayed readable by
   * `read_document`, `ila_query kind "resource"` and the chips route — with nothing on screen
   * naming the workspace it came from. v3's own arm 2 joined `workspaces` and checked
   * `deleted_at`; the v4 rewrite reads `work_resources` directly and the predicate was dropped
   * with the join. The `EXISTS` carries `user_id` for arm 3's reason: the owner is an id from a
   * settings blob, and this is what says it names *this* account's workspace.
   *
   * **Arm 1 is the conversation's *reach*, not only its holdings.** Its second half is a
   * `session_references` lookup by **reference id**: the rows this conversation *pointed at*,
   * which is the relation a `@` writes and a holding row is not. That half is what makes pointing
   * at something sticky — a file in a granted workspace stays readable after the grant is
   * withdrawn, because the conversation was pointed at it once. The row that comes back is the
   * one the user chose, so the id the model reads through is exactly the one `messages.refs`
   * replays and the chip names. (v4 looked this up by *entity*, which made "referred to" mean
   * "any holder of", and handed the model whichever holder the join reached first.)
   *
   * `linked_at` is `wr.created_at`, and there is no `MIN(...)`/`GROUP BY` any more. That
   * machinery existed because an upload wrote a row in *two* link tables with two `now()` calls,
   * so the same file could come back twice. The four-part unique index makes one row per
   * owner+entity, so a duplicate is not merely unlikely — it is unrepresentable.
   *
   * The ids reach `json_each` as a JSON array built by `scopeIdsJson`, the only place that value
   * is built: `json_each('')` raises, and a raise here is a 500 on every turn.
   */
  const stmtListReadableWorkResources = db.prepare(
    `${WR_SELECT}
      WHERE wr.user_id = @userId AND wr.deleted_at IS NULL
        AND (f.id IS NOT NULL OR p.id IS NOT NULL)
        AND (
          (wr.owner_type = 'session' AND wr.owner_id = @sessionId)
          OR wr.id IN (
            SELECT sr.work_resource_id FROM session_references sr
             WHERE sr.session_id = @sessionId)
          OR (wr.owner_type = 'workspace'
              AND EXISTS (
                SELECT 1 FROM workspaces w
                 WHERE w.id = wr.owner_id AND w.user_id = @userId AND w.deleted_at IS NULL)
              AND (
                @scopeAll = 1 OR wr.owner_id = @workspaceId
                OR wr.owner_id IN (SELECT value FROM json_each(@scopeIds)))
              AND NOT EXISTS (
                SELECT 1 FROM work_resources mine
                 WHERE mine.user_id = @userId AND mine.deleted_at IS NULL
                   AND mine.owner_type = 'session' AND mine.owner_id = @sessionId
                   AND mine.resource_type = wr.resource_type
                   AND mine.resource_id = wr.resource_id))
          OR (wr.owner_type = 'session' AND wr.owner_id <> @sessionId AND wr.owner_id IN (
                SELECT s.id FROM sessions s
                 JOIN workspaces w ON w.id = s.workspace_id
                WHERE w.user_id = @userId AND s.deleted_at IS NULL AND w.deleted_at IS NULL
                  AND (@scopeAll = 1 OR s.workspace_id = @workspaceId
                       OR s.workspace_id IN (SELECT value FROM json_each(@scopeIds))))
              AND NOT EXISTS (
                SELECT 1 FROM work_resources mine
                 WHERE mine.user_id = @userId AND mine.deleted_at IS NULL
                   AND mine.resource_type = wr.resource_type
                   AND mine.resource_id = wr.resource_id
                   AND (mine.owner_id = @sessionId
                        OR (mine.owner_type = 'workspace' AND (
                              @scopeAll = 1 OR mine.owner_id = @workspaceId
                              OR mine.owner_id IN (SELECT value FROM json_each(@scopeIds)))))))
        )
      ORDER BY wr.created_at ASC, wr.id ASC`
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
     FROM workspaces w
     LEFT JOIN sessions s ON s.workspace_id = w.id AND s.deleted_at IS NULL
     WHERE w.user_id = ? AND w.deleted_at IS NULL GROUP BY w.id ORDER BY w.created_at ASC`
  );
  const stmtGetWorkspaceForUser = db.prepare(
    "SELECT * FROM workspaces WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
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
     FROM workspaces w
     LEFT JOIN sessions s ON s.workspace_id = w.id AND s.deleted_at IS NULL
     WHERE w.id = ? AND w.user_id = ? AND w.deleted_at IS NULL GROUP BY w.id`
  );
  /*
   * `description` is written here rather than left to the column's default for the reason the
   * route gives: the field is filled in before the workspace exists, so the description is part
   * of what is being created rather than a correction to it.
   */
  const stmtCreateWorkspace = db.prepare(
    `INSERT INTO workspaces (id, user_id, name, slug, dir_path, description, created_at)
     VALUES (@id, @userId, @name, @slug, @dirPath, @description, @createdAt)`
  );
  /*
   * `COALESCE`, so "not mentioned" and "set to the empty string" stay different answers — the
   * `stmtUpdateSourcePlace` shape, and the reason the route can send either field or both.
   */
  const stmtPatchWorkspaceForUser = db.prepare(
    `UPDATE workspaces
        SET name = COALESCE(@name, name),
            description = COALESCE(@description, description)
      WHERE id = @id AND user_id = @userId AND deleted_at IS NULL`
  );
  const stmtSetWorkspaceSettingsForUser = db.prepare(
    "UPDATE workspaces SET settings = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  );
  const stmtSoftDeleteWorkspaceForUser = db.prepare(
    "UPDATE workspaces SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
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
       AND c.deleted_at IS NULL
     ORDER BY c.created_at ASC`
  );
  const stmtGetCopilotForUser = db.prepare(
    `${copilotSelect} WHERE c.id = ? AND c.user_id IS NOT NULL
       AND (c.user_id = ? OR c.visibility = 'public') AND c.deleted_at IS NULL`
  );
  const stmtGetOwnedCopilot = db.prepare(
    `${copilotSelect} WHERE c.id = ? AND c.user_id = ? AND c.deleted_at IS NULL`
  );
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
     WHERE id = @id AND user_id = @userId AND deleted_at IS NULL`
  );
  const stmtSoftDeleteCopilotForUser = db.prepare(
    "UPDATE copilots SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  );

  /* ------------------------------- sessions ------------------------------- */
  /*
   * A session's owner is reached through its workspace, so these joins *are* the scoping.
   * There is no `sessions.user_id` and deliberately so: a second copy of the owner is a
   * second thing that has to stay in agreement, and the day the two disagree is the day one
   * account reads another's conversation.
   */
  /*
   * Pinned first, then by recency — and the two keys have to agree with the split the sidebar
   * makes, or a list rendered in this order would interleave the groups it draws. The sidebar
   * partitions on `pinned` rather than trusting the position of the boundary, so this is the
   * order *within* each group and the partition is the flag; the two are one answer stated twice
   * because a consumer reading this array in order must see the same thing.
   */
  const stmtListSessionsForUser = db.prepare(
    `SELECT s.* FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.workspace_id = ? AND w.user_id = ?
       AND s.deleted_at IS NULL AND w.deleted_at IS NULL
     ORDER BY s.pinned DESC, s.updated_at DESC`
  );
  const stmtGetSessionForUser = db.prepare(
    `SELECT s.* FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.id = ? AND w.user_id = ?
       AND s.deleted_at IS NULL AND w.deleted_at IS NULL`
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
       description = @description, updated_at = @updatedAt
      WHERE id = @id AND deleted_at IS NULL
        AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = @userId AND deleted_at IS NULL)`
  );
  /*
   * The auto-titler's write, and `title_source = 'auto'` is part of the statement rather than of
   * its callers' checks.
   *
   * Both callers read the session first and then call this, which is a window the user can rename
   * in — and a rename is permanent by design, so an automatic title landing after one would
   * overwrite the name a person chose. Reading first and writing second is a check somebody has to
   * remember on the next call site; in the `WHERE` it is the write's own answer, and `changes === 0`
   * is how the caller learns it lost the race.
   */
  const stmtSetAutoTitleForUser = db.prepare(
    `UPDATE sessions SET title = ?, title_state = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL AND title_source = 'auto'
        AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = ? AND deleted_at IS NULL)`
  );
  /*
   * The auto-titler's *other* write: it looked, and there was nothing to name.
   *
   * Same guard as the statement above, and the title column is not in the `SET` at all — the
   * placeholder stays, which is what "still unnamed" means. `updated_at` is absent for the reason
   * the pin toggle gives below: it is not activity. Nothing about the conversation changed, and a
   * decline bumping it would reorder the sidebar to say a conversation had moved when all that
   * happened is that a question was answered with "not yet".
   */
  const stmtSetTitleStateForUser = db.prepare(
    `UPDATE sessions SET title_state = ?
      WHERE id = ? AND deleted_at IS NULL AND title_source = 'auto'
        AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = ? AND deleted_at IS NULL)`
  );
  const stmtSoftDeleteSessionForUser = db.prepare(
    `UPDATE sessions SET deleted_at = ?
      WHERE id = ? AND deleted_at IS NULL
        AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = ? AND deleted_at IS NULL)`
  );
  /*
   * The pin toggle, and `updated_at` is absent from the `SET` on purpose.
   *
   * Every other session write bumps it, because every other one is somebody touching the
   * conversation. A pin is a statement about where the row should be listed, not about the
   * conversation having moved — and if it bumped the timestamp, then unpinning would drop the
   * conversation at the *top* of the other group, so the two halves of one toggle would produce
   * an ordering neither of them asked for. The list is sorted on `updated_at`, so leaving it
   * alone is the whole of "pinning does not reorder anything but the group".
   *
   * The owner is in this statement's own `WHERE` rather than behind a read, the
   * `setAutoTitleForUser` argument: `changes === 0` is then the answer to "was there a live
   * session of yours", and no caller can forget to ask.
   */
  const stmtSetSessionPinnedForUser = db.prepare(
    `UPDATE sessions SET pinned = ?
      WHERE id = ? AND deleted_at IS NULL
        AND workspace_id IN (SELECT id FROM workspaces WHERE user_id = ? AND deleted_at IS NULL)`
  );
  const stmtTouchSession = db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");

  /* ----------------------------- session locks ---------------------------- */
  /*
   * Acquire, renew and release in one statement each.
   *
   * The `WHERE` on the upsert is the **whole of the concurrency control**, which is the same
   * shape `setAutoTitleForUser` uses and for the same reason: a read followed by a write is a
   * window two callers both pass. A row is claimable when it has expired or when it is already
   * this client's, so `changes === 0` means exactly "a live lease held by somebody else" and
   * needs no second query to interpret.
   *
   * Re-entry falls out of that rather than being a branch: the same client's second call matches
   * `client_id = @clientId`, takes the DO UPDATE path, and is a heartbeat. `acquired_at` is kept
   * on that path because it is the one column a beat must *not* move — it answers when this
   * client first took the conversation, and resetting it every minute would make it a second
   * `expires_at`.
   */
  const stmtAcquireSessionLock = db.prepare(
    `INSERT INTO session_locks (session_id, client_id, acquired_at, expires_at)
     SELECT s.id, @clientId, @now, @expiresAt
       FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.id = @sessionId AND w.user_id = @userId
        AND s.deleted_at IS NULL AND w.deleted_at IS NULL
     ON CONFLICT(session_id) DO UPDATE SET
       client_id = @clientId,
       acquired_at = CASE WHEN session_locks.client_id = @clientId
                          THEN session_locks.acquired_at ELSE @now END,
       expires_at = @expiresAt
     WHERE session_locks.expires_at <= @now OR session_locks.client_id = @clientId`
  );
  /*
   * Release. Owner-checked in the statement, and an expired row counts as releaseable: it is not
   * anybody's any more, so letting its former holder clean it up is harmless and saves a beat.
   * Note the *shape* of the owner check — a subquery rather than a join, because SQLite's DELETE
   * has no join.
   */
  const stmtReleaseSessionLock = db.prepare(
    `DELETE FROM session_locks
      WHERE session_id = ? AND (client_id = ? OR expires_at <= ?)
        AND session_id IN (
          SELECT s.id FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
           WHERE w.user_id = ? AND s.deleted_at IS NULL AND w.deleted_at IS NULL)`
  );
  /*
   * The lease on one conversation, for the write gate. The expiry is left to `lockFor` rather
   * than filtered here, so that the rule for "is this lease still alive" exists once and reads
   * the same for the single-session and the workspace-wide question.
   */
  const stmtGetSessionLock = db.prepare(
    `SELECT l.* FROM session_locks l
       JOIN sessions s ON s.id = l.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE l.session_id = ? AND w.user_id = ?
        AND s.deleted_at IS NULL AND w.deleted_at IS NULL`
  );
  /*
   * Every live lease in a workspace, in one query rather than one per conversation — this is what
   * the client polls, and a per-session shape would make the session list N requests on every
   * check. Owner-scoped through the join, exactly as the session list is, so a workspace that is
   * not the caller's returns nothing rather than another account's leases.
   */
  const stmtListSessionLocksForUser = db.prepare(
    `SELECT l.* FROM session_locks l
       JOIN sessions s ON s.id = l.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.workspace_id = ? AND w.user_id = ?
        AND l.expires_at > ?
        AND s.deleted_at IS NULL AND w.deleted_at IS NULL`
  );

  /* ------------------------------- messages ------------------------------- */
  /*
   * Two ways to read the same rows, and the pair is the point: `stmtListMessages` is the
   * unscoped one, used only by the session-id-only accessors above, and the `ForUser` pair
   * is what a route can reach. They are not interchangeable.
   *
   * `deleted_at IS NULL` on all three is the whole soft delete as far as messages go, and it
   * carries more weight here than anywhere else: `stmtListMessages` is also what
   * `listMessagesOf` reads, so this one line hides a deleted message from the conversation,
   * from `findAwaitingToolCall`, and from the history `buildHistoryMessages` turns into the
   * model's context. There is no second place to forget.
   */
  /*
   * One row per model call, with the three labels a table needs and cannot derive: a workspace's
   * title, a conversation's title and an account's name. LEFT JOINs, so a row whose workspace or
   * session is gone still counts — it is spend that happened, and dropping it would make the
   * totals disagree with the breakdowns beside them.
   *
   * The two bounds are compared as ISO strings, which is lexical and therefore correct here for
   * the same reason `auth_tokens.expires_at` is: every instant written by this app is UTC with a
   * fixed width. Either may be NULL, so the same statement serves a bounded and an unbounded query
   * rather than two statements that could disagree about the join.
   */
  const stmtListUsageRows = db.prepare(
    `SELECT e.*, w.name AS workspace_name, s.title AS session_title, u.username AS user_name
       FROM usage_events e
       LEFT JOIN workspaces w ON w.id = e.workspace_id
       LEFT JOIN sessions s ON s.id = e.session_id
       LEFT JOIN users u ON u.id = e.user_id
      WHERE (@userId IS NULL OR e.user_id = @userId)
        AND (@workspaceId IS NULL OR e.workspace_id = @workspaceId)
        AND (@fromIso IS NULL OR e.created_at >= @fromIso)
        AND (@toIso IS NULL OR e.created_at < @toIso)
      ORDER BY e.created_at ASC`
  );
  /** The earliest row there is, which is how a page says when counting began. */
  const stmtUsageSince = db.prepare(
    "SELECT MIN(created_at) AS since FROM usage_events WHERE (@userId IS NULL OR user_id = @userId)"
  );
  const stmtInsertUsageEvent = db.prepare(
    `INSERT INTO usage_events (id, user_id, workspace_id, session_id, message_id, purpose,
                               provider_id, provider_name, model_id, model_name,
                               input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
                               total_tokens, duration_ms, created_at)
     VALUES (@id, @userId, @workspaceId, @sessionId, @messageId, @purpose,
             @providerId, @providerName, @modelId, @modelName,
             @inputTokens, @cachedInputTokens, @outputTokens, @reasoningTokens,
             @totalTokens, @durationMs, @createdAt)`
  );
  const stmtListMessages = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? AND deleted_at IS NULL ORDER BY created_at ASC"
  );
  const stmtListMessagesForUser = db.prepare(
    `SELECT m.* FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE m.session_id = ? AND w.user_id = ?
        AND m.deleted_at IS NULL AND s.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY m.created_at ASC`
  );
  const stmtGetMessageForUser = db.prepare(
    `SELECT m.* FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE m.id = ? AND w.user_id = ?
        AND m.deleted_at IS NULL AND s.deleted_at IS NULL AND w.deleted_at IS NULL`
  );
  /** `createMessage`'s read-back, by primary key on a row this same call just inserted. */
  const stmtGetMessageById = db.prepare("SELECT * FROM messages WHERE id = ?");
  const stmtCreateMessage = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, reasoning, tool_calls, attachments, refs, usage,
                              provider_id, provider_name, model_id, model_name, stopped, created_at)
     VALUES (@id, @sessionId, @role, @content, @reasoning, @toolCalls, @attachments, @refs, @usage,
             @providerId, @providerName, @modelId, @modelName, @stopped, @createdAt)`
  );
  const stmtUpdateToolCalls = db.prepare("UPDATE messages SET tool_calls = ? WHERE id = ?");
  /*
   * Mark one message deleted, scoped to its owner through the session's workspace. No
   * `IS LAST` here on purpose: the caller has just read the live tail inside the same
   * transaction and the check belongs there, where the row it decided about is the row it
   * writes — a subquery repeating "the last one" would be a second opinion about the same
   * question, taken at a different instant.
   */
  const stmtSoftDeleteMessageForUser = db.prepare(
    `UPDATE messages SET deleted_at = @at
      WHERE id = @id AND deleted_at IS NULL
        AND session_id = @sessionId
        AND session_id IN (
          SELECT s.id FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
           WHERE w.user_id = @userId AND s.deleted_at IS NULL AND w.deleted_at IS NULL)`
  );

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
   * One widget's *decision* on one conversation — the existence question, not the state one.
   * Narrower than `stmtSessionWidgetRowsForUser` on purpose: it answers one pair, so the caller
   * that needs "has anybody decided" cannot be reusing a read meant for "what is installed".
   */
  const stmtSessionWidgetDecisionForUser = db.prepare(
    `SELECT wi.enabled FROM widget_instances wi
       JOIN sessions s ON s.id = @scopeId
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE wi.scope = 'session' AND wi.scope_id = @scopeId
        AND wi.widget_id = @widgetId AND w.user_id = @userId`
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

  /* --------------------------------- quizzes -------------------------------- */
  /*
   * Same scoping shape as plans: the ForUser reads join through to the workspace owner,
   * the session-id reads do not and run only on an already-resolved turn.
   */
  const stmtListQuizQuestionsForUser = db.prepare(
    `SELECT q.* FROM quiz_questions q
       JOIN sessions s ON s.id = q.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE q.session_id = @sessionId AND w.user_id = @userId
      ORDER BY q.position ASC, q.rowid ASC`
  );
  const stmtListQuizQuestionsBySession = db.prepare(
    "SELECT * FROM quiz_questions WHERE session_id = ? ORDER BY position ASC, rowid ASC"
  );
  const stmtGetQuizQuestionForUser = db.prepare(
    `SELECT q.* FROM quiz_questions q
       JOIN sessions s ON s.id = q.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE q.id = @id AND q.session_id = @sessionId AND w.user_id = @userId`
  );
  const stmtInsertQuizQuestion = db.prepare(
    `INSERT INTO quiz_questions
       (id, session_id, node_id, node_title, tool_call_id, qid, position, header, question,
        multi_select, options_json, reference_answer_json, explanation, status, created_at)
     VALUES (@id, @sessionId, @nodeId, @nodeTitle, @toolCallId, @qid, @position, @header,
             @question, @multiSelect, @optionsJson, @referenceAnswerJson, @explanation,
             'pending', @createdAt)`
  );
  // The named calls are always server-bound UUIDs, so the placeholder list is built from
  // length rather than interpolated values.
  const stmtSkipQuizQuestions = (toolCallIds: string[]) =>
    db.prepare(
      `UPDATE quiz_questions SET status = 'skipped'
        WHERE session_id = ? AND status = 'pending' AND tool_call_id IN (${toolCallIds
          .map(() => "?")
          .join(",")})`
    );
  // The expected-status guard is what makes two submissions racing one another honest: the
  // loser changes nothing and reports false. An answered transition clears the old grade.
  const stmtTransitionQuizQuestion = db.prepare(
    `UPDATE quiz_questions
        SET status = @status,
            user_answer_json = @answerJson,
            answered_at = @answeredAt,
            verdict = NULL, feedback = NULL, grade_tool_call_id = NULL, graded_at = NULL
      WHERE id = @id AND session_id = @sessionId AND status = @expectedStatus`
  );
  const stmtGradeQuizQuestion = db.prepare(
    `UPDATE quiz_questions
        SET verdict = @verdict, feedback = @feedback,
            grade_tool_call_id = @gradeToolCallId, graded_at = @gradedAt
      WHERE id = @id AND session_id = @sessionId AND status = 'answered'`
  );

  /* -------------------------------- threads ------------------------------- */
  const stmtListThreadsForUser = db.prepare(
    `SELECT t.* FROM session_threads t
       JOIN sessions s ON s.id = t.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE t.session_id = @sessionId AND w.user_id = @userId
      ORDER BY t.created_at ASC, t.rowid ASC`
  );
  const stmtListThreadsBySession = db.prepare(
    "SELECT * FROM session_threads WHERE session_id = ? ORDER BY created_at ASC, rowid ASC"
  );
  const stmtListThreadMessagesBySession = db.prepare(
    `SELECT m.thread_id AS thread_id, m.id AS id, m.role AS role, m.content AS content,
            m.created_at AS created_at
       FROM messages m
      WHERE m.session_id = ? AND m.deleted_at IS NULL AND m.thread_id IS NOT NULL
      ORDER BY m.created_at ASC, m.rowid ASC`
  );
  const stmtInsertThread = db.prepare(
    `INSERT INTO session_threads (id, session_id, branch, title, plan_node_id, created_at, updated_at)
     VALUES (@id, @sessionId, @branch, @title, @planNodeId, @now, @now)`
  );
  const stmtGetThreadByPlanNode = db.prepare(
    "SELECT * FROM session_threads WHERE session_id = ? AND plan_node_id = ?"
  );
  const stmtListThreadMessagesForUser = db.prepare(
    `SELECT m.thread_id AS thread_id, m.id AS id, m.role AS role, m.content AS content,
            m.created_at AS created_at
       FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE m.session_id = @sessionId AND w.user_id = @userId
        AND m.deleted_at IS NULL AND m.thread_id IS NOT NULL
      ORDER BY m.created_at ASC, m.rowid ASC`
  );
  // `rowid` is the tiebreak `stmtListMessages` does not need but the pending run does: two
  // rows sharing a millisecond must keep insertion order for the turn segmentation to hold.
  const stmtListPendingThreadMessages = db.prepare(
    `SELECT * FROM messages
      WHERE session_id = ? AND deleted_at IS NULL AND thread_id IS NULL
      ORDER BY created_at ASC, rowid ASC LIMIT ?`
  );
  const stmtCountPendingThreadMessagesForUser = db.prepare(
    `SELECT COUNT(*) AS n FROM messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE m.session_id = @sessionId AND w.user_id = @userId
        AND m.deleted_at IS NULL AND m.thread_id IS NULL`
  );
  const stmtCountPendingThreadMessages = db.prepare(
    `SELECT COUNT(*) AS n FROM messages
      WHERE session_id = ? AND deleted_at IS NULL AND thread_id IS NULL`
  );
  const stmtAssignMessagesToThread = (messageIds: string[]) =>
    db.prepare(
      `UPDATE messages SET thread_id = ?
        WHERE session_id = ? AND deleted_at IS NULL AND thread_id IS NULL
          AND id IN (${messageIds.map(() => "?").join(",")})`
    );
  // Classification is not a content change, so updated_at is deliberately untouched; and the
  // `thread_id IS NULL` guard makes a re-run a no-op while still letting a revise be judged
  // again (the diagram upsert clears it).
  const stmtAssignDiagramToThread = db.prepare(
    `UPDATE session_diagrams SET thread_id = ?
       WHERE id = ? AND session_id = ? AND thread_id IS NULL`
  );
  // The table's twin, with the same `thread_id IS NULL` guard: it is the whole of the
  // idempotency, so a second sync re-places nothing while a revise (which clears the column)
  // is judged again.
  const stmtAssignTableToThread = db.prepare(
    `UPDATE session_tables SET thread_id = ?
       WHERE id = ? AND session_id = ? AND thread_id IS NULL`
  );

  /* --------------------------------- notes --------------------------------- */
  /*
   * One projection, two lookups. `messageMissing` is answered by the LEFT JOIN — with
   * `deleted_at IS NULL` in the *join condition* rather than in a later filter, so a
   * soft-deleted message reads as absent, which is exactly what the flag claims. Writing the
   * expression once is the point: the list and the single lookup have to agree about it or a
   * note the panel calls anchored would fail to scroll.
   *
   * `targetMissing` is the same question asked of the other two tables, and it is a pair of
   * `NOT EXISTS` rather than a join because a note names exactly one figure and the two live in
   * tables with nothing in common but the shape of their name column. Neither `session_diagrams`
   * nor `session_tables` carries `deleted_at` — both are derived data whose rows are really
   * removed — so absence is absence. The `target_kind` guard on each half is what keeps a table
   * note from being reported missing because no *diagram* has that name.
   */
  /*
   * `target_missing`, and the **third arm is scoped differently from the first two** — which is
   * the thing to read before changing any of it.
   *
   * A diagram and a table are found inside this conversation, so `n.session_id` is the right
   * scope for both. A **resource** may legitimately be held by another workspace: the `@` picker
   * offers exactly that, and the read whitelist admits it through a grant. Scoping the arm by
   * conversation would make a cross-workspace reference read `targetMissing: true` and lose its
   * 定位 control while the note is perfectly intact — a silent failure, since a missing target
   * renders as an ordinary state.
   *
   * The owner is reached through the note's own conversation (`notes → sessions → workspaces`),
   * because that is the only path from a note to an account. Dropping the `user_id` comparison
   * would make another account's live reference un-missing for a dead id.
   */
  const NOTE_VIEW_SELECT = `SELECT n.*,
      (n.message_id IS NOT NULL AND m.id IS NULL) AS message_missing,
      ((n.target_kind = 'diagram' AND NOT EXISTS (
         SELECT 1 FROM session_diagrams d WHERE d.session_id = n.session_id AND d.name = n.target_ref
       )) OR (n.target_kind = 'table' AND NOT EXISTS (
         SELECT 1 FROM session_tables t WHERE t.session_id = n.session_id AND t.name = n.target_ref
       )) OR (n.target_kind = 'resource' AND NOT EXISTS (
         SELECT 1 FROM work_resources wr
           JOIN sessions ns ON ns.id = n.session_id
           JOIN workspaces nw ON nw.id = ns.workspace_id
          WHERE wr.id = n.target_ref AND wr.user_id = nw.user_id AND wr.deleted_at IS NULL
       ))) AS target_missing
     FROM notes n
     LEFT JOIN messages m ON m.id = n.message_id AND m.deleted_at IS NULL`;
  const stmtListNotesForUser = db.prepare(
    `${NOTE_VIEW_SELECT}
       JOIN sessions s ON s.id = n.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE n.session_id = @sessionId AND w.user_id = @userId
        AND n.deleted_at IS NULL AND s.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY n.created_at DESC, n.rowid DESC`
  );
  const stmtGetNoteForUser = db.prepare(
    `${NOTE_VIEW_SELECT}
       JOIN sessions s ON s.id = n.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE n.id = @noteId AND n.session_id = @sessionId AND w.user_id = @userId
        AND n.deleted_at IS NULL AND s.deleted_at IS NULL AND w.deleted_at IS NULL`
  );
  // Scoped by session rather than by owner: every caller has already resolved the session
  // through a `ForUser` read, and the session scoping is what keeps a note id from one
  // conversation out of another's route. The same shape as `stmtListQuizQuestionsForSession`.
  const stmtGetNote = db.prepare(
    `${NOTE_VIEW_SELECT} WHERE n.id = ? AND n.session_id = ? AND n.deleted_at IS NULL`
  );
  const stmtInsertNote = db.prepare(
    `INSERT INTO notes (id, session_id, message_id, type, quote, occurrence, content, target_kind, target_ref, created_at, updated_at)
     VALUES (@id, @sessionId, @messageId, @type, @quote, @occurrence, @content, @targetKind, @targetRef, @now, @now)`
  );
  const stmtUpdateNote = db.prepare(
    `UPDATE notes SET type = @type, content = @content, updated_at = @now
      WHERE id = @noteId AND session_id = @sessionId AND deleted_at IS NULL`
  );
  const stmtSoftDeleteNote = db.prepare(
    "UPDATE notes SET deleted_at = ? WHERE id = ? AND session_id = ? AND deleted_at IS NULL"
  );

  /* ------------------------------ session diagrams --------------------------- */
  /*
   * Owner-less by session: the tool writes through this immediately after resolving the
   * session in `turnContext`, the thread sync reads it to place the rows, and the
   * owner-scoped list route does its own join (see stmtListDiagramsForUser). The LEFT JOIN
   * is cheap here and lets the sync report where a diagram landed without a second query.
   */
  const stmtListDiagramsBySession = db.prepare(
    `SELECT d.*, t.title AS thread_title
       FROM session_diagrams d
       LEFT JOIN session_threads t ON t.id = d.thread_id
      WHERE d.session_id = ?
      ORDER BY d.updated_at DESC, d.rowid DESC`
  );
  // Read back by the conflict key, because a revise keeps the original id.
  const stmtGetDiagramBySessionName = db.prepare(
    `SELECT d.*, t.title AS thread_title
       FROM session_diagrams d
       LEFT JOIN session_threads t ON t.id = d.thread_id
      WHERE d.session_id = ? AND d.name = ?`
  );

  /*
   * The insight panel's reads. Owner-scoped through workspaces, the same join every other
   * session-owned read uses — `insight_items` carries no user_id because its session does, and
   * a second copy of the owner is a second thing to keep in agreement.
   *
   * The order is the render order: adopted items first (they are the ones the reader chose to
   * keep), then the current pass in the model's own sequence. The panel never re-sorts.
   */
  const stmtListInsightsForUser = db.prepare(
    `SELECT i.*
       FROM insight_items i
       JOIN sessions s   ON s.id = i.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE i.session_id = @sessionId AND w.user_id = @userId
        AND s.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY i.adopted DESC, i.created_at ASC, i.ordinal ASC`
  );
  const stmtGetInsightForUser = db.prepare(
    `SELECT i.*
       FROM insight_items i
       JOIN sessions s   ON s.id = i.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE i.session_id = @sessionId AND i.id = @insightId AND w.user_id = @userId
        AND s.deleted_at IS NULL AND w.deleted_at IS NULL`
  );
  /*
   * The wipe. One statement, and it is also what a user's delete reduces to (with an id
   * added) — see the DDL comment on why this table has no deleted_at.
   */
  const stmtDeleteUnadoptedInsights = db.prepare(
    `DELETE FROM insight_items WHERE session_id = ? AND adopted = 0`
  );
  const stmtInsertInsight = db.prepare(
    `INSERT INTO insight_items (id, session_id, type, title, body, adopted, ordinal, created_at, updated_at)
     VALUES (@id, @sessionId, @type, @title, @body, 0, @ordinal, @now, @now)`
  );
  /*
   * Both writes take a bare session id, like `updateNote`: the `ForUser` read above is what
   * answered "is this yours", and repeating the join here would be a second copy of that answer
   * — the one the next reader has to keep in agreement with the first.
   */
  const stmtSetInsightAdopted = db.prepare(
    `UPDATE insight_items SET adopted = @adopted, updated_at = @now
      WHERE session_id = @sessionId AND id = @insightId`
  );
  const stmtDeleteInsight = db.prepare(
    `DELETE FROM insight_items WHERE session_id = @sessionId AND id = @insightId`
  );
  // Owner-scoped, the route's read: the owner is in the WHERE by joining to workspaces,
  // because sessions reach their owner the same way messages do.
  const stmtListDiagramsForUser = db.prepare(
    `SELECT d.*, t.title AS thread_title
       FROM session_diagrams d
       JOIN sessions s   ON s.id = d.session_id
       JOIN workspaces w ON w.id = s.workspace_id
       LEFT JOIN session_threads t ON t.id = d.thread_id
      WHERE d.session_id = @sessionId AND w.user_id = @userId
        AND s.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY d.updated_at DESC, d.rowid DESC`
  );
  /*
   * One row per file, by construction: the upsert keys on (session_id, name). A revise keeps
   * the id and created_at and clears thread_id, because the new shape has to be judged again.
   */
  const stmtUpsertDiagram = db.prepare(
    `INSERT INTO session_diagrams (id, session_id, thread_id, file_id, name, summary, tool_call_id, created_at, updated_at)
     VALUES (@id, @sessionId, NULL, @fileId, @name, @summary, @toolCallId, @now, @now)
     ON CONFLICT(session_id, name) DO UPDATE SET
       summary = @summary,
       tool_call_id = @toolCallId,
       thread_id = NULL,
       updated_at = @now`
  );

  /* ------------------------------- session tables ---------------------------- */
  // The three diagram statements, one field wider: `content` is in the projection here because
  // the row *is* the artifact (there is no file to read it from), and it is absent from the
  // thread sync's own read for the same reason the classifier never sees a diagram's source —
  // a table's markdown is large, and placing it in a thread needs only its name and summary.
  const stmtListTablesBySession = db.prepare(
    `SELECT t2.*, t.title AS thread_title
       FROM session_tables t2
       LEFT JOIN session_threads t ON t.id = t2.thread_id
      WHERE t2.session_id = ?
      ORDER BY t2.updated_at DESC, t2.rowid DESC`
  );
  /** The classifier's read: name and summary, never the markdown. */
  const stmtListTableBriefsBySession = db.prepare(
    `SELECT id, session_id, thread_id, name, summary, '' AS content, tool_call_id,
            created_at, updated_at
       FROM session_tables
      WHERE session_id = ?`
  );
  // Read back by the conflict key, because a revise keeps the original id.
  const stmtGetTableBySessionName = db.prepare(
    `SELECT t2.*, t.title AS thread_title
       FROM session_tables t2
       LEFT JOIN session_threads t ON t.id = t2.thread_id
      WHERE t2.session_id = ? AND t2.name = ?`
  );
  const stmtListTablesForUser = db.prepare(
    `SELECT t2.*, t.title AS thread_title
       FROM session_tables t2
       JOIN sessions s   ON s.id = t2.session_id
       JOIN workspaces w ON w.id = s.workspace_id
       LEFT JOIN session_threads t ON t.id = t2.thread_id
      WHERE t2.session_id = @sessionId AND w.user_id = @userId
        AND s.deleted_at IS NULL AND w.deleted_at IS NULL
      ORDER BY t2.updated_at DESC, t2.rowid DESC`
  );
  // `session_diagrams`' upsert with `content` alongside `summary`, and the same revise rule:
  // the id and created_at are kept, and thread_id is cleared so the new shape is judged again.
  const stmtUpsertSessionTable = db.prepare(
    `INSERT INTO session_tables (id, session_id, thread_id, name, summary, content, tool_call_id, created_at, updated_at)
     VALUES (@id, @sessionId, NULL, @name, @summary, @content, @toolCallId, @now, @now)
     ON CONFLICT(session_id, name) DO UPDATE SET
       summary = @summary,
       content = @content,
       tool_call_id = @toolCallId,
       thread_id = NULL,
       updated_at = @now`
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
    `SELECT m.role, m.usage FROM messages m
      WHERE m.session_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at ASC`
  );
  const stmtWorkspaceUsageRows = db.prepare(
    `SELECT m.session_id, m.role, m.usage FROM messages m
       JOIN sessions s ON s.id = m.session_id
      WHERE s.workspace_id = ? AND s.deleted_at IS NULL AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC`
  );

  /* ------------------------------ providers ------------------------------- */
  const stmtListProviders = db.prepare(
    "SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC"
  );
  const stmtGetProvider = db.prepare("SELECT * FROM providers WHERE id = ? AND deleted_at IS NULL");
  const stmtCreateProvider = db.prepare(
    `INSERT INTO providers (id, name, base_url, api_key, sort_order, created_at, updated_at)
     VALUES (@id, @name, @baseURL, @apiKey, @sortOrder, @createdAt, @updatedAt)`
  );
  const stmtSoftDeleteProvider = db.prepare(
    "UPDATE providers SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
  );
  /*
   * The cascade, spelled out. `models.provider_id` is `ON DELETE CASCADE`, and a soft delete
   * fires no such thing — so a provider removed from the list would otherwise leave its models
   * behind, still resolvable by id and still offered wherever models are enumerated. Marking
   * them in the same transaction is what makes the two agree.
   */
  const stmtSoftDeleteModelsByProvider = db.prepare(
    "UPDATE models SET deleted_at = ? WHERE provider_id = ? AND deleted_at IS NULL"
  );
  const stmtNextProviderOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM providers"
  );

  /* -------------------------------- models -------------------------------- */
  const stmtModelsByProvider = db.prepare(
    "SELECT * FROM models WHERE provider_id = ? AND deleted_at IS NULL ORDER BY sort_order ASC"
  );
  const stmtGetModel = db.prepare("SELECT * FROM models WHERE id = ? AND deleted_at IS NULL");
  const stmtCreateModel = db.prepare(
    `INSERT INTO models (id, provider_id, model_id, name, context_window, max_output, capabilities, sort_order)
     VALUES (@id, @providerId, @modelId, @name, @contextWindow, @maxOutput, @capabilities, @sortOrder)`
  );
  const stmtSoftDeleteModel = db.prepare(
    "UPDATE models SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
  );
  const stmtNextModelOrder = db.prepare(
    "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM models WHERE provider_id = ?"
  );

  /* --------------------------- document parsers --------------------------- */
  const stmtListDocumentParsers = db.prepare(
    "SELECT * FROM document_parsers WHERE deleted_at IS NULL ORDER BY sort_order ASC, created_at ASC"
  );
  const stmtGetDocumentParser = db.prepare(
    "SELECT * FROM document_parsers WHERE id = ? AND deleted_at IS NULL"
  );
  const stmtCreateDocumentParser = db.prepare(
    `INSERT INTO document_parsers (id, name, kind, base_url, api_key, enabled, sort_order, created_at, updated_at)
     VALUES (@id, @name, @kind, @baseURL, @apiKey, @enabled, @sortOrder, @createdAt, @updatedAt)`
  );
  const stmtSoftDeleteDocumentParser = db.prepare(
    "UPDATE document_parsers SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
  );
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

  /**
   * The lease on a conversation, if it is still alive, as the asking client sees it.
   *
   * An expired row is `undefined` — "free" and "expired" are the same answer to every caller,
   * which is the point of a lease: nothing has to be cleaned up for the conversation to become
   * available again. The comparison is lexical because both sides are ISO strings in UTC, the
   * same rule `auth_tokens.expires_at` is read by.
   */
  const lockFor = (
    sessionId: string,
    userId: string,
    clientId: string,
    now_: Date
  ): SessionLockView | undefined => {
    const r = stmtGetSessionLock.get(sessionId, userId) as SessionLockRow | undefined;
    if (!r || r.expires_at <= now_.toISOString()) return undefined;
    return mapSessionLock(r, clientId);
  };

  const listUsersOf = (): UserRecord[] => (stmtListUsers.all() as UserRow[]).map(mapUser);

  return {
    raw: db,

    listUsers() {
      return listUsersOf();
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
      stmtCreateUser.run({
        id: input.id,
        username: input.username,
        slug: input.slug,
        passwordHash: input.passwordHash ?? null,
        // The least privilege when the caller does not say, matching the column's own default:
        // an account inserted by something that forgot to name the roles is an ordinary one.
        roles: JSON.stringify(input.roles ?? DEFAULT_USER_ROLES),
        mustChangePassword: input.mustChangePassword ? 1 : 0,
        createdAt: now(),
      });
      const r = stmtGetUser.get(input.id) as UserRow;
      return mapUser(r);
    },
    setUserPassword(id, passwordHash, mustChangePassword) {
      stmtSetUserPassword.run({ id, passwordHash, mustChangePassword: mustChangePassword ? 1 : 0 });
      const r = stmtGetUser.get(id) as UserRow | undefined;
      return r ? mapUser(r) : undefined;
    },
    setUserRoles(id, roles) {
      stmtSetUserRoles.run({ id, roles: JSON.stringify(roles) });
      const r = stmtGetUser.get(id) as UserRow | undefined;
      return r ? mapUser(r) : undefined;
    },
    setUserDisabled(id, disabled) {
      stmtSetUserDisabled.run({ id, disabled: disabled ? 1 : 0 });
      const r = stmtGetUser.get(id) as UserRow | undefined;
      return r ? mapUser(r) : undefined;
    },
    setUserAbout(id, about) {
      stmtSetUserAbout.run({ id, about });
      const r = stmtGetUser.get(id) as UserRow | undefined;
      return r ? mapUser(r) : undefined;
    },
    hasPasswordAccounts() {
      return (stmtHasPasswordAccounts.get() as { found: number }).found === 1;
    },
    hasSuperadmin() {
      // A scan of `users` in JS rather than a SQL `LIKE` over the roles JSON, and the table is
      // the reason it is affordable: this is one person's installations, so it holds a handful
      // of rows. `roles` is a JSON array, and matching it with `LIKE '%"superadmin"%'` would
      // be a second, looser reading of the same column — the kind of thing that agrees with
      // `isEnabledSuperadmin` right up until it does not.
      return listUsersOf().some(isEnabledSuperadmin);
    },

    createAuthToken(input) {
      stmtCreateAuthToken.run({ ...input, createdAt: now() });
      const r = stmtGetAuthToken.get(input.id) as AuthTokenRow;
      return toAuthTokenRecord(r);
    },
    getAuthToken(id) {
      const r = stmtGetAuthToken.get(id) as AuthTokenRow | undefined;
      return r ? toAuthTokenRecord(r) : undefined;
    },
    touchAuthToken(id, at) {
      stmtTouchAuthToken.run(at, id);
    },
    revokeAuthToken(id, at) {
      return stmtRevokeAuthToken.run(at, id).changes > 0;
    },
    revokeUserTokens(userId, at) {
      return stmtRevokeUserTokens.run({ userId, at }).changes;
    },
    revokeUserTokensOfKind(userId, kind, at) {
      return stmtRevokeUserTokensOfKind.run({ userId, kind, at }).changes;
    },
    pruneAuthTokens(before) {
      return stmtPruneAuthTokens.run(before, before).changes;
    },



    listSessionLabels(userId) {
      return stmtListSessionLabels.all(userId) as SessionLabelRow[];
    },
    listSessionOverviews(userId) {
      return stmtListSessionOverviews.all(userId) as SessionOverviewRow[];
    },
    searchMessages(userId, workspaceIds, query) {
      // An empty grant has no rows to match, and `json_each('[]')` already says so — returned
      // here rather than by the statement only because the note above promises it regardless.
      if (workspaceIds.length === 0) return [];
      return stmtSearchMessages.all({
        userId,
        workspaceIds: JSON.stringify(workspaceIds),
        query: likePattern(query),
      }) as MessageSearchRow[];
    },

    /*
     * Every work-resource read goes through `withEntity`, and that is the one place a reference
     * with no entity is handled: the shared join leaves the entity's columns NULL when the row
     * it points at has been soft-deleted, and this drops the row rather than handing back a
     * reference to nothing. A row about nothing is not a row the library can draw, and a caller
     * that had to check for it at every site would eventually forget once.
     */
    getFileForUser(userId, id) {
      const r = stmtGetFileForUser.get(id, userId) as FileRow | undefined;
      return r ? mapFile(r) : undefined;
    },
    getFileByPath(userId, path) {
      const r = stmtGetFileByPath.get(userId, path) as FileRow | undefined;
      return r ? mapFile(r) : undefined;
    },
    listFilesForUser(userId) {
      return (stmtListFilesForUser.all(userId) as FileRow[]).map(mapFile);
    },
    findFileByHash(userId, sha256) {
      const r = stmtFindFileByHash.get(userId, sha256) as FileRow | undefined;
      return r ? mapFile(r) : undefined;
    },
    findDeletedFileByHash(userId, sha256) {
      const r = stmtFindDeletedFileByHash.get(userId, sha256) as FileRow | undefined;
      return r ? mapFile(r) : undefined;
    },
    createFile(input) {
      stmtCreateFile.run({
        id: input.id,
        userId: input.userId,
        sourceType: input.sourceType,
        title: input.title,
        path: input.path,
        mimeType: input.mimeType,
        category: input.category,
        size: input.size,
        summary: input.summary ?? null,
        sha256: input.sha256 ?? null,
        createdAt: input.now ?? now(),
      });
      const r = stmtGetFileForUser.get(input.id, input.userId) as FileRow;
      return mapFile(r);
    },
    updateFilePath(id, userId, patch) {
      const updatedAt = patch.now ?? now();
      const changed =
        stmtUpdateFilePath.run({
          id,
          userId,
          path: patch.path ?? null,
          title: patch.title ?? null,
          mimeType: patch.mimeType ?? null,
          category: patch.category ?? null,
          size: patch.size ?? null,
          // Two parameters for one column, because "clear the summary" and "do not touch the
          // summary" are different intentions and a lone null cannot express both.
          summarySet: patch.summary === undefined ? 0 : 1,
          summary: patch.summary ?? null,
          updatedAt,
        }).changes > 0;

      // A rename carries the name to every reference, so the library does not keep showing the
      // old one. Only when the caller actually named it — a reconcile passes no title and must
      // not overwrite what a reference says.
      if (changed && patch.title !== undefined) {
        stmtRetitleWorkResourcesForFile.run({
          userId,
          fileId: id,
          title: patch.title,
          updatedAt,
        });
      }
      return changed;
    },
    softDeleteFileForUser(id, userId) {
      return stmtSoftDeleteFileForUser.run(now(), id, userId).changes > 0;
    },
    reviveFileForUser(id, userId) {
      const r = stmtReviveFileForUser.get(id, userId) as FileRow | undefined;
      return r ? mapFile(r) : undefined;
    },

    getWebPageForUser(userId, id) {
      const r = stmtGetWebPageForUser.get(id, userId) as WebPageRow | undefined;
      return r ? mapWebPage(r) : undefined;
    },
    softDeleteWebPageForUser(id, userId) {
      return stmtSoftDeleteWebPageForUser.run(now(), id, userId).changes > 0;
    },
    findWebPageByHash(userId, sha256) {
      const r = stmtFindWebPageByHash.get(userId, sha256) as WebPageRow | undefined;
      return r ? mapWebPage(r) : undefined;
    },
    createWebPage(input) {
      stmtCreateWebPage.run({
        id: input.id,
        userId: input.userId,
        sourceType: input.sourceType,
        url: input.url,
        title: input.title,
        summary: input.summary ?? null,
        sha256: input.sha256,
        createdAt: input.now ?? now(),
      });
      const r = stmtGetWebPageForUser.get(input.id, input.userId) as WebPageRow;
      return mapWebPage(r);
    },
    updateWebPage(id, userId, patch) {
      return (
        stmtUpdateWebPage.run({
          id,
          userId,
          url: patch.url ?? null,
          title: patch.title ?? null,
          summarySet: patch.summary === undefined ? 0 : 1,
          summary: patch.summary ?? null,
          updatedAt: patch.now ?? now(),
        }).changes > 0
      );
    },

    upsertWorkResource(input) {
      /*
       * The statement's `RETURNING *` gives the reference row without its entity, so the entity
       * is read back through the same owner-scoped accessor the callers use. Two statements
       * rather than a second join, because the value being returned is the *reference* — the
       * entity is fetched by whoever needs it, and doing it here would mean this method had to
       * know which of the two tables to read.
       */
      const inserted = stmtUpsertWorkResource.get({
        id: input.id,
        userId: input.userId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        title: input.title,
        summary: input.summary ?? null,
        createdAt: input.now ?? now(),
      }) as { id: string } | undefined;
      if (!inserted) return undefined;
      return this.getWorkResourceForUser(input.userId, inserted.id);
    },
    getWorkResourceForUser(userId, id) {
      const r = stmtGetWorkResourceForUser.get(id, userId) as WorkResourceRow | undefined;
      if (!r) return undefined;
      const entity = entityOf(r);
      return entity ? mapWorkResource(r, entity) : undefined;
    },
    listWorkResourcesForResource(userId, resourceType, resourceId) {
      const rows = stmtListWorkResourcesForResource.all({
        userId,
        resourceType,
        resourceId,
      }) as WorkResourceRow[];
      return rows.flatMap((r) => {
        const entity = entityOf(r);
        return entity ? [mapWorkResource(r, entity)] : [];
      });
    },
    addSessionReference(input) {
      stmtUpsertSessionReference.run({
        id: input.id,
        sessionId: input.sessionId,
        workResourceId: input.workResourceId,
        createdAt: input.now ?? now(),
      });
    },
    listSessionReferences(sessionId) {
      const rows = stmtListSessionReferences.all(sessionId) as { work_resource_id: string }[];
      return rows.map((r) => r.work_resource_id);
    },
    countReferencesForEntities(userId, resourceType, resourceIds) {
      // An empty page of ids returns an empty map rather than asking the statement to parse
      // `json_each('[]')` — which would work, but a query that provably cannot match is worth
      // not making.
      if (resourceIds.length === 0) return new Map();
      const bound = {
        userId,
        resourceType,
        resourceIds: JSON.stringify([...new Set(resourceIds)]),
      };
      const counts = new Map<string, number>();
      for (const row of stmtCountReferences.all(bound) as { resource_id: string; n: number }[]) {
        counts.set(row.resource_id, row.n);
      }
      for (const row of stmtCountSessionReferences.all(bound) as {
        resource_id: string;
        n: number;
      }[]) {
        counts.set(row.resource_id, (counts.get(row.resource_id) ?? 0) + row.n);
      }
      return counts;
    },
    listWorkResourcesFiltered(userId, filter) {
      const rows = stmtListWorkResourcesFiltered.all({
        userId,
        resourceType: filter.resourceType ?? null,
        ownerType: filter.ownerType ?? null,
        category: filter.category ?? null,
        mime: filter.mime ?? null,
        // `likePattern` is what makes a `%` in a filename a character rather than a wildcard;
        // `ESCAPE '\'` in the statement is the other half of it.
        name: filter.name ? likePattern(filter.name) : null,
        workspaceId: filter.workspaceId ?? null,
        sessionId: filter.sessionId ?? null,
      }) as WorkResourceRow[];
      return rows.flatMap((r) => {
        const entity = entityOf(r);
        return entity ? [mapWorkResource(r, entity)] : [];
      });
    },
    listReadableWorkResources(userId, sessionId, workspaceId, scope) {
      const rows = stmtListReadableWorkResources.all({
        userId,
        sessionId,
        workspaceId,
        // `1`/`0` and never a boolean: SQLite has no boolean type, and the statement tests it
        // with `= 1`. `idsJson` is the JSON array `scopeIdsJson` builds — see that function
        // for why nothing else may be bound here.
        scopeAll: scope.all ? 1 : 0,
        scopeIds: scope.idsJson,
      }) as WorkResourceRow[];
      return rows.flatMap((r) => {
        const entity = entityOf(r);
        return entity ? [mapWorkResource(r, entity)] : [];
      });
    },
    softDeleteWorkResourceForUser(id, userId) {
      return stmtSoftDeleteWorkResourceForUser.run(now(), id, userId).changes > 0;
    },
    updateWorkResourceParse(input) {
      return (
        stmtUpdateWorkResourceParse.run({
          id: input.id,
          userId: input.userId,
          status: input.status,
          error: input.error ?? null,
          code: input.code ?? null,
          parserId: input.parserId ?? null,
          parsedChars: input.parsedChars ?? null,
          pageCount: input.pageCount ?? null,
          parsedFileId: input.parsedFileId ?? null,
          updatedAt: input.now ?? now(),
        }).changes > 0
      );
    },

    listWorkspaces(userId) {
      return (stmtListWorkspaces.all(userId) as WorkspaceRow[]).map(mapWorkspace);
    },
    getWorkspaceForUser(id, userId) {
      return workspaceForUser(id, userId);
    },
    createWorkspace(input) {
      // `description` first, so an input that omits it still binds the named parameter: better-
      // sqlite3 refuses a missing one, and `description?: string` is what the callers show.
      stmtCreateWorkspace.run({ description: "", ...input, createdAt: now() });
      const r = stmtGetWorkspaceForUser.get(input.id, input.userId) as WorkspaceRow;
      return mapWorkspace(r);
    },
    patchWorkspaceForUser(id, userId, patch) {
      stmtPatchWorkspaceForUser.run({
        id,
        userId,
        name: patch.name ?? null,
        description: patch.description ?? null,
      });
      const r = stmtGetWorkspaceWithStatsForUser.get(id, userId) as WorkspaceRow | undefined;
      return r ? mapWorkspace(r) : undefined;
    },
    setWorkspaceSettingsForUser(id, userId, settings) {
      stmtSetWorkspaceSettingsForUser.run(JSON.stringify(settings), id, userId);
      const r = stmtGetWorkspaceWithStatsForUser.get(id, userId) as WorkspaceRow | undefined;
      return r ? mapWorkspace(r) : undefined;
    },
    softDeleteWorkspaceForUser(id, userId) {
      return stmtSoftDeleteWorkspaceForUser.run(now(), id, userId).changes > 0;
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
    softDeleteCopilotForUser(id, userId) {
      return stmtSoftDeleteCopilotForUser.run(now(), id, userId).changes > 0;
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
        // `?? ""` on the fallback rather than on the input: a row written before the column
        // existed has none, and `??` here would also swallow a deliberate empty string.
        description: input.description ?? existing.description ?? "",
        ...stored,
        updatedAt: now(),
      });
      const r = stmtGetSession.get(id) as SessionRow;
      return mapSession(r);
    },
    setAutoTitleForUser(id, userId, title, titleState) {
      const { changes } = stmtSetAutoTitleForUser.run(title, titleState, now(), id, userId);
      if (changes === 0) return undefined;
      const r = stmtGetSession.get(id) as SessionRow;
      return mapSession(r);
    },
    setTitleStateForUser(id, userId, titleState) {
      return stmtSetTitleStateForUser.run(titleState, id, userId).changes > 0;
    },
    softDeleteSessionForUser(id, userId) {
      return stmtSoftDeleteSessionForUser.run(now(), id, userId).changes > 0;
    },
    setSessionPinnedForUser(id, userId, pinned) {
      const { changes } = stmtSetSessionPinnedForUser.run(pinned ? 1 : 0, id, userId);
      if (changes === 0) return undefined;
      const r = stmtGetSession.get(id) as SessionRow;
      return mapSession(r);
    },
    touchSession(id) {
      stmtTouchSession.run(now(), id);
    },

    acquireSessionLock({ sessionId, userId, clientId, ttlSeconds, now: at }) {
      const at_ = at ?? new Date();
      // `changes` **is** the decision, and it is the statement's own, so nothing can slip between
      // the check and the write. Zero rows means one thing only: the upsert's `WHERE` excluded
      // this client, i.e. a live lease held by somebody else — or, unreachably, a session this
      // account does not own, since the INSERT selects through the owner. Both answer the same
      // refusal, which is not a distinguishable one: the route resolves the session `ForUser`
      // before it gets here, so a foreign id has already become a 404.
      const written = stmtAcquireSessionLock.run({
        sessionId,
        userId,
        clientId,
        now: at_.toISOString(),
        expiresAt: new Date(at_.getTime() + ttlSeconds * 1000).toISOString(),
      });
      if (written.changes === 0) return undefined;
      // Read back only to *build* the view, never to decide: a fresh acquire, a heartbeat and a
      // takeover of an expired row are three ways to succeed, and the caller wants the lease in
      // all of them. Returning the row without the guard above is how this handed a second client
      // the first one's lease while reporting success.
      return lockFor(sessionId, userId, clientId, at_);
    },

    releaseSessionLock({ sessionId, userId, clientId, now: at }) {
      const at_ = at ?? new Date();
      const result = stmtReleaseSessionLock.run(
        sessionId,
        clientId,
        at_.toISOString(),
        userId
      );
      return result.changes > 0;
    },

    sessionLockFor(sessionId, userId, clientId, at) {
      return lockFor(sessionId, userId, clientId, at ?? new Date());
    },

    listSessionLocksForUser(workspaceId, userId, clientId, at) {
      const at_ = at ?? new Date();
      return (
        stmtListSessionLocksForUser.all(workspaceId, userId, at_.toISOString()) as SessionLockRow[]
      ).map((r) => mapSessionLock(r, clientId));
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
        // Stored only when there is something to store, like the column beside it: a JSON
        // `[]` would make "referenced nothing" a value rather than an absence.
        refs: input.refs?.length ? JSON.stringify(input.refs) : null,
        usage: input.usage ? JSON.stringify(input.usage) : null,
        providerId: input.model?.providerId ?? null,
        providerName: input.model?.providerName ?? null,
        modelId: input.model?.modelId ?? null,
        modelName: input.model?.modelName ?? null,
        stopped: input.stopped ? 1 : 0,
        createdAt: now(),
      });
      const row = stmtGetMessageById.get(input.id) as MessageRow;
      return mapMessage(row);
    },
    softDeleteMessageForUser(sessionId, messageId, userId) {
      return (
        stmtSoftDeleteMessageForUser.run({ at: now(), id: messageId, sessionId, userId }).changes > 0
      );
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

    listAwaitingToolCalls(sessionId) {
      const out: { id: string; name: string }[] = [];
      for (const message of listMessagesOf(sessionId)) {
        for (const tc of message.toolCalls ?? []) {
          if (tc.status === "awaiting") out.push({ id: tc.id, name: tc.name });
        }
      }
      return out;
    },

    skipAwaitingToolCalls(sessionId) {
      // Computed before the write, so the returned list names the calls actually retired.
      const skipped = this.listAwaitingToolCalls(sessionId);
      for (const message of listMessagesOf(sessionId)) {
        const calls = message.toolCalls ?? [];
        if (!calls.some((tc) => tc.status === "awaiting")) continue;
        const next = calls.map((tc) => {
          if (tc.status !== "awaiting") return tc;
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
    getSessionWidgetDecisionForUser(userId, sessionId, widgetId) {
      const row = stmtSessionWidgetDecisionForUser.get({
        userId,
        scopeId: sessionId,
        widgetId,
      }) as { enabled: number } | undefined;
      // `undefined` is "no row", and it must stay distinguishable from `false` — a foreign
      // session id and an untouched one both reach here, and both mean *undecided*.
      return row ? row.enabled !== 0 : undefined;
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

    insertQuizQuestions(rows) {
      const stmt = stmtInsertQuizQuestion;
      for (const row of rows) {
        stmt.run({
          id: row.id,
          sessionId: row.sessionId,
          nodeId: row.nodeId,
          nodeTitle: row.nodeTitle,
          toolCallId: row.toolCallId,
          qid: row.qid,
          position: row.position,
          header: row.header,
          question: row.question,
          multiSelect: row.multiSelect ? 1 : 0,
          optionsJson: JSON.stringify(row.options),
          referenceAnswerJson:
            row.referenceAnswer && row.referenceAnswer.length > 0
              ? JSON.stringify(row.referenceAnswer)
              : null,
          explanation: row.explanation ?? null,
          createdAt: row.createdAt,
        });
      }
    },

    listQuizQuestionsForUser(userId, sessionId) {
      return (stmtListQuizQuestionsForUser.all({ userId, sessionId }) as QuizQuestionRow[]).map(
        mapQuizQuestion
      );
    },

    listQuizQuestionsBySession(sessionId) {
      return (stmtListQuizQuestionsBySession.all(sessionId) as QuizQuestionRow[]).map(
        mapQuizQuestion
      );
    },

    getQuizQuestionForUser(userId, sessionId, id) {
      const r = stmtGetQuizQuestionForUser.get({ id, userId, sessionId }) as
        | QuizQuestionRow
        | undefined;
      return r ? mapQuizQuestion(r) : undefined;
    },

    skipQuizQuestions(sessionId, toolCallIds) {
      // An empty IN-list is a syntax error and would match nothing anyway.
      if (toolCallIds.length === 0) return;
      stmtSkipQuizQuestions(toolCallIds).run(sessionId, ...toolCallIds);
    },

    transitionQuizQuestion(input) {
      return (
        stmtTransitionQuizQuestion.run({
          id: input.id,
          sessionId: input.sessionId,
          expectedStatus: input.expectedStatus,
          status: input.status,
          answerJson: input.answerJson ?? null,
          answeredAt: input.answeredAt ?? null,
        }).changes > 0
      );
    },

    gradeQuizQuestion(input) {
      return (
        stmtGradeQuizQuestion.run({
          id: input.id,
          sessionId: input.sessionId,
          verdict: input.verdict,
          feedback: input.feedback,
          gradeToolCallId: input.gradeToolCallId,
          gradedAt: input.gradedAt,
        }).changes > 0
      );
    },

    listThreadsForUser(userId, sessionId) {
      return (stmtListThreadsForUser.all({ userId, sessionId }) as ThreadRow[]).map(mapThread);
    },

    listThreadsBySession(sessionId) {
      return (stmtListThreadsBySession.all(sessionId) as ThreadRow[]).map(mapThread);
    },

    listThreadMessagesBySession(sessionId) {
      return (
        stmtListThreadMessagesBySession.all(sessionId) as Array<{
          thread_id: string;
          id: string;
          role: "user" | "assistant";
          content: string;
          created_at: string;
        }>
      ).map((r) => ({
        threadId: r.thread_id,
        id: r.id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      }));
    },

    listSessionMessages(sessionId) {
      return listMessagesOf(sessionId);
    },

    insertThread(input) {
      const ts = now();
      stmtInsertThread.run({
        id: input.id,
        sessionId: input.sessionId,
        branch: input.branch,
        title: input.title,
        planNodeId: input.planNodeId ?? null,
        now: ts,
      });
      return mapThread(
        db.prepare("SELECT * FROM session_threads WHERE id = ?").get(input.id) as ThreadRow
      );
    },

    getThreadByPlanNode(sessionId, planNodeId) {
      const r = stmtGetThreadByPlanNode.get(sessionId, planNodeId) as ThreadRow | undefined;
      return r ? mapThread(r) : undefined;
    },

    listThreadMessagesForUser(userId, sessionId) {
      return (
        stmtListThreadMessagesForUser.all({ userId, sessionId }) as Array<{
          thread_id: string;
          id: string;
          role: "user" | "assistant";
          content: string;
          created_at: string;
        }>
      ).map((r) => ({
        threadId: r.thread_id,
        id: r.id,
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      }));
    },

    listPendingThreadMessages(sessionId, limit) {
      return (stmtListPendingThreadMessages.all(sessionId, limit) as MessageRow[]).map(
        mapMessage
      );
    },

    countPendingThreadMessagesForUser(userId, sessionId) {
      const row = stmtCountPendingThreadMessagesForUser.get({ userId, sessionId }) as {
        n: number;
      };
      return row.n;
    },

    countPendingThreadMessages(sessionId) {
      const row = stmtCountPendingThreadMessages.get(sessionId) as { n: number };
      return row.n;
    },

    assignMessagesToThread(sessionId, messageIds, threadId) {
      if (messageIds.length === 0) return 0;
      return stmtAssignMessagesToThread(messageIds).run(
        threadId,
        sessionId,
        ...messageIds
      ).changes;
    },

    assignDiagramToThread(sessionId, diagramId, threadId) {
      return stmtAssignDiagramToThread.run(threadId, diagramId, sessionId).changes;
    },

    listNotesForUser(userId, sessionId) {
      return (stmtListNotesForUser.all({ userId, sessionId }) as NoteRow[]).map(mapNote);
    },

    getNoteForUser(userId, sessionId, noteId) {
      const row = stmtGetNoteForUser.get({ userId, sessionId, noteId }) as NoteRow | undefined;
      return row ? mapNote(row) : undefined;
    },

    createNote(input) {
      stmtInsertNote.run({
        id: input.id,
        sessionId: input.sessionId,
        messageId: input.messageId,
        type: input.type,
        quote: input.quote,
        occurrence: input.occurrence,
        content: input.content,
        targetKind: input.targetKind,
        targetRef: input.targetRef,
        now: now(),
      });
      const row = stmtGetNote.get(input.id, input.sessionId) as NoteRow;
      return mapNote(row);
    },

    updateNote(sessionId, noteId, input) {
      const existing = stmtGetNote.get(noteId, sessionId) as NoteRow | undefined;
      if (!existing) return undefined;
      stmtUpdateNote.run({
        noteId,
        sessionId,
        type: input.type ?? existing.type,
        content: input.content ?? existing.content,
        now: now(),
      });
      return mapNote(stmtGetNote.get(noteId, sessionId) as NoteRow);
    },

    softDeleteNote(sessionId, noteId) {
      return stmtSoftDeleteNote.run(now(), noteId, sessionId).changes > 0;
    },

    listDiagramsBySession(sessionId) {
      return (stmtListDiagramsBySession.all(sessionId) as DiagramRow[]).map(mapDiagram);
    },

    listDiagramsForUser(userId, sessionId) {
      return (stmtListDiagramsForUser.all({ userId, sessionId }) as DiagramRow[]).map(
        mapDiagram
      );
    },

    getDiagramBySessionName(sessionId, name) {
      const row = stmtGetDiagramBySessionName.get(sessionId, name) as DiagramRow | undefined;
      return row ? mapDiagram(row) : undefined;
    },

    listInsightsForUser(userId, sessionId) {
      return (
        stmtListInsightsForUser.all({ userId, sessionId }) as InsightItemRow[]
      ).map(mapInsight);
    },

    getInsightForUser(userId, sessionId, insightId) {
      const row = stmtGetInsightForUser.get({ userId, sessionId, insightId }) as
        | InsightItemRow
        | undefined;
      return row ? mapInsight(row) : undefined;
    },

    replaceUnadoptedInsights(sessionId, items) {
      const now = new Date().toISOString();
      const writes = (): void => {
        stmtDeleteUnadoptedInsights.run(sessionId);
        for (const item of items) {
          stmtInsertInsight.run({
            id: item.id,
            sessionId: item.sessionId,
            type: item.type,
            title: item.title,
            body: item.body,
            ordinal: item.ordinal,
            now,
          });
        }
      };
      db.transaction(writes)();
    },

    setInsightAdoptedForUser(userId, sessionId, insightId, adopted) {
      // The `ForUser` read is the ownership check; the UPDATE below then needs only the session
      // and the id. Reading first also means a foreign id is `undefined` rather than a silent
      // no-op UPDATE, which is the difference between a 404 and a 200 that changed nothing.
      if (!this.getInsightForUser(userId, sessionId, insightId)) return undefined;
      stmtSetInsightAdopted.run({
        sessionId,
        insightId,
        adopted: adopted ? 1 : 0,
        now: new Date().toISOString(),
      });
      return this.getInsightForUser(userId, sessionId, insightId);
    },

    deleteInsightForUser(userId, sessionId, insightId) {
      if (!this.getInsightForUser(userId, sessionId, insightId)) return false;
      return stmtDeleteInsight.run({ sessionId, insightId }).changes > 0;
    },

    upsertDiagram(input) {
      stmtUpsertDiagram.run({
        id: input.id,
        sessionId: input.sessionId,
        name: input.name,
        fileId: input.fileId,
        summary: input.summary,
        toolCallId: input.toolCallId,
        now: now(),
      });
      // Read back by the conflict key rather than by id — a revise preserves the original id.
      const row = stmtGetDiagramBySessionName.get(input.sessionId, input.name) as DiagramRow;
      return mapDiagram(row);
    },

    listTablesBySession(sessionId) {
      return (stmtListTablesBySession.all(sessionId) as TableRow[]).map(mapTable);
    },

    listTableBriefsBySession(sessionId) {
      return (stmtListTableBriefsBySession.all(sessionId) as TableRow[]).map(mapTable);
    },

    listTablesForUser(userId, sessionId) {
      return (stmtListTablesForUser.all({ userId, sessionId }) as TableRow[]).map(mapTable);
    },

    upsertSessionTable(input) {
      stmtUpsertSessionTable.run({
        id: input.id,
        sessionId: input.sessionId,
        name: input.name,
        summary: input.summary,
        content: input.content,
        toolCallId: input.toolCallId,
        now: now(),
      });
      // Read back by the conflict key rather than by id — a revise preserves the original id.
      const row = stmtGetTableBySessionName.get(input.sessionId, input.name) as TableRow;
      return mapTable(row);
    },

    assignTableToThread(sessionId, tableId, threadId) {
      return stmtAssignTableToThread.run(threadId, tableId, sessionId).changes;
    },

    insertUsageEvent(input) {
      stmtInsertUsageEvent.run({ ...input, createdAt: now() });
    },
    listUsageRows(query) {
      return (stmtListUsageRows.all({
        userId: query.userId ?? null,
        workspaceId: query.workspaceId ?? null,
        fromIso: query.fromIso,
        toIso: query.toIso,
      }) as UsageDbRow[]).map(mapUsageRow);
    },
    usageSince(userId) {
      const row = stmtUsageSince.get({ userId: userId ?? null }) as { since: string | null };
      return row.since;
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
    softDeleteProvider(id) {
      // One transaction, because the two writes are one act: a provider hidden while its
      // models stayed live would leave models resolvable under a provider nothing lists.
      db.transaction(() => {
        const at = now();
        stmtSoftDeleteProvider.run(at, id);
        stmtSoftDeleteModelsByProvider.run(at, id);
      })();
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
    softDeleteModel(id) {
      return stmtSoftDeleteModel.run(now(), id).changes > 0;
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
    softDeleteDocumentParser(id) {
      stmtSoftDeleteDocumentParser.run(now(), id);
    },

    getSetting(key) {
      const r = stmtGetSetting.get(key) as { value: string } | undefined;
      return r?.value;
    },
    setSetting(key, value) {
      stmtSetSetting.run(key, value);
    },

    transaction(fn) {
      return db.transaction(fn)();
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

/**
 * The upload limit currently in force.
 *
 * Falls back to `MAX_ATTACHMENT_BYTES` for anything unset, unparseable or out of range — the
 * "an unknown value reads as the default" rule `title_state` and the parsing policy both follow,
 * and here it also means a hand-edited database row cannot turn the cap off. A value below the
 * floor reads as the floor and one above the ceiling as the ceiling, because both are states the
 * console cannot produce and the *route* must not be the place that discovers it.
 */
export function readMaxUploadBytes(db: AppDb): number {
  const stored = Number(db.getSetting(SETTING_MAX_UPLOAD_BYTES));
  if (!Number.isFinite(stored) || stored <= 0) return MAX_ATTACHMENT_BYTES;
  return Math.min(MAX_UPLOAD_CEILING_BYTES, Math.max(MIN_UPLOAD_LIMIT_BYTES, Math.floor(stored)));
}

function isParsePolicy(value: string | undefined): value is DocumentParsePolicy {
  return (
    value === "local-only" ||
    value === "local-first" ||
    value === "cloud-first" ||
    value === "cloud-only"
  );
}
