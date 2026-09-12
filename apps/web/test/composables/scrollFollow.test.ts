import { describe, expect, it } from "vitest";
import { nextTick, ref } from "vue";
import { useScrollFollow } from "../../src/composables/scrollFollow.js";
import { BOTTOM_SLACK_PX } from "../../src/utils/scroll.js";

/**
 * The regression this whole composable exists for: a reply that is being written must not
 * drag a reader who has scrolled up back down on every token.
 *
 * The old shape was a watcher that assigned `scrollTop = scrollHeight` on every streamed
 * delta, so the two ways to write it wrong are both covered here — never releasing the
 * follow, and releasing it but moving the viewport anyway.
 *
 * Nothing needs a DOM: the composable only ever reads and writes the three numbers a scroller
 * reports, so a plain object stands in for the element and the assertions can be exact.
 */

interface FakeScroller {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * A scroller with the given extent, parked at its end — the state a conversation opens in.
 */
function atEnd(scrollHeight: number, clientHeight: number): FakeScroller {
  return { scrollTop: scrollHeight - clientHeight, clientHeight, scrollHeight };
}

function mount(el: FakeScroller | null) {
  return useScrollFollow(ref<HTMLElement | null>(el as unknown as HTMLElement | null));
}

describe("useScrollFollow", () => {
  it("starts following, because a conversation opens at its end", () => {
    const { following } = mount(atEnd(1200, 400));
    expect(following.value).toBe(true);
  });

  it("releases the follow when the container is found away from its end", () => {
    const el = atEnd(1200, 400);
    const { following, onScroll } = mount(el);

    onScroll();
    expect(following.value, "a scroll event at the end must not release the follow").toBe(true);

    el.scrollTop = 0;
    onScroll();
    expect(following.value).toBe(false);
  });

  it("keeps the viewport still while the follow is released", async () => {
    const el = atEnd(1200, 400);
    const { onScroll, follow } = mount(el);

    el.scrollTop = 0;
    onScroll();

    // Two tokens land. This is the jitter: `follow` used to move the viewport back to the end
    // on each one, which is what made the list impossible to read while it was being written.
    el.scrollHeight = 1400;
    follow();
    await nextTick();
    el.scrollHeight = 1600;
    follow();
    await nextTick();

    expect(el.scrollTop, "the reader was dragged back to a moving end").toBe(0);
  });

  it("still follows while the reader is at the end", async () => {
    const el = atEnd(1200, 400);
    const { follow } = mount(el);

    el.scrollHeight = 1400;
    follow();
    await nextTick();

    expect(el.scrollTop).toBe(1400);
  });

  it("writes the position a tick later, after the growth has been laid out", async () => {
    // Not an implementation detail: `scrollHeight` read at the moment the content changed is
    // the height from *before* it, so a synchronous write follows a reply and stays a little
    // short of it for the whole turn.
    const el = atEnd(1200, 400);
    const { follow } = mount(el);

    el.scrollHeight = 1400;
    follow();
    expect(el.scrollTop).toBe(800);

    await nextTick();
    expect(el.scrollTop).toBe(1400);
  });

  it("takes the follow back when the reader comes back to the end", async () => {
    const el = atEnd(1200, 400);
    const { following, onScroll, follow } = mount(el);

    el.scrollTop = 0;
    onScroll();
    expect(following.value).toBe(false);

    el.scrollTop = el.scrollHeight - el.clientHeight;
    onScroll();
    expect(following.value).toBe(true);

    // And the follow is live again, not merely recorded.
    el.scrollHeight = 1400;
    follow();
    await nextTick();
    expect(el.scrollTop).toBe(1400);
  });

  it("does not release the follow over the slack it wrote itself", () => {
    // The position the browser reports back is the one it was given, within rounding. Without
    // the slack the follow would release itself on the first token of every turn.
    const el = atEnd(1200, 400);
    const { following, onScroll } = mount(el);

    el.scrollTop = el.scrollHeight - el.clientHeight - BOTTOM_SLACK_PX;
    onScroll();

    expect(following.value).toBe(true);
  });

  it("returns to the end and re-takes the follow in one call", async () => {
    // What the return control does. It must not depend on a scroll event arriving afterwards
    // to flip the flag — a caller that reached the end without one would leave the control on
    // screen over a list that is being followed again.
    const el = atEnd(1200, 400);
    const { following, onScroll, scrollToBottom } = mount(el);

    el.scrollTop = 0;
    onScroll();
    expect(following.value).toBe(false);

    el.scrollHeight = 2000;
    scrollToBottom();

    expect(following.value).toBe(true);
    await nextTick();
    expect(el.scrollTop).toBe(2000);
  });

  it("survives a container that is not mounted yet", () => {
    const { following, onScroll, scrollToBottom, follow } = mount(null);

    expect(() => {
      onScroll();
      scrollToBottom();
      follow();
    }).not.toThrow();
    expect(following.value).toBe(true);
  });
});
