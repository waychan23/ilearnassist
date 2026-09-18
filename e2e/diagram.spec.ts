import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Diagrams, end to end: the model draws one, the conversation shows it, the file lands in the
 * conversation's own folder, and the widget lists it.
 *
 * The rendering is the part only a browser can check — mermaid needs real layout, real
 * `getBBox` and real SVG measurement, none of which jsdom has — so `utils/mermaid` is
 * unit-tested for what it *decides* and this spec is where the drawing actually happens.
 *
 * Every render is waited on through `data-render-state` rather than by watching for an `<svg>`
 * to appear. An SVG that never arrives, one that arrived empty, and one that was refused all
 * look the same to a `toBeVisible()` timeout; the attribute tells them apart, and it turns a
 * race into an assertion.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/** A flowchart with a CJK label, so the assertion is on text rather than on geometry. */
const FLOW = "flowchart TD\n  A[开始] --> B[结束]";
/**
 * A drawing wider than the dialog that shows it.
 *
 * The zoom spec needs one: a two-node flow is a couple of hundred pixels across, so at 4× it still
 * fits the viewer and the scroll half of a zoom has nothing to prove.
 */
const WIDE =
  "flowchart LR\n  A[开始] --> B[读取] --> C[校验] --> D[处理] --> E[保存] --> F[完成]";
/** Mermaid cannot parse this: the arrow points at nothing. */
const BROKEN = "flowchart TD\n  A --> ";

