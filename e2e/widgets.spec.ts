import { expect, test, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace, leaveWorkspace } from "./workspaces";

/**
 * The right sidebar: installing widgets, the strip that draws them, and the two demo panels
 * reading live numbers out of the database.
 *
 * **Almost every flow here installs first**, and that is not incidental. Nothing is installed by
 * default — the panel is opt-in, and the create dialog is where the choice is presented — so the
 * install path is a precondition for every other assertion rather than a case of its own. The one
 * test that *does* start from nothing is the one about the panel being absent.
 */

/**
 * Create a workspace through the dialog, ticking the given widgets, and answer its id.
 *
 * Through the UI rather than the API on purpose: the tick boxes are the thing being tested on the
 * way in, and a spec that seeded the install over HTTP would leave the dialog's own wiring
 * unexercised for every flow below.
 *
 * The id is read back **off the card it just made**, and matched by name rather than taken from
 * the first card in the list: the suite's own earlier tests leave workspaces behind, and the
 * first card is the oldest of them. Reading the wrong one installs a widget somewhere the test
 * never looks.
 */
async function createWorkspaceWith(
  page: Page,
  name: string,
  widgets: string[] = [],
): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByTestId("workspace-new").click();

  await page.getByTestId("workspace-name-input").fill(name);
  for (const id of widgets) {
    await page.getByTestId(`workspace-widget-check-${id}`).check();
  }
  await page.getByTestId("workspace-create-submit").click();

  const card = page.getByTestId("workspace-card").filter({ hasText: name });
  await expect(card).toBeVisible();
  const id = await card.getAttribute("data-workspace-id");
  expect(id, "the new card should carry its workspace id").toBeTruthy();
  return id!;
}

/**
 * Install one widget into a workspace that already exists, from the card's gear.
 *
 * Also the only coverage of the gear itself, which is the entry point that does not require
 * entering the workspace first — the reason anyone can install a widget *before* there is a panel
 * to see it in.
 */
async function installFromCard(page: Page, workspaceId: string, widgetId: string): Promise<void> {
  await page.goto("/");
  await page
    .locator(`[data-workspace-id="${workspaceId}"]`)
    .getByTestId("workspace-settings-open")
    .click();
  await page.getByTestId(`workspace-widget-toggle-${widgetId}`).click();
  // The button's label is the *action*, so "uninstall" is what says it is now installed.
  await expect(page.getByTestId(`workspace-widget-toggle-${widgetId}`)).toHaveText("卸载");
  await page.getByTestId("workspace-settings-done").click();
}

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

