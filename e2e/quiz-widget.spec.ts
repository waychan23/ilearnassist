import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The quiz widget over a real browser and a scripted model: questions are registered
 * against the current plan chapter, the resumed turn grades them with ila_review_quiz,
 * the panel lists/groups/filters them, a walked-away question is made up (same row,
 * graded once), and a follow-up is asked as a reference on an ordinary turn.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

const PLAN_TREE = [
  { title: "Chapter 1", children: [{ title: "1.1 Intro" }] },
  { title: "Chapter 2" },
];

const TWO_QUESTIONS = [
  {
    header: "窗口",
    question: "Flink 里按时间切分的窗口是哪一种？",
    options: [{ label: "滚动窗口" }, { label: "状态后端" }],
  },
  {
    header: "状态",
    question: "下面哪一个是状态后端？",
    options: [{ label: "RocksDB" }, { label: "Kafka" }],
  },
];

const ONE_QUESTION = [
  {
    header: "算子",
    question: "哪一个是转换算子？",
    options: [{ label: "map" }, { label: "addSource" }],
  },
];

/**
 * The make-up question carries BOTH kinds of text that must not show before it is
 * answered: option descriptions (the per-choice reasoning) and the model's answer key /
 * explanation (never sent to the client at all). The marker strings make a leak fail the
 * test even if it moved containers.
 */
const MAKEUP_QUESTION = [
  {
    header: "算子",
    question: "哪一个是转换算子？",
    options: [
      { label: "map", description: "DESC-MARKER-42 map 是一进一出的转换算子。" },
      { label: "addSource", description: "addSource 负责接入数据源。" },
    ],
    referenceAnswer: ["map"],
    explanation: "KEY-MARKER-84 答案解析只在判分时给模型，绝不能显示给用户。",
  },
];

async function sessionWithWidgets(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-plan").check();
  await page.getByTestId("new-session-widget-check-quiz").check();
  await page.getByTestId("create-session").click();

  await page.getByTestId("widget-tab-quiz").click();
  await expect(page.getByTestId("quiz-empty")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

/** Global quiz ids the panel rendered, in list order. */
async function panelIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="quiz-row-"]')
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid")!.replace("quiz-row-", ""))
    );
}

async function selectFilter(page: Page, value: string): Promise<void> {
  await page.getByTestId("quiz-filter").selectOption(value);
}

