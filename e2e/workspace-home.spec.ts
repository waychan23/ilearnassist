import { expect, test, type Page } from "./fixtures";
import { enterWorkspace, leaveWorkspace } from "./workspaces";

/**
 * The front door: the card grid the app opens on, and the only way into a conversation.
 *
 * Everything here is about the page *as a page* — that "/" renders it, that a card is what
 * gets you into a workspace, and that the things you might want to do to a workspace happen
 * on it rather than somewhere else. What the chat pane does once you are inside it is
 * `chat.spec.ts`; that every other spec still gets in is what `enterWorkspace` is for.
 *
 * Each test makes its own workspace with a unique name rather than assuming an empty
 * database: the suite shares one, and the default workspace from a first run is in it too.
 */

/**
 * A card, located by the workspace id it carries.
 *
 * Not by `filter({ hasText: name })`, which is the obvious way and is wrong here: while a
 * card is being renamed its name lives in an `<input>`, and `hasText` matches text content
 * only — so the locator would stop matching the very card the test is mid-edit on and then
 * time out waiting for an input inside nothing. The id is stable for the workspace's whole
 * life, which is also what makes it the right key for "the same card, later".
 */
const cardById = (page: Page, id: string) =>
  page.locator(`[data-testid="workspace-card"][data-workspace-id="${id}"]`);

/** Create a workspace through the real dialog and return its id. */
async function createWorkspace(page: Page, name: string): Promise<string> {
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();

  const card = page.getByTestId("workspace-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  return (await card.getAttribute("data-workspace-id"))!;
}

/** A name no other test in this file can collide with. */
const uniqueName = (prefix: string) => `${prefix} ${Date.now()}`;

test("the app opens on the workspace list, not in a conversation", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await expect(page.getByTestId("workspace-card").first()).toBeVisible();

  // Not merely hidden — not rendered. That is what makes the card the only way in, and a
  // `v-show` would leave the pane in the accessibility tree and in the tab order behind the
  // page the user is looking at.
  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
});

test("the Copilot list is reachable before any workspace is entered", async ({ page }) => {
  // The front door would otherwise be a dead end for someone who wants to manage the Copilots
  // they made — and the entry point for that is otherwise the sidebar's footer, inside a
  // workspace they may not have entered yet. The reason survived the settings dialog the button
  // used to open, which is why the button did.
  await page.goto("/");

  await page.getByTestId("open-copilots").click();

  await expect(page.locator("body > .modal-overlay")).toBeVisible();
  await expect(page.getByTestId("new-copilot")).toBeVisible();
});

test("the rail's menu is two groups, at the two ends of the column", async ({ page, request }) => {
  /*
   * The split is a layout decision as much as a content one. The home page's rail holds nothing
   * else, so the group of things the account can *reach* sits under the brand and the group about
   * *who is signed in* sits at the foot — rather than both huddling at the bottom of an otherwise
   * empty column, which is what a single group at the foot looked like.
   */
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  const app = page.getByTestId("menu-group-app");
  const account = page.getByTestId("menu-group-account");
  await expect(app).toBeVisible();
  await expect(account).toBeVisible();

  // The order, and the *distance*: a rule that only stacked them would pass on the order alone.
  const railBox = (await page.locator(".home-rail").boundingBox())!;
  const appBox = (await app.boundingBox())!;
  const accountBox = (await account.boundingBox())!;
  expect(appBox.y).toBeLessThan(accountBox.y);
  expect(appBox.y).toBeLessThan(railBox.y + railBox.height / 2);
  expect(accountBox.y + accountBox.height).toBeGreaterThan(railBox.y + railBox.height / 2);

  // And the root path the footer used to carry is gone. Read from the server rather than typed
  // out, so this asserts the removal rather than a string that happens to be missing.
  const config = (await (await request.get("/api/config")).json()) as {
    workspacesRootDir: string;
  };
  await expect(page.locator(".home-rail")).not.toContainText(config.workspacesRootDir);
});