test.describe("the widget panel", () => {
  test("is absent until something is installed, and appears when the first widget is", async ({
    page,
  }) => {
    const name = unique("Empty");
    const id = await createWorkspaceWith(page, name);

    await enterWorkspace(page, name);
    // The rule the whole feature is built on: a panel nobody installed anything into is not a
    // panel with an empty state, it is not there at all.
    await expect(page.getByTestId("widget-panel")).toHaveCount(0);

    await leaveWorkspace(page);
    await installFromCard(page, id, "workspace_stats");

    await enterWorkspace(page, name);
    await expect(page.getByTestId("widget-panel")).toBeVisible();
    await expect(page.getByTestId("widget-tab-workspace_stats")).toBeVisible();
  });

  test("is a third column beside the conversation, not an overlay over it", async ({ page }) => {
    const name = unique("Column");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);

    const panel = page.getByTestId("widget-panel");
    await expect(panel).toBeVisible();

    const panelBox = (await panel.boundingBox())!;
    const messagesBox = (await page.getByTestId("messages").boundingBox())!;
    // Side by side: the panel starts where the conversation's column ends. An overlay would have
    // the same origin and a positive overlap.
    expect(panelBox.x).toBeGreaterThanOrEqual(messagesBox.x + messagesBox.width - 1);

    // And the grid really has three tracks — a panel laid out in an implicit second *row* would
    // leave the message list's height collapsed, which this pins from the other side.
    expect(panelBox.height).toBeGreaterThan(400);
  });

  test("installs and uninstalls from the workspace settings, repeatedly", async ({ page }) => {
    const name = unique("Toggle");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);
    await expect(page.getByTestId("widget-tab-workspace_stats")).toBeVisible();

    // The strip is a UI element in a page that never reloads during this test, and the settings
    // dialog is opened from the sidebar's own workspace name.
    await page.getByTestId("workspace-settings-open").click();
    const toggle = page.getByTestId("workspace-widget-toggle-workspace_stats");
    await expect(toggle).toHaveText("卸载");

    await toggle.click();
    await expect(toggle).toHaveText("安装");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("workspace-settings-done").click();
    // The tab is gone from the strip while the panel itself stays: it is still installed for
    // nothing, so the panel goes too — but that is asserted below rather than here.
    await expect(page.getByTestId("widget-tab-workspace_stats")).toHaveCount(0);
    await expect(page.getByTestId("widget-panel")).toHaveCount(0);

    // Back on again, which is the "repeated install/uninstall of the same object" requirement.
    await page.getByTestId("workspace-settings-open").click();
    await toggle.click();
    await expect(toggle).toHaveText("卸载");
    await page.getByTestId("workspace-settings-done").click();
    await expect(page.getByTestId("widget-tab-workspace_stats")).toBeVisible();

    // And the record is a record: a reload shows the same state rather than a fresh default.
    await page.reload();
    await enterWorkspace(page, name);
    await expect(page.getByTestId("widget-tab-workspace_stats")).toBeVisible();
  });

  test("groups the two levels with a divider, workspace first", async ({ page, request }) => {
    const name = unique("Groups");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);

    // The session widget has to come from the session parameters dialog, which needs a session.
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-session_stats").check();
    await page.getByTestId("create-session").click();

    // Both tabs, in the order the levels are declared — which is the order of the strip.
    await expect(page.getByTestId("widget-tab-workspace_stats")).toBeVisible();
    await expect(page.getByTestId("widget-tab-session_stats")).toBeVisible();
    await expect(page.getByTestId("widget-tabs-divider")).toBeVisible();

    const tabs = await page.locator(".widget-tab").all();
    expect(await tabs[0]!.textContent()).toContain("工作区统计");
    expect(await tabs[1]!.textContent()).toContain("会话统计");

    // The divider sits between them rather than at either end.
    const divider = (await page.getByTestId("widget-tabs-divider").boundingBox())!;
    const first = (await page.getByTestId("widget-tab-workspace_stats").boundingBox())!;
    const second = (await page.getByTestId("widget-tab-session_stats").boundingBox())!;
    expect(divider.x).toBeGreaterThan(first.x + first.width - 1);
    expect(divider.x + divider.width).toBeLessThanOrEqual(second.x + 1);

    void request;
  });

  test("switches the open widget and remembers the choice", async ({ page }) => {
    const name = unique("Switch");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-session_stats").check();
    await page.getByTestId("create-session").click();

    await page.getByTestId("widget-tab-session_stats").click();
    await expect(page.getByTestId("widget-session-stats")).toBeVisible();
    await expect(page.getByTestId("widget-workspace-stats")).toHaveCount(0);

    /*
     * Remembered across a reload, so the panel comes back to the tab that was open — and the
     * session has to be reopened first, because a conversation's own installs cannot be known
     * until one is. That is the design rather than a gap: the strip belongs to whatever is on
     * screen, and with no conversation open there is nothing for a session widget to show.
     */
    await page.reload();
    await enterWorkspace(page, name);
    await expect(page.getByTestId("widget-tab-session_stats")).toHaveCount(0);

    await page.getByTestId("session-item").first().click();
    await expect(page.getByTestId("widget-session-stats")).toBeVisible();
  });

  test("uninstalling the open widget falls back rather than emptying the body", async ({
    page,
  }) => {
    const name = unique("Fallback");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-session_stats").check();
    await page.getByTestId("create-session").click();

    // Open the session widget, then uninstall it from session parameters, which is where a
    // session-scope widget is installed and removed.
    await page.getByTestId("widget-tab-session_stats").click();
    await expect(page.getByTestId("widget-session-stats")).toBeVisible();

    await page.getByTestId("open-session-settings").click();
    await page.getByTestId("session-widget-toggle-session_stats").click();
    await page.getByTestId("session-settings-save").click();

    // The other tab takes over. An empty body would be the alternative, and it reads as broken.
    await expect(page.getByTestId("widget-workspace-stats")).toBeVisible();
    await expect(page.getByTestId("widget-body")).not.toBeEmpty();
  });

  test("flips the strip to the left edge and back, across a reload", async ({ page }) => {
    const name = unique("Layout");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);

    const strip = page.getByTestId("widget-tabs");
    const horizontal = (await strip.boundingBox())!;

    await page.getByTestId("widget-layout-toggle").click();

    await expect(page.getByTestId("widget-panel")).toHaveClass(/vertical/);
    const vertical = (await strip.boundingBox())!;
    // Height rather than width now, which is what "the strip is on the left" means for a box.
    expect(vertical.height).toBeGreaterThan(vertical.width);
    expect(vertical.width).toBeLessThan(horizontal.width);

    await page.reload();
    await enterWorkspace(page, name);
    await expect(page.getByTestId("widget-panel")).toHaveClass(/vertical/);

    await page.getByTestId("widget-layout-toggle").click();
    await expect(page.getByTestId("widget-panel")).not.toHaveClass(/vertical/);
  });

  test("resizes by dragging, clamps, and remembers the width", async ({ page }) => {
    const name = unique("Resize");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);

    const panel = page.getByTestId("widget-panel");
    const before = (await panel.boundingBox())!.width;

    const handle = page.getByTestId("widget-resize");
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // The handle is on the panel's *left* edge, so dragging left widens it.
    await page.mouse.move(box.x - 120, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    const wider = (await panel.boundingBox())!.width;
    expect(wider).toBeGreaterThan(before);

    await page.reload();
    await enterWorkspace(page, name);
    expect((await panel.boundingBox())!.width).toBeCloseTo(wider, 0);

    // Dragged far past the ceiling, it stops at it rather than taking the conversation's room.
    const handle2 = (await page.getByTestId("widget-resize").boundingBox())!;
    await page.mouse.move(handle2.x + 2, handle2.y + handle2.height / 2);
    await page.mouse.down();
    await page.mouse.move(-2000, handle2.y + handle2.height / 2, { steps: 10 });
    await page.mouse.up();
    expect((await panel.boundingBox())!.width).toBeLessThanOrEqual(720);
  });

  test("moves tabs that no longer fit into the more menu", async ({ page }) => {
    /*
     * Two tabs and a 320px panel fit, so the overflow is reached the way a user reaches it: by
     * dragging the panel narrow. This is the only coverage of the menu's *wiring* — the fit
     * arithmetic has unit tests, but that the button opens a menu, that the menu lists what is
     * missing, and that picking from it switches the panel is a browser question.
     */
    const name = unique("Overflow");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-session_stats").check();
    await page.getByTestId("create-session").click();

    await expect(page.getByTestId("widget-more")).toHaveCount(0);

    // Drag the panel to its narrowest, which is where two tabs stop fitting.
    const handle = (await page.getByTestId("widget-resize").boundingBox())!;
    await page.mouse.move(handle.x + 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 4000, handle.y + handle.height / 2, { steps: 10 });
    await page.mouse.up();

    const narrow = (await page.getByTestId("widget-panel").boundingBox())!.width;
    expect(narrow, "the drag should have narrowed the panel").toBeLessThan(320);

    await expect(page.getByTestId("widget-more")).toBeVisible();
    /*
     * The first tab stays; the tail is what overflows, in order.
     *
     * That the first one stays is the invariant the minimum width exists for: a strip showing
     * nothing but its "more" button cannot say which widget is open. Dragging as far as the panel
     * goes is therefore never a state with an unreadable strip.
     */
    await expect(page.getByTestId("widget-tab-workspace_stats")).toBeVisible();
    await expect(page.getByTestId("widget-tab-session_stats")).toBeHidden();

    // Open it: the menu lists what is missing, and it anchors *under* the button rather than above
    // it — which is the shared `.overlay-popover` surface's own direction, and where a stray `top`
    // left alongside its `bottom` would stretch the box between the two anchors.
    const buttonBox = (await page.getByTestId("widget-more").boundingBox())!;
    await page.getByTestId("widget-more").click();

    const menuBox = (await page.getByTestId("widget-more-menu").boundingBox())!;
    expect(menuBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height - 1);
    expect(menuBox.height).toBeLessThan(200);

    /*
     * And it is **inside the panel**, which is the assertion this test exists for.
     *
     * `.widget-panel` is `overflow: hidden`, so a menu that reaches past its left edge is clipped
     * into a thing that is present, focusable, reported as visible by every check Playwright
     * makes — and unclickable, because the pointer lands on the chat pane underneath. That is
     * exactly what happened when the menu was anchored to a button sitting mid-strip rather than
     * to the strip's own right edge, and nothing short of a click would have caught it.
     */
    const panelBox = (await page.getByTestId("widget-panel").boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(panelBox.x);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);

    await expect(page.getByTestId("widget-more-item-session_stats")).toBeVisible();

    await page.getByTestId("widget-more-item-session_stats").click();
    await expect(page.getByTestId("widget-session-stats")).toBeVisible();
  });

  test("collapses to a rail, with the control still there to undo it", async ({ page }) => {
    const name = unique("Collapse");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);

    const panel = page.getByTestId("widget-panel");
    await expect(page.getByTestId("widget-body")).toBeVisible();

    await page.getByTestId("widget-collapse").click();

    // The body and the strip go; the panel and the button do not. A control that collapsed
    // something and then went with it is a one-way door.
    await expect(page.getByTestId("widget-body")).toBeHidden();
    await expect(page.getByTestId("widget-tabs")).toBeHidden();
    await expect(page.getByTestId("widget-collapse")).toBeVisible();

    const rail = (await panel.boundingBox())!.width;
    expect(rail).toBeLessThan(100);

    await page.getByTestId("widget-collapse").click();
    await expect(page.getByTestId("widget-body")).toBeVisible();
    expect((await panel.boundingBox())!.width).toBeGreaterThan(rail);
  });
});

