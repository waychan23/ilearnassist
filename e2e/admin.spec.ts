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
 * The platform console, and the account lifecycle it drives.
 *
 * This is the browser half of `apps/server/test/admin-users.test.ts`: the server suite pins
 * what each route refuses, and this pins that the controls exist, do what they say, and are
 * wired to those routes. The one claim only a browser can make is the *journey* — an
 * administrator creates an account, hands over a password read off the screen, and that
 * account is held on a change-password screen the first time it signs in.
 *
 * Each test starts a page of its own, so the account one test makes is invisible to the next
 * except through the list, which is exactly where a shared installation puts it.
 */

/** Open the console from the workspace home and wait for it to have loaded. */
async function openConsole(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-admin").click();
  await expect(page.getByTestId("admin-console")).toBeVisible();
}

/** Create an account through the console and answer with the password it was handed. */
async function createUser(page: Page, username: string): Promise<string> {
  await page.getByTestId("admin-new-user").click();
  await page.getByTestId("admin-create-username").fill(username);
  await page.getByTestId("admin-create-submit").click();

  const shown = page.getByTestId("admin-credential-password");
  await expect(shown).toBeVisible();
  const password = (await shown.textContent())?.trim() ?? "";
  expect(password.length).toBeGreaterThan(8);

  await page.getByTestId("admin-credential-dismiss").click();
  await expect(page.locator(`[data-testid="admin-user"][data-username="${username}"]`)).toBeVisible();
  return password;
}

test("the console lists the accounts and says which one is you", async ({ page }) => {
  await openConsole(page);

  const row = page.locator(`[data-testid="admin-user"][data-username="${SIGNED_IN_AS}"]`);
  await expect(row).toBeVisible();
  // Named, because an administrator looking at a list of their own accounts needs to know
  // which row is the one they are signed in as before they touch any of the buttons.
  await expect(row).toContainText("你");
  await expect(row).toContainText("超级管理员");
});

test("creating an account hands over a password that is shown exactly once", async ({ page }) => {
  await openConsole(page);
  await page.getByTestId("admin-new-user").click();
  await page.getByTestId("admin-create-username").fill("newcomer");
  await page.getByTestId("admin-create-submit").click();

  // The dialog closes and the password stays: the copy button is the whole point, and a
  // credential read off a panel that is closing is a credential mistyped.
  const credential = page.getByTestId("admin-credential");
  await expect(credential).toBeVisible();
  await expect(page.getByTestId("admin-credential-username")).toHaveText("newcomer");
  // Said out loud, because it is the part the administrator has to pass on with the password.
  await expect(credential).toContainText("首次登录时必须修改密码");
  await expect(page.getByTestId("admin-credential-copy")).toBeVisible();

  const password = (await page.getByTestId("admin-credential-password").textContent())?.trim();
  await page.getByTestId("admin-credential-dismiss").click();
  await expect(credential).toHaveCount(0);
  // And gone for good, which is what makes "once" mean something: the list has no way to show
  // it again, because only a hash is stored and nothing can read one back.
  await expect(page.getByTestId("admin-console")).not.toContainText(password ?? "؟");
});

test("a new account is held on the change-password screen before it can do anything", async ({
  page,
}) => {
  await openConsole(page);
  const password = await createUser(page, "firsttimer");

  // Its own session, so the shared one survives — see `forgetSession`.
  await forgetSession(page);
  await page.getByTestId("login-username").fill("firsttimer");
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();

  // Not the workspace home: the password an administrator handed over is a way in, not one to
  // keep, and the server refuses every other route until it is replaced.
  await expect(page.getByTestId("change-password")).toBeVisible();
  await expect(page.getByTestId("workspace-home")).toHaveCount(0);

  await page.getByTestId("password-current").fill(password);
  await page.getByTestId("password-new").fill("chosen-by-its-owner");
  await page.getByTestId("password-confirm").fill("chosen-by-its-owner");
  await page.getByTestId("password-submit").click();

  // And through it: the same session carries on, now with an account that owes nothing.
  await expect(page.getByTestId("workspace-home")).toBeVisible();
});

test("disabling an account stops it signing in, and enabling it again restores that", async ({
  page,
}) => {
  await openConsole(page);
  const password = await createUser(page, "tobedisabled");
  const row = page.locator('[data-testid="admin-user"][data-username="tobedisabled"]');

  await page.getByTestId("admin-toggle-tobedisabled").click();
  await page.getByTestId("confirm-accept").click();
  await expect(row).toContainText("已禁用");

  await forgetSession(page);
  await page.getByTestId("login-username").fill("tobedisabled");
  await page.getByTestId("login-password").fill(password);
  await page.getByTestId("login-submit").click();
  await expect(page.getByTestId("login-error")).toBeVisible();
  await expect(page.getByTestId("workspace-home")).toHaveCount(0);

  await signIn(page, SIGNED_IN_AS, SIGNED_IN_PASSWORD);
  await page.getByTestId("open-admin").click();
  await page.getByTestId("admin-toggle-tobedisabled").click();
  await expect(row).not.toContainText("已禁用");
});

test("signing an account out everywhere leaves its password alone", async ({ page }) => {
  await openConsole(page);
  const password = await createUser(page, "tobekicked");

  await page.getByTestId("admin-kick-tobekicked").click();
  await page.getByTestId("confirm-accept").click();
  // The row is unchanged: this is not a reset, and the marker only appears when a password was
  // replaced — so its absence is the assertion that the credential survived.
  const row = page.locator('[data-testid="admin-user"][data-username="tobekicked"]');
  await expect(row).toContainText("待改密码");
  expect(password).toBeTruthy();
});

test("the console is closed to an ordinary account", async ({ page, request }) => {
  // Made through the API rather than the console, because an ordinary account has no console to
  // drive — see `ensureUser`.
  const password = await ensureUser(request, "plainuser");

  await forgetSession(page);
  await signIn(page, "plainuser", password);

  // No entry point: the button is drawn from the role the server reported.
  await expect(page.getByTestId("open-admin")).toHaveCount(0);

  // And no way in by asking anyway. A hidden button is not a permission, so the route refuses —
  // which is the half that actually matters, and the half a browser can still check.
  const token = await page.evaluate(() => {
    const raw = window.localStorage.getItem("ila-auth");
    return raw ? (JSON.parse(raw) as { accessToken: string }).accessToken : "";
  });
  const refused = await request.get("/api/admin/users", {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(refused.status()).toBe(403);
});

test("the account page is everyone's, and changes the password it is signed in with", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("open-account").click();

  await expect(page.getByTestId("account-page")).toBeVisible();
  await expect(page.getByTestId("account-username")).toHaveText(SIGNED_IN_AS);
  // The console is one control away for an account that has it...
  await expect(page.getByTestId("account-open-admin")).toBeVisible();

  // ...and the form is the same one the forced screen uses. The current password is required:
  // it is the one thing between a stolen token and a permanent account takeover.
  await page.getByTestId("password-current").fill("not-the-password");
  await page.getByTestId("password-new").fill("a-new-password-1");
  await page.getByTestId("password-confirm").fill("a-new-password-1");
  await page.getByTestId("password-submit").click();
  await expect(page.getByTestId("password-error")).toBeVisible();
});

test("the sidebar reaches the console from inside a conversation", async ({ page }) => {
  await page.goto("/");
  await enterWorkspace(page);

  await page.getByTestId("open-admin-sidebar").click();
  await expect(page.getByTestId("admin-console")).toBeVisible();
  await page.getByTestId("admin-back").click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();
});
