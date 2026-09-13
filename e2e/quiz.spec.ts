import { expect, test, type Page } from "@playwright/test";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The `quiz` card, in a browser.
 *
 * Like `ask_user`, a quiz spans two HTTP requests — the tool suspends, the route persists a
 * pending call, the card renders it, the answer comes back on a second request and the turn
 * finishes. What only a real browser can prove is what `quiz` adds on top: the ids the tool
 * assigned are what the card shows and submits, the option letters come from the position,
 * the "unsure" state is genuinely exclusive with a choice in both directions, and the notes
 * survive a reload along with everything else.
 */

const QUESTIONS = [
  {
    header: "窗口",
    question: "Flink 里按时间切分的窗口是哪一种？",
    options: [{ label: "滚动窗口" }, { label: "状态后端" }],
  },
  {
    header: "状态",
    question: "下面哪些属于状态后端？",
    multiSelect: true,
    options: [{ label: "RocksDB" }, { label: "HashMap" }],
  },
  {
    header: "算子",
    question: "哪一个算子是转换算子？",
    options: [{ label: "map" }, { label: "addSource" }],
  },
];

/** The option's radio/checkbox. */
const choice = (page: Page, question: number, option: number) =>
  page.getByTestId(`quiz-option-${question}-${option}`).locator("input");

/** The "unsure" checkbox, which belongs to no option group. */
const unsureOf = (page: Page, question: number) =>
  page.getByTestId(`quiz-unsure-${question}`).locator("input");

/**
 * A workspace of this spec's own, entered.
 *
 * The default workspace is shared with `chat.spec.ts`, which asserts on how many
 * conversations it holds — so a spec that has a conversation in it has to bring its own.
 */
async function createAndEnter(page: Page, name: string): Promise<void> {
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  // ila_quiz is widget-bound now: open the conversation with the quiz widget installed.
  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-quiz").check();
  await page.getByTestId("create-session").click();
}

/** Enter a fresh workspace and ask for the quiz. */
async function startQuiz(page: Page): Promise<string> {
  const workspace = `小测 ${Date.now()}`;
  await page.goto("/");
  await createAndEnter(page, workspace);
  await page.getByTestId("composer-input").fill("我想学 Flink");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");
  return workspace;
}

