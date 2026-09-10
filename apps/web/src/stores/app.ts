import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { api, streamChat } from "../api/client";
import type {
  Copilot,
  CreateCopilotInput,
  Message,
  PublicConfig,
  Session,
  ToolCall,
  Workspace,
} from "../api/types";

interface StreamingState {
  active: boolean;
  content: string;
  toolCalls: ToolCall[];
  error: string | null;
}

export interface CopilotDraft {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string | null;
  tools: string[];
}

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

  const providerId = ref<string | null>(null);
  const modelId = ref<string | null>(null);

  const streaming = ref<StreamingState>({
    active: false,
    content: "",
    toolCalls: [],
    error: null,
  });

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

  const currentProviderId = computed(
    () => providerId.value ?? config.value?.defaultProvider ?? ""
  );
  const currentProvider = computed(() =>
    config.value?.providers.find((p) => p.id === currentProviderId.value)
  );
  const modelOptions = computed(() => currentProvider.value?.models ?? []);
  const effectiveModelId = computed(
    () =>
      modelId.value ??
      (config.value &&
      modelOptions.value.some((m) => m.id === config.value!.defaultModel)
        ? config.value.defaultModel
        : modelOptions.value[0]?.id ??
          config.value?.defaultModel)
  );

  const isConfigured = computed(
    () => !!config.value?.providers.some((p) => p.hasApiKey)
  );

  /* ------------------------------- actions --------------------------------- */
  function setError(message: string | null) {
    error.value = message;
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
    streaming.value = { active: false, content: "", toolCalls: [], error: null };
  }

  async function createSession(copilotId?: string | null): Promise<Session | null> {
    if (!activeWorkspaceId.value) return null;
    const session = await api.createSession(activeWorkspaceId.value, {
      copilotId: copilotId ?? activeCopilotId.value ?? null,
    });
    sessions.value.unshift(session);
    await selectSession(session.id);
    return session;
  }

  async function deleteSession(id: string): Promise<void> {
    await api.deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = null;
      activeCopilotId.value = null;
      messages.value = [];
    }
  }

  function setProvider(id: string): void {
    providerId.value = id;
    const provider = config.value?.providers.find((p) => p.id === id);
    modelId.value = provider?.models[0]?.id ?? null;
  }

  function setModel(id: string): void {
    modelId.value = id;
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
      model: draft.model,
      tools: draft.tools,
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

  /* -------------------------------- chat ----------------------------------- */
  async function sendMessage(text: string): Promise<void> {
    const content = text.trim();
    if (!content || streaming.value.active) return;

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
      createdAt: new Date().toISOString(),
    });

    streaming.value = { active: true, content: "", toolCalls: [], error: null };

    try {
      for await (const ev of streamChat(sessionId, {
        message: content,
        provider: currentProviderId.value || undefined,
        model: effectiveModelId.value || undefined,
        copilotId: activeCopilotId.value ?? undefined,
      })) {
        switch (ev.type) {
          case "text":
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
          case "message_done":
            messages.value.push(ev.message);
            break;
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
    providerId,
    modelId,
    streaming,
    error,
    // derived
    activeWorkspace,
    activeSession,
    activeCopilot,
    currentProviderId,
    currentProvider,
    modelOptions,
    effectiveModelId,
    isConfigured,
    // actions
    init,
    loadSessions,
    selectWorkspace,
    createWorkspace,
    deleteWorkspace,
    selectSession,
    createSession,
    deleteSession,
    setProvider,
    setModel,
    setCopilot,
    saveCopilot,
    deleteCopilot,
    sendMessage,
    setError,
  };
});