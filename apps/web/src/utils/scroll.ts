/**
 * The arithmetic behind "stay at the bottom" — split out from the composable that owns the
 * listeners so the decision can be tested without a DOM.
 *
 * Nothing here reads or writes an element. It takes the three numbers a scroller reports and
 * answers a question about them, which is the whole of the logic that decides whether a
 * streaming reply keeps the viewport or lets go of it.
 */

/**
 * How far from the end still counts as being at the end.
 *
 * Not zero, for three reasons that all show up in practice. `scrollTop` is fractional on a
 * display with a non-integer device-pixel ratio, so a viewport parked as far down as it will
 * go reports a fraction of a pixel of travel left rather than none. A wheel or trackpad tick
 * that lands a pixel or two short of the end would otherwise be read as "the reader has taken
 * over", and the follow would stay released for the rest of the turn over a gesture that
 * meant "keep going". And it is what makes a follow survive its own scroll event: the browser
 * reports the position it was given, which is the bottom, but only within rounding.
 *
 * Deliberately small. This is a tolerance for the end of the list, not a threshold for
 * "near enough" — a value loose enough to swallow a wheel notch is a value that re-grabs the
 * viewport from a reader who is on their way somewhere.
 */
export const BOTTOM_SLACK_PX = 24;

/** The three numbers a scroller reports, as `Element` exposes them. */
export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * How much content sits below the viewport.
 *
 * Negative once the element stops overflowing — a short conversation scrolled to its end has
 * no content below the fold, and neither does one that fits entirely — which is why this is
 * compared with a ceiling rather than to zero.
 */
export function distanceFromBottom(m: ScrollMetrics): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

/** Whether the viewport is close enough to the end to count as following it. */
export function isAtBottom(m: ScrollMetrics, slack = BOTTOM_SLACK_PX): boolean {
  return distanceFromBottom(m) <= slack;
}
