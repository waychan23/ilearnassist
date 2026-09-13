import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The plan widget over a real browser and a scripted model: install through the new-session
 * dialog, the model makes/edits/progresses a plan with the bound tools, the panel tracks it,
 * history browses read-only, and the "second plan" conflict card drives the fork.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

const TREE = [
  {
    title: "Chapter 1",
    children: [{ title: "1.1 Intro" }, { title: "1.2 Setup" }],
  },
  { title: "Chapter 2" },
];

/** Enter a fresh workspace and open a conversation with the plan widget preinstalled. */
async function planSession(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();

  await enterWorkspace(page, name);
  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-plan").check();
  await page.getByTestId("create-session").click();

  await expect(page.getByTestId("widget-tab-plan")).toBeVisible();
  await page.getByTestId("widget-tab-plan").click();
  await expect(page.getByTestId("plan-empty")).toBeVisible();
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
}

/** Current plan rows: stable id plus the title with the ordinal span removed. */
async function rows(page: Page): Promise<{ id: string; title: string }[]> {
  return page.locator('[data-testid^="plan-node-"]').evaluateAll((els) =>
    els.map((el) => {
      const titleEl = el.querySelector(".plan-title");
      titleEl?.querySelector(".plan-no")?.remove();
      return {
        id: el.getAttribute("data-testid")!.replace("plan-node-", ""),
        title: (titleEl?.textContent ?? "").trim(),
      };
    })
  );
}

async function idOf(page: Page, title: string): Promise<string> {
  const all = await rows(page);
  const found = all.find((r) => r.title === title);
  expect(found, `plan node ${title}`).toBeTruthy();
  return found!.id;
}

function makeTurn(toolCallId: string, tree: unknown[]) {
  return [
    { toolCalls: [{ id: toolCallId, name: "ila_make_plan", args: { tree } }] },
    { content: "计划已经记录在右侧面板中。" },
  ];
}

