import { expect, test, type APIRequestContext } from "./fixtures";
import { buildPdf } from "../apps/server/src/documents/sample.js";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Browser end-to-end: the real Vue app, the real Fastify server, a real sqlite database,
 * and a scripted fake LLM. Nothing is stubbed on either side of the wire.
 *
 * The server is given its own database directory per run, so the suite is self-sufficient:
 * it creates the workspace it needs rather than assuming an empty database.
 */

const FAKE_PARSER = `http://127.0.0.1:${process.env.ILA_FAKE_PARSER_PORT ?? 3897}`;

/** The last chat (streaming) request the fake LLM received, as raw JSON. */
async function lastChatRequest(request: APIRequestContext): Promise<string> {
  const sent = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as {
    stream?: boolean;
  }[];
  return JSON.stringify(sent.find((r) => r.stream === true));
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

  // The first launch creates a default workspace; entering it is what shows the empty state.
  await page.goto("/");
  await enterWorkspace(page);
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

  // The app remembers neither the active workspace nor the active session across a reload —
  // it opens on the workspace list, deliberately. Walk back in, then reopen the conversation
  // from the sidebar: everything after this must come from the database, not the store.
  await enterWorkspace(page);
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
  await enterWorkspace(page);
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

test("a PDF is parsed locally and its text reaches the model", async ({ page, request }) => {
  await scriptLlm(request, { turns: [{ content: "我读到了 PDF。" }] });

  await page.goto("/");
  await enterWorkspace(page);

  await page.getByTestId("composer-file-input").setInputFiles({
    name: "lecture.pdf",
    mimeType: "application/pdf",
    buffer: buildPdf(["Photosynthesis converts light into chemical energy."]),
  });

  // Extraction is asynchronous, so the chip reports progress before it reports success —
  // and sending is blocked until it settles.
  await expect(page.getByTestId("attachment-chip")).toBeVisible();
  await expect(page.getByTestId("attachment-detail")).toContainText("解析中", { timeout: 15_000 });
  await expect(page.getByTestId("attachment-detail")).toContainText("已解析", { timeout: 20_000 });
  await expect(page.getByTestId("attachment-detail")).toContainText("1 页");
  // Parsed by the built-in extractor, not by the mock cloud service.
  await expect(page.getByTestId("attachment-detail")).not.toContainText("云解析");

  await page.getByTestId("composer-input").fill("这份 PDF 讲了什么");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("我读到了 PDF。");

  // The extracted text — not the filename — is what the model was given.
  const chatRequest = await lastChatRequest(request);
  expect(chatRequest).toContain("Photosynthesis converts light into chemical energy.");

  // Parse state is persisted with the message, so the chip is still informative on reload.
  await page.reload();
  await enterWorkspace(page);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("attachment-chip")).toBeVisible();
  await expect(page.getByTestId("attachment-detail")).toContainText("1 页");
});

test("a scanned PDF falls back to the cloud parser", async ({ page, request }) => {
  // The mock parser answers with this, and it is unmistakably not the local extractor's
  // output — so finding it in the prompt proves the fallback actually ran.
  await request.post(`${FAKE_PARSER}/__reset`);
  await request.post(`${FAKE_PARSER}/__script`, {
    data: { text: "CLOUD-EXTRACTED-CONTENT from the scanned page." },
  });
  await scriptLlm(request, { turns: [{ content: "云端读到了。" }] });

  await page.goto("/");
  await enterWorkspace(page);

  // A page with no text layer: local extraction reports `no_text_layer`, which is the
  // recoverable failure the policy hands to the cloud tier.
  await page.getByTestId("composer-file-input").setInputFiles({
    name: "scan.pdf",
    mimeType: "application/pdf",
    buffer: buildPdf([""]),
  });

  await expect(page.getByTestId("attachment-detail")).toContainText("已解析", { timeout: 20_000 });
  // Attributed to the cloud, so the user can tell which service read it.
  await expect(page.getByTestId("attachment-detail")).toContainText("云解析");

  const parserRequests = (await (await request.get(`${FAKE_PARSER}/__requests`)).json()) as unknown[];
  expect(parserRequests.length).toBeGreaterThan(0);

  await page.getByTestId("composer-input").fill("扫描件里写了什么");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("云端读到了。");

  const chatRequest = await lastChatRequest(request);
  expect(chatRequest).toContain("CLOUD-EXTRACTED-CONTENT from the scanned page.");
});