test.describe("the demo widgets", () => {
  test("count again after a turn, without a reload", async ({ page, request }) => {
    /*
     * The whole point of the event subscription. The server wrote a message and moved the token
     * totals; nothing the client did knows by how much, so the widget refetches — and it must do
     * so on the turn's own signal rather than on a timer or a page load.
     */
    await scriptLlm(request, {
      turns: [
        { content: "第一轮", usage: { input: 100, output: 20 } },
        { content: "第二轮", usage: { input: 300, output: 40 } },
      ],
    });

    const name = unique("Live");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("new-session-widget-check-session_stats").check();
    await page.getByTestId("create-session").click();

    await page.getByTestId("widget-tab-session_stats").click();
    await expect(page.getByTestId("widget-session-messages")).toHaveText("0");

    await page.getByTestId("composer-input").fill("第一条");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("message-assistant").last()).toContainText("第一轮");

    // Two messages (the user's and the reply) and the first turn's tokens, with no reload.
    await expect(page.getByTestId("widget-session-messages")).toHaveText("2");
    await expect(page.getByTestId("widget-session-input")).toHaveText("100");

    await page.getByTestId("composer-input").fill("第二条");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("message-assistant").last()).toContainText("第二轮");

    // Moved again, still without a reload — which is the assertion the first pair cannot make.
    await expect(page.getByTestId("widget-session-messages")).toHaveText("4");
    await expect(page.getByTestId("widget-session-input")).toHaveText("400");
  });

  test("list the workspace's conversations and open one", async ({ page, request }) => {
    await scriptLlm(request, { turns: [{ content: "好的" }] });

    const name = unique("Rows");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("create-session").click();

    await page.getByTestId("widget-tab-workspace_stats").click();
    await expect(page.getByTestId("widget-workspace-stats")).toBeVisible();

    const row = page.getByTestId("widget-session-row").first();
    await expect(row).toBeVisible();

    // The workspace total is the sum of the rows, so an empty conversation shows a zero rather
    // than being omitted — a conversation that vanished from the list would read as one that
    // does not exist.
    await expect(page.getByTestId("widget-total-messages")).toHaveText("0");

    // Two conversations, and clicking a row opens that one.
    await page.getByTestId("new-session").click();
    await page.getByTestId("create-session").click();
    await expect(page.getByTestId("widget-session-row")).toHaveCount(2);

    await page.getByTestId("widget-session-row").last().click();
    await expect(page.getByTestId("composer-input")).toBeVisible();
  });

  test("stay in step with the conversation list as sessions come and go", async ({ page }) => {
    const name = unique("InStep");
    await createWorkspaceWith(page, name, ["workspace_stats"]);
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("create-session").click();
    await page.getByTestId("widget-tab-workspace_stats").click();
    await expect(page.getByTestId("widget-session-row")).toHaveCount(1);

    // A second conversation is announced as it is created, so the list is already right.
    await page.getByTestId("new-session").click();
    await page.getByTestId("create-session").click();
    await expect(page.getByTestId("widget-session-row")).toHaveCount(2);
  });
});
