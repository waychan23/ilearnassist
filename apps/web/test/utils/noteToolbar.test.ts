import { describe, expect, it } from "vitest";
import {
  NOTE_TOOLBAR_EDGE,
  NOTE_TOOLBAR_GAP,
  NOTE_TOOLBAR_HEIGHT,
  NOTE_TOOLBAR_WIDTH,
  noteToolbarPosition,
  type NoteToolbarAnchor,
} from "../../src/utils/noteToolbar.js";

/*
 * The selection toolbar's arithmetic, tested on its own because it is the part that can be wrong
 * in a way no screenshot shows — a card one pixel over an edge only shows at one window width —
 * and a `.vue` file in this project is covered by Playwright rather than by unit tests.
 */

/** A roomy window, a wide message list, and a selection well inside both. */
const WINDOW = { width: 1400, height: 900 };
const anchor = (overrides: Partial<NoteToolbarAnchor> = {}): NoteToolbarAnchor => ({
  right: 600,
  bottom: 320,
  top: 300,
  containerRight: 1200,
  ...overrides,
});

describe("noteToolbarPosition", () => {
  it("hangs off the selection's bottom-right vertex", () => {
    const position = noteToolbarPosition(anchor(), WINDOW);
    // The left edge is the vertex itself, not the vertex less half a card: the card is anchored
    // by its top-left corner, which is the whole point of the change.
    expect(position.left).toBe(600);
    expect(position.top).toBe(320 + NOTE_TOOLBAR_GAP);
  });

  it("dodges left of the message list's right edge", () => {
    const position = noteToolbarPosition(anchor({ right: 1190 }), WINDOW);
    expect(position.left).toBe(1200 - NOTE_TOOLBAR_EDGE - NOTE_TOOLBAR_WIDTH);
    // Same height: the avoidance is horizontal only, so a card pushed left is not also moved up.
    expect(position.top).toBe(320 + NOTE_TOOLBAR_GAP);
  });

  it("leaves the card where it is when the list's edge is far away", () => {
    const position = noteToolbarPosition(anchor({ right: 400 }), WINDOW);
    expect(position.left).toBe(400);
  });

  it("takes the list's edge over the window's, and the window's when it is the nearer one", () => {
    // A container wider than the window cannot push the card off-screen — this is the one case
    // where the window's margin is the binding side.
    const wide = noteToolbarPosition(
      anchor({ right: 1000, containerRight: 2000 }),
      { width: 1000, height: 900 }
    );
    expect(wide.left).toBe(1000 - NOTE_TOOLBAR_EDGE - NOTE_TOOLBAR_WIDTH);
    // And the container's edge is what the card obeys when it is the nearer of the two.
    const narrow = noteToolbarPosition(anchor({ right: 1000, containerRight: 800 }), WINDOW);
    expect(narrow.left).toBe(800 - NOTE_TOOLBAR_EDGE - NOTE_TOOLBAR_WIDTH);
  });

  it("flips above the selection when the window ends before the card does", () => {
    const position = noteToolbarPosition(
      anchor({ bottom: 880, top: 860 }),
      { width: 1400, height: 900 }
    );
    expect(position.top).toBe(860 - NOTE_TOOLBAR_HEIGHT - NOTE_TOOLBAR_GAP);
    // Still the vertex horizontally: the flip is vertical only.
    expect(position.left).toBe(600);
  });

  it("stays below when it only just fits", () => {
    // The boundary itself, which a flip written with `<` instead of `<=` gets wrong: the card's
    // bottom lands exactly on the margin.
    const bottom = 900 - NOTE_TOOLBAR_EDGE - NOTE_TOOLBAR_GAP - NOTE_TOOLBAR_HEIGHT;
    const position = noteToolbarPosition(anchor({ bottom }), { width: 1400, height: 900 });
    expect(position.top).toBe(bottom + NOTE_TOOLBAR_GAP);
  });

  it("keeps the margin when the message list is narrower than the card", () => {
    // Left unchecked this is the arm that goes negative and puts the card off the left edge.
    const position = noteToolbarPosition(anchor({ right: 60, containerRight: 100 }), {
      width: 100,
      height: 900,
    });
    expect(position.left).toBe(NOTE_TOOLBAR_EDGE);
  });

  it("never exceeds the list's right edge, whatever the selection does", () => {
    // The property rather than the cases: every position the arithmetic can return is inside the
    // container, however the selection is dragged.
    for (let right = 0; right <= 1400; right += 7) {
      const position = noteToolbarPosition(anchor({ right }), WINDOW);
      expect(position.left + NOTE_TOOLBAR_WIDTH).toBeLessThanOrEqual(1200 - NOTE_TOOLBAR_EDGE);
    }
  });
});
