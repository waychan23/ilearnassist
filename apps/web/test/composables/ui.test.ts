import { beforeEach, describe, expect, it } from "vitest";
import {
  closeDrawer,
  closeSettings,
  openDrawer,
  openSettings,
  showChat,
  showWorkspaceHome,
  uiState,
} from "../../src/composables/ui.js";

/**
 * The module is a singleton, so the state outlives a test — reset it rather than relying on
 * declaration order.
 */
beforeEach(() => {
  uiState.settingsOpen = false;
  uiState.drawerOpen = false;
  uiState.workspaceHome = true;
});

describe("uiState", () => {
  it("starts on the workspace home, with every overlay closed", () => {
    // A drawer or a dialog that opens on its own is the failure this pins: it would be
    // invisible in review, because the state is only read by components. The home page is
    // the opposite assertion — the app is *meant* to open there, so a regression that went
    // straight into a conversation would otherwise pass every other test in this file.
    expect(uiState).toMatchObject({
      settingsOpen: false,
      drawerOpen: false,
      workspaceHome: true,
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

  it("keeps the drawer and the settings dialog independent", () => {
    // They are separate flags on purpose: the drawer closes *before* Settings opens, so a
    // dialog is never left sitting behind an open drawer.
    openDrawer();
    openSettings();
    closeDrawer();

    expect(uiState).toMatchObject({ settingsOpen: true, drawerOpen: false });

    closeSettings();
    expect(uiState.settingsOpen).toBe(false);
  });
});

describe("the view switch", () => {
  it("moves between the workspace home and the chat pane", () => {
    showChat();
    expect(uiState.workspaceHome).toBe(false);

    showWorkspaceHome();
    expect(uiState.workspaceHome).toBe(true);
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
