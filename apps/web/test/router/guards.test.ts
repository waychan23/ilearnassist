import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicConfig, Session, User, Workspace } from "@ilearnassist/shared";
import { INSTANCE_STORAGE_KEY } from "@ilearnassist/shared";
import { i18n } from "../../src/i18n.js";
import { uiState, toggleSidebar } from "../../src/composables/ui.js";

/**
 * The bridge between the URL and the store.
 *
 * This is the file the whole change rests on: the route says where you are, the store says what
 * is loaded, and `beforeEach` is the only thing that crosses between them. So the cases here are
 * the transitions rather than the pages — a bookmark into a conversation, a URL naming something
 * that is gone, a page the account is not allowed to see, and what is torn down on the way out of
 * one page into another.
 *
 * It runs against the **real route table** from `src/router/index.ts`, so the paths and the
 * guards under test are the ones the app installs. What it does not run is the pages themselves:
 * the route components are mocked, because a navigation would otherwise fetch six `.vue` files
 * and their imports to render nothing this file asserts on. The guards never look at a
 * component — `meta` is the whole of what they read.
 *
 * The router is a **new one per test**, over the shared table. The app's own instance lives in
 * the history, and a test that started where the last one finished would be testing a
 * navigation vue-router is entitled to skip as a duplicate. One case below does need the app's
 * instance — `sidebarRail` reads it and nothing else — and says so where it is.
 */

const mocks = vi.hoisted(() => ({
  api: {
    me: vi.fn(),
    // `syncInstallation`'s only call. Mocked here because the address it drops is a *guard*
    // behaviour as much as a storage one — see "an address from another installation".
    health: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
    getConfig: vi.fn(),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn(),
    listCopilots: vi.fn(),
    listSessions: vi.fn(),
    listMessages: vi.fn(),
    listWorkspaceWidgets: vi.fn(),
    listSessionWidgets: vi.fn(),
    listWorkspaceLocks: vi.fn(),
    acquireSessionLock: vi.fn(),
    releaseSessionLock: vi.fn(),
    reportSessionLeave: vi.fn(),
  },
  streamChat: vi.fn(),
  streamAnswers: vi.fn(),
  streamRegenerate: vi.fn(),
  fileToBase64: vi.fn(),
  setUnauthenticatedHandler: vi.fn(),
}));

vi.mock("../../src/api/client", () => ({
  api: mocks.api,
  streamChat: mocks.streamChat,
  streamAnswers: mocks.streamAnswers,
  streamRegenerate: mocks.streamRegenerate,
  fileToBase64: mocks.fileToBase64,
  setUnauthenticatedHandler: mocks.setUnauthenticatedHandler,
  fileImageUrl: (id: string) => Promise.resolve(`blob:files/${id}`),
  // `composables/instance.ts` destructures this at module scope, so the mock has to carry it or
  // importing that module throws before any test runs.
  setStoredTokens: vi.fn(),
}));

// The six pages, stubbed. See the file comment: the guards read `meta`, so a component that
// renders nothing is the same route to them as the real one — and this keeps a routing test from
// loading the markdown pipeline and the diagram renderer.
const stub = (name: string) => ({ default: { name, render: () => null } });
vi.mock("../../src/components/WorkspaceHome.vue", () => stub("WorkspaceHome"));
vi.mock("../../src/components/ChatView.vue", () => stub("ChatView"));
vi.mock("../../src/components/LoginView.vue", () => stub("LoginView"));
vi.mock("../../src/components/ChangePasswordView.vue", () => stub("ChangePasswordView"));
vi.mock("../../src/components/AccountView.vue", () => stub("AccountView"));
vi.mock("../../src/components/AdminConsole.vue", () => stub("AdminConsole"));

