import { expect, test, type APIRequestContext } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Deleting and regenerating messages, in the browser.
 *
 * What these cover that the server tests cannot is the *control's* placement: the tail rule is
 * a property of what is rendered, and the requirement is that the button is absent rather than
 * present-and-refusing. So the assertions are mostly on which rows carry `message-delete` and
 * `message-regenerate`, and on the confirm dialog actually standing between a click and a
 * deletion.
 */

/** The last chat (streaming) request the fake LLM received, as raw JSON. */
async function lastChatRequest(request: APIRequestContext): Promise<string> {
  const sent = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as {
    stream?: boolean;
  }[];
  return JSON.stringify(sent.find((r) => r.stream === true));
}

/** Two exchanges, so there is a middle message to prove the tail rule against. */
async function twoTurns(request: APIRequestContext) {
  await scriptLlm(request, {
    title: "两条消息",
    turns: [{ content: "第一个回答。" }, { content: "第二个回答。" }],
  });
}

test("deletes from the tail only, peeling one message at a time", async ({ page, request }) => {
  await twoTurns(request);

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("第一个问题");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一个回答。");
  await page.getByTestId("composer-input").fill("第二个问题");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第二个回答。");

  // Four messages; only the last one offers the control — no button that refuses on click.
  await expect(page.getByTestId("message-delete")).toHaveCount(1);
  await expect(page.getByTestId("message-assistant").last().getByTestId("message-delete")).toBeVisible();
  await expect(page.getByTestId("message-user").first().getByTestId("message-delete")).toHaveCount(0);
  await expect(page.getByTestId("message-assistant").first().getByTestId("message-delete")).toHaveCount(0);

  // Cancelling leaves it alone.
  await page.getByTestId("message-delete").click();
  await expect(page.getByTestId("confirm-accept")).toBeVisible();
  await page.getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("message-assistant")).toHaveCount(2);

  // Accepting peels the last message, and the one it exposes becomes deletable in turn —
  // which is the "only a tail, but repeatedly" rule the client is asked for.
  await page.getByTestId("message-delete").click();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("message-assistant")).toHaveCount(1);
  await expect(page.getByTestId("message-delete")).toHaveCount(1);
  // The tail is now the *user* message, and it carries the control too — both roles peel.
  await expect(page.getByTestId("message-user").last().getByTestId("message-delete")).toBeVisible();

  await page.getByTestId("message-delete").click();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("message-user")).toHaveCount(1);
  await expect(page.getByTestId("message-assistant")).toHaveCount(1);

  // And once more, down to a single message.
  await page.getByTestId("message-delete").click();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("message-assistant")).toHaveCount(0);
  await expect(page.getByTestId("message-delete")).toHaveCount(1);

  // A deleted message is out of the conversation for good, including after a reload.
  await page.reload();
  await expect(page.getByTestId("message-assistant")).toHaveCount(0);
});

test("regenerates the last reply without duplicating the question", async ({ page, request }) => {
  await scriptLlm(request, {
    title: "重新生成",
    turns: [{ content: "第一次回答。" }, { content: "第二次回答。" }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("一个问题");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一次回答。");

  // The retry control belongs to the assistant tail, and only there.
  await expect(page.getByTestId("message-regenerate")).toHaveCount(1);
  await expect(page.getByTestId("message-user").last().getByTestId("message-regenerate")).toHaveCount(0);

  await page.getByTestId("message-regenerate").click();
  await expect(page.getByTestId("confirm-accept")).toBeVisible();
  await page.getByTestId("confirm-accept").click();

  // The old reply is replaced rather than joined by a new one, and the question is not
  // repeated — which is the whole difference between this and sending the message again.
  await expect(page.getByTestId("message-assistant").last()).toContainText("第二次回答。");
  await expect(page.getByTestId("message-assistant")).toHaveCount(1);
  await expect(page.getByTestId("message-user")).toHaveCount(1);
  await expect(page.getByText("第一次回答。")).toHaveCount(0);

  // What the model was actually sent: the user turn appears once, and the reply being
  // replaced is not in its context.
  const sent = await lastChatRequest(request);
  expect(sent).toContain("一个问题");
  expect(sent).not.toContain("第一次回答。");
});

test("offers no tail actions while a reply is streaming", async ({ page, request }) => {
  await scriptLlm(request, {
    title: "慢回答",
    turns: [{ content: "第一次回答。" }, { content: "正在回答", holdMs: 1500 }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("第一个问题");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一次回答。");

  await page.getByTestId("composer-input").fill("第二个问题");
  await page.getByTestId("composer-send").click();

  // Mid-turn there is nothing to delete or regenerate: the tail is the reply arriving.
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  await expect(page.getByTestId("message-delete")).toHaveCount(0);
  await expect(page.getByTestId("message-regenerate")).toHaveCount(0);

  // The text arriving is not the turn ending — the actions belong to the *persisted* reply.
  // `holdMs` pauses after every frame, so the turn outlasts the text by several of them;
  // the send button coming back is what `message_done` restores, and then the tail is real.
  await expect(page.getByTestId("message-assistant").last()).toContainText("正在回答", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("message-delete")).toHaveCount(1);
});

/*
 * The clipboard needs granting, and it is granted for the whole file rather than for the one case
 * below: Playwright's permissions are per test *context*, and a `describe`-scoped override is
 * inherited by sibling describes — the trap `playwright.config.ts` documents for `storageState`.
 * Nothing else here reads or writes the clipboard, so the widening costs nothing.
 */
test.use({ permissions: ["clipboard-read", "clipboard-write"] });

test("copies a code block, and only that block", async ({ page, request }) => {
  /*
   * The precondition the whole feature rests on, and the one a screenshot cannot check: the
   * button is *inside* the `<pre>` that holds the code — because a wrapper would be a block
   * inside a `<pre>`, and because the button must contribute no text to the message, which
   * `utils/noteAnchor.ts` counts a note's quote over.
   *
   * Two blocks, so "the one you pressed" is a real question: a handler that reached for the
   * first `<pre>` on the page would pass a single-block test.
   */
  await scriptLlm(request, {
    title: "两段代码",
    turns: [
      {
        content: [
          "第一段：",
          "",
          "```js",
          "const first = 1;",
          "```",
          "",
          "第二段：",
          "",
          "```js",
          "const second = 2;",
          "```",
        ].join("\n"),
      },
    ],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("给我两段代码");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第二段：");

  const blocks = page.locator('[data-copy-code]');
  await expect(blocks).toHaveCount(2);
  // Nothing is claimed until it is pressed: the idle label is what the catalog says, not "已复制".
  await expect(blocks.last()).toHaveAttribute("data-copy-state", "idle");

  await blocks.last().click();

  await expect(blocks.last()).toHaveAttribute("data-copy-state", "copied");
  // …and back to idle, so the control is not left claiming a copy from a minute ago.
  await expect(blocks.last()).toHaveAttribute("data-copy-state", "idle", { timeout: 5_000 });

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // The text alone: no markup, no label, and not the other block.
  expect(copied.trim()).toBe("const second = 2;");
});
