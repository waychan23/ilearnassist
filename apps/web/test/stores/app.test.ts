import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatStreamEvent,
  Copilot,
  DirectoryListing,
  FileEntry,
  Message,
  PublicConfig,
  Session,
  SessionLockView,
  Source,
  User,
  WidgetId,
  WidgetState,
  Workspace,
} from "@ilearnassist/shared";
import { MAX_ATTACHMENT_BYTES } from "@ilearnassist/shared";
import { i18n } from "../../src/i18n.js";
import { uiState } from "../../src/composables/ui.js";

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
    setSessionPinned: vi.fn(),
    deleteSession: vi.fn(),
    reportSessionLeave: vi.fn().mockResolvedValue({ status: "skipped" }),
    /**
     * The session write lock. Given a resting value rather than left `undefined`, for the same
     * reason the export state is: `selectSession` and `selectWorkspace` both reach for these on
     * the way in, and an `undefined` would be a TypeError swallowed by their own catch — every
     * test paying for a failure none of them is about.
     */
    acquireSessionLock: vi.fn().mockResolvedValue({
      lock: { sessionId: "s1", clientId: "c", mine: true, acquiredAt: "t", expiresAt: "t" },
    }),
    releaseSessionLock: vi.fn().mockResolvedValue({ released: true }),
    listWorkspaceLocks: vi.fn().mockResolvedValue({ locks: [] }),
    listMessages: vi.fn(),
    listWorkspaceWidgets: vi.fn(),
    setWorkspaceWidget: vi.fn(),
    listSessionWidgets: vi.fn(),
    setSessionWidget: vi.fn(),
    getWorkspaceStats: vi.fn(),
    getSessionStats: vi.fn(),
    getPlan: vi.fn(),
    getPlanVersion: vi.fn(),
    jumpPlanNode: vi.fn(),
    listQuizQuestions: vi.fn().mockResolvedValue({ questions: [] }),
    answerQuizQuestion: vi.fn(),
    getSessionThreads: vi.fn().mockResolvedValue({ threads: [], unassigned: 0 }),
    syncSessionThreads: vi.fn().mockResolvedValue({ threads: [], unassigned: 0 }),
    stopSession: vi.fn(),
    // `selectSession` reads the export state on the way in, so these need a resting value rather
    // than `undefined` — the store tolerates a failure, but every test would pay for it.
    startNoteSync: vi.fn(),
    getNoteSync: vi.fn().mockResolvedValue({ sync: null }),
    listFiles: vi.fn(),
    readFileContent: vi.fn(),
    listSessionFiles: vi.fn(),
    readSessionFileContent: vi.fn(),
    uploadAttachment: vi.fn(),
    listSessionSources: vi.fn(),
    listSources: vi.fn(),
    deleteSource: vi.fn(),
    reparseSource: vi.fn(),
    listParserKinds: vi.fn(),
    listDocumentParsers: vi.fn(),
    createDocumentParser: vi.fn(),
    updateDocumentParser: vi.fn(),
    deleteDocumentParser: vi.fn(),
    testDocumentParser: vi.fn(),
    updateDocumentParsing: vi.fn(),
    deleteProvider: vi.fn(),
    deleteModel: vi.fn(),
    deleteMessage: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    me: vi.fn(),
    changePassword: vi.fn(),
    updateProfile: vi.fn(),
    listAccounts: vi.fn(),
    createAccount: vi.fn(),
    updateAccount: vi.fn(),
    resetAccountPassword: vi.fn(),
    revokeAccountSessions: vi.fn(),
  },
  /**
   * The router, which the store pushes to in the two places a *write* moves the app — a
   * conversation it just made, and the fork a plan edit opens. There is no component to push
   * from in either case, which is why the store holds it at all.
   *
   * Mocked rather than built: this file tests the store, and a real router would drag the lazy
   * route components (and their own imports) into a suite that has no browser.
   */
  router: { push: vi.fn(), replace: vi.fn() },
  streamChat: vi.fn(),
  streamAnswers: vi.fn(),
  streamRegenerate: vi.fn(),
  fileToBase64: vi.fn(),
  /**
   * The client's 401 callback, captured rather than stubbed.
   *
   * The store registers one at setup, and most tests only need it to *exist* — but the
   * session-expiry path is worth a test of its own, and that needs to be able to fire it.
   */
  setUnauthenticatedHandler: vi.fn(),
}));

vi.mock("../../src/router", () => ({ router: mocks.router }));

vi.mock("../../src/api/client", () => ({
  api: mocks.api,
  streamChat: mocks.streamChat,
  streamAnswers: mocks.streamAnswers,
  streamRegenerate: mocks.streamRegenerate,
  fileToBase64: mocks.fileToBase64,
  setUnauthenticatedHandler: mocks.setUnauthenticatedHandler,
  sourceImageUrl: (sourceId: string) => Promise.resolve(`blob:sources/${sourceId}`),
}));

const { useAppStore } = await import("../../src/stores/app.js");
const { ApiError } = await import("../../src/utils/apiError.js");

/* --------------------------------- fixtures -------------------------------- */

