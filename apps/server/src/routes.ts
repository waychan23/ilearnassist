import type { FastifyInstance } from "fastify";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type {
  AnswerToolCallInput,
  ApiErrorBody,
  ApiErrorCode,
  AskUserQuestion,
  Attachment,
  AttachmentParseRecord,
  ChatInput,
  ChatStreamEvent,
  Copilot,
  CopilotDefaults,
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
  ToolCall,
  UpdateCopilotInput,
  UpdateDocumentParserInput,
  UpdateDocumentParsingInput,
  UpdateProviderInput,
  UpdateSessionInput,
  UpdateWorkspaceInput,
  UploadAttachmentInput,
  Workspace,
} from "@guided-learning/shared";
import { MAX_ATTACHMENT_BYTES } from "@guided-learning/shared";
import type { AppConfig } from "./config.js";
import {
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
} from "./db.js";
import {
  describeParseError,
  driverInfos,
  isDocumentParserKind,
  parseErrorCodeOf,
  parseErrorDetail,
} from "./documents/index.js";
import type { DocumentService } from "./documents/service.js";
import { listParseRecords } from "./documents/store.js";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { runAgentStream, type RunAgentResult } from "./agent/loop.js";
import { fallbackTitle, generateTitle } from "./agent/title.js";
import { createSseWriter } from "./stream.js";
import { buildTools } from "./tools/index.js";
import { renderAskUserResult, validateAnswers } from "./tools/askUser.js";
import {
  ensureSessionUploadDir,
  findStoredAttachment,
  isSupportedMime,
  kindFor,
  normalizeMime,
  removeSessionUploads,
  resolveStoredPath,
  UPLOADS_ROOT,
} from "./attachments.js";
import { createWorkspaceDir, removeWorkspaceDir, uniqueSlug } from "./workspace.js";
import { FileAccessError, listDirectory, readFileContent } from "./files.js";

interface RoutesOptions {
  config: AppConfig;
  db: AppDb;
  /**
   * Where uploaded attachment bytes are stored. Defaults to the project's own
   * `data/uploads`; tests redirect it at a temp directory.
   */
  uploadsRoot?: string;
  /** Owns document text extraction and the parse-state sidecars. */
  documents: DocumentService;
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
  const { config, db, documents } = opts;
  const uploadsRoot = opts.uploadsRoot ?? UPLOADS_ROOT;

  /* --------------------------------- resolution -------------------------------- */
  /*
   * Effective provider/model resolve in a fixed order, most specific first:
   *   explicit request override ⊳ session settings ⊳ the Copilot's defaults ⊳ app default.
   * A candidate only wins if it still exists, so a deleted provider (or a session copied
   * from a Copilot that referenced one) degrades instead of erroring.
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
    settings: SessionSettings,
    copilot?: CopilotDefaults
  ): string {
    for (const candidate of [override, settings.providerId, copilot?.providerId]) {
      if (providerExists(candidate)) return candidate;
    }
    return resolveDefaultProviderId();
  }

  function resolveModelId(
    provider: ProviderRecord | undefined,
    override: string | null | undefined,
    settings: SessionSettings,
    copilot?: CopilotDefaults
  ): string {
    const known = new Set((provider?.models ?? []).map((m) => m.modelId));
    const candidates = [
      override,
      settings.modelId,
      copilot?.modelId,
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

  function publicConfig(): PublicConfig {
    return {
      defaultProvider: resolveDefaultProviderId(),
      defaultModel: db.getSetting(SETTING_DEFAULT_MODEL) ?? config.defaultModel,
      providers: providerConfigs(),
      workspacesRootDir: config.workspaces.rootDir,
      webSearchProvider: config.tools.webSearch.provider,
      documentParsers: documentParserConfigs(),
      documentParsing: documentParsing(),
    };
  }

  /**
   * Fold parse state into the attachment metadata that gets persisted with a message.
   *
   * The prompt itself reads the sidecar directly, so this is purely for the UI: without it
   * a conversation reloaded tomorrow would show every document as unparsed, having lost the
   * only record of what happened.
   */
  async function withParseState(sessionId: string, list: Attachment[]): Promise<Attachment[]> {
    if (list.length === 0) return list;
    const records = await listParseRecords(uploadsRoot, sessionId);
    return list.map((att) => {
      const record = records.get(att.id);
      if (!record) return att;
      return {
        ...att,
        parseStatus: record.status,
        parseError: record.error,
        parseErrorCode: record.code,
        parserId: record.parserId,
        parsedChars: record.parsedChars,
        pageCount: record.pageCount,
      };
    });
  }

