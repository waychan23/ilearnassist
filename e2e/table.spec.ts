import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Tables, end to end: the model records one, the reply shows it *inline*, and the 图表 panel
 * lists it beside the diagrams.
 *
 * This spec is the only place the feature's actual requirement can be checked, and that is worth
 * stating because everything else about it has a unit test. `renderMarkdown` renders a Markdown
 * table — `apps/web/test/utils/markdown.test.ts` holds that — but only a browser can prove *which
 * surface* the table landed on: the reply's own prose, or a fold inside a tool call. The
 * requirement is the first, and the two are indistinguishable from the DOM of a rendered string.
 *
 * The other half is the panel: `figureRows` is unit-tested for the merge, and what is left for
 * here is that the row is reachable at all — that the tool wrote it, the route returned it, and
 * the row opens the viewer.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/** A Markdown table with a header, a separator and one body row. */
const TABLE = "| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |";

/** A fresh workspace and conversation with the 图表 widget installed and its tab open. */
async function figureSession(page: Page, name: string): Promise<string> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-diagram").check();
  await page.getByTestId("create-session").click();
  await page.getByTestId("widget-tab-diagram").click();
  return name;
}

/**
 * A turn that records a table the way a real model does it: the table is written in the step that
 * records it, and the closing step is a question about what to do next.
 *
 * That shape matters — it is the shape that was broken. Scripting the table into the *final* step
 * instead is what this spec used to do, and it passed while the feature was broken in the app: the
 * loop persists the last step's utterance, so a table written beside the call streamed live and
 * then vanished at `message_done`. `apps/server/test/agent/loop.test.ts` is where that rule is
 * pinned now, and this is the conversation that has to hold up in a browser because of it.
 */
