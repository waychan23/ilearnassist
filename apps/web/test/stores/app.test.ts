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
import { i18n } from "../../src/i18n.js";

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
    renameWorkspace: vi.fn(),
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
    listAttachmentStatus: vi.fn(),
    reparseAttachment: vi.fn(),
    listParserKinds: vi.fn(),
    listDocumentParsers: vi.fn(),
    createDocumentParser: vi.fn(),
    updateDocumentParser: vi.fn(),
    deleteDocumentParser: vi.fn(),
    testDocumentParser: vi.fn(),
    updateDocumentParsing: vi.fn(),
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
  sessionCount: 0,
  lastActivityAt: null,
};

const CONFIG: PublicConfig = {
  defaultProvider: "p1",
  defaultModel: "m1",
  workspacesRootDir: "/tmp/ws",
  webSearchProvider: "bing",
  documentParsers: [],
  documentParsing: {
    localEnabled: true,
    policy: "local-first",
    fallbackEnabled: true,
    defaultParserId: null,
  },
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
  // The store renders some errors through i18n, and jsdom's navigator is en-US. Pin the
  // locale so an assertion on wording is asserting the message, not the ambient locale.
  i18n.global.locale.value = "zh-CN";
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

  it("renames a workspace in place", async () => {
    const store = await readyStore();
    mocks.api.renameWorkspace.mockResolvedValue({
      ...WORKSPACE,
      name: "Renamed",
      sessionCount: 3,
    });

    await store.renameWorkspace("w1", "  Renamed  ");

    // Trimmed on the way out, and the server's own record — stats included — is what the
    // card is rebuilt from rather than a local patch of the name.
    expect(mocks.api.renameWorkspace).toHaveBeenCalledWith("w1", "Renamed");
    expect(store.workspaces).toEqual([{ ...WORKSPACE, name: "Renamed", sessionCount: 3 }]);
  });

  it("does not call the API for a rename that would be blank", async () => {
    const store = await readyStore();
    await store.renameWorkspace("w1", "   ");
    expect(mocks.api.renameWorkspace).not.toHaveBeenCalled();
  });

  it("re-reads the workspace list without disturbing the active one", async () => {
    const store = await readyStore();
    mocks.api.listWorkspaces.mockResolvedValue([{ ...WORKSPACE, sessionCount: 7 }]);
    mocks.api.listSessions.mockClear();

    await store.refreshWorkspaces();

    // The counts are the point: a conversation started since the page was last rendered
    // has to show up on the card the user is about to look at.
    expect(store.workspaces[0]!.sessionCount).toBe(7);
    // But the user is on their way somewhere, not arriving — the selection survives, and
    // so does the conversation list it belongs to.
    expect(store.activeWorkspaceId).toBe("w1");
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

describe("document parsing", () => {
  const PDF = {
    id: "d1",
    name: "lecture.pdf",
    mimeType: "application/pdf",
    size: 1000,
    kind: "file" as const,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls for parse state while a document is settling, then stops", async () => {
    const store = await readyStore();
    mocks.api.uploadAttachment.mockResolvedValue({ ...PDF, parseStatus: "pending" });
    mocks.api.listAttachmentStatus
      .mockResolvedValueOnce({ d1: { status: "parsing", updatedAt: "" } })
      .mockResolvedValue({ d1: { status: "ready", parsedChars: 4200, pageCount: 3, updatedAt: "" } });

    await store.uploadAttachment(new File(["x"], "lecture.pdf"));
    // The first poll fires immediately rather than after a full interval.
    await vi.advanceTimersByTimeAsync(0);
    expect(store.pendingAttachments[0]!.parseStatus).toBe("parsing");
    expect(store.documentsParsing).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);
    expect(store.pendingAttachments[0]!.parseStatus).toBe("ready");
    expect(store.pendingAttachments[0]!.parsedChars).toBe(4200);
    expect(store.documentsParsing).toBe(false);

    // Settled: no further polling, so an idle composer does not keep asking the server.
    const calls = mocks.api.listAttachmentStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.api.listAttachmentStatus).toHaveBeenCalledTimes(calls);
  });

  it("does not poll for an attachment that needs no parsing", async () => {
    const store = await readyStore();
    mocks.api.uploadAttachment.mockResolvedValue({
      id: "t1",
      name: "a.txt",
      mimeType: "text/plain",
      size: 3,
      kind: "file",
    });

    await store.uploadAttachment(new File(["hi"], "a.txt"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.api.listAttachmentStatus).not.toHaveBeenCalled();
    expect(store.documentsParsing).toBe(false);
  });

  it("surfaces a parse failure on the attachment", async () => {
    const store = await readyStore();
    mocks.api.uploadAttachment.mockResolvedValue({ ...PDF, parseStatus: "pending" });
    mocks.api.listAttachmentStatus.mockResolvedValue({
      d1: { status: "failed", error: "未检测到文本层", updatedAt: "" },
    });

    await store.uploadAttachment(new File(["x"], "lecture.pdf"));
    await vi.advanceTimersByTimeAsync(2000);

    expect(store.pendingAttachments[0]!.parseStatus).toBe("failed");
    expect(store.pendingAttachments[0]!.parseError).toBe("未检测到文本层");
    expect(store.documentsParsing).toBe(false);
  });

  it("re-parses and keeps polling until the retry settles", async () => {
    const store = await readyStore();
    const failed = { ...PDF, parseStatus: "failed" as const, parseError: "boom" };
    store.pendingAttachments = [failed];
    mocks.api.reparseAttachment.mockResolvedValue({ status: "pending" });
    // First poll still in progress, second one done — that is what makes the loop keep
    // going for a re-parse when nothing is staged in the composer.
    mocks.api.listAttachmentStatus
      .mockResolvedValueOnce({ d1: { status: "parsing", updatedAt: "" } })
      .mockResolvedValue({ d1: { status: "ready", parsedChars: 10, updatedAt: "" } });

    await store.reparseAttachment(failed);
    expect(mocks.api.reparseAttachment).toHaveBeenCalledWith("s1", "d1", "lecture.pdf");
    // Nothing is *pending* in the composer, so polling would stop immediately were it not
    // for the re-parse being tracked — this is the case that needs the extra bookkeeping.
    expect(store.pendingAttachments[0]!.parseStatus).not.toBe("failed");

    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.api.listAttachmentStatus.mock.calls.length).toBeGreaterThan(1);
    expect(store.pendingAttachments[0]!.parseStatus).toBe("ready");
    expect(store.pendingAttachments[0]!.parseError).toBeUndefined();
  });

  it("stops polling when the staged attachments are cleared", async () => {
    const store = await readyStore();
    mocks.api.uploadAttachment.mockResolvedValue({ ...PDF, parseStatus: "pending" });
    mocks.api.listAttachmentStatus.mockResolvedValue({
      d1: { status: "parsing", updatedAt: "" },
    });

    await store.uploadAttachment(new File(["x"], "lecture.pdf"));
    await vi.advanceTimersByTimeAsync(0);

    store.clearPendingAttachments();
    const calls = mocks.api.listAttachmentStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.api.listAttachmentStatus).toHaveBeenCalledTimes(calls);
  });
});

