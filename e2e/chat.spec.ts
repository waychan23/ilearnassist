import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Browser end-to-end: the real Vue app, the real Fastify server, a real sqlite database,
 * and a scripted fake LLM. Nothing is stubbed on either side of the wire.
 *
 * The server is given its own database directory per run, so the suite is self-sufficient:
 * it creates the workspace it needs rather than assuming an empty database.
 */

const FAKE_LLM = `http://127.0.0.1:${process.env.GL_FAKE_LLM_PORT ?? 3898}`;

/** Discard anything a previous test scripted, and queue the turns for the next one. */
async function scriptLlm(request: APIRequestContext, body: { turns: unknown[]; title?: string }) {
  await request.post(`${FAKE_LLM}/__reset`);
  const res = await request.post(`${FAKE_LLM}/__script`, { data: body });
  expect(res.ok()).toBe(true);
}

test("a conversation round trip survives a reload", async ({ page, request }) => {
  await scriptLlm(request, {
    title: "写一个文件",
    turns: [
      {
        reasoning: "用户想要一个文件，我应该用 write_file。",
        content: "我先把这个文件写下来。",
        toolCalls: [{ id: "call_1", name: "write_file", args: { path: "notes.txt", content: "hello" } }],
      },
      { reasoning: "写好了，回复用户。", content: "文件已保存。" },
    ],
  });

  await page.goto("/");
  await expect(page.getByTestId("composer-input")).toBeVisible();

  // The first launch creates a default workspace and shows the empty state.
  await expect(page.getByText("开始对话")).toBeVisible();

  await page.getByTestId("composer-input").fill("帮我写一个文件");
  await page.getByTestId("composer-send").click();

  // The user's turn appears immediately, before the model has replied.
  await expect(page.getByTestId("message-user")).toContainText("帮我写一个文件");

  // Chain of thought is rendered as its own block, separately from the answer — and
  // exactly once. This is the UI-level guard for the duplicated-reasoning bug: two
  // independent channels were each reporting the same deltas.
  const reasoning = page.getByTestId("reasoning").first();
  await expect(reasoning).toBeVisible();
  await expect(reasoning).toContainText("用户想要一个文件，我应该用 write_file。");
  await expect(page.getByText("用户想要一个文件，我应该用 write_file。")).toHaveCount(1);

  // The tool call is surfaced as a card.
  await expect(page.getByTestId("tool-call").first()).toContainText("写入文件");

  // The final answer is the persisted assistant message.
  await expect(page.getByTestId("message-assistant").last()).toContainText("文件已保存。");

  // The server named the conversation from its first exchange.
  await expect(page.getByTestId("session-title")).toHaveText("写一个文件");

  // The composer is usable again once the turn has finished.
  await expect(page.getByTestId("composer-send")).toBeDisabled();

  // --- reload: everything must come back from the database, not from memory ---
  await page.reload();

  // The app does not remember the active session across a reload; reopen it from the
  // sidebar, then everything must come back from the database rather than the store.
  // `.first()`: sessions are ordered most-recently-updated first, and this test's
  // session was just created and touched, so it is the topmost item.
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("message-user")).toContainText("帮我写一个文件");
  await expect(page.getByTestId("message-assistant").last()).toContainText("文件已保存。");
  await expect(page.getByTestId("tool-call").first()).toContainText("写入文件");
  await expect(page.getByTestId("session-title")).toHaveText("写一个文件");

  // The sidebar lists the conversation too.
  await expect(page.getByTestId("session-item")).toHaveCount(1);
  await expect(page.getByTestId("session-item")).toContainText("写一个文件");
});

test("a second turn keeps the earlier one in context and does not re-title", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "Should Never Be Used",
    turns: [{ content: "第一轮回答。" }, { content: "第二轮回答。" }],
  });

  await page.goto("/");
  await page.getByTestId("composer-input").fill("第一轮问题");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一轮回答。");

  const titleAfterFirstTurn = await page.getByTestId("session-title").textContent();

  await page.getByTestId("composer-input").fill("第二轮问题");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第二轮回答。");

  // Both turns are on screen, and the title did not change on the second turn.
  await expect(page.getByTestId("message-user")).toHaveCount(2);
  await expect(page.getByTestId("session-title")).toHaveText(titleAfterFirstTurn ?? "");
});

test("an attached file reaches the model's prompt and survives a reload", async ({
  page,
  request,
}) => {
  await scriptLlm(request, { turns: [{ content: "我读到了。" }] });

  await page.goto("/");

  // Pick a file through the composer's real input.
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("the secret contents"),
  });
  await expect(page.getByTestId("attachment-chip")).toContainText("notes.txt");

  await page.getByTestId("composer-input").fill("看看这个文件");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("我读到了。");

  // The text file was uploaded, stored and inlined into what the model was sent. The
  // auto-titler issues a second (non-streaming) request afterwards, so pick the chat
  // request rather than the last one.
  const sent = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as {
    stream?: boolean;
    messages: { content: unknown }[];
  }[];
  const chatRequest = sent.find((r) => r.stream === true);
  expect(JSON.stringify(chatRequest)).toContain("the secret contents");

  // The attachment is recorded on the persisted turn, so it comes back after a reload.
  // `.first()`: most-recently-updated session first (see the round-trip test above).
  await page.reload();
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("attachment-chip")).toContainText("notes.txt");
});
