import { computed, reactive } from "vue";
import { isCompact } from "./breakpoints";

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
 * still no router: six views and a six-valued flag do not need a dependency and a route table,
 * and none of them has a URL anyone would type — the app opens on the sign-in screen, the
 * first-run screen or the workspace list according to who is asking, not according to a link.
 * The two account pages are reached from controls that are already on screen, which is what
 * the "no URL" test really asks.
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
 *
 * `sidebarCollapsed` is the drawer's near neighbour and the one pair worth reading together:
 * the drawer says where the sidebar *is*, this says how wide it is, and the sidebar's own
 * toggle is a different control on each viewport because of it. The field carries the rest.
 */
export type View = "login" | "password" | "home" | "chat" | "account" | "admin";

/**
 * Which screen the platform console is showing.
 *
 * Held here rather than in `AdminConsole.vue` because a control *outside* the console opens it
 * on a particular section: the composer's model picker offers "manage models…" to an
 * administrator, and landing them on the accounts list would make them find it themselves.
 * A section id is also what the console's left menu is built from, so the flag and the menu
 * cannot disagree about what exists.
 */
export type AdminSection = "users" | "providers" | "documents";

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
  /**
   * The conversation's own files.
   *
   * Distinct from `sourcesOpen` in both halves of what a file can be: a source is the
   * *account's*, uploaded by the user, and lives outside every workspace; this is one
   * conversation's own directory, written by the agent — the diagrams it draws. The two lists
   * never overlap, which is what makes them two dialogs rather than two tabs of one.
   *
   * A flag rather than a session id, unlike `workspaceSettingsId`: the entry points are the
   * diagram widget and the chat topbar, both of which mean *this* conversation, and the dialog
   * watching `activeSessionId` is what keeps it honest if the conversation changes underneath.
   */
  sessionFilesOpen: false,
  drawerOpen: false,
  /**
   * The widget panel off-canvas at the *right*, on a compact viewport.
   *
   * A second drawer rather than a value shared with `drawerOpen`, because they hold different
   * panes and can be true at once — and because the left one is *where the sidebar is* on a
   * narrow screen, while this is a supplementary panel that happens to need the same treatment.
   * Both close on Escape and both get a backdrop; sharing one flag would tie two unrelated
   * controls together and make "which one is open" unanswerable.
   */
  widgetDrawerOpen: false,
  /**
   * The workspace whose settings dialog is open, or `null`.
   *
   * A **value** rather than a flag, unlike every other overlay here, and the reason is the entry
   * point: the gear sits on a workspace *card* on the home page, which need not be the active
   * workspace. Carrying the id means the dialog can be opened for a workspace nobody has entered,
   * and the alternative — a prop threaded from `App.vue` back down to the card that opened it —
   * is the chain this module exists to avoid.
   */
  workspaceSettingsId: null as string | null,
  /**
   * The chat sidebar collapsed to its rail.
   *
   * A second flag rather than a third value on `drawerOpen`, because the two answer
   * different questions and can be true at once: the drawer is *where the sidebar is* on a
   * compact viewport (off-canvas, over the pane, dismissed by its backdrop), and this is
   * *how wide it is* on a wide one (a 52px rail, in flow, still there). A single flag would
   * have to mean "hidden" on one viewport and "narrow" on the other, and the resize between
   * them would leave whichever meaning it did not have.
   *
   * Not persisted, like the drawer and unlike the theme. The drawer's reason does not carry
   * over — a remembered rail is defensible in a way a remembered drawer is not — so this is
   * a decision rather than an inheritance: a rail is what you narrow the window for, and it
   * defaults to open because the sidebar is how you reach a conversation at all.
   */
  sidebarCollapsed: false,
  /**
   * The console's current section. Reset on every entry, so the menu cannot open on a screen
   * somebody chose last week and has no memory of.
   */
  adminSection: "users" as AdminSection,
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

/** The conversation's own files — see `sessionFilesOpen`. */
export function openSessionFiles(): void {
  uiState.sessionFilesOpen = true;
}

export function closeSessionFiles(): void {
  uiState.sessionFilesOpen = false;
}

/** Only meaningful on a compact viewport; wider ones render the sidebar in place. */
export function openDrawer(): void {
  uiState.drawerOpen = true;
}

export function closeDrawer(): void {
  uiState.drawerOpen = false;
}

/** The widget panel's off-canvas form. Compact viewports only, like the drawer above. */
export function openWidgetDrawer(): void {
  uiState.widgetDrawerOpen = true;
}

