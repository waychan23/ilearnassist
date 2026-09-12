import { describe, expect, it } from "vitest";
import { BOTTOM_SLACK_PX, distanceFromBottom, isAtBottom } from "../../src/utils/scroll.js";

/**
 * The arithmetic under "stay at the bottom", pinned on its own terms.
 *
 * `composables/scrollFollow.ts` is where this is used, and its test covers the behaviour that
 * matters — a reader who scrolls up is not dragged back. What is tested here is the boundary
 * the behaviour rests on, because the two ways this can be wrong are both invisible in that
 * test: a slack of zero breaks a follow against its own scroll event on a fractional
 * `scrollTop`, and a slack loose enough to swallow a wheel notch quietly re-grabs the
 * viewport from someone on their way somewhere else.
 */

describe("distanceFromBottom", () => {
  it("measures the content below the viewport", () => {
    expect(distanceFromBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1200 })).toBe(300);
  });

  it("is zero with the viewport parked on the last pixel", () => {
    expect(distanceFromBottom({ scrollTop: 800, clientHeight: 400, scrollHeight: 1200 })).toBe(0);
  });

  it("goes negative once the content stops overflowing", () => {
    // A conversation shorter than the pane reports the pane's height as its scroll height.
    // This is why callers compare with a ceiling rather than to zero.
    expect(distanceFromBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 180 })).toBe(-220);
  });
});

describe("isAtBottom", () => {
  const bottom = { scrollTop: 800, clientHeight: 400, scrollHeight: 1200 };

  it("is true at the bottom and one pixel short of it", () => {
    expect(isAtBottom(bottom)).toBe(true);
    expect(isAtBottom({ ...bottom, scrollTop: 799 })).toBe(true);
  });

  it("is true for a viewport with nothing to scroll", () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 400 })).toBe(true);
    expect(isAtBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 180 })).toBe(true);
  });

  it("tolerates the fractional scrollTop a scaled display reports", () => {
    // A viewport as far down as it will go reports `0.5` of travel left on a non-integer
    // device-pixel ratio. A slack of zero would read that as "the reader has taken over",
    // and the follow would release itself on the very first token.
    expect(isAtBottom({ ...bottom, scrollTop: 799.5 })).toBe(true);
  });

  it("is false past the slack", () => {
    expect(isAtBottom({ ...bottom, scrollTop: 800 - BOTTOM_SLACK_PX - 1 })).toBe(false);
    expect(isAtBottom({ ...bottom, scrollTop: 0 })).toBe(false);
  });

  it("takes an explicit slack", () => {
    expect(isAtBottom({ ...bottom, scrollTop: 700 }, 100)).toBe(true);
    expect(isAtBottom({ ...bottom, scrollTop: 700 }, 99)).toBe(false);
  });
});

describe("BOTTOM_SLACK_PX", () => {
  it("is a tolerance for the end, not a threshold for near it", () => {
    // The bound is the point: this is what stops a later tweak from turning the release into
    // something a reader has to fight their way out of. A wheel notch is tens of pixels, so a
    // slack that reaches one is a slack that re-grabs the viewport mid-gesture.
    expect(BOTTOM_SLACK_PX).toBeGreaterThan(0);
    expect(BOTTOM_SLACK_PX).toBeLessThanOrEqual(32);
  });
});