test("quizzes the user, grades into the panel, and groups by chapter", async ({
  page,
  request,
}) => {
  await sessionWithWidgets(page, unique("Quiz widget"));

  // A plan, then the intro chapter in progress: the quiz binds to that chapter.
  await scriptLlm(request as APIRequestContext, {
    title: "Flink plan",
    turns: [
      { toolCalls: [{ id: "call_plan", name: "ila_make_plan", args: { tree: PLAN_TREE } }] },
      { content: "计划建好了。" },
    ],
  });
  await send(page, "制定学习计划");
  await page.getByTestId("widget-tab-plan").click();
  await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(3);

  const introId = await page
    .locator('[data-testid^="plan-node-"]')
    .evaluateAll((els) => {
      const titles = els.map((el) => el.textContent ?? "");
      const found = els.find((_, i) => titles[i]!.includes("1.1 Intro"));
      return found?.getAttribute("data-testid")!.replace("plan-node-", "") ?? "";
    });

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        toolCalls: [
          {
            id: "call_progress",
            name: "ila_update_plan_progress",
            args: { nodes: [{ id: introId, status: "in_progress" }] },
          },
        ],
      },
      { content: "我们开始。" },
    ],
  });
  await send(page, "开始第一章");

  // The quiz suspends and registers its two questions.
  await page.getByTestId("widget-tab-quiz").click();
  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "先测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: TWO_QUESTIONS } }],
      },
    ],
  });
  await send(page, "测测我");
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");

  // The panel lists both pending questions (pending rows jump to the card on click, but
  // they are visible).
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);
  let ids = await panelIds(page);
  expect(ids).toHaveLength(2);

  // Tree view: both leaves sit under the in-progress chapter, inside 学习测验.
  await page.getByTestId("quiz-view-tree").click();
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);
  const chapterGroup = page.locator(`[data-testid="quiz-node-${introId}"]`);
  await expect(chapterGroup).toBeVisible();

  // Back to list; answer the card (Q1 right, Q2 wrong). The resumed turn grades by the
  // exact global ids, so script it after reading the panel's ids.
  await page.getByTestId("quiz-view-list").click();
  ids = await panelIds(page);
  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        toolCalls: [
          {
            id: "call_grade",
            name: "ila_review_quiz",
            args: {
              reviews: [
                { quizId: ids[0], verdict: "correct", explanation: "答对了。" },
                { quizId: ids[1], verdict: "incorrect", explanation: "应选 RocksDB。" },
              ],
            },
          },
        ],
      },
      { content: "第一题对，第二题错。" },
    ],
  });
  await page.locator('[data-testid="quiz-option-0-0"]').click();
  await page.getByTestId("quiz-next").click();
  await page.locator('[data-testid="quiz-option-1-0"]').click();
  await page.getByTestId("quiz-submit").click();
  // The grading tool call lands mid-turn.
  await expect(page.locator('[data-tool-call-id="call_grade"]')).toBeVisible();

  // Wrong-only filter shows exactly the second question.
  await selectFilter(page, "wrong");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
  expect(await panelIds(page)).toEqual([ids[1]]);

  // The detail dialog shows the verdict and explanation.
  await page.locator('[data-testid^="quiz-row-"]').first().click();
  await expect(page.getByTestId("quiz-detail-overlay")).toBeVisible();
  await expect(page.getByTestId(`quiz-detail-verdict-${ids[1]}`)).toContainText("错误");
  await expect(page.locator(".quiz-detail .feedback")).toContainText("应选 RocksDB");
  await page.getByTestId("quiz-detail-close").click();
});

test("a walked-away question is made up once and then graded", async ({ page, request }) => {
  await sessionWithWidgets(page, unique("Quiz makeup"));

  // The quiz suspends with one question (whose descriptions and answer key are secret
  // until it has been answered).
  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "小测一下。",
        toolCalls: [
          { id: "call_quiz", name: "ila_quiz", args: { questions: MAKEUP_QUESTION } },
        ],
      },
    ],
  });
  await send(page, "开始");
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
  // Neither the card nor the page reveals the descriptions or the answer key.
  await expect(page.locator("body")).not.toContainText("DESC-MARKER-42");
  await expect(page.locator("body")).not.toContainText("KEY-MARKER-84");
  const quizId = (await panelIds(page))[0]!;

  // Walking away skips it.
  await scriptLlm(request as APIRequestContext, { turns: [{ content: "先讲别的。" }] });
  await send(page, "先讲别的吧");
  await expect(page.getByTestId("quiz-status")).toContainText("已跳过");

  // The settled card's option disclosure still hides the descriptions: the question was
  // never answered and remains make-up eligible.
  await page.getByTestId("quiz-disclosure").click();
  await expect(page.getByTestId("quiz-details")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("DESC-MARKER-42");

  await selectFilter(page, "skipped");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);

  // Open it and make up. The detail shows the make-up form, not a read-back that leaks the
  // option descriptions — and the answer key is nowhere either.
  await page.locator('[data-testid^="quiz-row-"]').click();
  await expect(page.getByTestId("quiz-makeup")).toBeVisible();
  await expect(page.locator(".quiz-detail .offered")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("DESC-MARKER-42");
  await expect(page.locator("body")).not.toContainText("KEY-MARKER-84");
  await page.locator('[data-testid="quiz-makeup-option-0-0"]').click();

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        toolCalls: [
          {
            id: "call_grade_late",
            name: "ila_review_quiz",
            args: {
              reviews: [{ quizId, verdict: "correct", explanation: "补答正确。" }],
            },
          },
        ],
      },
      { content: "这次对了。" },
    ],
  });
  await page.getByTestId("quiz-makeup-submit").click();
  // The dialog closes as soon as the make-up is sent, without waiting for the reply.
  await expect(page.getByTestId("quiz-detail-overlay")).toHaveCount(0);
  await expect(page.locator('[data-tool-call-id="call_grade_late"]')).toBeVisible();

  // Exactly one row for the question, now graded.
  await expect(page.getByTestId("quiz-detail-overlay")).toHaveCount(0);
  await selectFilter(page, "all");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
  await page.locator('[data-testid^="quiz-row-"]').click();
  await expect(page.getByTestId(`quiz-detail-verdict-${quizId}`)).toContainText("正确");
  // Answered now: the per-option description is a legitimate read-back, but the model's
  // answer key still never reaches the client.
  await expect(page.locator(".quiz-detail")).toContainText("DESC-MARKER-42");
  await expect(page.locator("body")).not.toContainText("KEY-MARKER-84");
  await page.getByTestId("quiz-detail-close").click();
});