test("the console's documents section manages a cloud parser", async ({ page, request }) => {
  await page.goto("/");

  // In the platform console rather than in Settings: a parser's `baseURL` is a URL the
  // *server* fetches for every account, so it is an administrator's to configure and nobody
  // else's to see. The spec runs as the administrator the suite signs in as.
  await page.getByTestId("open-admin").click();
  await page.getByTestId("admin-nav-documents").click();
  await expect(page.getByTestId("admin-documents")).toBeVisible();

  // The e2e config seeds one, so the list is not empty to begin with.
  await expect(page.getByTestId("parser-row")).toHaveCount(1);
  await expect(page.getByTestId("parse-policy")).toHaveValue("local-first");

  // "Test connection" round-trips a throwaway document through the mock service.
  await page.getByRole("button", { name: "测试连接" }).click();
  await expect(page.getByTestId("parser-test-result")).toContainText("连接正常");

  await page.getByTestId("add-parser").click();
  await page.getByTestId("parser-kind").selectOption("llamaparse");
  await page.getByPlaceholder("例如：Docling（本机）").fill("My LlamaParse");
  // llamaparse requires a key, so the form refuses to save without one — which is the
  // guard that stops a half-configured service from being added.
  await expect(page.getByTestId("parser-save")).toBeDisabled();
  await page.getByTestId("parser-api-key").fill("llama-key");
  await page.getByTestId("parser-save").click();
  await expect(page.getByTestId("parser-row")).toHaveCount(2);
});

test("an attached file reaches the model's prompt and survives a reload", async ({
  page,
  request,
}) => {
  await scriptLlm(request, { turns: [{ content: "我读到了。" }] });

  await page.goto("/");
  await enterWorkspace(page);

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
  await enterWorkspace(page);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("attachment-chip")).toContainText("notes.txt");
});

test("the title is the rename control, and the settings button opens the composer's dialog", async ({
  page,
}) => {
  /*
   * The title *is* the edit, and that is the whole of what the topbar carries for renaming — the
   * pencil button beside it was a second entry to the same editor and is gone. Asserted here
   * because it is only observable in a browser: `vue-tsc` cannot see whether a click handler
   * reached the right element, and the tooltip that teaches the gesture is a title attribute
   * rather than anything on screen.
   *
   * The settings button's real content is that it opens the *same* dialog the composer's button
   * does. Two entries to one dialog is a claim about identity, so the assertion is on the same
   * field the composer's route reaches.
   */
  await page.goto("/");
  await enterWorkspace(page);

  // The welcome screen has no conversation, and both controls belong to one — the topbar shows
  // neither until there is something to name.
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();

  // No pencil: the row is the title and the parameters, and nothing else.
  await expect(page.getByTestId("edit-session-title")).toHaveCount(0);

  const title = page.getByTestId("session-title");
  await expect(title).toHaveAttribute("title", "点击编辑标题");
  await title.click();
  // The title swaps for an input — the control really is the edit.
  await expect(page.getByTestId("chat-title-input")).toBeVisible();
  await page.getByTestId("chat-title-input").press("Escape");
  await expect(page.getByTestId("session-title")).toBeVisible();

  await page.getByTestId("chat-session-settings").click();
  // The conversation's own fields — the ones only this dialog has.
  await expect(page.getByTestId("session-name")).toBeVisible();
  await expect(page.getByTestId("session-description")).toBeVisible();

  // And the composer's button opens the same dialog, which is the identity being claimed.
  await page.getByTestId("session-settings-close").click();
  await page.getByTestId("open-session-settings").click();
  await expect(page.getByTestId("session-name")).toBeVisible();
});

