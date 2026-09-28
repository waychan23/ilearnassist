import { onScopeDispose, watch } from "vue";
import { useAppStore, SESSION_LOCK_HEARTBEAT_MS } from "../stores/app";

/**
 * The session write lock's lifetime, owned by the view that shows a conversation.
 *
 * ### Why this is an effect scope rather than a store timer
 *
 * The requirement is explicit that *退出工作区时，取消所有检测逻辑* — leaving a workspace stops every
 * check. That is a question about a *view*, not about the store: the locks this client holds and
 * the marks it reads are only meaningful while a conversation is on screen, and `ChatView` is
 * mounted exactly then. Stopping on `onScopeDispose` makes the requirement structural instead of
 * a flag that some future transition has to remember to clear — including the transition nothing
 * reactive expresses, which is the view simply going away.
 *
 * It is the shape `composables/widgetActivation.ts` uses, and for its second reason too: a
 * `watch` registered inside the store's setup belongs to no lifetime at all. In a test suite
 * every abandoned store instance would go on watching, so a change in one test would wake the
 * watchers of every store built before it.
 *
 * ### What runs, and when
 *
 * | When | What |
 * | --- | --- |
 * | opening a conversation | the store takes its lock and releases the previous one |
 * | mounting with one already open | a claim, for the paths that never call `selectSession` |
 * | every 60s while a conversation is open | one heartbeat, for the lease this client holds |
 * | every 5 min | a workspace-wide re-read, for the locks this client cannot see change |
 * | a turn refused with `SESSION_LOCKED` | an immediate re-read (in `consume`, and in the client) |
 * | the tab coming back to the front | a re-read, because that is when it matters |
 * | leaving the conversation | the release |
 * | leaving the workspace | all of the above stops, and the lease is released |
 * | the page going away (`pagehide`) | the release, sent with `keepalive` |
 * | the page coming back from the bfcache | the claim again |
 *
 * The heartbeat is guarded on having actually *taken* something: beating for a conversation this
 * client does not hold would be asking the server to give it away every minute, which is a
 * refusal per beat rather than a lease. The guard is what makes the 409 a one-off event that
 * settles into the read-only state instead of a loop.
 */
export function useSessionLock(): void {
  const store = useAppStore();

  void store.refreshWorkspaceLocks();

  /*
   * The conversation already on screen is this client's to claim. `selectSession` is what usually
   * does it, but it does not run on every path that puts a conversation in front of the reader:
   * the browser's Back from the workspace list, and a workspace card reopening the conversation
   * the store still holds, both remount this view with `activeSessionId` already set. A claim on
   * a conversation somebody else holds resolves into the read-only state, which is the same
   * answer `selectSession` would have produced.
   */
  const open = store.activeSessionId;
  if (open && store.heldSessionId !== open) void store.acquireSessionLock(open);

  /*
   * The lock follows the conversation *and* the workspace, because `refreshWorkspaceLocks` reads
   * the workspace: a store holding one from a workspace that is no longer open would mark the
   * wrong list. `selectWorkspace` and `selectSession` both do their own part synchronously — this
   * is the backstop for the paths that change either id without going through them.
   */
  const stopWatching = watch(
    () => store.activeWorkspaceId,
    () => void store.refreshWorkspaceLocks()
  );

  const heartbeat = setInterval(() => {
    const held = store.heldSessionId;
    // Only for a lease this client actually holds and is still looking at. A conversation left
    // open in another tab is not this tab's to keep alive.
    if (held && held === store.activeSessionId) void store.acquireSessionLock(held);
  }, SESSION_LOCK_HEARTBEAT_MS);

  /*
   * The backstop, for the changes this client cannot know about: another client taking a
   * conversation, or a lease of its own expiring because a beat was lost. Everything else asks
   * for a read directly through `requestLockRefresh`, which is debounced.
   */
  const poll = setInterval(() => store.requestLockRefresh(0), LOCK_POLL_INTERVAL_MS);

  /**
   * The page is going away — a tab closed, a reload, a navigation to another site.
   *
   * This is the one leave `onScopeDispose` cannot see, and the reason the release is sent with
   * `keepalive`: an ordinary fetch is cancelled with the page, so without this a closed tab would
   * hold its conversation read-only for the full two-minute expiry. `pageshow` below is the other
   * half, for the bfcache restore that comes back from exactly this event.
   */
  const onPageHide = () => store.endSessionLockLifecycle({ keepalive: true });

  /**
   * The page came back without reloading — a bfcache restore. The claim `pagehide` gave back has
   * to be taken again, because nothing else about this document re-ran.
   */
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    const id = store.activeSessionId;
    if (id) void store.acquireSessionLock(id);
  };

  /**
   * Coming back to the tab is when another client's leaving matters most: the reader may have
   * been looking at a read-only conversation whose lease was given back while the tab was in the
   * background. The five-minute poll is the backstop, not the thing to wait for here.
   */
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") store.requestLockRefresh(0);
  };

  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibilityChange);

  onScopeDispose(() => {
    stopWatching();
    clearInterval(heartbeat);
    clearInterval(poll);
    window.removeEventListener("pagehide", onPageHide);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    store.stopLockChecks();
    /*
     * Give the lease back, because the reader has gone *and* because this is the one transition
     * no reactive input expresses. `endSessionLockLifecycle` rather than a release of
     * `heldSessionId`: it also moves the lease generation, which is what makes an acquire still
     * in flight for the conversation being left hand itself back when it answers.
     *
     * Best effort, and the lease is the guarantee rather than this: a tab killed without running
     * this leaves a lease that expires on its own.
     */
    store.endSessionLockLifecycle();
  });
}

/**
 * How often the workspace-wide lock read runs on its own.
 *
 * Declared here rather than beside the heartbeat because the two intervals are different
 * questions: the heartbeat is about a lease this client is *responsible* for (and therefore
 * derived from the server's TTL, in the store), while this is about state it merely observes,
 * where being late costs a dot that corrects itself.
 */
const LOCK_POLL_INTERVAL_MS = 300_000;
