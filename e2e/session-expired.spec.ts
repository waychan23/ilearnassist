import { expect, test, type APIRequestContext } from "./fixtures";
import {
  ensureUser,
  forgetSession,
  SIGNED_IN_AS,
  SIGNED_IN_PASSWORD,
  signIn,
} from "./auth.js";
import { enterWorkspace } from "./workspaces";

/**
 * A session revoked from outside the tab.
 *
 * The console's "kick" ends every token the account holds, so the tab's next request answers
 * 401 and its refresh token is spent too. What the app must do then is universal — the same
 * global handler covers every authenticated page — and these tests pin the two ways it used
 * to go wrong: an optimistic navigation whose `catch` navigated *back* into the page it had
 * just been torn away from (entering a workspace), and a turn sent from a conversation.
 *
 * Every test acts as its own ordinary account rather than the shared administrator: kicking
 * that one would revoke the `storageState` session every later spec relies on, the same rule
 * `sign-out.spec.ts` is built around.
 */

const VICTIM = "kicked-user";

/** Sign in as the administrator over the API and end every session of one account. */
async function kickUser(request: APIRequestContext, username: string): Promise<void> {
  const login = await request.post("/api/auth/login", {
    data: { username: SIGNED_IN_AS, password: SIGNED_IN_PASSWORD },
  });
  expect(login.ok(), "the administrator signs in over the API").toBeTruthy();
  const adminToken = ((await login.json()) as { tokens: { accessToken: string } }).tokens
    .accessToken;
  const auth = { headers: { Authorization: `Bearer ${adminToken}` } };

  const list = await request.get("/api/admin/users", auth);
  expect(list.ok(), "the administrator lists accounts").toBeTruthy();
  const users = (await list.json()) as { users: Array<{ id: string; username: string }> };
  const victim = users.users.find((u) => u.username === username);
  expect(victim, `the "${username}" account exists`).toBeTruthy();

  const revoked = await request.post(`/api/admin/users/${victim!.id}/revoke`, auth);
  expect(revoked.ok(), "the kick succeeds").toBeTruthy();
}

test.describe("a kicked session", () => {
  test("entering a workspace after the kick lands on the sign-in screen, not an empty chat", async ({
    page,
    request,
  }) => {
    await forgetSession(page);
    const password = await ensureUser(request, VICTIM);
    await signIn(page, VICTIM, password);
    await expect(page.getByTestId("workspace-home")).toBeVisible();

    await kickUser(request, VICTIM);

    // The click optimistically paints the chat pane before the session list loads — the bug
    // was the failure handler painting it again after the global 401 handler had left.
    await page.getByTestId("workspace-open").first().click();

    await expect(page.getByTestId("login-form")).toBeVisible();
    // The chat pane is gone, not merely covered by the form.
    await expect(page.getByTestId("composer-input")).toHaveCount(0);
    // The toast says why.
    await expect(page.locator(".toast")).toContainText("登录已失效");

    // A real sign-in screen rather than a flash: the refresh token is spent, so a reload
    // answers 401 and stays here.
    await page.reload();
    await expect(page.getByTestId("login-form")).toBeVisible();
    await expect(page.getByTestId("workspace-home")).toHaveCount(0);
  });

  test("sending a message after the kick is refused and the reader is sent to sign in", async ({
    page,
    request,
  }) => {
    await forgetSession(page);
    const password = await ensureUser(request, VICTIM);
    await signIn(page, VICTIM, password);
    await enterWorkspace(page);

    await kickUser(request, VICTIM);

    await page.getByTestId("composer-input").fill("被踢下线之后再发消息");
    await page.getByTestId("composer-send").click();

    await expect(page.getByTestId("login-form")).toBeVisible();
    await expect(page.getByTestId("composer-input")).toHaveCount(0);
  });
});
