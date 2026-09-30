import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clampWidth,
  sidebarPanel,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_KEY,
} from "../../src/composables/sidebarPanel.js";

/*
 * The sidebar's width preference. A module singleton whose value outlives a test, so each one
 * starts from cleared storage and reloads — the same discipline
 * `test/composables/widgetPanel.test.ts` uses for its own singleton.
 */

beforeEach(() => {
  localStorage.clear();
  sidebarPanel.reload();
});

afterEach(() => {
  localStorage.clear();
});

describe("the sidebar's width", () => {
  it("defaults to the width the app has always opened at", () => {
    // The default is not an aesthetic choice: an untouched install must look exactly as it did
    // before the sidebar could be dragged, which is why this is the literal the track used to be.
    expect(sidebarPanel.width.value).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("clamps a stored value into range on read", () => {
    // Clamped on *read* rather than only on write, because the value travels between windows and
    // can outlive the range it was written in.
    localStorage.setItem(SIDEBAR_WIDTH_KEY, "9999");
    sidebarPanel.reload();
    expect(sidebarPanel.width.value).toBe(SIDEBAR_MAX_WIDTH);

    localStorage.setItem(SIDEBAR_WIDTH_KEY, "1");
    sidebarPanel.reload();
    expect(sidebarPanel.width.value).toBe(SIDEBAR_MIN_WIDTH);
  });

  it("falls back to the default for a missing or unparseable value", () => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, "wide please");
    sidebarPanel.reload();
    expect(sidebarPanel.width.value).toBe(SIDEBAR_DEFAULT_WIDTH);

    // `Number(null)` is 0, which is not a width anybody chose — so absence has to be tested for
    // rather than compared against a range.
    localStorage.removeItem(SIDEBAR_WIDTH_KEY);
    sidebarPanel.reload();
    expect(sidebarPanel.width.value).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("persists a width that survives a re-read", () => {
    const wanted = 360;
    sidebarPanel.setWidth(wanted);
    sidebarPanel.reload();
    expect(sidebarPanel.width.value).toBe(wanted);
  });

  it("steps by a delta, clamped", () => {
    sidebarPanel.setWidth(SIDEBAR_MIN_WIDTH);
    sidebarPanel.stepWidth(-100);
    expect(sidebarPanel.width.value).toBe(SIDEBAR_MIN_WIDTH);

    sidebarPanel.stepWidth(16);
    expect(sidebarPanel.width.value).toBe(SIDEBAR_MIN_WIDTH + 16);
  });

  it("paints the same clamped value the store holds, in px", () => {
    sidebarPanel.setWidth(SIDEBAR_MAX_WIDTH + 1000);
    expect(sidebarPanel.effectiveWidth.value).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarPanel.widthCss.value).toBe(`${SIDEBAR_MAX_WIDTH}px`);
  });

  it("rounds a fractional width rather than painting half a pixel", () => {
    expect(clampWidth(312.4)).toBe(312);
    expect(clampWidth(312.6)).toBe(313);
  });
});
