import { api } from "../api/client";
import type { Session } from "../api/types";

/**
 * Telling the server the reader has gone.
 *
 * The titler runs after every finished turn that produced prose, and the server's hook for it is
 * `finishTurn` — which is not a reader leaving. `POST /api/sessions/:id/leave` is the second look
 * a turn cannot take: a titling call that *failed* (no key, a rate limit, a model that spent its
 * whole budget thinking) leaves the user's own clipped words standing, and a turn that ended in an
 * error never asked at all. This module is the only thing that calls it.
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
 * would be a cycle. What is fed in is the **id**, and the session itself is resolved through a
 * lookup the store registers — see below. The title comes *out* through a callback the caller
 * passes, so there is no listener registry whose lifetime would belong to no component.
 *
 * ### The id, not the object — and that is a bug fix rather than a preference
 *
 * This used to hold the `Session` it was handed, and the gate below then read a **snapshot**:
 * `loadSessions()` replaces the whole list at the end of every turn, so the object captured on
 * the way into a conversation kept the `titleState` it had when the reader *arrived* — and since
 * that is usually `undefined`, "needs a retry" was true for every conversation the reader ever
 * left. The request went out and the server answered `skipped`, so nothing was mistitled; but the
 * gate that exists to make the common case free did nothing at all. Reading the live row when the
 * debounce fires is also what makes the gate *correct* rather than merely cheap: the state it
 * wants has usually settled a moment ago, at the end of the turn.
 *
 * ### `noteSession` is how "left" is noticed
 *
 * Comparing the conversation being replaced against the new one means the *caller* never has to
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
let currentId: string | null = null;

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
 * How to find the conversation on screen *now*, registered by the store for `onRetitled`'s reason.
 *
 * The gate below is two fields of a live row, and the one place that holds the live rows is the
 * store. Without this the module would have to remember the session it was handed, which is the
 * stale snapshot the header explains.
 */
export type SessionLookup = (sessionId: string) => Session | undefined;

let lookup: SessionLookup | null = null;

/** Register how to read the current session, by id. */
export function onSessionLookup(fn: SessionLookup): void {
  lookup = fn;
}

/**
 * Whether leaving this conversation is worth a request.
 *
 * The exact predicate the server re-checks, applied here first so the common case — a conversation
 * the model already named — costs **no request at all**.
 *
 * `"unnamed"` is refused for a reason of its own rather than for symmetry with `"model"`: it means
 * the turn that just ended asked the titler about *this* conversation and was told there was
 * nothing to name yet. Nothing has happened since, so the answer would be the same and the call
 * would be paid for twice. The other two open states are the ones worth the second look: absent
 * means no turn ever asked, and `"fallback"` means the asking never worked.
 */
export function needsTitleRetry(session: {
  titleSource: Session["titleSource"];
  titleState?: Session["titleState"];
}): boolean {
  return (
    session.titleSource === "auto" &&
    session.titleState !== "model" &&
    session.titleState !== "unnamed"
  );
}

/** What is on screen now — and, implicitly, what the reader has just left. */
export function noteSession(session: Session | null): void {
  const next = session?.id ?? null;
  if (currentId && currentId !== next) schedule(currentId);
  currentId = next;
}

/**
 * The reader left the conversation without another one taking its place.
 *
 * Going back to the workspace home is exactly that: the route changes and `activeSessionId`
 * deliberately does not, so `noteSession` sees nothing to report and only an explicit call can say
 * the reader went. `router/guards.ts` makes it, on the way out of any conversation route.
 */
export function reportLeave(): void {
  if (currentId) schedule(currentId);
}

/** Forget the conversation without reporting it — for one that no longer exists. */
export function forgetSession(): void {
  currentId = null;
}

function schedule(sessionId: string): void {
  const pending = timers.get(sessionId);
  if (pending) clearTimeout(pending);
  timers.set(
    sessionId,
    setTimeout(() => {
      timers.delete(sessionId);
      /*
       * Read at *this* moment rather than when the leave was noticed — see the header. A
       * conversation no longer in the list is simply not reported: it was deleted, or the account
       * changed, and either way there is nothing there to rename.
       */
      const session = lookup?.(sessionId);
      if (!session || !needsTitleRetry(session)) return;
      void send(sessionId);
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
