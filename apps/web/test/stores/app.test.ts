import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatStreamEvent,
  Copilot,
  Message,
  PublicConfig,
  Session,
  Workspace,
} from "@guided-learning/shared";
import { MAX_ATTACHMENT_BYTES } from "@guided-learning/shared";

/**
 * The store is the only place the frontend's resolution order and streaming state machine
 * live, so it is tested against a mocked API client — every network call is asserted, and
 * no component is involved.
 */

const mocks = vi.hoisted(() => ({
  api: {
    getConfig: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    listCopilots: vi.fn(),
    createCopilot: vi.fn(),
    updateCopilot: vi.fn(),
    deleteCopilot: vi.fn(),
    listSessions: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
    listMessages: vi.fn(),
    uploadAttachment: vi.fn(),
    deleteProvider: vi.fn(),
    deleteModel: vi.fn(),
  },
  streamChat: vi.fn(),
  fileToBase64: vi.fn(),
}));

vi.mock("../../src/api/client", () => ({
  api: mocks.api,
  streamChat: mocks.streamChat,
  fileToBase64: mocks.fileToBase64,
  attachmentUrl: (sessionId: string, attachmentId: string) =>
    `/api/sessions/${sessionId}/attachments/${attachmentId}`,
}));

const { useAppStore } = await import("../../src/stores/app.js");

/* --------------------------------- fixtures -------------------------------- */

