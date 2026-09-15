import { beforeEach, describe, expect, it } from "vitest";
import {
  closeDrawer,
  closeCopilots,
  closeWidgetDrawer,
  closeWorkspaceSettings,
  openDrawer,
  openCopilots,
  openWidgetDrawer,
  openWorkspaceSettings,
  showChat,
  showLogin,
  showWorkspaceHome,
  sidebarRail,
  toggleSidebar,
  uiState,
} from "../../src/composables/ui.js";

/**
 * The module is a singleton, so the state outlives a test — reset it rather than relying on
 * declaration order.
 */
beforeEach(() => {
  uiState.copilotsOpen = false;
  uiState.drawerOpen = false;
  uiState.widgetDrawerOpen = false;
  uiState.workspaceSettingsId = null;
  uiState.sidebarCollapsed = false;
  uiState.view = "login";
  uiState.authReady = false;
});

describe("uiState", () => {
  it("starts on the login screen, unready, with every overlay closed", () => {
    // A drawer or a dialog that opens on its own is the failure this pins: it would be
    // invisible in review, because the state is only read by components.
    //
    // Starting on `"login"` is not the same claim as *showing* the login screen — `App.vue`
    // withholds both views until `authReady`, so this initial value is never painted. It is
    // the safe guess rather than the visible one, and the flag beside it is what keeps a
    // signed-in user from seeing it on a refresh.
    expect(uiState).toMatchObject({
      copilotsOpen: false,
      drawerOpen: false,
      sidebarCollapsed: false,
      view: "login",
      authReady: false,
    });
  });

  it("opens and closes the drawer", () => {
    openDrawer();
    expect(uiState.drawerOpen).toBe(true);

    closeDrawer();
    expect(uiState.drawerOpen).toBe(false);
  });

  it("is idempotent", () => {
    openDrawer();
    openDrawer();
    expect(uiState.drawerOpen).toBe(true);

    closeDrawer();
    closeDrawer();
    expect(uiState.drawerOpen).toBe(false);
  });

  it("keeps the drawer and the Copilot list independent", () => {
    // They are separate flags on purpose: the drawer closes *before* the dialog opens, so a
    // dialog is never left sitting behind an open drawer.
    openDrawer();
    openCopilots();
    closeDrawer();

    expect(uiState).toMatchObject({ copilotsOpen: true, drawerOpen: false });

    closeCopilots();
    expect(uiState.copilotsOpen).toBe(false);
  });
});

describe("the sidebar rail", () => {
  it("starts open, and toggles both ways", () => {
    // Open is the default because the sidebar is how a conversation is reached at all; a
    // first run that began as a rail would be a first run with nothing to click.
    expect(uiState.sidebarCollapsed).toBe(false);

    toggleSidebar();
    expect(uiState.sidebarCollapsed).toBe(true);

    toggleSidebar();
    expect(uiState.sidebarCollapsed).toBe(false);
  });

  it("is a rail only in the chat view", () => {
    // The other two views render one full-width child, so a rail left collapsed behind you
    // would narrow the *workspace home*'s grid — the app's landing page, with no sidebar to
    // put in the column it just created.
    showChat();
    toggleSidebar();
    expect(sidebarRail.value).toBe(true);

    showWorkspaceHome();
    expect(sidebarRail.value).toBe(false);

    showChat();
    expect(sidebarRail.value).toBe(true);
  });

  it("keeps the collapsed flag across a view change", () => {
    // The rail coming back on the way *in* is the point of the check above; the flag itself
    // surviving is what makes "narrow the sidebar, go and make a workspace, come back" not
    // undo the narrowing. It is not persisted across a reload — see `ui.ts`.
    showChat();
    toggleSidebar();
    showWorkspaceHome();

    expect(uiState.sidebarCollapsed).toBe(true);
  });

  it("is independent of the drawer", () => {
    // They are two flags for two questions, and a compact viewport can have the drawer open
    // while the wide-viewport flag sits wherever the last wide viewport left it.
    openDrawer();
    toggleSidebar();

    expect(uiState).toMatchObject({ drawerOpen: true, sidebarCollapsed: true });

    closeDrawer();
    expect(uiState).toMatchObject({ drawerOpen: false, sidebarCollapsed: true });
  });
});

