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
  // By name: `enterWorkspace(page)` with no name opens the suite's *first* card, and this test
  // made a workspace of its own.
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("message-content").last().locator("table")).toBeVisible();
  await expect(page.getByTestId("message-content").last()).toContainText("速度");

  /*
   * And there is **no card for the call at all**. `ila_table` renders nothing: the table is the
   * reply, so a box beside it could only repeat the summary — and the generic card would be worse
   * than redundant, since its disclosure renders the whole markdown as JSON inside a fold. This
   * is asserted on the absence of every card shape rather than on one testid: a call that fell
   * through to the generic disclosure is exactly the regression to catch.
   */
  const message = page.getByTestId("message-assistant").last();
  // `[data-tool-call-id]` is on *every* card shape, so this is "no card of any kind" rather than
  // a list of the ones that exist today — and the generic one is named separately because that
  // is the fallback a call with no branch of its own silently lands in.
  await expect(message.locator("[data-tool-call-id]")).toHaveCount(0);
  await expect(message.getByTestId("tool-call")).toHaveCount(0);

  /*
   * The **anchor** the panel's 定位 needs, since the card that used to carry it is gone. It is on
   * the message, which is the block the table is actually in.
   */
  await expect(message).toHaveAttribute("data-tool-call-anchor", "call_t1");
});

test("every table carries a title bar with actions", async ({ page, request }) => {
  /*
   * The title the reply never had. It comes from the `ila_table` **call** rather than from the
   * model's prose, which is what makes it certain: the row is the name the 图表 panel lists the
   * same table under, so the two cannot disagree. `apps/web/test/utils/markdown.test.ts` pins the
   * markup and the count guard; what only a browser can show is that the app renders it over the
   * table a reader is looking at.
   */
  const workspace = await figureSession(page, unique("表格标题"));
  await scriptTable(request, { name: "季度对比", summary: "三项指标的对比" });
  await send(page, "帮我做一个对比表");

  const body = page.getByTestId("message-content").last();
  const bar = body.locator("[data-table-block] .table-head").first();
  await expect(bar).toBeVisible();
  await expect(bar.locator(".table-name")).toHaveText("季度对比");

  // Both actions, and the note one is the feature: a table can now be annotated from the place it
  // is read, without going to the panel first.
  await expect(bar.locator("[data-table-note]")).toBeVisible();
  await expect(bar.locator("[data-copy-table]")).toBeVisible();

  /*
   * And the bar is chrome rather than the message's text. A note anchors to a quote counted over
   * the message's *visible* text, so a title counted as message text would shift every note
   * anchored below it — the same claim `code-block.spec.ts` makes for the code header.
   */
  await expect(bar).toHaveAttribute("data-note-skip", "");

  // It survives a reload, like the table itself: it is rendered from the persisted tool call.
  await page.reload();
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();
  await expect(
    page.getByTestId("message-content").last().locator(".table-head .table-name")
  ).toHaveText("季度对比");
});

test("a table with no ila_table call still gets a bar, with no note control", async ({
  page,
  request,
}) => {
  /*
   * A reply that writes a table without recording one. The bar is still drawn — "every inline
   * table has a title" is the requirement — but it says the generic word rather than inventing a
   * name, and the 标注/笔记 control is **absent**, because a note is anchored to a canonical name
   * and there is none to anchor to.
   */
  await figureSession(page, unique("表格无名"));
  await scriptLlm(request, { turns: [{ content: `随手一张表：\n\n${TABLE}` }] });
  await send(page, "随便看看");

  const body = page.getByTestId("message-content").last();
  const bar = body.locator("[data-table-block] .table-head").first();
  await expect(bar).toBeVisible();
  await expect(bar.locator(".table-name")).toHaveText("表格");
  await expect(bar.locator("[data-table-note]")).toHaveCount(0);
  await expect(bar.locator("[data-copy-table]")).toBeVisible();
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

  /*
   * 定位, which is the panel's one carried affordance and the thing that had to keep working when
   * the card went: with no card to land on, the anchor is the message the table is in.
   *
   * Three more exchanges first, because a jump is only *observable* when its target is off-screen
   * — the first version of this asserted the message was in the viewport on a conversation short
   * enough that it already was, and so passed with the anchor removed entirely. The assertion that
   * discriminates is the pair: out of view before the press, in view after it.
   */
  for (const n of [1, 2, 3]) {
    await scriptLlm(request, { turns: [{ content: `${n}. ` + "这是一段补充说明。".repeat(24) }] });
    await send(page, `继续 ${n}`);
    await expect(page.getByTestId("message-assistant")).toHaveCount(n + 1);
  }

  const tableMessage = page.getByTestId("message-assistant").filter({ has: page.locator("table") });
  await expect(tableMessage).toHaveCount(1);
  // The turn ended at the bottom of the list, which is where the table is not.
  await expect(tableMessage).not.toBeInViewport();

  await page.getByTestId("diagram-locate").first().click();
  await expect(tableMessage).toBeInViewport();
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