test("a question cancelled with its quiz is make-up eligible, just like a skipped one", async ({
  page,
  request,
}) => {
  await sessionWithWidgets(page, unique("Quiz cancel makeup"));

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "小测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: ONE_QUESTION } }],
      },
      { content: "好，那我自己讲。" },
    ],
  });
  await send(page, "开始");
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");
  const quizId = (await panelIds(page))[0]!;

  // Explicit cancel on the card dismisses the call and its rows.
  await page.getByTestId("quiz-dismiss").click();
  await expect(page.getByTestId("quiz-status")).toContainText("已取消");

  // The panel groups it under the skipped filter (cancelled = unanswered).
  await selectFilter(page, "skipped");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);

  await page.locator('[data-testid^="quiz-row-"]').click();
  // The detail dialog offers the make-up form for a dismissed question.
  await expect(page.getByTestId("quiz-makeup")).toBeVisible();
  await page.locator('[data-testid="quiz-makeup-option-0-0"]').click();

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        toolCalls: [
          {
            id: "call_grade_cancel",
            name: "ila_review_quiz",
            args: {
              reviews: [{ quizId, verdict: "correct", explanation: "补答正确。" }],
            },
          },
        ],
      },
      { content: "这次对了。" },
    ],
  });
  await page.getByTestId("quiz-makeup-submit").click();
  await expect(page.getByTestId("quiz-detail-overlay")).toHaveCount(0);
  await expect(page.locator('[data-tool-call-id="call_grade_cancel"]')).toBeVisible();
  await selectFilter(page, "all");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
});

test("the follow-up box sends a normal chat message quoting the question", async ({
  page,
  request,
}) => {
  await sessionWithWidgets(page, unique("Quiz followup"));

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "小测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: ONE_QUESTION } }],
      },
    ],
  });
  await send(page, "开始");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
  const quizId = (await panelIds(page))[0]!;

  await scriptLlm(request as APIRequestContext, { turns: [{ content: "先讲别的。" }] });
  await send(page, "先讲别的吧");

  await selectFilter(page, "skipped");
  await page.locator('[data-testid^="quiz-row-"]').click();

  await scriptLlm(request as APIRequestContext, {
    turns: [{ content: "map 是一对一转换，flatMap 是一对多。" }],
  });
  /*
   * The gesture every other object uses now: 追问 stages a chip and closes, and the question is
   * typed in the composer. What this replaced was a text box inside the dialog whose submission
   * composed a sentence naming the question — so what is asserted is the part that changed: the
   * chip carries the question, and the prompt carries its *global* id rather than its `Qn`.
   */
  await page.getByTestId("quiz-followup-ask").click();

  await expect(page.getByTestId("quiz-detail-overlay")).toHaveCount(0);
  await expect(page.getByTestId("composer-refs")).toContainText("题目");
  await expect(page.getByTestId("composer-refs")).toContainText(ONE_QUESTION[0]!.question);

  await page.getByTestId("composer-input").fill("map 和 flatMap 有什么区别？");
  await page.getByTestId("composer-send").click();
  await expect(page.locator('[data-testid="message-content"]').last()).toContainText(
    "flatMap 是一对多"
  );

  // The bubble names the question it was about, above the answer's question.
  await expect(page.getByTestId("message-refs")).toContainText(ONE_QUESTION[0]!.question);

  // And what the model read: the question's own words, and the id `ila_review_quiz` takes —
  // never the `Qn`, which is scoped to this conversation and would resolve to nothing.
  const sent = JSON.stringify(
    (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as unknown[]
  );
  expect(sent).toContain(quizId);
  expect(sent).toContain("do not pose a new quiz");
  expect(quizId.length).toBeGreaterThan(8);
});

