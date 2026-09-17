import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, type EffectScope } from "vue";
import type { SessionLockView, WidgetId } from "@ilearnassist/shared";

/**
 * Which widget is told it is live, and when.
 *
 * The hook exists because a widget cannot work this out for itself: `WidgetPanel` mounts only
 * the active tab, so anything a widget needs for as long as it is *installed* — rather than
 * for as long as it is *visible* — has to come from outside the component. These are the
 * three inputs that decide it, plus the one transition no input can express: leaving the
 * view. That last one is what the scope is for, and it is why this is not a store `watch`.
 */

const mocks = vi.hoisted(() => ({
  api: {
    listNotes: vi.fn(() => Promise.resolve({ notes: [] })),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    listWorkspaces: vi.fn(() => Promise.resolve([])),
    listSessions: vi.fn(() => Promise.resolve([])),
    listMessages: vi.fn(() => Promise.resolve([])),
    getConfig: vi.fn(() =>
      Promise.resolve({ providers: [], models: [], defaults: {}, systemPrompt: "" })
    ),
    listSessionWidgets: vi.fn(() => Promise.resolve({ workspace: [], session: [] })),
    listWorkspaceWidgets: vi.fn(() => Promise.resolve([])),
    listCopilots: vi.fn(() => Promise.resolve([])),
    listSources: vi.fn(() => Promise.resolve([])),
    // The lock list, because the session's writability — which is one of the inputs this effect
    // gathers into a widget's context — comes from what the server reports here.
    listWorkspaceLocks: vi.fn(
      (): Promise<{ locks: SessionLockView[] }> => Promise.resolve({ locks: [] })
    ),
    acquireSessionLock: vi.fn(),
    releaseSessionLock: vi.fn(),
  },
}));

vi.mock("../../src/api/client", () => ({
  ...mocks,
  setUnauthenticatedHandler: vi.fn(),
  streamChat: vi.fn(),
  streamAnswers: vi.fn(),
  streamRegenerate: vi.fn(),
  fileToBase64: vi.fn(),
  sourceImageUrl: (id: string) => Promise.resolve(`blob:${id}`),
}));

const { useAppStore } = await import("../../src/stores/app.js");
const { useWidgetActivation } = await import("../../src/composables/widgetActivation.js");
const { WIDGET_MODULES } = await import("../../src/widgets/registry.js");

/** Every `onActive` call, in order, with the widget it was for. */
let calls: Array<[WidgetId, unknown]> = [];
const originals = new Map<WidgetId, unknown>();

function spyOnActive(): void {
  for (const [id, module] of Object.entries(WIDGET_MODULES)) {
    originals.set(id as WidgetId, module.onActive);
    module.onActive = (ctx) => calls.push([id as WidgetId, ctx]);
  }
}

function restoreOnActive(): void {
  for (const [id, original] of originals) {
    WIDGET_MODULES[id].onActive = original as never;
  }
  originals.clear();
}

let scope: EffectScope;

beforeEach(() => {
  calls = [];
  setActivePinia(createPinia());
  spyOnActive();
  scope = effectScope();
});

afterEach(() => {
  scope.stop();
  restoreOnActive();
});

/** The calls for one widget, newest last. */
function contextsOf(id: WidgetId): unknown[] {
  return calls.filter(([widgetId]) => widgetId === id).map(([, ctx]) => ctx);
}

describe("activating the installed widgets", () => {
  it("says nothing is live until a conversation is open", async () => {
    scope.run(() => useWidgetActivation());
    await nextTick();
    // A widget installed on the workspace is not on screen while no conversation is: the
    // panel is rendered beside one.
    expect(contextsOf("notes")).toEqual([null]);
  });

  it("activates the widget installed on the open conversation", async () => {
    const store = useAppStore();
    store.activeSessionId = "s1";
    (store as unknown as { sessionWidgets: unknown[] }).sessionWidgets = [
      { id: "notes", scope: "session", enabled: true },
    ];

    scope.run(() => useWidgetActivation());
    await nextTick();

    expect(contextsOf("notes").at(-1)).toEqual({
      scope: "session",
      scopeId: "s1",
      widgetId: "notes",
      // Nothing holds the conversation, so it accepts writes.
      writable: true,
    });
  });

  it("tells the widget the conversation is read-only when another client holds it", async () => {
    // The parameter the notes widget obeys, and the reason it is a parameter: the widget is *told*
    // by the session rather than looking it up, so nothing on the notes path has to know what a
    // write lock is. See `WidgetContext.writable`.
    const store = useAppStore();
    store.activeWorkspaceId = "w1";
    store.activeSessionId = "s1";
    (store as unknown as { sessionWidgets: unknown[] }).sessionWidgets = [
      { id: "notes", scope: "session", enabled: true },
    ];
    mocks.api.listWorkspaceLocks.mockResolvedValue({
      locks: [
        {
          sessionId: "s1",
          clientId: "another-client",
          mine: false,
          acquiredAt: "2026-01-01T00:00:00.000Z",
          expiresAt: "2026-01-01T00:02:00.000Z",
        },
      ],
    });

    scope.run(() => useWidgetActivation());
    await store.refreshWorkspaceLocks();
    await nextTick();

    expect(contextsOf("notes").at(-1)).toMatchObject({ scope: "session", writable: false });
  });

  it("prefers the conversation's install over the workspace's", async () => {
    const store = useAppStore();
    store.activeWorkspaceId = "w1";
    store.activeSessionId = "s1";
    (store as unknown as { workspaceWidgets: unknown[] }).workspaceWidgets = [
      { id: "notes", scope: "workspace", enabled: true },
    ];
    (store as unknown as { sessionWidgets: unknown[] }).sessionWidgets = [
      { id: "notes", scope: "session", enabled: true },
    ];

    scope.run(() => useWidgetActivation());
    await nextTick();

    // A session belongs to a workspace, so a widget installed at both is the more specific
    // install that matters on screen — the claim it takes has to name the conversation.
    expect(contextsOf("notes").at(-1)).toEqual({
      scope: "session",
      scopeId: "s1",
      widgetId: "notes",
      writable: true,
    });
  });

  it("reports a widget that is not installed as not live", async () => {
    const store = useAppStore();
    store.activeSessionId = "s1";

    scope.run(() => useWidgetActivation());
    await nextTick();
    expect(contextsOf("notes").at(-1)).toBeNull();
  });

  it("deactivates everything when the view goes away", async () => {
    const store = useAppStore();
    store.activeSessionId = "s1";
    (store as unknown as { sessionWidgets: unknown[] }).sessionWidgets = [
      { id: "notes", scope: "session", enabled: true },
    ];

    scope.run(() => useWidgetActivation());
    await nextTick();
    expect(contextsOf("notes").at(-1)).not.toBeNull();

    // Leaving the chat view is the transition no reactive input expresses — the panel is
    // simply gone — so the scope has to report it, or a widget keeps whatever it claimed for
    // a conversation nobody is looking at.
    scope.stop();
    await nextTick();
    expect(contextsOf("notes").at(-1)).toBeNull();
  });
});
