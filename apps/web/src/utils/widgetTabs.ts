import type { WidgetId, WidgetScope } from "@ilearnassist/shared";

/**
 * Which tabs fit in the strip, and which go into the "more" menu.
 *
 * Pure and separate from the component for the same reason `utils/minimap.ts` and
 * `utils/fileTree.ts` are: this is arithmetic that can be wrong in a way no screenshot shows —
 * an off-by-one in the divider's cost only shows up at one window width — and a `.vue` file in
 * this project is covered by Playwright rather than by unit tests. The component measures and
 * renders; this decides.
 *
 * The divider is a real cost, not decoration. It is counted only when the prefix being measured
 * actually contains both groups, which is what makes the fit depend on where the boundary falls
 * rather than on the tab count alone.
 */

export interface WidgetTabGroup {
  scope: WidgetScope;
  ids: readonly WidgetId[];
}

export interface WidgetTabFit {
  /** In display order: the first group's tabs, then the second's. */
  visible: WidgetId[];
  /** The rest, in the same order — what the "more" menu lists. Empty when everything fits. */
  overflow: WidgetId[];
  /**
   * The tab the group divider follows, or `null` when it should not be drawn.
   *
   * Only between two groups that both have a *visible* tab: a divider whose right-hand side is
   * hidden inside the "more" menu would be a rule separating a tab from a button. When the whole
   * second group overflows, the menu's own label carries that information instead.
   */
  dividerAfter: WidgetId | null;
}

interface PlacedTab {
  id: WidgetId;
  group: number;
}

/**
 * @param groups The groups to show, already filtered to the non-empty ones — an empty group is
 *   not a group, and counting its divider is how a strip comes out with two rules and one tab.
 * @param sizes Measured px per tab, in the flattened order of `groups`.
 * @param containerSize The strip's own size along its axis (width when horizontal, height when
 *   vertical).
 * @param moreSize The measured size of the "more" button, which is only spent when it is needed.
 * @param gap The gap between adjacent items, as the CSS uses it.
 */
export function fitWidgetTabs(input: {
  groups: readonly WidgetTabGroup[];
  sizes: readonly number[];
  containerSize: number;
  dividerSize: number;
  moreSize: number;
  gap: number;
}): WidgetTabFit {
  const { sizes, containerSize, dividerSize, moreSize, gap } = input;

  const tabs: PlacedTab[] = input.groups.flatMap((group, index) =>
    group.ids.map((id) => ({ id, group: index }))
  );
  if (tabs.length === 0) return { visible: [], overflow: [], dividerAfter: null };

  // The index at which each group starts, so "does this prefix cross a boundary" is a lookup
  // rather than a scan.
  const groupStarts: number[] = [];
  let offset = 0;
  for (const group of input.groups) {
    groupStarts.push(offset);
    offset += group.ids.length;
  }

  /** The width of the first `count` tabs, dividers included. */
  const cost = (count: number): number => {
    let total = 0;
    for (let i = 0; i < count; i++) total += sizes[i] ?? 0;
    if (count > 1) total += gap * (count - 1);
    // A boundary sits inside the prefix when some tab of the later group is in it — which, since
    // tabs are grouped, means the later group's first tab is.
    for (const start of groupStarts) {
      if (start > 0 && start < count) total += dividerSize;
    }
    return total;
  };

  const dividerBetween = (visibleCount: number): WidgetId | null => {
    // The last group that has a visible tab, and whether any *later* group does — which is the
    // condition for a rule at that boundary rather than at the end of the strip.
    for (let g = 0; g < input.groups.length - 1; g++) {
      const end = groupStarts[g + 1]!;
      const laterVisible = end < visibleCount;
      if (laterVisible && end > 0) return tabs[end - 1]!.id;
    }
    return null;
  };

  if (cost(tabs.length) <= containerSize) {
    const visible = tabs.map((t) => t.id);
    return { visible, overflow: [], dividerAfter: dividerBetween(visible.length) };
  }

  // Something has to go, so the "more" button is now certain and its cost is spent before any
  // tab is placed. The last tab always overflows in this branch — `cost(n) > containerSize`
  // and the budget is smaller than that — so the search runs below `tabs.length`.
  const budget = containerSize - moreSize - gap;
  let keep = 0;
  for (let count = 1; count < tabs.length; count++) {
    if (cost(count) <= budget) keep = count;
    // Past the point where it stops fitting it cannot start again: every added tab costs at
    // least its own width. Stopping here keeps a zero-sized measurement from walking the rest.
    else break;
  }

  return {
    visible: tabs.slice(0, keep).map((t) => t.id),
    overflow: tabs.slice(keep).map((t) => t.id),
    dividerAfter: dividerBetween(keep),
  };
}
