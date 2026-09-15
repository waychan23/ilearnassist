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
  | { type: "turn.finished"; sessionId: string }
  /**
   * A plan tool (`ila_make_plan` / `ila_update_plan_progress`) committed during a turn, so the
   * plan widget refetches mid-turn without waiting for the turn to end. Carries the session id
   * like `turn.finished`.
   */
  | { type: "plan.changed"; sessionId: string }
  /**
   * An `ila_review_quiz` grading call committed during a turn, so the quiz widget refetches
   * mid-turn without waiting for the turn to end. Carries the session id like `plan.changed`.
   */
  | { type: "quiz.changed"; sessionId: string }
  /**
   * An `ila_diagram` call wrote its file during a turn, so the diagram widget refetches
   * mid-turn without waiting for the turn to end. Carries the session id like `plan.changed`.
   *
   * This one is squarely inside the doctrine that events exist for what the store cannot see:
   * the diagram tool's *result is a file on disk*, and nothing local knows what the directory
   * holds now — not how many `.mmd` files there are, and not what they are called. A widget
   * that watched the message list for a new diagram call would be a second way to learn one
   * fact, and it would still miss a file somebody put in the folder by hand.
   */
  | { type: "diagram.changed"; sessionId: string }
  /**
   * A widget asked to scroll the conversation to a tool-call card — a plan node's start
   * anchor. The widget cannot reach ChatView's scroll container, which is what makes this an
   * event. Scrolling to the card (rather than the message top) lands on the node's start.
   */
  | { type: "chat.jump"; toolCallId: string }
  /**
   * A widget asked to scroll the conversation to a message row — a thread's first message.
   * Sibling of `chat.jump`, which targets a tool-call card: message anchors are
   * `[data-message-id]`, and the minimap already scrolls to them through `scrollToMessage`.
   */
  | { type: "chat.jumpToMessage"; messageId: string };

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