test("answers a three-question quiz through the tabs, and the record survives a reload", async ({
  page,
  request,
}) => {
  const workspace = `小测 ${Date.now()}`;
  await scriptLlm(request, {
    title: "Flink 入门",
    turns: [
      {
        content: "先测一下你的印象。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: QUESTIONS } }],
      },
      { content: "好，那我们从窗口讲起。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, workspace);
  await page.getByTestId("composer-input").fill("我想学 Flink");
  await page.getByTestId("composer-send").click();

  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");

  // The card sits *below* the sentence introducing it, not above it.
  const textBox = (await page.getByTestId("message-content").last().boundingBox())!;
  const cardBox = (await page.getByTestId("quiz-card").boundingBox())!;
  expect(cardBox.y).toBeGreaterThan(textBox.y);

  // The tool's own ids, on the strip and on the question — an id that were derived from a
  // position would still read Q1 here, so the counter is what a later screen has to show.
  await expect(page.getByTestId("quiz-tab-0")).toContainText("Q1");
  await expect(page.getByTestId("quiz-id-0")).toHaveText("Q1");
  await expect(page.getByTestId("quiz-question")).toHaveText("Flink 里按时间切分的窗口是哪一种？");
  await expect(page.getByTestId("quiz-step")).toHaveText("第 1 / 3 题");

  // The options are lettered by the client, from the order the model listed them, because
  // the model is told not to write letters of its own.
  await expect(page.getByTestId("quiz-option-0-0")).toContainText("A");
  await expect(page.getByTestId("quiz-option-0-1")).toContainText("B");

  // Submit is only offered on the last question, and only once every one is answered.
  await expect(page.getByTestId("quiz-submit")).toHaveCount(0);

  // Picking a single-select option must NOT advance, unlike `ask_user`: the question just
  // answered is the one the user may want to qualify, and the boxes for that are right here.
  await choice(page, 0, 0).click();
  await expect(page.getByTestId("quiz-question")).toHaveText("Flink 里按时间切分的窗口是哪一种？");
  await expect(choice(page, 0, 0)).toBeChecked();

  // The escape hatch: saying "I don't know, and here is why" is an answer, and it releases
  // the choice it cannot coexist with.
  await unsureOf(page, 0).click();
  await expect(choice(page, 0, 0)).not.toBeChecked();
  await page.getByTestId("quiz-unsure-reason-0").fill("没见过这个词");

  await page.getByTestId("quiz-next").click();
  await expect(page.getByTestId("quiz-question")).toHaveText("下面哪些属于状态后端？");
  await expect(page.getByTestId("quiz-id-1")).toHaveText("Q2");
  await expect(page.getByTestId("quiz-step")).toHaveText("第 2 / 3 题");
  // A multi-select question names itself as one.
  await expect(page.getByTestId("quiz-card")).toContainText("可多选");

  // Multi-select takes several and does not advance on its own either.
  await choice(page, 1, 0).click();
  await choice(page, 1, 1).click();
  await expect(page.getByTestId("quiz-question")).toHaveText("下面哪些属于状态后端？");
  await page.getByTestId("quiz-notes-1").fill("靠印象选的，不太确定");

  // Navigating away and back keeps everything that was written.
  await page.getByTestId("quiz-previous").click();
  await expect(page.getByTestId("quiz-unsure-0").locator("input")).toBeChecked();
  await expect(page.getByTestId("quiz-unsure-reason-0")).toHaveValue("没见过这个词");
  await page.getByTestId("quiz-next").click();
  await expect(page.getByTestId("quiz-notes-1")).toHaveValue("靠印象选的，不太确定");

  await page.getByTestId("quiz-next").click();
  await expect(page.getByTestId("quiz-submit")).toBeDisabled();

  await choice(page, 2, 1).click();
  await expect(page.getByTestId("quiz-submit")).toBeEnabled();
  await page.getByTestId("quiz-submit").click();

  // The turn resumes with a new reply from the answers just given.
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "好，那我们从窗口讲起。"
  );

  // And the card becomes a record: the ids, the answers, the reason and the notes, all
  // visible without expanding anything.
  await expect(page.getByTestId("quiz-status")).toHaveText("已提交");
  await expect(page.getByTestId("quiz-answer-id-0")).toHaveText("Q1");
  await expect(page.getByTestId("quiz-answer-0")).toContainText("不确定");
  await expect(page.getByTestId("quiz-answer-0")).toContainText("没见过这个词");
  await expect(page.getByTestId("quiz-answer-1")).toContainText("RocksDB、HashMap");
  await expect(page.getByTestId("quiz-answer-notes-1")).toContainText("靠印象选的，不太确定");
  await expect(page.getByTestId("quiz-answer-2")).toContainText("addSource");
  await expect(page.getByTestId("quiz-tab-0")).toHaveCount(0);

  // The options that were offered sit behind the disclosure, ticked where they were picked,
  // so the record shows the choice against what was on offer.
  await expect(page.getByTestId("quiz-details")).toHaveCount(0);
  await page.getByTestId("quiz-disclosure").click();

  const details = page.getByTestId("quiz-details");
  await expect(details.getByTestId("quiz-detail-option-1-0")).toHaveAttribute("data-chosen", "true");
  await expect(details.getByTestId("quiz-detail-option-1-1")).toHaveAttribute("data-chosen", "true");
  await expect(details.getByTestId("quiz-detail-option-2-1")).toHaveAttribute("data-chosen", "true");
  await expect(details.getByTestId("quiz-detail-option-0-0")).toHaveAttribute("data-chosen", "false");
  // An unsure answer appears with the options, not only in the summary.
  await expect(details.getByTestId("quiz-detail-unsure-0")).toContainText("没见过这个词");

  // --- reload: the whole exchange must come back from the database ---
  await page.reload();

  // Neither the workspace nor the session is remembered across a reload, so walk back in.
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();

  await expect(page.getByTestId("quiz-status")).toHaveText("已提交");
  await expect(page.getByTestId("quiz-answer-id-0")).toHaveText("Q1");
  await expect(page.getByTestId("quiz-answer-1")).toContainText("RocksDB、HashMap");
  await expect(page.getByTestId("quiz-answer-notes-1")).toContainText("靠印象选的，不太确定");
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "好，那我们从窗口讲起。"
  );
});

test("the multi-line boxes start one row tall and grow with their content", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "Flink 入门",
    turns: [
      {
        content: "一个问题。",
        toolCalls: [
          { id: "call_quiz", name: "ila_quiz", args: { questions: QUESTIONS.slice(0, 1) } },
        ],
      },
      { content: "好。" },
    ],
  });

  await startQuiz(page);

  const notes = page.getByTestId("quiz-notes-0");
  // One row to begin with, rather than the global `.textarea`'s 96px floor.
  await expect(notes).toHaveAttribute("rows", "1");
  const oneRow = (await notes.boundingBox())!.height;

  // Two lines needs more room than one, and four needs more than two — which is what
  // "grows with its content" means, stated without depending on a line height.
  await notes.fill("一\n二");
  const twoLines = (await notes.boundingBox())!.height;
  await notes.fill("一\n二\n三\n四");
  const fourLines = (await notes.boundingBox())!.height;

  expect(twoLines).toBeGreaterThan(oneRow);
  expect(fourLines).toBeGreaterThan(twoLines);

  // And back down again. A box that only ever grew would leave a four-line gap behind the
  // text it was sized for, which is the half a bare `scrollHeight` read cannot do.
  await notes.fill("");
  expect(Math.round((await notes.boundingBox())!.height)).toBe(Math.round(oneRow));

  // The unsure box is the other call site, and starts at the same one-row height — a missed
  // `rows="1"` there would show up here rather than only under a long reason.
  await unsureOf(page, 0).click();
  const reason = page.getByTestId("quiz-unsure-reason-0");
  await expect(reason).toHaveAttribute("rows", "1");
  const reasonOneRow = (await reason.boundingBox())!.height;
  expect(Math.round(reasonOneRow)).toBe(Math.round(oneRow));

  await reason.fill("一\n二\n三\n四");
  expect((await reason.boundingBox())!.height).toBeGreaterThan(reasonOneRow);
});

