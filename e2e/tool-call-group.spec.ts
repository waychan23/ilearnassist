import { expect, test, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * A run of consecutive tool calls, folded into one card.
 *
 * A turn that searches, fetches and reads renders one full-width card per call, and the reply
 * they were all on the way to ends up below the fold. The grouping rule itself is unit-tested in
 * `apps/web/test/utils/toolCallGroups.test.ts`; what is only reachable from here is the wiring —
 * that the message list actually draws the fold, that a run of one is untouched by it, and that
 * opening a run survives the streaming message becoming a persisted one.
 *
 * **What this spec cannot see:** the head's *running* wording ("正在使用工具[X]…"). Every tool
 * the offline suite can reach is a local file operation, finished in a few milliseconds, so
 * there is no moment at which a browser could catch one in flight — the assertion would be
 * racing the machine rather than testing the app. That branch is pinned in the unit test
 * instead, on the decision rather than on the rendered string.
 */

const MERMAID = "graph TD\n  A[开始] --> B[结束]";

/**
 * A workspace of this spec's own, entered.
 *
 * `chat.spec.ts` asserts on how many conversations the default workspace holds, so a spec that
 * has one of its own has to bring one — the note `ask-user.spec.ts` carries.
 */
async function createAndEnter(page: Page, name: string): Promise<void> {
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);
}

async function openSession(page: Page): Promise<void> {
  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

/** The folded card, and the control that opens it. */
const group = (page: Page) => page.getByTestId("tool-call-group");
const toggle = (page: Page) => page.getByTestId("tool-call-group-toggle");

/**
 * Three ordinary actions in one step — the shape this feature exists for.
 *
 * All three are **groupable**, which is what makes them "ordinary": `write_file` is deliberately
 * not one of them any more (its card renders the file, so it breaks a run like a diagram), and
 * the case below it pins that.
 */
const THREE_CALLS = [
  { id: "call_ls", name: "list_files", args: { path: "." } },
  { id: "call_read", name: "read_file", args: { path: "a.txt" } },
  { id: "call_fetch", name: "web_fetch", args: { url: "https://example.com" } },
];

test("a run of consecutive tool calls is one card, and opens into all of them", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "折叠工具调用",
    turns: [{ content: "我先看几眼。", toolCalls: THREE_CALLS }, { content: "都看完了。" }],
  });

  const workspace = `折叠 ${Date.now()}`;
  await page.goto("/");
  await createAndEnter(page, workspace);
  await openSession(page);
  await send(page, "看几个文件");
  await expect(page.getByTestId("message-assistant").last()).toContainText("都看完了。");

  // One line where three cards used to be, and no individual cards rendered at all.
  await expect(group(page)).toHaveCount(1);
  await expect(page.getByTestId("tool-call")).toHaveCount(0);

  const head = toggle(page);
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(head).toContainText("3 个工具调用");

  // Opening it gives back the cards the reader would have seen ungrouped — the fold hides
  // nothing, it only folds.
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-call")).toHaveCount(3);
  await expect(page.getByTestId("tool-call").first()).toContainText("列出文件");
  await expect(page.getByTestId("tool-call").last()).toContainText("读取网页");

  // The same control folds it back.
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("tool-call")).toHaveCount(0);

  // --- reload: the fold is a view of the persisted message, not a streaming artefact ---
  await page.reload();
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();
  await expect(group(page)).toHaveCount(1);
  await expect(page.getByTestId("tool-call")).toHaveCount(0);
  await expect(toggle(page)).toContainText("3 个工具调用");
});

