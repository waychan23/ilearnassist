import { expect, test } from "@playwright/test";
import { enterWorkspace } from "./workspaces";

/**
 * Signing out, from the two places the control lives.
 *
 * Unlike `login.spec.ts` this file *wants* the inherited session — the point is to have one to
 * give up — so it is a file of its own rather than a `describe` inside that one, whose
 * file-scoped `storageState` override would otherwise be inherited here and leave nothing to
 * sign out of.
 *
 * Each test gets a fresh browser context loaded from the saved state, so one test signing out
 * cannot sign out the next one.
 */

test("the sidebar signs out and lands on the login screen", async ({ page }) => {
  await page.goto("/");
  await enterWorkspace(page);

  await page.getByTestId("sign-out").click();

  await expect(page.getByTestId("login-username")).toBeVisible();
  // The chat pane is gone, not merely covered: a sign-out that leaves the conversation
  // rendered behind a login form has not really forgotten anything.
  expect(await page.getByTestId("composer-input").count()).toBe(0);
});

test("signing out survives a reload, which is what proves the cookie went", async ({ page }) => {
  /*
   * The session is an HttpOnly cookie, so the page cannot clear it and cannot see whether the
   * server did. Clearing the store and showing the login screen would look identical either
   * way — and a reload would quietly sign the user back in. That reload is the assertion.
   */
  await page.goto("/");
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("login-username")).toBeVisible();

  await page.reload();

  await expect(page.getByTestId("login-username")).toBeVisible();
  await expect(page.getByTestId("workspace-home")).toHaveCount(0);
});

test("a different account can sign in afterwards and sees none of the last one's work", async ({
  page,
}) => {
  // The other half of "forgets everything on the way out": what is left behind must not be
  // visible to whoever signs in next, on a machine two people share.
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("sign-out").click();
  await expect(page.getByTestId("login-username")).toBeVisible();

  await page.getByTestId("login-username").fill("someone-else");
  await page.getByTestId("login-submit").click();

  await expect(page.getByTestId("workspace-home")).toBeVisible();
  // A brand-new account has no conversations to show, whatever the previous one was doing.
  await enterWorkspace(page);
  await expect(page.getByTestId("session-item")).toHaveCount(0);
});
