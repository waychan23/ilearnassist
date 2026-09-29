import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Manual context compaction, end to end: two turns, a compression, then the assertion that
 * matters — what the *next* model request carries. The fake LLM records every body it was
 * sent, so "the summary stands in for the compacted messages" is read off the wire rather
 * than inferred from the UI.
 *
 * The other half is the restore: the requirement is that the full history is still there, and
 * the only way to prove that from a browser is to restore it and watch the old words go back
 * into the request.
 */

/** The summary the compactor call is scripted to answer with — unique enough to search for. */
const SUMMARY = "压缩总结：学员已经问过两个问题，都已回答。";

/**
 * Every **streamed** request the fake received, newest last.
 *
 * The turn calls are the streaming ones; the titler, the thread classifier and the compactor
 * are non-streaming (`stream: true` is only ever set by the agent loop), so this is the set
 * the conversation's own turns live in.
 */
async function chatRequests(request: APIRequestContext): Promise<Record<string, unknown>[]> {
  const sent = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as {
    stream?: boolean;
  }[];
  return sent.filter((r) => r.stream === true);
}

/** The streamed request whose body contains a phrase. */
async function requestWith(
  request: APIRequestContext,
  phrase: string
): Promise<Record<string, unknown>> {
  const found = (await chatRequests(request)).find((r) => JSON.stringify(r).includes(phrase));
  if (!found) throw new Error(`no streamed request carried ${JSON.stringify(phrase)}`);
  return found;
}

async function send(page: Page, message: string, reply: string) {
  await page.getByTestId("composer-input").fill(message);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText(reply, {
    timeout: 15_000,
  });
}

test("a compacted conversation sends the summary plus the messages after the point", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "上下文压缩",
    turns: [
      { content: "第一个回答" },
      { content: "第二个回答" },
      { content: "第三个回答" },
      { content: "第四个回答" },
    ],
    matches: [{ includes: "context-compression function", content: SUMMARY }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await send(page, "第一个问题", "第一个回答");
  await send(page, "第二个问题", "第二个回答");

  // Compress. The button confirms first — it spends tokens and changes what every later turn
  // sends — and the dialog opens on the result, so the reader sees what was written.
  await page.getByTestId("context-compact").click();
  await expect(page.getByTestId("confirm-accept")).toBeVisible();
  await page.getByTestId("confirm-accept").click();

  await expect(page.getByTestId("context-preview")).toBeVisible();
  await expect(page.getByTestId("context-preview-summary")).toContainText("压缩总结");
  await expect(page.getByTestId("context-preview-mode")).toContainText("压缩上下文");
  await page.getByTestId("context-preview-close").click();

  // The next turn goes out on the compacted context: the summary is in the system prompt and
  // the first two exchanges are not in the request at all.
  await send(page, "第三个问题", "第三个回答");
  const compacted = JSON.stringify(await requestWith(request, "第三个问题"));
  expect(compacted).toContain(SUMMARY);
  expect(compacted).toContain("<conversation_summary>");
  expect(compacted).not.toContain("第一个问题");
  expect(compacted).not.toContain("第一个回答");

  // The usage popover reports both the mode and the conversation's own lifetime spend —
  // including the compaction call, which no message records.
  await page.locator(".token-btn").hover();
  await expect(page.getByTestId("tokens-context-mode")).toContainText("压缩上下文");
  const popover = page.locator(".token-wrap");
  await expect(popover).toContainText("本会话累计");

  // Restore from the same popover, and the whole history goes back into the request.
  await page.getByTestId("context-preview-open").click();
  await expect(page.getByTestId("context-preview-mode")).toContainText("压缩上下文");
  await page.getByTestId("context-preview-restore").click();
  await expect(page.getByTestId("confirm-accept")).toBeVisible();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("context-preview-mode")).toContainText("全量上下文");
  await page.getByTestId("context-preview-close").click();

  await send(page, "第四个问题", "第四个回答");
  const restored = JSON.stringify(await requestWith(request, "第四个问题"));
  expect(restored).toContain("第一个问题");
  expect(restored).toContain("第一个回答");
  expect(restored).not.toContain("<conversation_summary>");
});

