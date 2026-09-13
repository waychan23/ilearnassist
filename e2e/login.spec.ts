import { expect, test } from "./fixtures";
import { SIGNED_IN_AS, SIGNED_IN_PASSWORD, signIn } from "./auth.js";

/**
 * The sign-in screen, from a browser that has no session.
 *
 * This is the only file in the suite that starts signed out. `test.use` at file scope clears
 * the browser state the setup project saved, and the other projects never see this override —
 * which is the reason it is a file of its own rather than a `describe` inside one of the
 * others: a file-level `test.use` cannot be inherited by accident from a neighbouring block.
 *
 * There is no create-account screen in the web app at all: the first administrator is made
 * by the control panel's one-shot CLI with the server stopped, and the Playwright config
 * chains `cli ensure-admin` ahead of the server. What is left for a signed-out browser is
 * exactly the sign-in form this file covers.
 *
 * Everything here is about the app's front door, so the assertions are about what a person
 * sees rather than about the API — the server's side of this is covered in
 * `apps/server/test/auth.test.ts`.
 */

test.use({ storageState: { cookies: [], origins: [] } });

test.describe("with no session", () => {
  test("shows the sign-in form rather than a blank page or the workspace list", async ({
    page,
  }) => {
    await page.goto("/");

    await expect(page.getByTestId("login-form")).toBeVisible();
    // The app withholds *both* views until `/api/auth/me` has answered, so this is not only
    // "the sign-in form is up" but "that gate resolved, and resolved here".
    await expect(page.getByTestId("workspace-home")).toHaveCount(0);
    // And it is the sign-in form, not the first-run one: this installation has an account.
    await expect(page.getByTestId("login-confirm")).toHaveCount(0);
  });

  test("asks for a password in a field that hides it", async ({ page }) => {
    // Not decoration. The build this replaced had no password at all and said so on the
    // screen; a name field with nothing behind it now would be a form that cannot work.
    await page.goto("/");
    await expect(page.getByTestId("login-password")).toHaveAttribute("type", "password");
  });

  test("refuses to submit an empty name", async ({ page }) => {
    await page.goto("/");
    // Disabled rather than rejected after the fact: there is nothing to say about a name the
    // user has not typed, and an error message for it would be noise on first sight.
    await expect(page.getByTestId("login-submit")).toBeDisabled();
  });

  test("reports a wrong password next to the form, and does not sign anyone in", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTestId("login-username").fill(SIGNED_IN_AS);
    await page.getByTestId("login-password").fill("not-the-password");
    await page.getByTestId("login-submit").click();

    // On the form rather than in the toast: the user is looking at these fields, and the
    // answer to "that password is wrong" belongs beside the one it is about.
    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page.getByTestId("workspace-home")).toHaveCount(0);
  });

  test("says nothing about which accounts exist", async ({ page }) => {
    // The list of names this screen used to offer is gone with the no-password build it
    // belonged to: with a password behind each one, a list of accounts is half a login.
    await page.goto("/");
    await expect(page.getByTestId("login-users")).toHaveCount(0);
  });

  test("signs in and stays signed in across a reload", async ({ page }) => {
    // What the stored token is for. Without it the app would ask again on every refresh, and
    // the workspace list would never be reachable for longer than one page view.
    await signIn(page, SIGNED_IN_AS, SIGNED_IN_PASSWORD);

    await page.reload();
    await expect(page.getByTestId("workspace-home")).toBeVisible();
    await expect(page.getByTestId("login-form")).toHaveCount(0);
  });
});