test("folding a chapter keeps the tree, and only the tree", async ({ page, request }) => {
  // The regression: the empty state used to key off *rendered* question rows, so folding the
  // folder that held every match read as "there are no questions" — the tree was replaced by
  // "还没有测验题" and the folder the user had just folded vanished with it.
  await sessionWithWidgets(page, unique("Quiz fold"));

  await scriptLlm(request as APIRequestContext, {
    title: "折叠加章",
    turns: [
      { toolCalls: [{ id: "call_plan", name: "ila_make_plan", args: { tree: PLAN_TREE } }] },
      { content: "计划建好了。" },
    ],
  });
  await send(page, "制定学习计划");
  await page.getByTestId("widget-tab-plan").click();
  await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(3);

  /** A plan node's id by the title its row shows. */
  const planNodeId = async (title: string): Promise<string> =>
    page.locator('[data-testid^="plan-node-"]').evaluateAll((els, wanted) => {
      const found = els.find((el) => (el.textContent ?? "").includes(wanted as string));
      return found?.getAttribute("data-testid")!.replace("plan-node-", "") ?? "";
    }, title);

  const chapterId = await planNodeId("Chapter 1");
  const introId = await planNodeId("1.1 Intro");
  expect(chapterId).not.toBe("");
  expect(introId).not.toBe("");

  // The intro chapter is what the quiz binds to, so both questions hang off the chapter that
  // is about to be folded — the case the bug needed, where collapsing hides every match.
  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        toolCalls: [
          {
            id: "call_progress",
            name: "ila_update_plan_progress",
            args: { nodes: [{ id: introId, status: "in_progress" }] },
          },
        ],
      },
      { content: "我们开始。" },
    ],
  });
  await send(page, "开始第一章");

  await page.getByTestId("widget-tab-quiz").click();
  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "先测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: TWO_QUESTIONS } }],
      },
    ],
  });
  await send(page, "测测我");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);

  await page.getByTestId("quiz-view-tree").click();
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);

  // Fold the top-level chapter that holds them both. Everything under it goes, but the tree
  // stays: the folder is still on screen, with the count that says what is inside it.
  const chapterGroup = page.locator(`[data-testid="quiz-node-${chapterId}"]`);
  await chapterGroup.click();

  await expect(chapterGroup).toBeVisible();
  await expect(page.locator(`[data-testid="quiz-node-${introId}"]`)).toHaveCount(0);
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(0);
  await expect(page.getByTestId("quiz-tree")).toBeVisible();
  await expect(page.getByTestId("quiz-empty")).toHaveCount(0);
  await expect(chapterGroup.locator(".node-count")).toHaveText("2");

  // Unfolding brings them back — the toggle is still a toggle.
  await chapterGroup.click();
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);
  await expect(page.locator(`[data-testid="quiz-node-${introId}"]`)).toBeVisible();

  // Folding the *leaf* behaves the same way, which is the same bug one level down.
  await page.locator(`[data-testid="quiz-node-${introId}"]`).click();
  await expect(page.locator(`[data-testid="quiz-node-${introId}"]`)).toBeVisible();
  await expect(page.getByTestId("quiz-tree")).toBeVisible();
  await expect(page.getByTestId("quiz-empty")).toHaveCount(0);
});

