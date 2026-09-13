import { expect, test, type Page } from "./fixtures";
import {
  ensureUser,
  forgetSession,
  SIGNED_IN_AS,
  SIGNED_IN_PASSWORD,
  signIn,
} from "./auth.js";
import { enterWorkspace } from "./workspaces";

/**
 * Signing out, from the two places the control lives.
 *
 * Unlike `login.spec.ts` this file *wants* the inherited session — the point is to have one to
 * give up — so it is a file of its own rather than a `describe` inside that one, whose
 * file-scoped `storageState` override would otherwise be inherited here and leave nothing to
 * sign out of.
 *
 * **Each test signs in for a session of its own first, and that is not ceremony.** The state
 * every spec starts from is one session, shared through `storageState`, and signing out
 * revokes it server-side — so signing out the inherited one would sign out every spec that
 * runs afterwards. `forgetSession` lets go of it locally, the sign-in below opens a second
 * session, and the shared one survives to the end of the run.
 */

/** The shared session, released; then a private one, which is the one that gets spent. */
async function ownSession(page: Page): Promise<void> {
  await forgetSession(page);
  await signIn(page, SIGNED_IN_AS, SIGNED_IN_PASSWORD);
}

test("the sidebar signs out and lands on the sign-in screen", async ({ page }) => {
  await ownSession(page);
  await enterWorkspace(page);

  await page.getByTestId("sign-out").click();

  await expect(page.getByTestId("login-username")).toBeVisible();
  // The chat pane is gone, not merely covered: a sign-out that leaves the conversation
  // rendered behind a sign-in form has not really forgotten anything.
  expect(await page.getByTestId("composer-input").count()).toBe(0);
});

test("signing out survives a reload, which is what proves the token went", async ({ page }) => {
  /*
   * The token is in `localStorage`, so the page *could* clear it and lie about the rest — and
   * clearing the store and showing the sign-in screen would look identical either way. The
   * reload is the assertion that separates them: a token still sitting there would sign the
   * user straight back in.
   */
  await ownSession(page);
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("login-username")).toBeVisible();

  await page.reload();

  await expect(page.getByTestId("login-username")).toBeVisible();
  await expect(page.getByTestId("workspace-home")).toHaveCount(0);
});

test("the token is revoked, not merely forgotten", async ({ page, request }) => {
  /*
   * The half a browser cannot see. Signing out revokes the pair server-side, so a copy of it
   * taken beforehand stops working — which is the property that makes sign-out worth anything
   * on a machine somebody else has touched.
   */
  await ownSession(page);

  const before = await page.evaluate(() => window.localStorage.getItem("ila-auth"));
  const token = (JSON.parse(before!) as { refreshToken: string }).refreshToken;
  expect(
    (await request.post("/api/auth/refresh", { data: { refreshToken: token } })).status()
  ).toBe(200);

  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("login-username")).toBeVisible();

  expect(
    (await request.post("/api/auth/refresh", { data: { refreshToken: token } })).status()
  ).toBe(401);
});

test("a different account can sign in afterwards and sees none of the last one's work", async ({
  page,
  request,
}) => {
  // The other half of "forgets everything on the way out": what is left behind must not be
  // visible to whoever signs in next, on a machine two people share.
  await ownSession(page);
  await enterWorkspace(page);

  // A second account, made the way the console makes one — see `ensureUser` for why this goes
  // round the UI rather than through it.
  const password = await ensureUser(request, "someone-else");

  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("login-username")).toBeVisible();

  await signIn(page, "someone-else", password);
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  // A brand-new account has no conversations to show, whatever the previous one was doing.
  await enterWorkspace(page);
  await expect(page.getByTestId("session-item")).toHaveCount(0);
});