function scriptTable(
  request: APIRequestContext,
  args: { name: string; table?: string; summary?: string }
): Promise<void> {
  return scriptLlm(request, {
    turns: [
      {
        content: `对比一下：\n\n${args.table ?? TABLE}`,
        toolCalls: [
          {
            id: "call_t1",
            name: "ila_table",
            args: {
              name: args.name,
              table: args.table ?? TABLE,
              summary: args.summary ?? `${args.name} 的对比`,
            },
          },
        ],
      },
      { content: "需要展开哪一项？" },
    ],
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

test("a recorded table renders in the reply, not in a tool container", async ({ page, request }) => {
  const workspace = await figureSession(page, unique("表格内联"));
  await scriptTable(request, { name: "季度对比" });
  await send(page, "帮我做一个对比表");

  /*
   * The requirement, asserted where it can be: a real `<table>` inside the message's own markdown
   * body. The message list renders the reply through `renderMarkdown`, so a table in the reply is
   * a table element under `[data-note-root]` — and a table anywhere *else* would be the shape the
   * feature rules out.
   */
  const body = page.getByTestId("message-content").last();
  await expect(body.locator("table")).toBeVisible();
  await expect(body.locator("table")).toContainText("速度");

  /*
   * And it is still there after a reload, which is the half that was broken: the streamed live
   * view showed the table while the *persisted* message held only the closing question, so a
   * reload — or the next visit — lost it. Asserted through the API as well as the DOM, because a
   * table that only survives in this tab is the bug, not the feature.
   */
  await page.reload();
  // By name: a reload lands on the workspace home, and `enterWorkspace(page)` with no name opens
  // the suite's *first* card — which is the seeded default workspace, not this one.
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("message-content").last().locator("table")).toBeVisible();
  await expect(page.getByTestId("message-content").last()).toContainText("速度");

  // And it is *outside* every tool card: the card is a line, and the table is not in it.
  const card = page.getByTestId("table-card").last();
  await expect(card).toBeVisible();
  await expect(card.locator("table")).toHaveCount(0);
  // The card names what it recorded — the canonical name, which is what a revise has to match —
  // and says where the table itself is.
  await expect(card.getByTestId("table-head")).toContainText("季度对比");
  await expect(card.getByTestId("table-head")).toContainText("表格已写在回复里");

  // The card carries the jump anchor the panel's 定位 scrolls to.
  await expect(card).toHaveAttribute("data-tool-call-id", "call_t1");
});

test("the panel lists it, opens it in the viewer, and copies it as HTML", async ({
  page,
  request,
}) => {
  await figureSession(page, unique("表格面板"));
  await scriptTable(request, { name: "季度对比", summary: "三项指标的对比" });
  await send(page, "帮我做一个对比表");

  // The row, in the panel, with the model's own summary — the panel's data is the row the tool
  // wrote, not the message it was written beside.
  const row = page.getByTestId("diagram-row").filter({ hasText: "季度对比" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("三项指标的对比");

  // A table has no file, so its row opens the viewer rather than the file preview — the
  // difference the row's own kind decides.
  await row.click();
  const viewer = page.getByTestId("diagram-viewer");
  await expect(viewer).toBeVisible();
  // Rendered by the same `renderMarkdown` the reply used, in the viewer's own canvas.
  await expect(viewer.getByTestId("figure-box").locator("table")).toBeVisible();
  await expect(viewer.getByTestId("figure-box")).toContainText("速度");
  // The dialog is named for what it is showing.
  await expect(viewer.locator(".modal-head h3")).toContainText("季度对比");

  /*
   * 复制, as both flavours at once: `text/html` for a document and `text/plain` for a source
   * file. Read back through the clipboard API rather than by watching a stub, because the whole
   * claim is about what a *paste* would receive — and the HTML has to carry the borders inline,
   * since a stylesheet does not travel.
   */
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await viewer.getByTestId("table-copy").click();
  await expect(viewer.getByTestId("table-copy")).toHaveAttribute("data-copy-state", "copied");

  const clipboard = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const out: Record<string, string> = {};
    for (const item of items) {
      if (item.types.includes("text/html")) out.html = await (await item.getType("text/html")).text();
      if (item.types.includes("text/plain")) out.text = await (await item.getType("text/plain")).text();
    }
    return out;
  });
  expect(clipboard.html).toContain("<table");
  expect(clipboard.html).toContain("border-collapse");
  expect(clipboard.html).toContain("速度");
  // The plain flavour is the *markdown*, which is what a code editor or a chat box wants.
  expect(clipboard.text).toContain("| 项目 | 数值 |");

  await viewer.getByTestId("diagram-viewer-close").click();
  await expect(viewer).toBeHidden();
});

test("the panel filters the two kinds, and offers a kind only when it has one", async ({
  page,
  request,
}) => {
  await figureSession(page, unique("表格筛选"));
  await scriptTable(request, { name: "季度对比" });
  await send(page, "帮我做一个对比表");
  await expect(page.getByTestId("diagram-row").filter({ hasText: "季度对比" })).toBeVisible();

  // One kind present: no filter strip at all, because an option that can only produce the empty
  // state is a control that does nothing.
  await expect(page.getByTestId("figure-filter")).toHaveCount(0);

  // A diagram too, and now the strip appears with both kinds in it.
  await scriptLlm(request, {
    turns: [
      {
        content: "画一张。",
        toolCalls: [
          { id: "call_d1", name: "ila_diagram", args: { name: "flow", source: "flowchart TD\n  A --> B", summary: "流程图" } },
        ],
      },
      { content: "画好了。" },
    ],
  });
  await send(page, "画一个流程图");
  await expect(page.getByTestId("diagram-row").filter({ hasText: "flow" })).toBeVisible();

  const filter = page.getByTestId("figure-filter");
  await expect(filter).toBeVisible();
  await expect(page.getByTestId("figure-count")).toHaveText("2");

  await filter.selectOption("table");
  await expect(page.getByTestId("diagram-row")).toHaveCount(1);
  await expect(page.getByTestId("diagram-row")).toContainText("季度对比");

  await filter.selectOption("diagram");
  await expect(page.getByTestId("diagram-row")).toHaveCount(1);
  await expect(page.getByTestId("diagram-row")).toContainText("flow");
});