/**
 * The detail dialog's pager.
 *
 * Only a browser can hold this one: the dialog is a component, so Vitest does not see it (the
 * coverage config excludes `*.vue`), and the arithmetic that decides what the pager offers is
 * worth pinning at the two ends — answered questions and unanswered ones behave differently.
 */
test("the detail dialog pages through the questions the panel is showing", async ({
  page,
  request,
}) => {
  await sessionWithWidgets(page, unique("Quiz pager"));

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "先测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: TWO_QUESTIONS } }],
      },
    ],
  });
  await send(page, "测测我");
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");

  // Answer both, so neither is make-up eligible and the unanswered jump has nothing to offer.
  const ids = await panelIds(page);
  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        toolCalls: [
          {
            id: "call_grade",
            name: "ila_review_quiz",
            args: {
              reviews: [
                { quizId: ids[0], verdict: "correct", explanation: "答对了。" },
                { quizId: ids[1], verdict: "correct", explanation: "也对了。" },
              ],
            },
          },
        ],
      },
      { content: "两题都对。" },
    ],
  });
  await page.locator('[data-testid="quiz-option-0-0"]').click();
  await page.getByTestId("quiz-next").click();
  await page.locator('[data-testid="quiz-option-1-0"]').click();
  await page.getByTestId("quiz-submit").click();
  await expect(page.locator('[data-tool-call-id="call_grade"]')).toBeVisible();

  await page.getByTestId("widget-tab-quiz").click();
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);

  await page.locator('[data-testid^="quiz-row-"]').first().click();
  await expect(page.getByTestId("quiz-nav")).toBeVisible();
  await expect(page.getByTestId("quiz-nav-count")).toHaveText("第 1 / 2 题");
  // The first question has nowhere to go back to, and the count says so rather than the control
  // being absent — a pager with a missing arrow is one you cannot tell the position of.
  await expect(page.getByTestId("quiz-nav-prev")).toBeDisabled();
  await expect(page.getByTestId("quiz-nav-next")).toBeEnabled();
  // Both were answered, so there is nothing to skip to: the button is not rendered at all.
  await expect(page.getByTestId("quiz-nav-unanswered")).toHaveCount(0);

  await page.getByTestId("quiz-nav-next").click();
  await expect(page.getByTestId("quiz-nav-count")).toHaveText("第 2 / 2 题");
  await expect(page.getByTestId("quiz-nav-next")).toBeDisabled();
  await expect(page.getByTestId("quiz-nav-prev")).toBeEnabled();

  // …and back, so the pair is a pair rather than one-way.
  await page.getByTestId("quiz-nav-prev").click();
  await expect(page.getByTestId("quiz-nav-count")).toHaveText("第 1 / 2 题");
});