const WORKSPACE: Workspace = {
  id: "w1",
  name: "Notes",
  slug: "notes",
  dirPath: "/tmp/notes",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const CONFIG: PublicConfig = {
  defaultProvider: "p1",
  defaultModel: "m1",
  workspacesRootDir: "/tmp/ws",
  webSearchProvider: "bing",
  providers: [
    {
      id: "p1",
      name: "Provider One",
      baseURL: "https://p1.test/v1",
      hasApiKey: true,
      models: [
        { id: "r1", modelId: "m1", name: "M1", capabilities: ["tool_use", "vision"], contextWindow: 1000 },
        { id: "r2", modelId: "m2", name: "M2", capabilities: ["tool_use"] },
      ],
    },
    {
      id: "p2",
      name: "Provider Two",
      baseURL: "https://p2.test/v1",
      hasApiKey: false,
      models: [{ id: "r3", modelId: "m3", name: "M3", capabilities: ["tool_use"] }],
    },
  ],
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "s1",
    workspaceId: "w1",
    copilotId: null,
    title: "New conversation",
    titleSource: "auto",
    settings: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function message(overrides: Partial<Message> & Pick<Message, "role">): Message {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    sessionId: "s1",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function streamOf(...events: ChatStreamEvent[]) {
  mocks.streamChat.mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

/** Put the store in a state where a session is selected and ready to chat. */
async function readyStore(options: { sessions?: Session[]; messages?: Message[] } = {}) {
  mocks.api.listSessions.mockResolvedValue(options.sessions ?? [session()]);
  mocks.api.listMessages.mockResolvedValue(options.messages ?? []);

  const store = useAppStore();
  await store.init();
  await store.selectSession("s1");
  mocks.api.listSessions.mockClear();
  mocks.api.listMessages.mockClear();
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.clearAllMocks();

  mocks.api.getConfig.mockResolvedValue(structuredClone(CONFIG));
  mocks.api.listWorkspaces.mockResolvedValue([structuredClone(WORKSPACE)]);
  mocks.api.listCopilots.mockResolvedValue([]);
  mocks.api.listSessions.mockResolvedValue([]);
  mocks.api.listMessages.mockResolvedValue([]);
  mocks.api.updateSession.mockImplementation(async (id: string, input: Partial<Session>) =>
    session({ id, ...input })
  );
  mocks.api.createSession.mockImplementation(async () => session());
  mocks.api.listSessions.mockResolvedValue([session()]);
  mocks.fileToBase64.mockResolvedValue("aGk=");
});

afterEach(() => {
  vi.useRealTimers();
});

/* ----------------------------------- tests ---------------------------------- */

describe("init", () => {
  it("loads config, workspaces, copilots and sessions", async () => {
    const store = useAppStore();
    await store.init();

    expect(mocks.api.listCopilots).toHaveBeenCalled();
    expect(store.config).toEqual(CONFIG);
    expect(store.workspaces).toHaveLength(1);
    expect(store.activeWorkspaceId).toBe("w1");
  });

  it("creates a default workspace when none exist", async () => {
    mocks.api.listWorkspaces.mockResolvedValue([]);
    mocks.api.createWorkspace.mockResolvedValue(WORKSPACE);

    const store = useAppStore();
    await store.init();

    expect(mocks.api.createWorkspace).toHaveBeenCalledWith("Default");
    expect(store.workspaces).toHaveLength(1);
  });
});

describe("provider and model resolution", () => {
  it("uses the configured default when nothing overrides it", async () => {
    const store = await readyStore();
    expect(store.currentProviderId).toBe("p1");
    expect(store.effectiveModelId).toBe("m1");
  });

  it("lets the session's own settings win", async () => {
    const store = await readyStore({
      sessions: [session({ settings: { providerId: "p2", modelId: "m3" } })],
    });
    expect(store.currentProviderId).toBe("p2");
    expect(store.effectiveModelId).toBe("m3");
  });

  it("lets the copilot's defaults sit between the session and the app default", async () => {
    const copilot: Copilot = {
      id: "c1",
      name: "Coach",
      description: "",
      systemPrompt: "",
      tools: [],
      settings: { providerId: "p1", modelId: "m2" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    mocks.api.listCopilots.mockResolvedValue([copilot]);

    const store = await readyStore({ sessions: [session({ copilotId: "c1" })] });
    // Provider falls through to the app default; the model comes from the copilot.
    expect(store.currentProviderId).toBe("p1");
    expect(store.effectiveModelId).toBe("m2");
  });

  it("degrades when the session points at a provider that no longer exists", async () => {
    // A deleted provider must not leave a broken selection on screen. A model id the
    // surviving provider *does* serve survives — only the unusable half is dropped.
    const store = await readyStore({
      sessions: [session({ settings: { providerId: "gone", modelId: "gone-model" } })],
    });
    expect(store.currentProviderId).toBe("p1");
    expect(store.effectiveModelId).toBe("m1");
  });

  it("degrades when the session names a model its provider does not serve", async () => {
    const store = await readyStore({
      sessions: [session({ settings: { modelId: "not-served" } })],
    });
    expect(store.effectiveModelId).toBe("m1");
  });

  it("falls back to the provider's first model when nothing else resolves", async () => {
    mocks.api.getConfig.mockResolvedValue({ ...structuredClone(CONFIG), defaultModel: "nope" });
    const store = await readyStore();
    expect(store.effectiveModelId).toBe("m1");
  });

  it("reports vision support and the context window of the effective model", async () => {
    const store = await readyStore();
    expect(store.supportsVision).toBe(true);
    expect(store.contextWindow).toBe(1000);

    await store.updateSettings({ modelId: "m2" });
    expect(store.supportsVision).toBe(false);
    expect(store.contextWindow).toBeNull();
  });

  it("reports the app as unconfigured when no provider has a key", async () => {
    mocks.api.getConfig.mockResolvedValue({
      ...structuredClone(CONFIG),
      providers: [{ ...CONFIG.providers[1]! }],
      defaultProvider: "p2",
      defaultModel: "",
    });
    const store = await readyStore();
    expect(store.isConfigured).toBe(false);
  });

  it("reads the context size from the most recent assistant turn", async () => {
    const store = await readyStore({
      messages: [
        message({ role: "user", content: "q" }),
        message({ role: "assistant", content: "a", usage: { contextTokens: 1234 } }),
        message({ role: "user", content: "q2" }),
        message({ role: "assistant", content: "a2", usage: { inputTokens: 9 } }),
      ],
    });
    // The last turn reported no `contextTokens`, so the previous one still applies.
    expect(store.contextTokens).toBe(1234);
  });
});

describe("sendMessage", () => {
  it("does nothing for empty text with no attachments", async () => {
    const store = await readyStore();
    await store.sendMessage("   ");

    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(store.messages).toHaveLength(0);
  });

  it("ignores a second send while a stream is running", async () => {
    const store = await readyStore();
    streamOf({ type: "done" });
    store.streaming.active = true;

    await store.sendMessage("hi");
    expect(mocks.streamChat).not.toHaveBeenCalled();
  });

  it("shows the user's bubble immediately and posts the message", async () => {
    const store = await readyStore();
    streamOf({ type: "done" });

    await store.sendMessage("  hello  ");

    expect(mocks.streamChat).toHaveBeenCalledWith("s1", {
      message: "hello",
      copilotId: undefined,
      attachments: [],
    });
  });

  it("creates a session first when the workspace has none selected", async () => {
    const store = await readyStore();
    store.activeSessionId = null;
    streamOf({ type: "done" });

    await store.sendMessage("hi");

    expect(mocks.api.createSession).toHaveBeenCalled();
    expect(mocks.streamChat).toHaveBeenCalled();
  });

  it("accumulates reasoning and marks the turn as thinking", async () => {
    const store = await readyStore();
    // Gated so the assertion lands mid-stream: the store clears `thinking` when the turn
    // ends, so a stream that ran to completion would always read `false`.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: "reasoning", delta: "think " };
      yield { type: "reasoning", delta: "more" };
      await gate;
      yield { type: "done" };
    });

    const promise = store.sendMessage("why?");
    await vi.advanceTimersByTimeAsync(0);

    expect(store.streaming.reasoning).toBe("think more");
    expect(store.streaming.thinking).toBe(true);
    expect(store.streaming.active).toBe(true);

    release();
    await promise;
  });

  it("freezes the reasoning timer once the answer starts", async () => {
    const store = await readyStore();
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: "reasoning", delta: "thinking" };
      await new Promise((resolve) => setTimeout(resolve, 600));
      yield { type: "text", delta: "answer" };
      yield { type: "done" };
    });

    const promise = store.sendMessage("q");
    await vi.advanceTimersByTimeAsync(700);

    const frozen = store.streaming.reasoningMs;
    expect(frozen).toBeGreaterThan(0);
    expect(store.streaming.thinking).toBe(false);

    // Time keeps passing, but the recorded thinking time does not.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.streaming.reasoningMs).toBe(frozen);

    await promise;
  });

  it("clears the transient tool calls once the message lands", async () => {
    const store = await readyStore();
    streamOf(
      { type: "tool_start", toolCall: { id: "c1", name: "read_file", input: "{}" } },
      { type: "tool_end", toolCall: { id: "c1", name: "read_file", input: "{}", output: "contents" } },
      { type: "message_done", message: message({ id: "a1", role: "assistant", content: "read it" }) },
      { type: "done" }
    );

    await store.sendMessage("read it");
    expect(store.streaming.toolCalls).toEqual([]);
  });

  it("keeps tool calls visible while the turn is still streaming", async () => {
    const store = await readyStore();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    mocks.streamChat.mockImplementation(async function* () {
      yield { type: "tool_start", toolCall: { id: "c1", name: "read_file", input: "{}" } };
      await gate;
      yield { type: "tool_end", toolCall: { id: "c1", name: "read_file", input: "{}", output: "contents" } };
    });

    const promise = store.sendMessage("read it");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.streaming.toolCalls).toEqual([{ id: "c1", name: "read_file", input: "{}" }]);

    release();
    await promise;
    expect(store.streaming.toolCalls[0]!.output).toBe("contents");
  });

  it("records usage for the turn", async () => {
    const store = await readyStore();
    streamOf({ type: "usage", usage: { totalTokens: 42 } }, { type: "done" });
    await store.sendMessage("hi");
    expect(store.streaming.usage).toEqual({ totalTokens: 42 });
  });

  it("appends the finished message and clears the transient stream", async () => {
    const store = await readyStore();
    const reply = message({ id: "a1", role: "assistant", content: "the answer" });
    streamOf({ type: "text", delta: "the answer" }, { type: "message_done", message: reply }, { type: "done" });

    await store.sendMessage("q");

    expect(store.messages.some((m) => m.id === "a1")).toBe(true);
    expect(store.streaming.active).toBe(false);
    expect(store.streaming.content).toBe("");
    expect(store.streaming.reasoning).toBe("");
  });

  it("renames the session when the server titles it", async () => {
    const store = await readyStore();
    streamOf({ type: "title", sessionId: "s1", title: "Recursion Basics" }, { type: "done" });

    await store.sendMessage("what is recursion");

    expect(store.sessions.find((s) => s.id === "s1")!.title).toBe("Recursion Basics");
  });

  it("surfaces an error event without throwing", async () => {
    const store = await readyStore();
    streamOf({ type: "error", message: "provider exploded" }, { type: "done" });

    await store.sendMessage("q");

    expect(store.streaming.error).toBe("provider exploded");
    expect(store.streaming.active).toBe(false);
  });

  it("surfaces a transport failure", async () => {
    const store = await readyStore();
    mocks.streamChat.mockImplementation(async function* () {
      throw new Error("network down");
    });

    await store.sendMessage("q");

    expect(store.streaming.error).toBe("network down");
    expect(store.streaming.active).toBe(false);
  });

  it("refreshes the session list at the end of every turn", async () => {
    const store = await readyStore();
    streamOf({ type: "done" });
    await store.sendMessage("q");

    expect(mocks.api.listSessions).toHaveBeenCalledWith("w1");
  });

  it("does not let a session refresh failure break the turn", async () => {
    const store = await readyStore();
    streamOf({ type: "done" });
    mocks.api.listSessions.mockRejectedValue(new Error("offline"));

    await expect(store.sendMessage("q")).resolves.toBeUndefined();
  });
});

