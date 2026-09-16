import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The thread widget end to end: installed into a conversation, the post-turn classifier
 * splits three unrelated turns into three 其他 threads, and clicking a thread scrolls the
 * conversation back to where it began. Plus the study-pack group installing/removing all
 * three session widgets from session settings as one action.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/** A long reply so three turns overflow the message list and a scroll actually moves. */
const LONG_REPLY = "这是一个比较长的回答，用来撑满会话区域，让定位滚动有可以移动的距离。".repeat(12);

async function threadSession(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-thread").check();
  await page.getByTestId("create-session").click();

  await expect(page.getByTestId("widget-tab-thread")).toBeVisible();
  await page.getByTestId("widget-tab-thread").click();
  await expect(page.getByTestId("thread-empty")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  // Wait for this turn's streamed reply to land before sending the next one.
  await expect(page.getByText(LONG_REPLY.slice(0, 20)).last()).toBeVisible({ timeout: 15_000 });
}

/** One classifier decision per turn, keyed by the turn's own words. */
function classifierMatches(titles: Array<[string, string]>) {
  return titles.map(([needle, title]) => ({
    includes: needle,
    content: JSON.stringify({
      decisions: [{ thread: "new", branch: "other", title }],
    }),
  }));
}

test.describe("the thread widget", () => {
  test("splits turns into threads and locates the message a thread began on", async ({
    page,
    request,
  }) => {
    const name = unique("Threads");
    await threadSession(page, name);

    const turns: Array<[string, string]> = [
      ["先说说我的学习目标", "学习目标"],
      ["什么是可数集", "可数集"],
      ["考试安排在周五吗", "考试安排"],
    ];
    await scriptLlm(request as APIRequestContext, {
      title: "脉络会话",
      turns: [{ content: LONG_REPLY }, { content: LONG_REPLY }, { content: LONG_REPLY }],
      matches: classifierMatches(turns),
    });

    for (const [message] of turns) {
      await send(page, message);
    }

    // Three background threads under 其他, each with its two-message turn.
    await expect(page.getByTestId("thread-branch-other")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("thread-branch-plan")).toHaveCount(0);
    const threadRows = page.locator('[data-testid^="thread-thread-"]');
    await expect(threadRows).toHaveCount(3, { timeout: 15_000 });
    await expect(page.locator('[data-testid^="thread-message-"]')).toHaveCount(6);
    await expect(
      page.getByTestId("widget-thread").getByText("可数集", { exact: true })
    ).toBeVisible();

    // Clicking the first thread scrolls the (bottom-anchored) conversation back to its
    // first message.
    const messages = page.getByTestId("messages");
    const before = await messages.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(100);
    await threadRows.first().click();
    await expect
      .poll(async () => messages.evaluate((el) => el.scrollTop), { timeout: 10_000 })
      .toBeLessThan(before - 100);
  });

  test("installs and uninstalls the study pack as one group action", async ({ page }) => {
    const name = unique("Study pack");
    await page.goto("/");
    await page.getByTestId("workspace-new").click();
    await page.getByTestId("workspace-name-input").fill(name);
    await page.getByTestId("workspace-create-submit").click();
    await enterWorkspace(page, name);
    await page.getByTestId("new-session").click();
    await page.getByTestId("create-session").click();
    /*
     * Asserted on the three tabs rather than on the panel, which the pack's members happen to be
     * the only occupants of *only* until `DEFAULT_WIDGET_IDS` stopped being empty: a conversation
     * now starts with the notes and sources panels, so the panel is on screen throughout and
     * "is it there" says nothing about this pack. `newSessionDialogArmed` below is the other half
     * of that — it pins what a fresh conversation actually installs.
     */
    await expect(page.getByTestId("widget-tab-plan")).toHaveCount(0);
    await expect(page.getByTestId("widget-tab-quiz")).toHaveCount(0);
    await expect(page.getByTestId("widget-tab-thread")).toHaveCount(0);

    // The group row installs every member in one click.
    await page.getByTestId("open-session-settings").click();
    await page.getByTestId("session-widget-group-study").click();
    await page.getByTestId("session-settings-save").click();

    await expect(page.getByTestId("widget-tab-plan")).toBeVisible();
    await expect(page.getByTestId("widget-tab-quiz")).toBeVisible();
    await expect(page.getByTestId("widget-tab-thread")).toBeVisible();

    // Second click uninstalls the whole pack.
    await page.getByTestId("open-session-settings").click();
    await page.getByTestId("session-widget-group-study").click();
    await page.getByTestId("session-settings-save").click();
    await expect(page.getByTestId("widget-tab-plan")).toHaveCount(0);
    await expect(page.getByTestId("widget-tab-quiz")).toHaveCount(0);
    await expect(page.getByTestId("widget-tab-thread")).toHaveCount(0);
  });
});