const { routes } = await import("../../src/router/index.js");
const { router: appRouter } = await import("../../src/router/index.js");
const { createRouter, createMemoryHistory } = await import("vue-router");
const { installGuards } = await import("../../src/router/guards.js");
const { useAppStore } = await import("../../src/stores/app.js");
const { ApiError } = await import("../../src/utils/apiError.js");
const { closeWidgetDrawer, openWidgetDrawer, openSessionSettings, openDrawer } = await import(
  "../../src/composables/ui.js"
);
const { sidebarRail } = await import("../../src/composables/ui.js");
const { syncInstallation } = await import("../../src/composables/instance.js");

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

const WORKSPACE: Workspace = {
  id: "w1",
  name: "Notes",
  slug: "notes",
  dirPath: "/tmp/notes",
  workdirPath: "/tmp/notes/workdir",
  description: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  sessionCount: 1,
  lastActivityAt: null,
};

const SESSION: Session = {
  id: "s1",
  workspaceId: "w1",
  copilotId: null,
  copilotName: "",
  systemPrompt: "",
  allTools: true,
  tools: [],
  // A name the user chose, so the leave report has nothing to retry — a *scheduled* request
  // would make every assertion here race a debounce it is not about.
  title: "Reading",
  titleSource: "user",
  settings: {},
  description: "",
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CONFIG = { defaultProvider: "p1", defaultModel: "m1" } as unknown as PublicConfig;

/**
 * A router of this test's own, over the app's route table.
 *
 * Memory history rather than the browser's: where the last test left the URL must not decide
 * what this one navigates *to*, because vue-router skips a navigation to the location it is
 * already on — guards and all.
 */
function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

let router: ReturnType<typeof makeRouter>;
/** Where the router ended up, by name. */
const landed = () => router.currentRoute.value.name;

let uninstall: (() => void) | null = null;

beforeEach(async () => {
  router = makeRouter();
  i18n.global.locale.value = "zh-CN";
  setActivePinia(createPinia());
  vi.clearAllMocks();

  mocks.api.me.mockResolvedValue(structuredClone(ACCOUNT));
  mocks.api.getConfig.mockResolvedValue(structuredClone(CONFIG));
  mocks.api.listWorkspaces.mockResolvedValue([structuredClone(WORKSPACE)]);
  mocks.api.listCopilots.mockResolvedValue([]);
  mocks.api.listSessions.mockResolvedValue([structuredClone(SESSION)]);
  mocks.api.listMessages.mockResolvedValue([]);
  mocks.api.listWorkspaceWidgets.mockResolvedValue([]);
  mocks.api.listSessionWidgets.mockResolvedValue({ workspace: [], session: [] });
  mocks.api.listWorkspaceLocks.mockResolvedValue({ locks: [] });
  mocks.api.acquireSessionLock.mockResolvedValue({ lock: null });
  mocks.api.releaseSessionLock.mockResolvedValue({ released: true });
  mocks.api.reportSessionLeave.mockResolvedValue({ status: "skipped" });

  uiState.drawerOpen = false;
  uiState.widgetDrawerOpen = false;
  uiState.sessionSettingsOpen = false;
  uiState.sidebarCollapsed = false;
  uiState.authReady = false;
});

/**
 * Start at a URL, the way a bookmark or a refresh does.
 *
 * `replace` rather than `push`, and it is the honest shape rather than a convenience: the first
 * navigation is what a cold load performs, and every case below is about where that lands.
 */
async function open(path: string): Promise<void> {
  uninstall = installGuards(router, useAppStore());
  await router.replace(path);
}

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.useRealTimers();
});

/* ---------------------------------- the gate --------------------------------- */

