import type { FastifyInstance } from "fastify";
import { readFile, writeFile } from "node:fs/promises";
import type {
  Attachment,
  ChatInput,
  ChatStreamEvent,
  CopilotDefaults,
  CreateCopilotInput,
  CreateProviderInput,
  CreateSessionInput,
  CreateWorkspaceInput,
  ProviderConfig,
  ProviderModelInput,
  PublicConfig,
  SessionSettings,
  UpdateCopilotInput,
  UpdateProviderInput,
  UpdateSessionInput,
  UploadAttachmentInput,
} from "@guided-learning/shared";
import { MAX_ATTACHMENT_BYTES } from "@guided-learning/shared";
import type { AppConfig } from "./config.js";
import {
  newId,
  SETTING_DEFAULT_MODEL,
  SETTING_DEFAULT_PROVIDER,
  type AppDb,
  type ProviderRecord,
} from "./db.js";
import { runAgentStream } from "./agent/loop.js";
import { fallbackTitle, generateTitle } from "./agent/title.js";
import { createSseWriter } from "./stream.js";
import { buildTools } from "./tools/index.js";
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

interface RoutesOptions {
  config: AppConfig;
  db: AppDb;
  /**
   * Where uploaded attachment bytes are stored. Defaults to the project's own
   * `data/uploads`; tests redirect it at a temp directory.
   */
  uploadsRoot?: string;
}

/** Base64 inflates bytes by 4/3, and the JSON envelope adds a little more. */
const ATTACHMENT_BODY_LIMIT = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 64 * 1024;

