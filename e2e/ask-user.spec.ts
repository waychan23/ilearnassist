import { expect, test, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The `ask_user` card, in a browser.
 *
 * A model that asks a question mid-turn is the one flow that spans two HTTP requests, so
 * it is the one flow where the pieces can each pass their unit tests and still not meet:
 * the tool suspends the loop, the route persists a pending call, the card renders it, the
 * answer comes back on a second request, and the turn finishes. Only a real browser
 * against the real stack proves the seams line up.
 */

const QUESTIONS = [
  {
    header: "认证方式",
    question: "要用哪种认证方式？",
    options: [
      { label: "OAuth", description: "浏览器跳转授权" },
      { label: "API Key", description: "静态令牌" },
    ],
  },
  {
    header: "数据库",
    question: "数据库用哪个？",
    options: [{ label: "PostgreSQL" }, { label: "MySQL" }],
  },
  {
    header: "部署方式",
    question: "怎么部署？",
    options: [{ label: "单机" }, { label: "容器" }],
  },
];

/** The option's radio/checkbox, for `toBeChecked`. */
const choice = (page: Page, question: number, option: number) =>
  page.getByTestId(`ask-user-option-${question}-${option}`).locator("input");

/**
 * Pick one of the model's options, letting the wizard advance on its own.
 *
 * `click()` rather than `check()`: Playwright's `check()` clicks *and then asserts the input
 * is checked*, and picking a single-select option rebuilds the panel under it — so the
 * assertion would spend its whole timeout polling an element that no longer exists.
 */
const pick = (page: Page, question: number, option: number) =>
  choice(page, question, option).click();

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
}