describe("who may see which page", () => {
  it("restores the page a URL names, and the conversation in it", async () => {
    // The requirement, at its smallest: a reload lands where the reader was rather than at the
    // front door. Both ids come off the path, and the store is loaded to match.
    const store = useAppStore();
    uninstall = installGuards(router, store);
    await router.replace("/w/w1/s/s1");

    expect(landed()).toBe("session");
    expect(store.activeWorkspaceId).toBe("w1");
    expect(store.activeSessionId).toBe("s1");
    expect(mocks.api.listMessages).toHaveBeenCalledWith("s1");
  });

  it("opens a workspace that names no conversation", async () => {
    const store = useAppStore();
    uninstall = installGuards(router, store);
    await router.replace("/w/w1");

    expect(landed()).toBe("workspace");
    expect(store.activeWorkspaceId).toBe("w1");
    expect(store.activeSessionId).toBeNull();
  });

  it("holds a signed-out reader on the sign-in screen, remembering where they were going", async () => {
    // A bookmark to a conversation, opened with an expired session. The `redirect` is what
    // makes signing back in land on the conversation rather than the workspace list.
    mocks.api.me.mockRejectedValue(new ApiError("UNAUTHENTICATED", "no session", 401));

    await open("/w/w1/s/s1");

    expect(landed()).toBe("login");
    expect(router.currentRoute.value.query.redirect).toBe("/w/w1/s/s1");
    // And nothing was loaded: everything below the gate is scoped to an account.
    expect(mocks.api.getConfig).not.toHaveBeenCalled();
  });

  it("leaves the front door without a redirect, since it is not a place to come back to", async () => {
    mocks.api.me.mockRejectedValue(new ApiError("UNAUTHENTICATED", "no session", 401));

    await open("/");

    expect(landed()).toBe("login");
    expect(router.currentRoute.value.query.redirect).toBeUndefined();
  });

  /**
   * A URL from an installation this browser is no longer talking to.
   *
   * The reported failure: the desktop panel's data-root picker restarts the server on the same
   * port, so a tab comes back to a different database holding an address naming a workspace that
   * never existed in it — and the guard hands that address back after the sign-in, landing the
   * reader on a 会话不存在 toast they did nothing to reach. `syncInstallation` is what notices; the
   * guard is what has to not carry it forward.
   */
  describe("an address from another installation", () => {
    beforeEach(() => {
      mocks.api.me.mockRejectedValue(new ApiError("UNAUTHENTICATED", "no session", 401));
      mocks.api.health.mockResolvedValue({ ok: true, instance: "inst-2" });
      localStorage.setItem(INSTANCE_STORAGE_KEY, "inst-1");
    });

    it("is not carried forward as a redirect", async () => {
      await syncInstallation();
      await open("/w/old-workspace/s/old-session");

      expect(landed()).toBe("login");
      expect(router.currentRoute.value.query.redirect).toBeUndefined();
    });

    it("does not spend itself on a refusal that did not need it", async () => {
      /*
       * The bug this case exists for, and it is a short-circuit rather than a typo: written as
       * `fullPath === "/" || consumeStaleAddress()`, the left operand wins when the reset's own
       * address rewrite means the first refusal *is* the front door — leaving the flag armed to
       * be spent on whatever later navigation happened to be refused. The reader's next bookmark
       * then lands on the front door instead of the conversation it named, which is the
       * behaviour `routing.spec.ts` covers for everybody who did not switch installations.
       */
      await syncInstallation();
      // The reset rewrote the address, so the first refusal is for the front door — and it
      // consumes the flag without using it.
      await open("/");
      expect(router.currentRoute.value.query.redirect).toBeUndefined();

      // A later refusal is an ordinary one, and keeps its bookmark.
      await open("/w/old-workspace/s/old-session");
      expect(router.currentRoute.value.query.redirect).toBe("/w/old-workspace/s/old-session");
    });
  });

  it("sends a signed-in account to the front door rather than the sign-in screen", async () => {
    // A typed `/login` while signed in. The screen is not an error, it is just not where this
    // account is — and the guard is what knows the difference.
    await open("/login");

    expect(landed()).toBe("home");
  });

  it("holds an account that owes a password on the change screen, whatever it asked for", async () => {
    // The state the server enforces: every route but three answers 403. The screen comes first
    // rather than a page of failing requests, and the address it was refused is kept.
    mocks.api.me.mockResolvedValue({ ...structuredClone(ACCOUNT), mustChangePassword: true });

    await open("/w/w1/s/s1");

    expect(landed()).toBe("password");
    expect(router.currentRoute.value.query.redirect).toBe("/w/w1/s/s1");
    expect(mocks.api.listWorkspaces).not.toHaveBeenCalled();
  });

  it("lets that account through once the password is chosen", async () => {
    const store = useAppStore();
    uninstall = installGuards(router, store);
    mocks.api.me.mockResolvedValue({ ...structuredClone(ACCOUNT), mustChangePassword: true });
    mocks.api.changePassword.mockResolvedValue({
      user: structuredClone(ACCOUNT),
      tokens: { accessToken: "at", refreshToken: "rt", expiresIn: 86_400 },
    });
    await router.replace("/w/w1");

    expect(landed()).toBe("password");

    await store.changePassword("issued", "chosen");
    await router.replace("/w/w1");

    expect(landed()).toBe("workspace");
  });

  it("refuses the console to an account that is not an administrator", async () => {
    // A hidden button is not a permission, and neither is a typed URL. The server answers 403
    // regardless; this is what the reader is shown instead of a page of them.
    mocks.api.me.mockResolvedValue({ ...structuredClone(ACCOUNT), roles: ["user"] });

    await open("/admin/providers");

    expect(landed()).toBe("home");
  });
});

