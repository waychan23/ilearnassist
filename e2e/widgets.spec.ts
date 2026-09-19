import { expect, test, type Page } from "./fixtures";
import { enterWorkspace, leaveWorkspace } from "./workspaces";

/**
 * The right sidebar: installing widgets, the strip that draws them, and the panels themselves.
 *
 * **Everything here is session scope, because that is the only scope with widgets.** There were
 * two at workspace level — demo panels reading numbers out of the database — and removing them
 * left the level with none, so the strip the app draws has a single group and never a divider.
 * That is asserted rather than assumed (see the divider test), since a spec that simply stopped
 * mentioning the group would not fail if one came back.
 *
 * **Almost every flow creates a conversation first**, and that is the install path now rather than
 * a precondition: a new conversation installs the notes and sources panels by default, so the
 * create dialog is where the choice is presented and the strip is where it shows up. The one test
 * that *does* start from nothing is the one about the panel being absent.
 */

/**
 * Create a workspace through the dialog and answer its id.
 *
 * Through the UI rather than the API on purpose: the card is what the rest of the flow starts
 * from, and a spec that seeded the workspace over HTTP would leave the dialog's own wiring
 * unexercised.
 *
 * The id is read back **off the card it just made**, and matched by name rather than taken from
 * the first card in the list: the suite's own earlier tests leave workspaces behind, and the
 * first card is the oldest of them.
 *
 * No widget argument: a workspace has no widgets to tick. Its dialog used to carry a checklist,
 * and the section is now hidden entirely — which `the workspace level has no widgets` below is
 * what holds in place.
 */
async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.getByTestId("workspace-new").click();

  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();

  const card = page.getByTestId("workspace-card").filter({ hasText: name });
  await expect(card).toBeVisible();
  const id = await card.getAttribute("data-workspace-id");
  expect(id, "the new card should carry its workspace id").toBeTruthy();
  return id!;
}

/**
 * Start a conversation, ticking the given widgets in the create dialog.
 *
 * The session half of the install path, and the only one left: the whole selection is chosen
 * before the conversation exists, so the create request is the only moment there is.
 */