/** A fresh workspace and conversation, with the diagram widget installed and its tab open. */
async function diagramSession(page: Page, name: string): Promise<string> {
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
 * The conversation on screen, through the API.
 *
 * By the workspace's name rather than by position: the suite shares one data root across
 * specs, so "the first workspace" is whichever spec ran first. The conversation is the only
 * one in a workspace this helper just made.
 */
async function sessionIdFor(request: APIRequestContext, workspaceName: string): Promise<string> {
  const workspaces = await (await request.get("/api/workspaces")).json();
  const workspace = workspaces.find((w: { name: string }) => w.name === workspaceName);
  expect(workspace).toBeTruthy();
  const sessions = await (await request.get(`/api/workspaces/${workspace.id}/sessions`)).json();
  expect(sessions).toHaveLength(1);
  return sessions[0].id;
}

/**
 * A turn whose first step draws `source` under `name`, and whose second says it is done.
 * `summary` is required on the real tool, so each call carries one; a caller that does not
 * care gets a deterministic stand-in.
 */
function scriptDiagram(
  request: APIRequestContext,
  args: ({ name: string; source: string; summary?: string } | { name: string; source: string; summary?: string })[]
    | { name: string; source: string; summary?: string }
): Promise<void> {
  const calls = (Array.isArray(args) ? args : [args]).map((call, i) => ({
    name: call.name,
    source: call.source,
    summary: call.summary ?? `${call.name} 的示意图`,
  }));
  return scriptLlm(request, {
    turns: [
      {
        content: "我画一张图。",
        toolCalls: calls.map((call, i) => ({
          id: `call_d${i + 1}`,
          name: "ila_diagram",
          args: call,
        })),
      },
      { content: "画好了。" },
    ],
  });
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

/** The diagram card in the conversation. */
function card(page: Page) {
  return page.getByTestId("diagram-card").last();
}

async function waitForDiagram(page: Page, state = "ready"): Promise<void> {
  await expect(card(page).getByTestId("mermaid")).toHaveAttribute("data-render-state", state, {
    timeout: 20_000,
  });
}

test("the model's diagram is drawn in the conversation", async ({ page, request }) => {
  await diagramSession(page, unique("图表绘制"));
  await scriptDiagram(request, { name: "auth flow", source: FLOW });
  await send(page, "画一个登录流程图");

  await expect(card(page)).toBeVisible({ timeout: 20_000 });
  await waitForDiagram(page);

  /*
   * Text, never coordinates. `htmlLabels: false` makes every label a real SVG `<text>`, so the
   * label is in the output — and a geometry assertion would be font-dependent, passing on one
   * machine and failing on the next.
   */
  await expect(card(page).getByTestId("mermaid").locator("svg")).toContainText("开始");

  const head = card(page).getByTestId("diagram-head");
  // The tool's *display name*, from `tools.name.ila_diagram`. Asserted here because the
  // fallback is silent: the card resolves the key through `te()` and renders the raw tool name
  // when it is missing, so a dropped key shows up as `ila_diagram` on screen and nowhere else.
  await expect(head).toContainText("图表");
  // And the diagram's own name, the way the model named it rather than the way the file is
  // spelled: `auth flow` is what the conversation reads as, `auth-flow.mmd` is what the folder
  // holds. The panel lists the file, the card labels the drawing.
  await expect(head).toContainText("auth flow");
  // The card carries the jump anchor, which is what the panel's 定位 scrolls to.
  await expect(card(page)).toHaveAttribute("data-tool-call-id", "call_d1");
});

test("the diagram is written to the conversation's own folder", async ({ page, request }) => {
  const name = await diagramSession(page, unique("图表落盘"));
  await scriptDiagram(request, { name: "login flow", source: FLOW });
  await send(page, "画一个登录流程图");
  await waitForDiagram(page);

  /*
   * Through the API, because the point is that the *file* is there. The card renders from the
   * tool call's own arguments — that is what makes it replayable — so it would look exactly
   * the same if nothing had been written at all.
   */
  const id = await sessionIdFor(request, name);
  const listing = await (await request.get(`/api/sessions/${id}/files?path=`)).json();
  expect(listing.entries.map((e: { name: string }) => e.name)).toContain("login-flow.mmd");

  const content = await (await request.get(`/api/sessions/${id}/files/content?path=login-flow.mmd`)).json();
  expect(content.kind).toBe("diagram");
  expect(content.text).toBe(FLOW);
});

test("a diagram mermaid cannot parse does not blank the reply", async ({ page, request }) => {
  await diagramSession(page, unique("图表失败"));
  await scriptDiagram(request, { name: "broken", source: BROKEN });
  await send(page, "画一张坏的图");

  await waitForDiagram(page, "failed");

  // Both halves matter: the failure is explained, *and* the model's own prose is still on
  // screen. A diagram that took the whole message down with it is the outcome this prevents —
  // a reader could not tell that from a reply which said nothing at all.
  await expect(card(page).getByTestId("mermaid-error")).toBeVisible();
  await expect(page.getByText("画好了。")).toBeVisible();
});

test("a diagram the model could not write is reported, not drawn empty", async ({
  page,
  request,
}) => {
  await diagramSession(page, unique("图表被拒"));
  // The tool refuses an empty source outright, and the loop writes that refusal into the
  // output — which is what the card shows instead of an empty frame where a picture belongs.
  await scriptDiagram(request, { name: "empty", source: "   " });
  await send(page, "画一张空图");

  await expect(card(page).getByTestId("diagram-failure")).toBeVisible({ timeout: 20_000 });
  await expect(card(page)).toContainText("empty");
});

test("the viewer opens larger and zooms", async ({ page, request }) => {
  await diagramSession(page, unique("图表查看器"));
  await scriptDiagram(request, { name: "zoomable", source: WIDE });
  await send(page, "画一个流程图");
  await waitForDiagram(page);

  await card(page).getByTestId("diagram-expand").click();
  const viewer = page.getByTestId("diagram-viewer");
  await expect(viewer).toBeVisible();
  // A second render, in a second box — so it has its own state to wait on.
  await expect(viewer.getByTestId("mermaid")).toHaveAttribute("data-render-state", "ready", {
    timeout: 20_000,
  });

  /*
   * Everything below is a **measurement**, and that is the point of this spec's shape.
   *
   * It previously asserted only the readout — that pressing 放大 left "125%" on screen — and it
   * passed for as long as the control did nothing useful, because the readout was the one half of
   * the arrangement that worked. A zoom is a claim about pixels, so it is measured in pixels, and
   * it is measured on the *drawing* rather than on a wrapper this implementation happens to use:
   * "the picture got bigger" is the feature; how it got bigger is not.
   */
  const drawn = viewer.getByTestId("mermaid");
  const widthOf = async () => (await drawn.boundingBox())!.width;
  const at100 = await widthOf();
  expect(at100).toBeGreaterThan(0);

  await viewer.getByTestId("diagram-zoom-in").click();
  await expect(viewer.getByTestId("diagram-zoom")).toHaveText("125%");
  // Polled rather than read once: the scale lands on the next frame.
  await expect.poll(widthOf).toBeGreaterThan(at100 * 1.2);

  // The readout is the control that goes back to 100 %, which is where 适应窗口 used to be.
  await viewer.getByTestId("diagram-zoom").click();
  await expect(viewer.getByTestId("diagram-zoom")).toHaveText("100%");
  await expect.poll(widthOf).toBeCloseTo(at100, 0);

  // And outwards below 100 %, which is the third direction.
  await viewer.getByTestId("diagram-zoom-out").click();
  await expect.poll(widthOf).toBeLessThan(at100);

  /*
   * **The assertion that catches the bug this spec was rewritten for**, and the reason the three
   * above are not enough on their own.
   *
   * The old arrangement scaled with the CSS `zoom` property on a full-width block, which left the
   * drawing's size derived from its *container*: whatever the factor, the picture came out at
   * `min(container, natural × zoom)` — it could never be wider than the box it was in. So a small
   * factor on a small drawing did move, which is why the run above is not a proof of anything on
   * its own, while for a diagram that already filled the box (`useMaxWidth` makes that the common
   * case) nothing happened at all, at any factor.
   *
   * A drawing that can be enlarged past its window is therefore the whole difference, and it is
   * asserted as such: the picture gets wider than the container *and* the container can scroll to
   * all of it — which is what makes the enlargement usable rather than a picture cropped by its own
   * frame.
   */
  const body = viewer.getByTestId("diagram-viewer-body");
  await viewer.getByTestId("diagram-zoom").click();
  for (let i = 0; i < 4; i += 1) await viewer.getByTestId("diagram-zoom-in").click();

  const viewportWidth = await body.evaluate((el) => el.clientWidth);
  await expect.poll(widthOf).toBeGreaterThan(viewportWidth);
  const finalWidth = await widthOf();
  await expect
    .poll(() => body.evaluate((el) => el.scrollWidth))
    .toBeGreaterThanOrEqual(Math.floor(finalWidth));

  await viewer.getByTestId("diagram-viewer-close").click();
  await expect(viewer).toBeHidden();
});

test("the viewer maximises, and downloads the drawing in three formats", async ({ page, request }) => {
  await diagramSession(page, unique("图表下载"));
  await scriptDiagram(request, { name: "downloadable", source: FLOW });
  await send(page, "画一个流程图");
  await waitForDiagram(page);

  await card(page).getByTestId("diagram-expand").click();
  const viewer = page.getByTestId("diagram-viewer");
  await expect(viewer.getByTestId("mermaid")).toHaveAttribute("data-render-state", "ready", {
    timeout: 20_000,
  });

  /*
   * Maximise, asserted on the *box* rather than on the class. The class is what this added, so a
   * maximised dialog that stayed 720px wide would satisfy a check on the class and fail at the only
   * thing the user sees.
   */
  const dialog = viewer.locator(".modal");
  const before = (await dialog.boundingBox())!;
  await viewer.getByTestId("diagram-viewer-maximize").click();
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeGreaterThan(before.width);
  await viewer.getByTestId("diagram-viewer-maximize").click();
  await expect.poll(async () => (await dialog.boundingBox())!.width).toBeCloseTo(before.width, 0);

  /*
   * Each format, as a real file. The name is asserted because it is the one part a download can
   * get wrong without failing: a file called `download` with no extension arrives unopenable, and
   * the only place that shows up is the name.
   */
  for (const format of ["png", "jpg", "svg"] as const) {
    await viewer.getByTestId("diagram-download").click();
    const download = page.waitForEvent("download");
    await viewer.getByTestId(`diagram-download-${format}`).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`downloadable.${format}`);

    // Non-empty, and written as the format it claims. The bytes matter: a broken SVG string
    // rasterises to a blank canvas, and a blank PNG is still a valid PNG.
    const path = await file.path();
    const bytes = readFileSync(path);
    expect(bytes.byteLength).toBeGreaterThan(100);
  }
});

test("the widget lists what the conversation has drawn, and locates it", async ({
  page,
  request,
}) => {
  const workspaceName = await diagramSession(page, unique("图表面板"));
  await expect(page.getByTestId("diagram-empty")).toBeVisible();

  await scriptDiagram(request, {
    name: "panel flow",
    source: FLOW,
    summary: "登录流程图：提交、校验、进入工作台",
  });
  await send(page, "画一个流程图");

  // No reload: the row arrives off `diagram.changed`, emitted when the tool's `tool_end` lands.
  const row = page.getByTestId("diagram-row").first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // The stem of the canonical file name, and the model's summary from the row.
  await expect(row).toContainText("panel-flow");
  await expect(row).toContainText("登录流程图：提交、校验、进入工作台");

  // The summary survives a reload — it is the persisted tool arguments and the row, neither
  // of which is transient turn state. The walk back in is the `chat.spec.ts` idiom: a reload
  // would stay in the conversation, so going through the front door is what re-reads it.
  await page.reload();
  await enterWorkspace(page, workspaceName);
  await page.getByTestId("session-item").first().click();
  await page.getByTestId("widget-tab-diagram").click();
  await expect(page.getByTestId("diagram-row").first()).toContainText(
    "登录流程图：提交、校验、进入工作台"
  );

  // 定位 scrolls the conversation to the call that drew it.
  await page.getByTestId("diagram-locate").first().click();
  await expect(card(page)).toBeInViewport();

  // The card's enlarged view carries the same summary.
  await card(page).getByTestId("diagram-expand").click();
  await expect(page.getByTestId("diagram-summary")).toContainText(
    "登录流程图：提交、校验、进入工作台"
  );
  await page.getByTestId("diagram-viewer-close").click();

  // And the row opens the ordinary file preview, which draws the same file and carries the
  // summary the session-file route attaches from the row.
  await page.getByTestId("diagram-row").first().click();
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await expect(page.getByTestId("file-preview-diagram-summary")).toContainText(
    "登录流程图：提交、校验、进入工作台"
  );
  await expect(
    page.getByTestId("file-preview-diagram").getByTestId("mermaid")
  ).toHaveAttribute("data-render-state", "ready", { timeout: 20_000 });

  // The source is the other view of the same file, and the one a reader copies from.
  await page.getByTestId("file-preview-source").click();
  await expect(page.getByTestId("file-preview-diagram-source")).toContainText("开始");
});

test("a diagram's own file stays out of the library, and is opened from the panel", async ({
  page,
  request,
}) => {
  await diagramSession(page, unique("会话文件"));
  await scriptDiagram(request, [
    { name: "browsable", source: FLOW },
  ]);
  await send(page, "画一个流程图");
  await expect(page.getByTestId("diagram-row").first()).toBeVisible({ timeout: 20_000 });

  /*
   * **A diagram's `.mmd` is deliberately not in the library**, and this is the case that says so.
   *
   * v3 gave a diagram a `sources` row so it could be seen, which is exactly the muddle the v4
   * split undoes: a diagram's file is a `files` row with **no** reference, so it is in the 图表
   * panel and nowhere else. The requirement's own words — "cancel one source per diagram" — are
   * what this asserts, and asserting the *absence* is the only way to tell "not listed" from
   * "listed under a name I did not guess".
   */
  await page.getByTestId("open-library").click();
  const dialog = page.getByTestId("library-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("resource-row").filter({ hasText: "browsable.mmd" })).toHaveCount(0);

  // The panel is where it lives, and it opens the same viewer the library row would have.
  await page.keyboard.press("Escape");
  await page.getByTestId("diagram-row").first().click();

  await expect(page.getByTestId("file-preview-diagram").getByTestId("mermaid")).toHaveAttribute(
    "data-render-state",
    "ready",
    { timeout: 20_000 }
  );
  await page.getByTestId("file-preview-close").click();
  await expect(dialog).toBeHidden();
});

test("a .mmd in the workspace previews as a diagram, with no model involved", async ({
  page,
  request,
}) => {
  /*
   * The kind is decided by the extension, so the workspace browser inherits the rendering for
   * free: a model that `write_file`s a `.mmd` gets a diagram when the user clicks it, and so
   * does a file they wrote themselves. No LLM here — the file is seeded directly, which is
   * also what makes this a test of the *preview* rather than of the tool.
   */
  const name = unique("图表预览");
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();

  const workspaces = await (await request.get("/api/workspaces")).json();
  const workspace = workspaces.find((w: { name: string }) => w.name === name);
  expect(workspace).toBeTruthy();
  // The one place a spec derives the on-disk layout itself: nothing writes into the workspace
  // over HTTP by design, so seeding a file is a filesystem job.
  writeFileSync(join(workspace.dirPath, "workdir", "hand-written.mmd"), FLOW, "utf8");

  await enterWorkspace(page, name);
  await page.getByTestId("sidebar-tab-files").click();
  await page.getByTestId("file-row").filter({ hasText: "hand-written.mmd" }).first().click();

  const stage = page.getByTestId("file-preview-diagram");
  await expect(stage.getByTestId("mermaid")).toHaveAttribute("data-render-state", "ready", {
    timeout: 20_000,
  });
  await expect(stage.locator("svg")).toContainText("开始");
});

test("a theme change redraws the diagram", async ({ page, request }) => {
  /*
   * The only place the token → `themeVariables` derivation can be checked at all.
   * `style.test.ts` scans the stylesheet and cannot see inline SVG attributes, and jsdom does
   * not apply the sheet — so if this did not hold, the runtime derivation would be the entire
   * mechanism with nothing holding it up.
   */
  await diagramSession(page, unique("图表主题"));
  await scriptDiagram(request, { name: "themed", source: FLOW });
  await send(page, "画一个流程图");
  await waitForDiagram(page);

  const nodeFill = (): Promise<string> =>
    card(page)
      .getByTestId("mermaid")
      .locator("svg .node rect")
      .first()
      .evaluate((el) => getComputedStyle(el).fill);

  const before = await nodeFill();

  /*
   * Two clicks, not one. The mode starts on `auto`, the button cycles auto → light → dark, and
   * the run's emulated colour scheme is light — so the first click lands on light and the
   * *resolved* theme does not move. Clicking once would leave the palette identical and this
   * test would be asserting nothing.
   */
  await page.getByTestId("theme-toggle").click();
  await page.getByTestId("theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  /*
   * Polled rather than read once. Mermaid fills a node from `themeVariables.primaryColor`, a
   * palette token, so a redraw under the other theme has to change it — but the redraw is
   * asynchronous, and reading the fill immediately after the click could sample the old
   * drawing and pass for the wrong reason, or fail for one.
   */
  await expect
    .poll(nodeFill, { timeout: 20_000, message: "the diagram should be redrawn for dark" })
    .not.toBe(before);
});

test("the diagram panel installs itself when a diagram is drawn without one", async ({
  page,
  request,
}) => {
  /*
   * `auto-install`, and the conversation is drawn into a session that installs nothing — so the
   * panel is not merely on another tab, it is not rendered at all until the tool call puts it
   * there. The diagram itself is visible either way, inline as its own card, which is why the
   * assertion is about the *tab* rather than about the drawing.
   */
  const name = unique("图表自动安装");
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("widget-tab-diagram")).toHaveCount(0);

  await scriptDiagram(request, { name: "auto flow", source: FLOW });
  await send(page, "画一个流程图");

  await waitForDiagram(page);
  await expect(page.getByTestId("widget-tab-diagram")).toBeVisible();

  // The reader is not pulled onto it: the drawing is already on screen, and the panel would
  // move them away from it. Clicking it opens the panel on the diagram that was just drawn.
  await page.getByTestId("widget-tab-diagram").click();
  await expect(page.getByTestId("diagram-row").first()).toContainText("auto flow");
});
