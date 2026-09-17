import { api } from "../api/client";
import type { Session } from "../api/types";

/**
 * Telling the server the reader has gone.
 *
 * The auto-titler runs **once**, on a conversation's first turn, and the server's own hook for it
 * is `finishTurn` — which is not a reader leaving. So a conversation whose titling call failed, or
 * whose first reply was stopped before it emitted anything, keeps the placeholder or the user's own
 * clipped words for good. `POST /api/sessions/:id/leave` is the second attempt, and this module is
 * the only thing that calls it.
 *
 * ### The trigger is here because the fact is here
 *
 * Only the browser knows the reader has left, which is why this is an event the client reports
 * rather than a timer or a server-side hook. There is no SSE stream open at the moment it fires,
 * so the answer comes back on the response — and it is a response nothing waits for.
 *
 * ### No store import, and no subscription
 *
 * The active conversation is *fed in* by `noteSession` rather than read from the store, for
 * `widgetEvents.ts`'s reason: `stores/app.ts` imports this module, so importing the store back
 * would be a cycle. The title comes *out* through a callback the caller passes, so there is no
 * listener registry whose lifetime would belong to no component — a subscription made in a store's
 * setup outlives the store, and in a test suite every abandoned store keeps it alive.
 *
 * ### `noteSession` is how "left" is noticed
 *
 * Comparing the session being replaced against the new one means the *caller* never has to
 * remember to say "I am leaving X" — it has one obligation, "this is what is on screen now", which
 * is also the only thing it can get wrong in one place. The one transition that does not change
 * the active conversation is going back to the workspace home (the app deliberately keeps
 * `activeSessionId` there), and `reportLeave` is for that.
 */

/**
 * How long after leaving we ask.
 *
 * Debounced, and the reason is the second half of the requirement rather than the first: this is
 * **not a critical operation**, so a reader flicking between conversations should produce one
 * request per conversation settled on, not one per click. Three seconds is longer than a click and
 * far shorter than a model call.
 */
const DEBOUNCE_MS = 3_000;

/** Per conversation, so moving quickly between two of them does not cancel either. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** The conversation on screen, as far as this module knows. */
let current: Session | null = null;

/**
 * Called when a report lands, with the title the server settled on.
 *
 * An assignment rather than a subscription, and the difference matters: a subscription would need
 * an unsubscribe whose lifetime belongs to no component — the trap `widgetEvents.ts` documents —
 * while this is one function reference that a second store instance simply replaces. A leftover
 * handler from a store that has gone finds no session with that id and does nothing.
 *
 * There is exactly one consumer, the store, so a registry would be machinery for a case that does
 * not exist.
 */
export type RetitledHandler = (sessionId: string, title: string) => void;

let retitled: RetitledHandler | null = null;

/** Register the sink for a title that arrives after the reader has gone. */
export function onRetitled(handler: RetitledHandler): void {
  retitled = handler;
}

/**
 * Whether this conversation is one a retry could help.
 *
 * The exact predicate the server re-checks, applied here first so the common case — a conversation
 * the model already named — costs **no request at all**. `titleState` absent means the titler never
 * ran, which is the stopped-first-turn case and equally worth another try.
 */
export function needsTitleRetry(session: {
  titleSource: Session["titleSource"];
  titleState?: Session["titleState"];
}): boolean {
  return session.titleSource === "auto" && session.titleState !== "model";
}

/** What is on screen now — and, implicitly, what the reader has just left. */
export function noteSession(session: Session | null): void {
  if (current && current.id !== session?.id) schedule(current);
  current = session;
}

/**
 * The reader left the conversation without another one taking its place.
 *
 * Going back to the workspace home is exactly that: the route changes and `activeSessionId`
 * deliberately does not, so `noteSession` sees nothing to report and only an explicit call can say
 * the reader went. `router/guards.ts` makes it, on the way out of any conversation route.
 */
export function reportLeave(): void {
  if (current) schedule(current);
}

/** Forget the conversation without reporting it — for one that no longer exists. */
export function forgetSession(): void {
  current = null;
}

function schedule(session: Session): void {
  if (!needsTitleRetry(session)) return;

  const pending = timers.get(session.id);
  if (pending) clearTimeout(pending);
  timers.set(
    session.id,
    setTimeout(() => {
      timers.delete(session.id);
      void send(session.id);
    }, DEBOUNCE_MS)
  );
}

/**
 * Report and forget.
 *
 * Every failure is swallowed, including a network one, for the reason the route gives for
 * answering 200 to a failed attempt: the reader has already left, the conversation is not broken,
 * and a message about a title nobody is looking at is worse than the placeholder it is about. The
 * next leave tries again — which is what "not a critical operation" has to mean in code.
 */
async function send(sessionId: string): Promise<void> {
  try {
    const result = await api.reportSessionLeave(sessionId);
    if (result.status === "titled" && result.title) retitled?.(sessionId, result.title);
  } catch {
    // Deliberately silent — see above.
  }
}
