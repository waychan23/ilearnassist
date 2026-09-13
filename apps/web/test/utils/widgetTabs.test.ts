import { describe, expect, it } from "vitest";
import { fitWidgetTabs, type WidgetTabGroup } from "../../src/utils/widgetTabs.js";

/*
 * The tab strip's arithmetic, tested on its own because it is the part that can be wrong in a way
 * no screenshot shows — an off-by-one in the divider's cost only shows up at one width — and a
 * `.vue` file in this project is covered by Playwright rather than by unit tests.
 */

const ONE_PER_GROUP: WidgetTabGroup[] = [
  { scope: "workspace", ids: ["workspace_stats"] },
  { scope: "session", ids: ["session_stats"] },
];

/** Sizes for the two tabs above, one number each. */
const SIZES = [100, 80];

const base = { dividerSize: 10, moreSize: 30, gap: 4 };

describe("fitWidgetTabs", () => {
  it("shows everything when it all fits, with nothing in the menu", () => {
    const fit = fitWidgetTabs({ groups: ONE_PER_GROUP, sizes: SIZES, containerSize: 300, ...base });
    expect(fit).toEqual({
      visible: ["workspace_stats", "session_stats"],
      overflow: [],
      // The rule follows the last tab of the first group, because both sides have a tab.
      dividerAfter: "workspace_stats",
    });
  });

  it("counts the divider as a cost, so a fit that ignores it does not happen", () => {
    // 100 + 4 + 10 + 80 = 194. A container of 190 fits the tabs and not the rule, so one has to
    // go — and the point of the test is that this boundary exists at all.
    const fit = fitWidgetTabs({ groups: ONE_PER_GROUP, sizes: SIZES, containerSize: 190, ...base });
    expect(fit.visible.length).toBeLessThan(2);
  });

  it("moves the tail into the menu, keeping the order", () => {
    // 100 + 4 + 10 + 80 = 194, and with the menu the budget is 300 - 30 - 4 = 266. Everything
    // still fits at 300, so this container is the one that forces a choice.
    const fit = fitWidgetTabs({ groups: ONE_PER_GROUP, sizes: SIZES, containerSize: 150, ...base });
    expect(fit.visible).toEqual(["workspace_stats"]);
    expect(fit.overflow).toEqual(["session_stats"]);
  });

  it("draws no divider when one side of it is in the menu", () => {
    // A rule between the last visible tab and the "more" button would be separating a tab from a
    // control, which is a claim about grouping that is no longer on screen.
    const fit = fitWidgetTabs({ groups: ONE_PER_GROUP, sizes: SIZES, containerSize: 150, ...base });
    expect(fit.dividerAfter).toBeNull();
  });

  it("draws the divider when both sides have a visible tab", () => {
    const fit = fitWidgetTabs({ groups: ONE_PER_GROUP, sizes: SIZES, containerSize: 250, ...base });
    expect(fit.visible).toEqual(["workspace_stats", "session_stats"]);
    expect(fit.dividerAfter).toBe("workspace_stats");
  });

  it("puts everything in the menu when there is no room at all", () => {
    // The state before the first measurement, and a zero-width strip. Everything overflowing is
    // the honest answer; the alternative is a crash or a tab rendered outside its container.
    const fit = fitWidgetTabs({ groups: ONE_PER_GROUP, sizes: SIZES, containerSize: 0, ...base });
    expect(fit.visible).toEqual([]);
    expect(fit.overflow).toEqual(["workspace_stats", "session_stats"]);
    expect(fit.dividerAfter).toBeNull();
  });

  it("never reports the same tab twice or loses one", () => {
    // The invariant the strip depends on: every tab is in exactly one of the two lists.
    for (const containerSize of [0, 50, 100, 150, 194, 300]) {
      const fit = fitWidgetTabs({ groups: ONE_PER_GROUP, sizes: SIZES, containerSize, ...base });
      expect([...fit.visible, ...fit.overflow].sort()).toEqual([
        "session_stats",
        "workspace_stats",
      ]);
    }
  });

  it("handles one group, which is the common case", () => {
    // A workspace widget installed and nothing at session level: no boundary, so no divider.
    const groups: WidgetTabGroup[] = [{ scope: "workspace", ids: ["workspace_stats"] }];
    const fit = fitWidgetTabs({ groups, sizes: [100], containerSize: 300, ...base });
    expect(fit).toEqual({ visible: ["workspace_stats"], overflow: [], dividerAfter: null });
  });

  it("is empty for no groups at all", () => {
    // What the panel passes when nothing is installed — it does not render in that case, but the
    // arithmetic should not be the thing that decides.
    const fit = fitWidgetTabs({ groups: [], sizes: [], containerSize: 300, ...base });
    expect(fit).toEqual({ visible: [], overflow: [], dividerAfter: null });
  });

  it("keeps an oversized first tab out of the strip rather than in the menu alone", () => {
    // A tab wider than the whole budget cannot be shown at all, so the menu holds everything —
    // including the tab whose own group the divider would have followed.
    const fit = fitWidgetTabs({ groups: ONE_PER_GROUP, sizes: [400, 80], containerSize: 200, ...base });
    expect(fit.visible).toEqual([]);
    expect(fit.overflow).toEqual(["workspace_stats", "session_stats"]);
  });
});