export default async function routes(app: FastifyInstance, opts: RoutesOptions): Promise<void> {
  const { config, db } = opts;
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

  function providerConfigs(): ProviderConfig[] {
    return db.listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      models: p.models,
      hasApiKey: !!p.apiKey,
    }));
  }

  function publicConfig(): PublicConfig {
    return {
      defaultProvider: resolveDefaultProviderId(),
      defaultModel: db.getSetting(SETTING_DEFAULT_MODEL) ?? config.defaultModel,
      providers: providerConfigs(),
      workspacesRootDir: config.workspaces.rootDir,
      webSearchProvider: config.tools.webSearch.provider,
    };
  }

  /* ------------------------------- config/health ------------------------------- */

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/config", async () => publicConfig());

  /* -------------------------------- workspaces -------------------------------- */

  app.get("/api/workspaces", async () => db.listWorkspaces());

  app.post("/api/workspaces", async (request, reply) => {
    const body = request.body as CreateWorkspaceInput;
    const name = body?.name?.trim();
    if (!name) return reply.code(400).send({ error: "name is required" });

    const slug = uniqueSlug(config.workspaces.rootDir, name);
    const dirPath = createWorkspaceDir(config.workspaces.rootDir, slug);
    const workspace = db.createWorkspace({ id: newId(), name, slug, dirPath });
    return reply.code(201).send(workspace);
  });

  app.delete("/api/workspaces/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = db.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "workspace not found" });
    db.deleteWorkspace(id);
    removeWorkspaceDir(config.workspaces.rootDir, workspace.dirPath);
    return { ok: true };
  });

  /* --------------------------------- copilots --------------------------------- */

  app.get("/api/copilots", async () => db.listCopilots());

  app.post("/api/copilots", async (request, reply) => {
    const body = request.body as CreateCopilotInput;
    if (!body?.name?.trim()) return reply.code(400).send({ error: "name is required" });
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
    if (!existing) return reply.code(404).send({ error: "copilot not found" });
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
    if (!db.getWorkspace(workspaceId)) return reply.code(404).send({ error: "workspace not found" });
    return db.listSessions(workspaceId);
  });

  app.post("/api/workspaces/:workspaceId/sessions", async (request, reply) => {
    const { workspaceId } = request.params as { workspaceId: string };
    const body = request.body as CreateSessionInput;
    if (!db.getWorkspace(workspaceId)) return reply.code(404).send({ error: "workspace not found" });

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
    if (!db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    if (body?.title !== undefined && !body.title.trim()) {
      return reply.code(400).send({ error: "title must not be empty" });
    }
    return db.updateSession(id, { title: body?.title, settings: body?.settings });
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    db.deleteSession(id);
    await removeSessionUploads(uploadsRoot, id);
    return { ok: true };
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.getSession(id)) return reply.code(404).send({ error: "session not found" });
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
      if (!db.getSession(id)) return reply.code(404).send({ error: "session not found" });

      const body = request.body as UploadAttachmentInput;
      const name = body?.name?.trim();
      if (!name) return reply.code(400).send({ error: "name is required" });

      const mimeType = normalizeMime(name, body.mimeType);
      if (!isSupportedMime(mimeType)) {
        return reply.code(415).send({ error: `Unsupported file type: ${body.mimeType || name}` });
      }
      if (typeof body.data !== "string" || !body.data) {
        return reply.code(400).send({ error: "data is required" });
      }

      let bytes: Buffer;
      try {
        bytes = Buffer.from(body.data, "base64");
      } catch {
        return reply.code(400).send({ error: "data is not valid base64" });
      }
      if (bytes.byteLength === 0) return reply.code(400).send({ error: "file is empty" });
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        return reply.code(413).send({
          error: `File is larger than the ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB limit`,
        });
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
      if (!path) return reply.code(400).send({ error: "invalid attachment path" });

      try {
        await writeFile(path, bytes);
      } catch (err) {
        request.log.error(err, "failed to store attachment");
        return reply.code(500).send({ error: "failed to store attachment" });
      }

      return reply.code(201).send(attachment);
    }
  );

  /** Serve an attachment back for preview/thumbnail rendering. */
  app.get("/api/sessions/:sessionId/attachments/:attachmentId", async (request, reply) => {
    const { sessionId, attachmentId } = request.params as {
      sessionId: string;
      attachmentId: string;
    };
    const found = await findStoredAttachment(uploadsRoot, sessionId, attachmentId);
    if (!found) return reply.code(404).send({ error: "attachment not found" });

    try {
      const bytes = await readFile(found.path);
      return reply
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .type(found.mimeType)
        .send(bytes);
    } catch {
      return reply.code(404).send({ error: "attachment not found" });
    }
  });

  /* -------------------------------- providers --------------------------------- */

  app.get("/api/providers", async () => providerConfigs());

  app.post("/api/providers", async (request, reply) => {
    const body = request.body as CreateProviderInput;
    const name = body?.name?.trim();
    const baseURL = body?.baseURL?.trim();
    if (!name) return reply.code(400).send({ error: "name is required" });
    if (!baseURL) return reply.code(400).send({ error: "baseURL is required" });

    const provider = db.createProvider({
      id: newId(),
      name,
      baseURL,
      apiKey: body.apiKey?.trim() || undefined,
    });
    for (const m of body.models ?? []) {
      const parsed = parseModelInput(m);
      if (!parsed) return reply.code(400).send({ error: "each model needs a modelId" });
      db.createModel({ id: newId(), providerId: provider.id, ...parsed });
    }
    return reply.code(201).send(publicProvider(provider.id));
  });

  app.put("/api/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateProviderInput;
    if (!db.getProvider(id)) return reply.code(404).send({ error: "provider not found" });

    if (body?.models) {
      for (const m of body.models) {
        const parsed = parseModelInput(m);
        if (!parsed) return reply.code(400).send({ error: "each model needs a modelId" });
        if (m.id) {
          // Editing in place. Unknown ids are rejected rather than silently inserted.
          if (!db.updateModel(m.id, parsed)) {
            return reply.code(404).send({ error: `model not found: ${m.id}` });
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
    if (!db.getProvider(id)) return reply.code(404).send({ error: "provider not found" });
    if (db.listProviders().length <= 1) {
      return reply.code(409).send({ error: "Cannot delete the only provider." });
    }
    if (db.getSetting(SETTING_DEFAULT_PROVIDER) === id) {
      return reply.code(409).send({
        error: "This is the default provider. Choose a different default first.",
      });
    }
    db.deleteProvider(id);
    return { ok: true };
  });

  app.delete("/api/providers/:providerId/models/:modelId", async (request, reply) => {
    const { providerId, modelId } = request.params as { providerId: string; modelId: string };
    const provider = db.getProvider(providerId);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    if (!db.deleteModel(modelId)) return reply.code(404).send({ error: "model not found" });
    return publicProvider(providerId);
  });

  /* --------------------------------- app defaults ------------------------------ */

  app.put("/api/defaults", async (request, reply) => {
    const body = request.body as { providerId?: string; modelId?: string };
    if (body?.providerId !== undefined) {
      if (!db.getProvider(body.providerId)) {
        return reply.code(400).send({ error: "unknown provider" });
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

  app.post("/api/sessions/:id/chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as ChatInput;

    const session = db.getSession(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const workspace = db.getWorkspace(session.workspaceId);
    if (!workspace) return reply.code(404).send({ error: "workspace not found" });

    const message = body?.message?.trim();
    const attachments = body?.attachments ?? [];
    if (!message && attachments.length === 0) {
      return reply.code(400).send({ error: "message is required" });
    }

    // A Copilot may be switched per turn; the change sticks to the session.
    if (body.copilotId !== undefined && body.copilotId !== session.copilotId) {
      db.setSessionCopilot(id, body.copilotId);
    }
    const copilotId = body.copilotId ?? session.copilotId ?? null;
    const copilot = copilotId ? db.getCopilot(copilotId) : undefined;

    // Session settings win over the Copilot's defaults; request fields are one-turn overrides.
    const providerId = resolveProviderId(body.provider, session.settings, copilot?.settings);
    const provider = db.getProvider(providerId);
    const modelId = resolveModelId(provider, body.model, session.settings, copilot?.settings);

    const tools = buildTools({
      workspaceDir: workspace.dirPath,
      webSearch: config.tools.webSearch,
      webFetch: config.tools.webFetch,
      fileToolsEnabled: config.tools.fileTools.enabled,
      allowedNames: copilot?.tools,
    });

    // Read history *before* persisting the new user turn, so it isn't replayed twice.
    const history = db.listMessages(id);

    // Drop anything whose id/MIME would not resolve to a path under this session's upload
    // directory. A stale or hostile client cannot point the reader at an arbitrary file
    // (a well-formed id for a missing file still degrades to a placeholder downstream).
    const storedAttachments = attachments.filter((a) => resolveStoredPath(uploadsRoot, id, a));

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

    try {
      const result = await runAgentStream({
        provider,
        modelId,
        workspace,
        copilot,
        settings: session.settings,
        uploadRoot: uploadsRoot,
        sessionId: id,
        vision: isVisionModel(provider, modelId),
        history,
        userMessage: message,
        attachments: storedAttachments,
        tools,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

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
      // title (which flips `titleSource` to `user`) or this isn't the first turn.
      const isFirstTurn = history.length === 0;
      if (isFirstTurn && session.titleSource !== "user") {
        const title = await autoTitle({
          provider,
          modelId,
          userMessage: message,
          assistantMessage: result.content,
        });
        if (title) {
          db.setAutoTitle(id, title);
          sse.send({ type: "title", sessionId: id, title });
        }
      }
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      sse.send({ type: "error", message: errorText });
      // Persist a balanced assistant message so history stays user/assistant.
      db.createMessage({
        id: newId(),
        sessionId: id,
        role: "assistant",
        content: `⚠️ ${errorText}`,
      });
    } finally {
      sse.send({ type: "done" });
      sse.end();
    }
  });
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
