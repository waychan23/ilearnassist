import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { api, streamChat, fileToBase64 } from "../api/client";
import type {
  Attachment,
  Copilot,
  CopilotDefaults,
  CreateCopilotInput,
  CreateProviderInput,
  Message,
  MessageUsage,
  ProviderConfig,
  PublicConfig,
  Session,
  SessionSettings,
  ToolCall,
  UpdateProviderInput,
  Workspace,
} from "../api/types";
import { MAX_ATTACHMENT_BYTES } from "../api/types";

interface StreamingState {
  active: boolean;
  content: string;
  /** Chain of thought, arriving before (and between) the visible answer. */
  reasoning: string;
  /** True while reasoning deltas are still arriving. */
  thinking: boolean;
  /** Elapsed thinking time, ticked while thinking and frozen once the answer starts. */
  reasoningMs: number | null;
  toolCalls: ToolCall[];
  usage: MessageUsage | null;
  error: string | null;
}

export interface CopilotDraft {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  settings: CopilotDefaults;
}

export interface ProviderDraft {
  id?: string;
  name: string;
  baseURL: string;
  apiKey: string;
  /** Models as edited in the form. `id` present = an existing record. */
  models: {
    id?: string;
    modelId: string;
    name: string;
    contextWindow: number | null;
    maxOutput: number | null;
    capabilities: string[];
  }[];
}

const EMPTY_STREAMING = (): StreamingState => ({
  active: false,
  content: "",
  reasoning: "",
  thinking: false,
  reasoningMs: null,
  toolCalls: [],
  usage: null,
  error: null,
});

