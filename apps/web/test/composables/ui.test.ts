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
  uiState.authReady = false;
});

describe("uiState", () => {
  it("starts unready, with every overlay closed", () => {
    // A drawer or a dialog that opens on its own is the failure this pins: it would be
    // invisible in review, because the state is only read by components.
    //
    // `authReady: false` is what keeps anything from being painted before `/api/auth/me` has
    // answered, and it is the one field here that outlives a page: which *page* is on screen
    // is the route's now, so there is no flag beside it any more.
    expect(uiState).toMatchObject({
      copilotsOpen: false,
      drawerOpen: false,
      sidebarCollapsed: false,
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
});
