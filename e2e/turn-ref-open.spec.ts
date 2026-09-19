import { expect, test, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { annotate, selectAndAsk } from "./notes";
import { enterWorkspace } from "./workspaces";

/**
 * Pressing a reference in a message that was sent.
 *
 * The chip over a sent user turn used to be a record and nothing more — it said what the turn was
 * about and left the reader to go and find the thing. Every kind now opens what it points at, and
 * **what that means differs per kind**, which is the whole content of this file: a passage scrolls
 * the conversation back to its words, a diagram opens the file its tool wrote, a note opens the
 * window the panel writes through, and a question scrolls to the card that asked it. Four
 * mechanisms, one chip, and each is a component agreeing with another about one array — which is
 * what only a browser can check.
 *
 * The setup is a real conversation each time, because a reference is *made* by a gesture: it is
 * staged from a panel or a selection, sent with a question, and persisted. Seeding it through the
 * API would test the reader's half of nothing.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/**
 * Padding tall enough to push a message list past the viewport.
 *
 * Two of the four cases are about *scrolling*, and a list that fits on screen has nothing to
 * scroll — the control would appear to work while doing nothing.
 */
const FILLER = "这一段只是用来把消息列表撑得比视口更高，好让滚动条真的存在。\n".repeat(24);

/** The passage the first reply is asked about, at the top of it. */
const PASSAGE = "光反应阶段产生 ATP，暗反应固定二氧化碳。";

/** A reply with the passage above a wall of filler, so its top is off screen at the end. */
const TALL_REPLY = `${PASSAGE}\n\n${FILLER}`;

/** A reply short enough that the whole turn stays on screen — what the note case needs. */
const SHORT_REPLY = "光合作用发生在叶绿体中，光反应阶段产生 ATP，暗反应固定二氧化碳。";

/** The phrase annotated in the note case. */
const PHRASE = "光反应阶段";

/**
 * Keep the topic classifier out of the scripted queue.
 *
 * It is a *streamed* side call — see `docs/widgets.md` — so an unmatched one consumes a turn the
 * conversation was going to be given, and the symptom is a reply the test is not about. One
 * canned decision answers every classifier request; nothing here asserts on threads.
 */
const CLASSIFIER = {
  includes: "topic-classification function",
  content: JSON.stringify({ decisions: [{ thread: "new", branch: "other", title: "参考" }] }),
};

/** The one question the quiz case asks, and the card the jump has to land on. */
const ONE_QUESTION = [
  {
    header: "算子",
    question: "哪一个是转换算子？",
    options: [{ label: "map" }, { label: "addSource" }],
  },
];

/** A workspace of this file's own, entered, and a conversation in it with the widgets asked for. */
async function session(page: Page, prefix: string, widgets: readonly string[]): Promise<void> {
  const name = unique(prefix);
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  for (const id of widgets) await page.getByTestId(`new-session-widget-check-${id}`).check();
  await page.getByTestId("create-session").click();
  await expect(page.getByTestId("composer-input")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  // Send replacing Stop is the app's own signal that the turn finished — see `notes.spec.ts` for
  // why waiting on the reply's text alone is not enough.
  await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 20_000 });
}

/** The last reply's rendered content — where a selection is made. */
function replyContent(page: Page) {
  return page.getByTestId("message-content").last();
}

/** The reference chips of the last user message, which is the one this turn sent. */
function lastChip(page: Page) {
  return page.getByTestId("message-ref").last();
}

test("a passage chip scrolls the conversation back to the words", async ({ page, request }) => {
  /*
   * The passage and not the message, which is the finer of the two claims available: a reply that
   * is taller than the pane is "in the viewport" from almost anywhere, so the assertion is on the
   * `<p>` that holds the quoted sentence — it is off screen at the end of the conversation and has
   * to be back on it after the press.
   */
  await scriptLlm(request, {
    title: "光合作用",
    matches: [CLASSIFIER],
    turns: [{ content: TALL_REPLY }, { content: "它是能量货币。" }],
  });
  await session(page, "RefPassage", []);

  await send(page, "讲讲光合作用");
  await selectAndAsk(page, replyContent(page), PASSAGE);
  await send(page, "它是什么？");

  const scroller = page.getByTestId("messages");
  const passage = page.getByTestId("message-content").first().getByText(PASSAGE);
  await expect(passage).not.toBeInViewport();
  const before = await scroller.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(200);

  await lastChip(page).click();

  await expect(passage).toBeInViewport();
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThan(before);
});