const ACCOUNT: User = {
  id: "u1",
  username: "Ada",
  slug: "ada",
  roles: ["superadmin"],
  mustChangePassword: false,
  about: "",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** What a token pair looks like on the wire. The store never reads it — `api` stores it. */
const TOKENS = { accessToken: "at", refreshToken: "rt", expiresIn: 86_400 };

const WORKSPACE: Workspace = {
  id: "w1",
  name: "Notes",
  slug: "notes",
  dirPath: "/tmp/notes",
  workdirPath: "/tmp/notes/workdir",
  description: "",
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
  // The installation's upload cap. Present because a config without it is not one the store ever
  // sees, and `uploadLimitBytes` reads it.
  maxUploadBytes: 10 * 1024 * 1024,
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
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: "(Untitled) Session",
    titleSource: "auto",
    settings: {},
    description: "",
    pinned: false,
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

/**
 * A source as the parse-status poll reports it — the server's own row for the file.
 *
 * An upload, since that is what this store deals with today: owned by the conversation it
 * arrived in, stored as a blob, and classified by its type. The newer fields are filled in
 * rather than left to the type to make optional, because a source without them is a source the
 * server does not produce.
 */
function sourceOf(overrides: Partial<Source> & Pick<Source, "id">): Source {
  return {
    name: "lecture.pdf",
    mimeType: "application/pdf",
    size: 1000,
    kind: "file",
    parseStatus: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
    ownerKind: "session",
    ownerId: "s1",
    origin: "session_attachment",
    storage: "upload",
    category: "document",
    ...overrides,
  };
}

function copilotFixture(id: string, userId: string): Copilot {
  return {
    id,
    userId,
    name: id,
    description: "",
    systemPrompt: "",
    allTools: false,
    // A restriction, so a copy that dropped the flag would be visible: it would come back as
    // every tool rather than this one.
    tools: ["read_file"],
    settings: {},
    // A selection, so a copy that dropped it would be visible — the same reason the tool list
    // above is a restriction rather than empty.
    widgets: ["session_stats"],
    visibility: "private",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function streamOf(...events: ChatStreamEvent[]) {
  mocks.streamChat.mockImplementation(async function* () {
    for (const event of events) yield event;
  });
}

/**
 * A widget state, resolved as the server resolves it: one entry per widget this build knows.
 *
 * The default is **nothing installed**, which is also what a fresh object gets — so a test that
 * is not about widgets sees the same layout it saw before they existed, and the ones that are
 * about widgets say what they installed.
 */
function widgetState(...enabled: WidgetId[]): WidgetState[] {
  return [
    { id: "workspace_stats", scope: "workspace", enabled: enabled.includes("workspace_stats") },
    { id: "session_stats", scope: "session", enabled: enabled.includes("session_stats") },
  ];
}

/**
 * What used to be `store.init()`, as the two questions it turned out to be.
 *
 * `probeAccount` answers *who is asking* and `ensureLoaded` answers *what they get*, and the
 * split is the router's: whether to load anything at all depends on which page the URL names,
 * so the decision lives in `router/guards.ts` and the store answers the two halves. A test
 * that is not about a refused page wants both, in this order.
 */
async function enterApp(store: ReturnType<typeof useAppStore>): Promise<void> {
  await store.probeAccount();
  await store.ensureLoaded();
}

/** Put the store in a state where a session is selected and ready to chat. */
async function readyStore(
  options: { sessions?: Session[]; messages?: Message[]; widgets?: WidgetId[] } = {}
) {
  mocks.api.listSessions.mockResolvedValue(options.sessions ?? [session()]);
  mocks.api.listMessages.mockResolvedValue(options.messages ?? []);
  // The conversation read answers both groups, so one state serves both keys.
  const states = widgetState(...(options.widgets ?? []));
  mocks.api.listSessionWidgets.mockResolvedValue({
    workspace: states.filter((w) => w.scope === "workspace"),
    session: states.filter((w) => w.scope === "session"),
  });
  mocks.api.listWorkspaceWidgets.mockResolvedValue(
    states.filter((w) => w.scope === "workspace")
  );

  const store = useAppStore();
  await enterApp(store);
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

  // Signed in by default, because that is the state almost every test is about; the
  // signed-out, first-run and pending-password cases say so themselves.
  mocks.api.me.mockResolvedValue(structuredClone(ACCOUNT));
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
  /*
   * The lock calls are re-established here rather than only in the hoisted factory, because
   * `vi.clearAllMocks()` clears *calls* and not implementations — so a test that made the
   * acquire refuse (the read-only case) would leave it refusing for every test after it. The
   * rest of this block exists for the same reason.
   */
  mocks.api.acquireSessionLock.mockResolvedValue({
    lock: {
      sessionId: "s1",
      clientId: "this-client",
      mine: true,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:02:00.000Z",
    },
  });
  mocks.api.releaseSessionLock.mockResolvedValue({ released: true });
  mocks.api.listWorkspaceLocks.mockResolvedValue({ locks: [] });
  mocks.fileToBase64.mockResolvedValue("aGk=");
  // Re-established here for the same reason as the locks above: a navigation *resolves*, and
  // the store awaits one before it goes on to name a widget tab.
  mocks.router.push.mockResolvedValue(undefined);
  mocks.router.replace.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/* ----------------------------------- tests ---------------------------------- */

describe("init", () => {
  it("loads config, workspaces, copilots and sessions", async () => {
    const store = useAppStore();
    await enterApp(store);

    expect(mocks.api.listCopilots).toHaveBeenCalled();
    expect(store.config).toEqual(CONFIG);
    expect(store.workspaces).toHaveLength(1);
    expect(store.activeWorkspaceId).toBe("w1");
  });

  it("creates a default workspace when none exist", async () => {
    mocks.api.listWorkspaces.mockResolvedValue([]);
    mocks.api.createWorkspace.mockResolvedValue(WORKSPACE);

    const store = useAppStore();
    await enterApp(store);

    // The widget list is **omitted**, not sent empty, and that is the distinction the API is
    // built on: this workspace was created by the app rather than by the dialog, so nobody made a
    // choice about it and it takes the server's default rather than asserting "none".
    // The description is `""` rather than absent: the two are the same claim there, and a
    // workspace nobody described is stored as an empty string either way.
    expect(mocks.api.createWorkspace).toHaveBeenCalledWith("默认工作区", undefined, "");
    expect(store.workspaces).toHaveLength(1);
  });

  it("asks who the caller is before loading anything", async () => {
    // Order matters, and not as a style point: everything below is scoped to an account, so
    // loading first would be a set of requests that are about to 401.
    const store = useAppStore();
    await enterApp(store);

    expect(mocks.api.me).toHaveBeenCalled();
    expect(store.account).toEqual(ACCOUNT);
    expect(uiState.authReady).toBe(true);
  });

  it("shows the login screen when nobody is signed in, and loads nothing", async () => {
    // The 401 is caught rather than reported: on a fresh installation this is the ordinary
    // first visit, not a failure, and a toast about it would be the first thing anyone sees.
    mocks.api.me.mockRejectedValue(new ApiError("UNAUTHENTICATED", "no session", 401));

    const store = useAppStore();
    await store.probeAccount();

    expect(store.account).toBeNull();
    expect(uiState.authReady).toBe(true);
    expect(store.error).toBeNull();
    expect(mocks.api.getConfig).not.toHaveBeenCalled();
    expect(mocks.api.listWorkspaces).not.toHaveBeenCalled();
  });
});

describe("uploaded files", () => {
  it("loads the account's files on demand, not with everything else", async () => {
    // `init` must not fetch the whole library: this is a dialog most sessions never open.
    const store = useAppStore();
    await enterApp(store);
    expect(mocks.api.listSources).not.toHaveBeenCalled();

    mocks.api.listSources.mockResolvedValue([sourceOf({ id: "a1", name: "one.pdf" })]);
    await store.loadSources();

    expect(store.sources.map((s) => s.name)).toEqual(["one.pdf"]);
    expect(store.sourcesLoading).toBe(false);
  });

  it("reports a failed load inside the dialog, not as a toast", async () => {
    // The user asked for this, so the place to say it failed is where they are looking.
    mocks.api.listSources.mockRejectedValue(new ApiError("SOURCE_NOT_FOUND", "gone", 404));

    const store = useAppStore();
    await store.loadSources();

    expect(store.sourcesError).toBe("gone");
    expect(store.error).toBeNull();
  });

  it("drops a deleted file from the list and from the live overlay", async () => {
    mocks.api.listSources.mockResolvedValue([
      sourceOf({ id: "a1" }),
      sourceOf({ id: "a2", name: "keep.pdf" }),
    ]);
    mocks.api.deleteSource.mockResolvedValue({ ok: true });

    const store = useAppStore();
    await store.loadSources();
    // A chip on a sent message is being overlaid from this map; leaving the entry behind
    // would keep showing parse state for a file that no longer exists.
    store.parseStatus = { a1: sourceOf({ id: "a1" }), a2: sourceOf({ id: "a2" }) };

    await store.deleteSource("a1");

    expect(mocks.api.deleteSource).toHaveBeenCalledWith("a1");
    expect(store.sources.map((s) => s.id)).toEqual(["a2"]);
    expect(store.parseStatus["a1"]).toBeUndefined();
    expect(store.parseStatus["a2"]).toBeDefined();
  });

  it("keeps the row when the delete fails, and says why", async () => {
    mocks.api.listSources.mockResolvedValue([sourceOf({ id: "a1" })]);
    mocks.api.deleteSource.mockRejectedValue(new ApiError("SOURCE_NOT_FOUND", "gone", 404));

    const store = useAppStore();
    await store.loadSources();
    await store.deleteSource("a1");

    // The file is still there as far as the server is concerned, so the list must not have
    // pretended otherwise — a row that vanishes and comes back is worse than an error.
    expect(store.sources.map((s) => s.id)).toEqual(["a1"]);
    expect(store.sourcesError).toBe("gone");
  });
});

describe("signing in and out", () => {
  it("takes the account, and loads nothing of its own accord", async () => {
    /*
     * The split that a first-run account made concrete. An account an administrator created owes
     * a password change, and the server refuses everything but three routes until it is settled —
     * so a load attempted on the way in is a page of 403s, and from the *form* it reads as "that
     * password is wrong", which is the one thing a sign-in failure must not say by accident.
     *
     * Where to land is the guard's call (it reads the `redirect` a refusal carried) and so is
     * whether to load (it asks about the password first). The store's half is the account.
     */
    mocks.api.login.mockResolvedValue({ user: structuredClone(ACCOUNT), tokens: TOKENS });

    const store = useAppStore();
    await store.signIn("  Ada  ", "hunter2");

    // Trimmed here rather than at the field: the screen accepts a name with a stray space and
    // the account the user means to sign in as is the one without it.
    expect(mocks.api.login).toHaveBeenCalledWith("Ada", "hunter2");
    expect(store.account).toEqual(ACCOUNT);
    expect(mocks.api.listWorkspaces).not.toHaveBeenCalled();
    expect(store.activeWorkspaceId).toBeNull();

    // And the load is still there to be asked for, which is what the guard does next.
    await store.ensureLoaded();
    expect(store.activeWorkspaceId).toBe("w1");
  });

  it("loads once, however many navigations ask", async () => {
    // `ensureLoaded` answers with one memoised promise, and the guard runs on every navigation
    // into a signed-in page — so a reload that lands on a conversation must not fetch the
    // account's config on the way past each hop.
    const store = useAppStore();
    await enterApp(store);
    await store.ensureLoaded();
    await store.ensureLoaded();

    expect(mocks.api.getConfig).toHaveBeenCalledTimes(1);
  });

  it("loads again for the next account", async () => {
    // Signing out forgets the *promise*, not merely its results — otherwise the next account is
    // handed a load that happened for somebody else, and an empty workspace list with nothing on
    // the way to fill it.
    mocks.api.login.mockResolvedValue({ user: structuredClone(ACCOUNT), tokens: TOKENS });
    const store = await readyStore();

    await store.signOut();
    await store.signIn("Ada", "hunter2");
    await store.ensureLoaded();

    expect(mocks.api.getConfig).toHaveBeenCalledTimes(2);
  });

  it("holds an account that still owes a password on the change screen", async () => {
    // The server refuses every other route in this state, so loading the app behind the screen
    // would produce a workspace list of failing requests. The screen comes first instead.
    mocks.api.me.mockResolvedValue(
      structuredClone({ ...ACCOUNT, mustChangePassword: true } as User)
    );

    const store = useAppStore();
    await store.probeAccount();

    // Held by the *guard*, which reads this flag and refuses every other route — and the server
    // refuses them too. What the store owes is to have loaded nothing behind the screen.
    expect(store.account?.mustChangePassword).toBe(true);
    expect(mocks.api.getConfig).not.toHaveBeenCalled();
    expect(mocks.api.listWorkspaces).not.toHaveBeenCalled();
  });

  it("enters the app once that password has been chosen", async () => {
    mocks.api.me.mockResolvedValue(
      structuredClone({ ...ACCOUNT, mustChangePassword: true } as User)
    );
    mocks.api.changePassword.mockResolvedValue({
      user: structuredClone(ACCOUNT),
      tokens: TOKENS,
    });

    const store = useAppStore();
    await enterApp(store);
    await store.changePassword("issued-password", "chosen-password");
    await store.ensureLoaded();

    expect(store.account?.mustChangePassword).toBe(false);
    expect(store.activeWorkspaceId).toBe("w1");
    expect(mocks.api.listWorkspaces).toHaveBeenCalled();
  });

  it("adopts the server's own wording when the introduction is saved", async () => {
    /*
     * The route trims, so echoing the textarea's value back would leave the field showing
     * whitespace the record does not hold — and a reload would then look like it had changed the
     * text. The store takes the answer rather than the input, which is the only version of this
     * that cannot drift.
     */
    mocks.api.updateProfile.mockResolvedValue(
      structuredClone({ ...ACCOUNT, about: "Backend dev, learning ML." } as User)
    );
    const store = await readyStore();

    await store.saveProfile("   Backend dev, learning ML.   ");

    expect(mocks.api.updateProfile).toHaveBeenCalledWith("   Backend dev, learning ML.   ");
    expect(store.account?.about).toBe("Backend dev, learning ML.");
  });

  it("lets a failed save be reported rather than swallowing it", async () => {
    // Deliberately unlike the fire-and-forget passes in this store: this is a write the user
    // pressed a button for and is watching, so the card has to be able to say it did not land.
    mocks.api.updateProfile.mockRejectedValue(new Error("nope"));
    const store = await readyStore();
    const before = store.account?.about;

    await expect(store.saveProfile("anything")).rejects.toThrow("nope");
    expect(store.account?.about).toBe(before);
  });

  it("forgets everything on the way out", async () => {
    // Not just the name: a workspace list or a half-written conversation left on screen is
    // the next person's problem, and on a shared machine that is a real one.
    mocks.api.logout.mockResolvedValue({ ok: true });
    const store = await readyStore();
    expect(store.workspaces).toHaveLength(1);

    await store.signOut();

    expect(store.account).toBeNull();
    expect(store.workspaces).toEqual([]);
    expect(store.copilots).toEqual([]);
    expect(store.sessions).toEqual([]);
    expect(store.messages).toEqual([]);
    expect(store.activeWorkspaceId).toBeNull();
  });

  it("lands on the login screen even when the logout request fails", async () => {
    // Clearing the token is the server's job and a failed logout cannot be retried locally —
    // but leaving someone looking signed in because a request failed is the worse outcome of
    // the two. The failure is reported rather than swallowed, because the stored token is
    // still there and a reload will sign them back in.
    mocks.api.logout.mockRejectedValue(new ApiError("INTERNAL", "boom", 500));
    const store = await readyStore();

    await store.signOut();

    expect(store.account).toBeNull();
    expect(store.workspaces).toEqual([]);
    expect(store.error).toBeTruthy();
  });

  it("stops applying a turn that was still arriving when the account went away", async () => {
    /*
     * Signing out does not close the stream, so a turn the previous account started keeps
     * delivering frames. Without the account-epoch check those deltas land in whatever state
     * the *next* account has by then — one person's reply text appearing in another's
     * conversation, which is exactly the kind of thing signing out is supposed to prevent.
     */
    const store = await readyStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    mocks.streamChat.mockImplementation(async function* () {
      yield { type: "text", delta: "before" } as ChatStreamEvent;
      await gate;
      yield { type: "text", delta: "after" } as ChatStreamEvent;
    });

    const turn = store.sendMessage("hi");
    // Let the first frame be applied while the account is still there.
    await vi.waitFor(() => expect(store.streaming.content).toBe("before"));

    await store.signOut();
    release();
    await turn;

    expect(store.streaming.content).toBe("");
    expect(store.messages).toEqual([]);
  });

  it("explains an expired session and clears the account when a request 401s", async () => {
    // The handler the client calls: the session went away under a tab that was open. Both
    // halves matter — the screen alone reads as the app having forgotten something, and the
    // toast alone leaves the user on a page none of whose controls will work.
    const store = await readyStore();

    const handler = mocks.setUnauthenticatedHandler.mock.calls.at(-1)?.[0] as () => void;
    handler();

    expect(store.account).toBeNull();
    expect(store.workspaces).toEqual([]);
    expect(store.error).toBe(i18n.global.t("errors.UNAUTHENTICATED"));
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

  it("resolves without consulting the Copilot list at all", async () => {
    /*
     * There used to be a Copilot tier between the session's settings and the app default.
     * There is not any more, because the conversation copied what the Copilot contributed when
     * it was created — so consulting the Copilot would be reading the same values a second
     * time, from a record that is allowed to have been deleted since.
     *
     * The Copilot here is left in the list on purpose and points at a *different* provider, so
     * a resolution that still read it would answer "p2"/"m3" and fail this.
     */
    const copilot: Copilot = {
      id: "c1",
      userId: "u1",
      name: "Coach",
      description: "",
      systemPrompt: "Be terse.",
      allTools: true,
      tools: [],
      settings: { providerId: "p2", modelId: "m3" },
      widgets: [],
      visibility: "private",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    mocks.api.listCopilots.mockResolvedValue([copilot]);

    const store = await readyStore({ sessions: [session({ copilotId: "c1" })] });

    // The session's own settings are empty, so both fall to the app default.
    expect(store.currentProviderId).toBe(CONFIG.defaultProvider);
    expect(store.effectiveModelId).toBe(CONFIG.defaultModel);
  });

  it("splits the Copilot list into published and mine, by owner", async () => {
    mocks.api.listCopilots.mockResolvedValue([
      { ...copilotFixture("c-mine", "u1"), visibility: "public" },
      { ...copilotFixture("c-theirs", "u2"), ownerName: "Bob", visibility: "public" },
    ]);

    const store = await readyStore();

    // One's own published Copilot stays under "mine": that is where the switch to unpublish it
    // lives, so it must not move groups the moment it is published.
    expect(store.myCopilots.map((c) => c.id)).toEqual(["c-mine"]);
    expect(store.publicCopilots.map((c) => c.id)).toEqual(["c-theirs"]);
  });

  it("copies a Copilot's tool restriction along with its persona", async () => {
    // A fork that carried the prompt but not the allowlist would be a different Copilot wearing
    // the original's name — and, because an unrestricted Copilot is the wider state, a quietly
    // more powerful one.
    mocks.api.listCopilots.mockResolvedValue([
      { ...copilotFixture("c-theirs", "u2"), visibility: "public" },
    ]);
    mocks.api.createCopilot.mockResolvedValue(copilotFixture("c-copy", "u1"));

    const store = await readyStore();
    await store.copyCopilotToMine("c-theirs");

    expect(mocks.api.createCopilot).toHaveBeenCalledWith(
      expect.objectContaining({ allTools: false, tools: ["read_file"], visibility: "private" })
    );
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

  it("sends a turn that is nothing but a reference", async () => {
    /*
     * "What about this?" needs no words: the chip is the question. Asserted at the store because
     * this is where the two sides have to agree — the composer's `canSend` accepts a staged chip
     * alone and the server's `MESSAGE_REQUIRED` guard knows about them, so a store that refused
     * the send would make both of those checks unreachable.
     */
    const store = await readyStore();
    streamOf({ type: "done" });
    store.stageReference({ kind: "diagram", ref: "auth-flow.mmd", label: "auth-flow" });

    await store.sendMessage("");

    expect(mocks.streamChat).toHaveBeenCalledWith("s1", {
      message: "",
      copilotId: undefined,
      attachments: [],
      refs: [{ kind: "diagram", ref: "auth-flow.mmd", label: "auth-flow" }],
    });
  });

  it("stages a reference once, folds two passages apart, and clears them on send", async () => {
    /*
     * The key rule, at the level it is enforced. Two chips for one diagram would be two
     * references in one turn and the model told the same thing twice; two *passages* of the same
     * words are two different things the reader pointed at, so the occurrence is part of the key
     * and only for them.
     */
    const store = await readyStore();
    streamOf({ type: "done" });

    store.stageReference({ kind: "diagram", ref: "flow.mmd", label: "flow" });
    store.stageReference({ kind: "diagram", ref: "flow.mmd", label: "flow" });
    expect(store.pendingRefs).toHaveLength(1);

    store.stageReference({
      kind: "message",
      ref: "m1",
      label: "ATP",
      quote: "ATP",
      occurrence: 0,
    });
    store.stageReference({
      kind: "message",
      ref: "m1",
      label: "ATP",
      quote: "ATP",
      occurrence: 1,
    });
    expect(store.pendingRefs).toHaveLength(3);

    // And one comes back off without disturbing the others.
    store.removePendingReference("diagram:flow.mmd");
    expect(store.pendingRefs.map((r) => r.kind)).toEqual(["message", "message"]);

    await store.sendMessage("go on");
    expect(store.pendingRefs).toEqual([]);
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

  it("replaces a coded error event with the catalog's sentence", async () => {
    // A code is present only when the server recognised the failure as a *setting* rather
    // than a fault. Then the provider's own words are the wrong thing to show: they describe
    // the symptom and name nothing the user can change.
    const store = await readyStore();
    streamOf(
      {
        type: "error",
        message: "400 The `reasoning_content` in the thinking mode must be passed back to the API.",
        code: "REASONING_NOT_DECLARED",
      },
      { type: "done" }
    );

    await store.sendMessage("q");

    const expected = i18n.global.t("errors.REASONING_NOT_DECLARED");
    expect(store.streaming.error).toBe(expected);
    expect(store.streaming.error).not.toContain("reasoning_content");
    // The toast too, not only the banner: the banner unmounts with the turn.
    expect(store.error).toBe(expected);
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

  it("carries settings picked before the session existed in the create call", async () => {
    /*
     * In the create request rather than a `PATCH` afterwards, which is what it used to be. Two
     * writes left a window in which the conversation existed with parameters nobody had chosen,
     * and a failure between them left it that way for good.
     */
    const store = await readyStore();
    store.activeSessionId = null;
    await store.updateSettings({ temperature: 0.4, maxSteps: 3 });
    expect(store.draftSettings).toEqual({ temperature: 0.4, maxSteps: 3 });

    await store.createSession();

    expect(mocks.api.createSession).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ settings: { temperature: 0.4, maxSteps: 3 } })
    );
    // And nothing is patched afterwards, which is the half that makes it one write.
    expect(mocks.api.updateSession).not.toHaveBeenCalled();
    expect(store.draftSettings).toEqual({});
  });

  it("names a new session with the placeholder, in the language being read", async () => {
    /*
     * The name is written by the client rather than left to the server's constant, because a
     * placeholder has to be in a language and the server has no reader to ask. It is sent with
     * `titleSource: "auto"`, which is what makes it a placeholder — the auto-titler still
     * replaces it after the first turn.
     *
     * The locale is pinned, per the rule the i18n guards state: jsdom's `en-US` navigator would
     * otherwise let this pass against the English catalog.
     */
    const store = await readyStore();
    store.activeSessionId = null;

    await store.createSession();

    expect(mocks.api.createSession).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ title: "（未命名）会话" })
    );
  });

  it("lets a caller name the session instead of using the placeholder", async () => {
    const store = await readyStore();
    store.activeSessionId = null;

    await store.createSession({ title: "第三章复习" });

    expect(mocks.api.createSession).toHaveBeenCalledWith(
      "w1",
      expect.objectContaining({ title: "第三章复习" })
    );
  });

  it("omits settings entirely when nothing was staged", async () => {
    // Not an empty object: the server merges what it is given over the Copilot's copied values,
    // so `{}` would be a no-op with the same meaning — but omitting it says "no opinion" rather
    // than "no settings", which is the honest statement about a form nobody filled in.
    const store = await readyStore();
    store.activeSessionId = null;

    await store.createSession();

    expect(mocks.api.createSession).toHaveBeenCalledWith(
      "w1",
      expect.not.objectContaining({ settings: expect.anything() })
    );
  });

  it("trims a rename and ignores a blank one", async () => {
    const store = await readyStore();
    await store.renameSession("s1", "  New Title  ");
    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", { title: "New Title" });

    mocks.api.updateSession.mockClear();
    await store.renameSession("s1", "   ");
    expect(mocks.api.updateSession).not.toHaveBeenCalled();
  });

  it("pins a conversation by replacing the row in place", async () => {
    const store = await readyStore();
    mocks.api.setSessionPinned.mockResolvedValue(session({ pinned: true }));

    await store.setSessionPinned("s1", true);
    expect(mocks.api.setSessionPinned).toHaveBeenCalledWith("s1", true);
    expect(store.sessions[0]?.pinned).toBe(true);

    // Unpinned comes back the same way — the row is replaced, never optimistically flipped, so a
    // refused write leaves the list exactly as it was.
    mocks.api.setSessionPinned.mockResolvedValue(session({ pinned: false }));
    await store.setSessionPinned("s1", false);
    expect(store.sessions[0]?.pinned).toBe(false);
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

/**
 * The `@` grant, as the store's side of it.
 *
 * A **session setting**, not a field on the turn — and that is the design rather than an
 * implementation detail: the grant persists, survives a reload, and is in force for turns nobody
 * typed an `@` in. So what these cases pin is that picking writes the setting (and, before a
 * conversation exists, stages it), and that taking the last one back writes `null` rather than an
 * empty object — a stored `{all: false, workspaceIds: []}` reads exactly like a grant that grants
 * something.
 */
describe("the workspace scope", () => {
  it("stages a pick before a conversation exists", async () => {
    // The welcome screen's composer has no session to write to, so the pick rides `draftSettings`
    // and `createSession` folds it in — the same path the provider and model already take.
    const store = await readyStore();
    store.activeSessionId = null;

    await store.referenceScope({ kind: "scope", all: false, workspaceId: "w2", name: "Other" });

    expect(mocks.api.updateSession).not.toHaveBeenCalled();
    expect(store.workspaceScope).toEqual({ all: false, workspaceIds: ["w2"] });
  });

  it("writes the grant to the conversation once there is one", async () => {
    const store = await readyStore();
    await store.referenceScope({ kind: "scope", all: false, workspaceId: "w2", name: "Other" });

    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", {
      settings: { workspaceScope: { all: false, workspaceIds: ["w2"] } },
    });
    expect(store.scopedWorkspaceIds).toEqual(["w2"]);
    expect(store.scopeIsAll).toBe(false);
  });

  it("writes `all` as a flag, with no list under it", async () => {
    const store = await readyStore();
    await store.referenceScope({ kind: "scope", all: true, name: "所有工作区" });

    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", {
      settings: { workspaceScope: { all: true } },
    });
    expect(store.scopeIsAll).toBe(true);
    // No chips for named workspaces: `all` already covers every one, and a list underneath
    // would be state nobody can see or remove.
    expect(store.scopedWorkspaceIds).toEqual([]);
  });

  it("writes null when the last workspace is taken back", async () => {
    const store = await readyStore();
    await store.referenceScope({ kind: "scope", all: false, workspaceId: "w2", name: "Other" });
    mocks.api.updateSession.mockClear();

    await store.removeScopeWorkspace("w2");

    // `null`, never `{all: false, workspaceIds: []}` — and never `undefined`, which disappears
    // in JSON and would leave the grant unremovable.
    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", {
      settings: { workspaceScope: null },
    });
    expect(store.workspaceScope).toBeNull();
  });

  it("keeps the others when one of several is taken back", async () => {
    const store = await readyStore();
    await store.referenceScope({ kind: "scope", all: false, workspaceId: "w2", name: "Other" });
    await store.referenceScope({ kind: "scope", all: false, workspaceId: "w3", name: "Third" });
    mocks.api.updateSession.mockClear();

    await store.removeScopeWorkspace("w2");

    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", {
      settings: { workspaceScope: { all: false, workspaceIds: ["w3"] } },
    });
  });

  it("closes every workspace at once, which is how the `all` chip comes off", async () => {
    const store = await readyStore();
    await store.referenceScope({ kind: "scope", all: true, name: "所有工作区" });
    mocks.api.updateSession.mockClear();

    await store.clearWorkspaceScope();

    expect(mocks.api.updateSession).toHaveBeenCalledWith("s1", {
      settings: { workspaceScope: null },
    });
    expect(store.scopeIsAll).toBe(false);
  });
});

describe("widgets", () => {
  it("loads both groups when a conversation is selected", async () => {
    const store = await readyStore({ widgets: ["workspace_stats", "session_stats"] });
    expect(store.workspaceWidgetIds).toEqual(["workspace_stats"]);
    expect(store.sessionWidgetIds).toEqual(["session_stats"]);
    // In group order, which is what makes "workspace first, then session" a property of the data
    // rather than of the render.
    expect(store.enabledWidgetIds).toEqual(["workspace_stats", "session_stats"]);
  });

  it("shows nothing when nothing is installed", async () => {
    // The default, and the state a fresh workspace is in. The panel does not render at all.
    const store = await readyStore();
    expect(store.enabledWidgetIds).toEqual([]);
  });

  it("patches the list from the reply rather than from what it asked for", async () => {
    // The server resolves the state, so the reply is the record — a client that composed it
    // locally would be asserting its own intent rather than the stored fact.
    const store = await readyStore();
    mocks.api.setWorkspaceWidget.mockResolvedValue({
      id: "workspace_stats",
      scope: "workspace",
      enabled: true,
    });

    await store.setWidgetEnabled("workspace", "w1", "workspace_stats", true);

    expect(mocks.api.setWorkspaceWidget).toHaveBeenCalledWith("w1", "workspace_stats", true);
    expect(store.workspaceWidgetIds).toEqual(["workspace_stats"]);
  });

  it("records an uninstall without dropping the row from the list", async () => {
    // `enabled: false` is the state, so the entry stays — which is also what the server stores.
    const store = await readyStore({ widgets: ["session_stats"] });
    mocks.api.setSessionWidget.mockResolvedValue({
      id: "session_stats",
      scope: "session",
      enabled: false,
    });

    await store.setWidgetEnabled("session", "s1", "session_stats", false);

    expect(store.sessionWidgetIds).toEqual([]);
    expect(store.sessionWidgets).toHaveLength(1);
    expect(store.sessionWidgets[0]!.enabled).toBe(false);
  });

  it("does not write a foreign object's installs into the active lists", async () => {
    /*
     * The workspace settings dialog can be opened for a workspace nobody has entered, so it keeps
     * its own rows — and this is the half that has to hold for that to be safe: a write to
     * another workspace must not land in the list the panel is rendering.
     */
    const store = await readyStore({ widgets: ["workspace_stats"] });
    mocks.api.setWorkspaceWidget.mockResolvedValue({
      id: "workspace_stats",
      scope: "workspace",
      enabled: false,
    });

    await store.setWidgetEnabled("workspace", "w-other", "workspace_stats", false);

    expect(store.workspaceWidgetIds).toEqual(["workspace_stats"]);
  });

  it("installs a widget group as one action, skipping members already in the target state", async () => {
    // Plan already installed; the group button installs the other two and leaves plan alone.
    // (The shared `widgetState` helper models only the stats widgets, so seed the study
    // group's states directly.)
    const store = await readyStore();
    store.sessionWidgets = [
      { id: "plan", scope: "session", enabled: true },
      { id: "quiz", scope: "session", enabled: false },
      { id: "thread", scope: "session", enabled: false },
    ];
    mocks.api.setSessionWidget.mockImplementation(
      async (_scope: string, id: string, enabled: boolean) => ({
        id,
        scope: "session",
        enabled,
      })
    );

    await store.setWidgetGroupEnabled("session", "s1", "study", true);

    const ids = vi.mocked(mocks.api.setSessionWidget).mock.calls.map((call) => call[1]);
    expect(ids).toContain("quiz");
    expect(ids).toContain("thread");
    expect(ids).not.toContain("plan");
    expect(store.sessionWidgetIds).toEqual(["plan", "quiz", "thread"]);
  });

  it("uninstalls every member of a group", async () => {
    const store = await readyStore({ widgets: ["plan", "quiz", "thread"] });
    mocks.api.setSessionWidget.mockImplementation(
      async (_scope: string, id: string, enabled: boolean) => ({
        id,
        scope: "session",
        enabled,
      })
    );

    await store.setWidgetGroupEnabled("session", "s1", "study", false);

    const calls = vi.mocked(mocks.api.setSessionWidget).mock.calls;
    expect(calls.map((call) => [call[1], call[2]])).toEqual([
      ["plan", false],
      ["quiz", false],
      ["thread", false],
    ]);
    expect(store.sessionWidgetIds).toEqual([]);
  });

  it("runs the lifecycle hook, and a hook that throws cannot fail the write", async () => {
    /*
     * The claim the ordering exists for: the record is committed before the hook runs, so a hook
     * that throws is a defect in a built-in widget rather than a failure of the user's action.
     * Reported nowhere the user can see, and the state stays as the server wrote it.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { WIDGET_MODULES } = await import("../../src/widgets/registry.js");
    const installed = vi.fn(() => {
      throw new Error("hook bug");
    });
    const original = WIDGET_MODULES.session_stats.onInstall;
    WIDGET_MODULES.session_stats.onInstall = installed;

    try {
      const store = await readyStore();
      mocks.api.setSessionWidget.mockResolvedValue({
        id: "session_stats",
        scope: "session",
        enabled: true,
      });

      await expect(
        store.setWidgetEnabled("session", "s1", "session_stats", true)
      ).resolves.toBeDefined();

      expect(installed).toHaveBeenCalledWith({
        scope: "session",
        scopeId: "s1",
        widgetId: "session_stats",
      });
      // The list is the server's answer, and the toast is untouched.
      expect(store.sessionWidgetIds).toEqual(["session_stats"]);
      expect(store.error).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      WIDGET_MODULES.session_stats.onInstall = original;
      warn.mockRestore();
    }
  });

  it("runs the install hook for a workspace's widgets, which arrive in the create call", async () => {
    /*
     * The half of the lifecycle that a per-widget toggle cannot cover: the whole selection is
     * chosen before the workspace exists, so the *creation* is the only moment there is. Unlike
     * the `setWidgetEnabled` case, the list comes from the caller — with the default set empty,
     * what was asked for and what was installed are the same list.
     */
    const { WIDGET_MODULES } = await import("../../src/widgets/registry.js");
    const installed = vi.fn();
    const original = WIDGET_MODULES.workspace_stats.onInstall;
    WIDGET_MODULES.workspace_stats.onInstall = installed;

    try {
      const store = await readyStore();
      mocks.api.createWorkspace.mockResolvedValue(WORKSPACE);
      await store.createWorkspace("Fresh", ["workspace_stats"]);

      expect(installed).toHaveBeenCalledWith({
        scope: "workspace",
        scopeId: WORKSPACE.id,
        widgetId: "workspace_stats",
      });
    } finally {
      WIDGET_MODULES.workspace_stats.onInstall = original;
    }
  });

  it("carries the description into the create request rather than a write after it", async () => {
    /*
     * One request, and the assertion is on the *request*: the dialog fills a description in
     * before the workspace exists, so a follow-up `PATCH` would leave the card on screen
     * without it — and a failure between the two leaves it that way for good.
     */
    const store = await readyStore();
    mocks.api.createWorkspace.mockResolvedValue(WORKSPACE);

    await store.createWorkspace("Fresh", ["workspace_stats"], "线性代数的习题");

    expect(mocks.api.createWorkspace).toHaveBeenCalledWith(
      "Fresh",
      ["workspace_stats"],
      "线性代数的习题"
    );
  });

  it("sends an empty description when the form did not ask for one", async () => {
    // The default, so a caller with no opinion — the first-run workspace — writes no column of
    // its own rather than tripping the server's "missing named parameter".
    const store = await readyStore();
    mocks.api.createWorkspace.mockResolvedValue(WORKSPACE);

    await store.createWorkspace("Fresh");

    expect(mocks.api.createWorkspace).toHaveBeenCalledWith("Fresh", undefined, "");
  });

  it("runs the install hook for what a new conversation actually got", async () => {
    // From the *resolved* list rather than the request's: the server copies a Copilot's selection
    // in, and a create may have named no widgets at all — so the reply is the only statement of
    // what was installed.
    const { WIDGET_MODULES } = await import("../../src/widgets/registry.js");
    const installed = vi.fn();
    const original = WIDGET_MODULES.session_stats.onInstall;
    WIDGET_MODULES.session_stats.onInstall = installed;

    try {
      const store = await readyStore();
      mocks.api.createSession.mockResolvedValue(session());
      // What the server resolved for the new conversation, which is what `selectSession` reads.
      mocks.api.listSessionWidgets.mockResolvedValue({
        workspace: [],
        session: [{ id: "session_stats", scope: "session", enabled: true }],
      });

      await store.createSession();

      expect(installed).toHaveBeenCalledWith({
        scope: "session",
        scopeId: "s1",
        widgetId: "session_stats",
      });
    } finally {
      WIDGET_MODULES.session_stats.onInstall = original;
    }
  });

  it("does not run a hook for a widget that was not installed", async () => {
    const { WIDGET_MODULES } = await import("../../src/widgets/registry.js");
    const installed = vi.fn();
    const original = WIDGET_MODULES.workspace_stats.onInstall;
    WIDGET_MODULES.workspace_stats.onInstall = installed;

    try {
      const store = await readyStore();
      mocks.api.createWorkspace.mockResolvedValue(WORKSPACE);
      await store.createWorkspace("Fresh");

      expect(installed).not.toHaveBeenCalled();
    } finally {
      WIDGET_MODULES.workspace_stats.onInstall = original;
    }
  });

  it("clears both lists when the account goes", async () => {
    // Through `signOut` rather than `forgetAccount` directly, because the latter is deliberately
    // not on the store's public surface — it is reached from sign-out, from an expired session
    // and from nothing else.
    const store = await readyStore({ widgets: ["workspace_stats", "session_stats"] });
    expect(store.enabledWidgetIds).toHaveLength(2);

    mocks.api.logout.mockResolvedValue(undefined);
    await store.signOut();

    expect(store.workspaceWidgets).toEqual([]);
    expect(store.sessionWidgets).toEqual([]);
  });
});

describe("the panel's open tab", () => {
  /**
   * The install lists, split by scope the way the server resolves them. A local helper rather
   * than the shared `widgetState`, which models only the two stats widgets — and widening that
   * one would change what every other case in this file sees.
   */
  function installed(...ids: WidgetId[]) {
    const scopeOf = (id: WidgetId) => (id === "workspace_stats" ? "workspace" : "session");
    return {
      workspace: ids
        .filter((id) => scopeOf(id) === "workspace")
        .map((id) => ({ id, scope: "workspace" as const, enabled: true })),
      session: ids
        .filter((id) => scopeOf(id) === "session")
        .map((id) => ({ id, scope: "session" as const, enabled: true })),
    };
  }

  beforeEach(async () => {
    // `widgetPanel` is a module singleton over one `localStorage`, so a stored tab survives
    // between cases and a test that did not clear it would pass or fail on the order it ran in.
    localStorage.removeItem("gl-widget-active");
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    widgetPanel.reload();
  });

  it("opens a new conversation on its first tab", async () => {
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    const store = await readyStore();
    mocks.api.listSessionWidgets.mockResolvedValue(installed("plan", "diagram"));
    mocks.api.createSession.mockResolvedValue(session({ id: "s2" }));

    await store.createSession({ widgets: ["plan", "diagram"] });

    expect(widgetPanel.activeId.value).toBe("plan");
  });

  it("counts the workspace group first, which is the order the strip draws", async () => {
    // "First tab" is the first of the flattened groups, not the first session widget: a panel
    // whose groups are drawn workspace-then-session opens on the workspace one.
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    const store = await readyStore();
    mocks.api.listSessionWidgets.mockResolvedValue(installed("workspace_stats", "session_stats"));
    mocks.api.createSession.mockResolvedValue(session({ id: "s2" }));

    await store.createSession({ widgets: ["workspace_stats", "session_stats"] });

    expect(widgetPanel.activeId.value).toBe("workspace_stats");
  });

  it("writes nothing when the new conversation installed nothing", async () => {
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    const store = await readyStore();
    widgetPanel.setActive("diagram");
    mocks.api.listSessionWidgets.mockResolvedValue(installed());
    mocks.api.createSession.mockResolvedValue(session({ id: "s2" }));

    await store.createSession({ widgets: [] });

    // There is no first tab to name, and an id written here would be a preference for a tab
    // that does not exist.
    expect(widgetPanel.activeId.value).toBe("diagram");
  });

  it("leaves the tab alone when an existing conversation is selected", async () => {
    // What makes the fix narrow rather than a general reset: opening a conversation you were
    // already reading still comes back to the tab you last read, which is the behaviour the
    // panel is built on.
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    const store = await readyStore({ widgets: [] });
    mocks.api.listSessionWidgets.mockResolvedValue(installed("plan", "diagram"));
    await store.selectSession("s1");
    widgetPanel.setActive("diagram");

    await store.selectSession("s1");

    expect(widgetPanel.activeId.value).toBe("diagram");
  });
});

describe("leaving a conversation", () => {
  /*
   * The store's half of the leave report: which transitions count as leaving, and what the late
   * title does to its own copy of the list. `composables/sessionLeave.test.ts` owns the debounce
   * and the gate; this is where "the store tells it what is on screen" is pinned.
   */

  /*
   * The composable is a module singleton, so the conversation it thinks is on screen and any
   * pending timer both outlive a test — and a leftover timer fires during the *next* case's
   * `sweep`, which reads as a report from nowhere. `forgetSession` is the production reset (the
   * store calls it on delete and sign-out), so this is the same call the app makes rather than a
   * test-only back door.
   */
  beforeEach(async () => {
    const { forgetSession } = await import("../../src/composables/sessionLeave.js");
    forgetSession();
    vi.clearAllTimers();
  });

  const sweep = () => vi.advanceTimersByTimeAsync(3_000);

  it("reports the conversation a switch leaves behind", async () => {
    const store = await readyStore({ sessions: [session({ id: "s1" }), session({ id: "s2" })] });

    await store.selectSession("s2");
    await sweep();

    expect(mocks.api.reportSessionLeave).toHaveBeenCalledWith("s1");
  });

  it("reports the conversation a workspace switch leaves behind", async () => {
    const store = await readyStore();
    await store.selectWorkspace("w2");
    await sweep();

    expect(mocks.api.reportSessionLeave).toHaveBeenCalledWith("s1");
  });

  it("says nothing for a conversation the model already named", async () => {
    const store = await readyStore({ sessions: [session({ id: "s1", titleState: "model" })] });
    await store.selectWorkspace("w2");
    await sweep();

    expect(mocks.api.reportSessionLeave).not.toHaveBeenCalled();
  });

  it("patches its own copy when a title arrives late", async () => {
    /*
     * The reader has gone somewhere else, so there is no list request to carry this — the patch is
     * what makes the sidebar show the name without a reload. `titleState` moves with it, which is
     * what stops the next leave reporting the same conversation again.
     */
    mocks.api.reportSessionLeave.mockResolvedValue({ status: "titled", title: "递归入门" });
    const store = await readyStore({ sessions: [session({ id: "s1" }), session({ id: "s2" })] });

    await store.selectSession("s2");
    await sweep();

    expect(store.sessions.find((s) => s.id === "s1")?.title).toBe("递归入门");
    expect(store.sessions.find((s) => s.id === "s1")?.titleState).toBe("model");
  });

  it("says nothing about a conversation it deletes", async () => {
    // Deleting is not leaving: there is nowhere to keep a new title, and the report would be a
    // request whose answer is a 404 by construction.
    const store = await readyStore();
    await store.deleteSession("s1");
    await sweep();

    expect(mocks.api.reportSessionLeave).not.toHaveBeenCalled();
  });
});

describe("auto-install widgets", () => {
  beforeEach(async () => {
    localStorage.removeItem("gl-widget-active");
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    widgetPanel.reload();
  });

  const activeTab = async () =>
    (await import("../../src/composables/widgetPanel.js")).widgetPanel.activeId.value;

  const state = (id: string, enabled: boolean): WidgetState => ({
    id: id as WidgetState["id"],
    scope: "session",
    enabled,
  });

  const plan = () => state("plan", true);
  const diagram = () => state("diagram", true);

  /** A store whose active conversation has exactly these session widgets installed. */
  async function withWidgets(...session: WidgetState[]) {
    const store = await readyStore();
    mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session });
    await store.selectSession("s1");
    return store;
  }

  function toolEnd(name: string) {
    return {
      type: "tool_end" as const,
      toolCall: { id: "c1", name, input: "{}", output: "{}" },
    };
  }

  it("picks up the plan the server installed when the tool ran", async () => {
    /*
     * The install is a *server* fact — the write happens during the call — so this store cannot
     * see it without asking. Re-reading the route is the whole mechanism: the tool ran in a
     * conversation with no plan panel, and afterwards there is one.
     */
    streamOf(toolEnd("ila_make_plan"), { type: "done" });
    const store = await withWidgets();
    // The first read is `selectSession`'s; the second is the one the tool call triggers.
    mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session: [plan()] });

    await store.sendMessage("make a plan");

    expect(store.sessionWidgetIds).toContain("plan");
    expect(await activeTab()).toBe("plan");
  });

  it("does not re-read the list when the widget is already installed", async () => {
    // The cost guard, and it matters because the plan tools fire on every progress update: a
    // conversation with the panel open must not pay a request per call.
    streamOf(toolEnd("ila_update_plan_progress"), { type: "done" });
    const store = await withWidgets(plan());
    vi.mocked(mocks.api.listSessionWidgets).mockClear();

    await store.sendMessage("next chapter");

    expect(mocks.api.listSessionWidgets).not.toHaveBeenCalled();
  });

  it("does not re-read the list for a tool that belongs to no widget", async () => {
    streamOf(toolEnd("read_file"), { type: "done" });
    const store = await withWidgets();
    vi.mocked(mocks.api.listSessionWidgets).mockClear();

    await store.sendMessage("read it");

    expect(mocks.api.listSessionWidgets).not.toHaveBeenCalled();
  });

  it("installs the diagram panel without pulling the reader onto it", async () => {
    /*
     * A diagram is already visible inline as its own card in the message list, so opening the
     * panel would move the reader away from the thing they can see. Installing is the whole
     * requirement; `open` is narrowed to `ila_make_plan` for this reason.
     */
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    streamOf(toolEnd("ila_diagram"), { type: "done" });
    const store = await withWidgets(state("notes", true));
    widgetPanel.setActive("notes");
    mocks.api.listSessionWidgets.mockResolvedValue({
      workspace: [],
      session: [state("notes", true), diagram()],
    });

    await store.sendMessage("draw it");

    expect(store.sessionWidgetIds).toContain("diagram");
    expect(await activeTab()).toBe("notes");
  });

  it("shows no panel when the reader has moved on while the refetch was in flight", async () => {
    /*
     * The refetch is fire-and-forget, so its continuation can land after the reader has opened
     * another conversation — at which point the list it just replaced belongs to the one they
     * left, and a tab opening for it would be a panel about somebody else's conversation.
     */
    const store = await withWidgets();
    let release!: () => void;
    // Held open so the reader can leave in the middle of the read; every later read (the
    // `selectSession` below) answers immediately.
    mocks.api.listSessionWidgets.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ workspace: [], session: [plan()] });
        })
    );
    mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session: [] });
    streamOf(toolEnd("ila_make_plan"), { type: "done" });

    await store.sendMessage("make a plan");
    await store.selectSession("s2");
    release();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.sessionWidgetIds).not.toContain("plan");
  });
});