async function newConversation(page: Page, widgets: string[] = []): Promise<void> {
  await page.getByTestId("new-session").click();
  for (const id of widgets) {
    await page.getByTestId(`new-session-widget-check-${id}`).check();
  }
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/** A workspace with one conversation in it, which is where every widget flow starts. */
async function workspaceWithConversation(
  page: Page,
  name: string,
  widgets: string[] = []
): Promise<void> {
  await createWorkspace(page, name);
  await enterWorkspace(page, name);
  await newConversation(page, widgets);
}

test.describe("the widget panel", () => {
  test("is absent until something is installed, and appears once it is", async ({ page }) => {
    const name = unique("Empty");
    await createWorkspace(page, name);
    await enterWorkspace(page, name);

    // The rule the whole feature is built on: a panel nobody installed anything into is not a
    // panel with an empty state, it is not there at all. A workspace with no conversation has
    // nothing installed, because a conversation's widgets arrive with the conversation.
    await expect(page.getByTestId("widget-panel")).toHaveCount(0);

    /*
     * And the create dialog is what changes it — without ticking anything, because the defaults
     * are the point of this assertion: a conversation nobody configured still shows what the
     * learner wrote and what it is working from.
     */
    await newConversation(page);
    await expect(page.getByTestId("widget-panel")).toBeVisible();
    await expect(page.getByTestId("widget-tab-notes")).toBeVisible();
  });

  test("is a third column beside the conversation, not an overlay over it", async ({ page }) => {
    const name = unique("Column");
    await workspaceWithConversation(page, name);

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

  test("installs and uninstalls from the conversation settings, repeatedly", async ({ page }) => {
    const name = unique("Toggle");
    await workspaceWithConversation(page, name);
    await expect(page.getByTestId("widget-tab-notes")).toBeVisible();

    // The settings dialog is opened from the composer's own button, and a session-scope widget is
    // installed and removed there.
    await page.getByTestId("open-session-settings").click();
    const toggle = page.getByTestId("session-widget-toggle-notes");
    await expect(toggle).toHaveText("卸载");

    await toggle.click();
    await expect(toggle).toHaveText("安装");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await page.getByTestId("session-settings-save").click();
    // The tab goes with it. `sources` is still installed, so the panel itself stays.
    await expect(page.getByTestId("widget-tab-notes")).toHaveCount(0);
    await expect(page.getByTestId("widget-panel")).toBeVisible();

    // Back on again, which is the "repeated install/uninstall of the same object" requirement.
    await page.getByTestId("open-session-settings").click();
    await toggle.click();
    await expect(toggle).toHaveText("卸载");
    await page.getByTestId("session-settings-save").click();
    await expect(page.getByTestId("widget-tab-notes")).toBeVisible();

    // And the record is a record: a reload shows the same state rather than a fresh default.
    await page.reload();
    await enterWorkspace(page, name);
    await page.getByTestId("session-item").first().click();
    await expect(page.getByTestId("widget-tab-notes")).toBeVisible();
  });

  test("draws one group and no divider, because only one scope has widgets", async ({ page }) => {
    /*
     * The state the workspace level is in, asserted rather than assumed.
     *
     * The strip used to draw the workspace group first and then the session group, separated by a
     * rule. With nothing installed at workspace scope there is one group, so the divider — which
     * only exists between two visible groups — must not be drawn at all: a rule with nothing on
     * one side of it is a claim about grouping that is not on screen. A spec that merely stopped
     * mentioning the workspace tab would pass whether or not a divider came back.
     */
    const name = unique("Groups");
    await workspaceWithConversation(page, name, ["diagram"]);

    await expect(page.getByTestId("widget-tab-notes")).toBeVisible();
    await expect(page.getByTestId("widget-tab-diagram")).toBeVisible();
    await expect(page.getByTestId("widget-tabs-divider")).toHaveCount(0);

    // And the order is the registry's, not the create request's: `notes` comes before `diagram`
    // in `WIDGET_IDS`, and the request named diagram first.
    const labels = (await page.locator(".widget-tab").allInnerTexts()).map((s) => s.trim());
    expect(labels.findIndex((l) => l.includes("笔记"))).toBeLessThan(
      labels.findIndex((l) => l.includes("图表"))
    );
  });

  test("switches the open widget and remembers the choice", async ({ page }) => {
    const name = unique("Switch");
    await workspaceWithConversation(page, name, ["diagram"]);

    await page.getByTestId("widget-tab-diagram").click();
    await expect(page.getByTestId("widget-diagram")).toBeVisible();
    await expect(page.getByTestId("widget-notes")).toHaveCount(0);

    /*
     * Remembered across a reload, so the panel comes back to the tab that was open — and the
     * conversation has to be reopened first, because a conversation's own installs cannot be known
     * until one is. That is the design rather than a gap: the strip belongs to whatever is on
     * screen, and with no conversation open there is nothing for a session widget to show.
     */
    await page.reload();
    await enterWorkspace(page, name);
    await expect(page.getByTestId("widget-tab-diagram")).toHaveCount(0);

    await page.getByTestId("session-item").first().click();
    await expect(page.getByTestId("widget-diagram")).toBeVisible();
  });

  test("opens a new conversation on its first tab, not on one read elsewhere", async ({ page }) => {
    const name = unique("FirstTab");
    await workspaceWithConversation(page, name, ["diagram"]);

    // Read the *second* tab. The panel remembers the open tab in one global preference, so this
    // is the value that used to decide what every later conversation opened on.
    await page.getByTestId("widget-tab-diagram").click();
    await expect(page.getByTestId("widget-diagram")).toBeVisible();

    // A conversation made fresh has no last-read tab of its own, so it opens on the strip's first
    // — `notes`, by registry order — rather than on the tab just read in the one before it.
    await newConversation(page, ["diagram"]);

    await expect(page.getByTestId("widget-notes")).toBeVisible();
    await expect(page.getByTestId("widget-diagram")).toHaveCount(0);
  });

  test("uninstalling the open widget falls back rather than emptying the body", async ({
    page,
  }) => {
    const name = unique("Fallback");
    await workspaceWithConversation(page, name, ["diagram"]);

    await page.getByTestId("widget-tab-diagram").click();
    await expect(page.getByTestId("widget-diagram")).toBeVisible();

    await page.getByTestId("open-session-settings").click();
    await page.getByTestId("session-widget-toggle-diagram").click();
    await page.getByTestId("session-settings-save").click();

    // Another tab takes over. An empty body would be the alternative, and it reads as broken.
    await expect(page.getByTestId("widget-notes")).toBeVisible();
    await expect(page.getByTestId("widget-body")).not.toBeEmpty();
  });

  test("flips the strip to the left edge and back, across a reload", async ({ page }) => {
    const name = unique("Layout");
    await workspaceWithConversation(page, name);

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
    await page.getByTestId("session-item").first().click();
    await expect(page.getByTestId("widget-panel")).toHaveClass(/vertical/);

    await page.getByTestId("widget-layout-toggle").click();
    await expect(page.getByTestId("widget-panel")).not.toHaveClass(/vertical/);
  });

  test("resizes by dragging, clamps, and remembers the width", async ({ page }) => {
    const name = unique("Resize");
    await workspaceWithConversation(page, name);

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
    await page.getByTestId("session-item").first().click();
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
     * This is the only coverage of the menu's *wiring* — the fit arithmetic has unit tests, but
     * that the button opens a menu, that the menu lists what is missing, and that picking from it
     * switches the panel is a browser question.
     *
     * Five tabs, from the live registry: the create dialog's own boxes for three more, plus the two
     * defaults (`notes`, `sources`). `widgetsForScope` walks `WIDGETS`, so the strip is
     * `plan, notes, diagram, insight, sources` — and it is the **last** of those that is the tail.
     * The drag is the case's subject: it is what guarantees the overflow rather than hoping for it,
     * and the count is what makes the overflow certain at the panel's own minimum width.
     */
    const name = unique("Overflow");
    await workspaceWithConversation(page, name, ["plan", "diagram", "insight"]);

    // Drag the panel to its narrowest, which is well past where five tabs stop fitting.
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
    await expect(page.getByTestId("widget-tab-plan")).toBeVisible();
    await expect(page.getByTestId("widget-tab-sources")).toBeHidden();

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

    await expect(page.getByTestId("widget-more-item-sources")).toBeVisible();

    await page.getByTestId("widget-more-item-sources").click();
    await expect(page.getByTestId("widget-sources")).toBeVisible();
  });

  test("collapses to a rail, with the control still there to undo it", async ({ page }) => {
    const name = unique("Collapse");
    await workspaceWithConversation(page, name);

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

test("the workspace level has no widgets, and says nothing about installing one", async ({
  page,
}) => {
  /*
   * The other half of "the strip draws one group": the *dialogs* at workspace scope.
   *
   * Both used to draw a section — the create dialog a labelled checklist, the settings dialog a
   * toggle list with a sentence about what installing there does. With nothing to install, a
   * label, a lead sentence and no checkboxes is a section claiming something exists when nothing
   * does. Asserted through the UI because that is where it was visible: the server side is
   * `apps/server/test/widgets.test.ts`'s "the workspace level".
   */
  const name = unique("NoWorkspaceWidgets");
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  await page.getByTestId("workspace-new").click();
  // No heading, and no checkbox for any id — the section is gone rather than empty.
  await expect(page.getByText("控件", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-testid^="workspace-widget-check-"]')).toHaveCount(0);
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await expect(page.getByTestId("workspace-card").filter({ hasText: name })).toBeVisible();

  await page
    .getByTestId("workspace-card")
    .filter({ hasText: name })
    .getByTestId("workspace-settings-open")
    .click();
  await expect(page.getByTestId("workspace-settings-done")).toBeVisible();
  await expect(page.locator('[data-testid^="workspace-widget-toggle-"]')).toHaveCount(0);
  await page.getByTestId("workspace-settings-done").click();
});

test("the workspace settings have two entries, and that is deliberate", async ({ page }) => {
  /*
   * The sidebar's workspace *name* in the header and the 工作区设置 row in its footer both open
   * the same dialog. That is a product decision rather than a duplicate to tidy away: the name
   * is the shortcut for someone who already knows what it does, and the labelled row is for
   * someone who does not — and a row labelled with where it goes is something the footer only
   * has room for because an installation-wide settings dialog no longer competes with it.
   *
   * Both are asserted because "there is a second way in" is exactly the kind of claim that
   * survives a refactor as a comment and stops being true in the code.
   */
  const name = unique("TwoDoors");
  await createWorkspace(page, name);
  await enterWorkspace(page, name);

  await page.getByTestId("open-workspace-settings").click();
  await expect(page.getByTestId("workspace-settings-done")).toBeVisible();
  await page.getByTestId("workspace-settings-done").click();

  // The header's name button, which is the other one. It must not be shadowed by the new row:
  // a strict-mode locator matching both would fail every spec that uses it.
  await page.getByTestId("workspace-settings-open").click();
  await expect(page.getByTestId("workspace-settings-done")).toBeVisible();
});

test("leaving a workspace from the rail still works with the panel drawn", async ({ page }) => {
  // A cheap guard on the one interaction the removal touched: the rail's back button sits beside
  // a panel whose widget list is now session-only, and a workspace with nothing installed must
  // still be leavable. `leaveWorkspace` is the suite's own helper, so this is really asserting
  // that the suite's front door did not become order-dependent.
  const name = unique("Leave");
  await createWorkspace(page, name);
  await enterWorkspace(page, name);
  await expect(page.getByTestId("widget-panel")).toHaveCount(0);
  await leaveWorkspace(page);
});
