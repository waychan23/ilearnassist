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
 * Create a Copilot through Settings → Copilots.
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
  await page.getByTestId("open-settings").click();
  await page.getByTestId("new-copilot").click();

  await page.getByPlaceholder("例如：代码助手").fill(name);
  await page.getByPlaceholder("定义这个 Copilot 的角色、能力与行为约束…").fill(systemPrompt);
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
  await page.getByTestId("close-settings").click();

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

  await page.getByTestId("open-settings").click();

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
  await page.getByTestId("open-settings").click();
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
  await page.getByTestId("close-settings").click();

  // Start a conversation from it. The Copilot is chosen here and never again.
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("copilot-option").filter({ hasText: NAME }).click();
  await page.getByTestId("create-session").click();

  // The badge names the persona from the conversation's own copy of the name.
  await expect(page.getByTestId("copilot-tag")).toContainText(NAME);

  // Now change the Copilot it came from. Scoped to its own row, because the specs in this file
  // share one server and the earlier one left Copilots behind.
  await page.getByTestId("open-settings").click();
  await page.getByTestId(`copilot-row-${NAME}`).getByTestId("edit-copilot").click();
  await page.getByPlaceholder("定义这个 Copilot 的角色、能力与行为约束…").fill(AFTER);
  await page.getByTestId("save-copilot").click();
  await page.getByTestId("close-settings").click();

  // The conversation is unmoved. This is the promise the settings copy makes in so many
  // words, and the one a live-read prompt used to break while the copy said otherwise.
  await page.getByTestId("open-session-settings").click();
  await expect(page.getByTestId("session-prompt")).toHaveValue(BEFORE);
});
