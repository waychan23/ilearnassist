import { expect, test } from "./fixtures";
import { enterWorkspace } from "./workspaces";

/**
 * The sidebar's rail, at desktop width.
 *
 * The drawer is the same control's other half and lives in `mobile.spec.ts`: there the
 * sidebar leaves the layout and slides over the pane, here it stays in it and narrows to its
 * toggle. One button, two viewports, and the difference is the viewport's — so the two are
 * tested where each of them is true rather than in one spec that resizes.
 *
 * What is asserted is what only a browser can answer: whether the grid track actually moved,
 * and whether the control that moved it is still reachable once it has. `style.test.ts`
 * holds the sheet to its tokens and `composables/ui.test.ts` to the state transitions.
 */

/** The collapsed sidebar's width, in line with the `272px` the sheet spells out open. */
const RAIL_WIDTH = 52;
const OPEN_WIDTH = 272;

/** The sidebar's rendered width. Retried by the caller: the class lands a tick after click. */
async function sidebarWidth(page: import("@playwright/test").Page): Promise<number> {
  const box = await page.getByTestId("sidebar").boundingBox();
  return box?.width ?? 0;
}

test("the header toggle narrows the sidebar to a rail, and back again", async ({ page }) => {
  await page.goto("/");
  await enterWorkspace(page);

  const toggle = page.getByTestId("sidebar-toggle");

  expect(await sidebarWidth(page)).toBeCloseTo(OPEN_WIDTH, 0);
  await expect(page.getByTestId("session-list")).toBeVisible();

  await toggle.click();

  // The *width*, not the class. The class is what this change added, so a rail that renders
  // at 272px while carrying `collapsed` would satisfy a check on the class and fail at the
  // only thing the user sees.
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(RAIL_WIDTH, 0);
  await expect(page.getByTestId("session-list")).toBeHidden();
  // The way out goes with it. A rail is the toggle and nothing else, which is what keeps it
  // from becoming a second, cramped copy of the sidebar.
  await expect(page.getByTestId("all-workspaces")).toBeHidden();
  await expect(page.getByTestId("workspace-name")).toBeHidden();

  // And the control that collapsed it is still on screen to undo it — the whole reason the
  // sidebar narrows rather than disappearing the way the drawer does.
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(OPEN_WIDTH, 0);
  await expect(page.getByTestId("session-list")).toBeVisible();
  await expect(page.getByTestId("workspace-name")).toBeVisible();
});

test("the toggle is named for the direction it goes", async ({ page }) => {
  // The label is the whole affordance for a mark that does not move: one `panel-left` in
  // both states, so the tooltip is what says which way the click goes. Nothing else on
  // screen carries that, which is why it is pinned rather than assumed.
  await page.goto("/");
  await enterWorkspace(page);

  const toggle = page.getByTestId("sidebar-toggle");
  await expect(toggle).toHaveAttribute("aria-label", "收起侧边栏");

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-label", "展开侧边栏");
});

test("a rail survives leaving the workspace and coming back", async ({ page }) => {
  // The flag is about the pane rather than about the visit, so re-entering the same
  // workspace must not silently widen what was narrowed. The *grid* is what makes this
  // worth a browser run: `App.vue` picks the track, and the home page in between must not
  // inherit it — the rail class is false outside the chat view, which is the half that
  // `ui.test.ts` covers and this one proves end to end.
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("sidebar-toggle").click();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(RAIL_WIDTH, 0);

  await page.getByTestId("back-to-workspaces").click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  await enterWorkspace(page);
  await expect(page.getByTestId("sidebar-toggle")).toBeVisible();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(RAIL_WIDTH, 0);
  // Still usable, not merely narrow: the toggle is the only control left, so a rail with
  // nothing clickable in it would be a dead end.
  await page.getByTestId("sidebar-toggle").click();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(OPEN_WIDTH, 0);
});