test("unsure and a choice exclude each other in both directions", async ({ page, request }) => {
  await scriptLlm(request, {
    title: "Flink 入门",
    turns: [
      {
        content: "一个问题。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: QUESTIONS.slice(0, 1) } }],
      },
      { content: "好。" },
    ],
  });

  await startQuiz(page);

  // Unsure first, then a choice: the choice wins and unsure is released.
  await unsureOf(page, 0).click();
  await expect(page.getByTestId("quiz-unsure-reason-0")).toBeVisible();
  await choice(page, 0, 1).click();

  await expect(unsureOf(page, 0)).not.toBeChecked();
  await expect(page.getByTestId("quiz-unsure-reason-0")).toHaveCount(0);
  await expect(choice(page, 0, 1)).toBeChecked();

  // And back: unsure clears the choice it cannot coexist with.
  await unsureOf(page, 0).click();
  await expect(choice(page, 0, 1)).not.toBeChecked();
  await expect(unsureOf(page, 0)).toBeChecked();
});

test("a quiz the user walks away from is retired, not left waiting", async ({ page, request }) => {
  await scriptLlm(request, {
    title: "Flink 入门",
    turns: [
      {
        content: "先测一下。",
        toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: QUESTIONS.slice(0, 1) } }],
      },
      { content: "好，那我先讲别的。" },
    ],
  });

  await startQuiz(page);

  // The user ignores the quiz and says something else. The card stops being answerable
  // rather than sitting live on a conversation that has moved on.
  await page.getByTestId("composer-input").fill("算了，先讲别的");
  await page.getByTestId("composer-send").click();

  await expect(page.getByTestId("message-assistant").last()).toContainText("好，那我先讲别的。");
  await expect(page.getByTestId("quiz-status")).toHaveText("已跳过");
  await expect(page.getByTestId("quiz-answer-0")).toHaveText("未回答");
  await expect(page.getByTestId("quiz-submit")).toHaveCount(0);
});

test("a rejected second quiz in one step renders as a failed call, not a stuck card", async ({
  page,
  request,
}) => {
  // A step may hold only one suspension, so the second call is refused. It is persisted with
  // an `output` and no `status` — which is also the shape of one mid-`tool_start`. Rendered
  // as a card on the name alone it showed "准备题目中" forever; it belongs on the ordinary
  // tool card, where the error the model was actually given is readable.
  await scriptLlm(request, {
    title: "两道小测",
    turns: [
      {
        content: "先测两个。",
        toolCalls: [
          { id: "call_a", name: "ila_quiz", args: { questions: QUESTIONS.slice(0, 1) } },
          { id: "call_b", name: "ila_quiz", args: { questions: QUESTIONS.slice(1, 2) } },
        ],
      },
      { content: "好。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `小测 ${Date.now()}`);
  await page.getByTestId("composer-input").fill("我想学 Flink");
  await page.getByTestId("composer-send").click();

  // One answerable card, and no card left on the placeholder.
  await expect(page.getByTestId("quiz-card")).toHaveCount(1);
  await expect(page.getByTestId("quiz-preparing")).toHaveCount(0);
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");

  // The refused call is an ordinary tool card, and its result says why. Clicking the card
  // itself opens the disclosure — collapsed, it is exactly its header.
  const failed = page.getByTestId("tool-call");
  await expect(failed).toHaveCount(1);
  await failed.click();
  await expect(failed).toContainText("only one question tool call is allowed per step");
});

test("option explanations stay hidden while answering and appear in the settled record", async ({
  page,
  request,
}) => {
  const SECRET = "因为水位线基于事件时间";
  const question = {
    header: "水位线",
    question: "水位线是基于什么时间的？",
    options: [
      { label: "事件时间", description: SECRET },
      { label: "处理时间" },
    ],
  };
  await scriptLlm(request, {
    title: "时间语义",
    turns: [
      { toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: [question] } }] },
      { content: "没错。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `小测 ${Date.now()}`);
  await page.getByTestId("composer-input").fill("考我");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("quiz-status")).toHaveText("等待你的作答");

  // The explanation must not leak while the question is live.
  await expect(page.getByTestId("quiz-card")).not.toContainText(SECRET);

  // Answer; the settled record's offered-options list now reveals it.
  await choice(page, 0, 0).click();
  await page.getByTestId("quiz-submit").click();
  await expect(page.getByTestId("quiz-status")).toHaveText("已提交");
  await page.getByTestId("quiz-disclosure").click();
  await expect(page.getByTestId("quiz-details")).toContainText(SECRET);
});
