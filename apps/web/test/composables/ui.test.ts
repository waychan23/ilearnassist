import { beforeEach, describe, expect, it } from "vitest";
import {
  closeDrawer,
  closeSettings,
  openDrawer,
  openSettings,
  uiState,
} from "../../src/composables/ui.js";

/**
 * The module is a singleton, so the state outlives a test — reset it rather than relying on
 * declaration order.
 */
beforeEach(() => {
  uiState.settingsOpen = false;
  uiState.drawerOpen = false;
});

describe("uiState", () => {
  it("starts with every overlay closed", () => {
    // A drawer or a dialog that opens on its own is the failure this pins: it would be
    // invisible in review, because the state is only read by components.
    expect(uiState).toMatchObject({ settingsOpen: false, drawerOpen: false });
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
