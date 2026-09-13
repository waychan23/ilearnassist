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

test("global settings is reachable before any workspace is entered", async ({ page }) => {
  // The front door would otherwise be a dead end for someone who wants to manage the Copilots
  // they made — and the controls for that live in Settings, which is otherwise reached from the
  // sidebar inside a workspace they may not have entered yet.
  await page.goto("/");

  await page.getByTestId("open-settings").click();

  await expect(page.locator("body > .modal-overlay")).toBeVisible();
  await expect(page.getByTestId("new-copilot")).toBeVisible();
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

test("the chat pane's back button returns to the list", async ({ page }) => {
  await page.goto("/");
  await enterWorkspace(page);
  await expect(page.getByTestId("sidebar")).toBeVisible();

  await leaveWorkspace(page);

  await expect(page.getByTestId("composer-input")).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toHaveCount(0);
});

test("the sidebar's header leaves the workspace too, and carries nothing else", async ({
  page,
}) => {
  // The two ways out are reached from different places — one from the topbar, one from the
  // sidebar — and on a phone the sidebar is the only one of them on screen.
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