test("the pager walks the filter the panel is set to, and skips to the next unanswered", async ({
  page,
  request,
}) => {
  await sessionWithWidgets(page, unique("Quiz pager filter"));

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "先测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: TWO_QUESTIONS } }],
      },
    ],
  });
  await send(page, "测测我");
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");

  // Walk away, so both are unanswered and both remain make-up eligible.
  await scriptLlm(request as APIRequestContext, { turns: [{ content: "先讲别的。" }] });
  await send(page, "先讲别的吧");
  await expect(page.getByTestId("quiz-status")).toContainText("已跳过");

  await page.getByTestId("widget-tab-quiz").click();
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);
  await page.locator('[data-testid^="quiz-row-"]').first().click();
  await expect(page.getByTestId("quiz-nav-count")).toHaveText("第 1 / 2 题");
  // There is a question ahead with no answer, so the jump is offered.
  await expect(page.getByTestId("quiz-nav-unanswered")).toBeVisible();

  await page.getByTestId("quiz-nav-unanswered").click();
  await expect(page.getByTestId("quiz-nav-count")).toHaveText("第 2 / 2 题");
  // Nothing unanswered is *ahead* of the last one, so the jump goes away rather than wrapping
  // round to the top — a button that silently returns you to the beginning is a different action
  // wearing the same label.
  await expect(page.getByTestId("quiz-nav-unanswered")).toHaveCount(0);

  await page.getByTestId("quiz-detail-close").click();

  // Now narrow the list: the pager counts the filtered list, not the conversation.
  await selectFilter(page, "skipped");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);
  await page.locator('[data-testid^="quiz-row-"]').last().click();
  await expect(page.getByTestId("quiz-nav-count")).toHaveText("第 2 / 2 题");
});

test("a list of one question has no pager", async ({ page, request }) => {
  await sessionWithWidgets(page, unique("Quiz pager single"));

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "先测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: ONE_QUESTION } }],
      },
    ],
  });
  await send(page, "测测我");
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");

  await scriptLlm(request as APIRequestContext, { turns: [{ content: "先讲别的。" }] });
  await send(page, "先讲别的吧");
  await expect(page.getByTestId("quiz-status")).toContainText("已跳过");

  await page.getByTestId("widget-tab-quiz").click();
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
  await page.locator('[data-testid^="quiz-row-"]').click();
  await expect(page.getByTestId("quiz-detail-overlay")).toBeVisible();
  // One question in the list, so a pager over it would be three controls that cannot act.
  await expect(page.getByTestId("quiz-nav")).toHaveCount(0);
});

test("补答模式 walks the unanswered questions and submits a part of them", async ({
  page,
  request,
}) => {
  /*
   * The requirement's own scenario, end to end: 补答 on one question asks whether to take the rest
   * with it, the mode then contains *only* unanswered questions — 上一题/下一题 walk that set, not
   * the panel's filter — and a submit that leaves questions behind says how many and keeps them
   * unanswered rather than grading a blank.
   */
  await sessionWithWidgets(page, unique("Quiz batch makeup"));

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "小测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: TWO_QUESTIONS } }],
      },
    ],
  });
  await send(page, "开始");
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");

  // Walk away from the whole set: both questions become unanswered.
  await scriptLlm(request as APIRequestContext, { turns: [{ content: "先讲别的。" }] });
  await send(page, "先讲别的吧");
  await expect(page.getByTestId("quiz-status")).toContainText("已跳过");

  // One of them is answered properly, so the mode has something to exclude.
  await scriptLlm(request as APIRequestContext, { turns: [{ content: "好。" }] });
  await send(page, "算了，随便聊聊");
  await selectFilter(page, "skipped");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);

  /*
   * Open the first one and press 补答: with a second unanswered question in the conversation, the
   * press asks rather than grading straight away.
   */
  await page.locator('[data-testid^="quiz-row-"]').first().click();
  await expect(page.getByTestId("quiz-makeup")).toBeVisible();
  await page.locator('[data-testid="quiz-makeup-option-0-0"]').click();
  await page.getByTestId("quiz-makeup-submit").click();
  // The prompt names the count, so the reader knows what they are agreeing to.
  await expect(page.locator(".confirm-message")).toContainText("还有 1 道未作答的题目");
  await page.getByTestId("confirm-accept").click();

  // The mode: the pager walks the unanswered queue, and the counter says where we are.
  await expect(page.getByTestId("quiz-makeup-step")).toHaveText("第 1/2 道未答题");
  await expect(page.getByTestId("quiz-makeup-filled")).toHaveText("已补答 1 道");
  // The answer already typed came with it: the press that opened the mode did not throw it away.
  await expect(page.locator('[data-testid="quiz-makeup-option-0-0"] input')).toBeChecked();

  // Submit with the second question untouched: it asks first, and says how many are left.
  await page.getByTestId("quiz-makeup-submit-all").click();
  await expect(page.locator(".confirm-message")).toContainText("还有 1 道题没有补答");
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("quiz-detail-overlay")).toHaveCount(0);

  // One question is answered and awaiting a grade; the other is exactly where it was.
  await selectFilter(page, "all");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(2);
  await selectFilter(page, "skipped");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
  await selectFilter(page, "answered");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);

  /*
   * And the record is in the conversation as a make-up card: the answers left as a tool call, which
   * is what the model grades from — no user message was composed for it.
   */
  await expect(page.getByTestId("quiz-card").last()).toContainText("补答");
});

