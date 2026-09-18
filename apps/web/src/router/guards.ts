import { watch } from "vue";
import type { RouteLocationRaw, Router } from "vue-router";
import { useAppStore } from "../stores/app";
import type { AdminSection } from "../composables/ui";
import {
  closeDrawer,
  closeSessionSettings,
  closeWidgetDrawer,
  closeWorkspaceSettings,
} from "../composables/ui";
import { reportLeave } from "../composables/sessionLeave";
import { consumeStaleAddress } from "../composables/instance";
import { isUnauthenticatedError } from "../utils/apiError";
import { ADMIN_SECTIONS } from "./index";

/**
 * Everything that has to happen around a navigation, in one place.
 *
 * The route table says what the URLs *are*; this says what moving between them *means*. It is
 * the only bridge between the two halves of the app's state, and that is the whole design: the
 * route is where you are, the store is what is loaded, and nothing else crosses between them —
 * `stores/app.ts` assigns `activeWorkspaceId` and `activeSessionId` nowhere except through the
 * `selectWorkspace` / `selectSession` calls below.
 *
 * That is a correctness rule rather than a tidiness one. `selectSession` is what gives back the
 * previous conversation's write lease and takes the next one's, and its own effect cannot do it
 * later: `ChatView` is *reused* when only the session changes, so nothing unmounts and
 * `composables/sessionLock.ts`'s teardown never fires. A guard that assigned the id directly
 * would leave the old lease held, take no new one, and stop the heartbeat — a conversation that
 * quietly goes read-only.
 *
 * ### The three hooks
 *
 * **`beforeEach`** is the gate: it asks who the caller is (once), refuses the pages an account
 * may not see, and loads what the destination names. Each refusal is a redirect rather than a
 * hidden page, which is what makes a typed URL answer the same way a hidden button does.
 *
 * **`afterEach`** is the teardown the deleted `show*` helpers used to do — closing drawers and
 * dialogs belonging to the page being left, and reporting the conversation left behind. It was
 * six copies of a rule; here it is the rule.
 *
 * **The account watcher** is the third, and it is the one that could not be a guard: the account
 * can go away without anybody navigating — a 401 arrives, or the reader presses sign out. Rather
 * than have the store know about the router, the router notices the store's account is gone.
 * That is also what makes "signing out lands on the sign-in screen even when the logout request
 * fails" structural instead of a line somebody has to remember.
 *
 * ### The store is a parameter
 *
 * `main.ts` hands it in, and the call is ordered before `app.use(router)` — which is not a
 * detail: installing a router is what *starts the first navigation*, so guards registered
 * afterwards would miss the very navigation that decides which page a reload lands on. Taking
 * the store as an argument rather than calling `useAppStore()` is what lets it be set up
 * without an active Pinia, and it is also what lets a test install a store of its own.
 */

/** `e` as a sentence. The guard reports failures the way every other caller does. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const isAdminSection = (value: string): value is AdminSection =>
  (ADMIN_SECTIONS as readonly string[]).includes(value);

/**
 * @returns a function that takes it all back — the three registrations, unregistered. The app
 *   installs this once and never asks; a test file installs it per case on one shared router,
 *   and without this every earlier case's guards would still be in the chain, waiting to
 *   redirect a navigation they were never written for.
 */
