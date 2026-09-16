import { expect, test } from "./fixtures";
import { enterWorkspace, leaveWorkspace } from "./workspaces";
import { scriptLlm } from "./llm";

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
  // The way out goes with it — and it is still the way out, since the chat header's back arrow
  // is gone and this row is where the workspace list is reached. A rail is the toggle and
  // nothing else, which is what keeps it from becoming a second, cramped copy of the sidebar.
  await expect(page.getByTestId("all-workspaces")).toBeHidden();
  await expect(page.getByTestId("workspace-name")).toBeHidden();
  // The account's menu too, whole. It used to be hidden a row at a time and three of its five
  // rows were never on that list, so the rail showed clipped icons between its toggle and the
  // bottom of the column.
  await expect(page.getByTestId("open-copilots")).toBeHidden();
  await expect(page.getByTestId("sign-out")).toBeHidden();

  // And the control that collapsed it is still on screen to undo it — the whole reason the
  // sidebar narrows rather than disappearing the way the drawer does.
  await expect(toggle).toBeVisible();
  await toggle.click();

  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(OPEN_WIDTH, 0);
  await expect(page.getByTestId("session-list")).toBeVisible();
  await expect(page.getByTestId("workspace-name")).toBeVisible();
});

test("the foot of the sidebar is the account's menu, and no longer the workspaces root", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await enterWorkspace(page);

  // Both groups, together: this sidebar's own content is what belongs at the top, so there is no
  // second end for them to spread to here — the split is the home page's rail.
  await expect(page.getByTestId("menu-group-app")).toBeVisible();
  await expect(page.getByTestId("menu-group-account")).toBeVisible();
  // The workspace's own settings, which only a page inside a workspace can name.
  await expect(page.getByTestId("open-workspace-settings")).toBeVisible();

  const config = (await (await request.get("/api/config")).json()) as {
    workspacesRootDir: string;
  };
  await expect(page.getByTestId("sidebar")).not.toContainText(config.workspacesRootDir);
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

test("a rail is the only way out of itself, and the home page never inherits it", async ({
  page,
}) => {
  /*
   * This used to be "a rail survives leaving the workspace and coming back", driven through the
   * chat header's back arrow — the one control that was still reachable at 52px. That arrow is
   * gone (the workspace list is reached from the rail that names the workspace you are in), so
   * the trip cannot be *made* while collapsed: expanding is both the way back and the way out.
   * What replaces it is the two claims the old sequence was carrying, each proved where it still
   * holds — that a rail is not a dead end, and that its grid track is the chat view's alone.
   *
   * The *grid* is why either half is worth a browser run: `ui.test.ts` covers the derivation of
   * `sidebarRail`, and `App.vue` picking the track is what a component test cannot see.
   */
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("sidebar-toggle").click();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(RAIL_WIDTH, 0);
  await expect(page.getByTestId("all-workspaces")).toBeHidden();

  // The way out, from the rail: the toggle, and then the sidebar it widens back into.
  await page.getByTestId("sidebar-toggle").click();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(OPEN_WIDTH, 0);
  await expect(page.getByTestId("all-workspaces")).toBeVisible();
  await leaveWorkspace(page);

  // Widened for the trip, and the home page has a rail of its own rather than this one — the
  // chat's sidebar is not mounted on it at all, which is the term that keeps a 52px track from
  // narrowing a page whose whole layout is a column of workspace cards.
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
  await expect(page.locator(".home-rail")).toBeVisible();

  // The toggle still works where it left off, and the flag did not come back collapsed on the
  // way in: entering a workspace is navigation, not a reset.
  await enterWorkspace(page);
  await expect(page.getByTestId("sidebar-toggle")).toBeVisible();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(OPEN_WIDTH, 0);
  await page.getByTestId("sidebar-toggle").click();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(RAIL_WIDTH, 0);
});

test("a row's settings button opens the parameters for that conversation", async ({
  page,
  request,
}) => {
  /*
   * The row's third control, and the one thing about it a unit test cannot reach: it *selects*
   * before it opens. The dialog reads whichever conversation is on screen, so a row that opened
   * it without switching would show the parameters of the conversation the user just left —
   * which is the failure this asserts against, by acting on a row that is not the active one.
   */
  await scriptLlm(request, { title: "第二个", turns: [{ content: "好的。" }] });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("第二个问题");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("session-title")).toHaveText("第二个");

  // A second conversation, named by hand so the two rows are tellable apart — and it becomes
  // the active one, so the row this test presses is the one that is *not* on screen.
  await page.getByTestId("new-session").click();
  await page.getByTestId("session-title-input").fill("别的东西");
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("session-title")).toHaveText("别的东西");

  const row = page.getByTestId("session-item").filter({ hasText: "第二个" });
  await row.getByTestId("session-row-settings").click();

  // The dialog is up, and it is about the row that was pressed — not the conversation that was
  // on screen when the click happened.
  await expect(page.getByTestId("session-name")).toHaveValue("第二个");
  await expect(page.getByTestId("session-title")).toHaveText("第二个");
});
