import { writeFileSync } from "node:fs";
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
  await scriptDiagram(request, { name: "zoomable", source: FLOW });
  await send(page, "画一个流程图");
  await waitForDiagram(page);

  await card(page).getByTestId("diagram-expand").click();
  const viewer = page.getByTestId("diagram-viewer");
  await expect(viewer).toBeVisible();
  // A second render, in a second box — so it has its own state to wait on.
  await expect(viewer.getByTestId("mermaid")).toHaveAttribute("data-render-state", "ready", {
    timeout: 20_000,
  });

  await viewer.getByTestId("diagram-zoom-in").click();
  await expect(viewer.getByTestId("diagram-zoom")).toHaveText("125%");
  await viewer.getByTestId("diagram-fit").click();
  await expect(viewer.getByTestId("diagram-zoom")).toHaveText("100%");

  await viewer.getByTestId("diagram-viewer-close").click();
  await expect(viewer).toBeHidden();
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
  // of which is transient turn state. The app remembers neither the workspace nor the session
  // across a reload, so walk back in (the `chat.spec.ts` idiom) before reading the panel.
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

test("the conversation's folder is browsable from the chat header", async ({ page, request }) => {
  await diagramSession(page, unique("会话文件"));
  await scriptDiagram(request, [
    { name: "browsable", source: FLOW },
  ]);
  await send(page, "画一个流程图");
  await expect(page.getByTestId("diagram-row").first()).toBeVisible({ timeout: 20_000 });

  // Opened from the header rather than from the panel: the folder is the conversation's, and
  // it is reachable without installing anything.
  await page.getByTestId("open-session-files").click();
  const dialog = page.getByTestId("session-files");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("session-file-row").first()).toContainText("browsable.mmd");

  await dialog.getByTestId("session-file-row").first().click();
  await expect(page.getByTestId("file-preview-diagram").getByTestId("mermaid")).toHaveAttribute(
    "data-render-state",
    "ready",
    { timeout: 20_000 }
  );
  await page.getByTestId("file-preview-close").click();
  await dialog.getByTestId("session-files-done").click();
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
