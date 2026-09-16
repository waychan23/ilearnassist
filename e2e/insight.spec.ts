import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The insight panel end to end.
 *
 * Almost all of this is a *rule about a set* rather than about one screen, which is why it needs
 * a browser: an item you keep survives the next pass and the rest do not, a pass that produces
 * nothing usable changes nothing, and a failure is reported in the panel rather than as a toast.
 * The unit suites pin the parser and the transaction; this pins that a person pressing the
 * button gets what the rules say.
 *
 * The pass goes through the **real** HTTP path against the fake LLM, scripted over HTTP like
 * every other model-driven spec — so the long POST, the 200-with-`status:"failed"` and the
 * panel's own state machine are all exercised rather than stubbed.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

/** What the pass answers with, as the fake LLM's body-keyed reply. */
function answer(items: unknown[]): { includes: string; content: string } {
  return { includes: "<study_record>", content: JSON.stringify({ items }) };
}

/** A conversation with the insight widget installed and the panel open on it. */
async function insightSession(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("new-session-widget-check-insight").check();
  await page.getByTestId("create-session").click();

  /*
   * The insight tab is opened rather than assumed. It used to be the first tab because it was the
   * only widget installed, and a conversation now starts with the notes and sources panels too —
   * so "the panel opened on insight" would be a test of the widget order, which is not what this
   * helper is for.
   */
  await page.getByTestId("widget-tab-insight").click();
  await expect(page.getByTestId("widget-insight")).toBeVisible();
  await expect(page.getByTestId("insight-empty")).toBeVisible();
}

/**
 * Give the conversation something to reflect on.
 *
 * A pass reads only the conversation's *derived* records — a plan, answered questions, threads,
 * notes, diagrams — so a conversation that has just been created has none of them and the pass
 * deliberately declines to spend a model call on it (`status: "empty"`). A note is the smallest
 * piece of material there is, and its route is not widget-gated, so one POST is enough.
 *
 * Through the API rather than the notes panel on purpose: what is being tested here is the pass,
 * and driving a second widget's UI to set it up would make every failure below ambiguous between
 * the two.
 */
async function addMaterial(page: Page, request: APIRequestContext): Promise<void> {
  const sessionId = await page.getByTestId("session-item").first().getAttribute("data-session-id");
  expect(sessionId, "the new conversation should be listed").toBeTruthy();
  const res = await request.post(`/api/sessions/${sessionId}/notes`, {
    data: { type: "idea", content: "这里我还是不太懂", quote: "", occurrence: 0 },
  });
  expect(res.ok()).toBe(true);
}

/** Run a pass and wait for it to finish — the button re-enables when it does. */
async function generate(page: Page): Promise<void> {
  await page.getByTestId("insight-generate").click();
  await expect(page.getByTestId("insight-generate")).toBeEnabled();
}

