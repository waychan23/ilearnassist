import type { FastifyInstance, FastifyRequest } from "fastify";
import { mkdirSync, rmSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import type {
  AnswerToolCallInput,
  ApiErrorBody,
  ApiErrorCode,
  AskUserQuestion,
  Attachment,
  ChatInput,
  ChatStreamEvent,
  CreateCopilotInput,
  CreateDocumentParserInput,
  CreateProviderInput,
  CreateSessionInput,
  CreateWorkspaceInput,
  DocumentParsePolicy,
  DocumentParserConfig,
  ParseErrorCode,
  ParseStatus,
  ProviderConfig,
  ProviderModelInput,
  PublicConfig,
  Session,
  SessionSettings,
  Source,
  ToolCall,
  UpdateCopilotInput,
  UpdateDocumentParserInput,
  UpdateDocumentParsingInput,
  UpdateProviderInput,
  UpdateSessionInput,
  UpdateWorkspaceInput,
  UploadAttachmentInput,
  User,
  Workspace,
} from "@ilearnassist/shared";
import { MAX_ATTACHMENT_BYTES } from "@ilearnassist/shared";
import type { AppConfig } from "./config.js";
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
import type { DocumentService } from "./documents/service.js";
import { removeParsedText } from "./documents/store.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { runAgentStream, type RunAgentResult } from "./agent/loop.js";
import { classifyProviderError } from "./agent/providerErrors.js";
import { fallbackTitle, generateTitle } from "./agent/title.js";
import { createSseWriter } from "./stream.js";
import { buildTools } from "./tools/index.js";
import { renderAskUserResult, validateAnswers } from "./tools/askUser.js";
import {
  isSupportedMime,
  kindFor,
  normalizeMime,
  resolveInSources,
  sha256Of,
  sourceRawPath,
} from "./attachments.js";
import {
  MAX_USERNAME_LENGTH,
  authSecret,
  clearedSessionCookie,
  currentUser,
  ensureUser,
  sessionCookie,
} from "./auth.js";
import { sessionDir, userLayout, type DataLayout, type UserLayout } from "./paths.js";
import { createWorkspaceDir, removeWorkspaceDir, uniqueSlug } from "./workspace.js";
import { FileAccessError, listDirectory, readFileContent } from "./files.js";

/**
 * The signed-in account, put on the request by the gate below.
 *
 * Optional because the gate lets the public routes through without setting it; see `actor()`
 * for how a route gets it safely.
 */
declare module "fastify" {
  interface FastifyRequest {
    user?: User;
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

/**
 * The error envelope for a curated reply.
 *
 * `code` is what the client renders — it owns the wording, in the user's language. The
 * English `message` rides along as the fallback for a client that does not know the code
 * yet, and `params` carries anything the client needs to interpolate so it never has to
 * receive a pre-built sentence. See `ApiErrorBody` in `packages/shared`.
 */
function apiError(
  code: ApiErrorCode | ParseErrorCode,
  message: string,
  params?: Record<string, string | number>
): ApiErrorBody {
  return { error: params ? { code, message, params } : { code, message } };
}

/** The parse-failure envelope: the code is the taxonomy value, the sentence a fallback. */
function parseApiError(err: unknown): ApiErrorBody {
  const detail = parseErrorDetail(err);
  return apiError(parseErrorCodeOf(err), describeParseError(err), detail ? { detail } : undefined);
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
function fileErrorReply(err: unknown): { status: 400 | 404; body: ApiErrorBody } {
  if (err instanceof FileAccessError) {
    // Only "there is nothing there" is a 404. Everything else — an escaping path, a
    // directory asked for as a file — is a bad request, and saying 404 would send the
    // client looking for a file that was never the problem.
    return {
      status: err.code === "FILE_NOT_FOUND" ? 404 : 400,
      body: apiError(err.code, err.message),
    };
  }
  throw err;
}

export default async function routes(app: FastifyInstance, opts: RoutesOptions): Promise<void> {
  const { config, db, documents, layout } = opts;

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
   * The signing secret, read per request rather than captured once.
   *
   * One indexed read of a local `app_settings` row, against a property worth having: deleting
   * that row — or replacing its value — invalidates every cookie *immediately* rather than
   * from the next restart. "Sign everyone out" is the lever you reach for when something has
   * gone wrong, and a lever that needs a restart is the wrong shape for that moment.
   */
  const requireSecret = (): string => authSecret(db);

  /**
   * The signed-in account, for a route the gate has already let through.
   *
   * Throws instead of returning undefined. The gate sets this on every route that is not
   * marked `public`, so a miss means a route ended up on the wrong side of that flag — and
   * failing here says so, where `undefined.id` a few lines later would say something much
   * less useful.
   */
  function actor(request: FastifyRequest): User {
    if (!request.user) throw new Error("No signed-in user on this route; is it marked public?");
    return request.user;
  }

  /** The acting user's tree: where its workspaces are created, and deleted from. */
  const treeFor = (user: User): UserLayout => userLayout(layout, user.slug);

  /**
   * The gate: every route needs a signed-in account unless it opts out.
   *
   * Deny by default rather than a list of protected routes, so a route added tomorrow
   * without a thought about auth is *refused* — the same move as the `read_document`
   * whitelist, where the safe state is the one you get by doing nothing. Exactly four routes
   * opt out, each with a reason.
   *
   * This hook belongs to the `routes` plugin, so it covers the API and nothing else: the
   * built frontend served by `webApp.ts` is a sibling plugin and stays public, which is what
   * lets a browser load the login screen in the first place.
   */
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config?.public === true) return;
    const user = currentUser(request, db, requireSecret());
    if (!user) return reply.code(401).send(apiError("UNAUTHENTICATED", "sign in to continue"));
    request.user = user;
  });

  /* ----------------------------------- auth ----------------------------------- */

  /**
   * Sign in, creating the account if the name is new.
   *
   * There is no password, so this is the whole of authentication — whoever can reach the
   * address can be anyone. That is a real property of this build and not an oversight: the
   * login screen states it, and the panel's LAN switch is the control that decides who can
   * reach the address at all.
   */
  app.post("/api/auth/login", { config: { public: true } }, async (request, reply) => {
    const body = request.body as { username?: unknown } | undefined;
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    if (!username) {
      return reply.code(400).send(apiError("USERNAME_REQUIRED", "username is required"));
    }
    if (username.length > MAX_USERNAME_LENGTH) {
      return reply
        .code(400)
        .send(apiError("USERNAME_TOO_LONG", "username is too long", { max: MAX_USERNAME_LENGTH }));
    }

    const { user } = ensureUser(db, layout, username);
    reply.header("set-cookie", sessionCookie(user.id, requireSecret()));
    return user;
  });

  app.post("/api/auth/logout", { config: { public: true } }, async (_request, reply) => {
    reply.header("set-cookie", clearedSessionCookie());
    return { ok: true };
  });

  /**
   * Who the caller is, or a 401.
   *
   * Public, because a 401 here is the *answer* rather than a refusal: the cookie is HttpOnly,
   * so a cold load has no other way to ask whether anyone is signed in. The client knows that
   * and keeps this route's 401 out of the "your session expired" path — otherwise every first
   * visit would open with an error about a session that never existed.
   */
  app.get("/api/auth/me", { config: { public: true } }, async (request, reply) => {
    const user = currentUser(request, db, requireSecret());
    if (!user) return reply.code(401).send(apiError("UNAUTHENTICATED", "sign in to continue"));
    return user;
  });

  /**
   * The accounts that already exist, so a returning user can pick one instead of remembering
   * exactly what they typed.
   *
   * Public, and it does leak usernames — which the no-password design already leaks to anyone
   * who types a name and is let in. Naming them is the honest version: a bare text field with
   * nothing behind it reads as a password prompt whose field is missing.
   */
  app.get("/api/auth/users", { config: { public: true } }, async () => ({
    usernames: db.listUsers().map((u) => u.username),
  }));

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

    const slug = uniqueSlug(treeFor(user).workspacesRoot, name);
    // Creates the workspace's own directory *and* the two inside it — `workdir/` for the
    // agent to work in, `sessions/` for its conversations. One call, so neither can be
    // forgotten and a workspace is never half-made.
    const dirPath = createWorkspaceDir(treeFor(user).workspacesRoot, slug);
    const workspace = db.createWorkspace({ id: newId(), userId: user.id, name, slug, dirPath });
    return reply.code(201).send(workspace);
  });

  /**
   * Rename. The directory keeps its original slug — see `renameWorkspaceForUser` in
   * `db.ts` — so this is a display-name change and nothing on disk moves underneath a
   * running agent.
   */
  app.patch("/api/workspaces/:id", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const body = request.body as UpdateWorkspaceInput;
    if (!db.getWorkspaceForUser(id, userId)) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    const name = body?.name?.trim();
    if (!name) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));

    return db.renameWorkspaceForUser(id, userId, name);
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const user = actor(request);
    const userId = user.id;
    const { id } = request.params as { id: string };
    const workspace = db.getWorkspaceForUser(id, userId);
    if (!workspace) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    db.deleteWorkspaceForUser(id, userId);
    // The workspace's *own* directory, so `sessions/` goes with it. The guard inside
    // `removeWorkspaceDir` is written against this level — "a direct child of the
    // workspaces root" — which is why `dirPath` holds this and not the sandbox.
    removeWorkspaceDir(treeFor(user).workspacesRoot, workspace.dirPath);
    return { ok: true };
  });

  /* ------------------------------ workspace files ------------------------------ */

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
   * Write endpoints belong here beside them when they land (`POST` for a new file,
   * `PUT /api/workspaces/:id/files/content` to save one, `DELETE` on a path) — the resource
   * and its URL shape are chosen so that is an addition rather than a rename.
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
      return await listDirectory(workspace.workdirPath, path);
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
    const copilot = db.updateCopilotForUser(id, userId, {
      name: body.name?.trim() ?? existing.name,
      description: body.description ?? existing.description,
      systemPrompt: body.systemPrompt ?? existing.systemPrompt,
      // Absent leaves the stored flag alone, so a client that predates the field cannot
      // silently widen a Copilot that had been restricted to no tools.
      allTools: body.allTools ?? existing.allTools,
      tools: body.tools ?? existing.tools,
      settings: body.settings ?? existing.settings,
      visibility: body.visibility ?? existing.visibility,
    });
    if (!copilot) return reply.code(404).send(apiError("COPILOT_NOT_FOUND", "copilot not found"));
    return copilot;
  });

  app.delete("/api/copilots/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.deleteCopilotForUser(id, actor(request).id)) {
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
      title: body?.title?.trim() || DEFAULT_SESSION_TITLE,
      settings: copilot ? { ...copilot.settings } : {},
    });
    // The conversation's own directory, made now rather than the first time something wants
    // it, so that reserving it means it is *there*. Best-effort: nothing writes into it yet,
    // and a data root on a read-only volume must not turn starting a conversation into an
    // error over a directory nobody is using.
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
    if (!db.getSessionForUser(id, userId)) {
      return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    }
    if (body?.title !== undefined && !body.title.trim()) {
      return reply.code(400).send(apiError("TITLE_EMPTY", "title must not be empty"));
    }
    return db.updateSessionForUser(id, userId, {
      title: body?.title,
      settings: body?.settings,
      systemPrompt: body?.systemPrompt,
      allTools: body?.allTools,
      tools: body?.tools,
    });
  });

  /**
   * Delete a conversation.
   *
   * **The uploaded files stay.** This used to abort any in-flight parse and remove the whole
   * session upload directory, because the bytes and the parse sidecars lived inside it. A
   * source belongs to the account now, so neither happens: deleting a conversation removes
   * its *references* (the links cascade with the row) and leaves the files alone, because
   * another conversation may be reading them — and because a file the user uploaded is not
   * something to delete as a side effect of tidying up a chat. `DELETE /api/sources/:id` is
   * the one that means "delete this file".
   */
  app.delete("/api/sessions/:id", async (request, reply) => {
    const userId = actor(request).id;
    const { id } = request.params as { id: string };
    const found = db.getSessionForUser(id, userId);
    if (!found) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));

    db.deleteSessionForUser(id, userId);
    // The reserved directory goes with the conversation. Best-effort, same as the create
    // above: a directory nothing wrote to is not worth failing a delete over.
    try {
      rmSync(sessionDir(found.workspace.dirPath, id), { recursive: true, force: true });
    } catch {
      // Ignored on purpose.
    }
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

  /* ---------------------------------- sources ---------------------------------- */

  /**
   * A source as a client may see it.
   *
   * `SourceRecord` carries two fields that never leave the server — who owns the file, and
   * where it sits on disk. Dropping them here rather than at each `reply.send` is what makes
   * that a property of the module instead of of whoever remembered: a route that forgets has
   * to deliberately reach past this function to leak, which is a much harder mistake to make.
   */
  function toSource(record: SourceRecord): Source {
    const { userId, rawPath, ...source } = record;
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

      const existing = db.findSourceByHash(userId, sha256Of(bytes));
      let source = existing;
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
          sha256: sha256Of(bytes),
          name,
          mimeType,
          size: bytes.byteLength,
          kind: kindFor(mimeType),
          rawPath,
        });

        // Extraction runs *after* the response: a cloud parse can take minutes and the
        // composer must not hold the upload open for it. `schedule` writes `pending`
        // synchronously, so the status a poll reads next is never a gap.
        if (documents.handles(source)) {
          void documents.schedule(tree, userId, source).catch((err: unknown) => {
            request.log.error(err, "failed to schedule document parsing");
          });
        }
      }

      db.linkSourceToSession(userId, id, source.id);
      db.linkSourceToWorkspace(userId, session.workspace.id, source.id);

      /*
       * A source that was just created reports `pending` rather than being re-read. Re-reading
       * would race the work it just queued — a small local PDF can be `ready` before this line
       * runs, and a status that races the parse is not a status. The client polls
       * `/sessions/:id/sources` for the outcome, so what it needs from the upload is a stable
       * "we started", which is what it gets.
       *
       * A *reused* source reports what it already has, because nothing was started for it: its
       * parse may be finished, or gone stale, or never have been needed.
       */
      const reported =
        existing || !documents.handles(source)
          ? source
          : { ...source, parseStatus: "pending" as ParseStatus };
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
    return db.listReadableSources(userId, id, found.workspace.id).map(toSource);
  });

  /**
   * Every file this account has uploaded, newest first.
   *
   * Account-wide rather than per-conversation, because that is what a source *is* — the same
   * file referenced from three conversations is one row here and three chips in history. This
   * is the list a user manages their uploads from, and the only place a file with no
   * remaining references is still visible.
   */
  app.get("/api/sources", async (request) => {
    const userId = actor(request).id;
    return db
      .listSourcesForUser(userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(toSource);
  });

  /** Serve a source's bytes back, for a thumbnail or a download. */
  app.get("/api/sources/:id/raw", async (request, reply) => {
    const user = actor(request);
    const { id: sourceId } = request.params as { id: string };
    const source = db.getSourceForUser(sourceId, user.id);
    if (!source) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    // From the row, and validated again before the read: `resolveInSources` is what keeps a
    // path that travelled through a backup — or through a future bug — from being a read of
    // whatever it happens to name.
    const path = resolveInSources(treeFor(user), source.rawPath);
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

  /** Re-run extraction, e.g. after a failure or a change of parser settings. */
  app.post("/api/sources/:id/reparse", async (request, reply) => {
    const user = actor(request);
    const { id: sourceId } = request.params as { id: string };
    const source = db.getSourceForUser(sourceId, user.id);
    if (!source) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    try {
      await documents.reparse(treeFor(user), user.id, source);
    } catch (err) {
      return reply.code(400).send(parseApiError(err));
    }
    return reply.code(202).send({ status: "pending" });
  });

  /**
   * Delete a file for good, everywhere it is used.
   *
   * The bytes and the extracted text go, and every reference to it cascades away — so a
   * conversation that used it simply stops listing it. The `messages.attachments` snapshots
   * stay, deliberately: a message that was sent with a PDF should keep showing what was sent,
   * and its thumbnail starts 404ing, rather than the chip vanishing from history it was part
   * of. That is the cost of a shared source, and it is the right way round.
   */
  app.delete("/api/sources/:id", async (request, reply) => {
    const user = actor(request);
    const { id: sourceId } = request.params as { id: string };
    const source = db.getSourceForUser(sourceId, user.id);
    if (!source) return reply.code(404).send(apiError("SOURCE_NOT_FOUND", "file not found"));

    // Stop a run before removing anything: a parse still going would finish by writing text
    // for a source that no longer exists, and recreate the file we just deleted.
    documents.cancelSource(source.id);

    const tree = treeFor(user);
    db.deleteSourceForUser(source.id, user.id);
    await removeParsedText(tree, source.id).catch(() => undefined);
    const raw = resolveInSources(tree, source.rawPath);
    if (raw) await rm(raw, { force: true }).catch(() => undefined);
    return { ok: true };
  });

  /* -------------------------------- providers --------------------------------- */

  app.get("/api/providers", async () => providerConfigs());

  app.post("/api/providers", async (request, reply) => {
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
    db.deleteProvider(id);
    return { ok: true };
  });

  app.delete("/api/providers/:providerId/models/:modelId", async (request, reply) => {
    const { providerId, modelId } = request.params as { providerId: string; modelId: string };
    const provider = db.getProvider(providerId);
    if (!provider) return reply.code(404).send(apiError("PROVIDER_NOT_FOUND", "provider not found"));
    if (!db.deleteModel(modelId)) return reply.code(404).send(apiError("MODEL_NOT_FOUND", "model not found"));
    return publicProvider(providerId);
  });

  /* ----------------------------- document parsers ------------------------------ */

  /** The protocol kinds the server implements, so the UI never hard-codes the list. */
  app.get("/api/document-parsers/kinds", async () => driverInfos());

  app.get("/api/document-parsers", async () => documentParserConfigs());

  app.post("/api/document-parsers", async (request, reply) => {
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
    const { id } = request.params as { id: string };
    if (!db.getDocumentParser(id)) return reply.code(404).send(apiError("PARSER_NOT_FOUND", "parser not found"));

    // Unlike LLM providers there is no "last one" guard: running with zero cloud parsers is
    // a normal configuration (local-only), so deleting the final entry is allowed.
    db.deleteDocumentParser(id);
    if (db.getSetting(SETTING_DOCUMENT_DEFAULT_PARSER) === id) {
      db.setSetting(SETTING_DOCUMENT_DEFAULT_PARSER, "");
    }
    return { ok: true };
  });

  /** Round-trip a throwaway document through a parser to prove the endpoint and key work. */
  app.post("/api/document-parsers/:id/test", async (request, reply) => {
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
      /** Whose sources tree `read_document` reads from. */
      user: UserLayout;
      /**
       * Every source this conversation can read, resolved per turn.
       *
       * A whitelist rather than "whatever ids the model names": a guessed id fails a `Map`
       * lookup before any path is touched, which is what makes wandering into another
       * conversation's uploads unrepresentable rather than merely forbidden. It is wider than
       * the turn's own attachments on purpose — see `read_document`'s note.
       */
      sources: Source[];
    }
  ): TurnContext {
    // The session's own settings; request fields are one-turn overrides. There is no Copilot
    // tier left to consult — its defaults were merged in when the conversation was created.
    const providerId = resolveProviderId(input.provider, session.settings);
    const provider = db.getProvider(providerId);
    const modelId = resolveModelId(provider, input.model, session.settings);

    const tools = buildTools({
      workspaceDir: workspace.workdirPath,
      webSearch: config.tools.webSearch,
      webFetch: config.tools.webFetch,
      fileToolsEnabled: config.tools.fileTools.enabled,
      // The session's own snapshot, not a Copilot's live list: an allowlist that narrowed the
      // tool set must not evaporate because the Copilot it came from was deleted.
      //
      // `undefined` when every tool is available and the list otherwise, even when empty —
      // that empty case is a conversation deliberately denied every tool, and passing it
      // through as "no restriction" is precisely the bug this shape fixes.
      allowedNames: session.allTools ? undefined : session.tools,
      documents: {
        user: input.user,
        sources: input.sources.map((s) => ({ id: s.id, name: s.name, mimeType: s.mimeType })),
        maxChars: Math.min(config.tools.documents.maxTextChars, 40_000),
      },
    });

    return {
      provider,
      modelId,
      tools,
      vision: isVisionModel(provider, modelId),
      toolUse: isToolUseModel(provider, modelId),
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
    opts: { historyLength: number; userMessage: string | null }
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
        db.setAutoTitleForUser(id, userId, title);
        sse.send({ type: "title", sessionId: id, title });
      }
    }
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
    const readable = new Map(
      db.listReadableSources(userId, id, workspace.id).map((s) => [s.id, s])
    );
    const storedAttachments = attachments
      .map((a) => (readable.has(a.id) ? toAttachment(readable.get(a.id)!, a.name) : undefined))
      .filter((a): a is Attachment => a !== undefined);

    // Any question still waiting for an answer belongs to a turn the user has now moved
    // on from. Retiring it here — before the new user turn is written — is what makes the
    // card read "skipped" rather than staying live on a conversation that has moved past it.
    db.skipAwaitingToolCalls(id);

    const ctx = turnContext(session, workspace, {
      provider: body.provider,
      model: body.model,
      user: treeFor(actor(request)),
      sources: db.listReadableSources(userId, id, workspace.id),
    });

    // Read history *before* persisting the new user turn, so it isn't replayed twice.
    const history = db.listMessagesForUser(id, userId);

    db.createMessage({
      id: newId(),
      sessionId: id,
      role: "user",
      content: message,
      attachments: storedAttachments.length > 0 ? storedAttachments : undefined,
    });

    // Take over the response so we can stream Server-Sent Events.
    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });

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
        attachments: storedAttachments,
        tools: ctx.tools,
        signal: turn.signal,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, userId, session, ctx, result, sse, {
        historyLength: history.length,
        userMessage: message,
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

    const questions = readAskUserQuestions(pending.call);
    if (!questions) {
      return reply.code(409).send(
        apiError("QUESTION_NOT_PENDING", "that tool call does not hold a question set")
      );
    }

    const validated = validateAnswers(questions, { ...body, action, toolCallId });
    if (!validated.ok) {
      return reply.code(400).send(apiError("INVALID_ANSWER", validated.reason));
    }

    // Two copies of one answer, for two readers. `output` is what the model replays as the
    // tool result; `answer` is what the card renders, so the UI never parses prose.
    const status = action === "cancel" ? "dismissed" : "answered";
    const message = db.getMessageForUser(pending.messageId, userId);
    db.updateMessageToolCalls(
      pending.messageId,
      (message?.toolCalls ?? []).map((tc) =>
        tc.id === toolCallId
          ? {
              ...tc,
              status,
              answer: validated.answers,
              output: renderAskUserResult(questions, validated.answers, action),
            }
          : tc
      )
    );

    const ctx = turnContext(session, workspace, {
      user: treeFor(actor(request)),
      sources: db.listReadableSources(userId, id, workspace.id),
    });

    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });

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
        tools: ctx.tools,
        signal: turn.signal,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, userId, session, ctx, result, sse, {
        historyLength: history.length,
        userMessage: null,
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

/**
 * The question set a suspended `ask_user` call recorded, or undefined when the stored
 * `input` is not one.
 *
 * Returns undefined rather than throwing because a malformed `input` here means the row
 * predates this feature or was written by something other than the tool — a case the
 * caller turns into the same 409 as a question that has already been answered.
 */
function readAskUserQuestions(call: ToolCall): AskUserQuestion[] | undefined {
  try {
    const parsed = JSON.parse(call.input) as { questions?: unknown };
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return undefined;
    return parsed.questions as AskUserQuestion[];
  } catch {
    return undefined;
  }
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