describe("sessions", () => {
  it("selects a session and loads its messages", async () => {
    const store = await readyStore({ messages: [message({ role: "user", content: "old" })] });
    expect(store.messages).toHaveLength(1);
    expect(store.streaming.active).toBe(false);
  });

  it("carries settings picked before the session existed onto the new session", async () => {
    const store = await readyStore();
    store.activeSessionId = null;
    await store.updateSettings({ temperature: 0.4, maxSteps: 3 });
    expect(store.draftSettings).toEqual({ temperature: 0.4, maxSteps: 3 });

    await store.createSession();

    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", { settings: { temperature: 0.4, maxSteps: 3 } });
    expect(store.draftSettings).toEqual({});
  });

  it("does not call the API when there are no staged settings", async () => {
    const store = await readyStore();
    store.activeSessionId = null;
    mocks.api.updateSession.mockClear();

    await store.createSession();

    expect(mocks.api.updateSession).not.toHaveBeenCalled();
  });

  it("trims a rename and ignores a blank one", async () => {
    const store = await readyStore();
    await store.renameSession("s1", "  New Title  ");
    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", { title: "New Title" });

    mocks.api.updateSession.mockClear();
    await store.renameSession("s1", "   ");
    expect(mocks.api.updateSession).not.toHaveBeenCalled();
  });

  it("clears the active state when the selected session is deleted", async () => {
    const store = await readyStore();
    await store.deleteSession("s1");

    expect(store.activeSessionId).toBeNull();
    expect(store.messages).toEqual([]);
    expect(store.pendingAttachments).toEqual([]);
  });

  it("moves to the first workspace when the active one is deleted", async () => {
    const store = await readyStore();
    mocks.api.listWorkspaces.mockResolvedValue([]);

    await store.deleteWorkspace("w1");

    expect(store.activeWorkspaceId).toBeNull();
    expect(mocks.api.listSessions).not.toHaveBeenCalled();
  });

  it("applies generation settings to the active session", async () => {
    const store = await readyStore();
    await store.updateSettings({ temperature: 0.9 });

    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", { settings: { temperature: 0.9 } });
    expect(store.sessionSettings.temperature).toBe(0.9);
  });
});

