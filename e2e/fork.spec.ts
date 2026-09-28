import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Branching a conversation, in the browser.
 *
 * The server test (`apps/server/test/fork.test.ts`) proves what the copy *is*; this proves the
 * flow around it: every persisted message carries the control, the dialog opens with the
 * source's name and a `· 分支` tail, creating the branch switches to it showing only the part
 * before the cut, and the source is left exactly as it was.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

test("forks a conversation from a message and opens the branch", async ({ page, request }) => {
  await scriptLlm(request as APIRequestContext, {
    title: "Fork source",
    turns: [{ content: "第一个回答。" }, { content: "第二个回答。" }],
  });

  // A workspace of its own, so the sidebar holds exactly the source and the branch.
  const workspace = unique("Fork workspace");
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(workspace);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, workspace);

  await send(page, "第一个问题");
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一个回答。");
  await send(page, "第二个问题");
  await expect(page.getByTestId("message-assistant").last()).toContainText("第二个回答。");
  // The auto-titler named the conversation from the fake model's non-streaming reply.
  await expect(page.getByTestId("session-title")).toHaveText("Fork source");

  // Every persisted message is a possible cut point — not only the tail, which is the rule the
  // delete and regenerate controls carry.
  await expect(page.getByTestId("message-fork")).toHaveCount(4);

  // Branch from the *first* reply, which is a middle message.
  const firstReply = page.getByTestId("message-assistant").first();
  await firstReply.hover();
  await firstReply.getByTestId("message-fork").click();

  const dialog = page.getByTestId("fork-session-dialog");
  await expect(dialog).toBeVisible();
  // The default title is the source's, with the suffix; the field is editable.
  await expect(page.getByTestId("fork-title-input")).toHaveValue("Fork source · 分支");
  await page.getByTestId("fork-title-input").fill("从第一条回复分支");
  await page.getByTestId("fork-session-create").click();

  // The new conversation is open on its own address, named as asked, holding the cut —
  // inclusive of the message the fork was made from and nothing after it.
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("session-title")).toHaveText("从第一条回复分支");
  await expect(page.getByTestId("message-user")).toHaveCount(1);
  await expect(page.getByTestId("message-assistant")).toHaveCount(1);
  await expect(page.getByTestId("message-assistant")).toContainText("第一个回答。");
  await expect(page.getByTestId("session-item")).toHaveCount(2);

  // The source is untouched: the same name, the same four messages.
  await page.getByTestId("session-item").filter({ hasText: "Fork source" }).click();
  await expect(page.getByTestId("session-title")).toHaveText("Fork source");
  await expect(page.getByTestId("message-user")).toHaveCount(2);
  await expect(page.getByTestId("message-assistant")).toHaveCount(2);
});