export function closeWidgetDrawer(): void {
  uiState.widgetDrawerOpen = false;
}

/**
 * Open the workspace settings dialog for a particular workspace.
 *
 * Takes the id rather than reading the active one, because the gear on a workspace card is for
 * *that* workspace and the user may not have entered it.
 */
export function openWorkspaceSettings(id: string): void {
  uiState.workspaceSettingsId = id;
}

export function closeWorkspaceSettings(): void {
  uiState.workspaceSettingsId = null;
}

/**
 * Narrow the sidebar to its rail, or widen it back.
 *
 * One function rather than a `collapse`/`expand` pair, because the only control that reaches
 * it is a toggle and a pair would put the "which one am I" question at the call site — where
 * it would be answered by reading the flag it is about to write, which is the state the
 * control already renders from.
 *
 * Wide viewports only. A compact one's sidebar is a drawer and has no rail to narrow to, so
 * the toggle closes the drawer there instead — that branch is in `Sidebar.vue`, next to the
 * button, since it is about which control the button *is* rather than about this flag.
 */
export function toggleSidebar(): void {
  uiState.sidebarCollapsed = !uiState.sidebarCollapsed;
}

/**
 * Whether the chat view is rendering its sidebar as a rail.
 *
 * The derived half of the flag above, and here rather than in either component because
 * *two* of them need it and they are not in a parent-child relation that would let one pass
 * it down: `Sidebar.vue` puts it on the element that hides the panels, `App.vue` puts it on
 * `.app` to pick the grid track. Written out twice, they are also two chances to drop a
 * term — and every term is load-bearing:
 *
 * - `view === "chat"`, because the other two views render one full-width child. Without it a
 *   rail left collapsed behind you on the workspace home would narrow the home page's grid.
 * - `!isCompact`, because a compact viewport's sidebar is a fixed 272px drawer. A 52px
 *   track would tie with the drawer's own rule on specificity and win on source order,
 *   leaving a sliver of empty column beside a drawer nobody could read.
 */
export const sidebarRail = computed(
  () => uiState.view === "chat" && uiState.sidebarCollapsed && !isCompact.value,
);

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
  // Both drawers belong to the pane being torn down, and all three dialogs to an account that
  // is leaving, so all five go with them.
  closeWidgetDrawer();
  closeWorkspaceSettings();
  closeSessionFiles();
}

/**
 * The screen a signed-in account owes a password change is stuck on.
 *
 * A view rather than a dialog, and the difference is not cosmetic: this is a state the account
 * cannot leave, and a dialog can be dismissed, escaped or navigated out from under. The server
 * refuses every other route until it is settled, so a screen that could be dismissed would
 * simply be dismissed onto a page of failing requests.
 */
export function showPasswordChange(): void {
  uiState.view = "password";
  closeDrawer();
  closeWidgetDrawer();
  closeWorkspaceSettings();
}

/**
 * Leave the workspace for the list. Closes the drawer on the way out: the drawer belongs to
 * the pane that is being torn down, and leaving it open would carry the flag into the next
 * workspace the user enters, which greets them with a drawer they did not ask for.
 */
export function showWorkspaceHome(): void {
  uiState.view = "home";
  closeDrawer();
  closeWidgetDrawer();
  // A conversation's files are the conversation's; the list is not a page about the workspace.
  closeSessionFiles();
}

/** Enter a workspace's chat pane. The workspace itself is chosen by the store, not here. */
export function showChat(): void {
  uiState.view = "chat";
}

/**
 * The account's own page: who it is signed in as, and how to change its password.
 *
 * Its own view rather than a tab of Settings, because Settings is how *this installation* is
 * configured — providers, parsers, Copilots, all shared by everybody — and this is one
 * account's business about itself. A superadmin who is also a user of the app is the same
 * person on both pages, which is exactly why they are two.
 */
export function showAccount(): void {
  uiState.view = "account";
  closeDrawer();
  closeWidgetDrawer();
}

/**
 * The platform console: everything that belongs to the installation rather than to one account.
 *
 * Reachable only by an administrator of either tier, and the server is what enforces that — the
 * control is hidden for everybody else, but a hidden button is not a permission.
 *
 * Takes the section because one caller knows which one it means: "manage models…" in the
 * composer is a request about providers, and opening on the accounts list would answer a
 * different question. Every other caller omits it and gets the first section.
 */
export function showAdmin(section: AdminSection = "users"): void {
  uiState.adminSection = section;
  uiState.view = "admin";
  closeDrawer();
  closeWidgetDrawer();
}
