import { describe, expect, it } from "vitest";
import {
  clampWindowPosition,
  nudgeWindowPosition,
  WINDOW_KEEP_VISIBLE_PX,
} from "../../src/utils/windowDrag";

/**
 * The arithmetic a dragged window is held by.
 *
 * The rule being tested is not "the window stays on screen" — a window taller than the screen
 * cannot, and refusing to move it would be its own bug — but "enough of it stays on screen to see
 * and grab its header", which is the only part that has to be reachable for it to be dragged back.
 * Every direction gets the same treatment, which is why the four edges are four cases rather than
 * one.
 */

const VIEWPORT = { width: 1440, height: 900 };
const SIZE = { width: 720, height: 600 };

describe("clampWindowPosition", () => {
  it("leaves a window that is already inside the viewport alone", () => {
    const position = { left: 300, top: 150 };

    expect(clampWindowPosition(position, SIZE, VIEWPORT)).toEqual(position);
  });

  it("keeps a window dragged off the left edge reachable", () => {
    // Far past the edge, the bound is the same one a small overshoot gets: it is not "how far may
    // this go" but "how much must stay". The *right* end of the header is what stays on screen,
    // and the header spans the window's whole width, so a margin of the window is a margin of it.
    const clamped = clampWindowPosition({ left: -4000, top: 100 }, SIZE, VIEWPORT);

    expect(clamped.left).toBe(WINDOW_KEEP_VISIBLE_PX - SIZE.width);
  });

  it("never lets the header go above the top edge", () => {
    /*
     * The asymmetry between the axes, and the reason it is not an oversight: vertically the header
     * is only the window's *top band*, so "keep this much of the window on screen" would be
     * satisfied by its bottom — a window whose title bar is off the top is one nobody can drag
     * back. The top edge of the window is therefore held at the viewport's, which is what a
     * browser window does for the same reason.
     */
    const clamped = clampWindowPosition({ left: 300, top: -4000 }, SIZE, VIEWPORT);

    expect(clamped.top).toBe(0);
  });

  it("keeps a window dragged off the right or bottom edge reachable", () => {
    const clamped = clampWindowPosition({ left: 9000, top: 9000 }, SIZE, VIEWPORT);

    expect(clamped.left).toBe(VIEWPORT.width - WINDOW_KEEP_VISIBLE_PX);
    // The whole header is still up there, comfortably grabbable.
    expect(clamped.top).toBe(VIEWPORT.height - WINDOW_KEEP_VISIBLE_PX);
  });

  it("centres a window whose bounds cannot both hold", () => {
    /*
     * The two bounds cross — which needs a viewport smaller than the margins plus the window
     * itself, so it is a case the app cannot reach and the arithmetic still has to answer: a
     * crossing would otherwise let the minimum win and put the window hard against an edge of a
     * screen that cannot hold it. Centring is the answer that is wrong in no direction.
     */
    const viewport = { width: 70, height: 60 };
    const size = { width: 50, height: 50 };

    expect(clampWindowPosition({ left: -500, top: 500 }, size, viewport)).toEqual({ left: 10, top: 5 });
  });
});

describe("nudgeWindowPosition", () => {
  it("moves by the step and clamps like any other move", () => {
    expect(nudgeWindowPosition({ left: 100, top: 100 }, SIZE, VIEWPORT, 16, -16)).toEqual({
      left: 116,
      top: 84,
    });

    const pushed = nudgeWindowPosition({ left: 100, top: 100 }, SIZE, VIEWPORT, -5000, 5000);
    expect(pushed.left).toBe(WINDOW_KEEP_VISIBLE_PX - SIZE.width);
    expect(pushed.top).toBe(VIEWPORT.height - WINDOW_KEEP_VISIBLE_PX);
  });
});
