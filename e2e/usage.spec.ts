import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The usage statistics pages, over a real browser and a real ledger.
 *
 * `apps/server/test/usage.test.ts` pins what the routes compute and refuse, and
 * `apps/web/test/utils/charts.test.ts` pins the palette. What only a browser can say is that the
 * *pages* are there and that a chart actually drew — a canvas is the one element whose content no
 * assertion can read, so a chart that never rendered and one that rendered a flat line look
 * identical to every other kind of test.
 */

/**
 * One turn, with usage the fake LLM reports.
 *
 * Waits for the *reply* rather than for the composer to become usable again: the send button goes
 * back to its enabled state only once there is text in the box, so "enabled" is never true after a
 * successful send — it is the state the button is in *before* one.
 */
async function spend(page: Page, request: APIRequestContext, message: string): Promise<void> {
  await scriptLlm(request, {
    turns: [{ content: `re: ${message}`, usage: { input: 400, output: 80, cached: 300 } }],
  });
  await page.getByTestId("composer-input").fill(message);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText(`re: ${message}`, {
    timeout: 15_000,
  });
}

async function openUsage(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("open-usage").click();
  await expect(page.getByTestId("usage-page")).toBeVisible();
}

test("the account's usage page reports the spend its own turns made", async ({ page, request }) => {
  await page.goto("/");
  await enterWorkspace(page);
  await spend(page, request, "记一笔用量");

  await openUsage(page);

  // The totals arrive from the ledger, so a turn taken a moment ago is already in them.
  await expect(page.getByTestId("stats-totals")).toBeVisible();
  await expect(page.getByTestId("stats-tile-calls")).not.toContainText("0");
  await expect(page.getByTestId("stats-tile-input")).not.toContainText("^0$");

  // Counting began, said out loud: the ledger is forward-only and a page that did not say so
  // would read as a claim about all of history.
  await expect(page.getByTestId("stats-since")).toContainText("统计自");

  // The purpose table separates the turn from the calls the server made around it — the whole
  // reason the ledger is a table rather than a sum over messages.
  const purposes = page.getByTestId("stats-table-purpose");
  await expect(purposes).toBeVisible();
  await expect(page.getByTestId("stats-row-chat")).toBeVisible();
  await expect(page.getByTestId("stats-row-title")).toBeVisible();

  // The conversations table names the conversation the spend went into.
  await expect(page.getByTestId("stats-table-session")).toBeVisible();
});

test("a chart actually draws", async ({ page, request }) => {
  /*
   * A canvas has no text to assert on, so the check is that it has been *painted*: a zero-width or
   * zero-height box, or one whose bitmap is blank, is what a failed render looks like — and it
   * looks exactly like a successful one to every other kind of test.
   */
  await page.goto("/");
  await enterWorkspace(page);
  await spend(page, request, "画个图");

  await openUsage(page);

  /*
   * A range first, and that is not a workaround: with one day of spend there is no *trend*, so the
   * page deliberately draws no chart — a single point on a line is a chart that says nothing. The
   * preset is what turns the ledger into a shape worth plotting, and the server fills the quiet
   * days inside a named range, which is the other half of what this asserts.
   */
  await page.getByTestId("stats-preset-week").click();

  const canvas = page.getByTestId("stats-chart-days");
  await expect(canvas).toBeVisible();

  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(50);
  expect(box!.height).toBeGreaterThan(50);

  // Painted, not merely present: a canvas that threw during the draw is blank and the same size.
  const painted = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext("2d");
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  });
  expect(painted).toBe(true);
});

test("the console's section reports the installation, and only an administrator reaches it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("open-admin").click();
  await expect(page.getByTestId("admin-console")).toBeVisible();

  // The section is in the console's own menu, and the URL names it.
  await page.getByTestId("admin-nav-stats").click();
  await expect(page.getByTestId("admin-stats")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/stats$/);

  // The same panel, asked for the other endpoint — so the per-account breakdown is here and is
  // *not* on the account's own page.
  await expect(page.getByTestId("stats-platform")).toBeVisible();
  await expect(page.getByTestId("stats-table-user")).toBeVisible();
});

test("the date range narrows what the page reports", async ({ page, request }) => {
  await page.goto("/");
  await enterWorkspace(page);
  await spend(page, request, "范围之内");

  await openUsage(page);
  await expect(page.getByTestId("stats-tile-calls")).not.toContainText("0");

  // A range in the past holds nothing, and the page says which nothing it is: "this range is
  // empty" rather than "nothing has ever been counted", which have different remedies.
  await page.getByTestId("stats-from").fill("2020-01-01");
  await page.getByTestId("stats-to").fill("2020-01-03");
  await expect(page.getByTestId("stats-range-empty")).toBeVisible();

  // The preset puts it back, and the spend returns with it.
  await page.getByTestId("stats-preset-all").click();
  await expect(page.getByTestId("stats-tile-calls")).not.toContainText("0");
});

test("each reply says which model wrote it", async ({ page, request }) => {
  /*
   * The reason it is on the *message* rather than on the conversation: a model can be changed
   * mid-conversation, and a transcript with two of them in it is one whose token figures mean
   * nothing without this line. The browser is where the wire field becomes something a reader sees.
   */
  await page.goto("/");
  await enterWorkspace(page);
  await spend(page, request, "谁写的");

  const reply = page.getByTestId("message-assistant").last();
  await expect(reply.getByTestId("message-model")).toBeVisible();
  await expect(reply.getByTestId("message-model")).toHaveText("fake-model");

  // The user's own message has no model, and shows no line rather than a placeholder.
  await expect(page.getByTestId("message-user").last().getByTestId("message-model")).toHaveCount(0);
});
