import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import type {
  AdminUser,
  AnswerToolCallInput,
  ApiErrorBody,
  ApiErrorCode,
  Attachment,
  AuthResult,
  ChatInput,
  ChatStreamEvent,
  CreateCopilotInput,
  CreateDocumentParserInput,
  CreateProviderInput,
  CreateSessionInput,
  CreateUserInput,
  CreateWorkspaceInput,
  DirectoryListing,
  DocumentParsePolicy,
  DocumentParserConfig,
  FileLocation,
  HealthResponse,
  ParseErrorCode,
  ParseStatus,
  PreviewReference,
  ProviderConfig,
  ProviderModelInput,
  PublicConfig,
  QuizAnswers,
  Session,
  SessionSettings,
  Message,
  ResourceOwner,
  SetSessionPinnedInput,
  WorkResource,
  StoredFile,
  TitleRetryResult,
  TitleState,
  ToolCall,
  TurnRequestMeta,
  UpdateCopilotInput,
  UpdateDocumentParserInput,
  UpdateDocumentParsingInput,
  UpdateProviderInput,
  UpdateUploadSettingsInput,
  UpdateSessionInput,
  UpdateUserInput,
  UpdateWorkspaceInput,
  AddResourcePageInput,
  UploadAttachmentInput,
  UploadWorkspaceFileInput,
  User,
  UserCredentials,
  UserRole,
  WidgetId,
  WidgetScope,
  WidgetState,
  Workspace,
} from "@ilearnassist/shared";
import {
  boundToolNamesForWidgetIds,
  CLIENT_ID_HEADER,
  DEFAULT_USER_ROLES,
  defaultWidgetIdsForScope,
  isEnabledSuperadmin,
  isPlatformAdmin,
  isUserRole,
  MAX_ATTACHMENT_BYTES,
  type MessageUsage,
  type UsageStats,
  MAX_UPLOAD_CEILING_BYTES,
  MIN_UPLOAD_LIMIT_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PROFILE_ABOUT_MAX,
  type UsagePurpose,
  EXPLORE_TOOL_NAME,
  PLAN_TOOL_NAMES,
  PLATFORM_ADMIN_ROLES,
  QUIZ_MAKEUP_TOOL_NAME,
  QUIZ_TOOL_NAME,
  QUIZ_TOOL_NAMES,
  SESSION_LOCK_TTL_SECONDS,
  SUPERADMIN_ROLE,
  TABLE_TOOL_NAME,
  USERNAME_MAX_LENGTH,
  WRITE_FILE_TOOL_NAME,
  type QuizMakeupSubmitBody,
  type QuizQuestion,
} from "@ilearnassist/shared";
import {
  insightReasoningSetting,
  threadReasoningSetting,
  type AppConfig,
} from "./config.js";
import {
  DEFAULT_SESSION_TITLE,
  instanceId,
  newId,
  readDocumentParsing,
  readMaxUploadBytes,
  SETTING_DEFAULT_MODEL,
  SETTING_DEFAULT_PROVIDER,
  SETTING_DOCUMENT_DEFAULT_PARSER,
  SETTING_DOCUMENT_FALLBACK,
  SETTING_DOCUMENT_LOCAL_ENABLED,
  SETTING_DOCUMENT_POLICY,
  SETTING_MAX_UPLOAD_BYTES,
  type AppDb,
  type ProviderRecord,
  type WorkResourceFilter,
  type WorkResourceRecord,
} from "./db.js";
import {
  describeParseError,
  driverInfos,
  isDocumentParserKind,
  parseErrorCodeOf,
  parseErrorDetail,
} from "./documents/index.js";
import { parseWidgetIds, widgetRowsForSelection } from "./widgets.js";
import { installWidgetForToolUse } from "./widgetInstall.js";
import { buildPlanView, jumpToNode, readPlanVersion } from "./plans.js";
import { buildThreadViews, syncThreads } from "./threads.js";
import { makeThreadClassifier } from "./agent/threads.js";
import { makeInsightGenerator } from "./agent/insights.js";
import { buildInsightViews, generateInsights } from "./insights.js";
import {
  bucketBy,
  buildSessionRows,
  buildStats,
  recordUsage,
  usageFilter,
  type StatsQuery,
} from "./usage.js";
import { createNote, deleteNote, updateNote } from "./notes.js";
import { listDiagramViews, registerDiagram } from "./diagrams.js";
import { listTableViews, registerTable } from "./tables.js";
import {
  parseTurnReferences,
  referencesForHistory,
  resolveReferences,
} from "./turnReferences.js";
import {
  dismissQuizQuestions,
  listQuizQuestionViews,
  reopenQuizAnswer,
  makeupAnswer,
  makeupQuestions,
  makeupQuestionsByQid,
  markMakeupOnCalls,
  recordMakeupAnswers,
  recordQuizAnswers,
  registerQuizQuestions,
  skipQuizQuestions,
} from "./quizzes.js";
import type { DocumentService } from "./documents/service.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { serverTimeZone, turnClock, type TurnClock } from "./agent/clock.js";
import { runAgentStream, type RunAgentResult } from "./agent/loop.js";
import { describeModel } from "./agent/model.js";
import { classifyProviderError } from "./agent/providerErrors.js";
import { fallbackTitle, generateTitle, type TitleMessage } from "./agent/title.js";
import { uniqueSessionTitle } from "./sessionTitles.js";
import { writeParsedText } from "./documents/store.js";
import { needsSummary, summarizeImage } from "./agent/mediaSummary.js";
import { createSseWriter } from "./stream.js";
import { buildTools } from "./tools/index.js";
import { QUIZ_QUESTION_COUNTER } from "./tools/quiz.js";
import { collectPageGuidance } from "./tools/collectPage.js";
import { tableGuidance } from "./tools/table.js";
import { fileWriteGuidance } from "./tools/fileTools.js";
import { exploreGuidance } from "./tools/explore.js";
import { planGuidance } from "./tools/planTools.js";
import { quizGuidance } from "./tools/quizReview.js";
import { makeupGuidance, renderMakeupResult } from "./tools/quizMakeup.js";
import { validateMakeupAnswers } from "./tools/quiz.js";
import { SUSPENDING_TOOLS } from "./tools/suspending.js";
import {
  readAsDataUrl,
  sha256Of,
} from "./attachments.js";
import { apiError } from "./apiError.js";
import { classifyFile } from "./fileCategory.js";
import {
  parsedFilePath,
  isSupportedMime,
  normalizeMime,
  rawFilePath,
  resolveFilePath,
  storePath,
  webFilePath,
} from "./resourcePaths.js";
import {
  adoptPageParse,
  deleteWorkResource,
  ensureWorkResource,
  filePathsFor,
  fileOwner,
  listResourceViewsForUser,
  sessionFilePath,
  workspaceFilePath,
  reconcileFilesystem,
  reconcileListing,
  registerFile,
  renameFileSubtree,
  trashFilePath,
} from "./resources.js";
import { createDirectory, deletePath, movePath, writeFileAt } from "./fileOps.js";
import { SCHEMA_VERSION } from "./schema.js";
import { APP_VERSION } from "./version.js";
import { resolveWriteLocation } from "./writeLocation.js";
import {
  normalizeWorkspaceScope,
  resolveWorkspaceScope,
  scopeIsEmpty,
  scopeQuery,
} from "./workspaceScope.js";
import { captureWebPage } from "./webCapture.js";
import { isFileCategory, isFileSourceType, isWorkResourceType } from "@ilearnassist/shared";
import {
  bearerToken,
  createAccount,
  currentUser,
  generatePassword,
  hashPassword,
  hashToken,
  isSuperadmin,
  issueTokens,
  passwordProblem,
  readPassword,
  readUsername,
  usernameProblem,
  revokeAllTokens,
  toWireUser,
  userForRefreshToken,
  verifyPassword,
} from "./auth.js";
import type { UserRecord } from "./db.js";
import {
  sessionDir,
  userLayout,
  workspaceTrashDir,
  type DataLayout,
  type UserLayout,
} from "./paths.js";
import { createWorkspaceDir, uniqueSlug } from "./workspace.js";
import {
  FileAccessError,
  type FileErrorCode,
  listDirectory,
  readFileContent,
  readPreviewFile,
  readRawFile,
} from "./files.js";

/**
 * The signed-in account, put on the request by the gate below.
 *
 * Optional because the gate lets the public routes through without setting it; see `actor()`
 * for how a route gets it safely.
 */
declare module "fastify" {
  interface FastifyRequest {
    /**
     * The signed-in account, as the **server** sees it — the record, not the wire shape.
     *
     * The record, because role checks and the pending-password gate are decided in here and
     * both read fields the client is never sent. Every response that carries a user goes
     * through `toWireUser`, which is what keeps the password hash from being serialised.
     */
    user?: UserRecord;
  }
  interface FastifyContextConfig {
    /**
     * Opt a route out of the auth gate.
     *
     * Declared rather than read off a cast, so `{ config: { public: true } }` is a thing the
     * type system knows about: a typo in the flag is a compile error rather than a route that
     * silently requires a session.
     */
    public?: boolean;
    /**
     * Reachable while the account still owes a password change.
     *
     * The gate refuses everything else with a 403 in that state, and this is the short list of
     * routes that have to stay open for the state to be escapable at all: asking who you are,
     * setting the new password, and signing out.
     *
     * A second flag rather than a widening of `public`, because the two answer different
     * questions — `public` means "no credential needed", this means "the credential is fine,
     * the account just has one more thing to do" — and collapsing them would let a route
     * meant for a signed-in-but-pending caller be reached by nobody at all.
     */
    allowPendingPassword?: boolean;
    /**
     * This route writes to one conversation, so only the client holding its lock may call it.
     *
     * Declared per route rather than checked per handler, because the check is the same one
     * everywhere and the interesting decision is *which* routes it covers — that list should be
     * readable in one place rather than assembled from whoever remembered. The gate resolves the
     * session id from `params.id`, which every session-scoped route names its session, and
     * refuses with `SESSION_LOCKED` for a client that holds nothing.
     *
     * Which routes carry it, and the short list that deliberately does not, is in
     * `docs/session-locks.md` — and `test/route-lock-coverage.test.ts` is what keeps the list
     * honest, since a route added without the flag compiles perfectly well.
     */
    requiresSessionLock?: boolean;
  }
}

interface RoutesOptions {
  config: AppConfig;
  db: AppDb;
  /** Owns document text extraction. */
  documents: DocumentService;
  /**
   * The data root, so a route can derive the acting user's tree.
   *
   * The tree is not passed in any more: it depends on *who is asking*, which is a fact about
   * the request rather than about the server, so it is derived per request from this and the
   * account the gate resolved.
   */
  layout: DataLayout;
}

/**
 * The route's own body limit: base64 inflates bytes by 4/3, and the JSON envelope adds a little
 * more.
 *
 * Derived from the **ceiling**, not from the configured limit, and that is forced rather than
 * chosen: `bodyLimit` is a number fixed when the route is registered, so a limit an administrator
 * can change at runtime cannot be what this reads. The handler compares against the value in force
 * (`effectiveUploadLimit`), so the two agree for every setting an administrator can save — and a
 * request past the ceiling is refused by Fastify before the handler runs, which is the one
 * refusal on this path that does not carry `FILE_TOO_LARGE`. `MAX_UPLOAD_CEILING_BYTES` says why
 * the ceiling is where it is.
 */
const ATTACHMENT_BODY_LIMIT = Math.ceil((MAX_UPLOAD_CEILING_BYTES * 4) / 3) + 64 * 1024;

/**
 * The `FILE_TOO_LARGE` refusal, built from the limit in force.
 *
 * A function because the number is no longer a constant: the message and its `limitMb` parameter
 * both have to name the cap that actually applied, and a sentence compiled against the old
 * constant is how a user is told "10 MB" by a server that refused at 50.
 */
function fileTooLarge(limit: number): ApiErrorBody {
  const limitMb = Math.round(limit / 1024 / 1024);
  return apiError("FILE_TOO_LARGE", `File is larger than the ${limitMb} MB limit`, { limitMb });
}

/** The parse-failure envelope: the code is the taxonomy value, the sentence a fallback. */
function parseApiError(err: unknown): ApiErrorBody {
  const detail = parseErrorDetail(err);
  return apiError(parseErrorCodeOf(err), describeParseError(err), detail ? { detail } : undefined);
}

/**
 * The envelope for a refused widget selection, from the code `parseWidgetIds` chose.
 *
 * The two codes get different sentences because they are different mistakes: an id this build
 * does not know is a version skew, while a widget at the wrong level is a request that was
 * assembled wrongly — and the second names the thing to change.
 */
function widgetError(code: "UNKNOWN_WIDGET" | "WIDGET_SCOPE_UNSUPPORTED"): ApiErrorBody {
  return code === "UNKNOWN_WIDGET"
    ? apiError(code, "no such widget")
    : apiError(code, "that widget cannot be installed at this level");
}

/**
 * Check the one settings field the server reads as a grant, and leave the rest alone.
 *
 * `settings` is otherwise passed straight through on both write routes — it is a JSON blob the
 * client owns, and the merge in `updateSessionForUser` is what makes a partial write work. But
 * `workspaceScope` is *not* an ordinary preference: it decides what a model may read, so a
 * malformed one is refused by name rather than stored and left to resolve to something nobody
 * chose. `"true"` for `all` is the case this exists for — it is truthy, so a coerced value
 * would be a grant the caller never asked for.
 *
 * **Ownership is not checked here**, deliberately: a workspace can be deleted between the chip
 * being drawn and the save landing, and failing the save for that would be failing it for
 * something that is not the user's fault. An id the account does not own is stored and resolves
 * to nothing at turn time — see `resolveWorkspaceScope`, which is the one place that decides.
 */
function withValidatedScope(
  settings: SessionSettings | undefined
): { ok: true; settings: SessionSettings | undefined } | { ok: false; message: string } {
  if (!settings || !("workspaceScope" in settings)) return { ok: true, settings };
  const normalized = normalizeWorkspaceScope(
    (settings as { workspaceScope?: unknown }).workspaceScope
  );
  if (!normalized.ok) return { ok: false, message: normalized.message };
  return { ok: true, settings: { ...settings, workspaceScope: normalized.value } };
}

/**
 * Map a workspace-read failure onto the envelope and the status that carries it.
 *
 * `FileAccessError` already knows which of the three it is, because that is decided where
 * the failure is detected — the only place that can tell a path that does not exist from one
 * that resolves out of the workspace. Anything else is a genuine server fault and is
 * rethrown, so Fastify answers with its own 500: a curated reply for a bug would tell the
 * user to read a friendly sentence about a file when what happened was the server breaking.
 */
function fileErrorReply(err: unknown): { status: 400 | 404 | 413; body: ApiErrorBody } {
  if (err instanceof FileAccessError) {
    // Only "there is nothing there" is a 404. Everything else — an escaping path, a
    // directory asked for as a file — is a bad request, and saying 404 would send the
    // client looking for a file that was never the problem.
    //
    // `FILE_TOO_LARGE` is the one that is neither, and it is a 413 rather than a 400 because
    // it is the only failure here the caller could have avoided by asking differently — it is
    // a real status, and no other path in this file produces it. The envelope carries the
    // limit so the sentence can name it; see `MAX_FILE_PREVIEW_BYTES`.
    return {
      status: fileErrorStatus(err.code),
      body: apiError(err.code, err.message),
    };
  }
  throw err;
}

/**
 * The status a file failure travels as.
 *
 * A switch rather than a ternary chain, and exhaustive over the codes `FileAccessError` can
 * carry: a fourth code added to `fileOps.ts` without a thought about its status is a `tsc`
 * error here rather than a 400 that happens to be wrong. The default arm is what makes that
 * work — `never` is only reachable if every other case is listed.
 */
function fileErrorStatus(code: FileErrorCode): 400 | 404 | 413 {
  switch (code) {
    case "FILE_NOT_FOUND":
      return 404;
    case "FILE_TOO_LARGE":
      return 413;
    // "This is not the kind of thing you asked for", "that name is taken" and an escaping path
    // are all the caller's to fix, and none of them is a missing resource.
    default:
      return 400;
  }
}

