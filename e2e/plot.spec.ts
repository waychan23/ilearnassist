import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Plotted figures, end to end: the model passes a spec, the app draws it inline, and the 图表
 * panel lists it beside the diagrams and tables.
 *
 * The renderer itself has unit tests — `apps/web/test/utils/plotSpec.test.ts` holds the mapping
 * and the serialisation — and what only a browser can prove is the wiring the unit tests cannot
 * see: that a real `function-plot` chunk draws, that the card renders the drawing rather than the
 * spec, that the panel row opens the same viewer a table uses, and that a refused spec leaves a
 * sentence rather than a blank frame.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/** A parabola with a labelled vertex — one curve and one text, so both paths are exercised. */
const GOOD_SPEC = {
  title: "抛物线",
  x: { domain: [-4, 4], label: "x" },
  y: { domain: [-2, 8], label: "y" },
  grid: true,
  elements: [
    { kind: "function", expr: "x^2 - 2*x", from: -4, to: 4 },
    { kind: "text", at: [1, -1], text: "顶点" },
  ],
};

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

/** One turn that plots a figure, then says it is done. */
function scriptPlot(
  request: APIRequestContext,
  args: { name: string; spec?: unknown; summary?: string }
): Promise<void> {
  return scriptLlm(request, {
    turns: [
      {
        content: "我画一下。",
        toolCalls: [
          {
            id: "call_p1",
            name: "ila_plot",
            args: {
              name: args.name,
              spec: args.spec ?? GOOD_SPEC,
              summary: args.summary ?? `${args.name} 的图`,
            },
          },
        ],
      },
      { content: "画好了。" },
    ],
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

test("a plotted figure renders inline as a drawing, with its label", async ({ page, request }) => {
  await figureSession(page, unique("坐标图内联"));
  await scriptPlot(request, { name: "抛物线" });
  await send(page, "画一个抛物线");

  // The card, and the figure inside it: `data-render-state` is what makes an async-looking
  // render assertable — waiting on an `<svg>` could not tell "still drawing" from "drew nothing".
  const card = page.getByTestId("plot-card").last();
  await expect(card).toBeVisible();
  const figure = card.getByTestId("plot");
  await expect(figure).toHaveAttribute("data-render-state", "ready", { timeout: 20_000 });

  // A real drawing with the model's own label in it. `htmlLabels: false`-style SVG text is not a
  // thing here, but the same claim holds: the text is in the output, so a spec can assert on it
  // rather than on coordinates.
  await expect(figure.locator("svg")).toBeVisible();
  await expect(figure.locator("svg")).toContainText("顶点");

  // Offset placement: the card sits between the two steps' prose rather than above them.
  const intro = page.getByText("我画一下。", { exact: true });
  const outro = page.getByText("画好了。", { exact: true });
  const [introBox, cardBox, outroBox] = await Promise.all([
    intro.boundingBox(),
    card.boundingBox(),
    outro.boundingBox(),
  ]);
  expect(introBox!.y + introBox!.height).toBeLessThanOrEqual(cardBox!.y);
  expect(cardBox!.y + cardBox!.height).toBeLessThanOrEqual(outroBox!.y);

  // The head names the tool and the model's own figure name, and 定位's anchor is the call.
  await expect(card.getByTestId("plot-head")).toContainText("坐标图");
  await expect(card.getByTestId("plot-head")).toContainText("抛物线");
  await expect(card).toHaveAttribute("data-tool-call-id", "call_p1");

  // The spec disclosure shows the data rather than a second rendering of it.
  await card.getByTestId("plot-head").click();
  await expect(card.locator(".plot-source")).toContainText('"kind"');
});

test("the panel lists the figure and opens it in the viewer", async ({ page, request }) => {
  await figureSession(page, unique("坐标图面板"));
  await scriptPlot(request, { name: "抛物线", summary: "二次函数图像" });
  await send(page, "画一个抛物线");

  const row = page.getByTestId("diagram-row").filter({ hasText: "抛物线" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("二次函数图像");

  // A plot has no file, so its row opens the viewer directly — the table's path, and the reason
  // the panel's three kinds are two open flows rather than three.
  await row.click();
  const viewer = page.getByTestId("diagram-viewer");
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".modal-head h3")).toContainText("抛物线");
  await expect(viewer.getByTestId("diagram-summary")).toContainText("二次函数图像");
  await expect(viewer.getByTestId("plot")).toHaveAttribute("data-render-state", "ready", {
    timeout: 20_000,
  });
  await expect(viewer.getByTestId("figure-box").locator("svg")).toBeVisible();

  // The download control is the drawing's, and an SVG of a plot is exactly what was on screen —
  // the serialised string is the render.
  const download = viewer.getByTestId("diagram-download");
  await download.click();
  const choice = viewer.getByTestId("diagram-download-svg");
  const [saved] = await Promise.all([page.waitForEvent("download"), choice.click()]);
  expect(saved.suggestedFilename()).toBe("抛物线.svg");
});

test("the geometry kinds draw: a circle, a filled polygon and a vector", async ({
  page,
  request,
}) => {
  /*
   * The two constructs the adapter builds itself are the ones worth a browser: a circle is an
   * implicit equation and a polygon is an overlay `<path>` drawn from the chart's own scales.
   * Both have unit-tested mappings, and what only a real render can show is that the library
   * accepted what the adapter handed it — the circle's interval sampler runs, and the overlay
   * path lands in the SVG with the fill marker below.
   */
  await figureSession(page, unique("坐标图几何"));
  await scriptPlot(request, {
    name: "几何图形",
    spec: {
      x: { domain: [-5, 5], label: "x" },
      y: { domain: [-5, 5], label: "y" },
      elements: [
        { kind: "circle", center: [0, 0], radius: 3 },
        { kind: "polygon", points: [[-4, -2], [4, -2], [0, 3]], fill: true },
        { kind: "vector", from: [0, 0], to: [3, 2] },
        { kind: "segment", from: [-4, 3], to: [4, 3], dashed: true },
        { kind: "points", points: [[1, 1], [2, -1]] },
        { kind: "text", at: [0, 0], text: "O" },
      ],
    },
  });
  await send(page, "画几何图形");

  const figure = page.getByTestId("plot-card").last().getByTestId("plot");
  await expect(figure).toHaveAttribute("data-render-state", "ready", { timeout: 30_000 });
  await expect(figure.locator("svg")).toContainText("O");
  // The circle's interval-sampler output is a path with a stroke, so at least one exists.
  await expect(figure.locator("svg path.line").first()).toBeVisible();
  // The polygon overlay: one path carrying the fill marker `drawPolygons` sets.
  await expect(figure.locator('svg path[fill-opacity="0.18"]')).toHaveCount(1);
  // The vector's arrowhead is a `marker-end`, which only the vector path carries.
  await expect(figure.locator("svg path[marker-end]")).toHaveCount(1);
});

test("a refused spec shows the tool's own sentence, not a blank frame", async ({
  page,
  request,
}) => {
  await figureSession(page, unique("坐标图拒绝"));
  // `foo` is outside the drawing language, so the tool refuses before writing — which is the
  // case a card has to survive, because there is no spec worth drawing and no row to list.
  await scriptPlot(request, {
    name: "坏图",
    spec: { elements: [{ kind: "function", expr: "foo(x)" }] },
  });
  await send(page, "画一个画不出来的");

  const card = page.getByTestId("plot-card").last();
  await expect(card.getByTestId("plot-failure")).toBeVisible();
  await expect(card.getByTestId("plot-failure")).toContainText("formula");
  // No drawing was attempted, and no panel row was written.
  await expect(card.getByTestId("plot")).toHaveCount(0);
  await expect(page.getByTestId("diagram-row").filter({ hasText: "坏图" })).toHaveCount(0);
});

const PARABOLA_SPEC = { elements: [{ kind: "function", expr: "x^2" }] };

test("the panel filters three kinds once it holds all three", async ({ page, request }) => {
  await figureSession(page, unique("坐标图筛选"));
  await scriptPlot(request, { name: "抛物线", spec: PARABOLA_SPEC });
  await send(page, "画一个抛物线");
  await expect(page.getByTestId("diagram-row").filter({ hasText: "抛物线" })).toBeVisible();

  // One kind present: no filter strip, the same rule the two-kind case follows.
  await expect(page.getByTestId("figure-filter")).toHaveCount(0);

  // A diagram and a table too, then the strip appears with all three options.
  await scriptLlm(request, {
    turns: [
      {
        content: "画一张。",
        toolCalls: [
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name: "flow", source: "flowchart TD\n  A --> B", summary: "流程图" },
          },
        ],
      },
      { content: "画好了。" },
    ],
  });
  await send(page, "画一个流程图");
  // Wait the turn out before the next script: a queued turn still unconsumed would be
  // wiped by the next scriptLlm reset (this was a pre-existing race in the test).
  await expect(page.getByTestId("diagram-row").filter({ hasText: "flow" })).toBeVisible();

  await scriptLlm(request, {
    turns: [
      {
        content: "记一下。",
        toolCalls: [
          {
            id: "call_t1",
            name: "ila_table",
            args: { name: "对比", table: "| a |\n| --- |\n| 1 |", summary: "对比表" },
          },
        ],
      },
      { content: "记好了。" },
    ],
  });
  await send(page, "记一个表格");
  await expect(page.getByTestId("diagram-row").filter({ hasText: "对比" })).toBeVisible();

  const filter = page.getByTestId("figure-filter");
  await expect(filter).toBeVisible();
  await expect(page.getByTestId("figure-count")).toHaveText("3");

  await filter.selectOption("plot");
  await expect(page.getByTestId("diagram-row")).toHaveCount(1);
  await expect(page.getByTestId("diagram-row")).toContainText("抛物线");

  await filter.selectOption("table");
  await expect(page.getByTestId("diagram-row")).toHaveCount(1);
  await expect(page.getByTestId("diagram-row")).toContainText("对比");
});