describe("widget events", () => {
  it("announces the end of a turn exactly once, at the point every turn ends", async () => {
    const { subscribeWidgetEvents } = await import("../../src/composables/widgetEvents.js");
    const seen: string[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e.type));

    try {
      streamOf({ type: "text", delta: "hi" }, { type: "done" });
      const store = await readyStore();
      await store.sendMessage("hello");

      expect(seen.filter((t) => t === "turn.finished")).toHaveLength(1);
      expect(seen).toContain("turn.started");
    } finally {
      off();
    }
  });

  it("announces a turn whose request failed, because it still persisted a message", async () => {
    // A failed turn writes a `⚠️` assistant message, so a widget showing a count would otherwise
    // be showing one that is no longer true.
    const { subscribeWidgetEvents } = await import("../../src/composables/widgetEvents.js");
    const seen: string[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e.type));

    try {
      mocks.streamChat.mockImplementation(async function* () {
        throw new Error("network down");
      });
      const store = await readyStore();
      await store.sendMessage("hello");

      expect(seen.filter((t) => t === "turn.finished")).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("announces a resumed turn as well as a fresh one", async () => {
    // A resumed `ask_user` turn moves the same numbers, and comes through a different route — so
    // it is announced from the same place rather than from only the fresh path.
    const { subscribeWidgetEvents } = await import("../../src/composables/widgetEvents.js");
    const seen: string[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e.type));

    try {
      streamOf({ type: "text", delta: "ok" }, { type: "done" });
      const store = await readyStore({
        messages: [
          message({
            role: "assistant",
            toolCalls: [
              { id: "c1", name: "ask_user", input: "{}", status: "awaiting" },
            ],
          }),
        ],
      });
      await store.answerQuestion("c1", { action: "cancel" });

      expect(seen.filter((t) => t === "turn.finished")).toHaveLength(1);
    } finally {
      off();
    }
  });
});

