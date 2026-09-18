import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, type EffectScope } from "vue";
import { createPinia, setActivePinia } from "pinia";
import type { SessionLockView } from "@ilearnassist/shared";

/**
 * The lock's lifetimes — the heartbeat, the poll, and the release on the way out.
 *
 * Run inside a real `effectScope` rather than by calling the function bare, because the whole
 * point of `useSessionLock` is that its timers belong to a *scope*: `onScopeDispose` is what
 * stops them when the view goes, and a test without a scope would be testing everything except
 * the part that matters.
 *
 * The host components in the browser suite cover the rendering; this covers the arithmetic, which
 * a browser run is a slow and indirect way to check a timer.
 */

const mocks = vi.hoisted(() => ({
  api: {
    acquireSessionLock: vi.fn(),
    releaseSessionLock: vi.fn(),
    listWorkspaceLocks: vi.fn(),
    listSessions: vi.fn(),
    listMessages: vi.fn(),
    listSessionWidgets: vi.fn(),
    listWorkspaceWidgets: vi.fn(),
    me: vi.fn(),
    getConfig: vi.fn(),
    listWorkspaces: vi.fn(),
    listCopilots: vi.fn(),
  },
}));

vi.mock("../../src/api/client", () => ({
  api: mocks.api,
  setStoredTokens: vi.fn(),
  setUnauthenticatedHandler: vi.fn(),
  streamChat: vi.fn(),
  streamAnswers: vi.fn(),
  streamRegenerate: vi.fn(),
  fileToBase64: vi.fn(),
  fileImageUrl: (id: string) => Promise.resolve(`blob:${id}`),
}));

const { useAppStore, SESSION_LOCK_HEARTBEAT_MS } = await import("../../src/stores/app.js");
const { useSessionLock } = await import("../../src/composables/sessionLock.js");

