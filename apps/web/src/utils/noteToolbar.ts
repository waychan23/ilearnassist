/**
 * Where a selection's floating toolbar goes.
 *
 * Pure and separate from the component for the same reason `utils/widgetTabs.ts` is: this is
 * arithmetic that can be wrong in a way no screenshot shows — a card one pixel over an edge only
 * shows at one window width — and a `.vue` file in this project is covered by Playwright rather
 * than by unit tests. The component measures and renders; this decides.
 *
 * Two decisions live here, and each is a boundary rather than a taste:
 *
 * - **The card hangs off the selection's bottom-right vertex**, not over the middle of its first
 *   line. Floating above the text put the card in the one band of the screen every other piece of
 *   chrome also occupies, and it covered the words it was offering to annotate.
 * - **The container's right edge, not the window's, is what it dodges.** The card belongs to the
 *   message list, and the space between that list and the window's edge is somebody else's.
 */

/** The card's own size, and the same numbers `.note-toolbar`'s CSS states. */
export const NOTE_TOOLBAR_WIDTH = 172;
export const NOTE_TOOLBAR_HEIGHT = 34;

/** How far the card floats from the selection, on whichever side of it it lands. */
export const NOTE_TOOLBAR_GAP = 8;

/** The least margin the card may keep from an edge it is dodging. */
export const NOTE_TOOLBAR_EDGE = 8;

export interface NoteToolbarAnchor {
  /** The selection's bottom-right vertex, in viewport coordinates. */
  right: number;
  bottom: number;
  /** The top of the selection's first line — where the card goes when the window ends first. */
  top: number;
  /** The right edge of the box the card must stay inside: the message list. */
  containerRight: number;
}

export interface NoteToolbarPosition {
  left: number;
  top: number;
}

export function noteToolbarPosition(
  anchor: NoteToolbarAnchor,
  viewport: { width: number; height: number }
): NoteToolbarPosition {
  // The edge the card's own right side must stay inside, less the margin. The message list's is
  // the one that matters — the space between it and the window belongs to whatever is beside the
  // list — and the window's is the backstop for a list wider than the window, where obeying the
  // list would be obeying something off-screen.
  const bound = Math.min(anchor.containerRight, viewport.width) - NOTE_TOOLBAR_EDGE;
  // Anchored at the vertex, then pushed left until the card is inside — and never past the
  // margin, which is the arm that holds when the list itself is narrower than the card.
  const left = Math.min(
    Math.max(NOTE_TOOLBAR_EDGE, anchor.right),
    Math.max(NOTE_TOOLBAR_EDGE, bound - NOTE_TOOLBAR_WIDTH)
  );

  const below = anchor.bottom + NOTE_TOOLBAR_GAP;
  // Below by preference: the card hangs off the selection's own end. Above only when the window
  // ends first, because a card half past the bottom edge is one nobody can press — the same
  // reasoning the vertical flip has always had, with the preference the other way round.
  const top =
    below + NOTE_TOOLBAR_HEIGHT <= viewport.height - NOTE_TOOLBAR_EDGE
      ? below
      : Math.max(NOTE_TOOLBAR_EDGE, anchor.top - NOTE_TOOLBAR_HEIGHT - NOTE_TOOLBAR_GAP);

  return { left, top };
}
