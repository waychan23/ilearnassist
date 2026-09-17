import { expect, test, type APIRequestContext, type Locator, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * What a code block says about itself: its file and its language.
 *
 * `apps/web/test/utils/markdown.test.ts` pins the markup `renderMarkdown` produces, including both
 * halves being optional. What it cannot see is the *stylesheet* — and one claim here is purely
 * layout: the header is a flow element at the top-left and the copy control is absolutely
 * positioned in the top-right, so the header's own padding is the only thing keeping a long
 * filename from sliding underneath a button. That is the failure this spec exists for, and it is
 * invisible to every unit test.
 */

const REPLY =
  "Three blocks, one of each shape:\n\n" +
  "```python app.py\nprint('hello')\n```\n\n" +
  "```ts\nconst a = 1;\n```\n\n" +
  "```\nplain text\n```\n";

async function replyWithBlocks(page: Page, request: APIRequestContext): Promise<Locator> {
  await scriptLlm(request, { turns: [{ content: REPLY }] });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("给我看看代码");
  await page.getByTestId("composer-send").click();

  const content = page
    .getByTestId("message-assistant")
    .last()
    .getByTestId("message-content");
  await expect(content).toContainText("Three blocks");
  return content;
}

test("a code block shows the file and language its fence names", async ({ page, request }) => {
  const content = await replyWithBlocks(page, request);

  await expect(content.locator("pre.code-block")).toHaveCount(3);

  // The first names both, and the header carries them in that order: the file, then the language.
  const first = content.locator("pre.code-block").first();
  await expect(first.locator(".code-file")).toHaveText("app.py");
  await expect(first.locator(".code-lang")).toHaveText("python");
  // The name is *shown*, which is the whole requirement — a header in the DOM and not on screen
  // would satisfy the unit tests.
  await expect(first.locator(".code-file")).toBeVisible();

  // The second names only a language: no file element at all, rather than an empty one.
  const second = content.locator("pre.code-block").nth(1);
  await expect(second.locator(".code-lang")).toHaveText("ts");
  await expect(second.locator(".code-file")).toHaveCount(0);

  // The third names nothing, and renders exactly as every code block did before this existed.
  const third = content.locator("pre.code-block").nth(2);
  await expect(third.locator(".code-head")).toHaveCount(0);
  await expect(third).toContainText("plain text");
});

test("a long filename stays clear of the copy control", async ({ page, request }) => {
  /*
   * The layout claim. The control is `position: absolute` in the corner and the header is in the
   * flow, so without the header's own right padding the two overlap for any name longer than a few
   * characters — and the overlap is invisible to the unit tests, which never lay anything out.
   */
  const name = "a-really-quite-long-file-name-for-testing-overlap.py";
  await scriptLlm(request, {
    turns: [{ content: "```python " + name + "\nprint(1)\n```" }],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await page.getByTestId("composer-input").fill("长文件名");
  await page.getByTestId("composer-send").click();

  const block = page
    .getByTestId("message-assistant")
    .last()
    .getByTestId("message-content")
    .locator("pre.code-block")
    .first();
  await expect(block.locator(".code-file")).toBeVisible();

  const file = await block.locator(".code-file").boundingBox();
  const copy = await block.locator(".code-copy").boundingBox();
  expect(file).not.toBeNull();
  expect(copy).not.toBeNull();
  // A pixel of tolerance for sub-pixel rounding, and no more: the claim is that they do not touch.
  expect(file!.x + file!.width).toBeLessThanOrEqual(copy!.x + 1);

  // The name is truncated rather than allowed to push the pill out of the block.
  const overflow = await block
    .locator(".code-file")
    .evaluate((node) => getComputedStyle(node).textOverflow);
  expect(overflow).toBe("ellipsis");
});

test("the header is the renderer's chrome, not the message's text", async ({ page, request }) => {
  /*
   * A note anchors to a quote counted over the message's *visible* text, so text the renderer
   * added would shift the occurrence arithmetic for every note anchored below it — including notes
   * written before this header existed. `data-note-skip` is the existing opt-out, and this is the
   * one place it can be observed: `noteAnchor`'s walk is a DOM walk.
   */
  const content = await replyWithBlocks(page, request);
  const head = content.locator(".code-head").first();
  await expect(head).toHaveAttribute("data-note-skip", "");
});