describe("document parser settings", () => {
  it("saves a new parser and folds the result into config", async () => {
    const store = await readyStore();
    const created = {
      id: "p1",
      name: "Docling",
      kind: "sync" as const,
      baseURL: "http://127.0.0.1:5001",
      enabled: true,
      hasApiKey: false,
    };
    mocks.api.createDocumentParser.mockResolvedValue(created);

    await store.saveDocumentParser({
      name: "Docling",
      kind: "sync",
      baseURL: "http://127.0.0.1:5001",
      apiKey: "",
      enabled: true,
    });

    // A blank key is omitted entirely so the server keeps whatever it has stored.
    expect(mocks.api.createDocumentParser.mock.calls[0]![0]).not.toHaveProperty("apiKey");
    expect(store.config?.documentParsers).toEqual([created]);
  });

  it("sends a key when one was typed", async () => {
    const store = await readyStore();
    mocks.api.createDocumentParser.mockResolvedValue({
      id: "p1",
      name: "MinerU",
      kind: "mineru",
      baseURL: "https://mineru.net/api/v4",
      enabled: true,
      hasApiKey: true,
    });

    await store.saveDocumentParser({
      name: "MinerU",
      kind: "mineru",
      baseURL: "https://mineru.net/api/v4",
      apiKey: "secret",
      enabled: true,
    });

    expect(mocks.api.createDocumentParser.mock.calls[0]![0]).toMatchObject({ apiKey: "secret" });
  });

  it("updates the parsing policy in place", async () => {
    const store = await readyStore();
    mocks.api.updateDocumentParsing.mockResolvedValue({
      localEnabled: true,
      policy: "cloud-first",
      fallbackEnabled: false,
      defaultParserId: null,
    });

    await store.setDocumentParsing({ policy: "cloud-first", fallbackEnabled: false });
    expect(store.config?.documentParsing.policy).toBe("cloud-first");
    expect(store.config?.documentParsing.fallbackEnabled).toBe(false);
  });

  it("removes a deleted parser from config", async () => {
    const store = await readyStore();
    mocks.api.deleteDocumentParser.mockResolvedValue({ ok: true });
    mocks.api.getConfig.mockResolvedValue({ ...CONFIG, documentParsers: [] });

    await store.deleteDocumentParser("p1");
    expect(store.config?.documentParsers).toEqual([]);
  });

  it("fetches the protocol kinds once", async () => {
    const store = await readyStore();
    mocks.api.listParserKinds.mockResolvedValue([
      { kind: "sync", label: "Sync", requiresApiKey: false },
    ]);

    await store.loadParserKinds();
    await store.loadParserKinds();
    expect(mocks.api.listParserKinds).toHaveBeenCalledTimes(1);
    expect(store.parserKinds).toHaveLength(1);
  });
});
