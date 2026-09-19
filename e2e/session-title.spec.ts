import { expect, test, type APIRequestContext } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Naming a conversation, and not naming it too early.
 *
 * The titler runs after every turn the conversation is still its to name, and what it may answer is
 * as much the subject as a title: a conversation with nothing in it yet stays 未命名 and is asked
 * about again on the next turn. The three cases below are that rule, the retry a reader walking away
 * triggers, and the gate that keeps the whole thing free for a conversation the model already named.
 *
 * The wait in the second case is real rather than simulated, and it has to be: the client's debounce
 * is three seconds of wall clock, and the point of the feature is that nothing is waiting on it. So
 * the assertion polls the *effect* — one more non-streaming call at the fake LLM — rather than
 * sleeping.
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

test("a conversation with nothing to name yet keeps its placeholder, and is named later", async ({
  page,
  request,
}) => {
  /*
   * The whole of the new rule, from the outside. A conversation that opens with a greeting has
   * nothing to be named after, so the model says so rather than inventing a title from it — and the
   * sidebar keeps saying 未命名. Nothing else could produce a name that means anything: asking is
   * the only way to find out, and the first asking can only be answered "not yet".
   */
  const name = unique("Untitled");
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await scriptLlm(request, {
    title: "NO_TITLE",
    turns: [{ content: "你好！有什么可以帮你的？" }],
  });
  await page.getByTestId("composer-input").fill("你好");
  await page.getByTestId("composer-send").click();

  // Wait for the turn itself — the titler runs after it, so this is what makes the assertion below
  // about a decline rather than about a title that has not arrived yet.
  await expect(page.getByTestId("message-assistant").last()).toContainText("你好！有什么可以帮你的？");
  // The placeholder the client sent at creation, unchanged, and no name invented from a greeting.
  await expect(page.getByTestId("session-title")).toHaveText("（未命名）会话");

  // A turn with something in it: the titler is asked again, and this time there is an answer.
  await scriptLlm(request, { title: "快速排序入门", turns: [{ content: "快速排序是…" }] });
  await page.getByTestId("composer-input").fill("帮我讲讲快速排序");
  await page.getByTestId("composer-send").click();

  await expect(page.getByTestId("session-title")).toHaveText("快速排序入门");
});

test("a conversation the model already named is left alone", async ({ page, request }) => {
  /*
   * The gate, from the outside: no re-titling for a conversation the model has already named, on
   * any later turn or on the way out of it. Asserted on the request count, because a `skipped` that
   * had still paid for a completion would look identical from the UI — and this is the common case,
   * so it is the one that has to be free.
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
