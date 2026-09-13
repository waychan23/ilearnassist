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
