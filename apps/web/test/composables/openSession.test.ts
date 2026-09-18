import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import type { Session } from "@ilearnassist/shared";

/**
 * Opening a conversation from a list of them.
 *
 * One rule, and it exists because a URL is not always a request: pushing the address the tab is
 * already at is a navigation the router may skip, guards and all. That is right for a link and
 * wrong for this — a reader clicking the conversation they are already in is asking to *read*
 * it again, which is also how a client picks up a write lease somebody else has just let go.
 */

const mocks = vi.hoisted(() => ({
  api: {
    listMessages: vi.fn(),
    listSessionWidgets: vi.fn(),
    acquireSessionLock: vi.fn(),
    releaseSessionLock: vi.fn(),
  },
  setUnauthenticatedHandler: vi.fn(),
}));

vi.mock("../../src/api/client", () => ({
  api: mocks.api,
  setUnauthenticatedHandler: mocks.setUnauthenticatedHandler,
  streamChat: vi.fn(),
  streamAnswers: vi.fn(),
  streamRegenerate: vi.fn(),
  fileToBase64: vi.fn(),
  fileImageUrl: (id: string) => Promise.resolve(`blob:files/${id}`),
}));

const { useAppStore } = await import("../../src/stores/app.js");
const { openSession } = await import("../../src/composables/openSession.js");

const session = (id: string): Session =>
  ({
    id,
    workspaceId: "w1",
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: "Reading",
    titleSource: "user",
    settings: {},
    description: "",
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }) as Session;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();
  mocks.api.listMessages.mockResolvedValue([]);
  mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session: [] });
  mocks.api.acquireSessionLock.mockResolvedValue({ lock: null });
  mocks.api.releaseSessionLock.mockResolvedValue({ released: true });
});

/** A router with only the two routes this needs, and no lazy components to load. */
function makeRouter() {
  const blank = { render: () => null };
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", name: "home", component: blank, meta: { view: "home" } },
      { path: "/w/:workspaceId", name: "workspace", component: blank, meta: { view: "chat" } },
      {
        path: "/w/:workspaceId/s/:sessionId",
        name: "session",
        component: blank,
        meta: { view: "chat" },
      },
    ],
  });
}

describe("openSession", () => {
  it("addresses a conversation that is not the one on screen", async () => {
    const router = makeRouter();
    const store = useAppStore();
    store.activeWorkspaceId = "w1";
    store.activeSessionId = "s1";

    openSession(router, store, "s2");
    await router.isReady();

    expect(router.currentRoute.value.path).toBe("/w/w1/s/s2");
    // Nothing is loaded here — the route's own guard does that. Asserted because it is the
    // division this module sits on the edge of.
    expect(mocks.api.listMessages).not.toHaveBeenCalled();
  });

  it("re-reads the conversation already on screen", async () => {
    /*
     * The case a router cannot express, and the reason this is not a `router.push` at each call
     * site: the address does not move, so the navigation is skipped — and skipping it would
     * mean the click did nothing. What the reader asked for is the conversation.
     */
    const router = makeRouter();
    const store = useAppStore();
    store.activeWorkspaceId = "w1";
    store.activeSessionId = "s1";
    await router.push("/w/w1/s/s1");
    const messagesBefore = mocks.api.listMessages.mock.calls.length;

    openSession(router, store, "s1");

    expect(mocks.api.listMessages.mock.calls.length).toBe(messagesBefore + 1);
    expect(mocks.api.listMessages).toHaveBeenLastCalledWith("s1");
    // And the lease is re-taken, which is what the second client in `session-lock.spec.ts` is
    // waiting for.
    expect(mocks.api.acquireSessionLock).toHaveBeenCalledWith("s1");
    expect(router.currentRoute.value.path).toBe("/w/w1/s/s1");
  });
});