const WORKSPACE = {
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

const ACCOUNT = {
  id: "u1",
  username: "Ada",
  slug: "ada",
  roles: ["superadmin"],
  mustChangePassword: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SESSION = {
  id: "s1",
  workspaceId: "w1",
  copilotId: null,
  copilotName: "",
  systemPrompt: "",
  allTools: true,
  tools: [],
  title: "One",
  titleSource: "auto" as const,
  settings: {},
  description: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function lease(sessionId: string, mine: boolean): SessionLockView {
  return {
    sessionId,
    clientId: mine ? "this-client" : "other-client",
    mine,
    acquiredAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:02:00.000Z",
  };
}

/** Start the composable in a scope of its own, the way `ChatView`'s setup does. */
function startLock(): EffectScope {
  const scope = effectScope();
  scope.run(() => useSessionLock());
  return scope;
}

/** Sign in and open a workspace, so the store is in the state the composable expects. */
async function readyStore() {
  const store = useAppStore();
  await store.probeAccount();
  await store.ensureLoaded();
  await store.selectWorkspace("w1");
  await vi.advanceTimersByTimeAsync(0);
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.clearAllMocks();

  mocks.api.me.mockResolvedValue(structuredClone(ACCOUNT));
  mocks.api.listWorkspaces.mockResolvedValue([structuredClone(WORKSPACE)]);
  mocks.api.listCopilots.mockResolvedValue([]);
  mocks.api.listSessions.mockResolvedValue([structuredClone(SESSION)]);
  mocks.api.listMessages.mockResolvedValue([]);
  mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session: [] });
  mocks.api.listWorkspaceWidgets.mockResolvedValue([]);
  // Re-established per test rather than only in the hoisted factory: `vi.clearAllMocks()` clears
  // calls and not implementations, so a test that made the acquire refuse would leave it refusing
  // for every test after it.
  mocks.api.acquireSessionLock.mockImplementation((sessionId: string) =>
    Promise.resolve({ lock: lease(sessionId, true) })
  );
  mocks.api.releaseSessionLock.mockResolvedValue({ released: true });
  mocks.api.listWorkspaceLocks.mockResolvedValue({ locks: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useSessionLock", () => {
  it("reads the workspace's locks when it starts", async () => {
    await readyStore();
    const scope = startLock();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.api.listWorkspaceLocks).toHaveBeenCalledWith("w1");
    scope.stop();
  });

  it("beats for the conversation it holds", async () => {
    const store = await readyStore();
    const scope = startLock();
    await store.selectSession("s1");
    await vi.advanceTimersByTimeAsync(0);
    mocks.api.acquireSessionLock.mockClear();

    await vi.advanceTimersByTimeAsync(SESSION_LOCK_HEARTBEAT_MS);

    expect(mocks.api.acquireSessionLock).toHaveBeenCalledWith("s1");
    scope.stop();
  });

  it("does not beat for a conversation it does not hold", async () => {
    // Beating for somebody else's conversation would be asking the server to give it away once a
    // minute — a refusal per beat rather than a lease. The guard is what makes the 409 a one-off
    // that settles into read-only instead of a loop.
    const store = await readyStore();
    mocks.api.acquireSessionLock.mockClear();
    const scope = startLock();
    await vi.advanceTimersByTimeAsync(SESSION_LOCK_HEARTBEAT_MS);

    expect(store.heldSessionId).toBeNull();
    expect(mocks.api.acquireSessionLock).not.toHaveBeenCalled();
    scope.stop();
  });

  it("stops beating once the conversation is not the one on screen", async () => {
    // A conversation left open in another tab is not this tab's to keep alive.
    const store = await readyStore();
    const scope = startLock();
    await store.selectSession("s1");
    await vi.advanceTimersByTimeAsync(0);
    mocks.api.acquireSessionLock.mockClear();

    store.$patch({ activeSessionId: "s2" });
    await vi.advanceTimersByTimeAsync(SESSION_LOCK_HEARTBEAT_MS);

    expect(mocks.api.acquireSessionLock).not.toHaveBeenCalled();
    scope.stop();
  });

  it("re-reads the workspace's locks on its own, without being asked", async () => {
    // The backstop for the changes this client cannot know about — another client taking or
    // releasing a conversation while this one sits still.
    const store = await readyStore();
    const scope = startLock();
    await vi.advanceTimersByTimeAsync(0);
    mocks.api.listWorkspaceLocks.mockClear();

    // Two advances, because the poll *asks* rather than reads: it goes through the same debounce
    // every other trigger uses, so the interval firing and the request going out are two moments.
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.api.listWorkspaceLocks).toHaveBeenCalled();
    scope.stop();
  });

  it("releases the lease and stops every timer when the view goes away", async () => {
    // Leaving the workspace, in the only terms the client can see it: the scope stops. This is
    // the whole reason the lock lives in a scope — see the composable's own comment.
    const store = await readyStore();
    const scope = startLock();
    await store.selectSession("s1");
    await vi.advanceTimersByTimeAsync(0);
    expect(store.heldSessionId).toBe("s1");
    mocks.api.acquireSessionLock.mockClear();
    mocks.api.listWorkspaceLocks.mockClear();

    scope.stop();
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.api.releaseSessionLock).toHaveBeenCalledWith("s1");
    expect(store.heldSessionId).toBeNull();

    // And nothing keeps running: no beat, no poll.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(mocks.api.acquireSessionLock).not.toHaveBeenCalled();
    expect(mocks.api.listWorkspaceLocks).not.toHaveBeenCalled();
  });

  it("collapses a burst of change into one read", async () => {
    // Every state change asks for a read; they must not each become a request. A switch between
    // two conversations is one check, not two.
    const store = await readyStore();
    const scope = startLock();
    await vi.advanceTimersByTimeAsync(0);
    mocks.api.listWorkspaceLocks.mockClear();

    store.requestLockRefresh();
    store.requestLockRefresh();
    store.requestLockRefresh();
    expect(mocks.api.listWorkspaceLocks).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.api.listWorkspaceLocks).toHaveBeenCalledTimes(1);
    scope.stop();
  });
});
