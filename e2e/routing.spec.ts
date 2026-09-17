import { expect, test } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace, leaveWorkspace } from "./workspaces";
import {
  AUTH_STATE,
  forgetSession,
  SIGNED_IN_AS,
  SIGNED_IN_PASSWORD,
  signIn,
} from "./auth";

/**
 * The address bar, as a feature.
 *
 * The app used to hold the page in memory and keep `/` in the URL whatever you were looking at,
 * so a refresh, a bookmark and a Back press all threw the reader back to the front door. Every
 * other spec in this suite now relies on the opposite — a reload stays put — and `workspaces.ts`
 * normalises for the twenty of them that reload to prove something came from the database. This
 * is the one file where **staying put is the assertion**.
 *
 * What only a real browser can prove is here rather than in the unit suite: the guard is tested
 * in `apps/web/test/router/guards.test.ts`, but that a *browser* asked the *server* for a deep
 * path and got the app back is a fact about two processes and a static file. (In dev that is
 * Vite's SPA fallback; the built-server half is `apps/server/test/web-app.test.ts`.)
 */

/** A workspace of this spec's own, with one answered turn in it. */
async function conversation(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext
): Promise<{ workspace: string; url: string }> {
  const workspace = `路由 ${Date.now()}`;
  await scriptLlm(request, { title: "路由测试", turns: [{ content: "记住了。" }] });

  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(workspace);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, workspace);

  await page.getByTestId("composer-input").fill("记住这句话");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("记住了。");

  return { workspace, url: new URL(page.url()).pathname };
}

test("the URL names the conversation, and a reload comes back to it", async ({
  page,
  request,
}) => {
  const { url } = await conversation(page, request);

  // The address is the workspace *and* the conversation, by id — which is what makes it
  // something a person can send to themselves.
  expect(url).toMatch(/^\/w\/[^/]+\/s\/[^/]+$/);

  await page.reload();

  // The whole of the requirement: the conversation is what comes back, not the front door.
  await expect(page.getByTestId("workspace-home")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("message-assistant").last()).toContainText("记住了。");
  expect(new URL(page.url()).pathname).toBe(url);
});

test("a conversation still being composed is not reset by the URL changing underneath it", async ({
  page,
  request,
}) => {
  /*
   * The trap a route table sets for a single-page app: the first message of an empty
   * conversation *creates* it, so the address changes from `/w/<ws>` to `/w/<ws>/s/<id>`
   * mid-turn. If that navigation swapped the component rather than patching it, the composer
   * would be rebuilt underneath the reader — losing whatever they had typed next, the scroll
   * position, and every effect the pane owns.
   *
   * Asserted on the DOM node itself: `evaluate` hands back a token that survives a patch and
   * does not survive a remount.
   */
  const workspace = `路由不重挂 ${Date.now()}`;
  await scriptLlm(request, { turns: [{ content: "在的。" }] });

  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(workspace);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, workspace);

  const before = new URL(page.url()).pathname;
  expect(before).toMatch(/^\/w\/[^/]+$/);

  // Typed *and left there*: this is what a remount would throw away, and it is the reason the
  // check is on the element rather than on the text.
  await page.getByTestId("composer-input").fill("这句话要在发送之后还在");
  await page.getByTestId("composer-input").evaluate((el) => {
    (el as HTMLElement).dataset.routingProbe = "kept";
  });

  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("在的。");

  // The address moved to the conversation the turn created…
  expect(new URL(page.url()).pathname).toMatch(/^\/w\/[^/]+\/s\/[^/]+$/);
  // …and it is the same element, not a fresh one that happens to look the same.
  await expect(page.getByTestId("composer-input")).toHaveAttribute("data-routing-probe", "kept");
});

test("Back walks the way it came, through the workspace list", async ({ page, request }) => {
  const workspace = `路由后退 ${Date.now()}`;
  await scriptLlm(request, { title: "后退", turns: [{ content: "第一条" }, { content: "第二条" }] });

  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(workspace);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, workspace);

  for (const said of ["第一句", "第二句"]) {
    await page.getByTestId("composer-input").fill(said);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("message-user").last()).toContainText(said);
  }

  const sessionUrl = new URL(page.url()).pathname;
  const workspacePath = sessionUrl.replace(/\/s\/[^/]+$/, "");

  // A second conversation, created the way the sidebar offers it. This is the push that has to
  // be a push: a `replace` here would leave Back pointing at whatever was before the *first*
  // conversation, and the reader would have no way back to the one they just left.
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  // Polled, not read once: the click returns as soon as it is dispatched, and the write, the
  // conversation's own address and the dialog closing all happen behind a round trip.
  await expect
    .poll(() => new URL(page.url()).pathname, { message: "the address should follow the new conversation" })
    .not.toBe(sessionUrl);
  const freshUrl = new URL(page.url()).pathname;

  // Back returns to the one before it, read from the server off its own address.
  await page.goBack();
  expect(new URL(page.url()).pathname).toBe(sessionUrl);
  await expect(page.getByTestId("message-user")).toHaveCount(2);

  // And Back again is the workspace without a conversation rather than the previous one: every
  // step of the way in was a push, so the trail is the whole of it.
  await page.goBack();
  expect(new URL(page.url()).pathname).toBe(workspacePath);
  await expect(page.getByTestId("composer-input")).toBeVisible();

  // …and once more is the list the trail started from.
  await page.goBack();
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
});

