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
 * `view` is the third, and the one that decides the *page* rather than an overlay. There is
 * still no router: three views and a three-valued flag do not need a dependency and a route
 * table, and none of the three has a URL anyone would type — the app opens on the login
 * screen or the workspace list according to who is asking, not according to a link.
 *
 * Not persisted, unlike the theme and the locale. A drawer left open across a reload is a
 * bug rather than a preference, and a storage key would drag in the pre-paint lock-step
 * obligation those two carry. The same goes for the home page: the app is *meant* to open
 * on the workspace list, so remembering "you were in a conversation" would defeat the point
 * of the page rather than restore anything.
 *
 * The account is the same case one level up: it is the *server's* fact, held in a cookie the
 * page cannot read, so there is nothing here to persist and nothing to trust on the way back
 * in. See `authReady`.
 */
export type View = "login" | "home" | "chat";

export const uiState = reactive({
  settingsOpen: false,
  /**
   * The uploaded-files dialog.
   *
   * Its own flag rather than a tab of Settings, because the two answer different questions:
   * Settings is how the app is configured, and this is what the account has stored. Opening
   * it from the home page is also the only route to a file that no conversation references
   * any more — which is exactly the file someone goes looking for here.
   */
  sourcesOpen: false,
  drawerOpen: false,
  view: "login" as View,
  /**
   * Whether `/api/auth/me` has answered yet.
   *
   * The session cookie is HttpOnly, so nothing on the page can tell whether anyone is signed
   * in until a request comes back — which means the correct view is genuinely unknown for the
   * first moments after a reload. `App.vue` renders neither view until this flips: starting
   * on `"login"` without it would flash the login screen at someone who is already signed in,
   * on every single refresh.
   */
  authReady: false,
});

export function openSettings(): void {
  uiState.settingsOpen = true;
}

export function closeSettings(): void {
  uiState.settingsOpen = false;
}

export function openSources(): void {
  uiState.sourcesOpen = true;
}

export function closeSources(): void {
  uiState.sourcesOpen = false;
}

/** Only meaningful on a compact viewport; wider ones render the sidebar in place. */
export function openDrawer(): void {
  uiState.drawerOpen = true;
}

export function closeDrawer(): void {
  uiState.drawerOpen = false;
}

/**
 * Ask who the caller is: the login screen.
 *
 * Reached on a cold start with no session, and from anywhere an authenticated request comes
 * back 401 — a session that expired while a tab sat open, or a secret that was rotated. Both
 * are "start again", not an error to report.
 */
export function showLogin(): void {
  uiState.view = "login";
  closeDrawer();
}

/**
 * Leave the workspace for the list. Closes the drawer on the way out: the drawer belongs to
 * the pane that is being torn down, and leaving it open would carry the flag into the next
 * workspace the user enters, which greets them with a drawer they did not ask for.
 */
export function showWorkspaceHome(): void {
  uiState.view = "home";
  closeDrawer();
}

/** Enter a workspace's chat pane. The workspace itself is chosen by the store, not here. */
export function showChat(): void {
  uiState.view = "chat";
}