export const useAppStore = defineStore("app", () => {
  /* --------------------------------- state --------------------------------- */
  const config = ref<PublicConfig | null>(null);
  const workspaces = ref<Workspace[]>([]);
  const copilots = ref<Copilot[]>([]);
  const sessions = ref<Session[]>([]);
  const messages = ref<Message[]>([]);

  const activeWorkspaceId = ref<string | null>(null);
  const activeSessionId = ref<string | null>(null);
  const activeCopilotId = ref<string | null>(null);

  /**
   * Settings chosen before a conversation exists. Folded into the session on creation,
   * so the header selectors work on the welcome screen too.
   */
  const draftSettings = ref<SessionSettings>({});

  /** Uploaded-but-not-yet-sent attachments for the composer. */
  const pendingAttachments = ref<Attachment[]>([]);

  /**
   * Ticker behind the "思考中 · 3.2s" label. Lives in the store rather than the component
   * so there is exactly one interval regardless of how many reasoning blocks render.
   */
  let reasoningStartedAt: number | null = null;
  let reasoningTicker: ReturnType<typeof setInterval> | null = null;

  function startReasoningTicker() {
    if (reasoningTicker !== null || reasoningStartedAt === null) return;
    reasoningTicker = setInterval(() => {
      if (reasoningStartedAt !== null) {
        streaming.value.reasoningMs = Date.now() - reasoningStartedAt;
      }
    }, 200);
  }

  function stopReasoningTicker() {
    if (reasoningTicker !== null) {
      clearInterval(reasoningTicker);
      reasoningTicker = null;
    }
    reasoningStartedAt = null;
    streaming.value.thinking = false;
  }

  const streaming = ref<StreamingState>(EMPTY_STREAMING());
  const error = ref<string | null>(null);

  /* ------------------------------- derived --------------------------------- */
  const activeWorkspace = computed(
    () => workspaces.value.find((w) => w.id === activeWorkspaceId.value) ?? null
  );
  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null
  );
  const activeCopilot = computed(
    () => copilots.value.find((c) => c.id === activeCopilotId.value) ?? null
  );

  /**
   * The parameters actually in force. Mirrors the server's resolution order exactly:
   * session ⊳ Copilot defaults ⊳ app default. A candidate only wins when it still
   * resolves, so a deleted provider degrades instead of showing a broken selection.
   */
  const sessionSettings = computed<SessionSettings>(
    () => activeSession.value?.settings ?? draftSettings.value
  );

  const currentProviderId = computed(() => {
    const candidates = [
      sessionSettings.value.providerId,
      activeCopilot.value?.settings.providerId,
      config.value?.defaultProvider,
    ];
    for (const c of candidates) {
      if (c && config.value?.providers.some((p) => p.id === c)) return c;
    }
    return config.value?.providers[0]?.id ?? "";
  });

  const currentProvider = computed(() =>
    config.value?.providers.find((p) => p.id === currentProviderId.value)
  );

  const modelOptions = computed(() => currentProvider.value?.models ?? []);

  const effectiveModelId = computed(() => {
    const provider = currentProvider.value;
    if (!provider) return "";
    const known = new Set(provider.models.map((m) => m.modelId));
    const candidates = [
      sessionSettings.value.modelId,
      activeCopilot.value?.settings.modelId,
      config.value?.defaultModel,
    ];
    for (const c of candidates) {
      if (c && known.has(c)) return c;
    }
    return provider.models[0]?.modelId ?? "";
  });

  const effectiveModel = computed(
    () => modelOptions.value.find((m) => m.modelId === effectiveModelId.value) ?? null
  );

  /** Whether the effective model accepts image input — drives the composer's warning. */
  const supportsVision = computed(
    () => effectiveModel.value?.capabilities.includes("vision") ?? false
  );

  /** Context window of the effective model, for the token popover. */
  const contextWindow = computed(() => effectiveModel.value?.contextWindow ?? null);

  /** Context used by the last completed assistant turn. */
  const contextTokens = computed(() => {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const usage = messages.value[i]?.usage;
      if (usage?.contextTokens) return usage.contextTokens;
    }
    return 0;
  });

  const isConfigured = computed(() => !!config.value?.providers.some((p) => p.hasApiKey));

  /* ------------------------------- actions --------------------------------- */
  function setError(message: string | null) {
    error.value = message;
  }

  function replaceSession(updated: Session) {
    const idx = sessions.value.findIndex((s) => s.id === updated.id);
    if (idx !== -1) sessions.value[idx] = updated;
  }

  async function init(): Promise<void> {
    config.value = await api.getConfig();
    workspaces.value = await api.listWorkspaces();
    if (workspaces.value.length === 0) {
      await createWorkspace("Default");
    }
    copilots.value = await api.listCopilots();
    if (!activeWorkspaceId.value) activeWorkspaceId.value = workspaces.value[0]!.id;
    await loadSessions();
  }

  async function refreshConfig(): Promise<void> {
    config.value = await api.getConfig();
  }

  async function loadSessions(): Promise<void> {
    if (!activeWorkspaceId.value) {
      sessions.value = [];
      return;
    }
    sessions.value = await api.listSessions(activeWorkspaceId.value);
  }

  async function selectWorkspace(id: string): Promise<void> {
    activeWorkspaceId.value = id;
    activeSessionId.value = null;
    activeCopilotId.value = null;
    draftSettings.value = {};
    messages.value = [];
    await loadSessions();
  }

  async function createWorkspace(name: string): Promise<void> {
    const ws = await api.createWorkspace(name);
    workspaces.value.push(ws);
    if (!activeWorkspaceId.value) activeWorkspaceId.value = ws.id;
  }

  async function deleteWorkspace(id: string): Promise<void> {
    await api.deleteWorkspace(id);
    workspaces.value = workspaces.value.filter((w) => w.id !== id);
    if (activeWorkspaceId.value === id) {
      activeWorkspaceId.value = workspaces.value[0]?.id ?? null;
      activeSessionId.value = null;
      messages.value = [];
      await loadSessions();
    }
  }

  async function selectSession(id: string): Promise<void> {
    activeSessionId.value = id;
    activeCopilotId.value = activeSession.value?.copilotId ?? null;
    messages.value = await api.listMessages(id);
    pendingAttachments.value = [];
    streaming.value = EMPTY_STREAMING();
  }

  async function createSession(copilotId?: string | null): Promise<Session | null> {
    if (!activeWorkspaceId.value) return null;
    const session = await api.createSession(activeWorkspaceId.value, {
      copilotId: copilotId ?? activeCopilotId.value ?? null,
    });
    // Carry over anything picked on the welcome screen, so the choice survives.
    const carried = Object.entries(draftSettings.value).filter(([, v]) => v != null);
    const created = carried.length
      ? await api.updateSession(session.id, { settings: draftSettings.value })
      : session;
    draftSettings.value = {};
    if (carried.length) replaceSession(created);
    sessions.value = [created, ...sessions.value.filter((s) => s.id !== created.id)];
    await selectSession(created.id);
    return created;
  }

  async function renameSession(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    const updated = await api.updateSession(id, { title: trimmed });
    replaceSession(updated);
  }

  /**
   * Write generation parameters. Before a conversation exists the values are staged
   * locally and applied when the session is created.
   */
  async function updateSettings(partial: SessionSettings): Promise<void> {
    const session = activeSession.value;
    if (!session) {
      draftSettings.value = { ...draftSettings.value, ...partial };
      return;
    }
    const updated = await api.updateSession(session.id, { settings: partial });
    replaceSession(updated);
  }

  async function deleteSession(id: string): Promise<void> {
    await api.deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = null;
      activeCopilotId.value = null;
      messages.value = [];
      pendingAttachments.value = [];
    }
  }

  /**
   * Pick a model from the composer's picker. Provider and model move together: a model id
   * is only meaningful inside its own provider, so setting one without the other would
   * leave the session pointing at a model its provider does not serve.
   */
  function setProviderAndModel(providerId: string, modelId: string): void {
    void updateSettings({ providerId, modelId });
  }

  function setCopilot(id: string | null): void {
    activeCopilotId.value = id;
  }

  /* ------------------------------ copilots --------------------------------- */
  async function saveCopilot(draft: CopilotDraft): Promise<void> {
    const payload: CreateCopilotInput = {
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      tools: draft.tools,
      settings: draft.settings,
    };
    if (draft.id) {
      const updated = await api.updateCopilot(draft.id, payload);
      const idx = copilots.value.findIndex((c) => c.id === updated.id);
      if (idx !== -1) copilots.value[idx] = updated;
    } else {
      const created = await api.createCopilot(payload);
      copilots.value.push(created);
    }
  }

  async function deleteCopilot(id: string): Promise<void> {
    await api.deleteCopilot(id);
    copilots.value = copilots.value.filter((c) => c.id !== id);
    if (activeCopilotId.value === id) activeCopilotId.value = null;
  }

  /* ------------------------------ providers -------------------------------- */
  function applyProvider(updated: ProviderConfig) {
    const providers = config.value?.providers ?? [];
    const idx = providers.findIndex((p) => p.id === updated.id);
    if (idx !== -1) providers[idx] = updated;
    else providers.push(updated);
    if (config.value) config.value.providers = providers;
  }

  async function saveProvider(draft: ProviderDraft): Promise<void> {
    const models = draft.models
      .filter((m) => m.modelId.trim())
      .map((m) => ({
        id: m.id,
        modelId: m.modelId.trim(),
        name: m.name.trim() || m.modelId.trim(),
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        capabilities: m.capabilities as ProviderConfig["models"][number]["capabilities"],
      }));

    const input: CreateProviderInput = {
      name: draft.name.trim(),
      baseURL: draft.baseURL.trim(),
      // Omit entirely when blank so the server keeps the stored key untouched.
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      models,
    };

    const updated = draft.id
      ? await api.updateProvider(draft.id, input as UpdateProviderInput)
      : await api.createProvider(input);
    applyProvider(updated);
  }

  async function deleteProvider(id: string): Promise<void> {
    await api.deleteProvider(id);
    if (config.value) {
      config.value.providers = config.value.providers.filter((p) => p.id !== id);
    }
    await refreshConfig();
  }

  async function deleteModel(providerId: string, modelId: string): Promise<void> {
    applyProvider(await api.deleteModel(providerId, modelId));
  }

  async function setDefaults(input: { providerId?: string; modelId?: string }): Promise<void> {
    config.value = await api.updateDefaults(input);
  }

  /* ----------------------------- attachments ------------------------------- */
  async function uploadAttachment(file: File): Promise<Attachment | null> {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError(`「${file.name}」超过 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB 限制`);
      return null;
    }

    // Attachments are stored per session, so a conversation has to exist first.
    if (!activeSessionId.value) await createSession();
    const sessionId = activeSessionId.value;
    if (!sessionId) return null;

    try {
      const attachment = await api.uploadAttachment(sessionId, {
        name: file.name,
        mimeType: file.type,
        data: await fileToBase64(file),
      });
      pendingAttachments.value.push(attachment);
      return attachment;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  function removePendingAttachment(id: string): void {
    pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id);
  }

  function clearPendingAttachments(): void {
    pendingAttachments.value = [];
  }

  /* -------------------------------- chat ----------------------------------- */
  async function sendMessage(text: string, attachments: Attachment[] = []): Promise<void> {
    const content = text.trim();
    if ((!content && attachments.length === 0) || streaming.value.active) return;

    // Auto-create a session if the user is on a fresh workspace.
    if (!activeSessionId.value) {
      await createSession();
    }
    if (!activeSessionId.value) return;

    const sessionId = activeSessionId.value;

    // Optimistic user bubble.
    messages.value.push({
      id: `local-${Date.now()}`,
      sessionId,
      role: "user",
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
      createdAt: new Date().toISOString(),
    });

    clearPendingAttachments();
    streaming.value = { ...EMPTY_STREAMING(), active: true };

    try {
      for await (const ev of streamChat(sessionId, {
        message: content,
        copilotId: activeCopilotId.value ?? undefined,
        attachments,
      })) {
        switch (ev.type) {
          case "reasoning":
            if (reasoningStartedAt === null) {
              reasoningStartedAt = Date.now();
              startReasoningTicker();
            }
            streaming.value.thinking = true;
            streaming.value.reasoning += ev.delta;
            break;
          case "text":
            // The answer starting means reasoning is over: freeze the timer for good.
            if (streaming.value.thinking) stopReasoningTicker();
            streaming.value.content += ev.delta;
            break;
          case "tool_start":
            streaming.value.toolCalls.push({
              id: ev.toolCall.id,
              name: ev.toolCall.name,
              input: ev.toolCall.input,
            });
            break;
          case "tool_end": {
            const tc = streaming.value.toolCalls.find((t) => t.id === ev.toolCall.id);
            if (tc) tc.output = ev.toolCall.output;
            break;
          }
          case "usage":
            streaming.value.usage = ev.usage;
            break;
          case "message_done":
            // The authoritative message is now in `messages`, so retire the transient
            // one — otherwise both render until `done`, and the server still has a
            // title call to make after this point.
            messages.value.push(ev.message);
            stopReasoningTicker();
            streaming.value.active = false;
            streaming.value.content = "";
            streaming.value.reasoning = "";
            streaming.value.toolCalls = [];
            break;
          case "title": {
            // The server named the conversation after its first exchange.
            const session = sessions.value.find((s) => s.id === ev.sessionId);
            if (session) session.title = ev.title;
            break;
          }
          case "error":
            streaming.value.error = ev.message;
            break;
          default:
            break;
        }
      }
    } catch (e) {
      streaming.value.error = e instanceof Error ? e.message : String(e);
    } finally {
      streaming.value.active = false;
      stopReasoningTicker();
      // Pick up the server-assigned title and this turn's updated_at without clobbering
      // the optimistic bubbles already in `messages`.
      await loadSessions().catch(() => undefined);
    }
  }

  return {
    // state
    config,
    workspaces,
    copilots,
    sessions,
    messages,
    activeWorkspaceId,
    activeSessionId,
    activeCopilotId,
    draftSettings,
    pendingAttachments,
    streaming,
    error,
    // derived
    activeWorkspace,
    activeSession,
    activeCopilot,
    sessionSettings,
    currentProviderId,
    effectiveModelId,
    effectiveModel,
    supportsVision,
    contextWindow,
    contextTokens,
    isConfigured,
    // actions
    init,
    refreshConfig,
    loadSessions,
    selectWorkspace,
    createWorkspace,
    deleteWorkspace,
    selectSession,
    createSession,
    renameSession,
    updateSettings,
    deleteSession,
    setProviderAndModel,
    setCopilot,
    saveCopilot,
    deleteCopilot,
    saveProvider,
    deleteProvider,
    deleteModel,
    setDefaults,
    uploadAttachment,
    removePendingAttachment,
    clearPendingAttachments,
    sendMessage,
    setError,
  };
});