test("a question whose grading failed can be re-opened and answered again", async ({
  page,
  request,
}) => {
  /*
   * The repair for a stuck row. The answers are written *before* the grading turn runs, so a
   * provider failure leaves a question that is answered with no verdict — a state a make-up
   * refuses and the card that asked it is gone from. Nothing else can touch it, so without the
   * reopen control the learner's question reads "waiting for the assistant to grade it" for good.
   */
  await sessionWithWidgets(page, unique("Quiz reopen"));

  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        content: "小测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: ONE_QUESTION } }],
      },
      { content: "先讲别的。" },
    ],
  });
  await send(page, "开始");
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");
  await send(page, "先讲别的吧");
  await expect(page.getByTestId("quiz-status")).toContainText("已跳过");

  // Make it up — with the grading turn failing, which is the state under test.
  await selectFilter(page, "skipped");
  await page.locator('[data-testid^="quiz-row-"]').click();
  await page.locator('[data-testid="quiz-makeup-option-0-0"]').click();
  await scriptLlm(request as APIRequestContext, {
    turns: [{ fail: { status: 500, message: "provider exploded" } }],
  });
  await page.getByTestId("quiz-makeup-submit").click();
  await expect(page.getByTestId("quiz-detail-overlay")).toHaveCount(0);

  // Answered, never graded: the panel says so, and the way out is offered. The id is read here,
  // while the row is still in the filter on screen — the reopen takes it out of that list.
  await selectFilter(page, "answered");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
  const quizId = (await panelIds(page))[0]!;
  await page.locator('[data-testid^="quiz-row-"]').click();
  await expect(page.locator(".feedback.waiting")).toBeVisible();
  await expect(page.getByTestId("quiz-reopen")).toBeVisible();

  // The confirm says what it costs, and confirming takes the question back to unanswered.
  await page.getByTestId("quiz-reopen").click();
  await expect(page.locator(".confirm-message")).toContainText("判分没有完成");
  await page.getByTestId("confirm-accept").click();
  // The dialog is already open on it, now showing the make-up form — which is the point of the
  // repair: the question is answerable the way it was the first time.
  await expect(page.getByTestId("quiz-makeup")).toBeVisible();

  // And a second attempt grades it — the same row, now judged.
  await page.locator('[data-testid="quiz-makeup-option-0-0"]').click();
  await scriptLlm(request as APIRequestContext, {
    turns: [
      {
        toolCalls: [
          {
            id: "call_grade_retry",
            name: "ila_review_quiz",
            args: { reviews: [{ quizId, verdict: "correct", explanation: "这次对了。" }] },
          },
        ],
      },
      { content: "这次判好了。" },
    ],
  });
  await page.getByTestId("quiz-makeup-submit").click();
  await expect(page.locator('[data-tool-call-id="call_grade_retry"]')).toBeVisible();

  await selectFilter(page, "all");
  await expect(page.locator('[data-testid^="quiz-row-"]')).toHaveCount(1);
  await page.locator('[data-testid^="quiz-row-"]').click();
  await expect(page.getByTestId(`quiz-detail-verdict-${quizId}`)).toContainText("正确");
  await page.getByTestId("quiz-detail-close").click();
});