test.describe("the plan widget", () => {
  test("makes a plan, tracks progress, edits with tombstones, and browses history", async ({
    page,
    request,
  }) => {
    const name = unique("Plan lifecycle");
    await planSession(page, name);

    // V1: the model builds the plan; the panel updates on the tool call, before turn end.
    await scriptLlm(request as APIRequestContext, { title: "学习 Rust", turns: makeTurn("call_make", TREE) });
    await send(page, "帮我制定一个两周学习 Rust 的计划");

    await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(4);
    await expect(page.getByTestId("plan-status-badge")).toHaveText("未开始");
    expect(await page.getByTestId("plan-version-select").inputValue()).toBe("latest");

    // Hierarchical numbering, from sibling position: root 1/2, children 1.1/1.2.
    const numbers = await page.locator(".plan-no").allInnerTexts();
    expect(numbers).toEqual(["1", "1.1", "1.2", "2"]);

    // Progress: complete the intro leaf, start its chapter.
    const chapter1 = await idOf(page, "Chapter 1");
    const intro = await idOf(page, "1.1 Intro");
    await scriptLlm(request as APIRequestContext, {
      turns: [
        {
          toolCalls: [
            {
              id: "call_progress",
              name: "ila_update_plan_progress",
              args: {
                nodes: [
                  { id: intro, status: "completed" },
                  { id: chapter1, status: "in_progress" },
                ],
              },
            },
          ],
        },
        { content: "入门这节学完了。" },
      ],
    });
    await send(page, "第一章入门看完了");

    const introRow = page.getByTestId(`plan-node-${intro}`);
    await expect(introRow).toHaveAttribute("data-node-status", "completed");
    await expect(page.getByTestId(`plan-jump-${intro}`)).toBeVisible();
    await expect(page.getByTestId("plan-status-badge")).toHaveText("进行中");
    // The jump scrolls to the exact tool-call card, which carries its id.
    await expect(page.locator('[data-tool-call-id="call_progress"]')).toBeVisible();

    // Edit: drop "1.2 Setup", add "1.3 New". Ids come from the panel's own rows.
    const chapter2 = await idOf(page, "Chapter 2");
    await scriptLlm(request as APIRequestContext, {
      turns: makeTurn("call_edit", [
        {
          id: chapter1,
          title: "Chapter 1",
          children: [
            { id: intro, title: "1.1 Intro" },
            { title: "1.3 New" },
          ],
        },
        { id: chapter2, title: "Chapter 2" },
      ]),
    });
    await send(page, "把 1.2 换成别的");

    const setup = await idOf(page, "1.2 Setup");
    await expect(page.getByTestId(`plan-node-${setup}`)).toHaveAttribute(
      "data-node-status",
      "deleted"
    );
    const newNode = page.locator('[data-testid^="plan-node-"]', {
      hasText: "1.3 New",
    });
    await expect(newNode).toHaveCount(1);
    // V2 is the latest, offered with V1 in the dropdown.
    await expect(page.getByTestId("plan-version-select")).toContainText("V2");

    // History is structural and read-only: V1 still has 1.2, no 1.3, no statuses.
    await page.getByTestId("plan-version-select").selectOption("1");
    await expect(page.getByTestId("plan-history-banner")).toBeVisible();
    await expect(page.locator('[data-testid^="plan-node-"]', { hasText: "1.2 Setup" })).toBeVisible();
    await expect(page.locator('[data-testid^="plan-node-"]', { hasText: "1.3 New" })).toHaveCount(0);
    const historyRows = await page.locator('[data-testid^="plan-node-"]').evaluateAll((els) =>
      els.every((el) => el.getAttribute("data-node-status") === "")
    );
    expect(historyRows).toBe(true);

    // Back to latest: statuses return.
    await page.getByTestId("plan-version-select").selectOption("latest");
    await expect(page.getByTestId("plan-history-banner")).toHaveCount(0);
    await expect(page.getByTestId(`plan-node-${setup}`)).toHaveAttribute(
      "data-node-status",
      "deleted"
    );

    // Collapse quick actions do not error and actually collapse.
    await page.getByTestId("plan-level-1").click();
    await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(2);
    await page.getByTestId("plan-expand-all").click();
    await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(5);
  });

  test("the conflict card edits this plan when chosen", async ({ page, request }) => {
    const name = unique("Plan conflict edit");
    await planSession(page, name);

    await scriptLlm(request as APIRequestContext, { turns: makeTurn("call_make", TREE) });
    await send(page, "制定学习计划");
    await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(4);

    // The model ignores the "edit needs ids" contract and submits a fresh tree: it suspends.
    await scriptLlm(request as APIRequestContext, {
      turns: [
        {
          content: "你是想重做计划吗？",
          toolCalls: [
            { id: "call_conflict", name: "ila_make_plan", args: { tree: [{ title: "Brand new" }] } },
          ],
        },
      ],
    });
    await send(page, "我要一个完全不同的计划");

    const card = page.getByTestId("plan-conflict-card");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("plan-conflict-new-session")).toBeVisible();

    await scriptLlm(request as APIRequestContext, { turns: [{ content: "已覆盖当前计划。" }] });
    await page.getByTestId("plan-conflict-edit").click();

    await expect(page.getByTestId("plan-version-select")).toContainText("V2");
    const tree = page.locator('[data-testid^="plan-node-"]', { hasText: "Brand new" });
    await expect(tree).toBeVisible();
    // Old nodes are tombstones in the current view.
    await expect(page.locator('[data-node-status="deleted"]').first()).toBeVisible();
  });

  test("the conflict card creates another conversation and switches to it", async ({
    page,
    request,
  }) => {
    const name = unique("Plan conflict new session");
    await planSession(page, name);

    await scriptLlm(request as APIRequestContext, { turns: makeTurn("call_make", TREE) });
    await send(page, "制定学习计划");
    await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(4);

    await scriptLlm(request as APIRequestContext, {
      turns: [
        {
          toolCalls: [
            {
              id: "call_conflict",
              name: "ila_make_plan",
              args: { tree: [{ title: "Brand new plan" }] },
            },
          ],
        },
      ],
    });
    await send(page, "这个计划不要了，重新做一个");

    await expect(page.getByTestId("plan-conflict-card")).toBeVisible();
    await scriptLlm(request as APIRequestContext, {
      turns: [{ content: "已在新会话里为你创建。" }],
    });
    await page.getByTestId("plan-conflict-new-session").click();

    // Auto-switch: the new conversation's V1 is the single new root, panel still installed.
    await expect(page.locator('[data-testid^="plan-node-"]', { hasText: "Brand new plan" })).toBeVisible();
    await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(1);
    await expect(page.getByTestId("plan-version-select")).toContainText("V1");

    // Two conversations now, and the active one is titled from the plan's first node.
    await expect(page.getByTestId("session-item")).toHaveCount(2);
    const active = page.locator(".session-item.active");
    await expect(active).toContainText("Brand new plan");
  });

  test("play on an undone node confirms, skips earlier chapters, opens the target, and messages", async ({
    page,
    request,
  }) => {
    const name = unique("Plan chapter jump");
    await planSession(page, name);

    await scriptLlm(request as APIRequestContext, { turns: makeTurn("call_make", TREE) });
    await send(page, "制定学习计划");
    await expect(page.locator('[data-testid^="plan-node-"]')).toHaveCount(4);

    const setup = await idOf(page, "1.2 Setup");

    await scriptLlm(request as APIRequestContext, { turns: [{ content: "好，我们开始学 1.2。" }] });
    await page.getByTestId(`plan-play-${setup}`).click();

    // The confirmation rewrites progress, so it names what gets skipped.
    await expect(page.getByTestId("confirm-accept")).toBeVisible();
    await expect(page.locator(".modal, [role='dialog']").first()).toContainText("1.2");
    await page.getByTestId("confirm-accept").click();

    // The composed user message drives the ordinary chat flow.
    await expect(page.getByTestId("message-user").last()).toContainText(
      "调整进度，跳到章节1.2 1.2 Setup"
    );
    await expect(page.getByTestId("message-assistant").last()).toContainText("我们开始学 1.2");

    // 1.1 Intro is skipped, the target in progress, Chapter 2 untouched.
    const intro = await idOf(page, "1.1 Intro");
    await expect(page.getByTestId(`plan-node-${intro}`)).toHaveAttribute(
      "data-node-status",
      "skipped"
    );
    await expect(page.getByTestId(`plan-node-${setup}`)).toHaveAttribute(
      "data-node-status",
      "in_progress"
    );
    const chapter2 = await idOf(page, "Chapter 2");
    await expect(page.getByTestId(`plan-node-${chapter2}`)).toHaveAttribute(
      "data-node-status",
      "not_started"
    );
    // Skipped nodes stay playable so a learner can come back to them.
    await expect(page.getByTestId(`plan-play-${intro}`)).toBeVisible();
  });

  test("the footer composer sends an adjustment as a normal user message", async ({
    page,
    request,
  }) => {
    const name = unique("Plan adjust");
    await planSession(page, name);

    await scriptLlm(request as APIRequestContext, { turns: makeTurn("call_make", TREE) });
    await send(page, "制定学习计划");

    await page.getByTestId("plan-adjust-open").click();
    const input = page.getByTestId("plan-adjust-input");
    await expect(input).toBeVisible();
    await input.fill("把第三章拆成两章");
    // Empty-disabled until there is text.
    await expect(page.getByTestId("plan-adjust-send")).toBeEnabled();
    await scriptLlm(request as APIRequestContext, {
      turns: [{ toolCalls: [{ id: "call_read", name: "ila_read_plan", args: {} }] }, { content: "已调整。" }],
    });
    await page.getByTestId("plan-adjust-send").click();

    await expect(page.getByTestId("message-user").last()).toContainText(
      "调整计划：把第三章拆成两章"
    );
    await expect(page.getByTestId("message-assistant").last()).toContainText("已调整。");
    // The composer collapses after sending.
    await expect(page.getByTestId("plan-adjust-open")).toBeVisible();
  });
});