test("answers a three-question card through the tabs, and the record survives a reload", async ({
  page,
  request,
}) => {
  const workspace = `问一问 ${Date.now()}`;
  await scriptLlm(request, {
    title: "加一个登录",
    turns: [
      {
        content: "有三件事需要你定。",
        toolCalls: [{ id: "call_ask", name: "ask_user", args: { questions: QUESTIONS } }],
      },
      { content: "好的，按 OAuth + SQLite + 容器 来实现。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, workspace);
  await page.getByTestId("composer-input").fill("帮我加个登录");
  await page.getByTestId("composer-send").click();

  // The preamble the model streamed before asking survives — the turn ended on the
  // question, so nothing replaced it.
  await expect(page.getByTestId("message-assistant").last()).toContainText("有三件事需要你定。");

  const card = page.getByTestId("ask-user-card");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("ask-user-status")).toHaveText("等待你的回答");

  // One question at a time, with the strip counting them off.
  await expect(page.getByTestId("ask-user-question")).toHaveText("要用哪种认证方式？");
  await expect(page.getByTestId("ask-user-step")).toHaveText("第 1 / 3 题");

  // Submit is only offered on the last question, and only once every one is answered.
  await expect(page.getByTestId("ask-user-submit")).toHaveCount(0);

  // Choosing one of the model's options answers a single-select question outright, so the
  // wizard steps on by itself — there is nothing further to do on this tab.
  await pick(page, 0, 0);
  await expect(page.getByTestId("ask-user-question")).toHaveText("数据库用哪个？");
  await expect(page.getByTestId("ask-user-step")).toHaveText("第 2 / 3 题");
  await expect(page.getByTestId("ask-user-submit")).toHaveCount(0);

  // The free-text choice is the client's own, appended to whatever the model offered — it
  // is never one of the options above. Picking it must *not* advance: the user has not
  // said anything yet, and the panel they would be leaving holds the box they type in.
  await page.getByTestId("ask-user-other-1").locator("input").check();
  await expect(page.getByTestId("ask-user-question")).toHaveText("数据库用哪个？");
  await page.getByTestId("ask-user-other-input-1").fill("SQLite");

  await page.getByTestId("ask-user-next").click();
  await expect(page.getByTestId("ask-user-question")).toHaveText("怎么部署？");
  await expect(page.getByTestId("ask-user-submit")).toBeDisabled();

  // Navigating back and forth keeps what was already answered.
  await page.getByTestId("ask-user-previous").click();
  await expect(page.getByTestId("ask-user-question")).toHaveText("数据库用哪个？");
  await expect(page.getByTestId("ask-user-other-1").locator("input")).toBeChecked();
  await expect(page.getByTestId("ask-user-other-input-1")).toHaveValue("SQLite");
  await page.getByTestId("ask-user-previous").click();
  await expect(page.getByTestId("ask-user-question")).toHaveText("要用哪种认证方式？");
  await expect(choice(page, 0, 0)).toBeChecked();

  // Forward again by the explicit control, then the last question — which has nowhere to
  // advance to, so the submit button is what is left.
  await page.getByTestId("ask-user-next").click();
  await expect(page.getByTestId("ask-user-question")).toHaveText("数据库用哪个？");
  await page.getByTestId("ask-user-next").click();
  await expect(page.getByTestId("ask-user-question")).toHaveText("怎么部署？");

  await choice(page, 2, 1).check();
  await expect(page.getByTestId("ask-user-question")).toHaveText("怎么部署？");
  await expect(page.getByTestId("ask-user-submit")).toBeEnabled();

  await page.getByTestId("ask-user-submit").click();

  // The turn resumes: a new assistant reply, from the answers just given.
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "好的，按 OAuth + SQLite + 容器 来实现。"
  );

  // And the card becomes a record. The summary is visible without expanding anything —
  // that is what makes a choice legible when the conversation is read back later.
  await expect(card.getByTestId("ask-user-status")).toHaveText("已确认");
  await expect(card.getByTestId("ask-user-answer-0")).toHaveText("OAuth");
  await expect(card.getByTestId("ask-user-answer-1")).toHaveText("SQLite");
  await expect(card.getByTestId("ask-user-answer-2")).toHaveText("容器");
  await expect(card.getByTestId("ask-user-tab-0")).toHaveCount(0);

  // The options that were offered sit behind the disclosure, ticked where they were
  // picked — so the record shows the decision against what was on offer, not just the
  // answer on its own.
  await expect(card.getByTestId("ask-user-details")).toHaveCount(0);
  await card.getByTestId("ask-user-disclosure").click();

  const details = card.getByTestId("ask-user-details");
  await expect(details).toContainText("API Key");
  await expect(details.getByTestId("ask-user-detail-option-0-0")).toHaveAttribute(
    "data-chosen",
    "true"
  );
  await expect(details.getByTestId("ask-user-detail-option-0-1")).toHaveAttribute(
    "data-chosen",
    "false"
  );
  await expect(details.getByTestId("ask-user-detail-option-2-1")).toHaveAttribute(
    "data-chosen",
    "true"
  );
  // The typed answer appears with the options, not only in the summary.
  await expect(details.getByTestId("ask-user-detail-other-1")).toContainText("SQLite");
  // A question answered from the offered options has no free-text row.
  await expect(details.getByTestId("ask-user-detail-other-0")).toHaveCount(0);

  // --- reload: the whole exchange must come back from the database ---
  await page.reload();

  // The reload would leave the reader in the conversation (a page is a URL now); walking in
  // from the front door instead reads the session again the way a new reader would.
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();

  await expect(page.getByTestId("ask-user-status")).toHaveText("已确认");
  await expect(page.getByTestId("ask-user-answer-0")).toHaveText("OAuth");
  await expect(page.getByTestId("ask-user-answer-1")).toHaveText("SQLite");
  await expect(page.getByTestId("ask-user-answer-2")).toHaveText("容器");
  await expect(page.getByTestId("message-assistant").last()).toContainText(
    "好的，按 OAuth + SQLite + 容器 来实现。"
  );
});

test("a question the user walks away from is retired, not left waiting", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "加一个登录",
    turns: [
      {
        content: "需要先确认一件事。",
        toolCalls: [{ id: "call_ask", name: "ask_user", args: { questions: [QUESTIONS[0]] } }],
      },
      { content: "好，那我先做别的。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `问一问 ${Date.now()}`);
  await page.getByTestId("composer-input").fill("帮我加个登录");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("ask-user-status")).toHaveText("等待你的回答");

  // The user ignores the question and says something else. The card stops being answerable
  // rather than sitting live on a conversation that has moved on.
  await page.getByTestId("composer-input").fill("算了，先做别的");
  await page.getByTestId("composer-send").click();

  await expect(page.getByTestId("message-assistant").last()).toContainText("好，那我先做别的。");
  await expect(page.getByTestId("ask-user-status")).toHaveText("已跳过");
  await expect(page.getByTestId("ask-user-answer-0")).toHaveText("未回答");
  await expect(page.getByTestId("ask-user-submit")).toHaveCount(0);
});

/**
 * The reported shape, reproduced: the model lists the workspace first, then asks four
 * questions in a later step, one of them multi-select — and every tab is walked by hand.
 */
test("the reported shape: four questions after a tool call, one of them multi-select", async ({
  page,
  request,
}) => {
  const questions = [
    {
      header: "编程背景",
      question: "你目前的技术背景更接近哪一种？",
      options: [{ label: "Java 熟练" }, { label: "Java 一般" }, { label: "Python 方向" }],
    },
    {
      header: "Flink 基础",
      question: "你对 Flink 目前的熟悉程度如何？",
      options: [{ label: "没接触过" }, { label: "写过 Demo" }, { label: "想补齐原理" }],
    },
    {
      header: "学习目标",
      question: "你学 Flink 最想达成的目标是什么？（可多选）",
      multiSelect: true,
      options: [{ label: "流计算开发" }, { label: "集群运维" }, { label: "Flink SQL" }],
    },
    {
      header: "学习节奏",
      question: "你希望的学习节奏和深度是？",
      options: [{ label: "深度实战" }, { label: "先建立认知" }, { label: "面试导向" }],
    },
  ];

  await scriptLlm(request, {
    title: "Flink学习路径",
    turns: [
      { toolCalls: [{ id: "call_ls", name: "list_files", args: { path: "." } }] },
      {
        content: "Flink 是个好东西。请先回答下面几个问题：",
        toolCalls: [{ id: "call_ask", name: "ask_user", args: { questions } }],
      },
      { content: "好的，按你的背景来设计。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `问一问 ${Date.now()}`);
  await page.getByTestId("composer-input").fill("我要学习Flink");
  await page.getByTestId("composer-send").click();

  await expect(page.getByTestId("ask-user-status")).toHaveText("等待你的回答");

  // The card sits *below* the sentence introducing it. Above it, a card demanding an answer
  // appeared before the words explaining it — and while streaming that read as though the
  // message had ended and then started talking again.
  const textBox = (await page.getByTestId("message-content").last().boundingBox())!;
  const cardBox = (await page.getByTestId("ask-user-card").boundingBox())!;
  expect(cardBox.y).toBeGreaterThan(textBox.y);

  await pick(page, 0, 0);
  await expect(page.getByTestId("ask-user-question")).toHaveText("你对 Flink 目前的熟悉程度如何？");

  await pick(page, 1, 0);
  await expect(page.getByTestId("ask-user-question")).toHaveText("你学 Flink 最想达成的目标是什么？（可多选）");

  // Multi-select must not advance: the user checks as many as they want.
  await choice(page, 2, 0).check();
  await choice(page, 2, 2).check();
  await expect(page.getByTestId("ask-user-question")).toHaveText("你学 Flink 最想达成的目标是什么？（可多选）");

  await page.getByTestId("ask-user-next").click();
  await pick(page, 3, 0);
  await expect(page.getByTestId("ask-user-submit")).toBeEnabled();
  await page.getByTestId("ask-user-submit").click();

  await expect(page.getByTestId("message-assistant").last()).toContainText("好的，按你的背景来设计。");
});

/**
 * A card holding one single-select question sends itself the moment an option is picked.
 *
 * There is nothing else to say about such a question — the only other input one can offer is
 * its free-text choice, and picking an offered option closes that — so a Submit button would
 * exist only to be pressed after the answer was already complete. The three cases that must
 * *not* do this are the ones below it, and each is a different reason.
 */
test("a single-question card submits on the pick, with no button to press", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "加一个登录",
    turns: [
      {
        content: "只有一件事要定。",
        toolCalls: [{ id: "call_ask", name: "ask_user", args: { questions: [QUESTIONS[0]] } }],
      },
      { content: "好，就按 OAuth 来。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `问一问 ${Date.now()}`);
  await page.getByTestId("composer-input").fill("帮我加个登录");
  await page.getByTestId("composer-send").click();

  const card = page.getByTestId("ask-user-card");
  await expect(card.getByTestId("ask-user-status")).toHaveText("等待你的回答");

  // Nothing to press, and the card says so rather than letting the click be a surprise: this
  // commits on one action with nothing to undo it.
  await expect(page.getByTestId("ask-user-submit")).toHaveCount(0);
  await expect(page.getByTestId("ask-user-auto-hint")).toBeVisible();

  await pick(page, 0, 0);

  // No Submit click anywhere in this test: the turn resumes by itself.
  await expect(page.getByTestId("message-assistant").last()).toContainText("好，就按 OAuth 来。");
  await expect(card.getByTestId("ask-user-status")).toHaveText("已确认");
  await expect(card.getByTestId("ask-user-answer-0")).toHaveText("OAuth");
});

test("a single multi-select question still waits for Submit", async ({ page, request }) => {
  // Each pick is one of several and no click means "done", so there is no moment to send at.
  const questions = [
    {
      header: "学习目标",
      question: "你学 Flink 想达成哪些目标？（可多选）",
      multiSelect: true,
      options: [{ label: "流计算开发" }, { label: "集群运维" }],
    },
  ];

  await scriptLlm(request, {
    title: "学习目标",
    turns: [
      {
        content: "先确认目标。",
        toolCalls: [{ id: "call_ask", name: "ask_user", args: { questions } }],
      },
      { content: "好，按这两块来安排。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `问一问 ${Date.now()}`);
  await page.getByTestId("composer-input").fill("我要学习 Flink");
  await page.getByTestId("composer-send").click();

  await expect(page.getByTestId("ask-user-status")).toHaveText("等待你的回答");
  await expect(page.getByTestId("ask-user-auto-hint")).toHaveCount(0);
  await expect(page.getByTestId("ask-user-submit")).toBeDisabled();

  await pick(page, 0, 0);
  await expect(page.getByTestId("ask-user-submit")).toBeEnabled();
  // Still answerable after the first pick — that is the whole difference.
  await expect(page.getByTestId("ask-user-question")).toBeVisible();

  await pick(page, 0, 1);
  await page.getByTestId("ask-user-submit").click();

  await expect(page.getByTestId("ask-user-status")).toHaveText("已确认");
  await expect(page.getByTestId("ask-user-answer-0")).toHaveText("流计算开发、集群运维");
});

test("a single question's free-text choice keeps its Submit", async ({ page, request }) => {
  // The same one-question card as the first test, but the pick is the client's own free-text
  // choice — which opens a box the user has yet to type in, so the card is a manual one
  // again and the hint stops claiming otherwise.
  await scriptLlm(request, {
    title: "加一个登录",
    turns: [
      {
        content: "只有一件事要定。",
        toolCalls: [{ id: "call_ask", name: "ask_user", args: { questions: [QUESTIONS[0]] } }],
      },
      { content: "好，按 SAML 来。" },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `问一问 ${Date.now()}`);
  await page.getByTestId("composer-input").fill("帮我加个登录");
  await page.getByTestId("composer-send").click();

  await expect(page.getByTestId("ask-user-status")).toHaveText("等待你的回答");

  await page.getByTestId("ask-user-other-0").locator("input").click();

  // Nothing was sent, and nothing says it will be: the box needs typing first.
  await expect(page.getByTestId("ask-user-question")).toBeVisible();
  await expect(page.getByTestId("ask-user-auto-hint")).toHaveCount(0);
  await expect(page.getByTestId("ask-user-submit")).toBeDisabled();

  await page.getByTestId("ask-user-other-input-0").fill("SAML");
  await expect(page.getByTestId("ask-user-submit")).toBeEnabled();
  await page.getByTestId("ask-user-submit").click();

  await expect(page.getByTestId("message-assistant").last()).toContainText("好，按 SAML 来。");
  await expect(page.getByTestId("ask-user-answer-0")).toHaveText("SAML");
});
