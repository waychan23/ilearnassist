import type { FastifyInstance } from "fastify";
import type {
  ChatInput,
  ChatStreamEvent,
  CreateCopilotInput,
  CreateSessionInput,
  CreateWorkspaceInput,
  PublicConfig,
  UpdateCopilotInput,
} from "@guided-learning/shared";
import type { AppConfig } from "./config.js";
import { newId, type AppDb } from "./db.js";
import { runAgentStream } from "./agent/loop.js";
import { createSseWriter } from "./stream.js";
import { buildTools } from "./tools/index.js";
import {
  createWorkspaceDir,
  ensureWorkspacesRoot,
  removeWorkspaceDir,
  uniqueSlug,
} from "./workspace.js";

interface RoutesOptions {
  config: AppConfig;
  db: AppDb;
}

export default async function routes(app: FastifyInstance, opts: RoutesOptions): Promise<void> {
  const { config, db } = opts;

  function publicConfig(): PublicConfig {
    return {
      defaultProvider: config.defaultProvider,
      defaultModel: config.defaultModel,
      providers: config.providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseURL: p.baseURL,
        models: p.models,
        hasApiKey: !!p.apiKey,
      })),
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
      model: body.model ?? null,
      tools: body.tools ?? [],
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
      model: body.model ?? existing.model,
      tools: body.tools ?? existing.tools,
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

    const session = db.createSession({
      id: newId(),
      workspaceId,
      copilotId: body?.copilotId ?? null,
      title: body?.title?.trim() || "New conversation",
    });
    return reply.code(201).send(session);
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    db.deleteSession(id);
    return { ok: true };
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    return db.listMessages(id);
  });

  /* ----------------------------------- chat ----------------------------------- */

  app.post("/api/sessions/:id/chat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as ChatInput;

    const session = db.getSession(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    const workspace = db.getWorkspace(session.workspaceId);
    if (!workspace) return reply.code(404).send({ error: "workspace not found" });

    const message = body?.message?.trim();
    if (!message) return reply.code(400).send({ error: "message is required" });

    // Per-turn model/provider/copilot selection (model/provider are transient).
    const effectiveCopilotId = body.copilotId ?? session.copilotId ?? null;
    if (body.copilotId !== undefined && body.copilotId !== session.copilotId) {
      db.setSessionCopilot(id, body.copilotId);
    }
    const copilot = effectiveCopilotId ? db.getCopilot(effectiveCopilotId) : undefined;
    const modelId = body.model ?? copilot?.model ?? config.defaultModel;
    const providerId = body.provider ?? config.defaultProvider;

    const tools = buildTools({
      workspaceDir: workspace.dirPath,
      webSearch: config.tools.webSearch,
      fileToolsEnabled: config.tools.fileTools.enabled,
      allowedNames: copilot?.tools,
    });

    const history = db.listMessages(id);
    db.createMessage({
      id: newId(),
      sessionId: id,
      role: "user",
      content: message,
    });

    // Take over the response so we can stream Server-Sent Events.
    await reply.hijack();
    const sse = createSseWriter(reply);
    sse.send({ type: "meta", sessionId: id });

    try {
      const result = await runAgentStream({
        config,
        workspace,
        copilot,
        providerId,
        modelId,
        history,
        userMessage: message,
        tools,
        onEvent: (event: ChatStreamEvent) => sse.send(event),
      });

      const assistantMessage = db.createMessage({
        id: newId(),
        sessionId: id,
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      });
      db.touchSession(id);

      sse.send({ type: "message_done", message: assistantMessage });
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