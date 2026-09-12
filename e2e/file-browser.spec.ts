import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The workspace file browser, in a real browser against the real server.
 *
 * The fixtures are written with `node:fs` into the directory `GET /api/workspaces` reports,
 * rather than by driving the model to `write_file` them. Two reasons: a couple of them are
 * things a tool call cannot produce at all — a file with a NUL byte, a quarter-megabyte of
 * text — and scripting a conversation per fixture would make this suite slow and would fail
 * with a message about the model rather than about the tree. The one flow that *has* to go
 * through a turn — the tree picking up a file an agent wrote — uses the fake LLM, because
 * that is what it is testing.
 */

/** A file past the server's preview cap, so the truncation notice is exercised. */
const BIG_FILE_CHARS = 300_000;

async function seedWorkspace(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post("/api/workspaces", { data: { name } });
  expect(res.status()).toBe(201);
  const { workdirPath } = (await res.json()) as { workdirPath: string };

  mkdirSync(join(workdirPath, "src", "utils"), { recursive: true });
  mkdirSync(join(workdirPath, "empty-dir"), { recursive: true });
  writeFileSync(join(workdirPath, "README.md"), "# 工作区说明\n\n**重点** 和 `代码`\n");
  writeFileSync(join(workdirPath, "notes.txt"), "纯文本内容\n");
  writeFileSync(join(workdirPath, "app.js"), "const answer = 42;\n");
  writeFileSync(join(workdirPath, "src", "index.ts"), "export const answer = 42;\n");
  writeFileSync(join(workdirPath, "src", "utils", "format.ts"), "export const pad = 1;\n");
  writeFileSync(join(workdirPath, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50, 0x4e]));
  writeFileSync(join(workdirPath, "big.log"), "x".repeat(BIG_FILE_CHARS));
  return workdirPath;
}

/** The sidebar's files panel. The root listing may be empty, so only the panel is awaited. */
async function openFilesTab(page: Page): Promise<void> {
  await page.getByTestId("sidebar-tab-files").click();
  await expect(page.getByTestId("file-tree")).toBeVisible();
}

test("the sidebar shows the workspace's files, one level at a time", async ({ page, request }) => {
  await seedWorkspace(request, "文件浏览器");
  await page.goto("/");
  await enterWorkspace(page, "文件浏览器");

  // The conversations panel is what the sidebar opens on; switching swaps the panel, and
  // there is still exactly one scroller either way.
  await expect(page.getByTestId("session-list")).toBeVisible();
  await openFilesTab(page);
  await expect(page.getByTestId("session-list")).toHaveCount(0);

  const rows = page.getByTestId("file-row");
  const names = await rows.allInnerTexts();
  // Directories first, then files, each alphabetical — the same order the agent's own
  // `list_files` returns, so the two ways of looking at a workspace agree.
  expect(names.slice(0, 2)).toEqual(["empty-dir", "src"]);
  expect(names).toContain("README.md");
  // One level only: a file two directories down is not in the root listing.
  expect(names).not.toContain("index.ts");

  // Expanding fetches that level, and only that level.
  await rows.filter({ hasText: "src" }).first().click();
  await expect(page.getByTestId("file-row").filter({ hasText: "index.ts" })).toBeVisible();
  await expect(page.getByTestId("file-row").filter({ hasText: "format.ts" })).toHaveCount(0);

  await page.getByTestId("file-row").filter({ hasText: "utils" }).first().click();
  await expect(page.getByTestId("file-row").filter({ hasText: "format.ts" })).toBeVisible();
});

test("a file's contents open in a preview, per format", async ({ page, request }) => {
  await seedWorkspace(request, "文件预览");
  await page.goto("/");
  await enterWorkspace(page, "文件预览");
  await openFilesTab(page);

  /* Markdown is rendered, not shown as source — the same renderer the messages use. */
  await page.getByTestId("file-row").filter({ hasText: "README.md" }).first().click();
  const preview = page.locator("body > .modal-overlay");
  await expect(preview).toBeVisible();
  await expect(preview.locator(".markdown h1")).toHaveText("工作区说明");
  await expect(preview.locator(".markdown strong")).toHaveText("重点");
  await preview.getByTestId("file-preview-close").click();
  await expect(preview).toHaveCount(0);

  /* Text arrives as source, in a `<pre>`. */
  await page.getByTestId("file-row").filter({ hasText: "notes.txt" }).first().click();
  await expect(page.getByTestId("file-preview-text")).toHaveText("纯文本内容");
  await page.getByTestId("file-preview-close").click();

  /* A binary is reported as unrenderable, with no `<pre>` and no bytes on screen. */
  await page.getByTestId("file-row").filter({ hasText: "data.bin" }).first().click();
  await expect(page.getByTestId("file-preview-unsupported")).toBeVisible();
  await expect(page.getByTestId("file-preview-text")).toHaveCount(0);
  await page.getByTestId("file-preview-close").click();

  /* Past the cap the text is shown with a notice, rather than the file silently ending. */
  await page.getByTestId("file-row").filter({ hasText: "big.log" }).first().click();
  await expect(page.getByTestId("file-preview-text")).toBeVisible();
  await expect(page.getByTestId("file-preview-truncated")).toBeVisible();
});