test("clicking a card enters that workspace, on its welcome screen", async ({ page }) => {
  await page.goto("/");
  const name = uniqueName("Entered");
  const id = await createWorkspace(page, name);

  await cardById(page, id).getByTestId("workspace-open").click();

  await expect(page.getByTestId("composer-input")).toBeVisible();
  // The welcome screen, not the last conversation: entering a workspace is not the same as
  // resuming whatever was open in it.
  await expect(page.getByText("开始对话")).toBeVisible();
  // And it is *this* workspace's pane — named in the middle of the sidebar's header. Not on
  // the back button beside it: that is a glyph now, and the name has an element of its own.
  await expect(page.getByTestId("workspace-name")).toHaveText(name);
});

test("leaving the workspace unmounts the pane and its rail", async ({ page }) => {
  // One route out, and it is the sidebar header's: the chat header's arrow went with the library
  // button, on the rule that the rail naming the workspace is where leaving it belongs. What this
  // pins is the *unmount* — the workspace home is a different branch of `App.vue` rather than a
  // pane hidden behind the chat, so nothing of the conversation is left mounted underneath it.
  await page.goto("/");
  await enterWorkspace(page);
  await expect(page.getByTestId("sidebar")).toBeVisible();

  await leaveWorkspace(page);

  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
});

test("the sidebar's header is the way out, and carries nothing else", async ({ page }) => {
  await page.goto("/");
  await enterWorkspace(page);

  // Three controls, and none of them creates anything: out on the left, the workspace's own
  // settings in the middle, the rail's toggle on the right. Creating a workspace lives on the
  // home page, a click away, rather than a few pixels from the button that goes back to it —
  // where a mis-click would start a workspace instead of leaving one. The count is here so an
  // icon button added later has to say what it is, and the *name* is what says it: the middle
  // one is the workspace name, made into a button, which is why the guard moved from two.
  await expect(page.locator(".workspace-head button")).toHaveCount(3);
  await expect(page.getByTestId("sidebar-toggle")).toBeVisible();
  await expect(page.getByTestId("workspace-settings-open")).toBeVisible();

  await page.getByTestId("all-workspaces").click();

  await expect(page.getByTestId("workspace-home")).toBeVisible();
});

test("a card reports what is inside it, and catches up when you come back", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const name = uniqueName("Busy");
  const id = await createWorkspace(page, name);
  const card = cardById(page, id);

  // A workspace nobody has talked to says so, rather than showing a bare zero and a date
  // it was created on.
  await expect(card.getByTestId("workspace-activity")).toContainText("0 个会话");
  await expect(card.getByTestId("workspace-activity")).toContainText("暂无活动");

  await request.post(`/api/workspaces/${id}/sessions`, { data: { title: "后来的会话" } });

  // Entering and leaving is what refreshes the card. Asserted rather than polled: the count
  // is read once, on the way back, and a version that never refreshed would still show 0.
  await card.getByTestId("workspace-open").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await leaveWorkspace(page);

  await expect(card.getByTestId("workspace-activity")).toContainText("1 个会话");
  await expect(card.getByTestId("workspace-activity")).not.toContainText("暂无活动");
});

test("renaming a workspace happens on its card and survives a reload", async ({ page }) => {
  await page.goto("/");
  const name = uniqueName("Renamed");
  const id = await createWorkspace(page, name);
  const card = cardById(page, id);
  const renamed = `${name} (v2)`;

  await card.getByTestId("workspace-rename").click();
  const input = card.getByTestId("workspace-rename-input");
  await input.fill(renamed);
  await input.press("Enter");

  await expect(card.getByTestId("workspace-open")).toHaveText(renamed);

  // From the server, not a local patch of the label — the app opens on this page again
  // after a reload, so the name it renders has to have been persisted.
  await page.reload();
  await expect(card.getByTestId("workspace-open")).toHaveText(renamed);
});

test("deleting a workspace asks first, and cancelling changes nothing", async ({ page }) => {
  await page.goto("/");
  const name = uniqueName("Doomed");
  const id = await createWorkspace(page, name);
  const card = cardById(page, id);

  await card.getByTestId("workspace-delete").click();

  // The directory and every file in it go with the workspace, so this is the one action on
  // the page that has to be confirmed rather than merely undoable.
  const prompt = page.locator("body > .modal-overlay");
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(name);

  await page.getByTestId("confirm-cancel").click();
  await expect(prompt).toHaveCount(0);
  await expect(card).toBeVisible();

  await card.getByTestId("workspace-delete").click();
  await page.getByTestId("confirm-accept").click();
  await expect(card).toHaveCount(0);
});

