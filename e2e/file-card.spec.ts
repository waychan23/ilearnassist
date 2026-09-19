import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * What a written file looks like in the conversation.
 *
 * The complaint this answers is exact and a browser is the only place to see it: the agent writes
 * a source file and then pastes the whole of it back as an inline code block, so the conversation
 * holds the same 200 lines twice. The card replaces the second copy with the artifact, and
 * `chat.guidance.fileWrite` is the half that stops the model writing it at all — a prompt
 * instruction, which no unit test can check.
 *
 * `apps/server/test/tools/fileTools.test.ts` pins the sentence the card parses and
 * `apps/web/test/utils/markdown.test.ts` pins the renderer; what is here is the two halves meeting
 * — a card drawn over a real `write_file` call, with the reference id the note button needs.
 */

const SOURCE = [
  "fn main() {",
  '    println!("hello");',
  "}",
  ...Array.from({ length: 40 }, (_, i) => `// 第 ${i + 1} 行`),
].join("\n");

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/** A turn that writes a file and then answers, which is the shape that produced the complaint. */
async function writeTurn(
  request: APIRequestContext,
  args: { path: string; content: string; location?: string }
): Promise<void> {
  await scriptLlm(request, {
    turns: [
      {
        content: "我把它写下来。",
        toolCalls: [{ id: "call_w1", name: "write_file", args }],
      },
      // The closing step, and it deliberately does NOT repeat the file — which is what the
      // guidance asks for and what the card makes possible.
      { content: "已经写好了，需要我解释哪一部分？" },
    ],
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("已经写好了");
}

test("a written file is a card, not a second copy of its text", async ({ page, request }) => {
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();

  await writeTurn(request, { path: "src/main.rs", content: SOURCE });
  await send(page, "写个 Rust 文件");

  const card = page.getByTestId("file-card").last();
  await expect(card).toBeVisible();
  // The three facts a reader needs to recognise it: the tool, the path, and how big it is.
  await expect(card.locator(".name")).toBeVisible();
  await expect(card.locator(".path")).toHaveText("src/main.rs");
  await expect(card.locator(".size")).toContainText("B");

  /*
   * And the file's text is **not** in the reply. This is the requirement, and the assertion has to
   * be on the absence of a code block rather than on the card's presence: a card beside a pasted
   * copy would pass every check above and be exactly the problem.
   */
  const message = page.getByTestId("message-assistant").last();
  await expect(message.locator("pre.code-block")).toHaveCount(0);
  await expect(message).not.toContainText("println!");

  // The preview is behind the disclosure, and bounded — the head of the file, not the file.
  await card.getByTestId("file-head").click();
  const preview = card.getByTestId("file-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator("pre")).toContainText("println!");
  // 40 comment lines past the 20-line preview, and the count says so rather than the file just
  // stopping.
  await expect(card.locator(".file-more")).toBeVisible();
});

test("the card opens the file at the root it was written into", async ({ page, request }) => {
  /*
   * The root is read out of the tool's own result rather than assumed, because the `location`
   * argument is optional and the write-location chain may have resolved it — and the same name in
   * `workdir/` and in a conversation's own folder is two different files.
   */
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();

  // Unqualified, so the default applies — which is `session`, the product default.
  await writeTurn(request, { path: "notes.txt", content: "写在会话里" });
  await send(page, "记一下");

  await page.getByTestId("file-card").last().getByTestId("file-open").click();
  // The preview dialog, showing the bytes that were just written.
  await expect(page.getByTestId("file-preview-body")).toContainText("写在会话里");
});

test("the card draws no 标注/笔记 control without the notes panel", async ({ page, request }) => {
  /*
   * The control is **absent, not disabled**, where nothing would render the window it opens: a
   * button that does nothing reads as broken, which is the failure this repository names most
   * often. The notes panel is installed by default, so the state it is absent in has to be made —
   * by uninstalling it for this conversation.
   */
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-notes").uncheck();
  await page.getByTestId("create-session").click();

  await writeTurn(request, { path: "lib.rs", content: SOURCE });
  await send(page, "写个文件");

  const card = page.getByTestId("file-card").last();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("file-note")).toHaveCount(0);
  // The card itself is unaffected: it is about the *file*, not about notes.
  await expect(card.getByTestId("file-open")).toBeVisible();
});

test("with the notes panel installed, the card writes a note about the file", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-notes").check();
  await page.getByTestId("create-session").click();

  await writeTurn(request, { path: "lib.rs", content: SOURCE });
  await send(page, "写个文件");

  const card = page.getByTestId("file-card").last();
  await card.getByTestId("file-note").click();

  // The note window, with the 标注对象 already filled in from the card.
  const editor = page.getByTestId("note-editor");
  await expect(editor).toBeVisible();
  await expect(editor.getByTestId("note-editor-target")).toContainText("lib.rs");

  await editor.getByTestId("note-editor-content").fill("这个文件要留着");
  await editor.getByTestId("note-editor-save").click();

  // And it is in the panel, with a chip that opens the file it is about.
  await page.getByTestId("widget-tab-notes").click();
  const row = page.getByTestId("notes-list").locator("li").first();
  await expect(row).toContainText("这个文件要留着");
  await expect(row.getByTestId(/^note-target-/)).toBeVisible();
});