test("the tree picks up a change on refresh, and after a turn", async ({ page, request }) => {
  const workdirPath = await seedWorkspace(request, "文件刷新");
  await page.goto("/");
  await enterWorkspace(page, "文件刷新");
  await openFilesTab(page);

  // The manual refresh is what makes a file that appeared outside the conversation visible.
  const rows = page.getByTestId("file-row");
  await expect(rows.filter({ hasText: "added-by-hand.txt" })).toHaveCount(0);
  writeFileSync(join(workdirPath, "added-by-hand.txt"), "hi");
  await page.getByTestId("files-refresh").click();
  await expect(rows.filter({ hasText: "added-by-hand.txt" })).toBeVisible();

  /*
   * And the automatic one: a turn is the thing that writes into a workspace, so the tree is
   * re-read when one ends. This is the only way to test it — the refresh is triggered by the
   * turn finishing, which means a turn has to actually finish.
   */
  await scriptLlm(request, {
    title: "写一个文件",
    turns: [
      {
        content: "我把它写下来。",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            args: { path: "written-by-agent.txt", content: "done" },
          },
        ],
      },
      { content: "文件已保存。" },
    ],
  });

  await page.getByTestId("composer-input").fill("帮我写一个文件");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText("文件已保存。");

  // No refresh click: the row is there because the turn ended.
  await expect(rows.filter({ hasText: "written-by-agent.txt" })).toBeVisible();
  // And a re-read nobody asked for does not raise a toast.
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("the tree is walkable from the keyboard", async ({ page, request }) => {
  await seedWorkspace(request, "文件键盘");
  await page.goto("/");
  await enterWorkspace(page, "文件键盘");
  await openFilesTab(page);

  const first = page.getByTestId("file-row").first();
  await first.focus();
  await expect(first).toHaveAttribute("aria-level", "1");

  // Down to the directory after `empty-dir`, which is `src`.
  await page.keyboard.press("ArrowDown");
  const focused = page.locator("[data-testid='file-row']:focus");
  await expect(focused).toContainText("src");

  // Right opens it, and the rows it brought in are now walkable.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("file-row").filter({ hasText: "index.ts" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("file-row").filter({ hasText: "index.ts" })).toHaveCount(0);

  // Enter on a file opens the preview. Two rows in are the two directories, so the row after
  // `src` is necessarily a file.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator("body > .modal-overlay")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("body > .modal-overlay")).toHaveCount(0);
});

test("a workspace with nothing in it says so", async ({ page, request }) => {
  // The state every new workspace starts in, and the one a user meets first — worth pinning
  // rather than leaving to the seeded fixtures the other tests need.
  const res = await request.post("/api/workspaces", { data: { name: "空工作区" } });
  expect(res.status()).toBe(201);

  await page.goto("/");
  await enterWorkspace(page, "空工作区");
  await openFilesTab(page);

  await expect(page.getByTestId("file-tree-empty")).toBeVisible();
  await expect(page.getByTestId("file-row")).toHaveCount(0);
});

test("source files are highlighted, and Markdown can be read as source", async ({
  page,
  request,
}) => {
  await seedWorkspace(request, "文件高亮");
  await page.goto("/");
  await enterWorkspace(page, "文件高亮");
  await openFilesTab(page);

  // A `.js` file is tokenised — the preview is a highlighted `<pre>`, not escaped monochrome.
  await page.getByTestId("file-row").filter({ hasText: "app.js" }).first().click();
  const body = page.getByTestId("file-preview-body");
  const keyword = body.locator(".file-text .hljs-keyword").first();
  await expect(keyword).toBeVisible();

  // And the tokens are *coloured*, not merely classed. The syntax palette is injected at
  // runtime by `theme.ts` rather than imported as a stylesheet, so a wiring mistake leaves
  // every token at the code foreground — the same colour as the text around it, which is a
  // thing a class-presence check cannot see.
  const tokenColour = await keyword.evaluate((el) => getComputedStyle(el).color);
  const codeColour = await page
    .getByTestId("file-preview-text")
    .evaluate((el) => getComputedStyle(el).color);
  expect(tokenColour).not.toBe(codeColour);

  await page.getByTestId("file-preview-close").click();

  // Markdown opens rendered, as before — the toggle is additive.
  await page.getByTestId("file-row").filter({ hasText: "README.md" }).first().click();
  await expect(body.locator(".markdown h1")).toBeVisible();
  await expect(body.locator(".file-text")).toHaveCount(0);

  // The view switch is one control in two states, not two buttons: exactly one segment is
  // pressed at a time, and the pressed one is the one painted as raised. Asserting the
  // *background* rather than the class is the point — `aria-pressed` is both what a reader
  // announces and what the sheet styles from, so a mismatch means one of the two audiences is
  // being told something the other cannot see.
  const segmentSurface = (id: string) =>
    page.getByTestId(id).evaluate((el) => getComputedStyle(el).backgroundColor);

  await expect(page.getByTestId("file-preview-rendered")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("file-preview-source")).toHaveAttribute("aria-pressed", "false");
  const [renderedBg, sourceBg] = [await segmentSurface("file-preview-rendered"), await segmentSurface("file-preview-source")];
  expect(renderedBg).not.toBe(sourceBg);

  // And the source view shows what was actually written, highlighted, with the rendered
  // document gone rather than underneath.
  await page.getByTestId("file-preview-source").click();
  await expect(page.getByTestId("file-preview-source")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("file-preview-rendered")).toHaveAttribute("aria-pressed", "false");
  expect(await segmentSurface("file-preview-source")).not.toBe(await segmentSurface("file-preview-rendered"));
  // `[class*=…]` rather than `.hljs-`: a CSS class selector is an exact match, so `.hljs-`
  // asks for an element whose class is literally "hljs-" and finds nothing.
  await expect(body.locator('[class*="hljs-"]').first()).toBeVisible();
  await expect(body.locator(".markdown")).toHaveCount(0);
  await expect(page.getByTestId("file-preview-text")).toContainText("# 工作区说明");

  // Switching back restores the rendered view.
  await page.getByTestId("file-preview-rendered").click();
  await expect(body.locator(".markdown h1")).toBeVisible();
});
