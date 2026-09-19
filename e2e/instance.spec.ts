import { AUTH_STORAGE_KEY, INSTANCE_STORAGE_KEY } from "./auth.js";
import { expect, test } from "./fixtures";

/**
 * Which installation is behind this origin.
 *
 * The failure this exists for is a *switch*: the desktop panel's data-root picker restarts the
 * server on the same port, so a tab that was already open comes back to a different database
 * holding a token that means nothing there and a URL naming a workspace that never existed in it.
 * The reported symptom is a 会话不存在 toast on a page the reader did nothing to reach.
 *
 * The suite runs against one server and cannot restart it on another data root, so a switch is
 * *staged* the way a reader would experience one: the browser is left holding an id that is not
 * the server's, which is exactly the state the picker leaves it in. What is being tested is the
 * client's answer to that state, and the two things it does about it.
 *
 * `apps/web/test/composables/instance.test.ts` pins the same decisions against a mocked client,
 * including the cases a browser here cannot reach; what is only reachable from here is that the
 * check really does run **before the token is used** — the whole point, and the thing a unit test
 * cannot see, since it is an ordering in `main.ts`.
 */

test("a stale installation's token and address are dropped before anything reads them", async ({
  page,
}) => {
  await page.goto("/");
  // Signed in by the suite's storage state, which is the premise: there *is* a token to lose.
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  // Stage the switch: this browser last talked to somebody else.
  await page.evaluate(
    ([key, authKey]) => {
      localStorage.setItem(key!, "an-installation-that-is-not-this-one");
      // ...and the address belongs to it too, which is what the reader would be looking at.
      localStorage.setItem(
        authKey!,
        JSON.stringify({ accessToken: "stale", refreshToken: "stale" })
      );
    },
    [INSTANCE_STORAGE_KEY, AUTH_STORAGE_KEY]
  );
  await page.goto("/w/does-not-exist/s/does-not-exist");

  // The sign-in screen: the token was dropped rather than sent and 401'd, so the reader is told
  // what happened rather than being walked through the failure of a credential they cannot see.
  await expect(page.getByTestId("login-form")).toBeVisible();

  // And the address is gone, which is the half that survives the sign-in otherwise: the guard
  // carries a `?redirect=` back, and this one would land on a workspace that never existed.
  expect(new URL(page.url()).pathname).toBe("/login");
  expect(new URL(page.url()).search).toBe("");

  // The new id was recorded on the way through, so the *next* switch is detectable too.
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), INSTANCE_STORAGE_KEY))
    .not.toBe("an-installation-that-is-not-this-one");
});

test("an unchanged installation leaves the session exactly where it was", async ({ page }) => {
  /*
   * The other side, and the one that would be a disaster to get wrong: a reload that signed
   * everybody out would be worse than the bug this fixes. The suite's own tab is that case — it
   * has been talking to this server all along.
   */
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
});