describe("plan widgets", () => {
  it("emits plan.changed when a plan tool finishes, and not for other tools", async () => {
    const { subscribeWidgetEvents } = await import("../../src/composables/widgetEvents.js");
    const seen: string[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e.type));
    try {
      streamOf(
        {
          type: "tool_end",
          toolCall: { id: "c1", name: "ila_read_plan", input: "{}", output: "{}" },
        },
        {
          type: "tool_end",
          toolCall: { id: "c2", name: "read_file", input: "{}", output: "x" },
        },
        { type: "done" }
      );
      const store = await readyStore();
      await store.sendMessage("hello");

      expect(seen.filter((t) => t === "plan.changed")).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("switches to the new conversation at stream end after plan_session_created", async () => {
    streamOf(
      { type: "plan_session_created", sessionId: "s2" },
      {
        type: "message_done",
        message: message({ role: "assistant", content: "created elsewhere" }),
      },
      { type: "done" }
    );
    const store = await readyStore();
    expect(store.activeSessionId).toBe("s1");

    await store.sendMessage("make a different plan");

    // Navigation happens in the stream's finally: sessions reloaded, then the target
    // conversation selected (its messages and widgets read), and the active id moved.
    expect(mocks.api.listMessages).toHaveBeenCalledWith("s2");
    expect(store.activeSessionId).toBe("s2");
  });

  it("adjust-plan sends the panel composer's message through the normal flow", async () => {
    streamOf({ type: "text", delta: "好的" }, { type: "done" });
    const store = await readyStore();
    await store.sendPanelMessage("调整计划：把第三章删掉");
    expect(mocks.streamChat).toHaveBeenCalled();
  });

  it("jump-to-chapter rewrites progress on the server, then sends the jump message", async () => {
    mocks.api.jumpPlanNode.mockResolvedValue({
      plan: null,
      number: "1.2",
      title: "1.2 Setup",
      skippedCount: 1,
    });
    streamOf({ type: "text", delta: "好的" }, { type: "done" });
    const store = await readyStore();

    const ok = await store.planJumpToNode("node-12", "调整进度，跳到章节1.2 1.2 Setup");
    expect(ok).toBe(true);
    expect(mocks.api.jumpPlanNode).toHaveBeenCalledWith("s1", "node-12");
    expect(mocks.streamChat).toHaveBeenCalled();
  });
});

describe("the plan tab", () => {
  /** An assistant message holding one live `ila_make_plan` conflict card. */
  function conflict(): Message {
    return message({
      role: "assistant",
      content: "这个计划要怎么处理？",
      toolCalls: [
        {
          id: "call_plan",
          name: "ila_make_plan",
          input: JSON.stringify({ tree: [{ title: "A" }] }),
          status: "awaiting",
        },
      ],
    });
  }

  function answersTo(...events: ChatStreamEvent[]) {
    mocks.streamAnswers.mockImplementation(async function* () {
      for (const event of events) yield event;
    });
  }

  const plan = (): WidgetState => ({ id: "plan", scope: "session", enabled: true });
  const diagram = (): WidgetState => ({ id: "diagram", scope: "session", enabled: true });

  /** A store whose active conversation has exactly these session widgets installed. */
  async function withWidgets(...session: WidgetState[]) {
    const store = await readyStore();
    mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session });
    await store.selectSession("s1");
    return store;
  }

  beforeEach(async () => {
    localStorage.removeItem("gl-widget-active");
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    widgetPanel.reload();
  });

  const activeTab = async () =>
    (await import("../../src/composables/widgetPanel.js")).widgetPanel.activeId.value;

  it("surfaces the plan when the make tool commits", async () => {
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    streamOf(
      {
        type: "tool_end",
        toolCall: { id: "p1", name: "ila_make_plan", input: "{}", output: "{}" },
      },
      { type: "done" }
    );
    const store = await withWidgets(plan(), diagram());
    widgetPanel.setActive("diagram");

    await store.sendMessage("make a plan");

    expect(await activeTab()).toBe("plan");
  });

  it("leaves the tab alone on a progress update, and still refetches the panel", async () => {
    /*
     * The two halves are deliberately separate effects of one `tool_end` arm. Narrowing
     * `plan.changed` to the make tool would have been the easy way to tell the three plan tools
     * apart, and it would have stopped the tree moving while the model is still writing — so the
     * event keeps covering all three and only the *activation* is narrowed.
     */
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    const { subscribeWidgetEvents } = await import("../../src/composables/widgetEvents.js");
    const seen: string[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e.type));
    try {
      streamOf(
        {
          type: "tool_end",
          toolCall: {
            id: "p1",
            name: "ila_update_plan_progress",
            input: "{}",
            output: "{}",
          },
        },
        { type: "done" }
      );
      const store = await withWidgets(plan(), diagram());
      widgetPanel.setActive("diagram");

      await store.sendMessage("mark chapter one done");

      expect(seen).toContain("plan.changed");
      expect(await activeTab()).toBe("diagram");
    } finally {
      off();
    }
  });

  it("leaves the tab alone on a read, and still refetches the panel", async () => {
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    const { subscribeWidgetEvents } = await import("../../src/composables/widgetEvents.js");
    const seen: string[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e.type));
    try {
      streamOf(
        {
          type: "tool_end",
          toolCall: { id: "p1", name: "ila_read_plan", input: "{}", output: "{}" },
        },
        { type: "done" }
      );
      const store = await withWidgets(plan(), diagram());
      widgetPanel.setActive("diagram");

      await store.sendMessage("what does the plan say?");

      expect(seen).toContain("plan.changed");
      expect(await activeTab()).toBe("diagram");
    } finally {
      off();
    }
  });

  it("writes nothing when the conversation has no plan widget", async () => {
    // `activateWidget`'s guard. A stored id the strip cannot draw is a preference the panel
    // silently overrides, so writing one would be a lie until the next click.
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    streamOf(
      {
        type: "tool_end",
        toolCall: { id: "p1", name: "ila_make_plan", input: "{}", output: "{}" },
      },
      { type: "done" }
    );
    const store = await withWidgets(diagram());
    widgetPanel.setActive("diagram");

    await store.sendMessage("make a plan");

    expect(await activeTab()).toBe("diagram");
  });

  it("surfaces the plan when the user chooses to edit at the conflict card", async () => {
    /*
     * This is the case a `tool_end` rule cannot see. `ila_make_plan` suspends on the conflict
     * card and a suspended call emits no `tool_end` — so the client's own record of the *choice*
     * is the only signal that a plan was committed here.
     */
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    const store = await (async () => {
      const s = await readyStore({ messages: [conflict()] });
      mocks.api.listSessionWidgets.mockResolvedValue({
        workspace: [],
        session: [plan(), diagram()],
      });
      await s.selectSession("s1");
      return s;
    })();
    answersTo({ type: "done" });
    widgetPanel.setActive("diagram");

    await store.answerQuestion("call_plan", {
      action: "submit",
      answers: { choice: "edit" },
    });

    expect(await activeTab()).toBe("plan");
  });

  it("does not surface this conversation's plan when the choice is a new conversation", async () => {
    // `new_session` commits the plan *elsewhere*, so the tab here must not move — the fork's own
    // conversation is handled by the `plan_session_created` tail instead.
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    const store = await readyStore({ messages: [conflict()] });
    mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session: [plan(), diagram()] });
    await store.selectSession("s1");
    answersTo({ type: "done" });
    widgetPanel.setActive("diagram");

    await store.answerQuestion("call_plan", {
      action: "submit",
      answers: { choice: "new_session", newSessionId: "s2" },
    });

    expect(await activeTab()).toBe("diagram");
  });

  it("surfaces the plan in the conversation the fork created", async () => {
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    streamOf(
      { type: "plan_session_created", sessionId: "s2" },
      {
        type: "message_done",
        message: message({ role: "assistant", content: "created elsewhere" }),
      },
      { type: "done" }
    );
    const store = await readyStore();
    // The server installs the plan widget into the conversation it makes for the plan.
    mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session: [plan()] });
    widgetPanel.setActive("diagram");

    await store.sendMessage("make a different plan");

    expect(store.activeSessionId).toBe("s2");
    expect(await activeTab()).toBe("plan");
  });

  it("leaves the tab alone when the fork's conversation has no plan widget", async () => {
    // The guard again, on the one write site that names a tab the server chose rather than one
    // the user is looking at.
    const { widgetPanel } = await import("../../src/composables/widgetPanel.js");
    streamOf(
      { type: "plan_session_created", sessionId: "s2" },
      {
        type: "message_done",
        message: message({ role: "assistant", content: "created elsewhere" }),
      },
      { type: "done" }
    );
    const store = await readyStore();
    mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session: [] });
    widgetPanel.setActive("diagram");

    await store.sendMessage("make a different plan");

    expect(store.activeSessionId).toBe("s2");
    expect(await activeTab()).toBe("diagram");
  });
});