test.describe("the insight panel", () => {
  test("runs a pass and shows each observation under its own type", async ({ page, request }) => {
    const name = unique("Insight");
    await scriptLlm(request, {
      turns: [],
      matches: [
        answer([
          { type: "difficulty", title: "递归" },
          { type: "strength", title: "闭包理解到位" },
        ]),
      ],
    });
    await insightSession(page, name);
    await addMaterial(page, request);

    await generate(page);

    // The type is on the row because the grouping and every follow-up action key on it — an
    // unknown one is filed as `advice` server-side rather than reaching the panel as a blank.
    await expect(
      page.getByTestId("insight-row").filter({ hasText: "递归" })
    ).toHaveAttribute("data-insight-type", "difficulty");
    await expect(
      page.getByTestId("insight-row").filter({ hasText: "闭包理解到位" })
    ).toHaveAttribute("data-insight-type", "strength");
    // Grouped by type, so the two kinds do not run together in one list.
    await expect(page.getByTestId("insight-list")).toContainText("难点");
    await expect(page.getByTestId("insight-list")).toContainText("已掌握");
  });

  test("adopt is a toggle, announced and painted as one", async ({ page, request }) => {
    // The badge is the visible half of `adopted` and `aria-pressed` is the announced one. They
    // are the same fact, and the rule under the list depends on the reader understanding it.
    const name = unique("Adopt");
    await scriptLlm(request, { turns: [], matches: [answer([{ type: "advice", title: "条目" }])] });
    await insightSession(page, name);
    await addMaterial(page, request);
    await generate(page);

    const row = page.getByTestId("insight-row").filter({ hasText: "条目" });
    const adopt = row.getByTestId("insight-adopt");
    await expect(adopt).toHaveAttribute("aria-pressed", "false");

    await adopt.click();
    await expect(adopt).toHaveAttribute("aria-pressed", "true");
    await expect(row).toContainText("已采纳");

    // And back, because a mis-click otherwise has no undo that is not "delete".
    await adopt.click();
    await expect(adopt).toHaveAttribute("aria-pressed", "false");
    await expect(row).not.toContainText("已采纳");
  });

  test("replaces the unadopted items and keeps the adopted ones", async ({ page, request }) => {
    // The rule the whole feature turns on, isolated: two items in, one adopted, then a second
    // pass that says something else entirely.
    const name = unique("Replace");
    await scriptLlm(request, {
      turns: [],
      matches: [answer([{ type: "habit", title: "留着的" }, { type: "advice", title: "会被替换" }])],
    });
    await insightSession(page, name);
    await addMaterial(page, request);
    await generate(page);
    await expect(page.getByTestId("insight-row")).toHaveCount(2);

    await page
      .getByTestId("insight-row")
      .filter({ hasText: "留着的" })
      .getByTestId("insight-adopt")
      .click();

    await scriptLlm(request, { turns: [], matches: [answer([{ type: "reading", title: "全新的" }])] });
    await generate(page);

    await expect(page.getByTestId("insight-row").filter({ hasText: "留着的" })).toBeVisible();
    await expect(page.getByTestId("insight-row").filter({ hasText: "全新的" })).toBeVisible();
    await expect(page.getByTestId("insight-row").filter({ hasText: "会被替换" })).toHaveCount(0);
    await expect(page.getByTestId("insight-row")).toHaveCount(2);
  });

  test("deletes one observation", async ({ page, request }) => {
    const name = unique("Delete");
    await scriptLlm(request, {
      turns: [],
      matches: [answer([{ type: "advice", title: "第一条" }, { type: "advice", title: "第二条" }])],
    });
    await insightSession(page, name);
    await addMaterial(page, request);
    await generate(page);

    await page
      .getByTestId("insight-row")
      .filter({ hasText: "第一条" })
      .getByTestId("insight-delete")
      .click();

    await expect(page.getByTestId("insight-row").filter({ hasText: "第一条" })).toHaveCount(0);
    await expect(page.getByTestId("insight-row")).toHaveCount(1);
  });

  test("reports a failed pass inside the panel and leaves the list alone", async ({
    page,
    request,
  }) => {
    /*
     * The invariant with the most riding on it, from the user's side: pressing generate and
     * getting a provider failure must not cost them the list they had. The unit suite pins the
     * transaction; this pins that the panel says so *in the panel* rather than replacing the
     * list with an error or raising a toast over the conversation.
     */
    const name = unique("Failed");
    await scriptLlm(request, { turns: [], matches: [answer([{ type: "advice", title: "已有的" }])] });
    await insightSession(page, name);
    await addMaterial(page, request);
    await generate(page);
    await expect(page.getByTestId("insight-row")).toHaveCount(1);

    // A model answering with prose instead of items.
    await scriptLlm(request, {
      turns: [],
      matches: [{ includes: "<study_record>", content: "I have nothing to say about this." }],
    });
    await generate(page);

    await expect(page.getByTestId("insight-failed")).toBeVisible();
    await expect(page.getByTestId("insight-row").filter({ hasText: "已有的" })).toBeVisible();
    await expect(page.getByTestId("insight-row")).toHaveCount(1);
  });
});

test("a conversation with nothing to reflect on says so instead of doing nothing", async ({
  page,
  request,
}) => {
  /*
   * The case the log surfaced on a real server: the pass reads only *derived* records, so a
   * conversation that has just been created has none, and spending a model call to ask a model to
   * observe a learner it was told nothing about is paying for the one instruction the prompt
   * cannot honour.
   *
   * So the pass declines — and the panel has to say which kind of nothing this is. `failed` and
   * `empty` both arrive with zero new items and ask the reader for opposite things (go and fix the
   * provider / go and have a conversation first), and a button whose press produces nothing
   * visible is the failure this test exists to prevent.
   */
  const name = unique("Nothing");
  // Scripted as if a pass ran, so an implementation that called the model anyway would fill the
  // panel and fail the assertion below rather than passing quietly.
  await scriptLlm(request, { turns: [], matches: [answer([{ type: "advice", title: "不该出现" }])] });
  await insightSession(page, name);

  await generate(page);

  await expect(page.getByTestId("insight-nothing")).toBeVisible();
  await expect(page.getByTestId("insight-row")).toHaveCount(0);
  await expect(page.getByTestId("insight-empty")).toBeVisible();
});