test("a lone tool call is the card it always was", async ({ page, request }) => {
  /*
   * The threshold's other side, and the guard that this feature did not quietly restyle every
   * existing turn: one call is already one line, and folding it into a card that says "1 个工具
   * 调用" would trade a label that names the tool for a number.
   */
  await scriptLlm(request, {
    turns: [
      { content: "我看一眼。", toolCalls: [{ id: "call_ls", name: "list_files", args: { path: "." } }] },
      { content: "看完了。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `单个 ${Date.now()}`);
  await openSession(page);
  await send(page, "看看");
  await expect(page.getByTestId("message-assistant").last()).toContainText("看完了。");

  await expect(group(page)).toHaveCount(0);
  await expect(page.getByTestId("tool-call")).toHaveCount(1);
  await expect(page.getByTestId("tool-call").first()).toContainText("列出文件");
});

test("a diagram breaks a run rather than being folded into it", async ({ page, request }) => {
  /*
   * The diagram card renders a drawing, and a count is not a drawing. So the run stops either
   * side of it: two calls fold, the diagram does not, and neither swallows the other.
   */
  await scriptLlm(request, {
    turns: [
      {
        content: "我先看看再画。",
        toolCalls: [
          ...THREE_CALLS.slice(0, 2),
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name: "流程", source: MERMAID, summary: "流程图" },
          },
        ],
      },
      { content: "画好了。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `图表 ${Date.now()}`);
  await openSession(page);
  await send(page, "画个图");
  await expect(page.getByTestId("message-assistant").last()).toContainText("画好了。");

  // The two ordinary calls folded into one line; the drawing is still a drawing.
  await expect(group(page)).toHaveCount(1);
  await expect(toggle(page)).toContainText("2 个工具调用");
  await expect(page.getByTestId("diagram-card")).toHaveCount(1);

  await toggle(page).click();
  await expect(page.getByTestId("tool-call")).toHaveCount(2);
});

test("a written file breaks a run rather than being folded into it", async ({ page, request }) => {
  /*
   * The diagram's reason, one tool over: the file card renders the **file**, so folding it into a
   * count would hide the artifact behind a number. A turn that reads two files and writes one
   * therefore shows the write as a card and folds only the two reads.
   *
   * `apps/web/test/utils/toolCallGroups.test.ts` pins the rule; what is here is that the message
   * list draws it — and that the file is not simply swallowed by the run it sits inside.
   */
  await scriptLlm(request, {
    turns: [
      {
        content: "我先看看再写。",
        toolCalls: [
          { id: "call_ls", name: "list_files", args: { path: "." } },
          { id: "call_read", name: "read_file", args: { path: "a.txt" } },
          { id: "call_write", name: "write_file", args: { path: "b.txt", content: "hi" } },
        ],
      },
      { content: "写好了。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `写文件 ${Date.now()}`);
  await openSession(page);
  await send(page, "写个文件");
  await expect(page.getByTestId("message-assistant").last()).toContainText("写好了。");

  // The two reads folded into one line; the written file is still a file.
  await expect(group(page)).toHaveCount(1);
  await expect(toggle(page)).toContainText("2 个工具调用");
  await expect(page.getByTestId("file-card")).toHaveCount(1);

  await toggle(page).click();
  await expect(page.getByTestId("tool-call")).toHaveCount(2);
});

test("a run opened mid-turn stays open when the turn ends", async ({ page, request }) => {
  /*
   * The reason the open set is not a `ref` inside the card.
   *
   * `ChatView` renders the live turn as one `MessageItem` and the persisted one as another, and
   * swaps them in a single tick when `message_done` lands. A flag owned by either instance would
   * therefore snap a group shut at the exact moment the turn ended — content collapsing under
   * the reader while they were reading it. The held second turn is what makes the moment
   * reachable: without it the swap happens too fast for a browser to have opened anything.
   */
  await scriptLlm(request, {
    turns: [
      { content: "我先看几眼。", toolCalls: THREE_CALLS.slice(0, 2) },
      { content: "都看完了。", holdMs: 1000 },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `展开 ${Date.now()}`);
  await openSession(page);
  await send(page, "看几个文件");

  // The turn is still in flight: the group exists, and the composer still offers Stop.
  await expect(page.getByTestId("composer-stop")).toBeVisible();
  await expect(group(page)).toHaveCount(1);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");

  // The turn ends, the streaming message is replaced by the persisted one...
  await expect(page.getByTestId("message-assistant").last()).toContainText("都看完了。");
  await expect(page.getByTestId("composer-send")).toBeVisible();

  // ...and the run the reader opened is still open.
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("tool-call")).toHaveCount(2);
});
