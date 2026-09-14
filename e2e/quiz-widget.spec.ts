import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The quiz widget over a real browser and a scripted model: questions are registered
 * against the current plan chapter, the resumed turn grades them with ila_review_quiz,
 * the panel lists/groups/filters them, a walked-away question is made up (same row,
 * graded once), and a follow-up goes through as a normal chat message.
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
  await page.getByTestId("quiz-followup-toggle").click();
  await page.getByTestId("quiz-followup-text").fill("map 和 flatMap 有什么区别？");
  await page.getByTestId("quiz-followup-send").click();

  // The dialog closed and the answer arrives in the chat, with the global id quoted.
  await expect(page.getByTestId("quiz-detail-overlay")).toHaveCount(0);
  await expect(page.locator('[data-testid="message-content"]').last()).toContainText(
    "flatMap 是一对多"
  );
  expect(quizId.length).toBeGreaterThan(8);
});
