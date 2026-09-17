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

/** The card's own height, and the same number `.note-toolbar`'s CSS states. */
export const NOTE_TOOLBAR_HEIGHT = 34;

/**
 * One button's width, in the strip the toolbar is built from.
 *
 * The **width is derived** rather than stated, and it has to be, because the number of buttons is
 * not fixed: the toolbar is a host control that widgets contribute to, so a constant width would
 * be wrong the moment a second widget offered an action. The module is therefore the one source
 * and the component reads it back — where before the number lived here *and* in a CSS rule, with a
 * comment asking the next person to change both.
 */
export const NOTE_TOOLBAR_BUTTON_WIDTH = 80;

/** The strip's own padding and the gap between its buttons, both from the stylesheet. */
const NOTE_TOOLBAR_PADDING = 4;
const NOTE_TOOLBAR_BUTTON_GAP = 4;

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

export interface NoteToolbarSize {
  width: number;
  height: number;
}

/**
 * How big the strip is for a given number of actions — what the component sets inline and what
 * the placement below reserves room for.
 *
 * Exported so the two cannot disagree: a card laid out at one width and dodging edges at another
 * is a card half over the edge it was meant to clear, which is exactly the failure this module
 * exists to make impossible to see only at one window width.
 */
export function toolbarSize(actionCount: number): NoteToolbarSize {
  const count = Math.max(1, actionCount);
  return {
    width:
      count * NOTE_TOOLBAR_BUTTON_WIDTH +
      (count - 1) * NOTE_TOOLBAR_BUTTON_GAP +
      NOTE_TOOLBAR_PADDING * 2,
    height: NOTE_TOOLBAR_HEIGHT,
  };
}

export function noteToolbarPosition(
  anchor: NoteToolbarAnchor,
  viewport: { width: number; height: number },
  size: NoteToolbarSize = toolbarSize(2)
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
    Math.max(NOTE_TOOLBAR_EDGE, bound - size.width)
  );

  const below = anchor.bottom + NOTE_TOOLBAR_GAP;
  // Below by preference: the card hangs off the selection's own end. Above only when the window
  // ends first, because a card half past the bottom edge is one nobody can press — the same
  // reasoning the vertical flip has always had, with the preference the other way round.
  const top =
    below + size.height <= viewport.height - NOTE_TOOLBAR_EDGE
      ? below
      : Math.max(NOTE_TOOLBAR_EDGE, anchor.top - size.height - NOTE_TOOLBAR_GAP);

  return { left, top };
}
