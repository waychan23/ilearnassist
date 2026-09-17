import type { Router } from "vue-router";
import type { useAppStore } from "../stores/app";

/**
 * Open a conversation from a row that lists it.
 *
 * One line of routing and one rule, and the rule is the reason this is a module rather than
 * three lines copied into each of the two lists that offer it (`Sidebar.vue` and the workspace
 * stats widget):
 *
 * **Clicking a conversation that is already open re-reads it.** A push to the address the tab
 * is already at is a navigation the router is entitled to skip — and it does, guards and all —
 * so the click would do nothing at all. Doing nothing is wrong here in a way it is not for a
 * link: "open this conversation" is also how a client picks up the write lease a moment after
 * another client let it go, and how a reader refreshes a transcript they suspect is stale. The
 * address is not what they are asking for; the conversation is.
 *
 * The router and the store are parameters rather than `useRouter()`/`useAppStore()` inside,
 * which is what makes this testable without mounting a component — the one thing this repo's
 * suite does not do.
 */
export function openSession(
  router: Router,
  store: ReturnType<typeof useAppStore>,
  sessionId: string
): void {
  if (store.activeSessionId === sessionId) {
    void store.selectSession(sessionId);
    return;
  }

  void router.push({
    name: "session",
    params: { workspaceId: store.activeWorkspaceId, sessionId },
  });
}
