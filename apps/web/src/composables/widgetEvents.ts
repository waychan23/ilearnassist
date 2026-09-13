/**
 * The widget event bus.
 *
 * A widget is a Vue component, so it can already `watch` anything the store holds. This exists
 * for what the store **cannot see**: a change the *server* made, whose consequences the client's
 * copy of the data no longer reflects.
 *
 * That line is the whole design, and it is why the list below is short. A turn ending moves the
 * message counts and the token totals, and nothing local knows by how much; a conversation
 * created or deleted changes a workspace's shape. Everything the client itself decided and holds
 * — the open tab, the panel's width, which widget is installed after a request that returned the
 * new state — is a `watch` away, and is deliberately **not** an event here. Two ways to learn one
 * fact drift.
 *
 * A module-level singleton with no store import, on the `theme.ts` / `breakpoints.ts` pattern, so
 * `stores/app.ts` can import it without a cycle.
 */
export type WidgetEvent =
  /** A different workspace was selected, so every workspace-scope panel is showing a new object. */
  | { type: "workspace.selected"; workspaceId: string }
  | { type: "session.created"; workspaceId: string; sessionId: string }
  | { type: "session.renamed"; sessionId: string; title: string }
  | { type: "session.deleted"; workspaceId: string; sessionId: string }
  /** A turn began. Emitted for a resumed `ask_user` turn as well as a fresh one. */
  | { type: "turn.started"; sessionId: string }
  /**
   * A turn ended — success, failure or stopped.
   *
   * The one shape of event a widget almost always wants, and it is emitted from the single point
   * every turn ends at rather than from the three that start one. It carries the session id so a
   * session-scope widget can ignore another conversation's turns.
   */
  | { type: "turn.finished"; sessionId: string };

type WidgetEventHandler = (event: WidgetEvent) => void;

const handlers = new Set<WidgetEventHandler>();

/**
 * Deliver one event.
 *
 * A subscriber that throws is logged and skipped rather than allowed to blind the others: the
 * publisher is the store, mid-turn, and a widget's bug must not become a turn's bug. Copying the
 * set first means a handler that unsubscribes during delivery does not shorten the list being
 * walked.
 */
export function emitWidgetEvent(event: WidgetEvent): void {
  for (const handler of [...handlers]) {
    try {
      handler(event);
    } catch (err) {
      console.warn("[widgets] a subscriber threw", err);
    }
  }
}

/**
 * Subscribe, and get the unsubscribe back.
 *
 * The shape `onMounted` / `onBeforeUnmount` wants, which is the only way a widget can be sure it
 * stops being called after it unmounts — a subscription is not scoped to a component the way a
 * `watch` is.
 */
export function subscribeWidgetEvents(handler: WidgetEventHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