describe("the view switch", () => {
  it("moves between the three views", () => {
    showChat();
    expect(uiState.view).toBe("chat");

    showWorkspaceHome();
    expect(uiState.view).toBe("home");

    showLogin();
    expect(uiState.view).toBe("login");
  });

  it("closes the drawer on the way to the login screen", () => {
    // Signing out with the mobile drawer open is the case: the drawer belongs to the view
    // being torn down, and the login screen has no toggle to close it with — so it would sit
    // over the form with no way out.
    openDrawer();
    showLogin();
    expect(uiState.drawerOpen).toBe(false);
  });

  it("closes the drawer on the way to the workspace home", () => {
    // The drawer belongs to the pane being torn down. Left open, the flag would survive
    // into the next workspace the user enters, which greets them with a drawer nobody
    // asked for — and on a wide viewport, where there is no drawer at all, nothing would
    // ever close it again.
    openDrawer();
    showWorkspaceHome();
    expect(uiState.drawerOpen).toBe(false);
  });

  it("leaves the drawer alone when entering a workspace", () => {
    // `showChat` is called by the card that was just clicked on a page with no drawer; the
    // drawer's own open/close is the sidebar's business.
    openDrawer();
    showChat();
    expect(uiState.drawerOpen).toBe(true);
  });
});

describe("the widget drawer", () => {
  it("opens and closes on its own flag", () => {
    // A second drawer rather than a value shared with `drawerOpen`: they hold different panes and
    // can be true at once, so one flag would make "which one is open" unanswerable.
    openWidgetDrawer();
    expect(uiState.widgetDrawerOpen).toBe(true);
    expect(uiState.drawerOpen).toBe(false);

    closeWidgetDrawer();
    expect(uiState.widgetDrawerOpen).toBe(false);
  });

  it("closes on the way to the login screen and the workspace home", () => {
    // The same rule the left drawer follows: it belongs to the pane being torn down.
    openWidgetDrawer();
    showWorkspaceHome();
    expect(uiState.widgetDrawerOpen).toBe(false);

    openWidgetDrawer();
    showLogin();
    expect(uiState.widgetDrawerOpen).toBe(false);
  });

  it("leaves the left drawer alone, and is left alone by it", () => {
    openDrawer();
    openWidgetDrawer();
    expect(uiState).toMatchObject({ drawerOpen: true, widgetDrawerOpen: true });

    closeDrawer();
    expect(uiState.widgetDrawerOpen).toBe(true);
  });
});

describe("the workspace settings dialog", () => {
  it("carries the workspace it is about, rather than being a flag", () => {
    /*
     * A value rather than a boolean, and the reason is the entry point: the gear sits on a
     * workspace *card*, which need not be the workspace anyone is in. An id is what lets the
     * dialog be opened for one nobody has entered.
     */
    openWorkspaceSettings("w2");
    expect(uiState.workspaceSettingsId).toBe("w2");

    closeWorkspaceSettings();
    expect(uiState.workspaceSettingsId).toBeNull();
  });

  it("opens for a workspace that is not the active one", () => {
    // The whole point of carrying the id: no side effect on which workspace is selected.
    openWorkspaceSettings("w-other");
    expect(uiState.workspaceSettingsId).toBe("w-other");
  });

  it("closes when the account leaves", () => {
    // It is a dialog about an account's own workspace, so signing out has to take it with it —
    // the next account's ids mean nothing here.
    openWorkspaceSettings("w1");
    showLogin();
    expect(uiState.workspaceSettingsId).toBeNull();
  });
});