export default async function routes(app: FastifyInstance, opts: RoutesOptions): Promise<void> {
  const { config, db, documents, layout } = opts;

  // Read once at registration — the classifier call cannot differ between two turns of one
  // launch, and an unrecognised value names itself at boot instead of silently doing nothing.
  const threadReasoning = threadReasoningSetting();
  // The insight pass's own switch, read at the same moment for the same reason. Two variables
  // rather than one because each changes its own call alone, by design.
  const insightReasoning = insightReasoningSetting();

  /**
   * The turn currently streaming for each session, so another request can stop it.
   *
   * Stopping is its own route rather than the client aborting its fetch: the chat request
   * has to outlive the decision in order to report the partial reply, and a fetch that was
   * aborted has no stream left to send `message_done` down. So the stop route aborts this
   * controller and returns, while the turn's own request — stream still open — persists
   * what had streamed and ends normally.
   *
   * Scoped to the plugin instance, so one app never sees another's turns. Keyed by session id
   * alone, which is only safe because the stop route resolves the session `ForUser` *before*
   * consulting this map — without that read the map would be an id-guessing oracle for
   * ending a stranger's turn.
   */
  const activeTurns = new Map<string, AbortController>();

  /* ---------------------------------- identity ---------------------------------- */

  /**
   * The signed-in account, for a route the gate has already let through.
   *
   * Throws instead of returning undefined. The gate sets this on every route that is not
   * marked `public`, so a miss means a route ended up on the wrong side of that flag — and
   * failing here says so, where `undefined.id` a few lines later would say something much
   * less useful.
   */
  function actor(request: FastifyRequest): UserRecord {
    if (!request.user) throw new Error("No signed-in user on this route; is it marked public?");
    return request.user;
  }

  /**
   * Which client of this account is asking, as it says so itself.
   *
   * The id is generated by the browser per tab and is **the whole of the client's identity** —
   * deliberately not the auth token, which `issueTokens` reissues on every refresh, so a lease
   * keyed on it would change holder underneath a client that had simply been running for a day.
   *
   * It is *asserted, not verified*, and that is the honest description: the lock is advisory and
   * this is not a credential. A forged id can take a lease it should not have, which is inside
   * the tolerance `docs/session-locks.md` states rather than a hole in it — the account check on
   * the session is what protects the row, and it is unchanged.
   *
   * Empty string when absent, which is a value no client can present: the header is trimmed and
   * an empty one reads as "did not say".
   */
  function clientIdOf(request: FastifyRequest): string {
    const raw = request.headers[CLIENT_ID_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" ? value.trim() : "";
  }

  /**
   * The signed-in account *and* a platform administrator of either tier, or a reply that says
   * why not.
   *
   * Returns the reply as well as sending it, so a handler reads as
   * `const admin = requirePlatformAdmin(...); if (!admin) return reply;` — one shape rather than
   * a throw that a route would then have to translate. 403 rather than 404: the credential is
   * perfectly good, the account simply may not do this, and answering "not found" would send an
   * administrator looking for a bug in their own URL.
   *
   * It is the gate for **everything an administrator of either tier may do**, which is two
   * things: the installation's accounts, and its shared settings — providers and models,
   * document parsers, the parsing policy, the app defaults. A superadmin passes it because
   * `isPlatformAdmin` reads the closed set rather than comparing one role, which is what keeps
   * the bootstrap account from needing a second role bolted on to keep working.
   *
   * It is an *entry* gate and never the whole rule. The account routes narrow it further,
   * because the two tiers differ in what they may do there rather than in what they may reach:
   * an ordinary administrator runs the installation's accounts, and an account that administers
   * it is not one of them. The settings routes do not narrow it at all — configuring the models
   * every conversation runs on is the job the `admin` role exists for.
   */
  function requirePlatformAdmin(
    request: FastifyRequest,
    reply: FastifyReply
  ): UserRecord | undefined {
    const user = actor(request);
    if (isPlatformAdmin(user)) return user;
    void reply.code(403).send(apiError("FORBIDDEN", "only an administrator can manage accounts"));
    return undefined;
  }

  /**
   * Why this administrator may not change that account, or undefined.
   *
   * The tiering rule, in one place, because it is the same answer for demote, disable, reset
   * and kick — and four copies of it is four chances for one to be forgotten.
   *
   * A superadmin may act on anybody. An ordinary administrator may act on accounts that
   * administer nothing: not on a superadmin, and not on a peer either. That last part is a
   * deliberate choice rather than an oversight — two ordinary administrators disabling each
   * other is a race whose winner is whoever clicked second, and the tier that appoints
   * administrators is the tier that should be able to undo one.
   *
   * **Your own row is not "an administrator's row."** The tier rule is about one administrator
   * reaching another, and every route below already has its own careful answer for the self
   * case — an ordinary administrator may still reset their own password, and neither tier may
   * disable or demote itself. Leaving `me` out of this predicate is what keeps those from being
   * shadowed by a broader refusal that never considered them.
   */
  function manageRefusal(
    me: UserRecord,
    target: UserRecord
  ): ApiErrorBody | undefined {
    if (isSuperadmin(me)) return undefined;
    if (target.id === me.id) return undefined;
    if (isPlatformAdmin(target)) {
      return apiError("CANNOT_MODIFY_ADMIN", "only a superadmin can manage an administrator");
    }
    return undefined;
  }

  /**
   * Why this administrator may not hand out those roles, or undefined.
   *
   * Separate from `manageRefusal` because it is about the *value being written* rather than
   * the row being read: creating a new account with `admin` is not touching an administrator,
   * and it is still the appointment this tier does not have. Refused rather than quietly
   * stripped down to `user` — a request that asked for an administrator and got an ordinary
   * account reports success and delivers something else.
   *
   * The superadmin role is refused for **every** HTTP caller, including a superadmin. An
   * installation has exactly one superadmin, the account the control panel bootstraps with the
   * server stopped; it cannot be created a second time or appointed from a screen, and the
   * bootstrap CLI is the one place that can write it (and it refuses once one exists). This is
   * why a request that merely *restates* the role the target already holds is refused too: no
   * console flow ever sends one, so distinguishing "grant" from "keep" would buy nothing and
   * leave a second mint path open.
   */
  function grantRefusal(me: UserRecord, roles: UserRole[]): ApiErrorBody | undefined {
    if (roles.includes(SUPERADMIN_ROLE)) {
      return apiError(
        "SUPERADMIN_NOT_GRANTABLE",
        "the superadmin is created in the control panel and cannot be assigned here"
      );
    }
    if (!isSuperadmin(me) && roles.some((role) => PLATFORM_ADMIN_ROLES.includes(role))) {
      return apiError("ROLES_NOT_GRANTABLE", "only a superadmin can grant the administrator role");
    }
    return undefined;
  }

  /** Whether a set of roles still includes something that administers the platform. */
  const holdsAdminRole = (roles: UserRole[]): boolean =>
    roles.some((role) => PLATFORM_ADMIN_ROLES.includes(role));

  /**
   * A hash to check a login against when there is no account to check it against.
   *
   * Without it, a name that exists returns after ~80ms of `scrypt` and a name that does not
   * returns immediately, which turns the login route into a way to enumerate accounts. Built
   * once on first use rather than at module load, because it is a real `scrypt` call and a
   * server that never sees a bad username should not pay for it at boot.
   */
  let decoyHash: string | undefined;
  async function decoy(): Promise<string> {
    decoyHash ??= await hashPassword("decoy-password-for-timing-only");
    return decoyHash;
  }

  /**
   * A `roles` array from a request body, or undefined when it is not one this build knows.
   *
   * Unknown names are **refused rather than dropped**, for the reason an unknown widget id is:
   * a dropped one is a selection that looks like it worked — the box was ticked, the request
   * succeeded, and the account does not have it. An empty list is refused too, because an
   * account holding no roles can reach nothing and there is no screen that would say why.
   *
   * Returns undefined for "not supplied" as well as "bad", so the caller has to distinguish
   * them: `PATCH` reads a missing field as "leave it alone", which is not what a malformed one
   * means. That is why the two checks at the call sites are separate rather than one `if`.
   */
  function normalizeRoles(value: unknown): UserRole[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (!value.every(isUserRole)) return undefined;
    return [...new Set(value as UserRole[])];
  }

  /** The console's view of an account. Built here rather than in the DB layer: it is a shape. */
  const toAdminUser = (u: UserRecord): AdminUser => ({
    id: u.id,
    username: u.username,
    slug: u.slug,
    roles: u.roles,
    disabled: u.disabled,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt,
  });

  /** The acting user's tree: where its workspaces are created, and deleted from. */
  const treeFor = (user: User): UserLayout => userLayout(layout, user.slug);

  /**
   * The gate: every route needs a signed-in account unless it opts out.
   *
   * Deny by default rather than a list of protected routes, so a route added tomorrow
   * without a thought about auth is *refused* — the same move as the `read_document`
   * whitelist, where the safe state is the one you get by doing nothing. Eight routes opt out
   * with `public` — the four that obtain a session or say whether one is possible, the three
   * that make a pending password change escapable, and the control panel's recovery route,
   * which carries a secret instead. Each says why where it is declared.
   *
   * The second refusal is the pending password change, and it is here rather than in the
   * client for the reason any rule enforced only by a client is not enforced: the account
   * holds a working token, so the screen it shows is a suggestion to anything that can make
   * a request. Three routes stay reachable in that state — ask who you are, set the new
   * password, sign out — which is what makes it a state you can leave.
   *
   * This hook belongs to the `routes` plugin, so it covers the API and nothing else: the
   * built frontend served by `webApp.ts` is a sibling plugin and stays public, which is what
   * lets a browser load the login screen in the first place.
   */
  app.addHook("onRequest", async (request, reply) => {
    const routeConfig = request.routeOptions.config;
    if (routeConfig?.public === true) return;
    const user = currentUser(request, db);
    if (!user) return reply.code(401).send(apiError("UNAUTHENTICATED", "sign in to continue"));
    if (user.mustChangePassword && routeConfig?.allowPendingPassword !== true) {
      return reply
        .code(403)
        .send(apiError("PASSWORD_CHANGE_REQUIRED", "choose a new password before continuing"));
    }
    request.user = user;
  });

  /*
   * The write gate, on its own hook rather than folded into the one above.
   *
   * `onRequest` hooks run in registration order and the one above sets `request.user`, so this
   * has to come after it — and a second hook is what makes that ordering legible instead of a
   * fact about where somebody put a line. It is also the only check that looks at what the
   * request is *about* rather than who is asking, which is a different question from auth.
   *
   * **It renews a lease; it never takes one.** A gated write by the holder renews it (a write is
   * evidence of presence, so an active client's lease cannot lapse between beats) and a write on a
   * conversation nobody holds is allowed — there is no conflict to refuse. What it does *not* do is
   * claim a free conversation on the strength of the write. That was the first shape, and it was
   * wrong in a way only a second writer shows: any API client writing to a conversation would
   * seize its lock and leave the reader's own tab read-only for two minutes, having never asked for
   * a lease and having no lifecycle to give it back. A lease exists because a client *opened* a
   * conversation; a write is not that act.
   *
   * The cost is the narrow race two clients on a free conversation would run — both write, neither
   * holds — and that is inside the tolerance `docs/session-locks.md` records rather than a hole in
   * it. Two clients that both opened the conversation are both coordinated; a client that opened it
   * is the only one that can hold a lease.
   *
   * A client with **no id** can never hold a lease, so it is refused like a client holding the
   * wrong one — the header is how a client says who it is, and a request that does not say cannot
   * be told apart from one that is not the holder. The suite's helpers send an id (`injectAs` on
   * the server, `fixtures.ts` on the browser side), so this costs the tests nothing and the rule
   * stays uniform: to write, name yourself.
   *
   * **It does not answer for a session that does not exist, and needs no second read to avoid
   * it.** The lease lookup is owner-scoped, so a conversation that is not this account's — or is
   * not there at all — finds no lease, this returns, and the route answers its own 404. Answering
   * the conflict instead would be a second and differently-shaped answer about existence: a bad id
   * in a URL coming back "somebody is editing this" for a conversation nobody can edit, which is
   * the one thing the codebase's "not yours and does not exist are one answer" rule forbids.
   */
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config?.requiresSessionLock !== true) return;
    const user = actor(request);
    const sessionId = (request.params as { id?: string }).id ?? "";
    if (!sessionId) return;
    const clientId = clientIdOf(request);
    const conflict = () =>
      reply
        .code(409)
        .send(apiError("SESSION_LOCKED", "this conversation is being edited from another client"));
    if (!clientId) return conflict();

    const held = db.sessionLockFor(sessionId, user.id, clientId);
    // Free: there is no conflict to refuse, and deliberately no lease taken — see above.
    if (!held) return;
    if (!held.mine) return conflict();
    // Ours: renew it. Checked, because the lease can move between the read above and this write,
    // and a renewal that lost that race means this client is no longer the holder.
    if (
      !db.acquireSessionLock({
        sessionId,
        userId: user.id,
        clientId,
        ttlSeconds: SESSION_LOCK_TTL_SECONDS,
      })
    ) {
      return conflict();
    }
  });

  /* ----------------------------------- auth ----------------------------------- */

  /**
   * Sign in.
   *
   * Two answers, and the split between them is deliberate. A name that does not exist and a
   * password that is wrong get the **same** 401, so the reply cannot be read to find out which
   * accounts exist — and the `scrypt` check runs either way, against a decoy hash when there
   * is no account, because the timing would otherwise say what the sentence does not.
   *
   * A disabled account gets a 403 instead, and that is not a leak: it is only reachable after
   * a *correct* password, so the caller has already proved they know which account it is.
   */
  app.post("/api/auth/login", { config: { public: true } }, async (request, reply) => {
    /*
     * The API's half of the boot rule.
     *
     * `main()` refuses to *listen* without an administrator, so a server started the ordinary way
     * never reaches this line with nobody able to sign in. It stays because `buildServer` is
     * usable on its own — the test harness does exactly that, and so would any embedder — and a
     * caller in that state deserves a sentence it can act on rather than a 401 that reads as a
     * wrong password. The administrator is created by the control panel, or by the CLI on a
     * machine that has no panel.
     */
    if (!db.hasPasswordAccounts()) {
      return reply
        .code(409)
        .send(apiError("SETUP_REQUIRED", "this installation has no administrator yet"));
    }

    const body = request.body as { username?: unknown; password?: unknown } | undefined;
    const username = readUsername(body?.username);
    const password = readPassword(body?.password);
    if (!username) return reply.code(400).send(apiError("USERNAME_REQUIRED", "username is required"));
    if (!password) return reply.code(400).send(apiError("PASSWORD_REQUIRED", "a password is required"));

    const user = db.findUserByUsername(username);
    /*
     * `stored` is what the password is checked against, and it is checked **in the condition**
     * rather than only fed to `verifyPassword`.
     *
     * The decoy is there to keep the *timing* honest when there is nothing to compare against
     * — but its verdict is a verdict, and a hash of a known string would otherwise be a working
     * password for every account that has none. That state is not hypothetical: it is exactly
     * the data root carried over from the build where a username was the credential, which is
     * what `ensureColumn(users.password_hash)` and `hasPasswordAccounts` exist to support. So
     * an account with no password cannot sign in, whatever it presents.
     */
    const stored = user?.passwordHash ?? null;
    const ok = await verifyPassword(password, stored ?? (await decoy()));
    if (!user || !stored || !ok) {
      return reply.code(401).send(apiError("INVALID_CREDENTIALS", "username or password is wrong"));
    }
    if (user.disabled) {
      return reply.code(403).send(apiError("ACCOUNT_DISABLED", "this account is disabled"));
    }

    const result: AuthResult = { user: toWireUser(user), tokens: issueTokens(db, user.id) };
    return result;
  });

  /**
   * Exchange a refresh token for a fresh pair.
   *
   * The presented token is **spent** — revoked before the new one is issued — so a refresh
   * token is good exactly once. That is what bounds a stolen one to a single exchange and
   * makes the theft visible: the real client's next refresh fails, and it signs in again
   * while the copy stops working.
   *
   * Only the token presented is revoked. Another device's refresh token is a session in its
   * own right, and ending it here would mean every device but the busiest one kept getting
   * signed out.
   *
   * Because each exchange resets the week, a client that keeps working never signs in again —
   * which is the "stay signed in as long as possible" behaviour, without a token that never
   * expires. A client that stops is signed out a week later.
   */
  app.post("/api/auth/refresh", { config: { public: true } }, async (request, reply) => {
    const body = request.body as { refreshToken?: unknown } | undefined;
    const presented = typeof body?.refreshToken === "string" ? body.refreshToken : "";
    const user = presented ? userForRefreshToken(db, presented) : undefined;
    if (!user) {
      return reply
        .code(401)
        .send(apiError("INVALID_REFRESH_TOKEN", "sign in again to continue"));
    }

    db.revokeAuthToken(hashToken(presented), new Date().toISOString());
    const result: AuthResult = { user: toWireUser(user), tokens: issueTokens(db, user.id) };
    return result;
  });

  /**
   * End this client's session.
   *
   * Public, and it revokes whatever it is handed: the access token from the header and the
   * refresh token from the body. Neither is required, so a client that has already lost one
   * can still spend the other, and answering `ok` either way means signing out cannot fail in
   * a way the user would have to do something about.
   *
   * Deliberately *not* "revoke everything this account holds": signing out of one device is
   * not a request to sign out of the others, and the console's kick is the control for that.
   */
  app.post("/api/auth/logout", { config: { public: true } }, async (request) => {
    const at = new Date().toISOString();
    const access = bearerToken(request);
    if (access) db.revokeAuthToken(hashToken(access), at);
    const body = request.body as { refreshToken?: unknown } | undefined;
    const refresh = typeof body?.refreshToken === "string" ? body.refreshToken : "";
    if (refresh) db.revokeAuthToken(hashToken(refresh), at);
    return { ok: true };
  });

  /**
   * Who the caller is, or a 401.
   *
   * Public, because a 401 here is the *answer* rather than a refusal: no page script can read
   * the token of a load that has not happened yet, so a cold start has no other way to ask
   * whether anyone is signed in. The client knows that and keeps this route's 401 out of the
   * "your session expired" path — otherwise every first visit would open with an error about
   * a session that never existed.
   */
  app.get("/api/auth/me", { config: { public: true } }, async (request, reply) => {
    const user = currentUser(request, db);
    if (!user) return reply.code(401).send(apiError("UNAUTHENTICATED", "sign in to continue"));
    return toWireUser(user);
  });

  /**
   * Edit your own record — which today means the introduction.
   *
   * **`about` is the one field of its own record an account may write**, and the reason this route
   * is not the console's is the split the console is built on: the console configures what every
   * account shares, and this is a thing one account says about itself. The username is out on
   * purpose (a rename is display-only and the `slug` never moves), and the roles and the disabled
   * flag are an administrator's.
   *
   * Deliberately **not** `allowPendingPassword`: an account owing a password change is refused
   * every route but the three that get it out of that state, and writing a profile is not one of
   * them.
   *
   * Trimmed before storing, unlike a workspace description. The two look alike and are not:
   * a description is prose somebody wrote for other people to read back, and this is an input to a
   * prompt, where leading and trailing whitespace is only ever an accident of the textarea.
   */
  app.patch("/api/auth/me", async (request, reply) => {
    const user = actor(request);
    const body = request.body as { about?: unknown } | undefined;
    const about = body?.about;
    if (typeof about !== "string") {
      // Never coerced: `String(undefined)` would store "undefined" into every turn's prompt.
      return reply
        .code(400)
        .send(apiError("INVALID_FIELD", "about must be a string", { field: "about" }));
    }
    const trimmed = about.trim();
    if (trimmed.length > PROFILE_ABOUT_MAX) {
      return reply.code(400).send(
        apiError("INVALID_FIELD", "the introduction is too long", {
          field: "about",
          max: PROFILE_ABOUT_MAX,
        })
      );
    }
    return toWireUser(db.setUserAbout(user.id, trimmed)!);
  });

  /**
   * Change your own password.
   *
   * Reachable while a password change is still owed — that is the point of the flag on this
   * route, since the account is holding a token and would otherwise be refused everything
   * including the way out. The old password is required here and nowhere else: this is the
   * one path where somebody is asserting a password they *chose*, and asking for it is what
   * stops a stolen token from being turned into a permanent account takeover.
   *
   * Every session the account holds is ended, including this one, and a fresh pair is
   * returned for this client. A password is changed because something may have gone wrong,
   * and a token obtained under the old one outliving the change is exactly what would make
   * the change not matter.
   */
  app.post(
    "/api/auth/password",
    { config: { allowPendingPassword: true } },
    async (request, reply) => {
      const user = actor(request);
      const body = request.body as { oldPassword?: unknown; newPassword?: unknown } | undefined;
      const oldPassword = readPassword(body?.oldPassword);
      const newPassword = readPassword(body?.newPassword);

      const ok = await verifyPassword(oldPassword, user.passwordHash);
      if (!ok) {
        return reply
          .code(400)
          .send(apiError("INVALID_CREDENTIALS", "the current password is wrong"));
      }
      const weak = passwordProblem(newPassword);
      if (weak) return reply.code(400).send(weak);
      // Refused rather than accepted, because the account was told to *choose* a password: the
      // same value would clear the flag with the decision still unmade, and the screen the
      // user just left would have changed nothing.
      if (newPassword === oldPassword) {
        return reply
          .code(400)
          .send(apiError("PASSWORD_UNCHANGED", "the new password is the current one"));
      }

      const updated = db.setUserPassword(user.id, await hashPassword(newPassword), false)!;
      revokeAllTokens(db, user.id);
      const result: AuthResult = { user: toWireUser(updated), tokens: issueTokens(db, user.id) };
      return result;
    }
  );

  /* --------------------------------- accounts ---------------------------------- */
  /*
   * The platform console's side of accounts. Every route here is a superadmin's, and the
   * guard is the first line of each rather than a hook of its own: this is a handful of
   * routes on one path prefix, and a `preHandler` would be a second place to look to find
   * out who may call what.
   *
   * There is no DELETE. "Remove a user" is `PATCH { disabled: true }`, because the row is not
   * only a credential — it owns workspaces, conversations and uploaded files, and there is no
   * version of deleting it that does not either destroy that or strand it. Disabling ends the
   * account's sessions and refuses the next sign-in, which is what "remove this user" means
   * in practice.
   */

  app.get("/api/admin/users", async (request, reply) => {
    // The wider gate: an ordinary administrator has to be able to *see* the accounts, which is
    // also how the console knows what it may offer them. What they may then do with each row is
    // decided per row below, and refused by each write route in its own right.
    if (!requirePlatformAdmin(request, reply)) return reply;
    const users = db.listUsers().map(toAdminUser);
    return { users };
  });

  /**
   * Create an account, and hand back the password it was given.
   *
   * The password is generated rather than chosen by the administrator, and it is returned
   * **once**. Only a hash is stored, so there is nothing to re-read afterwards — not for the
   * user, not for the administrator — which is why the console pairs this reply with a copy
   * button and a note to send it on.
   *
   * `mustChangePassword` is set, so what the administrator hands over is a way in rather than
   * a password the account keeps.
   */
  app.post("/api/admin/users", async (request, reply) => {
    const admin = requirePlatformAdmin(request, reply);
    if (!admin) return reply;

    const body = request.body as CreateUserInput | undefined;
    const username = readUsername(body?.username);
    const named = usernameProblem(username);
    if (named) return reply.code(400).send(named);

    // An omitted `roles` is the ordinary case and means "an account", not "no roles" — so the
    // absent value never reaches `normalizeRoles`, which reads absent and malformed alike.
    const roles = body?.roles === undefined ? [...DEFAULT_USER_ROLES] : normalizeRoles(body.roles);
    if (!roles) {
      return reply.code(400).send(apiError("INVALID_FIELD", "unknown role", { field: "roles" }));
    }
    const ungrantable = grantRefusal(admin, roles);
    if (ungrantable) return reply.code(403).send(ungrantable);
    // Checked before `createAccount`, because that is the side with the filesystem half of
    // slug uniqueness — and a name already taken should be a 409, not a second directory.
    if (db.findUserByUsername(username)) {
      return reply.code(409).send(apiError("USERNAME_TAKEN", "that username is taken"));
    }

    const password = generatePassword();
    const { user } = createAccount(db, layout, {
      username,
      roles,
      passwordHash: await hashPassword(password),
      mustChangePassword: true,
    });

    const result: UserCredentials = { user: toAdminUser(user), password };
    return result;
  });

  /**
   * Change what an account may do, or whether it can sign in at all.
   *
   * A username is not among the fields: it is half of how somebody signs in and the other
   * half is a password they were told, so a rename is a new account as far as anyone can
   * tell. `slug` is never in play either — the directory keeps the name it was created with,
   * which is what keeps every path already written under it valid.
   *
   * Disabling ends the account's sessions in the same request. A disabled account whose token
   * still worked for up to a day would be a control that reports a state it does not have.
   */
  app.patch("/api/admin/users/:id", async (request, reply) => {
    const admin = requirePlatformAdmin(request, reply);
    if (!admin) return reply;

    const { id } = request.params as { id: string };
    const target = db.getUser(id);
    if (!target) return reply.code(404).send(apiError("USER_NOT_FOUND", "no such account"));

    const refusal = manageRefusal(admin, target);
    if (refusal) return reply.code(403).send(refusal);

    const body = request.body as UpdateUserInput | undefined;
    const roles = body?.roles === undefined ? undefined : normalizeRoles(body.roles);
    if (body?.roles !== undefined && !roles) {
      return reply
        .code(400)
        .send(apiError("INVALID_FIELD", "unknown role", { field: "roles" }));
    }
    if (roles) {
      const ungrantable = grantRefusal(admin, roles);
      if (ungrantable) return reply.code(403).send(ungrantable);
    }

    /*
     * Refused rather than coerced, and this is the one place in the product where coercion
     * would be a security bug rather than a tidy-up: `disabled: "false"` is truthy, so
     * `disable === true` misses the self-guard below while `setUserDisabled` stores 1 — an
     * administrator could disable their own account past the check that exists to stop them,
     * and then nobody could reach the console. The console sends real booleans, so anything
     * else is a hand-written request, and the right answer to one is to say what was wrong.
     */
    const disabled = body?.disabled;
    if (disabled !== undefined && typeof disabled !== "boolean") {
      return reply
        .code(400)
        .send(apiError("INVALID_FIELD", "disabled must be true or false", { field: "disabled" }));
    }
    const losesAdminRole =
      holdsAdminRole(target.roles) &&
      (disabled === true || (roles !== undefined && !holdsAdminRole(roles)));

    /*
     * The self-guard is the whole of the "somebody has to remain" rule, and it is enough.
     *
     * A separate "you may not remove the last administrator" check looks like the obvious
     * second half, and it is unreachable: reaching this route at all means the caller holds a
     * role that administers the platform, on an account the gate already refused to see
     * disabled, so there is always one administrator besides the target. By induction the
     * count can never reach zero — which is why the check that *is* here is about who is
     * asking rather than about how many are left. Written the other way it would be a branch
     * nobody could cover.
     *
     * It reads `holdsAdminRole` rather than the superadmin role alone, and the difference is
     * the second tier: an ordinary administrator demoting themselves would lose the console
     * they are standing in exactly as a superadmin would, so the same refusal is owed to both.
     */
    if (losesAdminRole && target.id === admin.id) {
      return reply
        .code(400)
        .send(apiError("CANNOT_MODIFY_SELF", "you cannot disable or demote your own account"));
    }

    if (roles) db.setUserRoles(target.id, roles);
    if (disabled !== undefined) db.setUserDisabled(target.id, disabled);
    if (disabled === true) revokeAllTokens(db, target.id);

    return toAdminUser(db.getUser(target.id)!);
  });

  /**
   * Give an account a new password without knowing the old one.
   *
   * The old password is not required, and the asymmetry with `/auth/password` is the point:
   * that route is somebody asserting a password they chose, and this is an administrator who
   * by definition may not know it. The recovery path for a forgotten password is here.
   *
   * **The one case that does not set `mustChangePassword` is resetting your own.** The
   * administrator doing it is signed in, chose the value a moment ago, and is about to keep
   * using it — so a screen demanding they replace what they just typed would be a step with
   * nothing behind it. Resetting somebody else's always sets it, because that password was
   * read off a screen and sent through a chat window.
   *
   * Every session the target holds is ended either way. When the target is the caller, fresh
   * tokens come back in the reply — otherwise the administrator would be signed out by their
   * own action, which is the one way this route could look like a bug.
   *
   * **A superadmin's own password is not reset here at all.** That is the one case this route
   * refuses outright, and it is a rule rather than a convenience: the console is reached with a
   * credential the caller already holds, so a self-reset here would be a second and weaker way
   * to replace the single credential that can undo the installation — one that leaves no trace
   * anywhere but a token row. The control panel is the way back in by design, because turning it
   * on is what "this is the machine" means. Resetting *another* administrator's is ordinary.
   */
  app.post("/api/admin/users/:id/password", async (request, reply) => {
    const admin = requirePlatformAdmin(request, reply);
    if (!admin) return reply;

    const { id } = request.params as { id: string };
    const target = db.getUser(id);
    if (!target) return reply.code(404).send(apiError("USER_NOT_FOUND", "no such account"));

    const refusal = manageRefusal(admin, target);
    if (refusal) return reply.code(403).send(refusal);
    if (target.id === admin.id && isSuperadmin(admin)) {
      return reply
        .code(400)
        .send(
          apiError(
            "PANEL_RESET_REQUIRED",
            "a superadmin resets their own password in the control panel"
          )
        );
    }

    const body = request.body as { password?: unknown } | undefined;
    const chosen = readPassword(body?.password);
    let password: string;
    if (chosen) {
      const weak = passwordProblem(chosen);
      if (weak) return reply.code(400).send(weak);
      password = chosen;
    } else {
      password = generatePassword();
    }

    const self = target.id === admin.id;
    const updated = db.setUserPassword(target.id, await hashPassword(password), !self)!;
    revokeAllTokens(db, target.id);

    const result: UserCredentials = {
      user: toAdminUser(updated),
      password,
      // Present exactly when the reset ended the caller's own session, so the client has
      // something to swap in rather than a 401 on its next request.
      tokens: self ? issueTokens(db, admin.id) : undefined,
    };
    return result;
  });

  /**
   * End every session an account holds.
   *
   * A request rather than a request to change anything else, because "sign that account out
   * now" is a thing an administrator needs on its own: a laptop left open, a token that may
   * have leaked, somebody who should stop being able to act while the rest stays as it is.
   * The password is untouched — this is not a reset and the account keeps the credential it
   * has.
   *
   * Refused against your own account, because the control is for ending somebody else's
   * session and signing yourself out already has a button.
   */
  app.post("/api/admin/users/:id/revoke", async (request, reply) => {
    const admin = requirePlatformAdmin(request, reply);
    if (!admin) return reply;

    const { id } = request.params as { id: string };
    const target = db.getUser(id);
    if (!target) return reply.code(404).send(apiError("USER_NOT_FOUND", "no such account"));
    if (target.id === admin.id) {
      return reply
        .code(400)
        .send(apiError("CANNOT_MODIFY_SELF", "sign out from the account menu instead"));
    }
    const refusal = manageRefusal(admin, target);
    if (refusal) return reply.code(403).send(refusal);

    return { ok: true, revoked: revokeAllTokens(db, target.id) };
  });

  /*
   * There is deliberately **no HTTP route that resets a forgotten password**, and its absence
   * is a design decision rather than an omission.
   *
   * Every route above is reached by somebody already signed in, which is exactly what a
   * forgotten administrator password prevents — so recovery cannot live here at all. It lives
   * in the administrator CLI (`reset-admin`), which the control panel spawns as a one-shot
   * child on the operator's own machine. There used to be a route, guarded by a per-launch
   * secret the panel shared with the server it spawned; the CLI replaced it because the secret
   * bought nothing the process boundary did not already buy (see `docs/desktop.md`) and because
   * a recovery path that needs the server to be *up* is not much of a recovery path.
   */

  /* --------------------------------- resolution -------------------------------- */
  /*
   * Effective provider/model resolve in a fixed order, most specific first:
   *   explicit request override ⊳ session settings ⊳ app default.
   * A candidate only wins if it still exists, so a deleted provider degrades instead of erroring.
   *
   * The Copilot tier that used to sit between the session and the app default is gone: its
   * defaults were merged into `session.settings` when the conversation was created, so a turn
   * resolves against the session alone. That is why nothing here takes a Copilot.
   */

  const providerExists = (id: string | null | undefined): id is string =>
    !!id && db.getProvider(id) !== undefined;

  /**
   * `title`, or the next free numbered form of it within one workspace.
   *
   * Every path that names a conversation comes through here — creation, a rename, and the
   * auto-titler's own suggestion — because a name is only unique *relative to its siblings*, and
   * this is the one place that reads them. `listSessionsForUser` already filters out deleted
   * sessions and deleted workspaces, which is exactly the set a reader sees in the sidebar.
   *
   * `excludeId` is the session being renamed: without it, re-saving a conversation under the
   * name it already has would find itself taken and hand back `X (2)`.
   */
  function uniqueTitleIn(
    workspaceId: string,
    userId: string,
    title: string,
    excludeId?: string
  ): string {
    const taken = new Set(
      db
        .listSessionsForUser(workspaceId, userId)
        .filter((s) => s.id !== excludeId)
        .map((s) => s.title)
    );
    return uniqueSessionTitle(title, (t) => taken.has(t));
  }

  function resolveDefaultProviderId(): string {
    const stored = db.getSetting(SETTING_DEFAULT_PROVIDER);
    if (providerExists(stored)) return stored;
    if (providerExists(config.defaultProvider)) return config.defaultProvider;
    return db.listProviders()[0]?.id ?? "";
  }

  function resolveProviderId(
    override: string | null | undefined,
    settings: SessionSettings
  ): string {
    for (const candidate of [override, settings.providerId]) {
      if (providerExists(candidate)) return candidate;
    }
    return resolveDefaultProviderId();
  }

  function resolveModelId(
    provider: ProviderRecord | undefined,
    override: string | null | undefined,
    settings: SessionSettings
  ): string {
    const known = new Set((provider?.models ?? []).map((m) => m.modelId));
    const candidates = [
      override,
      settings.modelId,
      db.getSetting(SETTING_DEFAULT_MODEL),
      config.defaultModel,
    ];
    for (const candidate of candidates) {
      if (candidate && known.has(candidate)) return candidate;
    }
    return provider?.models[0]?.modelId ?? "";
  }

  /** Whether the chosen model accepts image input (drives the multimodal placeholder). */
  const isVisionModel = (provider: ProviderRecord | undefined, modelId: string): boolean =>
    !!provider?.models.find((m) => m.modelId === modelId)?.capabilities.includes("vision");

  /** Drives how a truncated document is explained — see `BuildContentOptions.toolUse`. */
  const isToolUseModel = (provider: ProviderRecord | undefined, modelId: string): boolean =>
    !!provider?.models.find((m) => m.modelId === modelId)?.capabilities.includes("tool_use");

  function providerConfigs(): ProviderConfig[] {
    return db.listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      models: p.models,
      hasApiKey: !!p.apiKey,
    }));
  }

  function documentParserConfigs(): DocumentParserConfig[] {
    return db.listDocumentParsers().map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseURL: p.baseURL,
      enabled: p.enabled,
      hasApiKey: !!p.apiKey,
    }));
  }

  const documentParsing = () =>
    readDocumentParsing(db, {
      localEnabled: config.documentParsing.localEnabled,
      policy: config.documentParsing.policy,
      fallbackEnabled: config.documentParsing.fallbackEnabled,
      defaultParserId: config.documentParsing.defaultParserId ?? null,
    });

  /**
   * What the client is allowed to know about this installation.
   *
   * Takes the caller because one field is per-account: `workspacesRootDir` is the *caller's*
   * tree, which is a fact about them rather than about the server. Providers and parsing
   * policy stay installation-wide — see the note in `docs/architecture.md` about what that
   * does and does not leak.
   */
  function publicConfig(user: User): PublicConfig {
    return {
      defaultProvider: resolveDefaultProviderId(),
      defaultModel: db.getSetting(SETTING_DEFAULT_MODEL) ?? config.defaultModel,
      providers: providerConfigs(),
      workspacesRootDir: treeFor(user).workspacesRoot,
      webSearchProvider: config.tools.webSearch.provider,
      documentParsers: documentParserConfigs(),
      documentParsing: documentParsing(),
      // Read per request rather than cached: it is one `app_settings` lookup, and a cached value
      // would be a second copy free to disagree with the one the upload routes enforce.
      maxUploadBytes: readMaxUploadBytes(db),
    };
  }

  /* ------------------------------- config/health ------------------------------- */

  // Public: a liveness probe that needs a session cannot do its job, and it reports nothing
  // about the data.
  app.get(
    "/api/health",
    { config: { public: true } },
    async (): Promise<HealthResponse> => ({
      ok: true,
      instance: instanceId(db),
      // The pair a deployment asks about itself: which build is running, and which schema it
      // writes. Reported, never asserted — a client that ignores them is unaffected.
      appVersion: APP_VERSION,
      schemaVersion: SCHEMA_VERSION,
    })
  );

  app.get("/api/config", async (request) => publicConfig(actor(request)));

  /* -------------------------------- workspaces -------------------------------- */

  app.get("/api/workspaces", async (request) => db.listWorkspaces(actor(request).id));

  app.post("/api/workspaces", async (request, reply) => {
    const user = actor(request);
    const body = request.body as CreateWorkspaceInput;
    const name = body?.name?.trim();
    if (!name) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));

    // Validated before anything is created, so a bad widget id cannot leave a half-made
    // workspace behind: the name check above and this one are both refusals that must precede
    // the write.
    const widgets = parseWidgetIds(body?.widgets, "workspace");
    if (!widgets.ok) return reply.code(400).send(widgetError(widgets.code));

    const slug = uniqueSlug(treeFor(user).workspacesRoot, name);
    // Creates the workspace's own directory *and* the two inside it — `workdir/` for the
    // agent to work in, `sessions/` for its conversations. One call, so neither can be
    // forgotten and a workspace is never half-made.
    const dirPath = createWorkspaceDir(treeFor(user).workspacesRoot, slug);
    // Verbatim, like the `PATCH` route's description and unlike the name above: a description is
    // prose somebody wrote, and trimming it would be this app editing their sentence.
    const workspace = db.createWorkspace({
      id: newId(),
      userId: user.id,
      name,
      slug,
      dirPath,
      description: body?.description ?? "",
    });

    /*
     * The widget selection lands here, in one go, because a workspace does not exist when its
     * boxes are ticked — which is what makes `installed` a moment per widget rather than a
     * sequence of flips. Only the *differences* from the default are written, so an object whose
     * state equals the defaults needs no rows at all.
     *
     * No failure path from here on: the workspace exists, and a write that threw would leave it
     * unusable rather than uncreated.
     */
    for (const row of widgetRowsForSelection("workspace", widgets.ids)) {
      db.setWorkspaceWidgetForUser(user.id, workspace.id, row.id, row.enabled);
    }
    return reply.code(201).send(workspace);
  });

  /**
   * Rename a workspace, describe it, change its defaults, or any combination.
   *
   * All three are one route because they are one resource's `PATCH`, and each is **optional and
   * independent**: a rename sends a name, the settings form sends a settings object and a
   * description, and a request that sends several does all of them. The alternative — a name
   * that must be present to reach the settings, or a settings write that silently renamed the
   * workspace to `undefined` — is the shape a single-field route grows into as it gains fields.
   *
   * The name and the description go in one statement (`patchWorkspaceForUser`); `settings` is
   * separate because it is a whole-object write, not a column.
   *
   * Renaming is display-only. The directory keeps its original slug — see
   * `patchWorkspaceForUser` in `db.ts` — so nothing on disk moves underneath a running agent.
   */
  app.patch("/api/workspaces/:id", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const body = request.body as UpdateWorkspaceInput;
    if (!db.getWorkspaceForUser(id, userId)) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    const name = body?.name?.trim();
    if (body?.name !== undefined && !name) {
      return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));
    }

    let workspace = db.patchWorkspaceForUser(id, userId, {
      // Omitted and empty mean different things here too: `undefined` leaves the stored name
      // alone, and an empty one never reaches the statement because it was refused above.
      ...(name !== undefined ? { name } : {}),
      ...(body?.description !== undefined ? { description: body.description } : {}),
    });
    if (body?.settings !== undefined) {
      workspace = db.setWorkspaceSettingsForUser(id, userId, body.settings);
    }
    return workspace ?? db.getWorkspaceForUser(id, userId);
  });

  /**
   * Soft delete. The workspace leaves every list and the directory stays — `workdir/`, the
   * `sessions/` beside it holding each conversation's own files, and every row hanging off this
   * one. Nothing is dismantled: the rows are reached through the workspace, so hiding it here
   * is what hides them, and the files being kept is what would make a future restore possible
   * at all. For the diagrams the agent drew, that is the whole of the file's life: there is no
   * row to hide, so the bytes on disk *are* what a restore would have to find.
   */
  app.delete("/api/workspaces/:id", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getWorkspaceForUser(id, userId)) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }
    db.softDeleteWorkspaceForUser(id, userId);
    return { ok: true };
  });

  /* ------------------------------ workspace files ------------------------------ */

  /**
   * A listing with each file's source id attached.
   *
   * This is where "every file is a source" is actually made true, and it is a *read* that makes
   * it so — deliberately, because the writers cannot. The agent's `delete_file` is a plain
   * filesystem operation that must not become a database write, and a file can appear with no
   * writer at all: dropped in from the Finder, restored from a backup, cloned into the
   * workspace. Reconciliation is idempotent, it is one query per listing rather than one per
   * entry, and it is a no-op whenever every entry already has a row — which is the common case.
   *
   * It lives in the route rather than in `files.ts` because that module has no database and is
   * meant to stay that way; the read it rides on already writes, since the session listing
   * creates the directory it is about to list.
   *
   * Directories are left alone: a directory is not a file, so a listing full of them — a
   * `node_modules` — costs the query and nothing else.
   */
  function withFileIds(
    listing: DirectoryListing,
    userId: string,
    owner: ResourceOwner,
    pathFor: (rel: string) => string
  ): DirectoryListing {
    const ids = reconcileListing(db, { userId, owner, pathFor, entries: listing.entries });
    return {
      ...listing,
      entries: listing.entries.map((entry) => {
        const id = entry.type === "file" ? ids.get(entry.path) : undefined;
        return id ? { ...entry, fileId: id } : entry;
      }),
    };
  }

  /**
   * The reference a previewed file is held by, so the dialog can offer to annotate it.
   *
   * A preview is reached by **path**, while a note about a file is anchored to a **reference id** —
   * and the file's own id is a third thing that the notes API refuses. The two lookups are the
   * bridge, and they belong here rather than on the client because the client has only the path:
   * turning that into a `files` row means knowing how the sandbox maps onto the account's root,
   * which is this side's business in every other route as well.
   *
   * **The owner's own row wins when a file has several.** A file written in a conversation and
   * also walked into its workspace has two references, and a note filed against the one belonging
   * to the *other* owner would be a note this conversation may not be able to read back. The
   * fallback is the first live row, which is the right answer for a workspace file whose only
   * reference is the workspace's own.
   */
  function referenceFor(
    userId: string,
    storedPath: string,
    owner: ResourceOwner
  ): PreviewReference | undefined {
    const file = db.getFileByPath(userId, storedPath);
    if (!file) return undefined;
    const held = db.listWorkResourcesForResource(userId, "file", file.id);
    const mine = held.find((row) => row.ownerType === owner.kind && row.ownerId === owner.id);
    const row = mine ?? held[0];
    return row ? { id: row.id, title: row.title, ...(row.summary ? { summary: row.summary } : {}) } : undefined;
  }

  /**
   * The browser's two reads. Both are keyed on the workspace id and a path *relative to the
   * workspace root*, and both answer from disk — there is no index and nothing cached, so a
   * file the agent wrote a moment ago is there on the next request.
   *
   * Listing one level at a time is what keeps this usable on a workspace with a
   * `node_modules` in it: a tree is expanded by the user, so only the levels they opened are
   * ever read. The client caches each level under its own path, which is why the reply
   * echoes the path back rather than leaving the caller to assume it.
   *
   * The write endpoints sit below, on the same resource shape: a path names the thing, and the
   * verb says what to do to it.
   */
  app.get("/api/workspaces/:workspaceId/files", async (request, reply) => {
    const userId = actor(request).id;
    const { workspaceId } = request.params as { workspaceId: string };
    // `string[]` is not hypothetical: `?path=a&path=b` parses to an array, and the module
    // refuses it rather than letting a string operation on it become a 500.
    const { path } = request.query as { path?: string | string[] };
    const workspace = db.getWorkspaceForUser(workspaceId, userId);
    if (!workspace) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    try {
      const listing = await listDirectory(workspace.workdirPath, path);
      return withFileIds(listing, userId, { kind: "workspace", id: workspaceId }, (rel) =>
        workspaceFilePath(workspace.slug, rel)
      );
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  app.get("/api/workspaces/:workspaceId/files/content", async (request, reply) => {
    const userId = actor(request).id;
    const { workspaceId } = request.params as { workspaceId: string };
    const { path } = request.query as { path?: string | string[] };
    const workspace = db.getWorkspaceForUser(workspaceId, userId);
    if (!workspace) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    try {
      const content = await readFileContent(workspace.workdirPath, path);
      // The reference, when there is one, so the dialog can offer 标注/笔记 — see
      // `referenceFor`. Only for a path that resolved: a `string[]` never reaches here.
      if (typeof path === "string") {
        const reference = referenceFor(userId, workspaceFilePath(workspace.slug, path), {
          kind: "workspace",
          id: workspaceId,
        });
        if (reference) content.reference = reference;
      }
      return content;
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  /**
   * The bytes themselves, for the preview viewer.
   *
   * A second endpoint rather than a field on the one above, because the two carry different
   * kinds of thing. `/files/content` answers *what this is*, in JSON, and stops at 256 KB;
   * this answers *here are the bytes* and goes to `MAX_FILE_PREVIEW_BYTES`. A PDF cannot ride
   * in the first, and a 40 MB one cannot ride in the second.
   *
   * The type is deliberately `application/octet-stream` with `Content-Disposition: attachment`
   * rather than the file's own, which is a divergence from `/api/resources/:id/raw` — and that
   * route should keep serving the real `mimeType`. It serves the account's own uploads to an
   * `<img>`, where an SVG is inert. This one serves bytes the *agent* may have written into a
   * sandbox, and the client hands them to a viewer that re-materialises some of them (a
   * `.docx` becomes HTML), so handing them to a browser as a scriptable type is the wrong
   * trade for no gain. The client re-labels the blob from the file name, which is also how the
   * viewer matches its plugins.
   *
   * The bearer token is what actually protects this: a browser attaches no `Authorization`
   * header to an `<img src>`, an `<iframe>` or a navigation, so the URL is unreachable except
   * by our own `fetch`. The headers are the second line, not the first.
   */
  app.get("/api/workspaces/:workspaceId/files/raw", async (request, reply) => {
    const userId = actor(request).id;
    const { workspaceId } = request.params as { workspaceId: string };
    const { path } = request.query as { path?: string | string[] };
    const workspace = db.getWorkspaceForUser(workspaceId, userId);
    if (!workspace) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    try {
      const { bytes } = await readRawFile(workspace.workdirPath, path);
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", "attachment")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Length", String(bytes.length))
        .send(bytes);
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  /*
   * ------------------------------ workspace writes ------------------------------
   *
   * The four operations a file manager needs, and each is a **filesystem change plus the row
   * that records it**. There is no way to do one without the other: a file the registry does not
   * know about is a file `@`-reference cannot name and the browser cannot filter, and a row
   * whose file has moved is a listing that shows the same file twice.
   *
   * The order is always bytes first, rows second. A row written before a write that then failed
   * would name something that does not exist — and the next listing's reconcile would repair it
   * anyway, which is exactly why the row half is allowed to be the simpler half.
   *
   * Every one of these resolves its paths through `fileOps.ts`, which uses the *same*
   * `resolveReal` the reads do: lexical containment and then `realpath`, so a symlink inside the
   * workspace cannot be written through. A delete is the case that makes the strictness matter
   * most, and it is the one operation whose mistake cannot be walked back.
   */

  /** The pieces every write below needs: whose workspace, where its sandbox is, where trash is. */
  function writeTarget(
    request: FastifyRequest
  ): { userId: string; workspace: Workspace } | undefined {
    const userId = actor(request).id;
    const { workspaceId } = request.params as { workspaceId: string };
    const workspace = db.getWorkspaceForUser(workspaceId, userId);
    return workspace ? { userId, workspace } : undefined;
  }

  /**
   * The file row for a path, created if nobody has one, and made referenceable.
   *
   * The file-manager routes are ordinary *writers*: a file the user uploads here is one they
   * chose deliberately, so it gets both rows — the entity and the reference — exactly as an
   * upload into a conversation does. That is what separates this from a reconciliation, which
   * only adds a reference for a file it itself discovered.
   */
  function fileAt(
    workspace: Workspace,
    userId: string,
    relPath: string,
    size: number,
    sourceType: "upload" | "discovered",
    /**
     * What the person adding it called it, when they added it by hand.
     *
     * Absent everywhere else — a reconcile discovers a file it did not name — and absent means
     * the file row's own title (its name), which is the reference's default.
     */
    named: { title?: string } = {}
  ): WorkResourceRecord | undefined {
    const path = workspaceFilePath(workspace.slug, relPath);
    const existing = db.getFileByPath(userId, path);
    const file =
      existing ??
      registerFile(db, {
        userId,
        path,
        sourceType,
        size,
      });
    return ensureWorkResource(db, {
      userId,
      owner: { kind: "workspace", id: workspace.id },
      resourceType: "file",
      resourceId: file.id,
      title: named.title ?? file.title,
    });
  }

  /**
   * Create a directory.
   *
   * Registers nothing, because a directory is not a file — and that is stated here as well as
   * in the file tools so the symmetry argument ("every write leaves a row") cannot grow one
   * quietly in either place.
   */
  app.post("/api/workspaces/:workspaceId/files/directory", async (request, reply) => {
    const target = writeTarget(request);
    if (!target) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    const body = request.body as { path?: string };

    try {
      const created = await createDirectory(target.workspace.workdirPath, body?.path ?? "");
      return reply.code(201).send({ path: created.rel, type: "dir" });
    } catch (err) {
      const { status, body: failure } = fileErrorReply(err);
      return reply.code(status).send(failure);
    }
  });

  /**
   * Upload a file into a directory.
   *
   * The name and the directory arrive as **two fields**, and the name is refused if it contains
   * a separator: the client chooses where in the sandbox this lands, and "the name is a path" is
   * how an upload ends up somewhere the person did not point at. The bytes are base64 in JSON,
   * like the chat upload route, which is what keeps this dependency-free (`@fastify/multipart`
   * is not installed) at the cost of a ~33% larger body — hence the raised `bodyLimit`.
   *
   * The cap is the same one the chat upload uses rather than something larger, deliberately: two
   * numbers would be two answers to "how big a file may I put in this app", and both now name the
   * limit they applied so raising it is a visible change rather than a guess.
   */
  app.post(
    "/api/workspaces/:workspaceId/files/upload",
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
    async (request, reply) => {
      const target = writeTarget(request);
      if (!target) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
      const body = request.body as UploadWorkspaceFileInput;

      const name = body?.name?.trim() ?? "";
      if (!name || name.includes("/") || name.includes("\\") || name.includes("\0")) {
        return reply.code(400).send(apiError("NAME_REQUIRED", "a file name without a path is required"));
      }
      if (typeof body?.data !== "string" || body.data === "") {
        return reply.code(400).send(apiError("DATA_REQUIRED", "file data is required"));
      }

      const bytes = Buffer.from(body.data, "base64");
      if (bytes.length === 0) {
        return reply.code(400).send(apiError("INVALID_BASE64", "file data could not be decoded"));
      }
      const uploadLimit = readMaxUploadBytes(db);
      if (bytes.length > uploadLimit) {
        // With the `limitMb` the other route has always carried, and which this one used to omit:
        // the number is a setting now, so a refusal that does not name it leaves the user to
        // guess which of two numbers they hit.
        return reply.code(413).send(fileTooLarge(uploadLimit));
      }

      const dir = (body.dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
      const relPath = dir ? `${dir}/${name}` : name;

      try {
        const written = await writeFileAt(target.workspace.workdirPath, relPath, bytes);
        const row = fileAt(target.workspace, target.userId, written.rel, bytes.byteLength, "upload", {
          // Optional, and the default is the file's own name — which is what the dialog's
          // placeholder promises and what every caller before this got.
          title: body?.title?.trim() || undefined,
        });
        return reply.code(201).send(row ? { ...toResource(row), missing: false } : { missing: true });
      } catch (err) {
        const { status, body: failure } = fileErrorReply(err);
        return reply.code(status).send(failure);
      }
    }
  );

  /**
   * Move or rename a file or a directory.
   *
   * Both paths are resolved before either is touched, so a refusal leaves the tree as it was.
   * The destination must be free — a file manager that overwrites on a name collision loses work
   * without asking — and a directory move carries its rows with it (`renameSourceSubtree`),
   * because a file whose row still names its old place is listed twice.
   */
  app.post("/api/workspaces/:workspaceId/files/move", async (request, reply) => {
    const target = writeTarget(request);
    if (!target) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    const body = request.body as { from?: string; to?: string };

    try {
      const moved = await movePath(
        target.workspace.workdirPath,
        body?.from ?? "",
        body?.to ?? ""
      );
      const rows = renameFileSubtree(db, {
        userId: target.userId,
        from: workspaceFilePath(target.workspace.slug, moved.from.rel),
        to: workspaceFilePath(target.workspace.slug, moved.to.rel),
      });
      // Nothing to move means nothing had a row — a file that arrived with no writer. The next
      // listing reconciles it at its new place, so this is not an error.
      void rows;
      return { from: moved.from.rel, to: moved.to.rel };
    } catch (err) {
      const { status, body: failure } = fileErrorReply(err);
      return reply.code(status).send(failure);
    }
  });

  /**
   * Delete a file from the file manager, or an empty directory.
   *
   * **The route is a path; the operation is a reference.** A file tree can only name what it is
   * showing, so this is where "delete `notes/plan.md`" is turned into "delete the work resource
   * that represents that file here" — and the deleting itself is
   * `deleteWorkResource`'s, the same call the library's rows make. That is what makes one intent
   * have one consequence and one sentence in the dialog, whichever surface the reader pressed.
   *
   * Two things a directory needs that a file does not: the bytes move without a row to mark (its
   * contents are separate rows, each deleted on the way down), and an unreferenced file — one no
   * writer ever made referenceable — has no work resource at all, so there is nothing to delete
   * but the bytes. Both are the file manager's own cases, not exceptions to the rule.
   *
   * **The bytes move to `trash/`, they are not destroyed**: the row is what hides the file from
   * every listing at once, and the bytes being kept is what a future restore would restore. A
   * populated directory is refused, exactly as the agent's `delete_file` refuses it — one click in
   * a browser is not a good place to be recursively destroying work someone never saw.
   */
  app.delete("/api/workspaces/:workspaceId/files", async (request, reply) => {
    const target = writeTarget(request);
    if (!target) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    const { path } = request.query as { path?: string | string[] };
    if (typeof path !== "string" || path === "") {
      return reply.code(400).send(apiError("INVALID_FILE_PATH", "a path is required"));
    }

    try {
      // The file row is resolved (or made) before anything moves, because its id namespaces the
      // trash directory — two deletions from different directories must not collide — and because
      // it is what says which work resource represents this file.
      const size = await stat(join(target.workspace.workdirPath, path)).then(
        (info) => info.size,
        () => 0
      );
      const stored = workspaceFilePath(target.workspace.slug, path);
      const file =
        db.getFileByPath(target.userId, stored) ??
        registerFile(db, {
          userId: target.userId,
          path: stored,
          sourceType: "discovered",
          size,
        });

      const held = db
        .listWorkResourcesForResource(target.userId, "file", file.id)
        .find((row) => row.ownerType === "workspace" && row.ownerId === target.workspace.id);
      if (held) {
        // The one operation: the reference goes, its material goes, and every *other* reference
        // to that material stays where it is and reports the loss when it is opened.
        await deleteWorkResource(db, treeFor(actor(request)), {
          userId: target.userId,
          id: held.id,
        });
        return { ok: true, path };
      }

      const removed = await deletePath(
        target.workspace.workdirPath,
        workspaceTrashDir(target.workspace.dirPath),
        path,
        file.id
      );
      if (!removed.wasDirectory) {
        // The bytes have moved, so the stored locator moves with them — and the row is marked
        // deleted rather than removed, which is what lets a restore find it again.
        db.updateFilePath(file.id, target.userId, {
          path: trashFilePath(target.workspace.slug, file.id, path),
        });
        db.softDeleteFileForUser(file.id, target.userId);
      }
      return { ok: true, path: removed.rel };
    } catch (err) {
      const { status, body: failure } = fileErrorReply(err);
      return reply.code(status).send(failure);
    }
  });

  /* --------------------------------- copilots --------------------------------- */
  /*
   * Copilots are owned, and *publishable* rather than tiered: a Copilot the operator wants every
   * account to have is simply one they published. So "platform Copilot" is not a kind, it is the
   * admin's public rows, and "ordinary users cannot edit it" needs no privilege check — the
   * owner-only writes below are the whole of it.
   *
   * The read/write split is the policy: `GET` answers with the caller's own Copilots plus every
   * public one, while `PUT`/`DELETE` take the narrower owned predicate. An id that is someone
   * else's private Copilot answers 404 rather than 403, so an id cannot be probed.
   */

  app.get("/api/copilots", async (request) => db.listCopilotsForUser(actor(request).id));

  app.post("/api/copilots", async (request, reply) => {
    const body = request.body as CreateCopilotInput;
    if (!body?.name?.trim()) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));
    // At **session** scope, which is the level a Copilot installs at: its selection is copied
    // into the conversation it starts, so a workspace-scope widget here is a request that cannot
    // mean anything.
    const widgets = parseWidgetIds(body.widgets, "session");
    if (!widgets.ok) return reply.code(400).send(widgetError(widgets.code));
    const copilot = db.createCopilot({
      id: newId(),
      userId: actor(request).id,
      name: body.name.trim(),
      description: body.description ?? "",
      systemPrompt: body.systemPrompt ?? "",
      // Every tool unless asked otherwise, which is what an untouched Copilot meant before
      // the flag existed. `false` is what makes "no tools" reachable.
      allTools: body.allTools !== false,
      tools: body.tools ?? [],
      settings: body.settings ?? {},
      // The session-scope defaults, because a Copilot installs into a session: an id of another
      // scope would be refused by `widgetRowsForSelection("session", …)` when a conversation is
      // created from this Copilot, not filtered here.
      widgets: widgets.ids ?? defaultWidgetIdsForScope("session"),
      // Private unless asked otherwise: publishing puts a persona in front of every account,
      // so it is something the owner opts into rather than a default they discover later.
      visibility: body.visibility === "public" ? "public" : "private",
    });
    return reply.code(201).send(copilot);
  });

  app.put("/api/copilots/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateCopilotInput;
    const userId = actor(request).id;
    // The owned read, not `getCopilotForUser`: a public Copilot someone else published is
    // usable but not editable, and this is the read that keeps those two apart.
    const existing = db.getOwnedCopilot(id, userId);
    if (!existing) return reply.code(404).send(apiError("COPILOT_NOT_FOUND", "copilot not found"));
    const widgets = parseWidgetIds(body.widgets, "session");
    if (!widgets.ok) return reply.code(400).send(widgetError(widgets.code));
    const copilot = db.updateCopilotForUser(id, userId, {
      name: body.name?.trim() ?? existing.name,
      description: body.description ?? existing.description,
      systemPrompt: body.systemPrompt ?? existing.systemPrompt,
      // Absent leaves the stored flag alone, so a client that predates the field cannot
      // silently widen a Copilot that had been restricted to no tools.
      allTools: body.allTools ?? existing.allTools,
      tools: body.tools ?? existing.tools,
      settings: body.settings ?? existing.settings,
      // Absent leaves the stored selection alone, for the same reason — a form that does not
      // mention widgets must not clear them.
      widgets: widgets.ids ?? existing.widgets,
      visibility: body.visibility ?? existing.visibility,
    });
    if (!copilot) return reply.code(404).send(apiError("COPILOT_NOT_FOUND", "copilot not found"));
    return copilot;
  });

  /** Soft delete. Conversations started from it keep working — they read their own snapshot. */
  app.delete("/api/copilots/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.softDeleteCopilotForUser(id, actor(request).id)) {
      return reply.code(404).send(apiError("COPILOT_NOT_FOUND", "copilot not found"));
    }
    return { ok: true };
  });

  /* --------------------------------- sessions --------------------------------- */

  /*
   * Session write locks. Three routes and one hook — see `docs/session-locks.md`.
   *
   * None of the three declares `requiresSessionLock`: `/lock` is how the lock is taken, so gating
   * it would be a lock that required itself, and the other two are a read and a release.
   */

  /**
   * Take the conversation, or renew it. A second call by the holder is a heartbeat, not an error.
   *
   * The re-entrancy falls out of the statement rather than being a branch here: the same client's
   * call matches the upsert's own `WHERE` and takes the update path. That is what lets one
   * endpoint serve both the claim on entering a conversation and the once-a-minute beat, which is
   * the shape the client wants — it never has to know whether it is the first or the fiftieth.
   */
  app.post("/api/sessions/:id/lock", async (request, reply) => {
    const user = actor(request);
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, user.id)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const clientId = clientIdOf(request);
    const lock = clientId
      ? db.acquireSessionLock({
          sessionId: id,
          userId: user.id,
          clientId,
          ttlSeconds: SESSION_LOCK_TTL_SECONDS,
        })
      : undefined;
    if (!lock) {
      // One answer for "somebody else is editing this" and "you did not say who you are": the
      // second is a client that can never hold a lease, so it is not a different situation to the
      // reader, and saying which would be telling a caller about a client it cannot see. The 404
      // above already ran, so this is never about a conversation the caller does not own.
      return reply.code(409).send(apiError("SESSION_LOCKED", "this conversation is held by another client"));
    }
    return { lock };
  });

  /**
   * Give the conversation back.
   *
   * Answers 200 whatever happened, like `/leave`, because the caller is leaving either way: a
   * release for a lease that already expired, or one this client never held, is what a stale tab
   * does, and turning that into a failure would only give it something to retry. `released` says
   * which it was, which is the part a caller can act on.
   */
  app.delete("/api/sessions/:id/lock", async (request) => {
    const user = actor(request);
    const { id } = request.params as { id: string };
    const released = db.releaseSessionLock({
      sessionId: id,
      userId: user.id,
      clientId: clientIdOf(request),
    });
    return { released };
  });

  /**
   * Every live lease in a workspace, in one request.
   *
   * Workspace-wide rather than per conversation on purpose: the session list is where the marks
   * are drawn, so a per-session shape would make one check N requests — and the client already
   * re-reads the list this way. `mine` is computed against the asking client, which is why the
   * response is a list of *views* rather than of rows.
   */
  app.get("/api/workspaces/:workspaceId/locks", async (request, reply) => {
    const userId = actor(request).id;
    const { workspaceId } = request.params as { workspaceId: string };
    if (!db.getWorkspaceForUser(workspaceId, userId)) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }
    return { locks: db.listSessionLocksForUser(workspaceId, userId, clientIdOf(request)) };
  });

  app.get("/api/workspaces/:workspaceId/sessions", async (request, reply) => {
    const userId = actor(request).id;
    const { workspaceId } = request.params as { workspaceId: string };
    const workspace = db.getWorkspaceForUser(workspaceId, userId);
    if (!workspace) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    return db.listSessionsForUser(workspaceId, userId);
  });

  app.post("/api/workspaces/:workspaceId/sessions", async (request, reply) => {
    const userId = actor(request).id;
    const { workspaceId } = request.params as { workspaceId: string };
    const body = request.body as CreateSessionInput;
    const workspace = db.getWorkspaceForUser(workspaceId, userId);
    if (!workspace) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));

    const copilotId = body?.copilotId ?? null;
    // The *usable* read, so the caller's own Copilots and any public one, and nothing else. A
    // named Copilot that is not reachable is refused rather than quietly dropped: silently
    // starting a Copilotless conversation would turn a rejected id into a session that looks
    // as though it worked, and this is the path that used to hand over another account's
    // private persona.
    const copilot = copilotId ? db.getCopilotForUser(copilotId, userId) : undefined;
    if (copilotId && !copilot) {
      return reply.code(404).send(apiError("COPILOT_NOT_FOUND", "copilot not found"));
    }

    const widgets = parseWidgetIds(body?.widgets, "session");
    if (!widgets.ok) return reply.code(400).send(widgetError(widgets.code));

    // Before the merge below, so a malformed grant cannot be one of the three levels laid down.
    const settings = withValidatedScope(body?.settings);
    if (!settings.ok) return reply.code(400).send(apiError("INVALID_FIELD", settings.message));

    const session = db.createSession({
      id: newId(),
      workspaceId,
      copilotId,
      // The Copilot is *copied*, not referenced — all four parts of it. `settings` was always
      // copied; the prompt and the tool allowlist joined it because a live-read persona meant
      // editing a Copilot rewrote conversations already underway, and a live-read allowlist
      // meant deleting one silently widened them, an empty list reading as "all tools".
      copilotName: copilot?.name ?? "",
      systemPrompt: copilot?.systemPrompt ?? "",
      // A Copilotless conversation gets every tool, as it always has; the allowlist is only
      // meaningful alongside `allTools: false`, which is what a restricting Copilot carries.
      allTools: copilot?.allTools ?? true,
      tools: copilot ? [...copilot.tools] : [],
      /*
       * A caller that names nothing gets the placeholder, and then the sibling check numbers it
       * — so three conversations created in a row read `(未命名) 会话`, `(未命名) 会话 (2)` and
       * `(未命名) 会话 (3)` rather than sharing one label until each has been talked to.
       *
       * The web client sends the placeholder itself, in the language being read; this constant
       * is what a script or the CLI gets. Both go through the same numbering, because a title
       * the client chose is no more entitled to a collision than one it did not.
       */
      title: uniqueTitleIn(workspaceId, userId, body?.title?.trim() || DEFAULT_SESSION_TITLE),
      /*
       * The parameters are merged here rather than patched in afterwards, which is what the
       * client used to do: create, then `PATCH /api/sessions/:id`. Two writes leave a window in
       * which the conversation exists with parameters nobody chose, and — the half that is
       * observable — a failure between them leaves it that way permanently.
       *
       * **Three levels, widest first**, which is the whole of the write-location precedence
       * and the reason it needs no machinery of its own: a workspace's default is the base, a
       * Copilot's value is laid over it, and the request's is laid over that. After this the
       * conversation carries its own resolved copy, so the turn path reads the session and
       * nothing else — the same rule that keeps an edited Copilot from rewriting the
       * conversations that came from it.
       */
      settings: {
        ...(workspace.settings ?? {}),
        ...(copilot?.settings ?? {}),
        ...(settings.settings ?? {}),
      },
    });

    /*
     * Three tiers, in order: what the dialog sent, what the Copilot installs, what a fresh
     * conversation defaults to. `undefined` falls through and `[]` stops — the absent/empty
     * distinction `all_tools` documents, for the same reason: "nobody decided" and "decided:
     * none" are different claims, and collapsing them would make a Copilot's selection
     * unoverridable.
     */
    const desired = widgets.ids ?? (copilot ? copilot.widgets : undefined);
    for (const row of widgetRowsForSelection("session", desired)) {
      db.setSessionWidgetForUser(userId, session.id, row.id, row.enabled);
    }
    /*
     * The conversation's own directory, made now rather than when something first wants it, so
     * that "this conversation has a folder" is true from the moment it exists.
     *
     * Best-effort, and the writer does not depend on it: `ila_diagram` makes the directory
     * itself before it writes, the session-files listing makes it before it reads, and this
     * route is not the only way a session comes to exist — the plan widget's snapshot fork
     * writes one straight to the database. A data root on a read-only volume must not turn
     * starting a conversation into an error over a directory nobody is using *yet*.
     */
    try {
      mkdirSync(sessionDir(workspace.dirPath, session.id), { recursive: true });
    } catch {
      // Ignored on purpose — see above.
    }
    return reply.code(201).send(session);
  });

  /**
   * Rename, retune, or re-persona a conversation.
   *
   * `systemPrompt` is where "this conversation should behave differently" now lives. It used to
   * be a mid-turn Copilot switch, which the snapshot model makes meaningless — moving the link
   * would move the label and leave the persona behind — so editing the conversation's own prompt
   * is the affordance that replaced it, and it leaves the Copilot it came from untouched.
   */
  app.patch("/api/sessions/:id", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const body = request.body as UpdateSessionInput;
    const existing = db.getSessionForUser(id, userId);
    if (!existing) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    if (body?.title !== undefined && !body.title.trim()) {
      return reply.code(400).send(apiError("TITLE_EMPTY", "title must not be empty"));
    }
    const settings = withValidatedScope(body?.settings);
    if (!settings.ok) return reply.code(400).send(apiError("INVALID_FIELD", settings.message));
    return db.updateSessionForUser(id, userId, {
      /*
       * Numbered against its siblings, excluding itself — re-saving under the name it already
       * has must not turn it into `X (2)`. A rename is deliberately **suffixed rather than
       * refused**: two conversations called the same thing is exactly the list this avoids, and
       * refusing would mean losing the edit the user had already made. `TITLE_EMPTY` above is
       * the one title this route rejects, because there is no name to number.
       */
      title: body?.title?.trim()
        ? uniqueTitleIn(existing.session.workspaceId, userId, body.title.trim(), id)
        : undefined,
      description: body?.description,
      settings: settings.settings,
      systemPrompt: body?.systemPrompt,
      allTools: body?.allTools,
      tools: body?.tools,
    });
  });

  /**
   * Pin a conversation to the top of the sidebar's list, or take it back out.
   *
   * A route of its own rather than a field on the PATCH above, for two reasons. Pinning must not
   * count as activity — the statement it writes deliberately leaves `updated_at` alone, or
   * unpinning would drop the conversation at the top of the other group — and the update route
   * writes that column on every call. And it is one column: routing it through the settings and
   * persona path would be three reads and a JSON round trip to move a row in a list.
   *
   * `requiresSessionLock` like every other session-scoped write: a pin is visible to the other
   * clients of this account, so it is exactly the kind of change the lease exists to serialise.
   */
  app.patch("/api/sessions/:id/pin", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const body = request.body as SetSessionPinnedInput;

    /*
     * A real boolean or nothing. `"false"` is truthy, so a coerced body would *pin* a
     * conversation whose caller asked for the opposite — the mistake
     * `PATCH /api/admin/users/:id` refuses to make with `disabled`, and refused here for the same
     * reason rather than for symmetry: the two states are both deliberate, so there is no absent
     * field that could mean either.
     */
    if (typeof body?.pinned !== "boolean") {
      return reply.code(400).send(apiError("INVALID_FIELD", "pinned must be a boolean"));
    }

    // "Not yours" and "does not exist" are one answer here too: the accessor's own `WHERE` holds
    // the owner, so a refused write and a missing session are the same `undefined`.
    const updated = db.setSessionPinnedForUser(id, userId, body.pinned);
    if (!updated) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    return updated;
  });

  /**
   * Soft delete a conversation.
   *
   * Everything stays: the messages, the source links, the plan and its versions, the quiz rows,
   * and the conversation's own `sessions/<id>/` directory with the diagrams it drew. They are
   * all reached through this row, so filtering it here is the whole of what removes them from
   * view — and leaving them in place is what would let a restore put the conversation back
   * together rather than in pieces. The directory is the sharpest case of that: a diagram is a
   * file and nothing else, so there is no row to bring back and the bytes are the record.
   *
   * An in-flight turn is aborted first, the same way `POST /stop` aborts one, so a deleted
   * conversation stops costing tokens immediately. It does not stop that turn's own `finishTurn`
   * from writing its partial reply — but that row belongs to this session and is filtered out
   * with it, which is exactly why nothing has to be reconciled afterwards.
   */
  app.delete("/api/sessions/:id", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }

    activeTurns.get(id)?.abort();
    db.softDeleteSessionForUser(id, userId);
    return { ok: true };
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    return db.listMessagesForUser(id, userId);
  });

  /**
   * Delete one message, and only ever the conversation's last live one.
   *
   * The tail rule is a product decision rather than a technical limit: peeling from the end is
   * the one deletion that cannot leave a reply hanging over a question that is no longer there.
   * Delete the last and the one before it becomes the last, so this is a loop the user can
   * repeat — but a message with anything after it is refused, and the client does not even
   * offer the control on one.
   *
   * The read and the write are one transaction. Two tabs both looking at a conversation see
   * the same "last", and without the transaction both would pass the check and both would
   * write; with it, the loser's `UPDATE` lands on a row that is no longer the tail and it gets
   * the same 409 a middle message does.
   *
   * Answering questions the deleted message asked: a `ila_quiz` call that was still awaiting an
   * answer leaves its question rows `pending`, which is a card that can never be submitted once
   * the call is gone. They are retired here, in the same transaction, rather than left for the
   * read-side reconciliation to notice later.
   */
  app.delete("/api/sessions/:id/messages/:messageId", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id, messageId } = request.params as { id: string; messageId: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    // A message id from another conversation is not this conversation's message, and answers
    // the same way as one that does not exist.
    const message = db.getMessageForUser(messageId, userId);
    if (!message || message.sessionId !== id) {
      return reply.code(404).send(apiError("MESSAGE_NOT_FOUND", "message not found"));
    }
    if (activeTurns.has(id)) {
      return reply.code(409).send(apiError("TURN_IN_PROGRESS", "a reply is still being generated"));
    }

    const removed = db.raw.transaction(() => {
      const live = db.listMessagesForUser(id, userId);
      if (live.length === 0 || live[live.length - 1]!.id !== messageId) return false;
      if (!db.softDeleteMessageForUser(id, messageId, userId)) return false;
      skipQuizQuestions(
        db,
        id,
        (message.toolCalls ?? []).filter((tc) => tc.name === QUIZ_TOOL_NAME).map((tc) => tc.id)
      );
      return true;
    })();

    if (!removed) {
      return reply.code(409).send(apiError("MESSAGE_NOT_LAST", "only the last message can be deleted"));
    }
    return { ok: true };
  });

  /* --------------------------------- widgets --------------------------------- */

  /*
   * These live in this plugin rather than in one of their own, and the reason is the auth hook
   * above: `onRequest` belongs to the `routes` plugin, so a sibling would either have to
   * re-implement the deny-by-default gate — two copies of the rule that exists to have one — or
   * leave six endpoints open.
   *
   * The write is a `PUT` on `(scope, scopeId, widgetId)` rather than a `PATCH` on a collection,
   * because the triple *is* the resource and `{ enabled }` is its whole state. That makes a
   * double-clicked toggle idempotent, which is the only property a toggle actually needs.
   */

  /**
   * A workspace's widgets at workspace scope, resolved and in registry order.
   *
   * Separate from the session read below because the settings dialog must work from the home
   * page's card and from the welcome screen, where there is no conversation to ask about.
   */
  app.get("/api/workspaces/:id/widgets", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getWorkspaceForUser(id, userId)) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }
    return db.listWorkspaceWidgetsForUser(userId, id);
  });

  app.put("/api/workspaces/:id/widgets/:widgetId", async (request, reply) => {
    const userId = actor(request).id;
    const { id, widgetId } = request.params as { id: string; widgetId: string };
    const body = request.body as { enabled?: boolean };
    if (!db.getWorkspaceForUser(id, userId)) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }
    const result = setWidget(userId, "workspace", id, widgetId, body);
    return result.ok ? result.state : reply.code(result.status).send(result.body);
  });

  /**
   * A conversation's widgets: **both groups, in one reply**.
   *
   * The tab strip is a single control, so splitting this across two reads would let it render
   * half-drawn — and the divider's position depends on both lists. The client's two groups are
   * the `enabled` entries of each, in the order they arrive.
   */
  app.get("/api/sessions/:id/widgets", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    return {
      workspace: db.listWorkspaceWidgetsForUser(userId, found.session.workspaceId),
      session: db.listSessionWidgetsForUser(userId, id),
    };
  });

  app.put("/api/sessions/:id/widgets/:widgetId", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id, widgetId } = request.params as { id: string; widgetId: string };
    const body = request.body as { enabled?: boolean };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const result = setWidget(userId, "session", id, widgetId, body);
    return result.ok ? result.state : reply.code(result.status).send(result.body);
  });

  type WidgetWrite =
    | { ok: true; state: WidgetState }
    | { ok: false; status: 400 | 404; body: ApiErrorBody };

  /**
   * Validate one widget id, set it, and answer its resolved state.
   *
   * Shared by the two writes because they differ only in which object they name. The id goes
   * through the same `parseWidgetIds` every other path uses — as a one-element list — so "is this
   * a widget this build knows, at this level" has exactly one implementation rather than a second
   * one that could drift.
   *
   * The reply is not composed by hand: it is read back out of the same resolved list the `GET`
   * returns, so what a toggle answers and what a reload shows cannot disagree.
   */
  function setWidget(
    userId: string,
    scope: WidgetScope,
    scopeId: string,
    widgetId: string,
    body: { enabled?: boolean }
  ): WidgetWrite {
    const parsed = parseWidgetIds([widgetId], scope);
    if (!parsed.ok) return { ok: false, status: 400, body: widgetError(parsed.code) };
    if (typeof body?.enabled !== "boolean") {
      return { ok: false, status: 400, body: apiError("DATA_REQUIRED", "enabled is required") };
    }
    const id = widgetId as WidgetId;

    const wrote =
      scope === "workspace"
        ? db.setWorkspaceWidgetForUser(userId, scopeId, id, body.enabled)
        : db.setSessionWidgetForUser(userId, scopeId, id, body.enabled);
    // Unreachable while the scoped read before it stands, and answered rather than ignored: that
    // read already sent the 404 for a foreign id, so this is the branch that would matter if
    // someone removed it.
    if (!wrote) {
      return {
        ok: false,
        status: 404,
        body: apiError(
          scope === "workspace" ? "WORKSPACE_NOT_FOUND" : "SESSION_NOT_FOUND",
          "not found"
        ),
      };
    }

    const states =
      scope === "workspace"
        ? db.listWorkspaceWidgetsForUser(userId, scopeId)
        : db.listSessionWidgetsForUser(userId, scopeId);
    const state = states.find((s) => s.id === id);
    // A bug rather than a reachable state: the validator just proved this build knows the id at
    // this level, and `resolveWidgetStates` walks that same registry. Throwing gives Fastify's
    // 500, which is the honest answer to "the validator and the reader disagree".
    if (!state) throw new Error(`setWidget: ${id} vanished between validation and read`);
    return { ok: true, state };
  }

  /* ----------------------------------- plans ----------------------------------- */

  /*
   * Routes about the conversation's plan, not `/widgets/...`: a plan is the object the
   * widget renders, and a later UI editor would talk to the same endpoints. No plan yet is a
   * 200 `{ plan: null }` (the widget's empty state), not a 404; a missing conversation is.
   */

  app.get("/api/sessions/:id/plan", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const row = db.getPlanForSessionForUser(userId, id);
    return { plan: row ? buildPlanView(db, row) : null };
  });

  /**
   * Jump study to one chapter: the widget's play button. Everything undone before it is
   * marked skipped, the target and its parent chapters open. The user-facing message naming
   * the chapter is composed by the client, which then sends it through `/chat` normally.
   */
  app.post("/api/sessions/:id/plan/nodes/:nodeId/jump", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id, nodeId } = request.params as { id: string; nodeId: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    try {
      const result = jumpToNode(db, id, nodeId);
      return { plan: result.view, number: result.number, title: result.title, skippedCount: result.skippedCount };
    } catch {
      // No plan, unknown/deleted/completed node: the same 404 a missing object gives, since
      // the jump target is the thing that does not exist.
      return reply.code(404).send(apiError("PLAN_NODE_NOT_FOUND", "that plan node cannot be jumped to"));
    }
  });

  app.get("/api/sessions/:id/plan/versions/:version", async (request, reply) => {
    const userId = actor(request).id;
    const { id, version: rawVersion } = request.params as { id: string; version: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const version = Number.parseInt(rawVersion, 10);
    const snapshot = Number.isInteger(version)
      ? readPlanVersion(db, userId, id, version)
      : undefined;
    if (!snapshot) {
      return reply
        .code(404)
        .send(apiError("PLAN_VERSION_NOT_FOUND", "that plan version does not exist"));
    }
    return snapshot;
  });

  /* ---------------------------------- quizzes ---------------------------------- */

  /*
   * The conversation's quiz questions, for the quiz widget. Same object-not-widget shape
   * as the plan routes: an endpoint about the thing the panel renders, so the rows exist
   * even when the widget was uninstalled. No questions yet is a 200 with an empty list.
   */
  app.get("/api/sessions/:id/quizzes", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    return { questions: listQuizQuestionViews(db, userId, id) };
  });

  /*
   * There is one make-up route now — `POST /api/sessions/:id/quizzes/makeup`, below, beside
   * `/answers`. The single-question `…/quizzes/:quizId/answer` that stood here took a JSON body and
   * left the grading to a following `/chat` message the client composed; a make-up is a tool call
   * whose answers arrive as its result, so both doors to it write the same rows and start the same
   * turn.
   */

  /**
   * Put an answered-but-ungraded question back among the unanswered ones.
   *
   * JSON rather than SSE: nothing streams, and no turn starts — the reader is repairing a row the
   * panel is showing, and the make-up that follows is a separate request they make next.
   */
  app.post("/api/sessions/:id/quizzes/:quizId/reopen", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id, quizId } = request.params as { id: string; quizId: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }

    const result = reopenQuizAnswer(db, userId, id, quizId);
    if (!result.ok) {
      return reply
        .code(result.status)
        .send(
          apiError(
            result.code,
            result.reason ??
              (result.code === "QUIZ_QUESTION_NOT_FOUND"
                ? "quiz question not found"
                : "that question cannot be re-opened")
          )
        );
    }
    return { question: result.view };
  });

  /* ---------------------------------- threads ---------------------------------- */

  /*
   * The conversation's derived topic chains, for the thread widget. Object-not-widget shape,
   * like the plan/quizzes routes: the derived rows are readable even if the widget was later
   * uninstalled, and "nothing classified yet" is a 200 with an empty list plus an unassigned
   * count (backfill still running), not a 404.
   */
  app.get("/api/sessions/:id/threads", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    return buildThreadViews(db, userId, id);
  });

  /** One re-titling attempt per conversation, joined rather than duplicated. */
  const titleRetries = new Map<string, Promise<TitleRetryResult>>();

  /**
   * What the titler is given: the conversation as it now reads, or `undefined` when there is
   * nothing worth a call yet.
   *
   * **Read from the persisted messages, never remembered** — and that is not only because the
   * attempt outlives the turn that would have held them. It is what lets the titler run *again*
   * on a later turn and see more than the first exchange: a conversation that opens with a
   * greeting has its substance in turn two, and the whole point of asking more than once is being
   * able to name it then.
   *
   * Both roles have to be present, an assistant message with actual text included: a turn that
   * only called tools leaves an assistant message with nothing in it, and a conversation nobody has
   * answered has nothing to name — the placeholder is the honest state until somebody has.
   */
  function titleMessagesFor(sessionId: string, userId: string): TitleMessage[] | undefined {
    const messages = db.listMessagesForUser(sessionId, userId);
    if (!messages.some((m) => m.role === "user" && m.content.trim())) return undefined;
    if (!messages.some((m) => m.role === "assistant" && m.content.trim())) return undefined;
    return messages.map((m) => ({ role: m.role, content: m.content }));
  }

  /**
   * The reader has left this conversation — try again at the title it did not get.
   *
   * The titler runs after every turn the conversation is still its to name, so this is no longer
   * the only second chance — it is the chance a *turn* cannot give. `finishTurn` only reaches the
   * titler when a turn ends in prose, so a conversation whose replies were all stopped, or whose
   * turns produced no text at all, keeps the placeholder for good; and a titling call that
   * *failed* (no key, a rate limit, a reasoning model that spent its whole budget thinking) leaves
   * the user's own clipped words standing until somebody asks again. The reader leaving is the
   * moment to ask.
   *
   * **The trigger is the client's**, which is why this is an event API rather than a timer: only
   * the browser knows the reader has gone, and the server-side hook that would otherwise look for
   * this has nothing to hook — a turn ending is not a reader leaving.
   *
   * Three things it deliberately is not:
   *
   * - **Not awaited by the caller.** The client reports and forgets, and the answer arrives on
   *   this response rather than on an SSE stream that no longer exists. A request that is left
   *   hanging while the model answers costs nothing, because nobody is waiting for it.
   * - **Not able to fail a leave.** Every failure is a response, not an error: the client has
   *   already navigated away, and a red toast about a conversation the reader has left is worse
   *   than the placeholder it is about. `skipped` and `failed` are both 200.
   * - **Not the fallback path.** `autoTitle` falls back to the user's own words when the call
   *   fails; repeating that here would write the same string again and mark the row as attempted.
   *   Only a model title is a success.
   *
   * One in-flight attempt per conversation, joined rather than duplicated: the client debounces,
   * but two tabs can still ask at once, and this is a model call.
   */
  app.post("/api/sessions/:id/leave", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const owned = db.getSessionForUser(id, userId);
    if (!owned) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const { session } = owned;

    /*
     * Eligible when the title is still the titler's to set, it has not already succeeded, and the
     * last judgement is not still current — `"unnamed"` means the turn that just ended asked, of
     * this exact conversation, and was told there was nothing to name. Asking again on the way out
     * would cost a call to get the same answer back. `"fallback"` and absent are both worth
     * another try: the first is a call that never worked, the second a turn that never asked.
     *
     * The client gates on the same fields before reporting at all, and the check is repeated here
     * because that gate is state it may be holding from a while ago.
     */
    if (
      session.titleSource !== "auto" ||
      session.titleState === "model" ||
      session.titleState === "unnamed"
    ) {
      return { status: "skipped" as const };
    }

    const messages = titleMessagesFor(session.id, userId);
    // Nothing to name: nobody has answered this conversation yet, so there is no exchange to read
    // and the next leave — once there is one — is the one that will have something to work with.
    if (!messages) return { status: "skipped" as const };

    const inFlight = titleRetries.get(id);
    if (inFlight) return inFlight;

    const attempt = (async (): Promise<TitleRetryResult> => {
      const provider = db.getProvider(resolveProviderId(undefined, session.settings));
      const modelId = resolveModelId(provider, undefined, session.settings);
      try {
        const generated = await generateTitle({ provider, modelId, messages });
        /*
         * The same decline the turn path records, for the same reason: nothing is written as a
         * title, and the state moves so the next leave does not ask this question again.
         */
        if (generated === null) {
          db.setTitleStateForUser(id, userId, "unnamed");
          return { status: "skipped" as const };
        }
        const unique = uniqueTitleIn(session.workspaceId, userId, generated, id);
        // The write can lose a race with a rename, and then there is no new title to report.
        if (!db.setAutoTitleForUser(id, userId, unique, "model")) {
          return { status: "skipped" as const };
        }
        return { status: "titled" as const, title: unique };
      } catch (err) {
        app.log.warn(
          { err: err instanceof Error ? err.message : String(err), sessionId: id },
          "re-title on leave failed; the conversation keeps its name"
        );
        return { status: "failed" as const };
      } finally {
        titleRetries.delete(id);
      }
    })();

    titleRetries.set(id, attempt);
    return attempt;
  });

  /**
   * Run one unit of classification (the oldest ≤8 unassigned turns, one model call), then
   * return the fresh view. Idempotent: a second call with nothing unassigned makes no model
   * call. The panel loops on it for the install-time backfill; the post-turn hook calls the
   * same domain function. A classifier failure is swallowed here too — it must report the
   * rows that exist rather than turn a panel refresh into an error.
   */
  app.post("/api/sessions/:id/threads/sync", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const owned = db.getSessionForUser(id, userId);
    if (!owned) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const provider = db.getProvider(resolveProviderId(undefined, owned.session.settings));
    const modelId = resolveModelId(provider, undefined, owned.session.settings);
    try {
      await syncThreads(
        db,
        id,
        makeThreadClassifier({
          provider,
          modelId,
          reasoning: threadReasoning,
          onUsage: passRecorder({
            userId,
            workspaceId: owned.session.workspaceId,
            sessionId: id,
            provider,
            modelId,
            purpose: "thread",
          }),
        }),
        "sync",
        modelId
      );
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "thread sync left messages unassigned"
      );
    }
    return buildThreadViews(db, userId, id);
  });

  /* --------------------------------- diagrams --------------------------------- */

  /*
   * The conversation's diagrams, object-not-widget like the notes routes below: a diagram
   * outlives the panel that lists it, and an empty list is a 200 rather than a missing
   * object. The rows are the panel's data; the conversation-files dialog still reads the
   * folder itself, so a hand-placed `.mmd` is reachable without a row.
   */
  app.get("/api/sessions/:id/diagrams", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const owned = db.getSessionForUser(id, userId);
    if (!owned) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const diagrams = await listDiagramViews(
      db,
      userId,
      id,
      sessionDir(owned.workspace.dirPath, id)
    );
    return { diagrams };
  });

  /*
   * The conversation's tables.
   *
   * Its own route rather than a `tables` field on the one above, because they are two resources
   * with two identities and one joins to a file: a reader asking for diagrams is not asking for
   * tables, and a payload that carried both would make every diagram read pay for a table read it
   * did not want. The panel asks for both, in parallel, because it is the one caller that shows
   * them together.
   *
   * Object-not-widget like the row above, and an empty list is a 200: a table is the row alone,
   * so — unlike a diagram, whose file can be gone — being listed and being readable are the same
   * thing here.
   */
  app.get("/api/sessions/:id/tables", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    return { tables: listTableViews(db, userId, id) };
  });

  /* ----------------------------------- notes ----------------------------------- */

  /*
   * The notes widget's records, in the object-not-widget shape the plan/quiz/thread routes
   * use above: a note is the user's own writing and outlives the widget that made it, so
   * uninstalling the panel must not hide what was already written. Every route resolves the
   * session through `getSessionForUser` first, which is what turns another account's id — and
   * an id that never existed — into the same 404 rather than into someone else's data.
   */
  app.get("/api/sessions/:id/notes", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    return { notes: db.listNotesForUser(userId, id) };
  });

  app.post("/api/sessions/:id/notes", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const result = createNote(db, userId, id, request.body);
    if (!result.ok) {
      return reply.code(result.status).send(apiError(result.code, "cannot save that note"));
    }
    return reply.code(201).send(result.note);
  });

  app.patch("/api/sessions/:id/notes/:noteId", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id, noteId } = request.params as { id: string; noteId: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const result = updateNote(db, userId, id, noteId, request.body);
    if (!result.ok) {
      return reply.code(result.status).send(apiError(result.code, "cannot save that note"));
    }
    return result.note;
  });

  app.delete("/api/sessions/:id/notes/:noteId", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id, noteId } = request.params as { id: string; noteId: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const result = deleteNote(db, userId, id, noteId);
    if (!result.ok) {
      return reply.code(result.status).send(apiError(result.code, "note not found"));
    }
    return { ok: true };
  });

  /* ---------------------------------- insights ---------------------------------- */

  /*
   * The insight panel's records, object-not-widget like the notes routes above: an observation
   * outlives the panel that shows it, so uninstalling the widget must not hide what was already
   * generated. Every route resolves the session through `getSessionForUser` first, which is what
   * turns another account's id — and an id that never existed — into the same 404.
   */
  app.get("/api/sessions/:id/insights", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    return { items: buildInsightViews(db, userId, id) };
  });

  /**
   * Run one pass and answer with the new list.
   *
   * A **plain POST that returns when the pass completes**, not a stream, and the three conditions
   * that make that honest are: the panel disables its button and shows a generating state while
   * it waits, so the 30–60s is a state on screen rather than a frozen control; the reply is
   * always the whole list, because the write is one transaction at the end; and nothing is
   * `hijack()`ed, since the SSE machinery belongs to turns. `/threads/sync` is the sibling
   * precedent. The alternative — a background pass the panel polls for — would need a stored
   * "running" state and a second way for the panel to learn it finished, invented to avoid an
   * await the user is already watching.
   *
   * Every non-`ok` answer is a **200 with the list unchanged**, never an error status: a provider
   * that returned nothing usable, and a conversation with nothing to reflect on, are both facts
   * about the request rather than failures of it, and the panel says so in its own words above
   * the observations it still has. Distinguishing `"empty"` from `"failed"` matters because both
   * arrive with zero new items and mean opposite things to a reader.
   */
  app.post("/api/sessions/:id/insights/generate", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const owned = db.getSessionForUser(id, userId);
    if (!owned) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const provider = db.getProvider(resolveProviderId(undefined, owned.session.settings));
    const modelId = resolveModelId(provider, undefined, owned.session.settings);
    return generateInsights(
      db,
      userId,
      id,
      makeInsightGenerator({
        provider,
        modelId,
        reasoning: insightReasoning,
        onUsage: passRecorder({
          userId,
          workspaceId: owned.session.workspaceId,
          sessionId: id,
          provider,
          modelId,
          purpose: "insight",
        }),
      }),
      modelId
    );
  });

  app.patch("/api/sessions/:id/insights/:insightId", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id, insightId } = request.params as { id: string; insightId: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    // Not coerced: `"false"` is truthy, and a boolean field read as its string form is how a
    // toggle ends up meaning the opposite of what was asked for.
    const body = request.body as { adopted?: unknown } | undefined;
    if (typeof body?.adopted !== "boolean") {
      return reply.code(400).send(apiError("INVALID_FIELD", "adopted must be a boolean"));
    }
    const item = db.setInsightAdoptedForUser(userId, id, insightId, body.adopted);
    if (!item) {
      return reply.code(404).send(apiError("INSIGHT_NOT_FOUND", "insight not found"));
    }
    return { item };
  });

  app.delete("/api/sessions/:id/insights/:insightId", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id, insightId } = request.params as { id: string; insightId: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    if (!db.deleteInsightForUser(userId, id, insightId)) {
      return reply.code(404).send(apiError("INSIGHT_NOT_FOUND", "insight not found"));
    }
    return { ok: true };
  });


  /* -------------------------------- usage stats -------------------------------- */
  /*
   * What the installation's model calls cost, three ways.
   *
   * Two routes over one query module, and the split is the permission model rather than a
   * preference: an account reads its own ledger, and an administrator reads anybody's. Neither
   * needs a new concept — the same "an account's own data is its own" rule the workspace and
   * session routes already follow, and the same `requirePlatformAdmin` the console's other
   * screens use.
   *
   * All three are **scope-only**: the ledger is derived observability data, so there is nothing
   * here to write, nothing to own and nothing a delete could invalidate.
   */

  /** The query every one of them takes, read off the URL. */
  function statsQuery(
    request: FastifyRequest,
    override?: { userId?: string }
  ): StatsQuery {
    const q = request.query as Record<string, unknown> | undefined;
    const str = (key: string): string | undefined => {
      const value = q?.[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };
    const query: StatsQuery = {};
    const from = str("from");
    const to = str("to");
    const timezone = str("timezone");
    const workspaceId = str("workspaceId");
    if (from) query.from = from;
    if (to) query.to = to;
    if (timezone) query.timezone = timezone;
    if (workspaceId) query.workspaceId = workspaceId;
    // The account, when one was resolved for us — an administrator's `?userId=` filter, or the
    // caller's own id. Set last so a body cannot name somebody else's ledger on the self route.
    if (override?.userId) query.userId = override.userId;
    return query;
  }

  /** Every figure one statistics page shows, from one read of the ledger. */
  function statsFor(query: StatsQuery): UsageStats {
    const filter = usageFilter(query, serverTimeZone() ?? "UTC");
    return buildStats(db.listUsageRows(filter), filter, db.usageSince(query.userId));
  }

  app.get("/api/stats", async (request) => statsFor(statsQuery(request, { userId: actor(request).id })));

  app.get("/api/stats/sessions", async (request) => {
    const user = actor(request);
    const filter = usageFilter(statsQuery(request, { userId: user.id }), serverTimeZone() ?? "UTC");
    return { sessions: buildSessionRows(db.listUsageRows(filter)) };
  });

  /**
   * The console's view, which may name an account and otherwise reports the whole installation.
   *
   * `byUser` is added here and nowhere else: it is the one field whose *presence* is a permission,
   * so a self-scoped response never carries a breakdown of other people's spend.
   */
  app.get("/api/admin/stats", async (request, reply) => {
    const admin = requirePlatformAdmin(request, reply);
    if (!admin) return reply;
    const q = request.query as Record<string, unknown> | undefined;
    const asked = typeof q?.["userId"] === "string" ? (q["userId"] as string).trim() : "";
    const query = statsQuery(request, asked ? { userId: asked } : undefined);
    const filter = usageFilter(query, serverTimeZone() ?? "UTC");
    const rows = db.listUsageRows(filter);
    const stats = buildStats(rows, filter, db.usageSince(query.userId || undefined));
    stats.byUser = bucketBy(
      rows,
      (row) => row.userId,
      (row) => row.userName ?? undefined
    );
    return stats;
  });

  /* ------------------------------- session files ------------------------------- */

  /*
   * A conversation's own directory, read with the same two endpoints as a workspace's.
   *
   * `sessions/<sessionId>/` is where a conversation's own files go — today, the `.mmd`
   * sources `ila_diagram` draws — and it is deliberately *not* inside `workdir/`, so nothing
   * here is reachable by the file tools and nothing the model writes with `write_file`
   * appears here. The two roots share `files.ts` rather than a copy of it: one level at a
   * time, the same envelopes, the same sandbox, the same strictness. This is a second
   * caller, not a second browser.
   *
   * The root is `sessionDir(workspace.dirPath, …)` — `dirPath`, **never** `workdirPath`. The
   * second is `dirPath/workdir`, so deriving from it would put a conversation's own files
   * inside the tree the model may already write into, which is the one thing this directory
   * exists to be separate from.
   *
   * Ownership is `getSessionForUser`, so another account's session id and an id that never
   * existed answer the same 404.
   *
   * The listing makes the directory first, best-effort. A conversation's directory is made
   * when it is created — but that mkdir is deliberately best-effort, and it is not the only
   * way a session comes to exist: the plan widget's "make a new plan" fork writes its
   * snapshot session straight through `db.createSession` and never goes near that route. So
   * "this conversation has no files yet" would otherwise be a 404 for a session that is
   * perfectly healthy, and the panel would show an error where its empty state belongs. The
   * write is idempotent, it is the app's own directory, and it is what makes the layout
   * `paths.ts` describes actually true. A volume that will not allow it still lists
   * whatever is there — the mkdir is swallowed for the same reason the creation-time one is.
   */
  app.get("/api/sessions/:id/files", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const { path } = request.query as { path?: string | string[] };
    const found = db.getSessionForUser(id, userId);
    if (!found) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }

    const root = sessionDir(found.workspace.dirPath, found.session.id);
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      // Ignored on purpose — see above.
    }

    try {
      const listing = await listDirectory(root, path);
      return withFileIds(
        listing,
        userId,
        { kind: "session", id: found.session.id },
        (rel) => sessionFilePath(found.workspace.slug, found.session.id, rel)
      );
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  app.get("/api/sessions/:id/files/content", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const { path } = request.query as { path?: string | string[] };
    const found = db.getSessionForUser(id, userId);
    if (!found) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }

    try {
      const content = await readFileContent(
        sessionDir(found.workspace.dirPath, found.session.id),
        path
      );
      // A diagram carries the model's summary on its row; the file alone cannot answer it.
      // Only a session-root read can attach one — a workspace `.mmd` is not the same thing.
      if (content.kind === "diagram" && typeof path === "string") {
        const row = db.getDiagramBySessionName(id, path);
        if (row) content.summary = row.summary;
      }
      // The reference, for the same shape of reason as the summary above: this route has the
      // session and the path, and the client has only the path. See `referenceFor`.
      if (typeof path === "string") {
        const reference = referenceFor(
          userId,
          sessionFilePath(found.workspace.slug, found.session.id, path),
          { kind: "session", id }
        );
        if (reference) content.reference = reference;
      }
      return content;
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  /**
   * A conversation's own files as bytes, for the preview viewer.
   *
   * The workspace route's twin, down to the headers and for the same reasons — see the
   * docblock there rather than a second copy of the argument. What differs is only the root,
   * which is why `readRawFile` takes one: `sessions/<sessionId>/` is where the diagrams and
   * anything else a turn wrote live, and the browser that lists it is the same browser.
   *
   * No diagram summary is attached here, unlike `/files/content` above: a summary belongs to a
   * `.mmd` the viewer draws itself, and this route is never the one that serves one.
   */
  app.get("/api/sessions/:id/files/raw", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const { path } = request.query as { path?: string | string[] };
    const found = db.getSessionForUser(id, userId);
    if (!found) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }

    try {
      const { bytes } = await readRawFile(sessionDir(found.workspace.dirPath, found.session.id), path);
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Disposition", "attachment")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Length", String(bytes.length))
        .send(bytes);
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  /* ---------------------------------- sources ---------------------------------- */

  /**
   * A source as a client may see it.
   *
   * `SourceRecord` carries one field that never leaves the server — the account it belongs to.
   * Dropping it here rather than at each `reply.send` is what makes that a property of the
   * module instead of of whoever remembered: a route that forgets has to deliberately reach
   * past this function to leak, which is a much harder mistake to make.
   *
   * Where the bytes are **does** travel now, as the reference's own entity: `path` sits on the
   * file and `url` on the page, and neither is a leak — a file's path is inside a sandbox the
   * client can already browse, and it is not enough to reach the file with, since every read
   * still passes a route that resolves it through the guard again.
   */
  function toResource(record: WorkResourceRecord): WorkResource {
    const { userId, ...resource } = record;
    return resource;
  }

  /**
   * A reference as one message's attachment: the same facts, under the name that upload used.
   *
   * The name is the only difference, and it is deliberate rather than redundant. A file keeps
   * the first title it was registered under — that is what dedupe means — so without this a
   * second upload of the same bytes would show someone else's filename on its chip.
   *
   * `id` is the **file**, `resourceId` is the reference: two ids for one row, and the split is
   * the v4 model in miniature. The bytes are fetched by the first and read by the model through
   * the second.
   */
  function toAttachment(record: WorkResourceRecord, name: string): Attachment {
    const entity = record.resource;
    return {
      id: entity.id,
      resourceId: record.id,
      name,
      mimeType: entityMimeOf(record),
      size: entitySizeOf(record),
      kind: entityMimeOf(record) === "image/png" || entityMimeOf(record).startsWith("image/")
        ? "image"
        : "file",
      parseStatus: record.parseStatus,
      parseError: record.parseError,
      parseErrorCode: record.parseErrorCode,
      parserId: record.parserId,
      parsedChars: record.parsedChars,
      pageCount: record.pageCount,
      parsedFileId: record.parsedFileId,
    };
  }

  /** A reference's entity MIME. A page is always HTML; a file says so itself. */
  function entityMimeOf(record: WorkResourceRecord): string {
    return record.resourceType === "file"
      ? (record.resource as StoredFile).mimeType
      : "text/html";
  }

  /** The same for size, which a page has none of. */
  function entitySizeOf(record: WorkResourceRecord): number {
    return record.resourceType === "file" ? (record.resource as StoredFile).size : 0;
  }

  /**
   * Every file id a run might read: the history's attachments, and this turn's.
   *
   * The history's, not just this turn's, and that is the whole point: `buildHistoryMessages`
   * re-runs the content builder for every earlier user turn, so a file attached three turns ago
   * is replayed on every turn after it. Collecting from both is what makes the cost one pass over
   * a small set instead of one query per attachment per message.
   */
  function fileIdsOf(history: readonly Message[], extra: readonly Attachment[]): string[] {
    return [
      ...history.flatMap((m) => (m.attachments ?? []).map((a) => a.id)),
      ...extra.map((a) => a.id),
    ];
  }

  /**
   * A reference's bytes, validated, or undefined.
   *
   * Every read of a file's contents goes through here — the preview and the raw download — so
   * "where is this file" is asked once. A page has no bytes of its own: its text is a file the
   * reference points at, and its raw body is not reachable from here at all.
   */
  function resourcePath(user: User, record: WorkResourceRecord): string | undefined {
    // The parsed text is an *entity's* file too, and is what a preview of a document should
    // show when there is one — the alternative is handing a viewer a PDF it cannot render.
    if (record.parsedFileId) {
      const text = db.getFileForUser(user.id, record.parsedFileId);
      if (text) {
        const resolved = resolveFilePath(treeFor(user), text);
        if (resolved) return resolved;
      }
    }
    if (record.resourceType !== "file") return undefined;
    return resolveFilePath(treeFor(user), record.resource as StoredFile);
  }

  /**
   * Upload a file, and reference it from this conversation.
   *
   * Uploads arrive as base64 JSON rather than multipart, which keeps this dependency-free
   * (`@fastify/multipart` is not installed) at the cost of a ~33% larger body — hence the
   * raised per-route `bodyLimit`.
   *
   * **Two links, not one.** The source is referenced by the conversation *and* by its
   * workspace, which is what makes a document uploaded here readable from another
   * conversation in the same workspace. Writing only the session link would leave the
   * workspace half of the read whitelist permanently empty.
   *
   * **Identical bytes are one source.** The hash is looked up first, scoped to the account,
   * so re-uploading the same PDF reuses the row, the file and whatever parse it already has —
   * the second upload is instant, costs no cloud call, and does not restart a parse that
   * failed.
   */
  app.post(
    "/api/sessions/:id/resources",
    { bodyLimit: ATTACHMENT_BODY_LIMIT, config: { requiresSessionLock: true } },
    async (request, reply) => {
      const user = actor(request);
      const userId = user.id;
      const { id } = request.params as { id: string };
      const session = db.getSessionForUser(id, userId);
      if (!session) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
      const tree = treeFor(user);

      const body = request.body as UploadAttachmentInput;
      const name = body?.name?.trim();
      if (!name) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));

      const mimeType = normalizeMime(name, body.mimeType);
      if (!isSupportedMime(mimeType)) {
        return reply
          .code(415)
          .send(
            apiError(
              "UNSUPPORTED_FILE_TYPE",
              `Unsupported file type: ${body.mimeType || name}`,
              { mimeType: body.mimeType || name }
            )
          );
      }
      if (typeof body.data !== "string" || !body.data) {
        return reply.code(400).send(apiError("DATA_REQUIRED", "data is required"));
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(body.data, "base64");
      } catch {
        return reply.code(400).send(apiError("INVALID_BASE64", "data is not valid base64"));
      }
      if (bytes.byteLength === 0) return reply.code(400).send(apiError("EMPTY_FILE", "file is empty"));
      // Read here rather than at registration, because this is the number an administrator can
      // change and the `bodyLimit` above is not.
      const uploadLimit = readMaxUploadBytes(db);
      if (bytes.byteLength > uploadLimit) {
        return reply.code(413).send(fileTooLarge(uploadLimit));
      }

      /*
       * One file, and one reference per owner that should be able to reach it.
       *
       * `UNIQUE (user_id, sha256)` makes identical user-supplied bytes one file for the account,
       * so a file the user deleted cannot be re-uploaded as a second row — the insert would be
       * refused. It is *revived* instead: the row never lost its bytes and every reference to it
       * survived, so bringing it back restores the file wherever it was being worked from.
       *
       * The reference, by contrast, is per conversation — which is the whole reason the two are
       * separate tables. Uploading the same bytes into a second conversation reuses the file and
       * creates a second reference, so neither conversation is holding the other's row.
       */
      const hash = sha256Of(bytes);
      const live = db.findFileByHash(userId, hash);
      const deleted = live ? undefined : db.findDeletedFileByHash(userId, hash);
      let file = live ?? (deleted ? db.reviveFileForUser(deleted.id, userId) : undefined);
      let started = false;

      if (!file) {
        const fileId = newId();
        // Both inputs to the path are server-side — an id we just made and a MIME type from the
        // table — so nothing the client sent can steer the write out of this user's
        // `sources/raw/`. Same reasoning as `resolveInWorkspace`, applied at the write.
        const rawPath = rawFilePath(tree, fileId, mimeType);
        try {
          await writeFile(rawPath, bytes);
        } catch (err) {
          request.log.error(err, "failed to store file bytes");
          return reply.code(500).send(apiError("FILE_STORE_FAILED", "failed to store the file"));
        }

        file = db.createFile({
          id: fileId,
          userId,
          sourceType: "attachment",
          title: name,
          path: storePath(tree, rawPath),
          mimeType,
          category: classifyFile(name, mimeType).category,
          size: bytes.byteLength,
          sha256: hash,
        });
      }

      const resource = ensureWorkResource(db, {
        userId,
        owner: { kind: "session", id },
        resourceType: "file",
        resourceId: file.id,
        title: name,
      });
      if (!resource) {
        return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
      }

      /*
       * A parse is scheduled when *this reference* has never been parsed — a fresh file, a
       * revived one whose run was cancelled mid-flight, or a file another conversation already
       * parsed (whose reference is its own, and whose text is its own).
       *
       * Extraction runs after the response: a cloud parse can take minutes and the composer must
       * not hold the upload open for it. `schedule` writes `pending` synchronously, so the status
       * a poll reads next is never a gap.
       */
      if (
        documents.handles(entityMimeOf(resource)) &&
        (resource.parseStatus === "none" ||
          resource.parseStatus === "pending" ||
          resource.parseStatus === "parsing")
      ) {
        started = true;
        void documents.schedule(tree, userId, resource).catch((err: unknown) => {
          request.log.error(err, "failed to schedule document parsing");
        });
      }

      /*
       * A reference this request started parsing reports `pending` rather than being re-read.
       * Re-reading would race the work it just queued — a small local PDF can be `ready` before
       * this line runs, and a status that races the parse is not a status. The client polls
       * `/sessions/:id/resources` for the outcome, so what it needs from the upload is a stable
       * "we started", which is what it gets.
       *
       * A reference nothing was started for reports what it already has: its parse may be
       * finished, or gone stale, or never have been needed.
       */
      const reported = started ? { ...resource, parseStatus: "pending" as ParseStatus } : resource;
      return reply.code(201).send(toAttachment(reported, name));
    }
  );

  /**
   * Every source this conversation can read, with the parse state as it is now.
   *
   * **This is the model's whitelist, verbatim** — its own sources unioned with its
   * workspace's — and that is deliberate. The two must not disagree: a document the model may
   * page through is one the user should see a chip for, and a chip the user can see is one
   * the model can be asked about. Two definitions of "available" would drift, and the drift
   * would show up as an answer referring to a file that is not on screen.
   *
   * The composer polls it to keep those chips current: parse status is a column rather than a
   * snapshot folded into each message, so a reparse is reflected here, and in every
   * conversation that shares the file, at once.
   */
  app.get("/api/sessions/:id/resources", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    // The grant is part of the whitelist, so it is part of this answer — the docblock above is
    // the reason, and the cost is real: this route is polled while something is parsing, and an
    // `@所有工作区` grant makes it an account-wide read. It is paid only while a parse is in
    // flight, and the alternative is the model and the chips disagreeing.
    const scope = scopeQuery(resolveWorkspaceScope(db, userId, found.session));
    return db.listReadableWorkResources(userId, id, found.workspace.id, scope).map(toResource);
  });

  /**
   * Every file this account has uploaded, newest first.
   *
   * Account-wide rather than per-conversation, because that is what a source *is* — the same
   * file referenced from three conversations is one row here and three chips in history. This
   * is the list a user manages their uploads from, and the only place a file with no
   * remaining references is still visible.
   */
  /*
   * Every source the account holds, newest first — and each one says whether it is still there.
   *
   * The `missing` flag is computed rather than stored (see `listSourceViewsForUser`), which is
   * why this is async and why it costs one `stat` per row. It is the one place the browser can
   * learn that a file it lists has been deleted outside the app, and a listing that simply
   * omitted those rows would be a file manager that loses entries when something goes wrong.
   */
  /**
   * The account's sources, filtered.
   *
   * Filters rather than one list per caller: the source browser draws all of them, the uploads
   * dialog is `?storage=upload`, and a conversation-scoped panel is `?sessionId=…`. Each filter
   * is optional and independent, which is what lets one route serve all three without a flag
   * that changes what the reply *means*.
   *
   * An unknown value for a closed set is **refused**, not ignored — a filter that silently does
   * nothing is indistinguishable from one that matched everything, which is the wrong way round
   * for a reader who is trying to narrow a list. A `?name=` is the opposite: any string is a
   * legitimate search, so it is a substring match with the wildcards escaped.
   *
   * `workspaceId`/`sessionId` are *not* owner checks — the owner check is `actor(request)` and
   * the `user_id` predicate every query carries. They narrow the view, and an id belonging to
   * somebody else matches nothing rather than being refused: the request is a legitimate
   * question with an empty answer, not an attempt.
   */
  app.get("/api/resources", async (request, reply) => {
    const user = actor(request);
    const query = request.query as Record<string, string | string[] | undefined>;

    const one = (key: string): string | undefined => {
      const value = query[key];
      if (value === undefined) return undefined;
      // `?category=a&category=b` arrives as an array, and a filter holding two values is a
      // request this route does not answer — refusing beats picking the first silently.
      if (typeof value !== "string" || value === "") {
        return reply.send(apiError("INVALID_FIELD", `${key} must be a single value`)) as never;
      }
      return value;
    };

    const resourceType = one("resourceType");
    if (resourceType !== undefined && !isWorkResourceType(resourceType)) {
      return reply.code(400).send(apiError("INVALID_FIELD", "unknown resource type"));
    }
    const category = one("category");
    if (category !== undefined && !isFileCategory(category)) {
      return reply.code(400).send(apiError("INVALID_FIELD", "unknown category"));
    }
    const ownerType = one("ownerType");
    if (ownerType !== undefined && ownerType !== "workspace" && ownerType !== "session") {
      return reply.code(400).send(apiError("INVALID_FIELD", "unknown owner type"));
    }
    const owner: WorkResourceFilter["ownerType"] =
      ownerType === "workspace" || ownerType === "session" ? ownerType : undefined;
    const sourceType = one("sourceType");
    if (sourceType !== undefined && !isFileSourceType(sourceType)) {
      return reply.code(400).send(apiError("INVALID_FIELD", "unknown source type"));
    }

    const filter = {
      resourceType,
      ownerType: owner,
      category,
      mime: one("mime"),
      name: one("name"),
      workspaceId: one("workspaceId"),
      sessionId: one("sessionId"),
    };

    // Before the listing, and bounded: the registry is an index of the filesystem, and a file
    // that appeared with no writer at all — cloned in, restored, dropped in from the Finder —
    // has no row until something walks. Answering from a stale index would make the browser's
    // answer depend on whether anybody had happened to open the file tree lately. See
    // `reconcileFilesystem` for why this is affordable here rather than at boot.
    await reconcileFilesystem(db, { workspaceId: filter.workspaceId, sessionId: filter.sessionId });

    const resources = await listResourceViewsForUser(db, treeFor(user), user.id, filter);
    return resources.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toResource);
  });

  /**
   * One source, by id.
   *
   * The read a caller makes when it has an id and needs the row *now*: the composer polls it
   * while a reference the user just pointed at is being parsed, and something that is not in the
   * conversation's list yet — a reference before the turn that links it — has no other way to be
   * asked about. `missing` is computed here as it is in the list, so the two agree.
   */
  app.get("/api/resources/:id", async (request, reply) => {
    const user = actor(request);
    const { id } = request.params as { id: string };
    const resource = db.getWorkResourceForUser(user.id, id);
    if (!resource) return reply.code(404).send(apiError("RESOURCE_NOT_FOUND", "file not found"));

    const path = resourcePath(user, resource);
    const present = path
      ? await stat(path).then(
          (info) => info.isFile(),
          () => false
        )
      : false;
    return toResource({ ...resource, missing: !present } as WorkResourceRecord);
  });

  /**
   * A source, described the way a workspace file is described.
   *
   * Uploaded files were the one place a preview could not reach: they live outside every
   * workspace, at `sources/raw/<id>.<ext>`, so the file browser's two routes cannot address them
   * and the sources dialog had nothing to open with. This is the same `FileContent` the browser
   * hands its dialog, so one dialog serves both.
   *
   * It goes through `readPreviewFile`, which is also what `readFileContent` calls — the point
   * being that a `.mmd` or a `.md` uploaded as a source is classified by the *same* tables as one
   * in a workspace. The sandbox is the only thing that differs, and it differs where it should:
   * `resolveSourceBytes` here rather than `resolveReal`, because a source's place is a column that
   * has travelled through backups.
   *
   * The bytes are not here, deliberately — `truncated` and `text` are for the text path, and a
   * binary's bytes come from `/raw` beside this, under the cap the client checks first.
   */
  app.get("/api/resources/:id/preview", async (request, reply) => {
    const user = actor(request);
    const { id } = request.params as { id: string };
    const resource = db.getWorkResourceForUser(user.id, id);
    if (!resource) return reply.code(404).send(apiError("RESOURCE_NOT_FOUND", "file not found"));

    const path = resourcePath(user, resource);
    if (!path) return reply.code(404).send(apiError("RESOURCE_NOT_FOUND", "file not found"));

    try {
      /*
       * The *stored* title is what to call it — not what it *is*: the extension the preview
       * decides by comes from the file's own name, which `readPreviewFile` reads off the path the
       * bytes are at. The title is the only part of the two the user ever chose, and a file
       * deduped onto an earlier upload would otherwise be shown as its uuid.
       */
      const content = await readPreviewFile(path, resource.title, resource.title);
      /*
       * …and the page it came from, when it is one. Carried here rather than fetched by the
       * client, because this route is the only one that knows *both* the bytes and the row: a
       * client holding the preview would otherwise need a second request to learn whether there is
       * somewhere to go, and the dialog's "open in browser" control is gated on exactly that.
       */
      const entity = resource.resource;
      return {
        ...content,
        url: resource.resourceType === "web_page" ? (entity as { url: string }).url : undefined,
      };
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  /**
   * Serve a **file's** bytes back, for a thumbnail or a download.
   *
   * By file id rather than by reference, and the two are not interchangeable: a file may be held
   * by several owners, so "which reference" has no answer here — what is being asked for is the
   * bytes. The image thumbnail is the caller that matters, and it is addressed from the
   * attachment, which carries both ids.
   */
  app.get("/api/files/:id/raw", async (request, reply) => {
    const user = actor(request);
    const { id } = request.params as { id: string };
    const file = db.getFileForUser(user.id, id);
    if (!file) return reply.code(404).send(apiError("RESOURCE_NOT_FOUND", "file not found"));

    // From the row, and validated again before the read: the resolver is what keeps a path
    // that travelled through a backup — or through a future bug — from being a read of
    // whatever it happens to name.
    const path = resolveFilePath(treeFor(user), file);
    if (!path) return reply.code(404).send(apiError("RESOURCE_NOT_FOUND", "file not found"));

    try {
      const bytes = await readFile(path);
      return reply
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .type(file.mimeType)
        .send(bytes);
    } catch {
      return reply.code(404).send(apiError("RESOURCE_NOT_FOUND", "file not found"));
    }
  });

  /**
   * Add a web page, by pasting its URL.
   *
   * The user's half of `ila_collect_page`, and the reason it exists is the requirement's own
   * list of what material can be: a web link or an uploaded file, added to a workspace from
   * outside a conversation. The browser offered only the file.
   *
   * A **workspace**, never a conversation, for the same reason the upload picker offers only
   * workspaces: a conversation's material is what happened inside it. The page is linked to
   * that workspace, so every conversation in it can read the page immediately — which is what
   * "added to a workspace" has to mean for the link to be worth anything.
   *
   * The fetch goes through `web_fetch`'s own guard, so a URL that resolves to a private address
   * is refused here exactly as it is there; the refusal is reported with the guard's own
   * sentence, because that sentence names the reason ("it resolves to a private address") and
   * any wording invented here would say less.
   */
  app.post("/api/resources/pages", async (request, reply) => {
    const user = actor(request);
    const body = request.body as AddResourcePageInput & { summary?: string };

    const url = body?.url?.trim();
    if (!url) return reply.code(400).send(apiError("DATA_REQUIRED", "a URL is required"));

    const workspaceId = body?.workspaceId;
    const workspace = workspaceId ? db.getWorkspaceForUser(workspaceId, user.id) : undefined;
    if (!workspace) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    try {
      const resource = await captureWebPage(db, {
        user: treeFor(user),
        userId: user.id,
        owner: { kind: "workspace", id: workspace.id },
        url,
        // Optional, and the *reference's*: a page's own title is what the document says it is
        // called, and this is what the person adding it decided to call it.
        title: body?.title?.trim() || undefined,
        // A link somebody pasted has no summary: a summary is a reading of a page by something
        // that understood it, and nothing has read this one yet.
        summary: body?.summary?.trim() || undefined,
      });
      return reply.code(201).send(toResource(resource));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return reply.code(400).send(apiError("PAGE_FETCH_FAILED", detail, { detail }));
    }
  });

  /** Re-run extraction, e.g. after a failure or a change of parser settings. */
  app.post("/api/resources/:id/reparse", async (request, reply) => {
    const user = actor(request);
    const { id } = request.params as { id: string };
    const resource = db.getWorkResourceForUser(user.id, id);
    if (!resource) return reply.code(404).send(apiError("RESOURCE_NOT_FOUND", "file not found"));

    try {
      // The parse reads the bytes through the same resolver every read does, which needs nothing
      // but the row — the locator is on the file.
      await documents.reparse(treeFor(user), user.id, resource);
    } catch (err) {
      return reply.code(400).send(parseApiError(err));
    }
    return reply.code(202).send({ status: "pending" });
  });

  /**
   * Delete a reference — **and the material it names**, which is its internal consequence.
   *
   * The one delete. A `work_resources` row is the handle everything else reaches material through,
   * so this is what "delete this" means: the reference goes, its file or page goes with it, and
   * every *other* reference to that material stays where it is — dangling, and reported as gone
   * wherever it is opened (the panel omits it, `read_document` loses it, the chip in a message
   * says so). Nothing here rewrites another conversation's records, and nothing sweeps
   * `session_references`: see the table's own comment in the schema for why standing on the
   * reference is what makes that safe.
   *
   * The file manager's route reaches the same operation from a path, which is the only thing a
   * file tree can name. `messages.attachments` snapshots were always kept: a message sent with a
   * PDF keeps showing what was sent rather than the chip vanishing from history it was part of.
   *
   * An in-flight parse is cancelled — not to protect bytes that are on their way out, but so a
   * parse that can never be read does not keep running against a file the user has deleted.
   */
  app.delete("/api/resources/:id", async (request, reply) => {
    const user = actor(request);
    const { id } = request.params as { id: string };
    const resource = db.getWorkResourceForUser(user.id, id);
    if (!resource) return reply.code(404).send(apiError("RESOURCE_NOT_FOUND", "file not found"));

    documents.cancelResource(resource.id);
    try {
      await deleteWorkResource(db, treeFor(user), { userId: user.id, id: resource.id });
    } catch (err) {
      const { status, body: failure } = fileErrorReply(err);
      return reply.code(status).send(failure);
    }
    return { ok: true };
  });

  /* -------------------------------- providers --------------------------------- */
  /*
   * Providers, parsers, the parsing policy and the app defaults are **installation-wide**, and
   * their writes are a platform administrator's — either tier. Reads are everybody's: the
   * composer needs the model list and the parse state, and a screen that cannot say which models
   * exist is not one anybody can use.
   *
   * The split the whole feature is built on: an administrator *configures* the models, and an
   * ordinary account *chooses among* them. That is why the reads stay open and the writes do not
   * — a user who could add a provider would be choosing from a list they wrote, and the
   * "configured by an administrator" promise would be a sentence rather than a rule.
   *
   * This matters more than it looks, now that an installation can hold more than one account.
   * A provider's `baseURL` is where every conversation's prompts and completions go, so an
   * account that can add one and point the defaults at it reads everybody's traffic. And
   * `POST /api/document-parsers/:id/test` makes the **server** issue a request to a `baseURL`
   * the caller chose, which is the same capability `web_fetch` needs an SSRF guard for — so a
   * route that reaches it must not be the one place in the product with no gate at all.
   *
   * The gate here is the *wider* one, unlike the account routes above: appointing an
   * administrator is a superadmin's act, and configuring the installation is the job the
   * `admin` role is appointed to do. The rule for a new route is the console's: if it changes
   * something every account shares, it is an administrator's to change.
   */

  app.get("/api/providers", async () => providerConfigs());

  app.post("/api/providers", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const body = request.body as CreateProviderInput;
    const name = body?.name?.trim();
    const baseURL = body?.baseURL?.trim();
    if (!name) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));
    if (!baseURL) return reply.code(400).send(apiError("BASE_URL_REQUIRED", "baseURL is required"));

    const provider = db.createProvider({
      id: newId(),
      name,
      baseURL,
      apiKey: body.apiKey?.trim() || undefined,
    });
    for (const m of body.models ?? []) {
      const parsed = parseModelInput(m);
      if (!parsed) return reply.code(400).send(apiError("MODEL_ID_REQUIRED", "each model needs a modelId"));
      db.createModel({ id: newId(), providerId: provider.id, ...parsed });
    }
    return reply.code(201).send(publicProvider(provider.id));
  });

  app.put("/api/providers/:id", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const { id } = request.params as { id: string };
    const body = request.body as UpdateProviderInput;
    if (!db.getProvider(id)) return reply.code(404).send(apiError("PROVIDER_NOT_FOUND", "provider not found"));

    if (body?.models) {
      for (const m of body.models) {
        const parsed = parseModelInput(m);
        if (!parsed) return reply.code(400).send(apiError("MODEL_ID_REQUIRED", "each model needs a modelId"));
        if (m.id) {
          // Editing in place. Unknown ids are rejected rather than silently inserted.
          if (!db.updateModel(m.id, parsed)) {
            return reply.code(404).send(apiError("MODEL_NOT_FOUND", `model not found: ${m.id}`, { modelId: m.id }));
          }
        } else {
          db.createModel({ id: newId(), providerId: id, ...parsed });
        }
      }
    }

    const provider = db.updateProvider(id, {
      name: body?.name,
      baseURL: body?.baseURL,
      // An absent key means "leave it alone", which is what lets the UI round-trip a
      // provider whose key it is never allowed to read back.
      apiKey: body?.apiKey === undefined ? undefined : body.apiKey.trim(),
    });
    return publicProvider(provider?.id ?? id);
  });

  app.delete("/api/providers/:id", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const { id } = request.params as { id: string };
    if (!db.getProvider(id)) return reply.code(404).send(apiError("PROVIDER_NOT_FOUND", "provider not found"));
    if (db.listProviders().length <= 1) {
      return reply.code(409).send(apiError("ONLY_PROVIDER", "Cannot delete the only provider."));
    }
    if (db.getSetting(SETTING_DEFAULT_PROVIDER) === id) {
      return reply
        .code(409)
        .send(
          apiError(
            "DEFAULT_PROVIDER",
            "This is the default provider. Choose a different default first."
          )
        );
    }
    db.softDeleteProvider(id);
    return { ok: true };
  });

  app.delete("/api/providers/:providerId/models/:modelId", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const { providerId, modelId } = request.params as { providerId: string; modelId: string };
    const provider = db.getProvider(providerId);
    if (!provider) return reply.code(404).send(apiError("PROVIDER_NOT_FOUND", "provider not found"));
    if (!db.softDeleteModel(modelId)) return reply.code(404).send(apiError("MODEL_NOT_FOUND", "model not found"));
    return publicProvider(providerId);
  });

  /* ----------------------------- document parsers ------------------------------ */

  /** The protocol kinds the server implements, so the UI never hard-codes the list. */
  app.get("/api/document-parsers/kinds", async () => driverInfos());

  app.get("/api/document-parsers", async () => documentParserConfigs());

  app.post("/api/document-parsers", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const body = request.body as CreateDocumentParserInput;
    const name = body?.name?.trim();
    const baseURL = body?.baseURL?.trim();
    if (!name) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));
    if (!baseURL) return reply.code(400).send(apiError("BASE_URL_REQUIRED", "baseURL is required"));
    if (!isDocumentParserKind(body.kind)) {
      return reply.code(400).send(apiError("UNKNOWN_PARSER_KIND", `unknown parser kind: ${String(body.kind)}`, { kind: String(body.kind) }));
    }

    const parser = db.createDocumentParser({
      id: newId(),
      name,
      kind: body.kind,
      baseURL,
      apiKey: body.apiKey?.trim() || undefined,
      enabled: body.enabled !== false,
    });
    return reply.code(201).send(publicDocumentParser(parser.id));
  });

  app.put("/api/document-parsers/:id", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const { id } = request.params as { id: string };
    const body = request.body as UpdateDocumentParserInput;
    if (!db.getDocumentParser(id)) return reply.code(404).send(apiError("PARSER_NOT_FOUND", "parser not found"));
    if (body?.kind !== undefined && !isDocumentParserKind(body.kind)) {
      return reply.code(400).send(apiError("UNKNOWN_PARSER_KIND", `unknown parser kind: ${String(body.kind)}`, { kind: String(body.kind) }));
    }

    // Same key contract as providers: absent keeps the stored key, "" clears it.
    db.updateDocumentParser(id, {
      name: body?.name,
      kind: body?.kind,
      baseURL: body?.baseURL,
      apiKey: body?.apiKey === undefined ? undefined : body.apiKey.trim(),
      enabled: body?.enabled,
    });
    return publicDocumentParser(id);
  });

  app.delete("/api/document-parsers/:id", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const { id } = request.params as { id: string };
    if (!db.getDocumentParser(id)) return reply.code(404).send(apiError("PARSER_NOT_FOUND", "parser not found"));

    // Unlike LLM providers there is no "last one" guard: running with zero cloud parsers is
    // a normal configuration (local-only), so deleting the final entry is allowed.
    db.softDeleteDocumentParser(id);
    if (db.getSetting(SETTING_DOCUMENT_DEFAULT_PARSER) === id) {
      db.setSetting(SETTING_DOCUMENT_DEFAULT_PARSER, "");
    }
    return { ok: true };
  });

  /** Round-trip a throwaway document through a parser to prove the endpoint and key work. */
  app.post("/api/document-parsers/:id/test", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const { id } = request.params as { id: string };
    if (!db.getDocumentParser(id)) return reply.code(404).send(apiError("PARSER_NOT_FOUND", "parser not found"));
    try {
      await documents.testParser(id);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ ok: false, ...parseApiError(err) });
    }
  });

  /** The parsing policy (tier order, fallback, pinned parser). */
  app.put("/api/document-parsing", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const body = request.body as UpdateDocumentParsingInput;

    if (body?.policy !== undefined) {
      if (!isParsePolicy(body.policy)) {
        return reply.code(400).send(apiError("UNKNOWN_POLICY", `unknown policy: ${String(body.policy)}`, { policy: String(body.policy) }));
      }
      db.setSetting(SETTING_DOCUMENT_POLICY, body.policy);
    }
    if (body?.localEnabled !== undefined) {
      db.setSetting(SETTING_DOCUMENT_LOCAL_ENABLED, body.localEnabled ? "1" : "0");
    }
    if (body?.fallbackEnabled !== undefined) {
      db.setSetting(SETTING_DOCUMENT_FALLBACK, body.fallbackEnabled ? "1" : "0");
    }
    if (body?.defaultParserId !== undefined) {
      const pin = body.defaultParserId === null ? "" : body.defaultParserId.trim();
      if (pin && !db.getDocumentParser(pin)) {
        return reply.code(400).send(apiError("UNKNOWN_PARSER", "unknown parser"));
      }
      db.setSetting(SETTING_DOCUMENT_DEFAULT_PARSER, pin);
    }
    return documentParsing();
  });

  /**
   * The upload limit, which is an installation-wide setting like the parsers above and an
   * administrator's to change for the same reason.
   *
   * Its own route rather than a field on `PUT /api/defaults`, which is about which model turns run
   * against: this one changes what every account may *send*, and the two share nothing but a gate.
   * The value must be a whole number of bytes within the floor and the ceiling — refused rather
   * than clamped, because a number outside that range is a request that did not mean what it said,
   * and silently storing the nearest legal limit would report success and deliver something else.
   */
  app.put("/api/upload-settings", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const body = request.body as UpdateUploadSettingsInput;
    const value = body?.maxUploadBytes;
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < MIN_UPLOAD_LIMIT_BYTES ||
      value > MAX_UPLOAD_CEILING_BYTES
    ) {
      return reply
        .code(400)
        .send(
          apiError(
            "INVALID_FIELD",
            `maxUploadBytes must be a whole number between ${MIN_UPLOAD_LIMIT_BYTES} and ${MAX_UPLOAD_CEILING_BYTES}`
          )
        );
    }

    db.setSetting(SETTING_MAX_UPLOAD_BYTES, String(value));
    // The whole config back, like `PUT /api/defaults`: the console's state is `store.config`, and
    // returning only the field would give it two ways to hold the same fact.
    return publicConfig(actor(request));
  });

  /* --------------------------------- app defaults ------------------------------ */

  app.put("/api/defaults", async (request, reply) => {
    if (!requirePlatformAdmin(request, reply)) return reply;

    const body = request.body as { providerId?: string; modelId?: string };
    if (body?.providerId !== undefined) {
      if (!db.getProvider(body.providerId)) {
        return reply.code(400).send(apiError("UNKNOWN_PROVIDER", "unknown provider"));
      }
      db.setSetting(SETTING_DEFAULT_PROVIDER, body.providerId);
    }
    if (body?.modelId !== undefined) db.setSetting(SETTING_DEFAULT_MODEL, body.modelId);
    return publicConfig(actor(request));
  });

  /**
   * Describe the images this turn sent to the model, once per source.
   *
   * Fire-and-forget from `finishTurn`, like the titler, and for the same reason: it is a model
   * call, and a model call on the turn path is a turn that can fail for a reason the user did
   * not cause. A failure is logged and nothing else — the image is still readable in the turn
   * it arrived in, and the next turn with the same image tries again.
   *
   * Only images the model could actually **see** are summarised: with no vision the attachment
   * was replaced by a placeholder, so a description would be a claim about a picture nothing
   * looked at.
   */
  async function summarizeTurnImages(input: {
    provider: ProviderRecord | undefined;
    modelId: string;
    /** This pass's own ledger reporter — see `passRecorder`. */
    onUsage?: (usage: MessageUsage, durationMs: number) => void;
    /**
     * Whether the model can see at all.
     *
     * Not a detail: with no vision the attachment reached it as a *placeholder*, so a
     * description would be a claim about a picture nothing looked at — and the request itself
     * would be an `image_url` a non-vision endpoint rejects. Checked before any work.
     */
    vision: boolean;
    user: UserLayout;
    userId: string;
    attachments: readonly Attachment[];
    /**
     * A line of the conversation, so the description comes back in the language the user is
     * reading. Cheaper and more reliable than a locale: the model already has the sentence, and
     * "same language as this" needs no table of tags.
     */
    sample: string;
  }): Promise<void> {
    if (!input.vision || input.attachments.length === 0) return;

    for (const attachment of input.attachments) {
      if (attachment.kind !== "image") continue;
      const file = db.getFileForUser(input.userId, attachment.id);
      if (!file || !needsSummary(file)) continue;

      const path = resolveFilePath(input.user, file);
      if (!path) continue;

      try {
        const dataUrl = await readAsDataUrl(path, file.mimeType);
        const summary = await summarizeImage({
          provider: input.provider,
          modelId: input.modelId,
          dataUrl,
          sample: input.sample,
          // One row per image described, because that is one model call: the loop is over the
          // turn's images, and a single row for the batch would hide how many calls it took.
          ...(input.onUsage ? { onUsage: input.onUsage } : {}),
        });
        if (!summary) continue;

        /*
         * Both halves, in one place: the file's `summary` column, which the browser reads, and the
         * text the *model* reads on every later turn — as a `files` row of its own, pointed at by
         * every reference to the image.
         *
         * The shape is `documents/service.ts`'s exactly, and it has to be: a reader resolves text
         * through a reference's `parsed_file_id` and then through *that* row's stored path, so a
         * file written to `parsed/<id>.txt` with no row behind it is a file nothing can find —
         * which is what this pass used to do, while its own docblock promised the opposite.
         *
         * The id is **new**, not the image's: `files.id` is the primary key, so the bytes and
         * their description cannot be the same row.
         */
        db.updateFilePath(file.id, input.userId, { summary });
        const textFileId = newId();
        await writeParsedText(input.user, textFileId, summary);
        registerFile(db, {
          id: textFileId,
          userId: input.userId,
          path: storePath(input.user, parsedFilePath(input.user, textFileId)),
          sourceType: "agent_create",
          size: Buffer.byteLength(summary, "utf8"),
          title: `${file.title} (summary)`,
          mimeType: "text/plain",
        });
        /*
         * **Every** reference to the picture, not just this turn's. A description is about the
         * image, and the image is one file: a conversation that holds it should be able to read
         * it whether it attached it or was pointed at it by `@`, and whether that happened
         * before or after the description was written.
         */
        for (const held of db.listWorkResourcesForResource(input.userId, "file", file.id)) {
          db.updateWorkResourceParse({
            id: held.id,
            userId: input.userId,
            status: "ready",
            parsedChars: summary.length,
            parsedFileId: textFileId,
          });
        }
      } catch (err) {
        app.log.warn(
          { err: err instanceof Error ? err.message : String(err), fileId: file.id },
          "image summary failed"
        );
      }
    }
  }

  /**
   * A title for a conversation, and **how it was arrived at** — the answers a caller has to tell
   * apart, in the vocabulary of the column that records them.
   *
   * `"model"` is the model naming it and `"fallback"` is the call not working, so the successful
   * pair is returned as the `TitleState` to store and the caller writes it straight through.
   * `"declined"` is the third answer and the new one: the model read the conversation and found
   * nothing to name in it yet — no title, and the next turn asks again.
   *
   * They used to be one value. This returned a bare string, so a model-written title and the user's
   * own clipped words were indistinguishable to every caller — both leave `titleSource: "auto"`
   * with a non-empty title — and a *decline* had nowhere to be expressed, so the only way to leave
   * a conversation unnamed was never to ask at all.
   */
  async function autoTitle(input: {
    provider: ProviderRecord | undefined;
    modelId: string;
    messages: readonly TitleMessage[];
    /** This pass's own ledger reporter — see `passRecorder`. */
    onUsage?: (usage: MessageUsage, durationMs: number) => void;
  }): Promise<{ status: "model" | "fallback"; title: string } | { status: "declined" }> {
    try {
      const title = await generateTitle(input);
      if (title === null) return { status: "declined" };
      return { status: "model", title };
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auto-title fell back to the user's own words"
      );
      /*
       * A failed call is not a decline: nothing was learned about whether the conversation has
       * substance, so the conversation is named after the user's own words and the state is the one
       * that says "this is worth another try" rather than the one that says "there is nothing
       * here". The two converge only when the user's own words clean up to nothing at all (a
       * question mark on its own), and then a decline is the honest summary: either way no title is
       * written, and the conversation stays on its placeholder.
       */
      const first = input.messages.find((m) => m.role === "user" && m.content.trim());
      const title = fallbackTitle(first?.content ?? "");
      return title ? { status: "fallback", title } : { status: "declined" };
    }
  }

  /**
   * Classify the just-finished turn into the thread widget's topic chains. Fire-and-forget on
   * purpose: it must not delay the stream's `done`, and a classification failure only leaves
   * the new messages unassigned until the next turn or a panel sync — the same "a side effect
   * can never fail a chat turn" contract the auto-titler keeps. Nothing happens when the
   * widget is not installed, and `syncThreads` is itself a no-op without unassigned messages.
   */
  function triggerThreadSync(
    userId: string,
    sessionId: string,
    provider: ProviderRecord | undefined,
    modelId: string,
    /** This pass's own ledger reporter — see `passRecorder`. */
    onUsage: (usage: MessageUsage, durationMs: number) => void
  ): void {
    let installed = false;
    try {
      installed = db.listSessionWidgetsForUser(userId, sessionId).some(
        (w) => w.id === "thread" && w.enabled
      );
    } catch {
      return;
    }
    if (!installed) return;
    void syncThreads(
      db,
      sessionId,
      makeThreadClassifier({ provider, modelId, reasoning: threadReasoning, onUsage }),
      "turn",
      modelId
    ).catch((err) => {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "thread sync after turn left messages unassigned"
      );
    });
  }

  /** Never returns `apiKey` — only whether one is set. */
  function publicDocumentParser(id: string): DocumentParserConfig {
    const parsers = documentParserConfigs();
    return (
      parsers.find((p) => p.id === id) ?? {
        id,
        name: "",
        kind: "sync",
        baseURL: "",
        enabled: false,
        hasApiKey: false,
      }
    );
  }

  /** Never returns `apiKey` — only whether one is set. */
  function publicProvider(id: string): ProviderConfig {
    const providers = providerConfigs();
    return (
      providers.find((p) => p.id === id) ?? {
        id,
        name: "",
        baseURL: "",
        models: [],
        hasApiKey: false,
      }
    );
  }

  /* ----------------------------------- chat ----------------------------------- */

  /** Everything a turn needs, resolved the same way whether it starts or resumes. */
  interface TurnContext {
    provider: ProviderRecord | undefined;
    modelId: string;
    tools: StructuredToolInterface[];
    vision: boolean;
    toolUse: boolean;
    /**
     * The account's own description of itself, which reaches the model as prompt context on every
     * turn — see `chat.system.about` in the catalog. Copied from the request's account rather
     * than re-read, and `""` when they have not written one.
     */
    about: string;
    /**
     * The two things the loop needs to describe where files may go: the conversation's own
     * directory, and the folder an unqualified write lands in. They come from here rather
     * than being recomputed in the loop, so the prompt names exactly the paths the tools
     * resolve against.
     */
    sessionDirPath: string;
    writeLocation: FileLocation;
    /**
     * What time it is where the user is, read at the top of the turn.
     *
     * Per turn rather than per session, and that is the whole point: a conversation left open
     * overnight must not answer tomorrow's "what is today" from yesterday's clock. Read here
     * because this is where the request body is in hand, and the body is the only place the
     * browser's own zone appears.
     */
    clock: TurnClock;
    /** Present when the plan tools survived assembly; appended to the turn's system prompt. */
    planGuidance?: string;
    /** Present when the quiz widget is installed; appended to the turn's system prompt. */
    quizGuidance?: string;
    /** Present when `ila_makeup_quiz` survived assembly; the positive half of its contract. */
    makeupGuidance?: string;
    /**
     * A tool call the model made resolved without throwing, handed the tool's name.
     *
     * This is where an `auto-install` widget's install happens: see `installWidgetForToolUse`.
     * Bound to this turn's user and conversation so a call site cannot name either — the same
     * closure form `collectPage` and `diagram` take.
     */
    onToolUsed?: (toolName: string) => void;
    /**
     * Present when `ila_collect_page` survived assembly; appended to the turn's system prompt.
     * Not a widget — this one is on by default, which is exactly why it needed the guidance.
     */
    collectPageGuidance?: string;
    /** See the assembly site: the positive half of `ila_table`'s contract. */
    tableGuidance?: string;
    /** Present when `write_file` survived assembly — the other half of the file card. */
    fileWriteGuidance?: string;
    /**
     * Present when the conversation holds an `@` grant **and** `ila_explore` survived assembly.
     * Its presence is what flips the workspace note's read prohibition — see `buildSystemPrompt`.
     */
    exploreGuidance?: string;
  }

  /**
   * Resolve the model, the persona in force and the tool set for one turn.
   *
   * Shared by the two routes that run a turn — `/chat` (a new user message) and
   * `/answers` (resuming a suspended `ask_user`). They have to agree on all of it: a
   * resumed turn that rebuilt its tools differently from the one that asked the question
   * could find `ask_user` missing from the very conversation it is in the middle of.
   *
   * **No Copilot is read here.** The session carries its own copy of everything a Copilot
   * contributes, so a turn consults the session and nothing else: that is what makes the
   * conversation independent of the Copilot it came from, and it is also what removes this
   * function from the list of places a Copilot id could be handed to another account.
   */
  function turnContext(
    session: Session,
    workspace: Workspace,
    input: {
      provider?: string;
      model?: string;
      /** The signed-in account; widget reads and sources are owner-scoped by it. */
      userId: string;
      /** Whose sources tree `read_document` reads from. */
      user: UserLayout;
      /**
       * The account's own description of itself, from `users.about`.
       *
       * A property of the *account* rather than of the conversation, so it arrives here with the
       * other per-request facts: changing it changes every conversation at once, which is what
       * "in my profile" means to the person who wrote it. `""` when they have not written one.
       */
      about: string;
      /**
       * The IANA zone the browser reported, or absent when it reported none.
       *
       * Untrusted like every other body field, which is why it goes through
       * `knownTimeZone` on the way in — and it is the *browser's* answer rather than this
       * process's because the server may be on a desk while the user is on a phone in
       * another timezone. Absent falls back to the server's own zone.
       */
      timezone?: string;
    }
  ): TurnContext {
    // Read at the top of the turn and carried through it, so every step of one turn states the
    // same time — a turn that fetched a page at 14:32 and answers at 14:33 was still a turn.
    const clock = turnClock(new Date(), input.timezone);

    // The session's own settings; request fields are one-turn overrides. There is no Copilot
    // tier left to consult — its defaults were merged in when the conversation was created.
    const providerId = resolveProviderId(input.provider, session.settings);
    const provider = db.getProvider(providerId);
    const modelId = resolveModelId(provider, input.model, session.settings);

    /*
     * Widget-switched tools. Read fresh per turn from the installed session widgets (a widget
     * can be installed mid-conversation), then derive the `required`-mode tool names: a name
     * here means its context is present and `buildTools` assembles it regardless of the
     * allow-list.
     *
     * Only the quiz tools can be in this set now. The plan and diagram tools became
     * `auto-install` — assembled on their own merits, with the allow-list governing them and a
     * call installing the widget — so their contexts are passed unconditionally below and this
     * read no longer decides them. `WidgetToolMode`'s two arms are what keeps that from being a
     * surprise at the call site.
     */
    const boundNames = boundToolNamesForWidgetIds(
      db
        .listSessionWidgetsForUser(input.userId, session.id)
        .filter((w) => w.enabled)
        .map((w) => w.id)
    );
    const quizInstalled = boundNames.some((name) =>
      (QUIZ_TOOL_NAMES as readonly string[]).includes(name)
    );

    // The conversation's own directory — `dirPath`, not `workdirPath`. The workdir is the
    // agent's sandbox and the file browser's root; deriving from it would put a
    // conversation's files inside the tree the model may already write into. One expression
    // with two consumers: `ila_diagram` writes here, and `ila_query` reads a `.mmd` back out
    // of here — computed once so "the conversation's own directory" has one definition.
    const ownDir = sessionDir(workspace.dirPath, session.id);

    // Where an unqualified write goes, resolved down the chain: the session's own setting
    // (which already carries whatever Copilot started it) over the workspace's default. The
    // per-turn instruction tier exists in `resolveWriteLocation` and is unused here until a
    // turn can express one — see `docs/resources.md`.
    const writeLocation = resolveWriteLocation({
      session: session.settings,
      workspace: workspace.settings,
    });

    /*
     * What this conversation may read, and the two things that decide it — resolved **here**,
     * once, rather than by each of the three turn routes and handed in.
     *
     * The placement is the point. Three call sites computing this would be three chances to
     * forget, in a function whose whole docblock is about the three turn routes not disagreeing;
     * with it here, a fourth route that builds its tools some other way also loses
     * `read_document` entirely and fails loudly rather than quietly under-granting.
     */
    const scope = resolveWorkspaceScope(db, input.userId, session);
    /*
     * The read whitelist: the conversation's own sources, its workspace's, and — when the user
     * has `@`-referenced other workspaces — those too.
     *
     * A whitelist rather than "whatever ids the model names": a guessed id fails a `Map`
     * lookup before any path is touched, which is what makes wandering into another
     * conversation's uploads unrepresentable rather than merely forbidden. It is wider than
     * the turn's own attachments on purpose — see `read_document`'s note — and the grant is
     * what makes it wider still.
     */
    const readable = db.listReadableWorkResources(
      input.userId,
      session.id,
      workspace.id,
      scopeQuery(scope)
    );

    const tools = buildTools({
      fileTools: {
        workdir: workspace.workdirPath,
        sessionDir: ownDir,
        defaultLocation: writeLocation,
        // Both rows are written after the bytes, through the *same* functions the file manager
        // and the reconciler call — so a file the agent wrote and a file the user moved end up
        // as rows nothing can tell apart, which is the point of the registry.
        register: ({ location, relPath, size }) => {
          const owner = fileOwner(location, {
            workspaceId: workspace.id,
            sessionId: session.id,
          });
          const stored =
            location === "workspace"
              ? workspaceFilePath(workspace.slug, relPath)
              : sessionFilePath(workspace.slug, session.id, relPath);
          const file = registerFile(db, {
            userId: input.userId,
            path: stored,
            sourceType: "agent_create",
            size,
          });
          return ensureWorkResource(db, {
            userId: input.userId,
            owner,
            resourceType: "file",
            resourceId: file.id,
            title: file.title,
          })?.id;
        },
        /*
         * The other half, and it is `deleteWorkResource` rather than an unlink — the same call the
         * file manager's route and the library's rows end in. Two writers of "this file is gone"
         * is how a `files` row ends up naming bytes that are not there, which is the state
         * `delete_file` used to leave: it unlinked and touched no row at all.
         *
         * The reference looked up is **this turn's owner** — the workspace's for a workdir file,
         * this conversation's for its own — because that is the row the tool is deleting from
         * under itself. A sibling conversation's reference to the same bytes is none of its
         * business; it keeps its row and reports the loss when somebody opens it.
         */
        unregister: async ({ location, relPath }) => {
          const stored =
            location === "workspace"
              ? workspaceFilePath(workspace.slug, relPath)
              : sessionFilePath(workspace.slug, session.id, relPath);
          const file = db.getFileByPath(input.userId, stored);
          if (!file) return false;
          const owner = fileOwner(location, {
            workspaceId: workspace.id,
            sessionId: session.id,
          });
          const held = db
            .listWorkResourcesForResource(input.userId, "file", file.id)
            .find((row) => row.ownerType === owner.kind && row.ownerId === owner.id);
          if (!held) return false;
          await deleteWorkResource(db, input.user, { userId: input.userId, id: held.id });
          return true;
        },
      },
      webSearch: config.tools.webSearch,
      webFetch: config.tools.webFetch,
      fileToolsEnabled: config.tools.fileTools.enabled,
      // The session's own snapshot, not a Copilot's live list. `undefined` when every tool
      // is available and the list otherwise, even when empty ("no tools" is representable).
      allowedNames: session.allTools ? undefined : session.tools,
      documents: {
        db,
        userId: input.userId,
        user: input.user,
        resources: readable.map((r) => ({
          id: r.id,
          name: r.title,
          mimeType:
            r.resourceType === "file" ? (r.resource as StoredFile).mimeType : "text/html",
        })),
        maxChars: Math.min(config.tools.documents.maxTextChars, 40_000),
      },
      // `ila_quiz` and its grading companion are `required` mode: both contexts exist only when
      // the quiz widget is installed, and their absence is what assembles neither tool. The
      // counter and the question rows are scoped to this conversation.
      quiz: quizInstalled
        ? {
            reserveQuestionNumbers: (count) =>
              db.reserveCounter("session", session.id, QUIZ_QUESTION_COUNTER, count),
            registerQuestions: (input2) => registerQuizQuestions(db, session.id, input2),
          }
        : undefined,
      quizReview: quizInstalled ? { db, sessionId: session.id } : undefined,
      // The third of the same switch, and read-only: the make-up tool writes nothing until the
      // learner answers it, so its context is a selection from the conversation's own rows.
      quizMakeup: quizInstalled
        ? { selectQuestions: (ids) => makeupQuestions(db, session.id, ids) }
        : undefined,
      // The plan tools are `auto-install`, so this context is not an assembly switch — the
      // allow-list is. Passing it in every conversation is what lets the model make a plan where
      // no panel was ever installed, and `installWidgetForToolUse` below is what puts the panel
      // there when it does.
      plan: { db, sessionId: session.id },
      /*
       * The rows go to the same session id as the file, in one callback, so the three cannot
       * diverge on which conversation they belong to. `ownDir` is the definition above.
       *
       * **Two rows, and both are needed.** `session_diagrams` holds what a file cannot answer
       * — the canonical name the client joins on, the model's summary, the thread the
       * classifier put it in. The *source* row holds what that table cannot — that this is
       * material the conversation has, where it sits, and what kind of thing it is — and it is
       * what makes a diagram visible to the same registry, the same browser and the same
       * `@`-reference as everything else. Neither replaces the other.
       *
       * One transaction because a diagram whose file exists but whose rows half-landed is a
       * file the conversation draws and the registry cannot name. The precedent is the
       * classifier placing diagrams with their turn's messages.
       */
      diagram: {
        sessionDir: ownDir,
        save: (saved) => {
          /*
           * A file, a diagram row and a **pointer** — and the transaction is for the pointer.
           *
           * It used to be two rows landing together; what it protects now is a diagram row whose
           * `file_id` is null, which is a row the 图表 panel can list and cannot open. The file
           * gets **no work resource**, deliberately: a diagram's `.mmd` is not externally
           * referenceable, so it is in the panel and not in the library.
           */
          db.transaction(() => {
            const file = registerFile(db, {
              userId: input.userId,
              path: sessionFilePath(workspace.slug, session.id, saved.name),
              sourceType: "agent_create",
              size: saved.size,
              title: saved.name,
              summary: saved.summary,
            });
            registerDiagram(db, session.id, { ...saved, fileId: file.id });
          });
        },
      },
      /*
       * A table is one row and nothing else, and deliberately **no transaction**.
       *
       * The diagram callback above needs one because two rows have to land together — its file
       * and its source row — and a diagram whose file exists but whose rows half-landed is a file
       * the conversation draws and the registry cannot name. There is one write here, and a
       * transaction around a single statement reads as if a second write existed.
       */
      table: {
        save: (saved) => {
          registerTable(db, session.id, saved);
        },
      },
      // Not gated on anything: the conversation's own record exists from the moment the
      // conversation does, whether or not any widget is installed to show it.
      query: {
        db,
        userId: input.userId,
        sessionId: session.id,
        workspaceId: workspace.id,
        scope: scopeQuery(scope),
        sessionDirPath: ownDir,
      },
      /*
       * Keeping a page is the other half of fetching one, and it is gated on the same switch:
       * an installation that has turned fetching off has no pages to keep. The `register`
       * callback writes the row through the same registry as everything else, so a captured
       * page is a source in exactly the way a file is.
       */
      collectPage: config.tools.webFetch.enabled
        ? {
            db,
            user: input.user,
            userId: input.userId,
            sessionId: session.id,
            workspaceId: workspace.id,
          }
        : undefined,
      /*
       * Present only when the conversation has been opened to other workspaces — the gate is
       * the grant, so an ordinary conversation carries no tool for reading across them, and the
       * model is never offered one that could only refuse.
       */
      explore: scopeIsEmpty(scope) ? undefined : { db, userId: input.userId, scope },
    });

    return {
      provider,
      modelId,
      tools,
      vision: isVisionModel(provider, modelId),
      toolUse: isToolUseModel(provider, modelId),
      about: input.about,
      sessionDirPath: ownDir,
      writeLocation,
      clock,
      /*
       * Read off the assembled set, like `collectPageGuidance` below and for the same reason:
       * with the plan tools `auto-install`, "is the widget installed" stopped being the question.
       * Whether the model can actually call them is, and only the array knows. The three are
       * assembled as a unit, so naming one would do — naming all three is what keeps that from
       * being an assumption.
       */
      planGuidance: tools.some((t) => (PLAN_TOOL_NAMES as readonly string[]).includes(t.name))
        ? planGuidance()
        : undefined,
      /*
       * Still gated on the install, and the difference from the line above is the mode: the quiz
       * tools are `required`, so they bypass the allow-list and the widget install *is* the whole
       * question. Asking the array here would answer yes whenever the widget is installed and
       * no otherwise, which is the same answer by a longer route.
       */
      quizGuidance: quizInstalled ? quizGuidance() : undefined,
      /*
       * The make-up card's positive half, asked of the assembled array — the quiz block above is
       * gated on the install instead because the *tool* is; this asks whether it is really there,
       * which is a question the array answers and the install can only approximate.
       */
      makeupGuidance: tools.some((t) => t.name === QUIZ_MAKEUP_TOOL_NAME)
        ? makeupGuidance()
        : undefined,
      /*
       * Read off the assembled set rather than off the config, and that is the whole of the
       * condition: a Copilot whose allow-list excludes `ila_collect_page` gets no guidance for a
       * call it cannot make, while the `webFetch.enabled` switch is already expressed by the
       * context above having been passed at all. Asking the array is the one form of the
       * question that cannot disagree with the answer.
       */
      collectPageGuidance: tools.some((t) => t.name === "ila_collect_page")
        ? collectPageGuidance()
        : undefined,
      // The same form of the question as the line above: a Copilot whose allow-list excludes
      // `ila_explore` gets no guidance for a call it cannot make, while the grant itself is
      // already expressed by `scopeIsEmpty` at assembly.
      exploreGuidance: tools.some((t) => t.name === EXPLORE_TOOL_NAME)
        ? exploreGuidance(scope)
        : undefined,
      /*
       * `ila_table`'s half, and it is load-bearing in a way the others are not: nothing on the
       * server can write into a model's reply, so "the table also appears inline, as ordinary
       * Markdown" is a prompt instruction or it is nothing at all. The tool's own description is
       * necessarily a restriction — "not every table" — and a model that was never told the
       * positive half reads a restriction as "usually do not", which is the failure
       * `collectPageGuidance` documents one tool over.
       *
       * Asked of the assembled array, like the two above it: a Copilot whose allow-list excludes
       * the tool is never taught a call it cannot make.
       */
      tableGuidance: tools.some((t) => t.name === TABLE_TOOL_NAME) ? tableGuidance() : undefined,
      /*
       * The file card's other half, in the same form: the renderer draws the written file over
       * the call, and this is what asks the reply not to restate it. Asked of the assembled
       * array, so a Copilot whose allow-list excludes `write_file` is never told what not to do
       * with a file it cannot write.
       */
      fileWriteGuidance: tools.some((t) => t.name === WRITE_FILE_TOOL_NAME)
        ? fileWriteGuidance()
        : undefined,
      /*
       * The `auto-install` side effect, and the only reason the loop takes a callback for it: the
       * loop knows which tool ran, and this closure knows whose conversation it ran in. It
       * installs from *silence* — a widget this conversation has never been asked about — and
       * never over a stored "no", so a panel somebody closed stays closed.
       */
      onToolUsed: (toolName: string) => {
        installWidgetForToolUse({ db, userId: input.userId, sessionId: session.id, toolName });
      },
    };
  }

  /**
   * Register a turn as stoppable, and hand back the signal it runs under.
   *
   * Every route that streams a turn uses this, so Stop works on a resumed `ask_user` turn
   * exactly as it does on a fresh one — the client shows the same control for both, and a
   * control that renders but does nothing is worse than no control.
   *
   * The `close` listener is the other way a turn ends early: a tab closed or a connection
   * dropped should stop costing tokens just like a Stop would. `finished` separates that from
   * a socket closing after a turn that ran to the end, which must not abort anything.
   */
  function beginTurn(request: FastifyRequest, sessionId: string) {
    const controller = new AbortController();
    activeTurns.set(sessionId, controller);

    let finished = false;
    const onDisconnect = () => {
      if (!finished) controller.abort();
    };
    request.raw.on("close", onDisconnect);

    return {
      signal: controller.signal,
      finish() {
        finished = true;
        request.raw.off("close", onDisconnect);
        // Only clear our own entry: a later turn for the same session may already have
        // registered itself while this one was unwinding.
        if (activeTurns.get(sessionId) === controller) activeTurns.delete(sessionId);
      },
    };
  }

  /**
   * Persist what a turn produced and close the stream: the assistant message, its
   * `message_done`, the conversation title when the conversation has not got one yet, and `done`.
   *
   * A turn that suspended on `ask_user` goes through here like any other — its assistant
   * message simply carries a tool call with `status: "awaiting"` and no `output`, which
   * is the whole representation of "we are waiting on a person".
   */
  async function finishTurn(
    id: string,
    userId: string,
    session: Session,
    ctx: TurnContext,
    result: RunAgentResult,
    sse: ReturnType<typeof createSseWriter>,
    opts: {
      userMessage: string | null;
      /** Whose tree the image bytes live in, for the summary pass below. */
      user: UserLayout;
      /** What this turn sent, so the images among them can be described — see below. */
      attachments?: readonly Attachment[];
      /** How long the turn took, for the usage ledger. Measured by the caller. */
      durationMs?: number;
    }
  ): Promise<void> {
    /*
     * Which model wrote this message, resolved once and used twice — on the row and on the ledger
     * entry below. One resolution is what keeps the transcript and the statistics from ever
     * disagreeing about which model ran a turn.
     */
    const model = describeModel(ctx.provider, ctx.modelId);
    /*
     * An image this model cannot see, said out loud **in the message the turn produces**.
     *
     * `⚠️` and `OUT_OF_STEPS` are the same shape and the same reasoning: it is content rather than
     * chrome, it is replayed to the model next turn, and it is untranslated because the server has
     * no reader to ask. What it answers is a silent failure — an image attachment on a model with
     * no vision reaches the prompt as a placeholder, so the reply reads as though the picture was
     * considered and had nothing to say.
     *
     * It is appended here rather than posted as a second message because this is the only place
     * that **arrives**: `runAgentStream` has already emitted `message_done` by the time
     * `finishTurn` runs, so a row created afterwards would appear only on a reload.
     *
     * One line per turn, not per image, and only when there is nothing to be said for the picture
     * — the summary pass below describes what it *can*, and that description is what a later
     * model reads.
     */
    const unseen = ctx.vision
      ? []
      : (opts.attachments ?? []).filter((attachment) => attachment.kind === "image");
    const content =
      unseen.length === 0
        ? result.content
        : result.content +
          (result.content.trim() ? "\n\n" : "") +
          `⚠️ 本次附带的 ${unseen.length === 1 ? `图片「${unseen[0]!.name}」` : `${unseen.length} 张图片`}` +
          `未参与理解：当前模型不支持图片输入。`;

    const assistantMessage = db.createMessage({
      id: newId(),
      sessionId: id,
      role: "assistant",
      content,
      reasoning: result.reasoning || undefined,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      usage: Object.keys(result.usage).length > 0 ? result.usage : undefined,
      model,
      stopped: result.stopped,
    });
    db.touchSession(id);

    /*
     * The turn, in the ledger. One row per finished turn — not per ReAct step — because the model
     * was billed for the turn and `result.usage` is already the sum across its steps.
     *
     * A stopped turn reports no usage at all (see `runAgentStream`), so `recordUsage` writes
     * nothing: a half-finished step's figures are not a number worth summing, and an all-zero row
     * would drag every average toward it.
     */
    recordUsage(db, {
      userId,
      workspaceId: session.workspaceId,
      sessionId: id,
      messageId: assistantMessage.id,
      purpose: "chat",
      model,
      usage: result.usage,
      durationMs: opts.durationMs ?? null,
    });

    sse.send({ type: "message_done", message: assistantMessage });

    /*
     * Describe the images this turn sent, if the model could see them.
     *
     * Deliberately **not awaited**: it is a second model call, and the stream is already at
     * `message_done` — a turn that waited on a description would be a turn that got slower for
     * a chip nobody has looked at yet. Every failure inside is swallowed and logged there.
     */
    void summarizeTurnImages({
      provider: ctx.provider,
      modelId: ctx.modelId,
      vision: ctx.vision,
      user: opts.user,
      userId,
      attachments: opts.attachments ?? [],
      sample: opts.userMessage ?? session.title,
      onUsage: passRecorder({
        userId,
        workspaceId: session.workspaceId,
        sessionId: id,
        provider: ctx.provider,
        modelId: ctx.modelId,
        purpose: "summary.media",
      }),
    });

    /*
     * Name the conversation, unless the user already typed a title (which flips `titleSource` to
     * `user`) or the model has already named it.
     *
     * **On every turn, not only the first.** A conversation that opens with `你好` has nothing to
     * name, and the model says so rather than inventing a title from it — and then the *next* turn
     * asks again, which is the only way a name that means something can ever arrive. The state that
     * closes this gate is the model having actually produced one.
     *
     * The excerpt comes from the persisted messages rather than from this turn's arguments, so a
     * turn nobody typed (`/regenerate`, a resumed `ask_user`) is a legitimate attempt too: the
     * question it is answering is already in the history.
     */
    if (session.titleSource !== "user" && session.titleState !== "model") {
      // Read only once the gate is open: a conversation the model has already named must not pay
      // for a message query on every turn of its life.
      const messagesToTitle = titleMessagesFor(id, userId);
      if (messagesToTitle) {
        const titled = await autoTitle({
          provider: ctx.provider,
          modelId: ctx.modelId,
          messages: messagesToTitle,
          onUsage: passRecorder({
            userId,
            workspaceId: session.workspaceId,
            sessionId: id,
            provider: ctx.provider,
            modelId: ctx.modelId,
            purpose: "title",
          }),
        });
        if (titled.status === "declined") {
          /*
           * The model read the conversation and there was nothing in it to name. The title column
           * is left alone — the conversation keeps the placeholder it was created with, which is
           * the state the requirement asks for and the reason no event is sent — and only the
           * state moves, so the next turn knows the question has already been asked of *this*
           * content and a leave does not ask it a third time.
           */
          db.setTitleStateForUser(id, userId, "unnamed");
        } else {
          /*
           * Numbered against its siblings, itself excluded — the titler is guessing at a name and
           * has no idea what else is in the list, so two conversations that open the same way
           * would otherwise both be called `什么是递归`. The number is what the SSE event
           * carries, so the sidebar shows the same string the database now holds.
           */
          const unique = uniqueTitleIn(session.workspaceId, userId, titled.title, id);
          /*
           * The write decides whether there is anything to announce: it refuses when the title is
           * no longer the titler's to set, which the user can make true by renaming mid-turn. The
           * event used to be sent regardless, so the sidebar would show a name the database had
           * just declined to hold.
           */
          if (db.setAutoTitleForUser(id, userId, unique, titled.status)) {
            sse.send({ type: "title", sessionId: id, title: unique });
          }
        }
      }
    }

    // Topic classification runs after every finished turn while the widget is installed —
    // not awaited, so it never delays `done`, and swallowed internally on failure.
    triggerThreadSync(
      userId,
      id,
      ctx.provider,
      ctx.modelId,
      passRecorder({
        userId,
        workspaceId: session.workspaceId,
        sessionId: id,
        provider: ctx.provider,
        modelId: ctx.modelId,
        purpose: "thread",
      })
    );
  }


  /**
   * A recorder for one out-of-band pass: the attribution all of them share.
   *
   * Built here rather than inside each pass, because the passes differ only in their *purpose* —
   * every one of them runs inside an account's turn or an account's session, and resolving the ids
   * in one place is what stops a new pass from being wired with a different idea of whose call it
   * was. The model is resolved once, at build time, so a ledger row and the transcript cannot
   * disagree about which model ran.
   *
   * The returned callback goes straight to a pass's `onUsage`, which calls it only when the
   * provider reported something — see `recordUsage` for why an unreported call writes no row.
   */
  function passRecorder(input: {
    userId: string;
    workspaceId?: string | null;
    sessionId?: string | null;
    provider: ProviderRecord | undefined;
    modelId: string;
    purpose: UsagePurpose;
  }): (usage: MessageUsage, durationMs: number) => void {
    const model = describeModel(input.provider, input.modelId);
    return (usage, durationMs) => {
      recordUsage(db, {
        userId: input.userId,
        workspaceId: input.workspaceId ?? null,
        sessionId: input.sessionId ?? null,
        purpose: input.purpose,
        model,
        usage,
        durationMs,
      });
    };
  }

  /** Report a failed turn and keep history well-formed. */
  function failTurn(
    id: string,
    ctx: TurnContext,
    err: unknown,
    sse: ReturnType<typeof createSseWriter>
  ): void {
    const errorText = err instanceof Error ? err.message : String(err);
    // The code is additive and lives only on the event: `errorText` below is persisted
    // verbatim, because that `⚠️` line is replayed to the model next turn. Rewriting the
    // provider's sentence into something friendlier would change what the model is told about
    // its own failure, which is a different decision from what the *user* is shown.
    sse.send({ type: "error", message: errorText, code: classifyProviderError(errorText) });
    // Persist a balanced assistant message so history stays user/assistant.
    db.createMessage({
      id: newId(),
      sessionId: id,
      role: "assistant",
      content: `⚠️ ${errorText}`,
      // Attributed like any other assistant message: "which model failed" is the first question
      // anybody asks about a failed turn, and a row with no model cannot answer it.
      model: describeModel(ctx.provider, ctx.modelId),
    });
  }


  /**
   * Run the turn that follows a write the route has already made.
   *
   * `/answers`, `/regenerate` and the make-up submit all end the same way: something was written,
   * the history is read **after** that write, and the model continues from a history that ends on
   * a tool result rather than on a new user message — `userMessage: null` is what keeps the user's
   * own message from arriving twice. They differ only in the frame they emit before the run
   * starts: the plan fork's navigation, the removed reply, the recorded make-up.
   *
   * One implementation rather than three, and not for tidiness: these routes have to agree about
   * the turn's clock, its guidance, its tools and what a provider failure leaves behind, and three
   * copies of that agreement is how they stop having it.
   */
  async function streamResumedTurn(input: {
    request: FastifyRequest;
    reply: FastifyReply;
    userId: string;
    session: Session;
    workspace: Workspace;
    /** Emitted right after `meta`, before the model streams. */
    before?: (sse: ReturnType<typeof createSseWriter>) => void;
  }): Promise<void> {
    const { request, reply, userId, session, workspace } = input;
    const id = session.id;

    const ctx = turnContext(session, workspace, {
      userId,
      user: treeFor(actor(request)),
      about: actor(request).about,
      // A resumed turn is a turn like any other and gets the clock like any other; the client
      // posts a body for this one field alone.
      timezone: (request.body as TurnRequestMeta | undefined)?.timezone,
    });

    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });
    input.before?.(sse);

    const turn = beginTurn(request, id);
    try {
      // Read history *after* the route's write, so the resumed run sees it.
      const history = db.listMessagesForUser(id, userId);
      // Wall-clock time for the call, which is the ledger's one non-token figure. Measured around
      // the whole run rather than around the provider request: a turn that spends four seconds in
      // tools and one in the model is a turn that took five.
      const turnStartedAt = Date.now();
      const result = await runAgentStream({
        provider: ctx.provider,
        modelId: ctx.modelId,
        workspace,
        // Read from the session, exactly as `/chat` does: a resumed turn must not rebuild the
        // persona differently from the one that asked the question it is resuming.
        systemPrompt: session.systemPrompt,
        settings: session.settings,
        user: treeFor(actor(request)),
        sessionId: id,
        vision: ctx.vision,
        toolUse: ctx.toolUse,
        history,
        userMessage: null,
        // No turn of its own, but the history it replays may reference files whose paths are
        // not derivable from their ids — see `filePathsFor`.
        sourcePaths: filePathsFor(db, treeFor(actor(request)), userId, fileIdsOf(history, [])),
        // And what those replayed turns pointed at. This is the shape where it matters most: an
        // answer rebuilt from history would otherwise leave the model asked about nothing.
        historicalReferences: referencesForHistory(db, userId, id, history),
        tools: ctx.tools,
        sessionDirPath: ctx.sessionDirPath,
        writeLocation: ctx.writeLocation,
        about: ctx.about,
        planGuidance: ctx.planGuidance,
        quizGuidance: ctx.quizGuidance,
        makeupGuidance: ctx.makeupGuidance,
        collectPageGuidance: ctx.collectPageGuidance,
        tableGuidance: ctx.tableGuidance,
        fileWriteGuidance: ctx.fileWriteGuidance,
        exploreGuidance: ctx.exploreGuidance,
        onToolUsed: ctx.onToolUsed,
        clock: ctx.clock,
        signal: turn.signal,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, userId, session, ctx, result, sse, {
        durationMs: Date.now() - turnStartedAt,
        userMessage: null,
        user: treeFor(actor(request)),
      });
    } catch (err) {
      failTurn(id, ctx, err, sse);
    } finally {
      turn.finish();
      sse.send({ type: "done" });
      sse.end();
    }
  }

  app.post("/api/sessions/:id/chat", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const body = request.body as ChatInput;

    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    const { session, workspace } = found;

    /*
     * `?? ""` rather than leaving it possibly-undefined, and it is load-bearing now that a turn
     * may carry nothing but references: the user message is persisted and handed to the run as a
     * *string*, and an absent one would reach `buildUserContent` as `undefined` and throw — a 500
     * on the one shape of turn that has no words in it at all.
     */
    const message = body?.message?.trim() ?? "";
    const attachments = body?.attachments ?? [];
    /*
     * A turn may be nothing but references, and the composer allows it — `canSend` accepts a
     * staged chip alone, in every conversation. So this guard has to know about them or the two
     * sides disagree about what a sendable message is, and a question asked by pointing at
     * something is refused by a server that never looked at what was pointed at.
     */
    const mayCarryRefs = Array.isArray(body?.refs) && body.refs.length > 0;
    if (!message && attachments.length === 0 && !mayCarryRefs) {
      return reply.code(400).send(apiError("MESSAGE_REQUIRED", "message is required"));
    }

    /*
     * The sources this conversation can actually read — its own links plus its workspace's.
     * A whitelist membership test rather than a path check: a stale or hostile client cannot
     * name another conversation's upload at all, and an id for a deleted file degrades to a
     * placeholder downstream rather than failing the turn.
     *
     * Both halves of the snapshot are reassembled here, and each comes from the side that
     * knows it. The **name** is the client's, because it is the one this message used — a
     * source shared between conversations can only remember the first. The **parse state** is
     * the server's, read from the row at this moment: a tab that has been sitting open would
     * otherwise write whatever it last saw into the record of a turn, so a document that
     * failed to parse would reach the model as "still parsing" and it would answer about a
     * file it was told was coming.
     */
    // The same whitelist `turnContext` builds, and it is built twice on this route rather than
    // shared because the two are needed at different points in it: this Map validates what the
    // client claimed *before* the user message is persisted, and the whitelist itself is
    // assembled inside `turnContext` so that no call site can hand it a narrower one.
    const readable = new Map(
      db
        .listReadableWorkResources(
          userId,
          id,
          workspace.id,
          scopeQuery(resolveWorkspaceScope(db, userId, session))
        )
        .map((r) => [r.id, r])
    );
    /*
     * The client names the **reference** it staged, and the snapshot is rebuilt from the server's
     * row rather than trusted: `resourceId`, not the file id. An attachment must already be
     * readable — it was uploaded into this conversation or its workspace — and a stale client
     * naming anything else is a client to refuse, which the `Map` membership test does before any
     * path is touched.
     */
    const storedAttachments = attachments
      .map((a) => {
        const row = readable.get(a.resourceId ?? "");
        return row ? toAttachment(row, a.name) : undefined;
      })
      .filter((a): a is Attachment => a !== undefined);

    // Any question still waiting for an answer belongs to a turn the user has now moved
    // on from. Retiring it here — before the new user turn is written — is what makes the
    // card read "skipped" rather than staying live on a conversation that has moved past it.
    // The retired quiz calls' question rows go with them, so the panel's skipped filter
    // matches the cards.
    const retired = db.skipAwaitingToolCalls(id);
    skipQuizQuestions(
      db,
      id,
      retired.filter((c) => c.name === QUIZ_TOOL_NAME).map((c) => c.id)
    );

    const ctx = turnContext(session, workspace, {
      provider: body.provider,
      model: body.model,
      userId,
      user: treeFor(actor(request)),
      about: actor(request).about,
      timezone: body.timezone,
    });

    /*
     * What this turn points at — a diagram, a table, a note, or a passage the user selected.
     *
     * Resolved before anything is written, so a reference that cannot be found refuses the turn
     * rather than producing an answer about nothing. Every target lives inside this conversation,
     * which is what makes "it does not resolve" a client problem rather than an ordinary race.
     */
    const refs = parseTurnReferences(body?.refs);
    if (refs === null) {
      return reply.code(400).send(apiError("INVALID_FIELD", "refs must be a list"));
    }
    const resolution = resolveReferences(db, userId, id, refs);
    if (!resolution.ok) {
      return reply.code(resolution.status).send(apiError(resolution.code, "reference not found"));
    }

    /*
     * A `@`-reference is the user pointing at their own material, wherever it is — and what makes
     * it readable on the *next* turn too is a **link of this conversation's own**, not a copy for
     * this one. It is recorded in `session_references`: the fact that this conversation is *about*
     * that **work resource**, which is a different relation from *holding* it.
     *
     * **The handle is the reference id, and that is v5's change.** The row used to name the
     * *entity*, which made "referred to" mean "any holder of" — the panel then listed every holder
     * of anything the conversation had pointed at. What the user points at is a reference, and it
     * is what gets recorded.
     *
     * **It deliberately does not create a holding row.** It used to, and that is what made the
     * library show one file once per conversation that had mentioned it: the library lists
     * holdings, and a link was wearing the same row shape. A conversation that already holds *this
     * row* has nothing to write at all — holding it already implies referring to it.
     *
     * A side effect of the request rather than of `resolveReferences`, which stays read-only on
     * purpose: replay resolves references on every later turn, and a replay that wrote would
     * resurrect rows a user had deleted.
     */
    const referencedAttachments: Attachment[] = [];
    for (const resolved of resolution.resolved) {
      if (resolved.kind !== "resource") continue;
      const held = db.getWorkResourceForUser(userId, resolved.resourceId);
      if (!held) continue;

      if (held.ownerType !== "session" || held.ownerId !== id) {
        db.addSessionReference({
          id: newId(),
          sessionId: id,
          workResourceId: held.id,
        });
      }
      referencedAttachments.push(toAttachment(held, held.title));

      /*
       * The parse is queued **on the holding row**, never on a row of this conversation's own —
       * because there is no longer one to queue it on, and because a parse belongs to whoever
       * holds the material. One document is extracted once, and every conversation that referred
       * to it reads that extraction (the whitelist admits the owner's row, so the id the model is
       * handed is the same one this put the text on).
       *
       * Without this the model reads "still parsing" for ever — the feature looks right in the UI
       * and fails only when the model tries to read the document, which is the worst place for it
       * to fail.
       */
      if (held.parseStatus === "none") {
        /*
         * A page is **adopted** rather than scheduled. It arrives already extracted, and its text
         * is reachable only through a holding row — so a row born with no pointer, and `schedule`
         * skips it (`text/html` is not a document MIME). See `adoptPageParse`, which answers false
         * for everything else and for a page whose every holder is also unparsed, leaving the
         * schedule to run as it always did.
         */
        const adopted = adoptPageParse(db, userId, held);
        if (!adopted) {
          void documents.schedule(treeFor(actor(request)), userId, held).catch(() => undefined);
        }
      }
    }

    // Read history *before* persisting the new user turn, so it isn't replayed twice.
    const history = db.listMessagesForUser(id, userId);

    const userMessage = db.createMessage({
      id: newId(),
      sessionId: id,
      role: "user",
      content: message,
      attachments: storedAttachments.length > 0 ? storedAttachments : undefined,
      // The *client's* references rather than the resolved ones: a message describes the turn
      // that was had, so the chip keeps the label and the quote it was shown with. What the model
      // reads is re-derived on every run from these — see `referencesForHistory`.
      refs: refs.length > 0 ? refs : undefined,
    });

    // Take over the response so we can stream Server-Sent Events.
    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });
    // The row this turn just wrote for the user's own message. The client has been showing an
    // optimistic bubble under an id of its own making; this is what makes the row addressable,
    // which a tail delete needs.
    sse.send({ type: "message_saved", message: userMessage });

    const turn = beginTurn(request, id);

    try {
      // Wall-clock time for the call, which is the ledger's one non-token figure. Measured
      // around the whole run rather than around the provider request: a turn that spends four
      // seconds in tools and one in the model is a turn that took five.
      const turnStartedAt = Date.now();
      const result = await runAgentStream({
        provider: ctx.provider,
        modelId: ctx.modelId,
        workspace,
        // The conversation's own persona, copied from its Copilot at creation and editable
        // since. Empty means the built-in assistant prompt.
        systemPrompt: session.systemPrompt,
        settings: session.settings,
        user: treeFor(actor(request)),
        sessionId: id,
        vision: ctx.vision,
        toolUse: ctx.toolUse,
        history,
        userMessage: message,
        // To the model, an attachment and a referenced resource are the same thing: material
        // this turn is about. A reference reaches the prompt twice on purpose — as a pointer it
        // can follow with `read_document`, and as bytes here when it is an image — because the
        // two answer different questions and neither replaces the other.
        attachments: [...storedAttachments, ...referencedAttachments],
        sourcePaths: filePathsFor(
          db,
          treeFor(actor(request)),
          userId,
          fileIdsOf(history, [...storedAttachments, ...referencedAttachments])
        ),
        // This turn's, and every earlier message's — the same split `userMessage` and `history`
        // make, and for the same reason: history was read before this turn was written.
        references: resolution.resolved,
        historicalReferences: referencesForHistory(db, userId, id, history),
        tools: ctx.tools,
        sessionDirPath: ctx.sessionDirPath,
        writeLocation: ctx.writeLocation,
        about: ctx.about,
        planGuidance: ctx.planGuidance,
        quizGuidance: ctx.quizGuidance,
        makeupGuidance: ctx.makeupGuidance,
        collectPageGuidance: ctx.collectPageGuidance,
        tableGuidance: ctx.tableGuidance,
        fileWriteGuidance: ctx.fileWriteGuidance,
        exploreGuidance: ctx.exploreGuidance,
        onToolUsed: ctx.onToolUsed,
        clock: ctx.clock,
        signal: turn.signal,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, userId, session, ctx, result, sse, {
        durationMs: Date.now() - turnStartedAt,
        userMessage: message,
        user: treeFor(actor(request)),
        // The attachments *and* the references: both were sent as material, and an image the
        // user pointed at with `@` deserves a description as much as one they dragged in.
        attachments: [...storedAttachments, ...referencedAttachments],
      });
    } catch (err) {
      failTurn(id, ctx, err, sse);
    } finally {
      // Before `sse.end()`: closing the socket is exactly the event the disconnect listener
      // is watching for, and it must not read as the client having gone away.
      turn.finish();
      sse.send({ type: "done" });
      sse.end();
    }
  });

  /**
   * Answer a suspended `ask_user` call, and carry the turn on from there.
   *
   * Streams the same way `/chat` does, so the client consumes one shape for both. What it
   * does *not* do is append a user message: the answers are written onto the tool call
   * that asked for them, and the resumed run's history is that call plus its result.
   * That is why a question can be answered after a reload, or after the server restarted
   * — nothing about the pending state lives in a process.
   */
  app.post("/api/sessions/:id/answers", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const body = request.body as AnswerToolCallInput;

    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    const { session, workspace } = found;

    const toolCallId = typeof body?.toolCallId === "string" ? body.toolCallId : "";
    const action = body?.action === "cancel" ? "cancel" : "submit";

    const pending = toolCallId ? db.findAwaitingToolCall(id, toolCallId) : undefined;
    if (!pending) {
      // Covers the double submit, the card the user already skipped by sending a message,
      // and a tool-call id belonging to another session. None of them is a server fault.
      return reply.code(409).send(
        apiError("QUESTION_NOT_PENDING", "that question is no longer awaiting an answer")
      );
    }

    // Which tool this call belongs to decides how its `input` is read and how a submission
    // is judged — looked up by the *stored* call's name, so the client cannot pick the
    // reading. An unregistered name is the same 409 as a stale question. A `commit` spec
    // (ila_make_plan) writes something as part of the answer; a `resolve` spec (ask_user,
    // quiz) only renders it.
    const spec = SUSPENDING_TOOLS[pending.call.name];
    const submission: AnswerToolCallInput = { ...body, action, toolCallId };
    const commitCtx = { db, userId, session, workspace };
    const resolved = spec?.resolve
      ? spec.resolve(pending.call, submission, commitCtx)
      : spec?.commit?.(pending.call, submission, commitCtx);
    if (!resolved) {
      return reply.code(409).send(
        apiError("QUESTION_NOT_PENDING", "that tool call does not hold a question set")
      );
    }
    if (!resolved.ok) {
      return reply.code(400).send(apiError("INVALID_ANSWER", resolved.reason));
    }

    // Two copies of one answer, for two readers. `output` is what the model replays as the
    // tool result; `answer` is what the card renders, so the UI never parses prose.
    const status = action === "cancel" ? "dismissed" : "answered";
    const message = db.getMessageForUser(pending.messageId, userId);
    db.updateMessageToolCalls(
      pending.messageId,
      (message?.toolCalls ?? []).map((tc) =>
        tc.id === toolCallId
          ? { ...tc, status, answer: resolved.answer, output: resolved.output }
          : tc
      )
    );

    // The quiz panel's rows follow the call: a submission answers its pending rows with the
    // validated per-question answers; a cancel dismisses them. A legacy uid-less call has
    // no rows, so both are no-ops there.
    if (pending.call.name === QUIZ_TOOL_NAME) {
      if (action === "cancel") {
        dismissQuizQuestions(db, id, toolCallId);
      } else {
        recordQuizAnswers(
          db,
          id,
          toolCallId,
          (resolved.answer ?? {}) as QuizAnswers
        );
      }
    }

    await streamResumedTurn({
      request,
      reply,
      userId,
      session,
      workspace,
      // The plan fork created another conversation and committed V1 into it; tell the client
      // to switch before the (short) resumed turn in THIS conversation streams its reply.
      before: (sse) => {
        if (resolved.navigateToSessionId) {
          sse.send({ type: "plan_session_created", sessionId: resolved.navigateToSessionId });
        }
      },
    });
  });

  /**
   * Record a make-up the learner answered **in the card that asked the question**.
   *
   * The client's door to the mechanism `ila_makeup_quiz` opens from the other side. A make-up
   * cannot be a turn of its own — there is no pending call to answer, and the grading has to start
   * from the newest position in the conversation — so the answers are recorded twice over: on the
   * rows (which is what the panel reads) and on a **completed** make-up call written just before
   * the grading turn, which is what the model reads as a tool result. Nothing here constructs a
   * user message, at any size.
   *
   * The card the learner actually answered is left exactly as it was and its answer is written back
   * onto it, so the reply they scrolled past stops saying "skipped" about a question they have now
   * answered.
   */
  app.post("/api/sessions/:id/quizzes/makeup", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };

    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    const { session, workspace } = found;

    // A route that starts a turn refuses while one streams — `/regenerate`'s guard, and the reason
    // `/chat` lacking it is a hole rather than a pattern.
    if (activeTurns.has(id)) {
      return reply.code(409).send(apiError("TURN_IN_PROGRESS", "a reply is still being generated"));
    }

    const body = request.body as QuizMakeupSubmitBody | undefined;
    const answers = (body?.answers ?? {}) as QuizAnswers;
    const qids = Object.keys(answers);
    if (qids.length === 0) {
      return reply.code(400).send(apiError("INVALID_ANSWER", "no question was answered"));
    }

    /*
     * The questions come from the conversation's own rows, addressed by the Qn the card displays:
     * the card names questions, it never carries them, so a stale tab cannot have its wording
     * written into the record. A card whose question has since been answered is refused rather
     * than written over.
     */
    let questions: QuizQuestion[];
    try {
      questions = makeupQuestionsByQid(db, id, qids);
    } catch (err) {
      return reply
        .code(409)
        .send(
          apiError(
            "QUIZ_NOT_ANSWERABLE",
            err instanceof Error ? err.message : "that question is not open to a make-up answer"
          )
        );
    }

    const validated = validateMakeupAnswers(questions, {
      toolCallId: "",
      action: "submit",
      answers,
    });
    if (!validated.ok) {
      return reply.code(400).send(apiError("INVALID_ANSWER", validated.reason));
    }

    const written = recordMakeupAnswers(db, userId, id, questions, validated.answers);
    if (!written.ok) {
      return reply
        .code(written.status)
        .send(apiError(written.code, written.reason ?? "the make-up answer could not be recorded"));
    }
    markMakeupOnCalls(db, id, written.applied);

    /*
     * Every question still waiting for an answer is retired, exactly as `/chat` retires it when the
     * user sends a message instead of answering.
     *
     * **This route appends to the conversation, and that is the whole reason it belongs here.**
     * A card is answerable only while it is what the conversation is waiting on; a make-up writes a
     * record *after* it, so a quiz posed in an earlier turn is now behind the reader's attention
     * and its card can never be answered in place again — `/answers` would find the call awaiting,
     * but nothing on screen offers it. Left alone, the row stays `pending`, which is not
     * make-up-eligible, so the question is invisible to the panel's make-up and unreachable in the
     * conversation: stuck between two states with no way back. Retiring it makes it `skipped`,
     * which is what it is — the learner moved on — and that is the state the panel can bring back.
     *
     * Before the record is written, like `/chat`'s, so the retirement and the new message are one
     * visible step rather than a card that flickers.
     */
    const retired = db.skipAwaitingToolCalls(id);
    skipQuizQuestions(
      db,
      id,
      retired.filter((c) => c.name === QUIZ_TOOL_NAME).map((c) => c.id)
    );

    /*
     * The record, as the call the tool would have made — same input shape, same result, so the
     * model grades from the identical sentence whichever door was used, and the conversation shows
     * the identical card. `content` is empty on purpose: a turn that only calls a tool has no text,
     * and the card is the thing to read.
     */
    const record = db.createMessage({
      id: newId(),
      sessionId: id,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: newId(),
          name: QUIZ_MAKEUP_TOOL_NAME,
          input: JSON.stringify({ questions }),
          status: "answered",
          answer: validated.answers,
          output: renderMakeupResult(questions, validated.answers, written.keys),
        },
      ],
    });

    await streamResumedTurn({
      request,
      reply,
      userId,
      session,
      workspace,
      // Emitted before the run: the record is on screen while the model grades, rather than
      // appearing under the reply it produced.
      before: (sse) => sse.send({ type: "message_added", message: record }),
    });
  });

  /**
   * Answer the last user turn again: drop the assistant reply and run the model once more.
   *
   * The shape is the `/answers` one, not `/chat`'s, and that is the whole trick. `/chat`
   * persists a user message and passes its text along to be *appended*; here the user message
   * is already in the conversation and stays exactly as it was, so the history read after the
   * delete already ends on it and `userMessage: null` is what keeps it from arriving twice.
   * Its attachments come back the same way — `buildHistoryMessages` replays every persisted
   * user message through `buildUserContent`, so the images and documents the turn originally
   * carried are rebuilt from the row rather than re-sent by the client.
   *
   * The old reply is soft-deleted *before* history is read, so the model does not see the
   * answer it is being asked to replace. It is replaced rather than duplicated, and a failure
   * leaves the ⚠️ row `failTurn` writes as the new tail — the user can retry again.
   *
   * A regenerate *does* reach the titler, and that is deliberate rather than incidental: the
   * excerpt is read from the persisted messages, so a conversation the titler has not managed to
   * name yet — because the call failed, or because the model found nothing to name in the old
   * reply — gets the new answer as evidence on the way through. A conversation that already has a
   * name is one the gate leaves alone, exactly as on any other turn.
   */
  app.post("/api/sessions/:id/regenerate", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };

    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    const { session, workspace } = found;

    if (activeTurns.has(id)) {
      return reply.code(409).send(apiError("TURN_IN_PROGRESS", "a reply is still being generated"));
    }

    const messages = db.listMessagesForUser(id, userId);
    const last = messages[messages.length - 1];
    /*
     * Three things a regenerate is not, and each is the client's own state rather than a
     * server fault: an empty conversation, a turn whose reply the user has not written yet (the
     * tail is their own message), and an assistant turn still holding an unanswered question.
     * The last one is refused because the interactive card owns that state — regenerating it
     * would throw away the question the user is in the middle of answering.
     */
    if (
      !last ||
      last.role !== "assistant" ||
      (last.toolCalls ?? []).some((tc) => tc.status === "awaiting")
    ) {
      return reply
        .code(409)
        .send(apiError("NO_REPLY_TO_REGENERATE", "there is no reply to regenerate"));
    }

    const peeled = db.raw.transaction(() => {
      const live = db.listMessagesForUser(id, userId);
      if (live.length === 0 || live[live.length - 1]!.id !== last.id) return false;
      if (!db.softDeleteMessageForUser(id, last.id, userId)) return false;
      skipQuizQuestions(
        db,
        id,
        (last.toolCalls ?? []).filter((tc) => tc.name === QUIZ_TOOL_NAME).map((tc) => tc.id)
      );
      return true;
    })();

    if (!peeled) {
      return reply
        .code(409)
        .send(apiError("NO_REPLY_TO_REGENERATE", "there is no reply to regenerate"));
    }

    await streamResumedTurn({
      request,
      reply,
      userId,
      session,
      workspace,
      // The row is already gone server-side; say so before the replacement streams, or the client
      // renders the old reply and the new one at the same time for the whole turn.
      before: (sse) => sse.send({ type: "message_removed", id: last.id }),
    });
  });

  /**
   * Stop the turn streaming for a session.
   *
   * The session is resolved `ForUser` *before* the map is consulted, so another account's id
   * is a 404 rather than an abort — without that read, `activeTurns` would be an id-guessing
   * oracle for ending a stranger's turn.
   *
   * Answers `ok: false` rather than 404 when *your* session simply has nothing running: the
   * client's Stop races the stream's own `done`, and losing that race means the stop already
   * happened. That is an outcome, not a failure.
   */
  app.post("/api/sessions/:id/stop", { config: { requiresSessionLock: true } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, actor(request).id)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }

    const turn = activeTurns.get(id);
    turn?.abort();
    return { ok: turn !== undefined };
  });
}

function isParsePolicy(value: unknown): value is DocumentParsePolicy {
  return (
    value === "local-only" ||
    value === "local-first" ||
    value === "cloud-first" ||
    value === "cloud-only"
  );
}

/** Validate + normalize one model payload. Returns undefined when it is unusable. */
function parseModelInput(
  m: ProviderModelInput
): { modelId: string; name: string; contextWindow: number | null; maxOutput: number | null; capabilities: ProviderModel["capabilities"] } | undefined {
  const modelId = m?.modelId?.trim();
  if (!modelId) return undefined;
  return {
    modelId,
    name: m.name?.trim() || modelId,
    contextWindow: m.contextWindow ?? null,
    maxOutput: m.maxOutput ?? null,
    capabilities: m.capabilities ?? ["tool_use"],
  };
}

type ProviderModel = ProviderConfig["models"][number];