/* --------------------------- what a URL may name --------------------------- */

describe("a URL naming something that is not there", () => {
  it("lands on the front door when the workspace cannot be read", async () => {
    mocks.api.listSessions.mockRejectedValue(new ApiError("WORKSPACE_NOT_FOUND", "gone", 404));

    await open("/w/nope");

    expect(landed()).toBe("home");
    const store = useAppStore();
    expect(store.error).toBe("gone");
  });

  it("lands on the workspace when the conversation is not one of its own", async () => {
    /*
     * The case the check exists for: messages are scoped to the *account* rather than to the
     * workspace, so a session id from elsewhere in the account would load happily and be shown
     * under a workspace it does not belong to — a URL that lies about what is on screen.
     */
    await open("/w/w1/s/someone-elses");

    expect(landed()).toBe("workspace");
    expect(mocks.api.listMessages).not.toHaveBeenCalled();
  });

  it("lands on the workspace when the conversation will not load", async () => {
    mocks.api.listMessages.mockRejectedValue(new ApiError("SESSION_NOT_FOUND", "gone", 404));

    await open("/w/w1/s/s1");

    expect(landed()).toBe("workspace");
    expect(useAppStore().error).toBe("gone");
  });

  it("completes a bare console URL and corrects a section that is not one", async () => {
    await open("/admin");

    expect(landed()).toBe("admin");
    expect(router.currentRoute.value.params.section).toBe("users");

    await router.push("/admin/nonsense");
    expect(router.currentRoute.value.params.section).toBe("users");
    expect(router.currentRoute.value.path).toBe("/admin/users");
  });
});

/* ------------------------------- what is torn down ------------------------------ */

