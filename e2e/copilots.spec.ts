import { expect, test, type Page } from "./fixtures";
import { ensureUser, forgetSession, signIn } from "./auth";
import { enterWorkspace } from "./workspaces";

/**
 * Copilots, which had no browser coverage at all before this file.
 *
 * The two claims worth proving in a browser are the ones a unit test cannot make: that a
 * Copilot one account publishes is genuinely reachable by another account — and genuinely not
 * editable by it — and that a conversation's persona survives the Copilot it came from being
 * changed afterwards. The server suite pins the mechanism for both; this pins that the UI
 * exists and is wired to it.
 */

/**
 * Create a Copilot through the Copilot list.
 *
 * The field placeholders are the catalog's own strings, which the suite pins to `zh-CN`, so
 * they select the field rather than a test id — the same way the parser spec fills its form.
 */
async function createCopilot(
  page: Page,
  name: string,
  systemPrompt: string,
  { publish = false } = {}
): Promise<void> {
  await page.getByTestId("open-copilots").click();
  await page.getByTestId("new-copilot").click();

  await page.getByPlaceholder("例如：代码助手").fill(name);
  await page.getByPlaceholder("定义这个助理的角色、能力与行为约束…").fill(systemPrompt);
  if (publish) await page.getByTestId("copilot-public").check();
  await page.getByTestId("save-copilot").click();

  await expect(page.getByTestId(`copilot-row-${name}`)).toBeVisible();
}

test("a published Copilot is usable by another account, and not editable by it", async ({
  page,
  request,
}) => {
  const NAME = "共享助教";
  const PROMPT = "只讲重点，一次不超过三句话。";

  await page.goto("/");
  await createCopilot(page, NAME, PROMPT, { publish: true });
  await page.getByTestId("close-copilots").click();

  /*
   * A second account, starting from no session at all.
   *
   * The inherited one is released locally and a session of the second account's own takes its
   * place — a second browser context is not an option, because one built by hand does not
   * inherit the project's `locale: "zh-CN"`, and every selector below (and the plain fact that
   * the app renders Chinese) depends on it.
   *
   * `ensureUser` rather than a dialog: an account can only be made from the console now, and a
   * spec that needs a second one should not have to drive a form to get it.
   */
  const password = await ensureUser(request, "learner");
  await forgetSession(page);
  await signIn(page, "learner", password);

  await page.getByTestId("open-copilots").click();

  const published = page.getByTestId(`copilot-row-${NAME}`);
  await expect(published).toBeVisible();
  // Attributed, because picking someone else's wording is the moment whose it is matters.
  await expect(published).toContainText("tester");

  // Exactly one action, and it is "copy to mine". A row with an edit or delete button here
  // would mean "you may use it but not change it" had stopped being true.
  await expect(published.getByRole("button")).toHaveCount(1);
  await expect(page.getByTestId(`copy-copilot-${NAME}`)).toBeVisible();

  // The prompt is readable before it is chosen — a persona you cannot inspect is not a choice.
  await published.getByText("查看它的设定").click();
  await expect(published.locator("pre")).toHaveText(PROMPT);

  // Forking it into an editable copy is the escape hatch, and it lands under "mine".
  await page.getByTestId(`copy-copilot-${NAME}`).click();
  await expect(page.getByTestId(`copilot-row-${NAME}`)).toHaveCount(2);
  await expect(page.getByTestId("edit-copilot")).toHaveCount(1);
  // Only the published one still offers to copy: the fork is now an ordinary own Copilot.
  await expect(page.getByTestId(`copy-copilot-${NAME}`)).toHaveCount(1);
});

