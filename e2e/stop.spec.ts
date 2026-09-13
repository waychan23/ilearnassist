import { expect, test, type Page } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Stopping a reply from the composer, in a real browser.
 *
 * The scripted turn is paused (`holdMs`) — without that the fake model writes a whole turn
 * in one burst and there is no moment at which a Stop control could be pressed at all.
 */

const HELD_REPLY = "这句话还没说完";

/**
 * A workspace of this spec's own, entered.
 *
 * `chat.spec.ts` asserts on how many conversations the default workspace holds, so a spec
 * that has one of its own has to bring one — see the note in `ask-user.spec.ts`.
 */
async function createAndEnter(page: Page, name: string): Promise<void> {
  await page.getByTestId("workspace-new").click();
  await page.getByTestId("workspace-name-input").fill(name);
  await page.getByTestId("workspace-create-submit").click();
  await enterWorkspace(page, name);
}

test("the send control becomes Stop, and stopping keeps the partial reply", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "被打断的对话",
    turns: [{ content: HELD_REPLY, holdMs: 1500 }],
  });

  const workspace = `停一停 ${Date.now()}`;
  await page.goto("/");
  await createAndEnter(page, workspace);

  await page.getByTestId("composer-input").fill("讲一个很长的故事");
  await page.getByTestId("composer-send").click();

  // While the reply streams the corner holds Stop rather than a disabled Send.
  const stop = page.getByTestId("composer-stop");
  await expect(stop).toBeVisible();
  await expect(page.getByTestId("composer-send")).toHaveCount(0);

  // The part that has arrived is already on screen — that is what the user is deciding
  // whether to keep reading.
  await expect(page.getByTestId("message-content")).toContainText(HELD_REPLY);

  await stop.click();

  // The turn winds up rather than erroring: the control goes back to Send, and no error
  // banner is left behind.
  await expect(page.getByTestId("composer-send")).toBeVisible();
  await expect(page.getByTestId("composer-stop")).toHaveCount(0);
  await expect(page.locator(".error-banner")).toHaveCount(0);

  // The partial reply is kept and marked, instead of vanishing with the stream.
  await expect(page.getByTestId("message-assistant").last()).toContainText(HELD_REPLY);
  await expect(page.getByTestId("message-stopped")).toBeVisible();

  // The stop reached the model: the fake provider saw its request closed mid-turn, so this
  // was a real cancellation rather than the UI merely looking away. Polled, because the
  // provider notices the hang-up on its own socket event — a moment behind the stream the
  // browser has already finished reading.
  await expect
    .poll(async () => {
      const state = await request.get(`${FAKE_LLM}/__state`);
      return ((await state.json()) as { aborted: number }).aborted;
    })
    .toBe(1);

  // It came back from the database rather than from memory. A reload lands on the workspace
  // home, so this is also the trip a user would actually make.
  // By name, not by position: cards are ordered oldest-first, so the default "first card"
  // is the suite's seeded workspace rather than this spec's.
  await page.reload();
  await enterWorkspace(page, workspace);
  await page.getByTestId("session-item").first().click();
  await expect(page.getByTestId("message-stopped")).toBeVisible();
  await expect(page.getByTestId("message-assistant").last()).toContainText(HELD_REPLY);
});

test("a turn stopped before any text arrived still says what happened", async ({
  page,
  request,
}) => {
  // The reply is held from the very first frame, so Stop lands on an empty message. That
  // one still needs to explain itself: an assistant bubble with nothing in it and no note
  // is indistinguishable from a failure.
  await scriptLlm(request, {
    title: "空手而归",
    turns: [{ content: "", holdMs: 1500 }],
  });

  await page.goto("/");
  await createAndEnter(page, `停得早 ${Date.now()}`);

  await page.getByTestId("composer-input").fill("先说点什么");
  await page.getByTestId("composer-send").click();

  await page.getByTestId("composer-stop").click();

  await expect(page.getByTestId("message-stopped")).toBeVisible();
  await expect(page.getByTestId("message-content")).toHaveCount(0);
});