describe("the diagram widget", () => {
  it("emits diagram.changed when the tool finishes, and not for another tool", async () => {
    /*
     * The event exists because the tool's *result is a file*, and nothing the client holds
     * knows what the conversation's folder contains now — so the panel cannot learn it from
     * any local state, however it watches. Emitted from the one `tool_end` arm the other
     * mid-turn events already use.
     */
    const { subscribeWidgetEvents } = await import("../../src/composables/widgetEvents.js");
    const seen: string[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e.type));
    try {
      streamOf(
        {
          type: "tool_end",
          toolCall: { id: "d1", name: "ila_diagram", input: "{}", output: "Wrote flow.mmd" },
        },
        {
          type: "tool_end",
          toolCall: { id: "f1", name: "write_file", input: "{}", output: "x" },
        },
        { type: "done" }
      );
      const store = await readyStore();
      await store.sendMessage("draw it");

      expect(seen.filter((t) => t === "diagram.changed")).toHaveLength(1);
    } finally {
      off();
    }
  });
});

describe("quiz widgets", () => {
  it("emits quiz.changed when the grading tool finishes, and not for ila_quiz or other tools", async () => {
    const { subscribeWidgetEvents } = await import("../../src/composables/widgetEvents.js");
    const seen: string[] = [];
    const off = subscribeWidgetEvents((e) => seen.push(e.type));
    try {
      streamOf(
        {
          type: "tool_end",
          toolCall: { id: "g1", name: "ila_review_quiz", input: "{}", output: "{}" },
        },
        // ila_quiz suspends and never emits tool_end; even a stray one must not double-fire.
        {
          type: "tool_end",
          toolCall: { id: "q1", name: "ila_quiz", input: "{}", output: "x" },
        },
        {
          type: "tool_end",
          toolCall: { id: "c2", name: "read_file", input: "{}", output: "x" },
        },
        { type: "done" }
      );
      const store = await readyStore();
      await store.sendMessage("grade it");

      expect(seen.filter((t) => t === "quiz.changed")).toHaveLength(1);
    } finally {
      off();
    }
  });

  it("persists a make-up answer, then sends the quoting message through the normal flow", async () => {
    mocks.api.answerQuizQuestion.mockResolvedValue({ question: { id: "quiz-1" } });
    streamOf({ type: "text", delta: "答对了" }, { type: "done" });
    const store = await readyStore();

    const question = { id: "quiz-1", qid: "Q1" } as never;
    const answer = { selected: ["滚动"] } as never;
    const ok = await store.makeupQuizAnswer(question, answer, "【补答】…");

    expect(ok).toBe(true);
    expect(mocks.api.answerQuizQuestion).toHaveBeenCalledWith("s1", "quiz-1", {
      selected: ["滚动"],
    });
    expect(mocks.streamChat).toHaveBeenCalled();
    // The follow-up turn names the row so the server appends its hidden answer key to the
    // system prompt; the visible message carries nothing.
    expect(mocks.streamChat).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ makeupQuizId: "quiz-1" })
    );
  });

  it("reports a rejected make-up POST without starting a turn, leaving the dialog to stay open", async () => {
    mocks.api.answerQuizQuestion.mockRejectedValueOnce(new Error("不能补答"));
    const store = await readyStore();

    const ok = await store.makeupQuizAnswer(
      { id: "quiz-1" } as never,
      { selected: ["x"] } as never,
      "msg"
    );
    expect(ok).toBe(false);
    expect(mocks.streamChat).not.toHaveBeenCalled();
    expect(store.error).toContain("不能补答");
  });

  it("does not POST a make-up answer while a turn is streaming", async () => {
    const store = await readyStore();
    store.streaming.active = true;
    const ok = await store.makeupQuizAnswer(
      { id: "quiz-1" } as never,
      { selected: ["x"] } as never,
      "msg"
    );
    expect(ok).toBe(false);
    expect(mocks.api.answerQuizQuestion).not.toHaveBeenCalled();
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

  it("uses the configured limit rather than the constant", async () => {
    /*
     * The reason the cap is on the wire at all: an administrator who raised it to 60 MB expects a
     * 30 MB file to be *sent*, and one who lowered it to 2 MB expects a 3 MB file to be refused
     * without being sent. Both halves are asserted, because the failure that matters is a client
     * whose check disagrees with the route behind it in either direction.
     */
    const store = await readyStore();
    store.config = { ...store.config!, maxUploadBytes: 2 * 1024 * 1024 };

    const big = new File([new Uint8Array(1)], "big.bin");
    Object.defineProperty(big, "size", { value: 3 * 1024 * 1024 });
    await expect(store.uploadAttachment(big)).resolves.toBeNull();
    expect(mocks.api.uploadAttachment).not.toHaveBeenCalled();

    mocks.api.uploadAttachment.mockResolvedValue({
      id: "a2",
      name: "ok.txt",
      mimeType: "text/plain",
      size: 1,
      kind: "file" as const,
    });
    const allowed = new File([new Uint8Array(1)], "ok.txt");
    Object.defineProperty(allowed, "size", { value: 1024 * 1024 });
    await expect(store.uploadAttachment(allowed)).resolves.toMatchObject({ id: "a2" });
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
    mocks.api.listSessionSources
      .mockResolvedValueOnce([sourceOf({ id: "d1", parseStatus: "parsing" })])
      .mockResolvedValue([
        sourceOf({ id: "d1", parseStatus: "ready", parsedChars: 4200, pageCount: 3 }),
      ]);

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
    const calls = mocks.api.listSessionSources.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.api.listSessionSources).toHaveBeenCalledTimes(calls);
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
    expect(mocks.api.listSessionSources).not.toHaveBeenCalled();
    expect(store.documentsParsing).toBe(false);
  });

  it("surfaces a parse failure on the attachment", async () => {
    const store = await readyStore();
    mocks.api.uploadAttachment.mockResolvedValue({ ...PDF, parseStatus: "pending" });
    mocks.api.listSessionSources.mockResolvedValue([
      sourceOf({ id: "d1", parseStatus: "failed", parseError: "未检测到文本层" }),
    ]);

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
    mocks.api.reparseSource.mockResolvedValue({ status: "pending" });
    // First poll still in progress, second one done — that is what makes the loop keep
    // going for a re-parse when nothing is staged in the composer.
    mocks.api.listSessionSources
      .mockResolvedValueOnce([sourceOf({ id: "d1", parseStatus: "parsing" })])
      .mockResolvedValue([sourceOf({ id: "d1", parseStatus: "ready", parsedChars: 10 })]);

    await store.reparseAttachment(failed);
    // By the source alone: the file belongs to the account, so the conversation it was
    // uploaded through is not part of its identity.
    expect(mocks.api.reparseSource).toHaveBeenCalledWith("d1", "lecture.pdf");
    // Nothing is *pending* in the composer, so polling would stop immediately were it not
    // for the re-parse being tracked — this is the case that needs the extra bookkeeping.
    expect(store.pendingAttachments[0]!.parseStatus).not.toBe("failed");

    await vi.advanceTimersByTimeAsync(2000);
    expect(mocks.api.listSessionSources.mock.calls.length).toBeGreaterThan(1);
    expect(store.pendingAttachments[0]!.parseStatus).toBe("ready");
    expect(store.pendingAttachments[0]!.parseError).toBeUndefined();
  });

  it("stops polling when the staged attachments are cleared", async () => {
    const store = await readyStore();
    mocks.api.uploadAttachment.mockResolvedValue({ ...PDF, parseStatus: "pending" });
    mocks.api.listSessionSources.mockResolvedValue({
      d1: { status: "parsing", updatedAt: "" },
    });

    await store.uploadAttachment(new File(["x"], "lecture.pdf"));
    await vi.advanceTimersByTimeAsync(0);

    store.clearPendingAttachments();
    const calls = mocks.api.listSessionSources.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.api.listSessionSources).toHaveBeenCalledTimes(calls);
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

describe("a failed turn", () => {
  it("is left on screen as a toast, not only as a banner that unmounts with the turn", async () => {
    // The banner lives inside the streaming message, which is only rendered while a turn is
    // running. A failure therefore used to flash and vanish: the user was left with an
    // unchanged card and no reason for it.
    const store = await readyStore();
    streamOf({ type: "error", message: "provider said no" }, { type: "done" });

    await store.sendMessage("hello");

    expect(store.error).toBe("provider said no");
    expect(store.streaming.error).toBe("provider said no");
  });
});

describe("answerQuestion", () => {
  const QS = [
    { header: "认证方式", question: "要用哪种认证方式？", options: [{ label: "OAuth" }, { label: "API Key" }] },
  ];

  /** An assistant message holding one live `ask_user` call. */
  function pending(): Message {
    return message({
      role: "assistant",
      content: "需要确认一件事。",
      toolCalls: [
        {
          id: "call_ask",
          name: "ask_user",
          input: JSON.stringify({ questions: QS }),
          status: "awaiting",
        },
      ],
    });
  }

  const toolCall = (store: ReturnType<typeof useAppStore>) =>
    store.messages.flatMap((m) => m.toolCalls ?? []).find((tc) => tc.id === "call_ask");

  function answersTo(...events: ChatStreamEvent[]) {
    mocks.streamAnswers.mockImplementation(async function* () {
      for (const event of events) yield event;
    });
  }

  it("records the answer locally and posts it", async () => {
    const store = await readyStore({ messages: [pending()] });
    answersTo({ type: "done" });

    await store.answerQuestion("call_ask", {
      action: "submit",
      answers: { "0": { selected: ["OAuth"] } },
    });

    // Nothing streams while the question waits, so no server event describes this change —
    // the card is flipped by the client that caused it.
    expect(toolCall(store)).toMatchObject({
      status: "answered",
      answer: { "0": { selected: ["OAuth"] } },
    });
    expect(mocks.streamAnswers).toHaveBeenCalledWith("s1", {
      toolCallId: "call_ask",
      action: "submit",
      answers: { "0": { selected: ["OAuth"] } },
    });
  });

  it("streams the resumed turn into the conversation", async () => {
    const store = await readyStore({ messages: [pending()] });
    answersTo(
      { type: "text", delta: "好的，" },
      {
        type: "message_done",
        message: message({ id: "m2", role: "assistant", content: "好的，按 OAuth 来。" }),
      },
      { type: "done" }
    );

    await store.answerQuestion("call_ask", { action: "submit", answers: { "0": { selected: ["OAuth"] } } });

    expect(store.messages.at(-1)).toMatchObject({ role: "assistant", content: "好的，按 OAuth 来。" });
    expect(store.streaming.active).toBe(false);
    expect(store.streaming.content).toBe("");
  });

  it("records a cancel as a dismissal with no answers", async () => {
    const store = await readyStore({ messages: [pending()] });
    answersTo({ type: "done" });

    await store.answerQuestion("call_ask", { action: "cancel" });

    expect(toolCall(store)).toMatchObject({ status: "dismissed", answer: {} });
    expect(mocks.streamAnswers).toHaveBeenCalledWith("s1", {
      toolCallId: "call_ask",
      action: "cancel",
    });
  });

  it("puts the card back when the server refuses the answer", async () => {
    // A 409 — already answered in another tab, or skipped by a message sent since. The
    // local flip is a guess until the response says otherwise, so it has to be undone.
    const store = await readyStore({ messages: [pending()] });
    mocks.streamAnswers.mockImplementation(async function* () {
      // Thrown from inside the generator, as the real one does: a rejected `fetch` surfaces
      // on the first `next()`, not when the generator is created.
      throw new ApiError("QUESTION_NOT_PENDING", "这组问题已经不需要回答了", 409);
    });

    await store.answerQuestion("call_ask", { action: "submit", answers: { "0": { selected: ["OAuth"] } } });

    expect(toolCall(store)).toMatchObject({ status: "awaiting" });
    expect(toolCall(store)!.answer).toBeUndefined();
    expect(store.streaming.error).toBe("这组问题已经不需要回答了");
  });

  it("reports a call that is not in the loaded conversation instead of doing nothing", async () => {
    // A card on screen whose submission vanishes without a word is indistinguishable from
    // a broken button — which is exactly how a real failure was reported.
    const store = await readyStore({ messages: [pending()] });

    await store.answerQuestion("no-such-call", { action: "cancel" });

    expect(mocks.streamAnswers).not.toHaveBeenCalled();
    expect(store.error).toBe("这组问题已经不需要回答了，可能已经提交或作废。");
  });

  it("ignores an answer while another turn is streaming", async () => {
    const store = await readyStore({ messages: [pending()] });
    store.streaming.active = true;

    await store.answerQuestion("call_ask", { action: "cancel" });

    expect(mocks.streamAnswers).not.toHaveBeenCalled();
  });

  it("retires a pending question when the user sends a message instead", async () => {
    // The server makes the same change when it writes the new user turn; doing it here too
    // is what keeps the card honest until the page is next reloaded.
    const store = await readyStore({ messages: [pending()] });
    streamOf({ type: "done" });

    await store.sendMessage("算了，先做别的");

    expect(toolCall(store)!.status).toBe("skipped");
    expect(toolCall(store)!.answer).toBeUndefined();
  });

  it("leaves an already-answered card alone when a new message is sent", async () => {
    const store = await readyStore({
      messages: [
        message({
          role: "assistant",
          toolCalls: [
            {
              id: "call_ask",
              name: "ask_user",
              input: JSON.stringify({ questions: QS }),
              status: "answered",
              answer: { "0": { selected: ["OAuth"] } },
            },
          ],
        }),
      ],
    });
    streamOf({ type: "done" });

    await store.sendMessage("继续");

    expect(toolCall(store)!.status).toBe("answered");
    expect(toolCall(store)!.answer).toEqual({ "0": { selected: ["OAuth"] } });
  });
});

describe("a quiz call, through the same plumbing", () => {
  const QS = [
    { id: "Q1", header: "窗口", question: "哪种窗口？", options: [{ label: "滚动" }, { label: "滑动" }] },
    {
      id: "Q2",
      header: "状态",
      question: "状态后端？",
      multiSelect: true,
      options: [{ label: "RocksDB" }, { label: "内存" }],
    },
  ];

  /** An assistant message holding one live `quiz` call, numbered as the tool would. */
  function pendingQuiz(): Message {
    return message({
      role: "assistant",
      content: "先测一下。",
      toolCalls: [
        { id: "call_quiz", name: "ila_quiz", input: JSON.stringify({ questions: QS }), status: "awaiting" },
      ],
    });
  }

  const quizCall = (store: ReturnType<typeof useAppStore>) =>
    store.messages.flatMap((m) => m.toolCalls ?? []).find((tc) => tc.id === "call_quiz");

  function answers(store: ReturnType<typeof useAppStore>, payload: unknown) {
    return store.answerQuestion("call_quiz", { action: "submit", answers: payload as never });
  }

  it("carries an answer keyed by question id, and records it locally", async () => {
    // The two suspending tools key their answers differently — by id, by position — and the
    // store is deliberately name-agnostic about it: it carries whichever shape the card
    // built, and the server reads it through the call's own registered spec.
    const store = await readyStore({ messages: [pendingQuiz()] });
    mocks.streamAnswers.mockImplementation(async function* () {
      yield { type: "done" } as ChatStreamEvent;
    });

    const payload = {
      Q1: { selected: ["滚动"] },
      Q2: { selected: ["RocksDB"], notes: "记不太准" },
    };
    await answers(store, payload);

    expect(quizCall(store)).toMatchObject({ status: "answered", answer: payload });
    expect(mocks.streamAnswers).toHaveBeenCalledWith("s1", {
      toolCallId: "call_quiz",
      action: "submit",
      answers: payload,
    });
  });

  it("puts the card back when the server refuses the answer", async () => {
    const store = await readyStore({ messages: [pendingQuiz()] });
    mocks.streamAnswers.mockImplementation(async function* () {
      throw new ApiError("QUESTION_NOT_PENDING", "这次小测已经不需要作答了", 409);
    });

    await answers(store, { Q1: { selected: ["滚动"] }, Q2: { selected: ["内存"] } });

    expect(quizCall(store)).toMatchObject({ status: "awaiting" });
    expect(quizCall(store)!.answer).toBeUndefined();
  });

  it("counts as a pending question when the user sends a message instead", async () => {
    // `awaitingToolCalls` is what `sendMessage` retires, and it has to see a quiz: a card
    // left answerable on a conversation that has moved on is the bug that list prevents.
    const store = await readyStore({ messages: [pendingQuiz()] });
    streamOf({ type: "done" });

    await store.sendMessage("算了，先讲别的");

    expect(quizCall(store)!.status).toBe("skipped");
  });
});

describe("stopMessage", () => {
  /** A turn held open, so the assertions land while the reply is still streaming. */
  function heldStream(): { release: () => void; finished: Promise<void> } {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let done: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: "text", delta: "half an answer" };
      await gate;
      yield { type: "done" };
      done();
    });
    return { release, finished };
  }

  it("asks the server, and leaves the partial reply to arrive down the stream", async () => {
    const store = await readyStore();
    mocks.api.stopSession.mockResolvedValue({ ok: true });
    const { release, finished } = heldStream();

    const sending = store.sendMessage("讲个故事");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.streaming.active).toBe(true);

    await store.stopMessage();
    expect(mocks.api.stopSession).toHaveBeenCalledWith("s1");

    // Nothing is invented locally: the server ends the turn with the usual `message_done`,
    // and the store winds down through the path a completed turn takes.
    release();
    await sending;
    await finished;
    expect(store.streaming.active).toBe(false);
    expect(store.streaming.stopping).toBe(false);
  });

  it("ignores a second press while the first is still in flight", async () => {
    const store = await readyStore();
    let settle: (v: { ok: boolean }) => void = () => undefined;
    mocks.api.stopSession.mockImplementation(
      () => new Promise((resolve) => (settle = resolve))
    );
    const { release } = heldStream();

    const sending = store.sendMessage("讲个故事");
    await vi.advanceTimersByTimeAsync(0);

    void store.stopMessage();
    expect(store.streaming.stopping).toBe(true);
    await store.stopMessage();

    expect(mocks.api.stopSession).toHaveBeenCalledTimes(1);

    settle({ ok: true });
    release();
    await sending;
  });

  it("does nothing when no turn is streaming", async () => {
    const store = await readyStore();

    await store.stopMessage();
    expect(mocks.api.stopSession).not.toHaveBeenCalled();
  });

  it("stays pressable when the request fails", async () => {
    // Nothing was stopped, so the control has to be usable again — a Stop that silently
    // stops working is worse than no Stop at all.
    const store = await readyStore();
    mocks.api.stopSession.mockRejectedValue(new Error("network is down"));
    const { release, finished } = heldStream();

    const sending = store.sendMessage("讲个故事");
    await vi.advanceTimersByTimeAsync(0);

    await store.stopMessage();

    expect(store.streaming.stopping).toBe(false);
    expect(store.error).toBe("network is down");
    // Still live, so the same control can be pressed again.
    expect(store.streaming.active).toBe(true);

    release();
    await sending;
    await finished;
  });
});

