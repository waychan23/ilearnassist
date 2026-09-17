import { computed, reactive } from "vue";
import { isCompact } from "./breakpoints";
// For one derived value only — `sidebarRail`, which is a fact about the page. Read through
// `currentRoute` rather than taken as a parameter because its two readers are siblings, and
// acyclic because the router imports no view eagerly: see `router/index.ts`.
import { router } from "../router";

/**
 * Cross-component UI state for the few globals that more than one place needs to open.
 *
 * The Copilot list is reachable from the footer of a conversation's sidebar *and* from the rail
 * the workspace home draws — the front door has no sidebar, and an account that has not entered a
 * workspace yet must still be able to manage the Copilots it made. Both rails are one component
 * (`AppMenu.vue`), which is why this is a flag rather than two. Rather than threading an event up through App and back
 * down, the dialog is mounted once in `App.vue` and anyone can ask for it here.
 *
 * The drawer is the same shape, one step further: the button that opens it is in the topbar,
 * the thing that slides is the sidebar, and whether either exists is decided in `App.vue`.
 * Three components, one boolean — which is what this module is for.
 *
 * **The page is not here, and that is the change.** It used to be — `view`, with six
 * `show*` functions as its only writers — and a browser that only ever knew one URL meant a
 * refresh threw the reader back to the front door, losing the conversation they were reading.
 * A page is a *place*, and places have addresses, so the page lives in `router/index.ts` now
 * and this module holds only the overlays and the two flags that describe the chrome around a
 * page rather than the page itself.
 *
 * Nothing here is persisted, unlike the theme and the locale, and the reasons are the ones the
 * page used to give: a drawer left open across a reload is a bug rather than a preference, and
 * a storage key would drag in the pre-paint lock-step obligation those two carry. The
 * *page*, meanwhile, is not persisted because it does not need to be — it is in the URL.
 *
 * The account is the same case one level up: it is the *server's* fact, held in a bearer token
 * the page stores but cannot verify, so there is nothing here to trust on the way back in. See
 * `authReady`.
 *
 * `sidebarCollapsed` is the drawer's near neighbour and the one pair worth reading together:
 * the drawer says where the sidebar *is*, this says how wide it is, and the sidebar's own
 * toggle is a different control on each viewport because of it. The field carries the rest.
 */
export type View = "login" | "password" | "home" | "chat" | "account" | "admin";

/**
 * Which screen the platform console is showing.
 *
 * A *type* here and a **route parameter** in fact: `/admin/providers` is what the composer's
 * model picker pushes, and the console's left menu is built from the same ids, so the two
 * cannot disagree about what exists. It used to be a field on `uiState`, which is the shape
 * the URL replaced: a section is a place in the console, so it belongs in the address of one.
 */
export type AdminSection = "users" | "providers" | "documents" | "uploads";

export const uiState = reactive({
  /** The account's own Copilots, opened from the menu either rail draws. */
  copilotsOpen: false,
  /**
   * The uploaded-files dialog.
   *
   * Its own flag rather than a corner of another dialog, because the two answer different
   * questions: the Copilot list is what this account has *made*, and this is what it has
   * stored. Opening it from the home page is also the only route to a file that no
   * conversation references any more — which is exactly the file someone goes looking for
   * here. That is the `sources-row` prop on `AppMenu`: the chat page opens this browser from
   * its header, and the front door has no header to put a button in.
   */
  sourcesOpen: false,
  /**
   * The session-parameters dialog.
   *
   * Three places open it and they are not in a parent-child relation: the composer's `sliders`
   * button, the topbar's, and the settings button on a row in the conversation list. The last
   * two are siblings under `ChatView`, so there is no ancestor to thread an event through —
   * which is the case this module exists for, exactly as it is for the Copilot list.
   *
   * A **flag**, unlike `workspaceSettingsId`: the dialog is about the conversation on screen
   * (`store.activeSession`), so there is no second object to name. The sidebar row's button
   * selects that conversation first, which is what makes them the same object.
   */
  sessionSettingsOpen: false,
  /**
   * Which slice the source browser opens on, when it opens.
   *
   * The browser has two front doors and one component: the workspace home opens it as the
   * whole account, and a conversation opens it already narrowed to its workspace. A *scope*
   * rather than a second `workspaceSourcesOpen` flag, because the two would be the same
   * dialog twice and the third front door would be a third flag — and because the scope is
   * also what the caller must *say*, which `true` cannot carry.
   *
   * Reset by `closeSources`, so a reopen from the other door cannot inherit the last one's
   * filter. `null` and `{}` both mean the whole account.
   */
  sourcesScope: null as { workspaceId?: string } | null,
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
   * Whether `/api/auth/me` has answered yet.
   *
   * The session is a bearer token, so nothing on the page can tell whether anyone is signed in
   * until a request comes back — which means the correct view is genuinely unknown for the
   * first moments after a reload. `App.vue` renders neither view until this flips: starting on
   * the sign-in screen without it would flash that screen at someone who is already signed in,
   * on every single refresh.
   *
   * The *destination* is the router's, and the guard is what flips this on its way past. The
   * two are one decision between them: `router/guards.ts` calls `probeAccount()` before it
   * decides anything, so the flag is set by the time any route resolves.
   */
  authReady: false,
});

export function openCopilots(): void {
  uiState.copilotsOpen = true;
}

export function closeCopilots(): void {
  uiState.copilotsOpen = false;
}

export function openSources(scope: { workspaceId?: string } = {}): void {
  uiState.sourcesScope = scope;
  uiState.sourcesOpen = true;
}

export function closeSources(): void {
  uiState.sourcesOpen = false;
  // Cleared rather than left behind: the next open comes from one of two doors, and a stale
  // scope would silently pre-filter the other one.
  uiState.sourcesScope = null;
}

/**
 * The conversation's parameters — the dialog the composer, the topbar and a sidebar row all
 * open. Nothing is passed: it reads whichever conversation is on screen.
 */
export function openSessionSettings(): void {
  uiState.sessionSettingsOpen = true;
}

export function closeSessionSettings(): void {
  uiState.sessionSettingsOpen = false;
}

/**
 * The sidebar drawer, on a compact viewport. Not persisted and not the same flag as
 * `sidebarCollapsed`: one is "the panel covers the pane right now", the other is a preference.
 */
export function openDrawer(): void {
  uiState.drawerOpen = true;
}

export function closeDrawer(): void {
  uiState.drawerOpen = false;
}

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
 * - the route is a conversation, because every other page renders one full-width child.
 *   Without it a rail left collapsed behind you on the workspace home would narrow the home
 *   page's grid. The page is the router's now, so the term is read from there; both chat paths
 *   declare the same `meta.view`, which is what makes this one condition rather than two.
 * - `!isCompact`, because a compact viewport's sidebar is a fixed 272px drawer. A 52px
 *   track would tie with the drawer's own rule on specificity and win on source order,
 *   leaving a sliver of empty column beside a drawer nobody could read.
 */
export const sidebarRail = computed(
  () => router.currentRoute.value.meta.view === "chat" && uiState.sidebarCollapsed && !isCompact.value,
);