test("a Copilot can be locked down to no tools, and it survives the round trip", async ({
  page,
}) => {
  const NAME = "无工具助手";
  const BOX = (name: string) => page.getByTestId(`tool-check-${name}`).locator("input");

  await page.goto("/");
  await page.getByTestId("open-copilots").click();
  await page.getByTestId("new-copilot").click();
  await page.getByPlaceholder("例如：代码助手").fill(NAME);

  // "All tools" is on out of the box, and every box reads as ticked because that is what it
  // means — the flag is the state, not the list.
  await expect(page.getByTestId("copilot-all-tools")).toBeChecked();
  await expect(BOX("read_file")).toBeChecked();
  await expect(BOX("delete_file")).toBeChecked();

  // Unticking one box is how "everything except this" is said: the flag comes off and the rest
  // stay ticked, so a Copilot that may read but not delete is one click away.
  await BOX("delete_file").click();
  await expect(page.getByTestId("copilot-all-tools")).not.toBeChecked();
  await expect(BOX("read_file")).toBeChecked();
  await expect(BOX("delete_file")).not.toBeChecked();

  // Ticking the flag back on restores everything, including the box just cleared — the flag
  // means every tool, not "the ones left in the list".
  await page.getByTestId("copilot-all-tools").click();
  await expect(page.getByTestId("copilot-all-tools")).toBeChecked();
  await expect(BOX("delete_file")).toBeChecked();

  // And clearing the flag reaches the state that used not to exist at all: no tools, rather
  // than the every-tool reading an empty selection used to get.
  await page.getByTestId("copilot-all-tools").click();
  await expect(page.getByTestId("copilot-all-tools")).not.toBeChecked();
  await expect(BOX("read_file")).not.toBeChecked();
  await expect(BOX("delete_file")).not.toBeChecked();

  await page.getByTestId("save-copilot").click();

  // Read back from the server, not from the form: the row's digest proves the flag came back as
  // false with an empty list rather than being flattened to "no restriction".
  const row = page.getByTestId(`copilot-row-${NAME}`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("不使用工具");
});

test("a conversation keeps the prompt it was started with when the Copilot changes", async ({
  page,
}) => {
  const NAME = "快照助教";
  const BEFORE = "只回答一句话。";
  const AFTER = "请尽可能长篇大论。";

  await page.goto("/");
  await createCopilot(page, NAME, BEFORE);
  await page.getByTestId("close-copilots").click();

  // Start a conversation from it. The Copilot is chosen here and never again.
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("copilot-option").filter({ hasText: NAME }).click();
  await page.getByTestId("create-session").click();

  // The badge names the persona from the conversation's own copy of the name.
  await expect(page.getByTestId("copilot-tag")).toContainText(NAME);

  // Now change the Copilot it came from. Scoped to its own row, because the specs in this file
  // share one server and the earlier one left Copilots behind.
  await page.getByTestId("open-copilots").click();
  await page.getByTestId(`copilot-row-${NAME}`).getByTestId("edit-copilot").click();
  await page.getByPlaceholder("定义这个助理的角色、能力与行为约束…").fill(AFTER);
  await page.getByTestId("save-copilot").click();
  await page.getByTestId("close-copilots").click();

  // The conversation is unmoved. This is the promise the Copilot dialog's copy makes in so
  // many words, and the one a live-read prompt used to break while the copy said otherwise.
  await page.getByTestId("open-session-settings").click();
  await expect(page.getByTestId("session-prompt")).toHaveValue(BEFORE);
});

test("both entry points reach the Copilot list", async ({ page }) => {
  /*
   * Two doors to one dialog, and each is load-bearing rather than a convenience.
   *
   * The home page has no sidebar, so its header button is the only way to manage the Copilots
   * you made *before* entering a workspace — which is the access this suite has guarded since
   * the dialog lived behind a "settings" gear. The sidebar's footer row is the one you reach
   * from inside a conversation. Neither can be dropped for the other, so both are asserted
   * here rather than one being left to a comment.
   */
  await page.goto("/");
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  await page.getByTestId("open-copilots").click();
  await expect(page.locator("body > .modal-overlay")).toBeVisible();
  await expect(page.getByTestId("new-copilot")).toBeVisible();
  await page.getByTestId("close-copilots").click();

  // The footer row, on the other side of the front door. `enterWorkspace` takes the first card,
  // which is where the suite's own earlier tests left one.
  await enterWorkspace(page);
  await page.getByTestId("open-copilots").click();
  await expect(page.locator("body > .modal-overlay")).toBeVisible();
  await expect(page.getByTestId("new-copilot")).toBeVisible();
});

/**
 * The assistant a new installation ships with.
 *
 * The product claim is not "a row exists" — that is a server test — it is that an account which
 * did not create it can **find it and start a conversation with it**, with the seven study
 * widgets already installed. That is the whole of what `public` buys, and it is the part no unit
 * test can check: the row belongs to the administrator, so the owner's own view would show it
 * whether or not the visibility arm worked.
 */
test("the built-in assistant is usable by an account that does not own it", async ({
  page,
  request,
}) => {
  const NAME = "引导学习";
  const WIDGETS = ["plan", "quiz", "thread", "notes", "diagram", "insight", "sources"];

  // The owner's view first: the administrator owns it, so it is an ordinary editable row of
  // their own rather than something to copy.
  await page.goto("/");
  await page.getByTestId("open-copilots").click();
  const owned = page.getByTestId(`copilot-row-${NAME}`);
  await expect(owned).toBeVisible();
  await expect(owned.getByTestId("edit-copilot")).toHaveCount(1);
  await expect(page.getByTestId(`copy-copilot-${NAME}`)).toHaveCount(0);
  await page.getByTestId("close-copilots").click();

  // A second account. `ensureUser` is idempotent, and the name is this spec's own so the
  // result does not depend on which other test ran first.
  const password = await ensureUser(request, "guided-learner");
  await forgetSession(page);
  await signIn(page, "guided-learner", password);

  await page.getByTestId("open-copilots").click();
  const published = page.getByTestId(`copilot-row-${NAME}`);
  // Visible at all is the assertion: the read predicate is
  // `user_id = ? OR visibility = 'public'`, and a private built-in would simply not be here.
  await expect(published).toBeVisible();
  // Attributed, because choosing someone else's wording is when whose it is matters.
  await expect(published).toContainText("tester");
  await page.getByTestId("close-copilots").click();

  // And usable: a conversation started from it comes with the study widgets installed.
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page
    .getByTestId("copilot-option")
    .filter({ hasText: NAME })
    .locator("input")
    .check();
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();

  await page.getByTestId("chat-session-settings").click();
  for (const id of WIDGETS) {
    // `aria-pressed`, not visibility: the list renders every widget at this scope, so an
    // "installed" claim that only checked presence would pass for an assistant that installs
    // nothing. A widget listed but off is a panel the tutor asks you to read and never draws.
    await expect(page.getByTestId(`session-widget-toggle-${id}`)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  }
});