test("a workspace's name and description are edited in its settings dialog", async ({ page }) => {
  /*
   * The second door to the name. The card's inline rename is still the shortcut for someone
   * looking at the list; this is where someone who opened the settings expects to find it, and
   * the description has no other home at all.
   *
   * Committed on blur rather than behind a Save button, because this dialog has no Save — its
   * write location applies on change and its widget toggles apply on click. The assertion after
   * the reload is what makes that a claim about the server.
   *
   * **Two overlapping commits, deliberately.** Pressing Enter on the name and then typing the
   * description is the ordinary way to fill this form in, and it puts two writes in flight at
   * once — the second blurring the first. Their replies are whole rows, so the older one lands
   * carrying a description that predates what was typed, and writing it back wipes the field.
   * The sequence is what this test is really for; both asserts failed against a version that
   * assigned a reply's fields unconditionally.
   */
  await page.goto("/");
  const name = uniqueName("Described");
  const id = await createWorkspace(page, name);
  const card = cardById(page, id);
  const renamed = `${name} (v2)`;

  await card.getByTestId("workspace-settings-open").click();
  const dialog = page.locator("body > .modal-overlay");
  await expect(dialog).toBeVisible();

  await dialog.getByTestId("workspace-name").fill(renamed);
  await dialog.getByTestId("workspace-name").press("Enter");
  // Losing focus is what commits it — the dialog has no Save button to press.
  await dialog.getByTestId("workspace-description").fill("线性代数的习题与讲义");
  await dialog.getByTestId("workspace-description").blur();
  await page.getByTestId("workspace-settings-done").click();

  // The card behind the dialog already carries the new name, and the description is on it —
  // a field nobody can see is a field nobody writes.
  await expect(card.getByTestId("workspace-open")).toHaveText(renamed);
  await expect(card.getByTestId("workspace-description-text")).toHaveText("线性代数的习题与讲义");

  await page.reload();
  await expect(card.getByTestId("workspace-open")).toHaveText(renamed);
  await expect(card.getByTestId("workspace-description-text")).toHaveText("线性代数的习题与讲义");

  // Reopening shows the stored values, not the ones the form was opened with.
  await card.getByTestId("workspace-settings-open").click();
  await expect(dialog.getByTestId("workspace-name")).toHaveValue(renamed);
  await expect(dialog.getByTestId("workspace-description")).toHaveValue("线性代数的习题与讲义");

  /*
   * And a description longer than two lines is *two lines* — the row it is given, with the
   * rest behind `title`.
   *
   * Asserted on the rendered box rather than on the class, because "two lines" is a claim
   * about a laid-out paragraph: `-webkit-line-clamp` has no effect at all without
   * `display: -webkit-box`, and a width-dependent count is exactly what a test can only ask
   * of the browser. The paragraph below is deliberately far past two lines, so an unclamped
   * card would be four or five tall and this would catch it.
   */
  const long =
    "线性代数的习题与讲义：矩阵与线性方程组、向量空间与子空间、特征值与特征向量、" +
    "正交性与最小二乘、二次型与正定矩阵，以及每一章的课后练习与期末复习提纲。";
  await dialog.getByTestId("workspace-description").fill(long);
  await dialog.getByTestId("workspace-description").blur();
  await page.getByTestId("workspace-settings-done").click();

  const box = await card
    .getByTestId("workspace-description-text")
    .evaluate((el) => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return {
        lines: Math.round(el.clientHeight / lineHeight),
        // The overflow the clamp is hiding, which is what separates "two lines of text" from
        // "a two-line box that happens to fit".
        clipped: el.scrollHeight > el.clientHeight,
      };
    });
  expect(box).toEqual({ lines: 2, clipped: true });

  // The whole sentence is still reachable, which is what makes clamping it a presentation
  // choice rather than a loss.
  await expect(card.getByTestId("workspace-description-text")).toHaveAttribute("title", long);
});
