import { expect, test } from "@playwright/test";
import { SIGNED_IN_AS, signIn } from "./auth.js";

/**
 * The login screen, from a browser that has no session.
 *
 * This is the only file in the suite that starts signed out. `test.use` at file scope clears
 * the cookie the setup project saved, and the other projects never see this override — which
 * is the reason it is a file of its own rather than a `describe` inside one of the others: a
 * file-level `test.use` cannot be inherited by accident from a neighbouring block.
 *
 * Everything here is about the app's front door, so the assertions are about what a person
 * sees rather than about the API — the server's side of this is covered in
 * `apps/server/test/auth.test.ts`.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("with no session", () => {
  test("shows the login screen rather than a blank page or the workspace list", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("login-form")).toBeVisible();
    // The app withholds *both* views until `/api/auth/me` has answered, so this is not only
    // "the login screen is up" but "that gate resolved, and resolved here".
    await expect(page.getByTestId("workspace-home")).toHaveCount(0);
  });

  test("says that this instance has no passwords", async ({ page }) => {
    // The one claim on this screen that a user could otherwise get wrong in a way that hurts
    // them: a field that looks like a password prompt reads as a privacy guarantee.
    await page.goto("/");
    await expect(page.getByTestId("login-form")).toContainText("没有设置密码");
  });

  test("offers the accounts that already exist, and fills the field from one", async ({
    page,
  }) => {
    // The setup project signed in as this account, so it exists by the time this runs.
    await page.goto("/");

    const chip = page.getByTestId("login-users").getByRole("button", { name: SIGNED_IN_AS });
    await expect(chip).toBeVisible();

    await chip.click();
    await expect(page.getByTestId("login-username")).toHaveValue(SIGNED_IN_AS);
  });

  test("refuses an empty name rather than creating an account called nothing", async ({
    page,
  }) => {
    await page.goto("/");
    // Disabled rather than rejected after the fact: there is nothing to say about a name the
    // user has not typed, and an error message for it would be noise on first sight.
    await expect(page.getByTestId("login-submit")).toBeDisabled();
  });

  test("signs in and stays signed in across a reload", async ({ page }) => {
    // What the cookie is for. Without it the app would ask again on every refresh, and the
    // workspace list would never be reachable for longer than one page view.
    await signIn(page, SIGNED_IN_AS);

    await page.reload();
    await expect(page.getByTestId("workspace-home")).toBeVisible();
    await expect(page.getByTestId("login-form")).toHaveCount(0);
  });

  test("creates the account when the name is new", async ({ page }) => {
    // The same route does both, which is what makes a fresh installation usable with no setup
    // step: there is no registration screen because there is nothing to register.
    await signIn(page, "someone-else");
    await expect(page.getByTestId("workspace-home")).toBeVisible();
  });
});