  /* ------------------------------- config/health ------------------------------- */

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/config", async () => publicConfig());

  /* -------------------------------- workspaces -------------------------------- */

  app.get("/api/workspaces", async () => db.listWorkspaces());

  app.post("/api/workspaces", async (request, reply) => {
    const body = request.body as CreateWorkspaceInput;
    const name = body?.name?.trim();
    if (!name) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));

    const slug = uniqueSlug(config.workspaces.rootDir, name);
    const dirPath = createWorkspaceDir(config.workspaces.rootDir, slug);
    const workspace = db.createWorkspace({ id: newId(), name, slug, dirPath });
    return reply.code(201).send(workspace);
  });

  /**
   * Rename. The directory keeps its original slug — see `renameWorkspace` in `db.ts` — so
   * this is a display-name change and nothing on disk moves underneath a running agent.
   */
  app.patch("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateWorkspaceInput;
    if (!db.getWorkspace(id)) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));

    const name = body?.name?.trim();
    if (!name) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));

    return db.renameWorkspace(id, name);
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = db.getWorkspace(id);
    if (!workspace) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    db.deleteWorkspace(id);
    removeWorkspaceDir(config.workspaces.rootDir, workspace.dirPath);
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
    const { workspaceId } = request.params as { workspaceId: string };
    // `string[]` is not hypothetical: `?path=a&path=b` parses to an array, and the module
    // refuses it rather than letting a string operation on it become a 500.
    const { path } = request.query as { path?: string | string[] };
    const workspace = db.getWorkspace(workspaceId);
    if (!workspace) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    try {
      return await listDirectory(workspace.dirPath, path);
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  app.get("/api/workspaces/:workspaceId/files/content", async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const { path } = request.query as { path?: string | string[] };
    const workspace = db.getWorkspace(workspaceId);
    if (!workspace) {
      return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    }

    try {
      return await readFileContent(workspace.dirPath, path);
    } catch (err) {
      const { status, body } = fileErrorReply(err);
      return reply.code(status).send(body);
    }
  });

  /* --------------------------------- copilots --------------------------------- */

  app.get("/api/copilots", async () => db.listCopilots());

  app.post("/api/copilots", async (request, reply) => {
    const body = request.body as CreateCopilotInput;
    if (!body?.name?.trim()) return reply.code(400).send(apiError("NAME_REQUIRED", "name is required"));
    const copilot = db.createCopilot({
      id: newId(),
      name: body.name.trim(),
      description: body.description ?? "",
      systemPrompt: body.systemPrompt ?? "",
      tools: body.tools ?? [],
      settings: body.settings ?? {},
    });
    return reply.code(201).send(copilot);
  });

  app.put("/api/copilots/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateCopilotInput;
    const existing = db.getCopilot(id);
    if (!existing) return reply.code(404).send(apiError("COPILOT_NOT_FOUND", "copilot not found"));
    const copilot = db.updateCopilot(id, {
      name: body.name?.trim() ?? existing.name,
      description: body.description ?? existing.description,
      systemPrompt: body.systemPrompt ?? existing.systemPrompt,
      tools: body.tools ?? existing.tools,
      settings: body.settings ?? existing.settings,
    });
    return copilot;
  });

  app.delete("/api/copilots/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    db.deleteCopilot(id);
    return { ok: true };
  });

  /* --------------------------------- sessions --------------------------------- */

  app.get("/api/workspaces/:workspaceId/sessions", async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    if (!db.getWorkspace(workspaceId)) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));
    return db.listSessions(workspaceId);
  });

  app.post("/api/workspaces/:workspaceId/sessions", async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = request.body as CreateSessionInput;
    if (!db.getWorkspace(workspaceId)) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));

    const copilotId = body?.copilotId ?? null;
    const copilot = copilotId ? db.getCopilot(copilotId) : undefined;

    const session = db.createSession({
      id: newId(),
      workspaceId,
      copilotId,
      title: body?.title?.trim() || "New conversation",
      // The Copilot's defaults are copied in, not referenced — changing a Copilot later
      // must not silently rewrite the parameters of conversations already underway.
      settings: copilot ? { ...copilot.settings } : {},
    });
    return reply.code(201).send(session);
  });

  /** Rename and/or update per-conversation generation parameters. */
  app.patch("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateSessionInput;
    if (!db.getSession(id)) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    if (body?.title !== undefined && !body.title.trim()) {
      return reply.code(400).send(apiError("TITLE_EMPTY", "title must not be empty"));
    }
    return db.updateSession(id, { title: body?.title, settings: body?.settings });
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    // Abort before deleting: a parse still running would finish by writing a sidecar back
    // into the directory we are about to remove, recreating it as an orphan.
    documents.cancelSession(id);
    db.deleteSession(id);
    await removeSessionUploads(uploadsRoot, id);
    return { ok: true };
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.getSession(id)) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    return db.listMessages(id);
  });

  /* -------------------------------- attachments -------------------------------- */

  /**
   * Uploads arrive as base64 JSON rather than multipart, which keeps this dependency-free
   * (`@fastify/multipart` is not installed) at the cost of a ~33% larger body — hence the
   * raised per-route `bodyLimit`.
   */
  app.post(
    "/api/sessions/:id/attachments",
    { bodyLimit: ATTACHMENT_BODY_LIMIT },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!db.getSession(id)) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));

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

      const attachment: Attachment = {
        id: newId(),
        name,
        mimeType,
        size: bytes.byteLength,
        kind: kindFor(mimeType),
      };

      await ensureSessionUploadDir(uploadsRoot, id);
      // resolveStoredPath re-derives the filename from the id + MIME type, so nothing the
      // client sent can steer the write outside `<uploads>/<sessionId>/`.
      const path = resolveStoredPath(uploadsRoot, id, attachment);
      if (!path) return reply.code(400).send(apiError("INVALID_ATTACHMENT_PATH", "invalid attachment path"));

      try {
        await writeFile(path, bytes);
      } catch (err) {
        request.log.error(err, "failed to store attachment");
        return reply.code(500).send(apiError("ATTACHMENT_STORE_FAILED", "failed to store attachment"));
      }

      // Text extraction runs *after* the response: a cloud parse can take minutes, and the
      // composer must not hold the upload open for it. The client polls the parse state,
      // which `schedule` has already written as `pending` before this returns.
      void documents.schedule(id, attachment).catch((err: unknown) => {
        request.log.error(err, "failed to schedule document parsing");
      });

      // Report the pending state immediately so the client never has to guess.
      const pending = documents.handles(attachment)
        ? { ...attachment, parseStatus: "pending" as ParseStatus }
        : attachment;
      return reply.code(201).send(pending);
    }
  );

  /** Parse state for every attachment in a session, keyed by attachment id. */
  app.get("/api/sessions/:id/attachments", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.getSession(id)) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    const records = await listParseRecords(uploadsRoot, id);
    // Mapped rather than passed through: the sidecar stores the code as `code`, while the
    // client-facing type calls it `parseErrorCode`. The rename is deliberate — the record
    // is an internal representation and should not become the wire contract by accident.
    return Object.fromEntries(
      [...records].map(([attachmentId, r]) => [
        attachmentId,
        {
          status: r.status,
          error: r.error,
          parseErrorCode: r.code,
          parserId: r.parserId,
          parsedChars: r.parsedChars,
          pageCount: r.pageCount,
          updatedAt: r.updatedAt,
        } satisfies AttachmentParseRecord,
      ])
    );
  });

  /** Re-run extraction, e.g. after a failure or a change of parser settings. */
  app.post("/api/sessions/:id/attachments/:attachmentId/reparse", async (request, reply) => {
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };
    if (!db.getSession(id)) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));

    const found = await findStoredAttachment(uploadsRoot, id, attachmentId);
    if (!found) return reply.code(404).send(apiError("ATTACHMENT_NOT_FOUND", "attachment not found"));

    const body = (request.body ?? {}) as { name?: string };
    // Cloud parsers branch on the filename extension, so the on-disk name is a sound
    // fallback when the caller does not supply the original — the MIME type came from that
    // same extension a moment ago.
    const name = body.name?.trim() || basename(found.path);

    try {
      await documents.reparse(id, {
        id: attachmentId,
        name,
        mimeType: found.mimeType,
        size: 0,
        kind: kindFor(found.mimeType),
      });
    } catch (err) {
      return reply.code(400).send(parseApiError(err));
    }
    return reply.code(202).send({ status: "pending" });
  });

  /** Serve an attachment back for preview/thumbnail rendering. */
  app.get("/api/sessions/:sessionId/attachments/:attachmentId", async (request, reply) => {
    const { sessionId, attachmentId } = request.params as {
      sessionId: string;
      attachmentId: string;
    };
    const found = await findStoredAttachment(uploadsRoot, sessionId, attachmentId);
    if (!found) return reply.code(404).send(apiError("ATTACHMENT_NOT_FOUND", "attachment not found"));

    try {
      const bytes = await readFile(found.path);
      return reply
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .type(found.mimeType)
        .send(bytes);
    } catch {
      return reply.code(404).send(apiError("ATTACHMENT_NOT_FOUND", "attachment not found"));
    }
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
    return publicConfig();
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
    copilot: Copilot | undefined;
    provider: ProviderRecord | undefined;
    modelId: string;
    tools: StructuredToolInterface[];
    vision: boolean;
    toolUse: boolean;
  }

  /**
   * Resolve the model, the Copilot in force and the tool set for one turn.
   *
   * Shared by the two routes that run a turn — `/chat` (a new user message) and
   * `/answers` (resuming a suspended `ask_user`). They have to agree on all of it: a
   * resumed turn that rebuilt its tools differently from the one that asked the question
   * could find `ask_user` missing from the very conversation it is in the middle of.
   */
  function turnContext(
    session: Session,
    workspace: Workspace,
    input: {
      copilotId: string | null;
      provider?: string;
      model?: string;
      /** This turn's attachments, which scope the `read_document` tool. */
      attachments: Attachment[];
    }
  ): TurnContext {
    const copilot = input.copilotId ? db.getCopilot(input.copilotId) : undefined;

    // Session settings win over the Copilot's defaults; request fields are one-turn overrides.
    const providerId = resolveProviderId(input.provider, session.settings, copilot?.settings);
    const provider = db.getProvider(providerId);
    const modelId = resolveModelId(provider, input.model, session.settings, copilot?.settings);

    const tools = buildTools({
      workspaceDir: workspace.dirPath,
      webSearch: config.tools.webSearch,
      webFetch: config.tools.webFetch,
      fileToolsEnabled: config.tools.fileTools.enabled,
      allowedNames: copilot?.tools,
      // The tool is scoped to *this turn's* attachments, so a model cannot read a document
      // from another conversation even if it guesses an id.
      documents: {
        uploadRoot: uploadsRoot,
        sessionId: session.id,
        attachments: input.attachments.map((a) => ({
          id: a.id,
          name: a.name,
          mimeType: a.mimeType,
        })),
        maxChars: Math.min(config.tools.documents.maxTextChars, 40_000),
      },
    });

    return {
      copilot,
      provider,
      modelId,
      tools,
      vision: isVisionModel(provider, modelId),
      toolUse: isToolUseModel(provider, modelId),
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
    });
    db.touchSession(id);

    sse.send({ type: "message_done", message: assistantMessage });

    // Name the conversation from its first exchange, unless the user already typed a
    // title (which flips `titleSource` to `user`) or this isn't the first turn. A resume
    // has no user message to name it from, and is never the first turn anyway.
    const isFirstTurn = opts.historyLength === 0;
    if (isFirstTurn && session.titleSource !== "user" && opts.userMessage !== null) {
      const title = await autoTitle({
        provider: ctx.provider,
        modelId: ctx.modelId,
        userMessage: opts.userMessage,
        assistantMessage: result.content,
      });
      if (title) {
        db.setAutoTitle(id, title);
        sse.send({ type: "title", sessionId: id, title });
      }
    }
  }

  /** Report a failed turn and keep history well-formed. */
  function failTurn(id: string, err: unknown, sse: ReturnType<typeof createSseWriter>): void {
    const errorText = err instanceof Error ? err.message : String(err);
    sse.send({ type: "error", message: errorText });
    // Persist a balanced assistant message so history stays user/assistant.
    db.createMessage({
      id: newId(),
      sessionId: id,
      role: "assistant",
      content: `⚠️ ${errorText}`,
    });
  }

  app.post("/api/sessions/:id/chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as ChatInput;

    const session = db.getSession(id);
    if (!session) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    const workspace = db.getWorkspace(session.workspaceId);
    if (!workspace) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));

    const message = body?.message?.trim();
    const attachments = body?.attachments ?? [];
    if (!message && attachments.length === 0) {
      return reply.code(400).send(apiError("MESSAGE_REQUIRED", "message is required"));
    }

    // A Copilot may be switched per turn; the change sticks to the session.
    if (body.copilotId !== undefined && body.copilotId !== session.copilotId) {
      db.setSessionCopilot(id, body.copilotId);
    }
    const copilotId = body.copilotId ?? session.copilotId ?? null;

    // Drop anything whose id/MIME would not resolve to a path under this session's upload
    // directory. A stale or hostile client cannot point the reader at an arbitrary file
    // (a well-formed id for a missing file still degrades to a placeholder downstream).
    const storedAttachments = attachments.filter((a) => resolveStoredPath(uploadsRoot, id, a));

    // Any question still waiting for an answer belongs to a turn the user has now moved
    // on from. Retiring it here — before the new user turn is written — is what makes the
    // card read "skipped" rather than staying live on a conversation that has moved past it.
    db.skipAwaitingToolCalls(id);

    const ctx = turnContext(session, workspace, {
      copilotId,
      provider: body.provider,
      model: body.model,
      attachments: storedAttachments,
    });

    // Read history *before* persisting the new user turn, so it isn't replayed twice.
    const history = db.listMessages(id);

    db.createMessage({
      id: newId(),
      sessionId: id,
      role: "user",
      content: message,
      attachments: storedAttachments.length > 0 ? await withParseState(id, storedAttachments) : undefined,
    });

    // Take over the response so we can stream Server-Sent Events.
    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });

    try {
      const result = await runAgentStream({
        provider: ctx.provider,
        modelId: ctx.modelId,
        workspace,
        copilot: ctx.copilot,
        settings: session.settings,
        uploadRoot: uploadsRoot,
        sessionId: id,
        vision: ctx.vision,
        toolUse: ctx.toolUse,
        history,
        userMessage: message,
        attachments: storedAttachments,
        tools: ctx.tools,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, session, ctx, result, sse, {
        historyLength: history.length,
        userMessage: message,
      });
    } catch (err) {
      failTurn(id, err, sse);
    } finally {
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
    const { id } = request.params as { id: string };
    const body = request.body as AnswerToolCallInput;

    const session = db.getSession(id);
    if (!session) return reply.code(404).send(apiError("SESSION_NOT_FOUND", "session not found"));
    const workspace = db.getWorkspace(session.workspaceId);
    if (!workspace) return reply.code(404).send(apiError("WORKSPACE_NOT_FOUND", "workspace not found"));

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
    const message = db.getMessage(pending.messageId);
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
      copilotId: session.copilotId ?? null,
      attachments: [],
    });

    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });

    try {
      // Read history *after* the answer was written, so the resumed run sees it.
      const history = db.listMessages(id);
      const result = await runAgentStream({
        provider: ctx.provider,
        modelId: ctx.modelId,
        workspace,
        copilot: ctx.copilot,
        settings: session.settings,
        uploadRoot: uploadsRoot,
        sessionId: id,
        vision: ctx.vision,
        toolUse: ctx.toolUse,
        history,
        userMessage: null,
        tools: ctx.tools,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      await finishTurn(id, session, ctx, result, sse, {
        historyLength: history.length,
        userMessage: null,
      });
    } catch (err) {
      failTurn(id, err, sse);
    } finally {
      sse.send({ type: "done" });
      sse.end();
    }
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
