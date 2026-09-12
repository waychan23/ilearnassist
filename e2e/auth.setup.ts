import { test as setup } from "@playwright/test";
import { AUTH_STATE, SIGNED_IN_AS, signIn } from "./auth.js";

/**
 * Sign in once, for the whole suite.
 *
 * A project dependency rather than `globalSetup`, and not by preference: a `globalSetup` may
 * run before the `webServer` entries are up, and this has to talk to one. `dependencies` is
 * ordered after them by construction, so there is nothing to race.
 *
 * What it leaves behind is browser state — the session cookie — which every other project
 * loads through `storageState`. That is what keeps the ~70 specs that are *not* about
 * authentication from having to know it exists.
 */
setup("sign in", async ({ page }) => {
  await signIn(page, SIGNED_IN_AS);
  await page.context().storageState({ path: AUTH_STATE });
});
