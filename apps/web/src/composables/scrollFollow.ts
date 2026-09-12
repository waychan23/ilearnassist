import { nextTick, ref, type Ref } from "vue";
import { isAtBottom } from "../utils/scroll";

/**
 * Whether a scroller follows its content as it grows.
 *
 * The message list streams tokens into a box that keeps getting taller, and the obvious way
 * to write that — put the viewport at the end whenever anything changed — is a fight with the
 * reader. Every delta drags the viewport back down, so someone scrolling up through a long
 * reply is returned to the bottom on the next token, and again on the one after it: a jitter
 * that repeats until the turn ends and a list that cannot be read while it is being written.
 *
 * So following is *state* rather than an unconditional consequence of a change. It is
 * released when the container is found away from its end, and retaken when the reader comes
 * back to the end or asks for it. While it is released the stream keeps arriving and nothing
 * moves — which is the whole of the property, and the reason this is a state machine and not
 * a comparison made at the moment of each change.
 *
 * The released state is readable by the caller (`following`) because it is also what decides
 * whether to offer a way back: a reader who has scrolled away from a moving target has no
 * other way to reach it, and a follow that could be left without a way home is a worse
 * bargain than the jitter it replaced.
 */
export function useScrollFollow(container: Ref<HTMLElement | null>) {
  const following = ref(true);

  /**
   * Derive the state from the position rather than tracking it ourselves.
   *
   * The scroll position belongs to the browser, and it also moves for reasons no handler of
   * ours caused — a resize, a late font, a scrollbar appearing, an earlier message re-laying
   * out when its syntax highlighting or maths lands. Reading "is it at the end" off the
   * position afterwards is correct in all of those; a flag set only where we expect movement
   * is wrong in each of them. It is also what makes the release work for *any* gesture, since
   * a wheel, a drag of the scrollbar, a touch and a keyboard scroll all arrive here as the
   * same event.
   */
  function onScroll(): void {
    const el = container.value;
    if (!el) return;
    following.value = isAtBottom(el);
  }

  /**
   * Go to the end and take the follow back.
   *
   * Both halves matter and they are the same act: this is either the reader asking to return
   * to a live reply, or having just sent one. Landing at the end without following would drop
   * them off it again on the next token.
   *
   * The state flips now and the viewport moves a tick later. Every caller has just changed
   * something — a turn was sent, another conversation was opened — and `scrollHeight` read
   * before the DOM has laid that out is the height from *before* it, which is how a scroll to
   * the bottom ends up a few pixels short of it. The gap is a microtask, so no reader can do
   * anything in it, and the flip is not deferred so the control driven by `following` never
   * lags a frame behind the click that caused it.
   */
  function scrollToBottom(): void {
    following.value = true;
    void nextTick(() => {
      const el = container.value;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    });
  }

  /**
   * The content grew: go to the end, but only if the reader has not taken over.
   *
   * The decision is made *now* and not inside the deferred write, because it is a statement
   * about the reader at the moment the content grew — by the time the write runs the reader
   * could not have done anything, but the next growth can, and it is the growth that decides.
   */
  function follow(): void {
    if (!following.value) return;
    scrollToBottom();
  }

  return { following, onScroll, scrollToBottom, follow };
}