test("a deep link pasted into a fresh tab opens the conversation it names", async ({
  browser,
  page,
  request,
}) => {
  /*
   * The bookmark case, and it needs a *second* context rather than a navigation: the point is
   * that the address alone is enough — no history, no state carried over from the tab that
   * made it. The saved session comes with the storage state, so this is a signed-in reader
   * opening a link.
   */
  const { url } = await conversation(page, request);

  const other = await browser.newContext({ storageState: AUTH_STATE, locale: "zh-CN" });
  try {
    const tab = await other.newPage();
    await tab.goto(url);

    await expect(tab.getByTestId("composer-input")).toBeVisible();
    await expect(tab.getByTestId("message-assistant").last()).toContainText("记住了。");
    expect(new URL(tab.url()).pathname).toBe(url);
  } finally {
    await other.close();
  }
});

test("a URL naming a workspace that is not there lands on the front door", async ({
  page,
  request,
}) => {
  // A link from a database that has moved on. The honest answer is the workspace list with the
  // address corrected — not a blank pane, and not an error about somebody else's file.
  await conversation(page, request);

  await page.goto("/w/definitely-not-a-workspace/s/definitely-not-a-session");

  await expect(page.getByTestId("workspace-home")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("a URL naming a conversation the workspace does not hold lands on the workspace", async ({
  page,
  request,
}) => {
  const { url } = await conversation(page, request);
  const workspacePath = url.replace(/\/s\/[^/]+$/, "");

  await page.goto(`${workspacePath}/s/definitely-not-a-session`);

  await expect(page.getByTestId("composer-input")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(workspacePath);
});

test("the console's section is in the URL, and survives a reload", async ({ page }) => {
  // The other half of 菜单项: a reload on the providers screen must not land on the accounts
  // list, which is what a section held in memory would do.
  await page.goto("/admin/providers");

  await expect(page.getByTestId("admin-providers")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/admin/providers");

  await page.reload();

  await expect(page.getByTestId("admin-providers")).toBeVisible();
  await expect(page.getByTestId("admin-nav-providers")).toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).pathname).toBe("/admin/providers");

  // Choosing another writes it, and a bare `/admin` completes rather than leaving a default.
  await page.getByTestId("admin-nav-documents").click();
  expect(new URL(page.url()).pathname).toBe("/admin/documents");

  await page.goto("/admin");
  await expect(page.getByTestId("admin-nav-users")).toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).pathname).toBe("/admin/users");
});

test("a bookmark into a signed-out tab survives the sign-in it turns out to need", async ({
  page,
  request,
}) => {
  /*
   * The session expired between the link being saved and it being opened. The address is
   * carried through the sign-in rather than discarded — which is the difference between a
   * bookmark being useful and being a reminder of where you used to be.
   *
   * `forgetSession` first: signing out normally revokes the shared token server-side, which
   * would sign out every spec after this one.
   */
  const { url } = await conversation(page, request);

  await forgetSession(page);
  await page.goto(url);

  // Sent to the form, with the destination remembered in the address rather than in memory.
  await expect(page.getByTestId("login-form")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("redirect")).toBe(url);

  await page.getByTestId("login-username").fill(SIGNED_IN_AS);
  await page.getByTestId("login-password").fill(SIGNED_IN_PASSWORD);
  await page.getByTestId("login-submit").click();

  // …and handed back to it once there is somebody to show it to.
  await expect(page.getByTestId("composer-input")).toBeVisible();
  await expect(page.getByTestId("message-assistant").last()).toContainText("记住了。");
  expect(new URL(page.url()).pathname).toBe(url);
});

test("an unknown path is the front door, not an error", async ({ page }) => {
  // Nothing in this app owns `/nope`. The reader gets the workspace list and a corrected
  // address, which is the only answer that is not a dead end.
  await page.goto("/nope");

  await expect(page.getByTestId("workspace-home")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("a signed-in reader typing /login gets the front door, not the form", async ({ page }) => {
  // The guard's refusal, in a browser: the form is not an error, it is just not where an
  // account that already has a session is — and a reload of it must not strand them there.
  await page.goto("/login");

  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await expect(page.getByTestId("login-form")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/");
});

test("signing out leaves no conversation in the address", async ({ page, request }) => {
  /*
   * The account watcher's half: clearing the account is what moves the reader, so a URL naming
   * somebody's conversation cannot outlive the session that could read it.
   *
   * It signs in for a session of its own first, for the reason `auth.ts` documents and
   * `sign-out.spec.ts` follows: signing out revokes the token server-side, and the inherited
   * session is shared with every spec that runs after this one. It is last in the file for the
   * same reason — once this session is spent, the page has no way back in.
   */
  await forgetSession(page);
  await signIn(page, SIGNED_IN_AS, SIGNED_IN_PASSWORD);

  await conversation(page, request);
  await expect(page.getByTestId("composer-input")).toBeVisible();

  await page.getByTestId("sign-out").click();

  await expect(page.getByTestId("login-form")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/login");
  await expect(page.getByTestId("message-assistant")).toHaveCount(0);
});
