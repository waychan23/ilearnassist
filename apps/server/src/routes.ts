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
  ParseErrorCode,
  ParseStatus,
  ProviderConfig,
  ProviderModelInput,
  PublicConfig,
  QuizAnswers,
  Session,
  SessionSettings,
  Source,
  SourceOrigin,
  SourceOwner,
  SourceStorage,
  ToolCall,
  TurnRequestMeta,
  UpdateCopilotInput,
  UpdateDocumentParserInput,
  UpdateDocumentParsingInput,
  UpdateProviderInput,
  UpdateSessionInput,
  UpdateUserInput,
  UpdateWorkspaceInput,
  UploadAttachmentInput,
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
  DEFAULT_USER_ROLES,
  defaultWidgetIdsForScope,
  isEnabledSuperadmin,
  isPlatformAdmin,
  isUserRole,
  MAX_ATTACHMENT_BYTES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  EXPLORE_TOOL_NAME,
  PLAN_TOOL_NAMES,
  PLATFORM_ADMIN_ROLES,
  QUIZ_TOOL_NAME,
  QUIZ_TOOL_NAMES,
  SUPERADMIN_ROLE,
  USERNAME_MAX_LENGTH,
} from "@ilearnassist/shared";
import {
  insightReasoningSetting,
  noteSyncReasoningSetting,
  threadReasoningSetting,
  type AppConfig,
} from "./config.js";
import {
  DEFAULT_SESSION_TITLE,
  newId,
  readDocumentParsing,
  SETTING_DEFAULT_MODEL,
  SETTING_DEFAULT_PROVIDER,
  SETTING_DOCUMENT_DEFAULT_PARSER,
  SETTING_DOCUMENT_FALLBACK,
  SETTING_DOCUMENT_LOCAL_ENABLED,
  SETTING_DOCUMENT_POLICY,
  type AppDb,
  type ProviderRecord,
  type SourceRecord,
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
import { makeNoteSummarizer } from "./agent/notesSummary.js";
import { buildInsightViews, generateInsights } from "./insights.js";
import { createNote, deleteNote, updateNote } from "./notes.js";
import { readNoteSync, runNoteSync } from "./notesExport.js";
import { listDiagramViews, registerDiagram } from "./diagrams.js";
import {
  dismissQuizQuestions,
  listQuizQuestionViews,
  makeupAnswer,
  recordQuizAnswers,
  registerQuizQuestions,
  renderMakeupKeyNote,
  skipQuizQuestions,
} from "./quizzes.js";
import type { DocumentService } from "./documents/service.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { turnClock, type TurnClock } from "./agent/clock.js";
import { runAgentStream, type RunAgentResult } from "./agent/loop.js";
import { classifyProviderError } from "./agent/providerErrors.js";
import { fallbackTitle, generateTitle } from "./agent/title.js";
import { uniqueSessionTitle } from "./sessionTitles.js";
import { writeParsedText } from "./documents/store.js";
import { needsSummary, summarizeImage } from "./agent/mediaSummary.js";
import { createSseWriter } from "./stream.js";
import { buildTools } from "./tools/index.js";
import { QUIZ_QUESTION_COUNTER } from "./tools/quiz.js";
import { COLLECT_PAGE_GUIDANCE } from "./tools/collectPage.js";
import { exploreGuidance } from "./tools/explore.js";
import { PLAN_GUIDANCE } from "./tools/planTools.js";
import { QUIZ_GUIDANCE } from "./tools/quizReview.js";
import { SUSPENDING_TOOLS } from "./tools/suspending.js";
import {
  readAsDataUrl,
  sha256Of,
} from "./attachments.js";
import { apiError } from "./apiError.js";
import { classifySource } from "./sourceCategory.js";
import { isSupportedMime, normalizeMime, resolveSourceBytes, sourceRawPath } from "./sourcePaths.js";
import {
  fileOwner,
  listSourceViewsForUser,
  ownerWorkspaceRoot as ownerWorkspaceRootIn,
  reconcileFilesystem,
  reconcileListing,
  registerFileSource,
  renameSourceSubtree,
  sourcePathsFor,
  sourceBytesOf,
} from "./sources.js";
import { createDirectory, deletePath, movePath, writeFileAt } from "./fileOps.js";
import { resolveWriteLocation } from "./writeLocation.js";
import {
  normalizeWorkspaceScope,
  resolveWorkspaceScope,
  scopeIsEmpty,
  scopeQuery,
} from "./workspaceScope.js";
import { captureWebPage } from "./webCapture.js";
import { isSourceCategory, isSourceOrigin, isSourceStorage } from "@ilearnassist/shared";
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

/** Base64 inflates bytes by 4/3, and the JSON envelope adds a little more. */
const ATTACHMENT_BODY_LIMIT = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 64 * 1024;

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
  // And the note export's, the same shape a third time for the same reason.
  const noteSyncReasoning = noteSyncReasoningSetting();

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
    };
  }

  /* ------------------------------- config/health ------------------------------- */

  // Public: a liveness probe that needs a session cannot do its job, and it reports nothing
  // about the data.
  app.get("/api/health", { config: { public: true } }, async () => ({ ok: true }));

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
    const workspace = db.createWorkspace({ id: newId(), userId: user.id, name, slug, dirPath });

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
   * Directories are left alone: a directory is not a source, so a listing full of them — a
   * `node_modules` — costs the query and nothing else.
   */
  function withSourceIds(
    listing: DirectoryListing,
    userId: string,
    owner: SourceOwner,
    storage: "workspace" | "session"
  ): DirectoryListing {
    const ids = reconcileListing(db, { userId, owner, storage, entries: listing.entries });
    return {
      ...listing,
      entries: listing.entries.map((entry) => {
        const id = entry.type === "file" ? ids.get(entry.path) : undefined;
        return id ? { ...entry, sourceId: id } : entry;
      }),
    };
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
      return withSourceIds(listing, userId, { kind: "workspace", id: workspaceId }, "workspace");
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
      return await readFileContent(workspace.workdirPath, path);
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
   * rather than the file's own, which is a divergence from `/api/sources/:id/raw` — and that
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

  /** The row for a file at a path, created if nobody has one — the same rule the listing uses. */
  function sourceAt(
    workspace: Workspace,
    userId: string,
    relPath: string,
    size: number,
    origin: SourceOrigin
  ): SourceRecord {
    return (
      db.getSourceByPlace(userId, { kind: "workspace", id: workspace.id }, relPath) ??
      registerFileSource(db, {
        userId,
        owner: { kind: "workspace", id: workspace.id },
        storage: "workspace",
        relPath,
        origin,
        size,
      })
    );
  }

  /**
   * Create a directory.
   *
   * Registers nothing, because a directory is not a source — and that is stated here as well as
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
   * The cap is the attachment cap rather than something larger, deliberately: two numbers would
   * be two answers to "how big a file may I put in this app", and the message names the limit so
   * raising it is a visible change rather than a guess.
   */
  app.post(
    "/api/workspaces/:workspaceId/files/upload",
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
    async (request, reply) => {
      const target = writeTarget(request);
      if (!target) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
      const body = request.body as { dir?: string; name?: string; data?: string };

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
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        return reply.code(413).send(apiError("FILE_TOO_LARGE", "file is too large"));
      }

      const dir = (body.dir ?? "").replace(/^\.?\/+/, "").replace(/\/+$/, "");
      const relPath = dir ? `${dir}/${name}` : name;

      try {
        const written = await writeFileAt(target.workspace.workdirPath, relPath, bytes);
        const row = sourceAt(
          target.workspace,
          target.userId,
          written.rel,
          bytes.byteLength,
          "workspace_upload"
        );
        return reply.code(201).send({ ...toSource(row), missing: false });
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
      const owner = { kind: "workspace" as const, id: target.workspace.id };
      const rows = renameSourceSubtree(db, {
        userId: target.userId,
        owner,
        from: moved.from.rel,
        to: moved.to.rel,
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
   * Delete a file, or an empty directory.
   *
   * **The bytes move to `trash/`, they are not destroyed**, and the row is soft-deleted: the row
   * is what hides the file from every listing at once, and the bytes being kept is what a future
   * restore would restore. `storage: "trash"` records *where* they went, which is the one field
   * that changes about a source and the reason it is a field.
   *
   * A populated directory is refused, exactly as the agent's `delete_file` refuses it. One click
   * in a browser is not a good place to be recursively destroying work someone never saw.
   */
  app.delete("/api/workspaces/:workspaceId/files", async (request, reply) => {
    const target = writeTarget(request);
    if (!target) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    const { path } = request.query as { path?: string | string[] };
    if (typeof path !== "string" || path === "") {
      return reply.code(400).send(apiError("INVALID_FILE_PATH", "a path is required"));
    }

    try {
      // The row is resolved (or made) before the bytes move, because its id is what namespaces
      // the trash directory — two deletions from different directories must not collide.
      const owner = { kind: "workspace" as const, id: target.workspace.id };
      const size = await stat(join(target.workspace.workdirPath, path)).then(
        (info) => info.size,
        () => 0
      );
      const row =
        db.getSourceByPlace(target.userId, owner, path) ??
        registerFileSource(db, {
          userId: target.userId,
          owner,
          storage: "workspace",
          relPath: path,
          origin: "discovered",
          size,
        });

      const removed = await deletePath(
        target.workspace.workdirPath,
        workspaceTrashDir(target.workspace.dirPath),
        path,
        row.id
      );
      if (!removed.wasDirectory) {
        db.updateSourcePlace(row.id, target.userId, { storage: "trash" });
        db.softDeleteSourceForUser(row.id, target.userId);
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
  app.patch("/api/sessions/:id", async (request, reply) => {
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
  app.delete("/api/sessions/:id", async (request, reply) => {
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
  app.delete("/api/sessions/:id/messages/:messageId", async (request, reply) => {
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

  app.put("/api/sessions/:id/widgets/:widgetId", async (request, reply) => {
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

  /* ----------------------------------- stats ----------------------------------- */

  /*
   * Not under `/widgets`, deliberately: these are numbers about the object, not about a widget.
   * Two widgets already read the same two endpoints and a third will, so hanging them off one
   * widget's namespace would make the next consumer add a second path to the same query.
   */

  app.get("/api/workspaces/:id/stats", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const stats = db.statsForWorkspace(userId, id);
    if (!stats) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    return stats;
  });

  app.get("/api/sessions/:id/stats", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const stats = db.statsForSessionForUser(userId, id);
    if (!stats) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    return stats;
  });

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
  app.post("/api/sessions/:id/plan/nodes/:nodeId/jump", async (request, reply) => {
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

  /**
   * Make-up answer for one question originally skipped. JSON rather than SSE: it only
   * validates and persists; the client follows with an ordinary `/chat` message that
   * drives the model's grading, so the resumed turn streams through the same path a normal
   * message does. The row is updated in place — never duplicated.
   */
  app.post("/api/sessions/:id/quizzes/:quizId/answer", async (request, reply) => {
    const userId = actor(request).id;
    const { id, quizId } = request.params as { id: string; quizId: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    const result = makeupAnswer(db, userId, id, quizId, request.body);
    if (!result.ok) {
      return reply
        .code(result.status)
        .send(
          apiError(
            result.code,
            result.reason ??
              (result.code === "QUIZ_NOT_ANSWERABLE"
                ? "that question is not open to a make-up answer"
                : "quiz question not found")
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
        makeThreadClassifier({ provider, modelId, reasoning: threadReasoning }),
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

  app.post("/api/sessions/:id/notes", async (request, reply) => {
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

  app.patch("/api/sessions/:id/notes/:noteId", async (request, reply) => {
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

  app.delete("/api/sessions/:id/notes/:noteId", async (request, reply) => {
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

  /* ----------------------------- notes → the library ----------------------------- */

  /*
   * Exporting this conversation's notes into the source library, object-not-widget like the
   * notes routes above: the run outlives the panel that started it, and `sync: null` is "never
   * exported" — a 200 with an empty answer rather than a missing object, because a conversation
   * nobody has exported is the ordinary state and not an error to report.
   *
   * The pair is **asynchronous on purpose**, which is where it parts company with
   * `/insights/generate`'s long POST. That pass is a single model call whose answer *is* the
   * reply; this one is a model call followed by a sweep of the filesystem, and the requirement is
   * a status the reader can watch and a button they can force. So the work outlives the reply and
   * `GET` is how the panel learns how it went.
   */
  app.get("/api/sessions/:id/notes/sync", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    // A pure read. Settling a `running` row from here would make this route a second writer on a
    // status row, and the "stuck" answer would then be visible exactly once.
    return { sync: readNoteSync(db, id) };
  });

  app.post("/api/sessions/:id/notes/sync", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const owned = db.getSessionForUser(id, userId);
    if (!owned) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }

    const body = (request.body ?? {}) as { force?: unknown };
    // Never coerced: `"false"` is truthy, and forcing a sync is a real model call plus a
    // rewrite of every exported file. The shape of the rule `PATCH /api/admin/users/:id`
    // follows for `disabled`.
    if (body.force !== undefined && typeof body.force !== "boolean") {
      return reply.code(400).send(apiError("INVALID_FIELD", "force must be a boolean"));
    }

    /*
     * The lock, and it is this write rather than a map of in-flight runs.
     *
     * better-sqlite3 is synchronous and this handler is one turn of the event loop, so the read
     * and the write below cannot interleave with another request's: of two concurrent starts,
     * one sees `running` and is refused and the other proceeds. A `Map` could not survive the
     * process restart this guard exists for — a run whose server was killed mid-flight leaves
     * the row `running`, which `stuck` reports and a later press recovers.
     */
    const current = readNoteSync(db, id);
    if (current?.status === "running" && !current.stuck && body.force !== true) {
      return reply
        .code(409)
        .send(apiError("SYNC_IN_PROGRESS", "this conversation is already being exported"));
    }

    db.saveNoteSyncState({ sessionId: id, status: "running", startedAt: new Date().toISOString() });

    const provider = db.getProvider(resolveProviderId(undefined, owned.session.settings));
    const modelId = resolveModelId(provider, undefined, owned.session.settings);

    // Deliberately not awaited: the reply is the state the panel polls, and the work continues
    // after it. `runNoteSync` never rejects — its own catch settles `failed` — and the net here
    // covers the case where even that write failed, since an unhandled rejection would take the
    // process down. A missing provider is not an HTTP error either: it settles as `failed`,
    // which is a fact about the call rather than a refusal of the request.
    void runNoteSync({
      db,
      userId,
      sessionId: id,
      sessionDir: sessionDir(owned.workspace.dirPath, id),
      sessionTitle: owned.session.title,
      summarize: makeNoteSummarizer({ provider, modelId, reasoning: noteSyncReasoning }),
      model: modelId,
    }).catch(() => undefined);

    return reply.code(202).send({ sync: readNoteSync(db, id) });
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
  app.post("/api/sessions/:id/insights/generate", async (request, reply) => {
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
      makeInsightGenerator({ provider, modelId, reasoning: insightReasoning }),
      modelId
    );
  });

  app.patch("/api/sessions/:id/insights/:insightId", async (request, reply) => {
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

  app.delete("/api/sessions/:id/insights/:insightId", async (request, reply) => {
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
      return withSourceIds(listing, userId, { kind: "session", id: found.session.id }, "session");
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
   * Where the bytes are **does** travel now, as `storage` + `relPath`, and that is not a leak:
   * it is the path inside a sandbox the client can already browse, it is what a tree view of
   * the browser is drawn from, and it is not enough to reach a file with — the request still
   * has to pass a route, which resolves it through the guard again.
   */
  function toSource(record: SourceRecord): Source {
    const { userId, ...source } = record;
    return source;
  }

  /**
   * A source as one message's attachment: the same facts, under the name that upload used.
   *
   * The name is the only difference, and it is deliberate rather than redundant. A source
   * keeps the first name it was uploaded under — that is what dedupe means — so without this
   * a second upload of the same bytes would show someone else's filename on its chip.
   *
   * Spread-with-omit rather than a field list, so a field added to `Attachment` later travels
   * here without anyone having to remember this function. `createdAt` is left out because it
   * is a fact about the source, not about the message that referenced it.
   */
  function toAttachment(record: SourceRecord, name: string): Attachment {
    const { createdAt, ...rest } = toSource(record);
    return { ...rest, name };
  }

  /**
   * A source's bytes, validated, or undefined.
   *
   * Every read of a source's contents goes through here — the preview and the raw download —
   * so "where is this file" is asked once. The answer itself is `sources.ts`'s: it resolves the
   * row's owner, picks the root the row's storage names, and checks the path against it.
   */
  function sourcePath(user: User, source: SourceRecord): string | undefined {
    return sourceBytesOf(db, treeFor(user), user.id, source);
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
    "/api/sessions/:id/sources",
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
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
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        const limitMb = Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024);
        return reply
          .code(413)
          .send(
            apiError("FILE_TOO_LARGE", `File is larger than the ${limitMb} MB limit`, { limitMb })
          );
      }

      /*
       * Three cases, and the middle one is the soft delete's.
       *
       * `UNIQUE (user_id, sha256)` makes identical bytes one row for the account, so a file the
       * user deleted cannot be re-uploaded as a second row — the insert would be refused. It is
       * *revived* instead: the row never lost its bytes, its parse state or its links, so
       * bringing it back restores the file everywhere it was used, and the re-upload costs
       * nothing but a marker.
       */
      const hash = sha256Of(bytes);
      const existing = db.findSourceByHash(userId, hash);
      let source = existing;
      let started = false;

      if (!source) {
        const deleted = db.findDeletedSourceByHash(userId, hash);
        if (deleted) {
          // A parse cancelled mid-flight left the row saying `pending` forever, because the run
          // that would have written an outcome is the one that was stopped. Re-queue it; a row
          // that already finished keeps its verdict.
          const stuck = deleted.parseStatus === "pending" || deleted.parseStatus === "parsing";
          source = db.reviveSourceForUser(deleted.id, userId) ?? deleted;
          if (stuck && documents.handles(source)) {
            started = true;
            void documents.schedule(tree, userId, source, session.workspace.dirPath).catch((err: unknown) => {
              request.log.error(err, "failed to schedule document parsing");
            });
          }
        }
      }

      if (!source) {
        const sourceId = newId();
        // Both inputs to the path are server-side — an id we just made and a MIME type from
        // the table — so nothing the client sent can steer the write out of this user's
        // `sources/raw/`. Same reasoning as `resolveInWorkspace`, applied at the write.
        const rawPath = sourceRawPath(tree, sourceId, mimeType);
        try {
          await writeFile(rawPath, bytes);
        } catch (err) {
          request.log.error(err, "failed to store source bytes");
          return reply.code(500).send(apiError("SOURCE_STORE_FAILED", "failed to store the file"));
        }

        source = db.createSource({
          id: sourceId,
          userId,
          // An upload is held by the conversation it arrived in, and *shared with the
          // workspace* by the link written below — two different facts, which is why the link
          // tables still exist beside this column.
          ownerKind: "session",
          ownerId: id,
          origin: "session_attachment",
          storage: "upload",
          // No stored path: the filename is `<id>.<ext>`, derived from the id and the MIME
          // type, so the row would be a second copy of an answer it already has.
          relPath: null,
          name,
          mimeType,
          category: classifySource(name, mimeType).category,
          size: bytes.byteLength,
          url: null,
          summary: null,
          sha256: hash,
        });
        started = true;

        // Extraction runs *after* the response: a cloud parse can take minutes and the
        // composer must not hold the upload open for it. `schedule` writes `pending`
        // synchronously, so the status a poll reads next is never a gap.
        if (documents.handles(source)) {
          void documents.schedule(tree, userId, source, session.workspace.dirPath).catch((err: unknown) => {
            request.log.error(err, "failed to schedule document parsing");
          });
        }
      }

      db.linkSourceToSession(userId, id, source.id);
      db.linkSourceToWorkspace(userId, session.workspace.id, source.id);

      /*
       * A source this request started parsing reports `pending` rather than being re-read.
       * Re-reading would race the work it just queued — a small local PDF can be `ready` before
       * this line runs, and a status that races the parse is not a status. The client polls
       * `/sessions/:id/sources` for the outcome, so what it needs from the upload is a stable
       * "we started", which is what it gets.
       *
       * A source nothing was started for reports what it already has: its parse may be
       * finished, or gone stale, or never have been needed. That is the reused case and the
       * revived-and-already-parsed one alike.
       */
      const reported =
        started && documents.handles(source)
          ? { ...source, parseStatus: "pending" as ParseStatus }
          : source;
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
  app.get("/api/sessions/:id/sources", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    // The grant is part of the whitelist, so it is part of this answer — the docblock above is
    // the reason, and the cost is real: this route is polled while something is parsing, and an
    // `@所有工作区` grant makes it an account-wide read. It is paid only while a parse is in
    // flight, and the alternative is the model and the chips disagreeing.
    const scope = scopeQuery(resolveWorkspaceScope(db, userId, found.session));
    return db.listReadableSources(userId, id, found.workspace.id, scope).map(toSource);
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
  app.get("/api/sources", async (request, reply) => {
    const user = actor(request);
    const query = request.query as Record<string, string | string[] | undefined>;

    const one = (key: string): string | undefined => {
      const value = query[key];
      if (value === undefined) return undefined;
      // `?storage=a&storage=b` arrives as an array, and a filter holding two values is a
      // request this route does not answer — refusing beats picking the first silently.
      if (typeof value !== "string" || value === "") {
        return reply.send(apiError("INVALID_FIELD", `${key} must be a single value`)) as never;
      }
      return value;
    };

    const storage = one("storage");
    if (storage !== undefined && !isSourceStorage(storage)) {
      return reply.code(400).send(apiError("INVALID_FIELD", "unknown storage"));
    }
    const category = one("category");
    if (category !== undefined && !isSourceCategory(category)) {
      return reply.code(400).send(apiError("INVALID_FIELD", "unknown category"));
    }
    const origin = one("origin");
    if (origin !== undefined && !isSourceOrigin(origin)) {
      return reply.code(400).send(apiError("INVALID_FIELD", "unknown origin"));
    }

    const filter = {
      storage,
      category,
      origin,
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

    const sources = await listSourceViewsForUser(db, treeFor(user), user.id, filter);
    return sources.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(toSource);
  });

  /**
   * One source, by id.
   *
   * The read a caller makes when it has an id and needs the row *now*: the composer polls it
   * while a source the user just referenced is being parsed, and something that is not in the
   * conversation's list yet — a reference before the turn that links it — has no other way to
   * be asked about. `missing` is computed here as it is in the list, so the two agree.
   */
  app.get("/api/sources/:id", async (request, reply) => {
    const user = actor(request);
    const { id: sourceId } = request.params as { id: string };
    const source = db.getSourceForUser(sourceId, user.id);
    if (!source) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    const path = sourceBytesOf(db, treeFor(user), user.id, source);
    const present = path
      ? await stat(path).then(
          (info) => info.isFile(),
          () => false
        )
      : false;
    return toSource({ ...source, missing: !present });
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
  app.get("/api/sources/:id/preview", async (request, reply) => {
    const user = actor(request);
    const { id: sourceId } = request.params as { id: string };
    const source = db.getSourceForUser(sourceId, user.id);
    if (!source) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    const path = sourcePath(user, source);
    if (!path) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    try {
      // The *stored* name, not the path's: the name is the only part of the two that the user
      // ever chose, and a source deduped onto an earlier upload would otherwise show a uuid.
      const content = await readPreviewFile(path, source.name);
      /*
       * …and the page it came from, when it is one. Carried here rather than fetched by the
       * client, because this route is the only one that knows *both* the bytes and the row: a
       * client holding the preview would otherwise need a second request to learn whether there is
       * somewhere to go, and the dialog's "open in browser" control is gated on exactly that.
       */
      return { ...content, url: source.url ?? undefined };
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  /** Serve a source's bytes back, for a thumbnail or a download. */
  app.get("/api/sources/:id/raw", async (request, reply) => {
    const user = actor(request);
    const { id: sourceId } = request.params as { id: string };
    const source = db.getSourceForUser(sourceId, user.id);
    if (!source) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    // From the row, and validated again before the read: the resolver is what keeps a path
    // that travelled through a backup — or through a future bug — from being a read of
    // whatever it happens to name.
    const path = sourcePath(user, source);
    if (!path) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    try {
      const bytes = await readFile(path);
      return reply
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .type(source.mimeType)
        .send(bytes);
    } catch {
      return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));
    }
  });

  /**
   * Add a web page as a source, by pasting its URL.
   *
   * The user's half of `ila_collect_page`, and the reason it exists is the requirement's own
   * list of what a source can be: "a web link, or an uploaded file, added to a workspace from
   * outside a conversation". The browser offered only the file.
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
  app.post("/api/sources/pages", async (request, reply) => {
    const user = actor(request);
    const body = request.body as { url?: string; workspaceId?: string; summary?: string };

    const url = body?.url?.trim();
    if (!url) return reply.code(400).send(apiError("DATA_REQUIRED", "a URL is required"));

    const workspaceId = body?.workspaceId;
    const workspace = workspaceId ? db.getWorkspaceForUser(workspaceId, user.id) : undefined;
    if (!workspace) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    try {
      const source = await captureWebPage(db, {
        user: treeFor(user),
        userId: user.id,
        owner: { kind: "workspace", id: workspace.id },
        workspaceId: workspace.id,
        url,
        // A link somebody pasted has no summary: a summary is a reading of a page by something
        // that understood it, and nothing has read this one yet.
        summary: body?.summary?.trim() || undefined,
      });
      return reply.code(201).send(toSource(source));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return reply.code(400).send(apiError("PAGE_FETCH_FAILED", detail, { detail }));
    }
  });

  /** Re-run extraction, e.g. after a failure or a change of parser settings. */
  app.post("/api/sources/:id/reparse", async (request, reply) => {
    const user = actor(request);
    const { id: sourceId } = request.params as { id: string };
    const source = db.getSourceForUser(sourceId, user.id);
    if (!source) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    try {
      // The parse reads the bytes through the same resolver every read does, so it needs the
      // workspace the row's owner lives in. A blob needs none — see `sourcePath`.
      await documents.reparse(
        treeFor(user),
        user.id,
        source,
        ownerWorkspaceRootIn(db, user.id, source) ?? ""
      );
    } catch (err) {
      return reply.code(400).send(parseApiError(err));
    }
    return reply.code(202).send({ status: "pending" });
  });

  /**
   * Soft delete a file everywhere it is used.
   *
   * The row keeps its bytes, its extracted text and every link; it stops being listed, stops
   * being offered to the model, and starts 404ing on `/raw`. Because the links survive,
   * re-uploading the same content brings the file back *with* its history — see the upload
   * route, which revives this row rather than inserting beside it.
   *
   * The `messages.attachments` snapshots were always kept: a message sent with a PDF keeps
   * showing what was sent, rather than the chip vanishing from history it was part of.
   *
   * An in-flight parse is still cancelled — not to protect the bytes, which are staying, but so
   * a parse that can never be read does not keep running against a file the user has put away.
   */
  app.delete("/api/sources/:id", async (request, reply) => {
    const user = actor(request);
    const { id: sourceId } = request.params as { id: string };
    const source = db.getSourceForUser(sourceId, user.id);
    if (!source) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    documents.cancelSource(source.id);
    db.softDeleteSourceForUser(source.id, user.id);
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
   * Best-effort conversation naming.
   *
   * A model-written title is preferred, but a failure must never leave the conversation
   * showing the create-time placeholder — the whole point is that a first turn produces
   * a usable name. So any throw degrades to a title derived from the user's own words,
   * and only a total absence of text leaves the placeholder in place.
   */
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
      const source = db.getSourceForUser(attachment.id, input.userId);
      if (!source || !needsSummary(source)) continue;

      const path = sourceBytesOf(db, input.user, input.userId, source);
      if (!path) continue;

      try {
        const dataUrl = await readAsDataUrl(path, source.mimeType);
        const summary = await summarizeImage({
          provider: input.provider,
          modelId: input.modelId,
          dataUrl,
          sample: input.sample,
        });
        if (!summary) continue;

        // Both halves, in one place: the column the browser reads, and the text file the
        // *model* reads on every later turn. A summary in the column alone would leave the
        // image unreadable in the prompt, which is the whole thing this pass is for.
        db.updateSourcePlace(source.id, input.userId, { summary });
        await writeParsedText(input.user, source.id, summary);
      } catch (err) {
        app.log.warn(
          { err: err instanceof Error ? err.message : String(err), sourceId: source.id },
          "image summary failed"
        );
      }
    }
  }

  async function autoTitle(input: {
    provider: ProviderRecord | undefined;
    modelId: string;
    userMessage: string;
    assistantMessage: string;
  }): Promise<string | undefined> {
    try {
      return await generateTitle(input);
    } catch (err) {
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auto-title fell back to the user's own words"
      );
      return fallbackTitle(input.userMessage, input.assistantMessage) || undefined;
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
    modelId: string
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
      makeThreadClassifier({ provider, modelId, reasoning: threadReasoning }),
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
    // turn can express one — see `docs/sources.md`.
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
    const sources = db.listReadableSources(
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
        // The row is written after the bytes, and it is the *same* function the file manager
        // and the reconciler call — so a file the agent wrote and a file the user moved end up
        // as rows nothing can tell apart, which is the point of the registry.
        register: ({ location, relPath, size }) => {
          registerFileSource(db, {
            userId: input.userId,
            owner: fileOwner(location, { workspaceId: workspace.id, sessionId: session.id }),
            storage: location,
            relPath,
            origin: location === "workspace" ? "agent_workspace" : "agent_session",
            size,
          });
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
        sources: sources.map((s) => ({ id: s.id, name: s.name, mimeType: s.mimeType })),
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
          db.transaction(() => {
            registerDiagram(db, session.id, saved);
            registerFileSource(db, {
              userId: input.userId,
              owner: { kind: "session", id: session.id },
              storage: "session",
              relPath: saved.name,
              origin: "agent_session",
              size: saved.size,
              name: saved.name,
              summary: saved.summary,
            });
          });
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
        ? PLAN_GUIDANCE
        : undefined,
      /*
       * Still gated on the install, and the difference from the line above is the mode: the quiz
       * tools are `required`, so they bypass the allow-list and the widget install *is* the whole
       * question. Asking the array here would answer yes whenever the widget is installed and
       * no otherwise, which is the same answer by a longer route.
       */
      quizGuidance: quizInstalled ? QUIZ_GUIDANCE : undefined,
      /*
       * Read off the assembled set rather than off the config, and that is the whole of the
       * condition: a Copilot whose allow-list excludes `ila_collect_page` gets no guidance for a
       * call it cannot make, while the `webFetch.enabled` switch is already expressed by the
       * context above having been passed at all. Asking the array is the one form of the
       * question that cannot disagree with the answer.
       */
      collectPageGuidance: tools.some((t) => t.name === "ila_collect_page")
        ? COLLECT_PAGE_GUIDANCE
        : undefined,
      // The same form of the question as the line above: a Copilot whose allow-list excludes
      // `ila_explore` gets no guidance for a call it cannot make, while the grant itself is
      // already expressed by `scopeIsEmpty` at assembly.
      exploreGuidance: tools.some((t) => t.name === EXPLORE_TOOL_NAME)
        ? exploreGuidance(scope)
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
   * `message_done`, the conversation title when this was the first turn, and `done`.
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
      historyLength: number;
      userMessage: string | null;
      /** Whose tree the image bytes live in, for the summary pass below. */
      user: UserLayout;
      /** What this turn sent, so the images among them can be described — see below. */
      attachments?: readonly Attachment[];
    }
  ): Promise<void> {
    const assistantMessage = db.createMessage({
      id: newId(),
      sessionId: id,
      role: "assistant",
      content: result.content,
      reasoning: result.reasoning || undefined,
      toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      usage: Object.keys(result.usage).length > 0 ? result.usage : undefined,
      stopped: result.stopped,
    });
    db.touchSession(id);

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
    });

    // Name the conversation from its first exchange, unless the user already typed a
    // title (which flips `titleSource` to `user`) or this isn't the first turn. A resume
    // has no user message to name it from, and is never the first turn anyway. A turn
    // stopped before any text arrived has nothing to name it after either.
    const isFirstTurn = opts.historyLength === 0;
    if (
      isFirstTurn &&
      session.titleSource !== "user" &&
      opts.userMessage !== null &&
      result.content.trim()
    ) {
      const title = await autoTitle({
        provider: ctx.provider,
        modelId: ctx.modelId,
        userMessage: opts.userMessage,
        assistantMessage: result.content,
      });
      if (title) {
        /*
         * Numbered against its siblings, itself excluded — the titler is guessing at a name and
         * has no idea what else is in the list, so two conversations that open the same way
         * would otherwise both be called `什么是递归`. The number is what the SSE event
         * carries, so the sidebar shows the same string the database now holds.
         */
        const unique = uniqueTitleIn(session.workspaceId, userId, title, id);
        db.setAutoTitleForUser(id, userId, unique);
        sse.send({ type: "title", sessionId: id, title: unique });
      }
    }

    // Topic classification runs after every finished turn while the widget is installed —
    // not awaited, so it never delays `done`, and swallowed internally on failure.
    triggerThreadSync(userId, id, ctx.provider, ctx.modelId);
  }

  /** Report a failed turn and keep history well-formed. */
  function failTurn(id: string, err: unknown, sse: ReturnType<typeof createSseWriter>): void {
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
    });
  }

  app.post("/api/sessions/:id/chat", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const body = request.body as ChatInput;

    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    const { session, workspace } = found;

    const message = body?.message?.trim();
    const attachments = body?.attachments ?? [];
    if (!message && attachments.length === 0) {
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
        .listReadableSources(
          userId,
          id,
          workspace.id,
          scopeQuery(resolveWorkspaceScope(db, userId, session))
        )
        .map((s) => [s.id, s])
    );
    const storedAttachments = attachments
      .map((a) => (readable.has(a.id) ? toAttachment(readable.get(a.id)!, a.name) : undefined))
      .filter((a): a is Attachment => a !== undefined);

    /*
     * The sources this turn *referenced*, which is a different rule from the attachments above.
     *
     * An attachment must already be readable — it was uploaded into this conversation or its
     * workspace, and a stale client naming anything else is a client to refuse. A reference is
     * the user pointing at their own material, wherever it is: a file in another workspace, a
     * page the agent kept last week. That widens what the model may read, so it is done by
     * **linking** the source to this conversation rather than by handing the turn a private
     * copy: the link is what makes `read_document` able to page through it on the next turn
     * too, and it is the same `session_sources` row an upload writes.
     *
     * `getSourceForUser` is the owner check, so an id belonging to somebody else resolves to
     * nothing rather than being refused — the same "not yours and does not exist answer alike"
     * rule the rest of the routes follow, and here it means a reference simply does not arrive.
     */
    const referenced = (body?.sources ?? [])
      .map((ref) => db.getSourceForUser(ref.id, userId))
      .filter((source): source is SourceRecord => source !== undefined);

    const storedSources = referenced
      .map((source) => {
        db.linkSourceToSession(userId, id, source.id);
        const name = (body?.sources ?? []).find((ref) => ref.id === source.id)?.name ?? source.name;
        return toAttachment(source, name);
      })
      .filter((a): a is Attachment => a !== undefined);

    /*
     * The quiz widget's make-up flow follows this same /chat turn with the row it just
     * answered. The answer key lives server-side and never enters the visible message:
     * when the row exists, is owned here and is answered, its key (if one was given) is
     * appended to THIS turn's system prompt only. A missing id or a non-answered row is a
     * stale client rather than a turn to grade loosely.
     */
    let quizMakeupNote: string | undefined;
    const makeupQuizId = typeof body?.makeupQuizId === "string" ? body.makeupQuizId : undefined;
    if (makeupQuizId !== undefined) {
      const makeupRow = db.getQuizQuestionForUser(userId, id, makeupQuizId);
      if (!makeupRow) {
        return reply
          .code(404)
          .send(apiError("QUIZ_QUESTION_NOT_FOUND", "quiz question not found"));
      }
      if (makeupRow.status !== "answered") {
        return reply
          .code(409)
          .send(
            apiError(
              "QUIZ_NOT_ANSWERABLE",
              "that question is not open to a make-up answer"
            )
          );
      }
      quizMakeupNote = renderMakeupKeyNote(makeupRow) ?? undefined;
    }

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
      timezone: body.timezone,
    });

    // Read history *before* persisting the new user turn, so it isn't replayed twice.
    const history = db.listMessagesForUser(id, userId);

    const userMessage = db.createMessage({
      id: newId(),
      sessionId: id,
      role: "user",
      content: message,
      attachments: storedAttachments.length > 0 ? storedAttachments : undefined,
      sources: storedSources.length > 0 ? storedSources : undefined,
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
        // To the model, a referenced source and an attachment are the same thing: material
        // this turn is about. They are two columns on the message so the chips can say which
        // is which, and one array here because the prompt has no use for the difference.
        attachments: [...storedAttachments, ...storedSources],
        sourcePaths: sourcePathsFor(db, treeFor(actor(request)), userId, history, [
          ...storedAttachments,
          ...storedSources,
        ]),
        tools: ctx.tools,
        sessionDirPath: ctx.sessionDirPath,
        writeLocation: ctx.writeLocation,
        planGuidance: ctx.planGuidance,
        quizGuidance: ctx.quizGuidance,
        collectPageGuidance: ctx.collectPageGuidance,
        exploreGuidance: ctx.exploreGuidance,
        onToolUsed: ctx.onToolUsed,
        clock: ctx.clock,
        quizMakeupNote,
        signal: turn.signal,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, userId, session, ctx, result, sse, {
        historyLength: history.length,
        userMessage: message,
        user: treeFor(actor(request)),
        // The attachments *and* the references: both were sent as material, and an image the
        // user pointed at with `@` deserves a description as much as one they dragged in.
        attachments: [...storedAttachments, ...storedSources],
      });
    } catch (err) {
      failTurn(id, err, sse);
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
  app.post("/api/sessions/:id/answers", async (request, reply) => {
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

    const ctx = turnContext(session, workspace, {
      userId,
      user: treeFor(actor(request)),
      timezone: body.timezone,
    });

    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });

    // The plan fork created another conversation and committed V1 into it; tell the client
    // to switch before the (short) resumed turn in THIS conversation streams its reply.
    if (resolved.navigateToSessionId) {
      sse.send({ type: "plan_session_created", sessionId: resolved.navigateToSessionId });
    }

    const turn = beginTurn(request, id);

    try {
      // Read history *after* the answer was written, so the resumed run sees it.
      const history = db.listMessagesForUser(id, userId);
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
        // not derivable from their ids — see `sourcePathsFor`.
        sourcePaths: sourcePathsFor(db, treeFor(actor(request)), userId, history, []),
        tools: ctx.tools,
        sessionDirPath: ctx.sessionDirPath,
        writeLocation: ctx.writeLocation,
        planGuidance: ctx.planGuidance,
        quizGuidance: ctx.quizGuidance,
        collectPageGuidance: ctx.collectPageGuidance,
        exploreGuidance: ctx.exploreGuidance,
        onToolUsed: ctx.onToolUsed,
        clock: ctx.clock,
        signal: turn.signal,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, userId, session, ctx, result, sse, {
        historyLength: history.length,
        userMessage: null,
        user: treeFor(actor(request)),
      });
    } catch (err) {
      failTurn(id, err, sse);
    } finally {
      turn.finish();
      sse.send({ type: "done" });
      sse.end();
    }
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
   * No title: a regenerate is never a first turn (`history` holds at least the user message,
   * so `finishTurn`'s `historyLength === 0` test is false), and the conversation already has
   * whatever name it earned.
   */
  app.post("/api/sessions/:id/regenerate", async (request, reply) => {
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

    const ctx = turnContext(session, workspace, {
      userId,
      user: treeFor(actor(request)),
      // A regenerate is a turn like any other and gets the clock like any other: the client
      // posts a body for this one field alone.
      timezone: (request.body as TurnRequestMeta | undefined)?.timezone,
    });

    // After the delete: the reply being replaced is not part of what the model is shown.
    const history = db.listMessagesForUser(id, userId);

    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });
    // The row is already gone server-side; say so before the replacement streams, or the
    // client renders the old reply and the new one at the same time for the whole turn.
    sse.send({ type: "message_removed", id: last.id });

    const turn = beginTurn(request, id);

    try {
      const result = await runAgentStream({
        provider: ctx.provider,
        modelId: ctx.modelId,
        workspace,
        systemPrompt: session.systemPrompt,
        settings: session.settings,
        user: treeFor(actor(request)),
        sessionId: id,
        vision: ctx.vision,
        toolUse: ctx.toolUse,
        history,
        userMessage: null,
        // No turn of its own, but the history it replays may reference files whose paths are
        // not derivable from their ids — see `sourcePathsFor`.
        sourcePaths: sourcePathsFor(db, treeFor(actor(request)), userId, history, []),
        tools: ctx.tools,
        sessionDirPath: ctx.sessionDirPath,
        writeLocation: ctx.writeLocation,
        planGuidance: ctx.planGuidance,
        quizGuidance: ctx.quizGuidance,
        collectPageGuidance: ctx.collectPageGuidance,
        exploreGuidance: ctx.exploreGuidance,
        onToolUsed: ctx.onToolUsed,
        clock: ctx.clock,
        signal: turn.signal,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, userId, session, ctx, result, sse, {
        historyLength: history.length,
        userMessage: null,
        user: treeFor(actor(request)),
      });
    } catch (err) {
      failTurn(id, err, sse);
    } finally {
      turn.finish();
      sse.send({ type: "done" });
      sse.end();
    }
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
  app.post("/api/sessions/:id/stop", async (request, reply) => {
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