/* ------------------------------- file browser -------------------------------- */

const dirEntry = (path: string): FileEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type: "dir",
  size: null,
  modifiedAt: null,
});

const fileEntry = (path: string, size = 12): FileEntry => ({
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
  type: "file",
  size,
  modifiedAt: "2026-01-01T00:00:00.000Z",
});

const listing = (path: string, entries: FileEntry[], truncated = false): DirectoryListing => ({
  path,
  entries,
  truncated,
});

const ROOT = listing("", [dirEntry("src"), fileEntry("README.md")]);
const SRC = listing("src", [fileEntry("src/index.ts")]);

/** A promise the test resolves by hand, for asserting on what happens mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("file browser", () => {
  it("reads a directory once and reuses it", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockResolvedValue(ROOT);

    await store.loadDirectory("");
    expect(store.fileListings[""]).toEqual(ROOT);
    expect(mocks.api.listFiles).toHaveBeenCalledWith("w1", "");

    await store.loadDirectory("");
    expect(mocks.api.listFiles).toHaveBeenCalledTimes(1);
  });

  it("fetches a directory when it is opened, and only folds it away when closed", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockImplementation(async (_w: string, path: string) =>
      path === "" ? ROOT : SRC
    );

    await store.toggleDirectory("src");
    expect(store.fileExpanded).toEqual(["src"]);
    expect(store.fileListings["src"]).toEqual(SRC);

    await store.toggleDirectory("src");
    expect(store.fileExpanded).toEqual([]);
    // Folded away, not forgotten: reopening goes back to the cache, not to the server.
    await store.toggleDirectory("src");
    expect(store.fileExpanded).toEqual(["src"]);
    expect(mocks.api.listFiles).toHaveBeenCalledTimes(1);
  });

  /**
   * An expanded directory with no children is indistinguishable from an empty one, so a
   * failed read must not leave one on screen.
   */
  it("closes a directory whose listing failed, and says why", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockRejectedValue(new Error("读取失败"));

    await store.toggleDirectory("src");

    expect(store.fileExpanded).toEqual([]);
    expect(store.fileTreeError).toBe("读取失败");
  });

  it("clears a previous error once something succeeds", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockRejectedValueOnce(new Error("读取失败"));
    await store.toggleDirectory("src");

    mocks.api.listFiles.mockResolvedValue(ROOT);
    await store.loadDirectory("");

    expect(store.fileTreeError).toBeNull();
  });

  it("re-reads the root and every open directory on refresh", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockImplementation(async (_w: string, path: string) =>
      path === "" ? ROOT : SRC
    );
    await store.loadDirectory("");
    await store.toggleDirectory("src");
    mocks.api.listFiles.mockClear();

    await store.refreshFileTree();

    expect(mocks.api.listFiles.mock.calls.map((c) => c[1]).sort()).toEqual(["", "src"]);
  });

  it("reports a failed manual refresh but not a silent one", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockResolvedValue(ROOT);
    await store.loadDirectory("");

    mocks.api.listFiles.mockRejectedValue(new Error("服务器错误"));
    await store.refreshFileTree({ silent: true });
    expect(store.fileTreeError).toBeNull();

    await store.refreshFileTree();
    expect(store.fileTreeError).toBe("服务器错误");
  });

  it("does nothing on a silent refresh before the tree has ever been opened", async () => {
    const store = await readyStore();
    await store.refreshFileTree({ silent: true });
    expect(mocks.api.listFiles).not.toHaveBeenCalled();
  });

  it("shows a preview's path immediately, and its contents when they arrive", async () => {
    const store = await readyStore();
    const content = {
      path: "README.md",
      name: "README.md",
      size: 12,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      kind: "markdown" as const,
      text: "# hi",
      truncated: false,
    };
    const gate = deferred<void>();
    mocks.api.readFileContent.mockImplementation(async () => {
      await gate.promise;
      return content;
    });

    const promise = store.openFile("README.md");
    expect(store.filePreviewPath).toBe("README.md");
    expect(store.fileContentLoading).toBe(true);

    gate.resolve();
    await promise;
    expect(store.fileContent).toEqual(content);
    expect(store.fileContentLoading).toBe(false);
  });

  /**
   * The dialog is already open and the user asked for this file, so a failure has one
   * obvious home. Throwing would leave the dialog blank and the click looking inert.
   */
  it("keeps the dialog open with the reason when a file cannot be read", async () => {
    const store = await readyStore();
    mocks.api.readFileContent.mockRejectedValue(new Error("文件不存在"));

    await store.openFile("gone.txt");

    expect(store.filePreviewPath).toBe("gone.txt");
    expect(store.filePreviewError).toBe("文件不存在");
    expect(store.fileContent).toBeNull();
    expect(store.fileContentLoading).toBe(false);
  });

  it("clears the preview on close", async () => {
    const store = await readyStore();
    mocks.api.readFileContent.mockResolvedValue({
      path: "a.txt",
      name: "a.txt",
      size: 1,
      modifiedAt: "2026-01-01T00:00:00.000Z",
      kind: "text",
      text: "x",
      truncated: false,
    });
    await store.openFile("a.txt");

    store.closeFile();

    expect(store.filePreviewPath).toBeNull();
    expect(store.fileContent).toBeNull();
    expect(store.filePreviewError).toBeNull();
  });

  it("drops the tree and the open preview when the workspace changes", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockResolvedValue(ROOT);
    await store.loadDirectory("");
    await store.toggleDirectory("src").catch(() => undefined);
    store.filePreviewPath = "README.md";

    await store.selectWorkspace("w1");

    expect(store.fileListings).toEqual({});
    expect(store.fileExpanded).toEqual([]);
    expect(store.filePreviewPath).toBeNull();
  });

  /**
   * Paths are relative to the workspace that answered, so a reply that outlived its
   * workspace would put one workspace's files under another's name — and by then the tree
   * has been cleared, so it would be resurrecting it rather than appending to it.
   */
  it("drops a listing that arrives after the workspace changed", async () => {
    const store = await readyStore();
    const gate = deferred<DirectoryListing>();
    mocks.api.listFiles.mockReturnValue(gate.promise);

    const loading = store.loadDirectory("");
    await store.selectWorkspace("w2");
    gate.resolve(ROOT);
    await loading;

    expect(store.fileListings).toEqual({});
  });

  it("derives the visible rows from what is open", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockImplementation(async (_w: string, path: string) =>
      path === "" ? ROOT : SRC
    );
    await store.loadDirectory("");
    expect(store.fileRows.map((r) => r.entry.path)).toEqual(["src", "README.md"]);

    await store.toggleDirectory("src");
    expect(store.fileRows.map((r) => r.entry.path)).toEqual([
      "src",
      "src/index.ts",
      "README.md",
    ]);
  });

  it("reports how much of a truncated listing is on screen", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockResolvedValue(listing("", [fileEntry("a.txt")], true));

    await store.loadDirectory("");

    expect(store.fileTruncatedAt).toBe(1);
  });
});