test("the compress button is inert before there is anything to compress", async ({
  page,
  request,
}) => {
  await scriptLlm(request, { title: "空会话", turns: [] });

  await page.goto("/");
  await enterWorkspace(page);

  // A conversation with no messages has nothing to summarize, and the button says so rather
  // than opening a confirm whose every path is a refusal.
  await expect(page.getByTestId("context-compact")).toBeDisabled();
});

test("sending is paused while a compaction runs, then resumes untouched", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "压缩等待",
    turns: [{ content: "第一个回答" }, { content: "第二个回答" }],
    matches: [{ includes: "context-compression function", content: SUMMARY }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await send(page, "第一个问题", "第一个回答");

  // A draft in the box, so "the send button is disabled" is about the compaction rather than
  // about an empty composer.
  await page.getByTestId("composer-input").fill("压缩期间写好的草稿");

  // Hold the compaction open, so the paused state is observed rather than raced.
  await page.route("**/api/sessions/*/context/compact", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await route.continue();
  });

  await page.getByTestId("context-compact").click();
  await page.getByTestId("confirm-accept").click();

  // The wait is stated where the reader is looking, the send is refused, and the draft is
  // still there so nothing has to be retyped.
  await expect(page.getByTestId("composer-compacting")).toBeVisible();
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await expect(page.getByTestId("composer-input")).toHaveValue("压缩期间写好的草稿");

  // The compaction lands, the preview opens, and the composer is usable again.
  await expect(page.getByTestId("context-preview")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("context-preview-close").click();
  await expect(page.getByTestId("composer-compacting")).toHaveCount(0);
  await expect(page.getByTestId("composer-send")).toBeEnabled();
});

test("a failed compaction is reported, and does not block the conversation", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "压缩失败",
    turns: [{ content: "第一个回答" }, { content: "第二个回答" }],
    matches: [{ includes: "context-compression function", content: SUMMARY }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await send(page, "第一个问题", "第一个回答");

  // Refuse the way the server's `COMPACT_FAILED` does, provider detail and all.
  await page.route("**/api/sessions/*/context/compact", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "COMPACT_FAILED",
          message: "context compaction failed",
          params: { detail: "测试注入的失败" },
        },
      }),
    })
  );

  await page.getByTestId("context-compact").click();
  await page.getByTestId("confirm-accept").click();

  // Obvious, and it says which context the conversation is still on.
  const toast = page.getByTestId("toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("上下文压缩失败");
  await expect(toast).toContainText("仍使用原有上下文");

  // Not blocking: the wait is over, the box works, and the next message goes out on the full
  // context — no preview dialog, no stuck spinner.
  await expect(page.getByTestId("composer-compacting")).toHaveCount(0);
  await expect(page.getByTestId("context-preview")).toHaveCount(0);
  await page.getByTestId("composer-input").fill("失败之后继续");
  await expect(page.getByTestId("composer-send")).toBeEnabled();
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第二个回答", {
    timeout: 15_000,
  });
});

test("compaction is disabled while a card is waiting for an answer", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "等待回答",
    turns: [
      {
        content: "先确认一下方向：",
        toolCalls: [
          {
            name: "ask_user",
            args: {
              questions: [
                {
                  header: "方向",
                  question: "先讲哪一章？",
                  options: [
                    { label: "第一章", description: "从基础开始" },
                    { label: "第二章", description: "跳过基础" },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await send(page, "开始复习", "先确认一下方向：");

  // The awaiting call is the conversation's last message, so it is exactly where the point
  // would land — the answer could never be replayed. The button refuses rather than letting
  // the reader press into a 409.
  await expect(page.getByTestId("ask-user-card")).toBeVisible();
  await expect(page.getByTestId("context-compact")).toBeDisabled();
});
