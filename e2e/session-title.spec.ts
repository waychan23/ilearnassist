import { expect, test, type APIRequestContext } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The second attempt at a name.
 *
 * The auto-titler runs once, on a conversation's first turn, and when it fails what is left is the
 * user's own clipped words — indistinguishable, until now, from a title the model wrote. This spec
 * is the whole loop: a failed titling, a reader walking away, and the name that is there when they
 * come back.
 *
 * The wait is real rather than simulated, and it has to be: the client's debounce is three seconds
 * of wall clock, and the point of the feature is that nothing is waiting on it. So the assertion
 * polls the *effect* — one more non-streaming call at the fake LLM — rather than sleeping.
 */

const unique = (prefix: string): string => `${prefix} ${Date.now()}`;

async function llmRequests(request: APIRequestContext): Promise<{ stream?: boolean }[]> {
  return (await request.get(`${FAKE_LLM}/__requests`)).json();
}

test("a conversation the titler failed to name is retried when the reader leaves", async ({
  page,
  request,
}) => {
  const name = unique("Retitle");
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  /*
   * A titling call that answers with whitespace is what makes `generateTitle` throw —
   * `sanitizeTitle` cleans it to nothing — and the fallback is the user's own words. It has to be
   * a `match` on the titler's own prompt: the sticky `title` cannot be made unusable, because the
   * script endpoint ignores an empty one.
   */
  await scriptLlm(request, {
    matches: [{ includes: "titling function", content: " " }],
    turns: [{ content: "好的。" }],
  });
  await page.getByTestId("composer-input").fill("什么是递归");
  await page.getByTestId("composer-send").click();

  // The state this feature exists for: the conversation is named after the question, which is
  // what the sidebar shows and what nothing before this could tell from a model-written title.
  await expect(page.getByTestId("session-title")).toHaveText("什么是递归");

  // Now the model will answer, and the reader leaves.
  await scriptLlm(request, { title: "递归入门", turns: [{ content: "好的。" }] });
  const before = (await llmRequests(request)).length;

  await page.getByTestId("all-workspaces").click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  /*
   * Polled, not slept. The report waits out the debounce on the client and then runs the titler,
   * so the observable is one more *non-streaming* request — the turn above was the streaming one.
   */
  await expect
    .poll(async () => (await llmRequests(request)).length, {
      timeout: 20_000,
      message: "the leave should have asked the titler again",
    })
    .toBeGreaterThan(before);

  // And the name is there when the conversation is opened again, read from the server rather than
  // remembered by the tab that reported it.
  await enterWorkspace(page, name);
  await expect(page.getByTestId("session-item").first()).toContainText("递归入门");
});

test("a conversation the model already named is left alone", async ({ page, request }) => {
  /*
   * The gate, from the outside: no re-titling for a conversation that was named on its first turn.
   * Asserted on the request count, because a `skipped` that had still paid for a completion would
   * look identical from the UI — and it is the common case, so it is the one that has to be free.
   */
  const name = unique("NoRetitle");
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await scriptLlm(request, { title: "模型起的名字", turns: [{ content: "好的。" }] });
  await page.getByTestId("composer-input").fill("什么是递归");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("session-title")).toHaveText("模型起的名字");

  const before = (await llmRequests(request)).length;
  await page.getByTestId("all-workspaces").click();
  await expect(page.getByTestId("workspace-home")).toBeVisible();

  // Well past the debounce, so a report that was going to fire has fired.
  await page.waitForTimeout(5_000);
  expect((await llmRequests(request)).length).toBe(before);
});