describe("a conversation's own files", () => {
  const diagram = {
    path: "flow.mmd",
    name: "flow.mmd",
    size: 20,
    modifiedAt: "2026-01-01T00:00:00.000Z",
    kind: "diagram" as const,
    text: "flowchart TD\n  A --> B",
    truncated: false,
  };

  it("reads a session file from the conversation's own route", async () => {
    const store = await readyStore();
    mocks.api.readSessionFileContent.mockResolvedValue(diagram);

    await store.openFile("flow.mmd", "session");

    expect(mocks.api.readSessionFileContent).toHaveBeenCalledWith("s1", "flow.mmd");
    expect(mocks.api.readFileContent).not.toHaveBeenCalled();
    expect(store.filePreviewRoot).toBe("session");
    expect(store.fileContent).toEqual(diagram);
  });

  it("reads a workspace file by default, so the file tree is unchanged", async () => {
    // The parameter defaults: every call site that predates the second root reads the same
    // way it always did.
    const store = await readyStore();
    mocks.api.readFileContent.mockResolvedValue({ ...diagram, kind: "text", text: "x" });

    await store.openFile("README.md");

    expect(mocks.api.readFileContent).toHaveBeenCalledWith("w1", "README.md");
    expect(mocks.api.readSessionFileContent).not.toHaveBeenCalled();
    expect(store.filePreviewRoot).toBe("workspace");
  });

  it("opens nothing for a session file with no conversation", async () => {
    // There is nothing for the path to be relative to, and the dialog would show a file from
    // a conversation the user is not in.
    const store = await readyStore();
    store.activeSessionId = null;

    await store.openFile("flow.mmd", "session");

    expect(mocks.api.readSessionFileContent).not.toHaveBeenCalled();
    expect(store.filePreviewPath).toBeNull();
  });

  it("closes a conversation's file when the conversation changes", async () => {
    // It belongs to the conversation being left. Nothing else clears it there — a session
    // switch keeps the workspace, so `resetFileTree` does not run.
    const store = await readyStore();
    mocks.api.readSessionFileContent.mockResolvedValue(diagram);
    await store.openFile("flow.mmd", "session");

    await store.selectSession("s2");

    expect(store.filePreviewPath).toBeNull();
    expect(store.fileContent).toBeNull();
  });

  it("leaves a workspace file open when the conversation changes", async () => {
    // The workspace has not changed, so the file on screen is still the file it was. Closing
    // it would be a new behaviour for the tree, and not one anybody asked for.
    const store = await readyStore();
    mocks.api.readFileContent.mockResolvedValue({ ...diagram, kind: "text", text: "x" });
    await store.openFile("README.md");

    await store.selectSession("s2");

    expect(store.filePreviewPath).toBe("README.md");
  });

  it("drops a session file that arrives after the conversation changed", async () => {
    // The read is captured with its id before the await, so a switch mid-flight cannot land
    // one conversation's file under another's heading.
    const store = await readyStore();
    const gate = deferred<void>();
    mocks.api.readSessionFileContent.mockImplementation(async () => {
      await gate.promise;
      return diagram;
    });

    const loading = store.openFile("flow.mmd", "session");
    await store.selectSession("s2");
    gate.resolve();
    await loading;

    expect(store.fileContent).toBeNull();
    expect(store.fileContentLoading).toBe(false);
  });

  it("drops a reply that a later open has already superseded", async () => {
    const store = await readyStore();
    const first = deferred<void>();
    mocks.api.readFileContent
      .mockImplementationOnce(async () => {
        await first.promise;
        return { ...diagram, path: "slow.txt", name: "slow.txt", kind: "text", text: "slow" };
      })
      .mockResolvedValue({ ...diagram, path: "fast.txt", name: "fast.txt", kind: "text", text: "fast" });

    const slow = store.openFile("slow.txt");
    await store.openFile("fast.txt");
    first.resolve();
    await slow;

    expect(store.fileContent?.name).toBe("fast.txt");
    expect(store.filePreviewPath).toBe("fast.txt");
  });

  it("cancels an in-flight read when the preview is closed", async () => {
    const store = await readyStore();
    const gate = deferred<void>();
    mocks.api.readFileContent.mockImplementation(async () => {
      await gate.promise;
      return { ...diagram, path: "a.txt", name: "a.txt", kind: "text", text: "x" };
    });

    const loading = store.openFile("a.txt");
    store.closeFile();
    gate.resolve();
    await loading;

    expect(store.fileContent).toBeNull();
    expect(store.fileContentLoading).toBe(false);
  });
});

describe("the file tree after a turn", () => {
  it("re-reads an open tree, because a turn is what writes files", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockResolvedValue(ROOT);
    await store.loadDirectory("");
    mocks.api.listFiles.mockClear();
    streamOf({ type: "done" });

    await store.sendMessage("写一个文件");

    expect(mocks.api.listFiles).toHaveBeenCalledWith("w1", "");
  });

  it("costs nothing when the tree was never opened", async () => {
    const store = await readyStore();
    streamOf({ type: "done" });

    await store.sendMessage("你好");

    expect(mocks.api.listFiles).not.toHaveBeenCalled();
  });

  /**
   * The re-read is a courtesy to a panel the user may not even be looking at, so it must not
   * reach the toast — a turn that succeeded should not report a failure of something nobody
   * asked for.
   */
  it("swallows a failure so a good turn stays good", async () => {
    const store = await readyStore();
    mocks.api.listFiles.mockResolvedValue(ROOT);
    await store.loadDirectory("");
    mocks.api.listFiles.mockRejectedValue(new Error("服务器错误"));
    streamOf({ type: "done" });

    await store.sendMessage("你好");

    expect(store.error).toBeNull();
    expect(store.fileTreeError).toBeNull();
  });

  it("also covers a turn resumed by answering a question", async () => {
    const store = await readyStore({
      messages: [
        message({
          id: "a1",
          role: "assistant",
          content: "先确认一下",
          toolCalls: [
            {
              id: "call_ask",
              name: "ask_user",
              input: JSON.stringify({
                questions: [
                  {
                    header: "认证方式",
                    question: "要用哪种认证方式？",
                    options: [{ label: "OAuth" }, { label: "API Key" }],
                  },
                ],
              }),
              status: "awaiting",
            },
          ],
        }),
      ],
    });
    mocks.api.listFiles.mockResolvedValue(ROOT);
    await store.loadDirectory("");
    mocks.api.listFiles.mockClear();
    mocks.streamAnswers.mockImplementation(async function* () {
      yield { type: "done" };
    });

    await store.answerQuestion("call_ask", { action: "submit", answers: { "0": { selected: ["OAuth"] } } });

    expect(mocks.api.listFiles).toHaveBeenCalledWith("w1", "");
  });
});

