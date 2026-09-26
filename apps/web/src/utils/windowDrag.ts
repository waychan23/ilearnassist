/**
 * The arithmetic behind moving a window, with no DOM in it — `utils/widgetTabs.ts`'s split, and
 * for its reason: the interesting part is the clamping, and a function that measures the viewport
 * itself can only be tested in a browser.
 */

/** Where a window's top-left corner sits, in viewport coordinates. */
export interface WindowBox {
  left: number;
  top: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

/**
 * How much of a window must stay on screen, in pixels — in the directions where a *margin* is the
 * answer.
 *
 * **What has to stay reachable is the header**, and that single fact is why the two axes are not
 * clamped the same way. The header spans the window's whole width, so keeping this much of it
 * visible horizontally is a matter of keeping this much of the window visible. Vertically the
 * header is only the top band of the box: a bound of "keep this much of the window on screen"
 * would be satisfied by the window's *bottom*, which is exactly the state where the title bar has
 * gone off the top and the window can no longer be dragged back. So the top edge is held at the
 * viewport's own top instead — the browser-window behaviour, and for the same reason.
 */
export const WINDOW_KEEP_VISIBLE_PX = 64;

/** How far an arrow key moves a focused window. */
export const WINDOW_NUDGE_PX = 16;

function clampTo(value: number, min: number, max: number, fallback: number): number {
  // A viewport too small to hold the margins at all — the two bounds cross and no position
  // satisfies both. Centring is the answer that is wrong in no direction; picking one of the two
  // bounds would pin the window to an edge of a screen that cannot hold it.
  if (min > max) return Math.round(fallback);
  return Math.min(Math.max(value, min), max);
}

/**
 * Bring a position back inside the viewport, keeping the header on screen.
 *
 * Applied on every move, and again on the way *out* of storage: a window dragged on a wide monitor
 * and remembered would otherwise reopen off the edge of a laptop screen. Both callers have the
 * same question, which is why this is one function.
 */
export function clampWindowPosition(
  position: WindowBox,
  size: WindowSize,
  viewport: WindowSize
): WindowBox {
  return {
    left: Math.round(
      clampTo(
        position.left,
        WINDOW_KEEP_VISIBLE_PX - size.width,
        viewport.width - WINDOW_KEEP_VISIBLE_PX,
        (viewport.width - size.width) / 2
      )
    ),
    top: Math.round(
      clampTo(
        position.top,
        // Never above the viewport's top edge: the header lives there, and it is the one part of
        // the window that cannot be allowed off screen.
        0,
        viewport.height - WINDOW_KEEP_VISIBLE_PX,
        (viewport.height - size.height) / 2
      )
    ),
  };
}

/** Move one axis of a position, clamped like any other move. Used by the keyboard nudge. */
export function nudgeWindowPosition(
  position: WindowBox,
  size: WindowSize,
  viewport: WindowSize,
  dx: number,
  dy: number
): WindowBox {
  return clampWindowPosition(
    { left: position.left + dx, top: position.top + dy },
    size,
    viewport
  );
}
