import { reactive } from "vue";

/**
 * Cross-component UI state for the few globals that more than one place needs to open.
 *
 * Settings is reachable from the sidebar footer *and* from the composer's model picker
 * ("管理模型…"). Rather than threading an event up through App and back down, the dialog
 * is mounted once in `App.vue` and anyone can ask for it here.
 *
 * The drawer is the same shape, one step further: the button that opens it is in the topbar,
 * the thing that slides is the sidebar, and whether either exists is decided in `App.vue`.
 * Three components, one boolean — which is what this module is for.
 *
 * Not persisted, unlike the theme and the locale. A drawer left open across a reload is a
 * bug rather than a preference, and a storage key would drag in the pre-paint lock-step
 * obligation those two carry.
 */
export const uiState = reactive({
  settingsOpen: false,
  drawerOpen: false,
});

export function openSettings(): void {
  uiState.settingsOpen = true;
}

export function closeSettings(): void {
  uiState.settingsOpen = false;
}

/** Only meaningful on a compact viewport; wider ones render the sidebar in place. */
export function openDrawer(): void {
  uiState.drawerOpen = true;
}

export function closeDrawer(): void {
  uiState.drawerOpen = false;
}