describe("what a page change tears down", () => {
  it("closes both drawers and the conversation's parameters on the way out of a page", async () => {
    const store = useAppStore();
    uninstall = installGuards(router, store);
    await router.replace("/w/w1/s/s1");

    openDrawer();
    openWidgetDrawer();
    openSessionSettings();
    await router.push("/");

    expect(uiState).toMatchObject({
      drawerOpen: false,
      widgetDrawerOpen: false,
      sessionSettingsOpen: false,
    });
  });

  it("keeps the widget drawer on the way *into* a conversation", async () => {
    // The asymmetry `showChat` documented, written as a rule about the destination: the panel
    // belongs to the pane being entered, so every page but this one closes it.
    const store = useAppStore();
    uninstall = installGuards(router, store);
    await router.replace("/");

    openWidgetDrawer();
    await router.push("/w/w1/s/s1");

    expect(uiState.widgetDrawerOpen).toBe(true);
  });

  it("leaves an open dialog alone when only the conversation changes", async () => {
    /*
     * Switching conversation is not leaving the page, and the sidebar's row-settings button is
     * exactly this shape: it selects the conversation and *then* opens the parameters. A
     * teardown keyed on "any navigation" would dismiss the dialog the click had just asked for.
     */
    const store = useAppStore();
    mocks.api.listSessions.mockResolvedValue([
      structuredClone(SESSION),
      { ...structuredClone(SESSION), id: "s2" },
    ]);
    uninstall = installGuards(router, store);
    await router.replace("/w/w1/s/s1");

    openSessionSettings();
    await router.push("/w/w1/s/s2");

    expect(uiState.sessionSettingsOpen).toBe(true);
  });

  it("reports the conversation left behind when the reader goes back to the list", async () => {
    /*
     * The one transition the store cannot see. `noteSession` is what notices a conversation
     * being replaced, and going back to the workspace list deliberately does *not* clear
     * `activeSessionId` — so nothing in the store moves, and only the page change can say the
     * reader went. Asserted through the request it schedules, which is the whole point of it.
     */
    vi.useFakeTimers();
    const store = useAppStore();
    mocks.api.me.mockResolvedValue({ ...structuredClone(ACCOUNT), mustChangePassword: false });
    uninstall = installGuards(router, store);
    // A conversation the model named is the only one worth asking about again.
    mocks.api.listSessions.mockResolvedValue([
      { ...structuredClone(SESSION), titleSource: "auto", titleState: "placeholder" },
    ]);
    await router.replace("/w/w1/s/s1");

    await router.push("/");
    await vi.advanceTimersByTimeAsync(3_000);

    expect(mocks.api.reportSessionLeave).toHaveBeenCalledWith("s1");
  });
});

/* --------------------------------- the sidebar --------------------------------- */

describe("the sidebar rail", () => {
  it("is a rail only on a conversation page", async () => {
    /*
     * The other pages render one full-width child, so a rail left collapsed behind you would
     * narrow the *workspace home*'s grid — the app's landing page, with no sidebar to put in
     * the column it just created. Both conversation paths count, which is why the term is
     * `meta.view` rather than a route name.
     *
     * This one navigates the **app's own router**, and has to: `sidebarRail` is a module-level
     * computed in `composables/ui.ts` that reads that instance and takes no argument, which is
     * what lets its two readers — `Sidebar.vue` and `App.vue`, neither a parent of the other —
     * share one expression. No guards are installed on it; nothing here needs a store.
     */
    await appRouter.replace("/w/w1/s/s1");
    toggleSidebar();
    expect(sidebarRail.value).toBe(true);

    await appRouter.push("/");
    expect(sidebarRail.value).toBe(false);

    // …and the flag survives the trip, so coming back is not an expand-then-collapse.
    await appRouter.push("/w/w1");
    expect(sidebarRail.value).toBe(true);
  });
});

/* ---------------------------------- the account --------------------------------- */

describe("the account going away", () => {
  it("takes the reader to the sign-in screen without anybody navigating", async () => {
    /*
     * The third hook, and the one that could not be a guard: a 401 arrives, or the reader
     * presses sign out, and no navigation happens. Two call sites used to call the same
     * function by hand for this; now the store only clears the account and the router notices.
     */
    const store = useAppStore();
    uninstall = installGuards(router, store);
    await router.replace("/w/w1/s/s1");

    mocks.api.logout.mockResolvedValue({ ok: true });
    await store.signOut();
    await vi.waitFor(() => expect(landed()).toBe("login"));

    expect(router.currentRoute.value.query.redirect).toBeUndefined();
  });

  it("stays where it is when the sign-in screen loses the account", async () => {
    // Signing out on the sign-in screen is not a transition worth acting on.
    mocks.api.me.mockRejectedValue(new ApiError("UNAUTHENTICATED", "no session", 401));
    const store = useAppStore();
    uninstall = installGuards(router, store);
    await router.replace("/login");

    mocks.api.logout.mockResolvedValue({ ok: true });
    await store.signOut();

    expect(landed()).toBe("login");
  });
});
