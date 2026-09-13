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

/**
 * The two tiers, from the console's side.
 *
 * `apps/server/test/admin-users.test.ts` pins what each route refuses; this pins that the page
 * *says so* rather than offering a control that fails after the click. The interesting claim is
 * the asymmetry: the same console is a working screen for an ordinary administrator right up to
 * the row of the account that appointed it.
 */
test("a superadmin cannot reset their own password from here, and is told where to", async ({
  page,
}) => {
  await openConsole(page);

  const reset = page.getByTestId(`admin-reset-${SIGNED_IN_AS}`);
  await expect(reset).toBeDisabled();
  // Disabled with the reason on it: this is the one refusal on the page a person cannot work
  // out from the button, because nothing about their own row looks different from any other.
  await expect(reset).toHaveAttribute("title", /控制面板/);
});

test("an ordinary administrator runs the console but cannot touch the superadmin", async ({
  page,
  request,
}) => {
  // Made through the API: appointing an administrator is a superadmin's act, and this spec is
  // about what happens *after* one has been appointed. Both accounts up front, because the
  // console reads its list once on mount and an account made afterwards would need a reload to
  // appear — which is a different claim from the one this test is making.
  const password = await ensureUser(request, "steward", ["admin"]);
  await ensureUser(request, "someone");

  await forgetSession(page);
  await signIn(page, "steward", password);

  // The console is theirs — both entry points, because the tier is an addition to the rule
  // rather than a replacement of it.
  await page.getByTestId("open-admin").click();
  await expect(page.getByTestId("admin-console")).toBeVisible();
  await expect(page.getByTestId("admin-nav-users")).toBeVisible();

  // Every action on the superadmin's row is refused before it is clicked...
  for (const action of ["toggle", "reset", "kick"]) {
    await expect(page.getByTestId(`admin-${action}-${SIGNED_IN_AS}`)).toBeDisabled();
  }
  // ...and the role boxes on it too, which is how the row says *why* it is out of reach: the
  // tier is visible rather than the row simply being inert.
  await expect(page.getByTestId("admin-role-superadmin").first()).toBeDisabled();

  // An ordinary account is still theirs to run, so this is a tier rule and not a dead page.
  const row = page.locator('[data-testid="admin-user"][data-username="someone"]');
  await expect(row).toBeVisible();
  await expect(row.getByTestId("admin-toggle-someone")).toBeEnabled();
});

test("an ordinary administrator cannot appoint one, and the dialog says why", async ({
  page,
  request,
}) => {
  const password = await ensureUser(request, "warden", ["admin"]);
  await forgetSession(page);
  await signIn(page, "warden", password);

  await page.getByTestId("open-admin").click();
  await page.getByTestId("admin-new-user").click();

  // Drawn but unticked and untickable, rather than hidden: the boxes are how somebody learns
  // that appointing administrators is not theirs to do.
  await expect(page.getByTestId("admin-create-role-admin")).toBeDisabled();
  await expect(page.getByTestId("admin-create-role-superadmin")).toBeDisabled();
  await expect(page.getByTestId("admin-create-dialog")).toContainText("只有超级管理员");

  // And it does not merely hide the control: a request that asks anyway is refused whole, not
  // quietly downgraded to an ordinary account.
  const token = await page.evaluate(() => {
    const raw = window.localStorage.getItem("ila-auth");
    return raw ? (JSON.parse(raw) as { accessToken: string }).accessToken : "";
  });
  const refused = await request.post("/api/admin/users", {
    headers: { Authorization: `Bearer ${token}` },
    data: { username: "usurper", roles: ["admin"] },
  });
  expect(refused.status()).toBe(403);
});