export function installGuards(
  router: Router,
  store: ReturnType<typeof useAppStore>
): () => void {
  /**
   * Who is asking, asked once.
   *
   * The session is a bearer token in `localStorage`, so whether anyone is signed in is a fact
   * only the server has — and it is a fact every navigation depends on. Memoised because the
   * first navigation answers it and every later one would only be asking the same question
   * again; `App.vue`'s `authReady` gate is what keeps nothing painted until it has.
   */
  let probed: Promise<void> | null = null;
  const ensureProbed = (): Promise<void> => (probed ??= store.probeAccount());

  /**
   * The workspace this guard last handed to `selectWorkspace`.
   *
   * Kept here rather than read back off the store, because the store's `activeWorkspaceId` is
   * also written by paths that never load a workspace's conversations (`loadApp`'s default and
   * `createWorkspace` both set it). "Which workspace is the store *in*" and "which one has it
   * *read*" are different questions, and the second is the one that decides whether a reload is
   * needed.
   */
  let appliedWorkspaceId: string | null = null;

  /**
   * Where a refusal to enter a page sends the reader: the screen they owe, remembering where
   * they were going. The front door carries no `redirect` — "you were on the way to home" is
   * not a place to come back to.
   *
   * **And neither does an address from another installation.** A data-root switch leaves a tab
   * holding a `/w/<id>/s/<id>` that named a workspace in a database that is gone; handing it back
   * after the sign-in would land the reader on a page that never existed, which is the
   * 会话不存在 report. This is the one place that knows both halves — the destination and the fact
   * that it cannot mean anything here. See `composables/instance.ts`.
   */
  const landing = (fullPath: string, name: "login" | "password"): RouteLocationRaw => {
    const home = fullPath === "/" || consumeStaleAddress();
    return { name, query: home ? {} : { redirect: fullPath } };
  };

  const stopBefore = router.beforeEach(async (to) => {
    await ensureProbed();
    const account = store.account;
    const owesPassword = Boolean(account?.mustChangePassword);

    if (!account) {
      // `/login` is the one page a signed-out reader may see; anything else is remembered so
      // the sign-in can hand it back. That is the whole of "a bookmark opens the conversation
      // it names" for a session that has since expired.
      return to.name === "login" ? true : landing(to.fullPath, "login");
    }

    // Held until a password is chosen, and the server refuses every other route anyway — so
    // this is the screen, not a redirect loop.
    if (owesPassword) {
      return to.name === "password" ? true : landing(to.fullPath, "password");
    }

    // Signed in, so neither of those two has anything to say.
    if (to.name === "login" || to.name === "password") return { name: "home" };

    try {
      await store.ensureLoaded();
    } catch (e) {
      // A failed load is not a failed navigation: the pages all render their own empty state,
      // and a blank screen behind a toast would be worse than an empty workspace list. Same
      // shape as the `onMounted` catch this replaced.
      store.setError(messageOf(e));
    }

    // A hidden button is not a permission, and neither is a typed URL — the console checks on
    // the server too, this is only what the reader is shown.
    if (to.meta.admin && !store.canAdmin) return { name: "home" };

    if (to.name === "admin") {
      const section = String(to.params.section ?? "");
      if (!isAdminSection(section)) {
        // Completes a bare `/admin` and corrects a section that is not one. `replace`, because
        // this is the URL being fixed rather than a step the reader took.
        return { name: "admin", params: { section: "users" }, replace: true };
      }
    }

    if (to.name !== "workspace" && to.name !== "session") return true;

    const workspaceId = String(to.params.workspaceId ?? "");
    if (appliedWorkspaceId !== workspaceId || store.activeWorkspaceId !== workspaceId) {
      try {
        await store.selectWorkspace(workspaceId);
        appliedWorkspaceId = workspaceId;
      } catch (e) {
        // A dead session is not this guard's to report: the 401 handler has already cleared
        // the account and the watcher below lands the reader on the sign-in screen. Showing
        // the workspace home instead would only be overruled a moment later.
        if (isUnauthenticatedError(e)) return false;
        appliedWorkspaceId = null;
        store.setError(messageOf(e));
        return { name: "home" };
      }
    }

    if (to.name !== "session") return true;

    const sessionId = String(to.params.sessionId ?? "");
    if (store.activeSessionId === sessionId) return true;

    /**
     * The conversation has to be one of *this* workspace's — and the list is the only place
     * that says so cheaply. A session id from elsewhere in the account would otherwise load
     * happily (messages are scoped to the owner, not to the workspace) and be shown under a
     * workspace it does not belong to, which is a URL that lies about what is on screen.
     */
    if (!store.sessions.some((s) => s.id === sessionId)) {
      return { name: "workspace", params: { workspaceId }, replace: true };
    }

    try {
      await store.selectSession(sessionId);
    } catch (e) {
      if (isUnauthenticatedError(e)) return false;
      store.setError(messageOf(e));
      return { name: "workspace", params: { workspaceId }, replace: true };
    }

    return true;
  });

  const stopAfter = router.afterEach((to, from) => {
    const view = to.meta.view;
    const left = from.meta.view;
    // Switching conversation is not leaving the page, and a dialog opened *about* the
    // conversation on screen must survive it — which is exactly what `Sidebar.vue`'s row
    // settings button does when it opens one.
    if (view === left) return;

    closeDrawer();
    closeSessionSettings();
    /*
     * Every page but the conversation closes the widget drawer with everything else — and that
     * one keeps it, because the panel belongs to the pane being entered rather than to the one
     * being left. This is `showChat`'s asymmetry, which is why it is written as a rule about
     * the destination.
     */
    if (view !== "chat") closeWidgetDrawer();
    // The workspace settings dialog is opened *from* a card on the home page, so the home page
    // keeps it; the sign-in pair is the one destination with no card behind it.
    if (view === "login" || view === "password") closeWorkspaceSettings();

    /*
     * Leaving a conversation is reported even though `noteSession` never saw it leave: going
     * back to the workspace list deliberately keeps `activeSessionId`, so nothing in the store
     * moves and only the page change can say the reader went. This used to live inside
     * `showWorkspaceHome`, which was the one function that left a conversation — a route table
     * has many ways out, so it is the transition that reports now.
     */
    if (left === "chat") reportLeave();
  });

  const stopWatching = watch(
    () => store.account,
    (account) => {
      // Only away from a page that needed one: signing out on the sign-in screen is not a
      // transition worth acting on, and there is nothing to correct.
      if (account) return;
      if (!router.currentRoute.value.meta.auth) return;
      void router.replace({ name: "login" });
    }
  );

  return () => {
    stopBefore();
    stopAfter();
    stopWatching();
  };
}
