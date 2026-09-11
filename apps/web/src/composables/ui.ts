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
 * `workspaceHome` is the third, and the one that decides the *page* rather than an overlay:
 * `App.vue` renders it, a card on it opens the chat pane, the chat pane's back button and
 * the sidebar's back row return to it. There is no router in this app — two views and a
 * boolean would be a dependency and a route table serving one bit — so the flag lives here
 * with the other cross-component state.
 *
 * Not persisted, unlike the theme and the locale. A drawer left open across a reload is a
 * bug rather than a preference, and a storage key would drag in the pre-paint lock-step
 * obligation those two carry. The same goes for the home page: the app is *meant* to open
 * on the workspace list, so remembering "you were in a conversation" would defeat the point
 * of the page rather than restore anything.
 */
export const uiState = reactive({
  settingsOpen: false,
  drawerOpen: false,
  workspaceHome: true,
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

/**
 * Leave the workspace for the list. Closes the drawer on the way out: the drawer belongs to
 * the pane that is being torn down, and leaving it open would carry the flag into the next
 * workspace the user enters, which greets them with a drawer they did not ask for.
 */
export function showWorkspaceHome(): void {
  uiState.workspaceHome = true;
  closeDrawer();
}

/** Enter a workspace's chat pane. The workspace itself is chosen by the store, not here. */
export function showChat(): void {
  uiState.workspaceHome = false;
}