describe("deleting and regenerating the last message", () => {
  it("swaps the optimistic user bubble for the row the server wrote", async () => {
    // Without this the bubble keeps a `local-…` id for the life of the page, and the tail
    // actions address rows by id — so deleting a message you had just sent would name an id
    // the server has never seen, and 404.
    const saved = message({ role: "user", content: "just sent" });
    const store = await readyStore();
    mocks.streamChat.mockImplementation(async function* () {
      yield { type: "message_saved", message: saved } as ChatStreamEvent;
      yield { type: "done" } as ChatStreamEvent;
    });

    await store.sendMessage("just sent");

    expect(store.messages.map((m) => m.id)).toEqual([saved.id]);
    expect(store.messages[0]!.id.startsWith("local-")).toBe(false);
  });

  it("removes a deleted message from the conversation", async () => {
    const first = message({ role: "user", content: "question" });
    const reply = message({ role: "assistant", content: "answer" });
    const store = await readyStore({ messages: [first, reply] });
    mocks.api.deleteMessage.mockResolvedValue({ ok: true });

    await store.deleteMessage(reply.id);

    expect(mocks.api.deleteMessage).toHaveBeenCalledWith("s1", reply.id);
    expect(store.messages.map((m) => m.id)).toEqual([first.id]);
  });

  it("keeps the message on screen when the server refuses, and says why", async () => {
    // The tail moved under the click (another tab, or a turn that started), so the row the
    // user aimed at is still there and a silent no-op is the one wrong answer.
    const reply = message({ role: "assistant", content: "answer" });
    const store = await readyStore({ messages: [reply] });
    mocks.api.deleteMessage.mockRejectedValue(new ApiError("MESSAGE_NOT_LAST", "not last", 409));

    await store.deleteMessage(reply.id);

    expect(store.messages.map((m) => m.id)).toEqual([reply.id]);
    expect(store.error).toBe("not last");
  });

  it("drops the old reply when the server says it is gone, then takes the new one", async () => {
    // The server soft-deletes the reply itself and announces it, so the store does not guess
    // — that is what keeps a regenerate from being a second opinion about what happened.
    const question = message({ role: "user", content: "question" });
    const old = message({ role: "assistant", content: "old answer" });
    const fresh = message({ role: "assistant", content: "new answer" });
    const store = await readyStore({ messages: [question, old] });

    mocks.streamRegenerate.mockImplementation(async function* () {
      yield { type: "message_removed", id: old.id } as ChatStreamEvent;
      // Visible mid-stream: the old reply is already gone, which is the point of the event.
      expect(store.messages.map((m) => m.id)).toEqual([question.id]);
      yield { type: "text", delta: "new" } as ChatStreamEvent;
      yield { type: "message_done", message: fresh } as ChatStreamEvent;
      yield { type: "done" } as ChatStreamEvent;
    });

    await store.regenerateLastMessage();

    expect(mocks.streamRegenerate).toHaveBeenCalledWith("s1");
    expect(store.messages.map((m) => m.content)).toEqual(["question", "new answer"]);
    expect(store.streaming.active).toBe(false);
  });

  it("does nothing while a turn is streaming", async () => {
    // Both tail actions are hidden mid-turn for the same reason; this is the race.
    const reply = message({ role: "assistant", content: "answer" });
    const store = await readyStore({ messages: [reply] });
    store.streaming = { ...store.streaming, active: true };

    await store.regenerateLastMessage();
    await store.deleteMessage(reply.id);

    expect(mocks.streamRegenerate).not.toHaveBeenCalled();
    expect(mocks.api.deleteMessage).not.toHaveBeenCalled();
  });

  it("regenerates only an assistant tail", async () => {
    const question = message({ role: "user", content: "question" });
    const store = await readyStore({ messages: [question] });

    await store.regenerateLastMessage();

    expect(mocks.streamRegenerate).not.toHaveBeenCalled();
  });

  it("leaves a reply that is still awaiting an answer alone", async () => {
    // The question card owns that state; regenerating would discard the question.
    const suspended = message({
      role: "assistant",
      content: "may I ask?",
      toolCalls: [
        { id: "call_ask", name: "ask_user", input: "{}", status: "awaiting" },
      ],
    });
    const store = await readyStore({ messages: [suspended] });

    await store.regenerateLastMessage();

    expect(mocks.streamRegenerate).not.toHaveBeenCalled();
  });
});

describe("the note export", () => {
  /*
   * The run is asynchronous on the server, so the store's half is a poll — and the poll is what
   * these pin: that it starts, that it stops the moment the run settles, and that a reply
   * arriving after the reader has switched conversations is dropped rather than shown as this
   * conversation's state.
   */
  const settled = {
    status: "ok" as const,
    startedAt: "2026-09-16T06:00:00.000Z",
    finishedAt: "2026-09-16T06:00:01.000Z",
    added: 2,
    updated: 0,
    removed: 0,
    error: null,
    stuck: false,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("follows a run to its end, then stops asking", async () => {
    const store = await readyStore();
    mocks.api.startNoteSync.mockResolvedValue({ sync: { ...settled, status: "running" } });
    mocks.api.getNoteSync
      .mockResolvedValueOnce({ sync: { ...settled, status: "running" } })
      .mockResolvedValue({ sync: settled });

    await store.syncNotesToLibrary();
    expect(store.noteSyncing).toBe(true);
    expect(store.noteSync?.status).toBe("running");

    // The first poll fires immediately rather than after a full interval, and reports that the
    // run is still going — so the poll keeps going rather than settling on its first answer.
    await vi.advanceTimersByTimeAsync(0);
    expect(store.noteSync?.status).toBe("running");
    expect(store.noteSyncing).toBe(true);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.noteSync?.status).toBe("ok");
    expect(store.noteSyncing).toBe(false);

    // Settled: no further polling, so an idle conversation does not keep asking the server.
    const calls = mocks.api.getNoteSync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.api.getNoteSync).toHaveBeenCalledTimes(calls);
  });

  it("forces only when the caller says the last run is stuck", async () => {
    const store = await readyStore();
    mocks.api.startNoteSync.mockResolvedValue({ sync: { ...settled, status: "running" } });

    await store.syncNotesToLibrary();
    expect(mocks.api.startNoteSync).toHaveBeenLastCalledWith("s1", {});
    await vi.advanceTimersByTimeAsync(10_000);

    // The recovery carries the flag; an ordinary press never does, because forcing a live run is
    // a second export over the same files.
    await store.syncNotesToLibrary(true);
    expect(mocks.api.startNoteSync).toHaveBeenLastCalledWith("s1", { force: true });
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it("reports a refused start, and re-reads the state that refused it", async () => {
    // A 409 means another run is live. The press has to say so — a button that does nothing is
    // what this app keeps out of the UI — and the panel should then show the run that refused it.
    const store = await readyStore();
    mocks.api.startNoteSync.mockRejectedValue(new ApiError("SYNC_IN_PROGRESS", "already", 409));
    mocks.api.getNoteSync.mockResolvedValue({ sync: { ...settled, status: "running" } });

    await store.syncNotesToLibrary();
    expect(store.error).toBeTruthy();
    expect(store.noteSyncing).toBe(false);
    expect(store.noteSync?.status).toBe("running");
  });

  it("does not carry one conversation's export state into the next", async () => {
    /*
     * The export state is per conversation, and both halves of that are asserted here: the switch
     * clears what was on screen, and it stops the poll with it. A poll left running would settle
     * the *previous* conversation's run into the one now open — a status line about somebody
     * else's notes, which is exactly the "reply for a session that is no longer active" the other
     * lists guard against with a sequence number.
     */
    const store = await readyStore();
    mocks.api.startNoteSync.mockResolvedValue({ sync: { ...settled, status: "running" } });
    // Each conversation answers for itself, which is what makes the clearing observable.
    mocks.api.getNoteSync.mockImplementation((id: string) =>
      Promise.resolve({ sync: id === "s1" ? settled : null })
    );

    await store.syncNotesToLibrary();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(store.noteSync?.status).toBe("ok");

    mocks.api.listMessages.mockResolvedValue([]);
    await store.selectSession("s2");
    expect(store.noteSync).toBeNull();

    // The poll went with it: only the switch's own read has been made since.
    const calls = mocks.api.getNoteSync.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.api.getNoteSync).toHaveBeenCalledTimes(calls);
  });
});

/**
 * Session write locks.
 *
 * The store's half of the feature: it records which conversations are held and by whom, and it
 * offers the two flags the UI reads. What it deliberately does *not* do is enforce anything —
 * the server refuses the write — so a test here is about the state being right when the server
 * says a conversation is somebody else's.
 *
 * `composables/sessionLock.test.ts` owns the lifetimes (the heartbeat and the release on the way
 * out), because those are the view's, not the store's.
 */
describe("session write locks", () => {
  /** A refusal, shaped exactly as the client's error normaliser builds one. */
  function lockedError() {
    return new ApiError("SESSION_LOCKED", "held by another client", 409);
  }

  function lease(overrides: Partial<SessionLockView> = {}): SessionLockView {
    return {
      sessionId: "s1",
      clientId: "other-client",
      mine: false,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:02:00.000Z",
      ...overrides,
    };
  }

  it("takes the conversation's lock on the way in", async () => {
    const store = await readyStore();
    expect(mocks.api.acquireSessionLock).toHaveBeenCalledWith("s1");
    expect(store.heldSessionId).toBe("s1");
    expect(store.holdsActiveSessionLock).toBe(true);
    expect(store.isActiveSessionReadOnly).toBe(false);
  });

  it("marks the conversation read-only when another client holds it", async () => {
    // The 409 is an answer rather than a failure: it is how this client learns the conversation
    // is somebody else's. So it must not throw out of `selectSession`, and it must land in the
    // state the composer reads.
    mocks.api.acquireSessionLock.mockRejectedValue(lockedError());
    const store = await readyStore();

    expect(store.isActiveSessionReadOnly).toBe(true);
    expect(store.holdsActiveSessionLock).toBe(false);
    // And it does not claim to hold what it was refused.
    expect(store.heldSessionId).toBeNull();
  });

  it("gives back the conversation it was holding when another one is opened", async () => {
    // A client holds at most one lease, and the one it owes is the one it took — not "whatever
    // was on screen before", which a click on the same row twice would get wrong.
    const store = await readyStore({ sessions: [session(), session({ id: "s2" })] });
    mocks.api.listMessages.mockResolvedValue([]);

    await store.selectSession("s2");

    expect(mocks.api.releaseSessionLock).toHaveBeenCalledWith("s1");
    expect(mocks.api.acquireSessionLock).toHaveBeenCalledWith("s2");
  });

  it("does not release the conversation it is re-opening", async () => {
    const store = await readyStore();
    await store.selectSession("s1");
    expect(mocks.api.releaseSessionLock).not.toHaveBeenCalled();
  });

  it("carries every lock in the workspace, with mine settled per conversation", async () => {
    const store = await readyStore({
      sessions: [session(), session({ id: "s2" })],
    });
    mocks.api.listWorkspaceLocks.mockResolvedValue({
      locks: [lease({ mine: true }), lease({ sessionId: "s2" })],
    });

    await store.refreshWorkspaceLocks();

    expect(mocks.api.listWorkspaceLocks).toHaveBeenCalledWith("w1");
    expect(Object.keys(store.sessionLocks).sort()).toEqual(["s1", "s2"]);
    expect(store.sessionLocks["s1"]?.mine).toBe(true);
    expect(store.sessionLocks["s2"]?.mine).toBe(false);
  });

  it("reads the workspace's locks on entering it, in one request", async () => {
    // One request for the whole list is the shape's whole point: the marks are drawn on the
    // session list, so a per-conversation check would be N requests on every entry.
    const store = useAppStore();
    await enterApp(store);
    await store.selectWorkspace("w1");
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.api.listWorkspaceLocks).toHaveBeenCalledWith("w1");
  });

  it("joins a read that is already in flight rather than making a second request", async () => {
    // Entering a workspace reads the list alongside the session list, and then mounts the chat
    // view whose lock lifecycle reads it again — one action, two asks. The second waits for the
    // first instead of starting its own, which is the auto-titler's "joined rather than
    // duplicated" rule.
    const store = useAppStore();
    await enterApp(store);
    await store.selectWorkspace("w1");
    mocks.api.listWorkspaceLocks.mockClear();

    const first = store.refreshWorkspaceLocks();
    const second = store.refreshWorkspaceLocks();
    await Promise.all([first, second]);

    expect(mocks.api.listWorkspaceLocks).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh read once the one in flight has finished", async () => {
    // The join is per *moment*, not a cache: a later ask is a later ask, or the dot would never
    // catch up with a lease taken while the first read was in the air.
    const store = await readyStore();
    mocks.api.listWorkspaceLocks.mockClear();

    await store.refreshWorkspaceLocks();
    await store.refreshWorkspaceLocks();

    expect(mocks.api.listWorkspaceLocks).toHaveBeenCalledTimes(2);
  });

  it("drops the previous workspace's marks rather than leaving them behind", async () => {
    const store = await readyStore();
    mocks.api.listWorkspaceLocks.mockResolvedValue({ locks: [lease()] });
    await store.refreshWorkspaceLocks();
    expect(Object.keys(store.sessionLocks)).toEqual(["s1"]);

    mocks.api.listWorkspaceLocks.mockResolvedValue({ locks: [] });
    await store.selectWorkspace("w1");

    expect(store.sessionLocks).toEqual({});
    expect(store.heldSessionId).toBeNull();
  });

  it("turns a refused turn into the read-only state", async () => {
    // The last way this client learns a lease changed, and the one the requirement names: the
    // heartbeat failed, the lease expired underneath a reader who was typing, and the server
    // refuses the turn. Re-reading is what turns the error into a state instead of a one-off
    // sentence that leaves the buttons looking live.
    const store = await readyStore();
    mocks.api.listWorkspaceLocks.mockResolvedValue({ locks: [lease()] });
    mocks.streamChat.mockImplementation(async function* () {
      throw lockedError();
    });

    await store.sendMessage("hello");
    await vi.advanceTimersByTimeAsync(0);

    expect(store.isActiveSessionReadOnly).toBe(true);
    // Both surfaces: the banner inside the streaming message, and the toast that outlives it.
    expect(store.streaming.error).toBeTruthy();
    expect(store.error).toBeTruthy();
  });

  it("does not re-read on an ordinary failure", async () => {
    // A provider outage is not a lock change, and a workspace-wide read on every failed turn
    // would be a request per outage for a state that did not move.
    const store = await readyStore();
    mocks.api.listWorkspaceLocks.mockClear();
    mocks.streamChat.mockImplementation(async function* () {
      throw new Error("upstream is down");
    });

    await store.sendMessage("hello");
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.api.listWorkspaceLocks).not.toHaveBeenCalled();
    expect(store.isActiveSessionReadOnly).toBe(false);
  });

  it("forgets every lock with the account", async () => {
    // A lease held by a signed-out account would keep beating, and a stale list would hand the
    // next account a read-only conversation that is not its own.
    const store = await readyStore();
    mocks.api.listWorkspaceLocks.mockResolvedValue({ locks: [lease()] });
    await store.refreshWorkspaceLocks();
    expect(store.sessionLocks).not.toEqual({});

    store.signOut();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.sessionLocks).toEqual({});
    expect(store.heldSessionId).toBeNull();
    expect(store.isActiveSessionReadOnly).toBe(false);
  });

  it("answers a workspace it cannot read with the locks it already had", async () => {
    // A failed read is not a reason to strip the marks off the conversations: the dots would
    // flicker on every hiccup, and the server refuses what it should refuse regardless of what
    // this client believes.
    const store = await readyStore();
    mocks.api.listWorkspaceLocks.mockResolvedValue({ locks: [lease()] });
    await store.refreshWorkspaceLocks();

    mocks.api.listWorkspaceLocks.mockRejectedValue(new Error("offline"));
    await store.refreshWorkspaceLocks();

    expect(Object.keys(store.sessionLocks)).toEqual(["s1"]);
  });
});