test("the canned replies appear once there is something to reply to", async ({ page, request }) => {
  await scriptLlm(request, { turns: [{ content: "第一轮回答。" }] });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();

  /*
   * Nothing to continue on a conversation that has not started. The welcome screen is where a
   * first message is *composed*, and "继续 / 是的 / 可以" are answers to something the assistant
   * has not said yet — three buttons that cannot mean anything are three buttons that teach the
   * user to ignore the row.
   */
  await expect(page.getByTestId("composer-quick")).toHaveCount(0);

  await page.getByTestId("composer-input").fill("你好");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一轮回答。");

  const quick = page.getByTestId("composer-quick");
  await expect(quick).toBeVisible();
  await expect(quick.getByTestId("composer-quick-label")).toHaveText("快捷回复");
  await expect(quick.getByTestId("quick-continue")).toHaveText("继续");
  await expect(quick.getByTestId("quick-yes")).toHaveText("是的");
  await expect(quick.getByTestId("quick-ok")).toHaveText("可以");

  // The label names the row rather than joining it: a fourth thing shaped like a chip would be
  // a fourth thing to click, and clicking this one would have to do nothing.
  await expect(quick.locator("button")).toHaveCount(3);

  /*
   * Centred, which is a layout claim and so only a browser can answer it. Asserted as
   * "the row's midpoint is the composer's" rather than by reading `justify-content`, since the
   * declaration is not what the user sees and a flex item's own margins can override it.
   */
  const row = (await quick.boundingBox())!;
  const surface = (await page.locator(".composer .surface").boundingBox())!;
  expect(Math.abs(row.x + row.width / 2 - (surface.x + surface.width / 2))).toBeLessThan(2);
});

test("a canned reply sends its own words as the user's message", async ({ page, request }) => {
  await scriptLlm(request, {
    turns: [{ content: "第一轮回答。" }, { content: "那我们就继续。" }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  await page.getByTestId("composer-input").fill("你好");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一轮回答。");

  await page.getByTestId("quick-continue").click();

  // The chip *is* the sentence: what the user sees on the button is what the conversation
  // records, so the label and the sent text cannot drift apart.
  await expect(page.getByTestId("message-user").last()).toContainText("继续");
  await expect(page.getByTestId("message-assistant").last()).toContainText("那我们就继续。");
});

test("a canned reply leaves a draft where it was", async ({ page, request }) => {
  /*
   * The chip sends its own words and nothing else. It shares the send *button*'s path in every
   * way but one: there is nothing staged to attach and nothing typed to consume, and a chip that
   * cleared the textarea would be a one-click way to lose a paragraph the user was writing.
   */
  await scriptLlm(request, { turns: [{ content: "第一轮回答。" }, { content: "好。" }] });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  await page.getByTestId("composer-input").fill("你好");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一轮回答。");

  await page.getByTestId("composer-input").fill("这是我还没写完的草稿");
  await page.getByTestId("quick-yes").click();

  await expect(page.getByTestId("message-user").last()).toContainText("是的");
  await expect(page.getByTestId("composer-input")).toHaveValue("这是我还没写完的草稿");
});

test("the canned replies are gone while a reply is arriving", async ({ page, request }) => {
  /*
   * Not merely tidiness. Sending is refused while a turn runs — the send button has already
   * become Stop — so a chip on screen then would look live and do nothing when clicked, which
   * is the class of control this app keeps out of the UI.
   */
  // Held per *frame* rather than for a fixed duration, so the turn has to be slow enough to be
  // caught mid-flight and short enough that the assertions after it do not spend the whole
  // retry budget waiting for it. 1500 here is a nine-second turn and a flake.
  await scriptLlm(request, {
    turns: [{ content: "第一轮回答。" }, { content: "慢一点的回答", holdMs: 400 }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  await page.getByTestId("composer-input").fill("你好");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("第一轮回答。");
  await expect(page.getByTestId("composer-quick")).toBeVisible();

  await page.getByTestId("quick-ok").click();
  // The row goes with the send, and comes back with the answer.
  await expect(page.getByTestId("composer-quick")).toHaveCount(0);
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  await expect(page.getByTestId("message-assistant").last()).toContainText("慢一点的回答");
  await expect(page.getByTestId("composer-quick")).toBeVisible();
});
