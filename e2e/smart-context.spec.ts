import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * The experimental smart-context mode, end to end: the switch in the composer, and the
 * assertion that matters — what the *next* model request carries. The fake LLM records every
 * body it was sent, so "only the newest two history messages, and the prompt says so" is read
 * off the wire rather than inferred from the UI.
 */

/**
 * Every **streamed** request the fake received, newest last.
 *
 * The turn calls are the streaming ones; the titler and the thread classifier are non-streaming
 * (`stream: true` is only ever set by the agent loop), so this is the set the conversation's own
 * turns live in. Taking the first request whose body mentions a phrase matters for the system
 * prompt: the classifier's body also includes the turn's text.
 */
async function chatRequests(request: APIRequestContext): Promise<Record<string, unknown>[]> {
  const sent = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as {
    stream?: boolean;
  }[];
  return sent.filter((r) => r.stream === true);
}

/** The streamed request whose body contains a phrase. */
async function requestWith(
  request: APIRequestContext,
  phrase: string
): Promise<Record<string, unknown>> {
  const found = (await chatRequests(request)).find((r) => JSON.stringify(r).includes(phrase));
  if (!found) throw new Error(`no streamed request carried ${JSON.stringify(phrase)}`);
  return found;
}

async function send(page: Page, message: string, reply: string) {
  await page.getByTestId("composer-input").fill(message);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText(reply, {
    timeout: 15_000,
  });
}

test("smart context sends only the newest two history messages, and says so", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "智能上下文",
    turns: [
      { content: "第一个回答" },
      { content: "第二个回答" },
      { content: "第三个回答" },
    ],
  });

  await page.goto("/");
  await enterWorkspace(page);
  await send(page, "第一个问题", "第一个回答");
  await send(page, "第二个问题", "第二个回答");

  // The switch is immediately effective — a session setting, not a draft — and its state is on
  // `aria-pressed`, so the assertion is about the control rather than about a colour.
  const toggle = page.getByTestId("smart-context-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Compaction has nothing left to stand in for while the mode is on, so the button says so
  // rather than offering a call whose result would never be sent.
  await expect(page.getByTestId("context-compact")).toBeDisabled();

  await send(page, "第三个问题", "第三个回答");
  const sent = JSON.stringify(await requestWith(request, "第三个问题"));
  expect(sent).toContain("第二个问题");
  expect(sent).toContain("第二个回答");
  expect(sent).not.toContain("第一个问题");
  expect(sent).not.toContain("第一个回答");
  // The prompt's own statement of the mode — no tool description carries this fact.
  expect(sent).toContain("smart context mode");

  // Switching it off puts the ordinary context back within reach.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("context-compact")).toBeEnabled();
});

test("the switch can be set before the conversation exists", async ({ page, request }) => {
  await scriptLlm(request, { title: "新建智能", turns: [{ content: "第一个回答" }] });

  await page.goto("/");
  await enterWorkspace(page);

  // No conversation yet, so this stages the setting the way every other welcome-screen control
  // does — `updateSettings` writes `draftSettings` until there is a session to PATCH.
  const toggle = page.getByTestId("smart-context-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await send(page, "第一个问题", "第一个回答");
  const sent = JSON.stringify(await requestWith(request, "第一个问题"));
  expect(sent).toContain("smart context mode");
});