test("a diagram chip opens the file the tool wrote", async ({ page, request }) => {
  await scriptLlm(request, {
    title: "画图",
    matches: [CLASSIFIER],
    turns: [
      {
        content: "画好了：",
        toolCalls: [
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name: "auth-flow", source: "graph TD\n  A[开始] --> B[结束]", summary: "登录流程" },
          },
        ],
      },
      { content: "还需要补充吗？" },
      { content: "这一步是开始。" },
    ],
  });
  await session(page, "RefDiagram", ["diagram"]);
  await page.getByTestId("widget-tab-diagram").click();

  await send(page, "画个登录流程图");
  await expect(page.getByTestId("diagram-row").first()).toBeVisible();

  // Staged from the panel's own row, which is the gesture that puts a figure reference in a turn.
  await page.getByTestId("diagram-row-ask").first().click();
  await expect(page.getByTestId("composer-refs")).toContainText("auth-flow");
  await send(page, "这一步是什么意思？");

  /*
   * The chip names the diagram and not its content — the agent reads the drawing by name — and
   * pressing it opens the `.mmd` through the ordinary preview, which is where a diagram is shown
   * everywhere else. That it is the *session* root is what this checks: a workspace-rooted read
   * would come back "file not found" in the dialog's body.
   */
  await lastChip(page).click();
  await expect(page.getByTestId("file-preview")).toBeVisible();
  await expect(page.getByTestId("file-preview-diagram")).toBeVisible();
  await expect(page.getByTestId("file-preview-error")).toHaveCount(0);
});

test("a note chip reopens the note, and says so when there is none to open", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "光合作用",
    matches: [CLASSIFIER],
    turns: [{ content: SHORT_REPLY }, { content: "它是能量货币。" }],
  });
  // The notes panel holds the records, and it is installed by default.
  await session(page, "RefNote", []);
  await page.getByTestId("widget-tab-notes").click();

  await send(page, "讲讲光合作用");
  await annotate(page, replyContent(page), PHRASE);

  // The reference is made from the note's own window, which is the only place the panel offers it.
  await page.getByTestId("notes-list").locator("li").first().click();
  const editor = page.getByTestId("note-editor");
  await expect(editor).toBeVisible();
  await page.getByTestId("note-editor-ask").click();
  await expect(page.getByTestId("composer-refs")).toContainText("笔记");
  await send(page, "这条笔记说的对吗？");

  await expect(lastChip(page)).toContainText("笔记");
  await lastChip(page).click();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText(PHRASE);

  /*
   * Then the two ways this press can come to nothing, and they are the reason the arm reports at
   * all: the note can be deleted out from under the chip that names it, and the panel that holds
   * the records can be uninstalled from the conversation. A chip is a record of a gesture made in
   * an earlier tab, so unlike the panel's own row it cannot check either in advance — and a press
   * that did nothing reads as a broken app.
   */
  await page.getByTestId("note-editor-remove").click();
  await page.getByTestId("confirm-accept").click();
  await expect(editor).toBeHidden();

  await lastChip(page).click();
  await expect(page.getByTestId("toast")).toContainText("笔记已不在这个会话里");

  await page.getByTestId("open-session-settings").click();
  await page.getByTestId("session-widget-toggle-notes").click();
  await page.getByTestId("session-settings-save").click();
  await expect(page.getByTestId("widget-tab-notes")).toHaveCount(0);

  await lastChip(page).click();
  await expect(page.getByTestId("toast")).toContainText("没有安装笔记面板");
});

test("a quiz chip scrolls back to the card that asked the question", async ({ page, request }) => {
  /*
   * The **card**, not the panel's dialog: that is the shape a question has in this app — a live
   * one is answered there, and a settled one shows the question, the recorded answer and the
   * verdict — and it exists in every conversation rather than only where the quiz panel is
   * installed. The card has to be found by the *tool call* the question was drawn by, which is
   * nowhere in the reference: it stores the question's global id, the one `ila_review_quiz` takes.
   */
  await scriptLlm(request, {
    title: "窗口",
    matches: [CLASSIFIER],
    turns: [
      { toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: ONE_QUESTION } }] },
      { content: FILLER },
      { content: "map 是一对一转换，flatMap 是一对多。" },
    ],
  });
  await session(page, "RefQuiz", ["plan", "quiz"]);
  await page.getByTestId("widget-tab-quiz").click();
  await expect(page.getByTestId("quiz-empty")).toBeVisible();

  await send(page, "开始");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1, { timeout: 20_000 });

  // Walking away settles the question, which is what leaves a row with something to ask about.
  await send(page, "先讲别的吧");
  await page.getByTestId("quiz-filter").selectOption("skipped");
  await page.locator('[data-testid^="quiz-row-"]').click();
  await expect(page.getByTestId("quiz-detail-overlay")).toBeVisible();
  await page.getByTestId("quiz-followup-ask").click();
  await expect(page.getByTestId("composer-refs")).toContainText("题目");
  await send(page, "map 和 flatMap 有什么区别？");

  const card = page.locator('[data-tool-call-id="call_quiz"]');
  await expect(card).not.toBeInViewport();

  await lastChip(page).click();

  await expect(card).toBeInViewport();
});
