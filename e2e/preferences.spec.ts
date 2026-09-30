import { expect, test, type APIRequestContext, type Page } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { selectText } from "./notes";
import { enterWorkspace } from "./workspaces";

/**
 * User preferences end to end: a stated rule is recorded, listed in the right-hand panel,
 * injected into every later request, and removable.
 *
 * The part only a browser can check is the *gesture*: a real selection producing the toolbar's
 * "作为用户偏好" button, and the panel appearing from the server-side install a manual save
 * performs. The injection half is read off the wire, the smart-context spec's proof-shape.
 */

/** The marker `preference.system` carries — see `fakeLlm.ts`. */
const EXTRACT_MARKER = "user-preference extraction function";

/** A streamed request whose body carries a phrase. */
async function requestWith(
  request: APIRequestContext,
  phrase: string
): Promise<Record<string, unknown>> {
  const sent = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as {
    stream?: boolean;
  }[];
  const found = sent
    .filter((r) => r.stream === true)
    .find((r) => JSON.stringify(r).includes(phrase));
  if (!found) throw new Error(`no streamed request carried ${JSON.stringify(phrase)}`);
  return found;
}

/** A workspace and a conversation, from the home page. */
async function preferenceSession(page: Page, name: string): Promise<void> {
  await page.goto("/");
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);

  await page.getByTestId("new-session").click();
  await page.getByTestId("create-session").click();
}

/** Send a turn and wait for it to finish, not merely for the first token to render. */
async function send(page: Page, message: string, reply: string): Promise<void> {
  await page.getByTestId("composer-input").fill(message);
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").last()).toContainText(reply, {
    timeout: 15_000,
  });
  // The bubble is replaced by the persisted message at `message_done`, and a selection made
  // during that swap would collapse — see `notes.spec.ts`, which waits the same way.
  await expect(page.getByTestId("composer-send")).toBeVisible({ timeout: 20_000 });
}

test("records a stated preference, lists it, injects it when switched on, and deletes it", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "用户偏好",
    turns: [
      {
        content: "好的，我记下来。",
        toolCalls: [
          {
            id: "call_pref",
            name: "ila_save_preference",
            args: { type: "positive", content: "回答先给结论" },
          },
        ],
      },
      { content: "记住了。" },
      { content: "第二个回答" },
    ],
  });

  await preferenceSession(page, `Preferences ${Date.now()}`);
  await send(page, "我希望以后回答先给结论", "记住了。");

  // The call installs the panel (`auto-install`, the diagram's rule applied to a memory), and
  // the row is the rule the tool wrote — with its kind as a tag.
  await page.getByTestId("widget-tab-preferences").click();
  await expect(page.getByTestId("preferences-list")).toContainText("回答先给结论");
  await expect(page.getByTestId("preferences-list")).toContainText("期望");

  // Injection is built in — no switch to flip: the very next turn already carries the rule.
  await send(page, "第二个问题", "第二个回答");
  const sent = JSON.stringify(await requestWith(request, "第二个问题"));
  expect(sent).toContain("<user_preferences>");
  expect(sent).toContain("回答先给结论");

  // Deleting goes through the app's confirm, like every other destructive control, and the
  // empty state replaces the row once it is accepted.
  await page.getByTestId("preference-delete").click();
  await page.getByTestId("confirm-accept").click();
  await expect(page.getByTestId("preferences-empty")).toBeVisible();
});

test("saves a selected passage as a preference from the selection toolbar", async ({
  page,
  request,
}) => {
  const PHRASE = "以后请用中文解释";
  await scriptLlm(request, {
    title: "偏好提取",
    turns: [{ content: `好的。${PHRASE}。` }],
    matches: [
      {
        includes: EXTRACT_MARKER,
        content: JSON.stringify({
          status: "saved",
          type: "positive",
          content: "回答使用中文",
        }),
      },
    ],
  });

  await preferenceSession(page, `Preference extract ${Date.now()}`);
  await send(page, "开始吧", PHRASE);

  // The gesture: select the passage, take the bar's own action (the host's, like 追问 — it
  // works whether or not any widget holds the conversation's claim).
  await selectText(page, page.getByTestId("message-content").last(), PHRASE);
  await expect(page.getByTestId("note-toolbar")).toBeVisible();
  await page.getByTestId("note-toolbar-preference").click();

  // The route installed the panel on its way out, and the store re-read the installed list, so
  // the tab appears and lists what the extraction stored.
  await page.getByTestId("widget-tab-preferences").click();
  await expect(page.getByTestId("preferences-list")).toContainText("回答使用中文");
});

test("says so when the passage states no standing preference", async ({ page, request }) => {
  const PHRASE = "地球是圆的";
  await scriptLlm(request, {
    title: "没有偏好",
    turns: [{ content: `是的，${PHRASE}。` }],
    matches: [{ includes: EXTRACT_MARKER, content: '{"status":"skipped"}' }],
  });

  await preferenceSession(page, `Preference skip ${Date.now()}`);
  await send(page, "讲个常识", PHRASE);

  await selectText(page, page.getByTestId("message-content").last(), PHRASE);
  await page.getByTestId("note-toolbar-preference").click();

  // A press that produced nothing must answer rather than look broken; the toast is the app's
  // global channel for that.
  await expect(page.getByTestId("toast")).toContainText("没有可记录");
});
