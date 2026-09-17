import { onScopeDispose, watchEffect } from "vue";
import type { WidgetId } from "@ilearnassist/shared";
import { WIDGET_IDS } from "@ilearnassist/shared";
import { useAppStore } from "../stores/app";
import { WIDGET_MODULES, type WidgetContext } from "../widgets/registry";

/**
 * Telling widgets which object they are live on — `WidgetModule.onActive`.
 *
 * ### Why this is an effect with a lifetime rather than a store `watch`
 *
 * Two reasons, and the second is the one that decided it.
 *
 * The first is that the question only has an answer while a view is on screen. Which widget
 * is "live on what the reader is looking at" is not a fact about the store — it is a fact
 * about the panel being rendered beside a conversation. An effect owned by the component
 * that renders that panel says so directly, and `null` on the way out is not a special case
 * but the effect stopping.
 *
 * The second is that a `watch` registered inside the store's setup belongs to no lifetime at
 * all. In the app that is invisible, because there is one store and it lives as long as the
 * page. Anywhere the store is constructed more than once — a test per case, and Pinia
 * abandoning each instance with its effects still running — every abandoned store keeps
 * watching a *module-level* singleton (`uiState`), so a change in one test wakes the watchers
 * of every store built before it. That is not a hazard anybody can see in the app, and it is
 * a class of confusing cross-test failure rather than one instance of it.
 *
 * A `watchEffect` over the store's own reactive state, run inside this scope, is also what
 * makes the eight or so places that change an active object unnecessary: selecting and
 * creating a workspace or a session, deleting one, toggling a widget, toggling a whole group,
 * signing out, the 401 handler, and the cold load all move one of the inputs.
 *
 * The one transition none of them covers is leaving a conversation for a page that has no
 * widget panel — the route changes and `activeSessionId` deliberately does not — and that is
 * exactly the transition the scope owns.
 */

/** Which widget is live on the object on screen, or null when it is not installed there. */
function contextFor(
  id: WidgetId,
  state: {
    workspaceId: string | null;
    sessionId: string | null;
    workspaceWidgetIds: readonly WidgetId[];
    sessionWidgetIds: readonly WidgetId[];
    /** The conversation on screen is being written to from another client. */
    sessionReadOnly: boolean;
  }
): WidgetContext | null {
  // The session first: a widget installed at both levels is the more specific install on
  // screen, and a session always belongs to a workspace, so the wider one is the fallback.
  if (state.sessionId && state.sessionWidgetIds.includes(id)) {
    return {
      scope: "session",
      scopeId: state.sessionId,
      widgetId: id,
      writable: !state.sessionReadOnly,
    };
  }
  if (state.workspaceId && state.workspaceWidgetIds.includes(id)) {
    // Always writable: a workspace has no write lock, and a widget scoped to it has nothing to be
    // read-only about. Only a conversation is held by one client at a time.
    return { scope: "workspace", scopeId: state.workspaceId, widgetId: id, writable: true };
  }
  return null;
}

/**
 * Activate the installed widgets for as long as this effect scope lives.
 *
 * Called from `ChatView`'s setup, which is the component that renders the panel — so a widget
 * is told it is live exactly while a reader could be looking at it, and told it is not when
 * the view goes away.
 */
export function useWidgetActivation(): void {
  const store = useAppStore();
  const stop = watchEffect(() => {
    const state = {
      workspaceId: store.activeWorkspaceId,
      sessionId: store.activeSessionId,
      workspaceWidgetIds: store.workspaceWidgetIds,
      sessionWidgetIds: store.sessionWidgetIds,
      // Read here and passed down rather than left for a widget to look up: this effect is where
      // the host's facts are gathered into a context, and `WidgetContext.writable` is one of them.
      // It also means a lease changing re-runs this, so a widget is told when writing becomes
      // possible again — not just when it is taken away.
      sessionReadOnly: store.isActiveSessionReadOnly,
    };
    for (const id of WIDGET_IDS) WIDGET_MODULES[id]?.onActive?.(contextFor(id, state));
  });

  /*
   * Stopping the effect covers the reactive inputs, but a widget that claimed something still
   * has to be told: nothing changed, the view simply went away. Every widget gets the same
   * `null` the effect would have given it — including the note that this is the one
   * transition the effect itself cannot see.
   */
  onScopeDispose(() => {
    stop();
    for (const id of WIDGET_IDS) WIDGET_MODULES[id]?.onActive?.(null);
  });
}