describe("attachments", () => {
  it("rejects a file over the size cap before uploading", async () => {
    const store = await readyStore();
    const oversized = new File([new Uint8Array(1)], "big.bin");
    Object.defineProperty(oversized, "size", { value: MAX_ATTACHMENT_BYTES + 1 });

    await expect(store.uploadAttachment(oversized)).resolves.toBeNull();
    expect(store.error).toContain("超过");
    expect(mocks.api.uploadAttachment).not.toHaveBeenCalled();
  });

  it("uploads and stages the attachment", async () => {
    const store = await readyStore();
    const attachment = { id: "a1", name: "a.txt", mimeType: "text/plain", size: 3, kind: "file" as const };
    mocks.api.uploadAttachment.mockResolvedValue(attachment);

    await expect(store.uploadAttachment(new File(["hi"], "a.txt"))).resolves.toEqual(attachment);
    expect(store.pendingAttachments).toEqual([attachment]);
  });

  it("creates a session first, because uploads are stored per session", async () => {
    const store = await readyStore();
    store.activeSessionId = null;
    mocks.api.uploadAttachment.mockResolvedValue({
      id: "a1",
      name: "a.txt",
      mimeType: "text/plain",
      size: 3,
      kind: "file",
    });

    await store.uploadAttachment(new File(["hi"], "a.txt"));
    expect(mocks.api.createSession).toHaveBeenCalled();
  });

  it("reports an upload failure instead of throwing", async () => {
    const store = await readyStore();
    mocks.api.uploadAttachment.mockRejectedValue(new Error("too large"));

    await expect(store.uploadAttachment(new File(["hi"], "a.txt"))).resolves.toBeNull();
    expect(store.error).toBe("too large");
  });

  it("removes and clears staged attachments", async () => {
    const store = await readyStore();
    store.pendingAttachments = [
      { id: "a1", name: "a.txt", mimeType: "text/plain", size: 1, kind: "file" },
      { id: "a2", name: "b.txt", mimeType: "text/plain", size: 1, kind: "file" },
    ];

    store.removePendingAttachment("a1");
    expect(store.pendingAttachments.map((a) => a.id)).toEqual(["a2"]);

    store.clearPendingAttachments();
    expect(store.pendingAttachments).toEqual([]);
  });

  it("clears staged attachments once they have been sent", async () => {
    const store = await readyStore();
    store.pendingAttachments = [{ id: "a1", name: "a.txt", mimeType: "text/plain", size: 1, kind: "file" }];
    streamOf({ type: "done" });

    await store.sendMessage("look", store.pendingAttachments);

    expect(store.pendingAttachments).toEqual([]);
  });
});
