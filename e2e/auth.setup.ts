import { expect, test as setup } from "@playwright/test";
import { AUTH_STATE, SIGNED_IN_AS, SIGNED_IN_PASSWORD } from "./auth.js";

/**
 * Sign in once, for the whole suite.
 *
 * The administrator is *not* created in the browser any more: the web app cannot create
 * accounts, and the server refuses to start without one. `playwright.config.ts` chains
 * `cli ensure-admin` ahead of the server's own command, so by the time this runs the
 * installation has exactly the administrator whose credentials live in `auth.ts`.
 *
 * A project dependency rather than `globalSetup`, and not by preference: a `globalSetup` may
 * run before the `webServer` entries are up, and this has to talk to one. `dependencies` is
 * ordered after them by construction, so there is nothing to race.
 *
 * What it leaves behind is browser state — the token pair — which every other project loads
 * through `storageState`. That is what keeps the ~70 specs that are *not* about authentication
 * from having to know it exists.
 */
setup("signs in and saves the session", async ({ page }) => {
  await page.goto("/");

  // The one screen that exists on a running server: a sign-in form, and not a create-account
  // form. The first-run screen moved to the control panel, which runs with the server stopped.
  await expect(page.getByTestId("login-form")).toBeVisible();
  await expect(page.getByTestId("login-confirm")).toHaveCount(0);

  await page.getByTestId("login-username").fill(SIGNED_IN_AS);
  await page.getByTestId("login-password").fill(SIGNED_IN_PASSWORD);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  // The token survives a reload, which is what makes it a session rather than a state this tab
  // happens to be holding — and the assertion that the stored pair is being read back.
  await page.reload();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await expect(page.getByTestId("login-form")).toHaveCount(0);

  await page.context().storageState({ path: AUTH_STATE });
});
