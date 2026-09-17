import { createRouter, createWebHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";
import type { View } from "../composables/ui";

/**
 * The app's URLs.
 *
 * The page used to be a flag — `uiState.view` — and the address bar stayed on `/` for the life
 * of a session. That made a refresh a return to the front door: the conversation, the console
 * section and the workspace you were reading were all in memory, and memory does not survive
 * one. A route table is what puts them in the URL instead, so a reload, a bookmark and a Back
 * press all land where the reader was.
 *
 * ### What a path is made of
 *
 * | Path | Name | `meta.view` |
 * | --- | --- | --- |
 * | `/` | `home` | `home` |
 * | `/login` | `login` | `login` |
 * | `/password` | `password` | `password` |
 * | `/account` | `account` | `account` |
 * | `/admin/:section?` | `admin` | `admin` |
 * | `/w/:workspaceId` | `workspace` | `chat` |
 * | `/w/:workspaceId/s/:sessionId` | `session` | `chat` |
 *
 * Ids are the server's, and they are the UUIDs rather than anything human: a workspace *has* a
 * slug, but it names a directory rather than a workspace (it survives a rename, and two accounts
 * may each have one), and a session has none at all. A name in the path would have to be looked
 * up to be trusted, so the path carries the thing that is already the key.
 *
 * ### Three things about this file are load-bearing
 *
 * **`meta.view` is the page, and there is no second copy of it.** The `View` union that used to
 * live on `uiState` is what each route declares here, and it is *required* — the augmentation
 * below is what makes a route added without one a `vue-tsc` error rather than a blank screen.
 *
 * **Both chat paths are one component, and `RouterView` reuses it across them.** Moving between
 * them — or between two conversations — patches the existing `ChatView` rather than mounting a
 * new one, which is what keeps the composer's textarea, the scroll position and the widget
 * panel's claim. Vue reuses an instance when the vnode's type is the same object, and both
 * records name the same import; a remount here would be a visible one.
 *
 * **Every component is a lazy import, and the graph depends on it.** `stores/app.ts` imports
 * this module for the two navigations the store itself causes, so a route that statically
 * imported a view would close a cycle — this module would reach the store through the view
 * before the store had finished evaluating. `() => import(…)` defers that to navigation time,
 * which is also why the first paint of a page fetches a chunk rather than carrying every page
 * in the entry bundle.
 */
declare module "vue-router" {
  interface RouteMeta {
    /** Which page this is — the successor to `uiState.view`, and the only place it is stated. */
    view: View;
    /** Requires a signed-in account. Enforced by `router/guards.ts`, not by the component. */
    auth?: boolean;
    /** Requires an administrator of either tier. Same: the guard decides, not the button. */
    admin?: boolean;
  }
}

/**
 * Section ids the console can be showing, in menu order.
 *
 * Exported because the guard normalises `:section` against it, which is the one place that has
 * to know what a section *is* — `AdminConsole.vue` builds its menu from its own copy of the
 * icons, and a mismatch there would be a menu row the URL cannot express.
 */
export const ADMIN_SECTIONS = ["users", "providers", "documents", "uploads"] as const;

export const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "home",
    component: () => import("../components/WorkspaceHome.vue"),
    meta: { view: "home", auth: true },
  },
  {
    path: "/login",
    name: "login",
    component: () => import("../components/LoginView.vue"),
    meta: { view: "login" },
  },
  {
    path: "/password",
    name: "password",
    component: () => import("../components/ChangePasswordView.vue"),
    meta: { view: "password", auth: true },
  },
  {
    path: "/account",
    name: "account",
    component: () => import("../components/AccountView.vue"),
    meta: { view: "account", auth: true },
  },
  {
    /*
     * The section is optional in the path because the guard completes it: `/admin` is what a
     * bare "platform console" push writes, and it is normalised to `/admin/users` so the URL
     * says which section is on screen rather than leaving it to a default.
     */
    path: "/admin/:section?",
    name: "admin",
    component: () => import("../components/AdminConsole.vue"),
    meta: { view: "admin", auth: true, admin: true },
  },
  {
    path: "/w/:workspaceId",
    name: "workspace",
    component: () => import("../components/ChatView.vue"),
    meta: { view: "chat", auth: true },
  },
  {
    path: "/w/:workspaceId/s/:sessionId",
    name: "session",
    component: () => import("../components/ChatView.vue"),
    meta: { view: "chat", auth: true },
  },
  /*
   * Anything else goes to the front door, where the guard has the last word: a signed-out
   * reader is taken on to the sign-in screen, and a signed-in one lands on the workspace list
   * with the URL corrected. A path this app does not own is not a page to complain about.
   */
  { path: "/:pathMatch(.*)*", name: "notFound", redirect: { name: "home" } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
