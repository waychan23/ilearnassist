import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clampWidth,
  usableMaxWidth,
  widgetPanel,
  WIDGET_ACTIVE_KEY,
  WIDGET_DEFAULT_WIDTH,
  WIDGET_MAX_WIDTH,
  WIDGET_MIN_WIDTH,
  WIDGET_ORIENTATION_KEY,
  WIDGET_WIDTH_KEY,
  WIDGET_RAIL_WIDTH,
} from "../../src/composables/widgetPanel.js";

/*
 * The panel's preferences. A module singleton whose values outlive a test, so each one starts from
 * cleared storage and reloads — the same discipline `test/composables/ui.test.ts` uses for
 * `uiState`.
 */

beforeEach(() => {
  localStorage.clear();
  widgetPanel.reload();
  widgetPanel.setCollapsed(false);
  widgetPanel.orientation.value = "horizontal";
});

afterEach(() => {
  localStorage.clear();
});

describe("the panel's width", () => {
  it("defaults to the standard width with nothing stored", () => {
    expect(widgetPanel.width.value).toBe(WIDGET_DEFAULT_WIDTH);
  });

  it("clamps a stored value into range on read", () => {
    // Clamped on *read* rather than only on write, because a value that was fine when it was set
    // is not necessarily fine now: it travels between windows, and a panel sized for a 1440px
    // screen would eat most of a 1024px one.
    localStorage.setItem(WIDGET_WIDTH_KEY, "9999");
    widgetPanel.reload();
    expect(widgetPanel.width.value).toBeLessThanOrEqual(WIDGET_MAX_WIDTH);

    localStorage.setItem(WIDGET_WIDTH_KEY, "1");
    widgetPanel.reload();
    expect(widgetPanel.width.value).toBe(WIDGET_MIN_WIDTH);
  });

  it("falls back to the default for a missing or unparseable value", () => {
    localStorage.setItem(WIDGET_WIDTH_KEY, "wide please");
    widgetPanel.reload();
    expect(widgetPanel.width.value).toBe(WIDGET_DEFAULT_WIDTH);

    // `Number(null)` is 0, which is not a width anybody chose — so absence has to be tested for
    // rather than compared against a range.
    localStorage.removeItem(WIDGET_WIDTH_KEY);
    widgetPanel.reload();
    expect(widgetPanel.width.value).toBe(WIDGET_DEFAULT_WIDTH);
  });

  it("persists a width that survives a re-read", () => {
    // Within the viewport's ceiling — jsdom reports a 1024px window, so a width above the range
    // would be clamped and this would be testing the clamp rather than the persistence.
    const wanted = Math.min(480, usableMaxWidth());
    widgetPanel.setWidth(wanted);
    widgetPanel.reload();
    expect(widgetPanel.width.value).toBe(wanted);
  });

  it("stops at the viewport's ceiling rather than the token's", () => {
    // The panel may never take the room the conversation needs, so on a narrow window the
    // bind is the window and not `WIDGET_MAX_WIDTH`.
    widgetPanel.setWidth(WIDGET_MAX_WIDTH);
    expect(widgetPanel.width.value).toBe(usableMaxWidth());
    expect(widgetPanel.width.value).toBeLessThanOrEqual(WIDGET_MAX_WIDTH);
  });

  it("steps by a delta, clamped", () => {
    widgetPanel.setWidth(WIDGET_MIN_WIDTH);
    widgetPanel.stepWidth(-100);
    expect(widgetPanel.width.value).toBe(WIDGET_MIN_WIDTH);

    widgetPanel.stepWidth(16);
    expect(widgetPanel.width.value).toBe(WIDGET_MIN_WIDTH + 16);
  });

  it("never paints wider than the viewport can hold", () => {
    // The ceiling is derived from the window as well as the token, so the *painted* value is
    // clamped even when the stored one is not — which is the case a smaller window creates.
    expect(clampWidth(WIDGET_MAX_WIDTH)).toBeLessThanOrEqual(usableMaxWidth());
    expect(usableMaxWidth()).toBeGreaterThanOrEqual(WIDGET_MIN_WIDTH);
  });
});

describe("the panel's layout", () => {
  it("starts horizontal", () => {
    expect(widgetPanel.orientation.value).toBe("horizontal");
  });

  it("toggles between the two positions and persists the choice", () => {
    widgetPanel.toggleOrientation();
    expect(widgetPanel.orientation.value).toBe("vertical");
    expect(localStorage.getItem(WIDGET_ORIENTATION_KEY)).toBe("vertical");

    widgetPanel.reload();
    expect(widgetPanel.orientation.value).toBe("vertical");

    widgetPanel.toggleOrientation();
    expect(widgetPanel.orientation.value).toBe("horizontal");
  });

  it("ignores a stored value that is neither position", () => {
    localStorage.setItem(WIDGET_ORIENTATION_KEY, "diagonal");
    widgetPanel.reload();
    expect(widgetPanel.orientation.value).toBe("horizontal");
  });
});

describe("the open widget", () => {
  it("remembers which one was open", () => {
    widgetPanel.setActive("session_stats");
    widgetPanel.reload();
    expect(widgetPanel.activeId.value).toBe("session_stats");
  });

  it("is null before anything has been opened", () => {
    expect(widgetPanel.activeId.value).toBeNull();
  });
});

describe("collapse", () => {
  it("is not persisted, unlike the other three", () => {
    // The one deliberate omission, matching `uiState.sidebarCollapsed`: a rail is what you narrow
    // the window for, and coming back to a panel you had hidden reads as a bug rather than a
    // restored preference. Asserted as an absent key rather than as a false value, because a
    // stored `false` would be a different (and equally wrong) design.
    widgetPanel.toggleCollapsed();
    expect(widgetPanel.collapsed.value).toBe(true);
    expect(localStorage.getItem(WIDGET_WIDTH_KEY)).toBeNull();
    expect(localStorage.getItem(WIDGET_ORIENTATION_KEY)).toBeNull();
    expect(localStorage.getItem(WIDGET_ACTIVE_KEY)).toBeNull();
    expect(Object.keys(localStorage)).toHaveLength(0);
  });

  it("paints the rail width instead of the set width", () => {
    const wanted = Math.min(480, usableMaxWidth());
    widgetPanel.setWidth(wanted);
    expect(widgetPanel.widthCss.value).toBe(`${wanted}px`);

    widgetPanel.toggleCollapsed();
    expect(widgetPanel.widthCss.value).toBe(`${WIDGET_RAIL_WIDTH}px`);

    // And the width is still remembered, so expanding restores what was chosen rather than the
    // default.
    widgetPanel.toggleCollapsed();
    expect(widgetPanel.widthCss.value).toBe(`${wanted}px`);
  });
});
