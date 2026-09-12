import { expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Signing in, for the browser suite.
 *
 * Every spec needs a session — the API refuses everything without one — and almost none of
 * them are *about* sessions. So the sign-in happens once, in a setup project, and its result
 * is handed to every other project as browser state: no spec has to know how a cookie is
 * obtained, and `workspaces.ts`'s front door is unchanged.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Where the signed-in state is written, and read back.
 *
 * Under `.e2e/`, which `global-teardown.ts` removes — so a stale cookie cannot survive into
 * the next run, and a run that fails before the setup project cannot inherit one from the
 * run before it.
 */
export const AUTH_STATE = join(ROOT, ".e2e", "auth.json");

/**
 * The account every spec acts as.
 *
 * Invented here rather than configured, because there is nothing to configure: the first
 * sign-in *creates* the account. Fixed rather than random so a failure names something a
 * person can type into the login screen and reproduce.
 */
export const SIGNED_IN_AS = "tester";

/**
 * Sign in through the real form, and wait until the app is actually in.
 *
 * Shared with `login.spec.ts`, which is the point: the spec that proves the form works is
 * exercising the same path every other spec depends on, so the two cannot drift apart.
 */
export async function signIn(page: Page, username: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("login-username").fill(username);
  await page.getByTestId("login-submit").click();
  // The workspace home is the app's own signal that the session took: it only renders once
  // `/api/auth/me` has answered, and it is the page every spec's front door starts on.
  await expect(page.getByTestId("workspace-home")).toBeVisible();
}
