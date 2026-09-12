import { expect, test, type Page } from "@playwright/test";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * Reading back through a reply that is still being written.
 *
 * The message list follows its own content, and it used to follow it unconditionally — the
 * viewport was put back at the end on every streamed delta. So a reader who scrolled up was
 * returned to the end on the next token, and on the one after that: a list that fought the
 * scrollbar for as long as the turn lasted.
 *
 * The unit tests cover the release itself; what is only reachable from here is the wiring —
 * that a real scroll event releases the follow, that the turn's later growth respects it, and
 * that the control the release puts on screen brings the reader back. `composables/scrollFollow.ts`
 * is deliberately not unit-testable on that last point, since it is the renderer that decides
 * what `following` means.
 *
 * The scripted turns are held (`holdMs`) for the same reason `stop.spec.ts` holds them:
 * without it a turn is written in one burst, and there is no moment at which a reader could
 * have scrolled at all.
 */

/** Held after every frame, so the reply is still arriving while the test scrolls. */
const HELD_MS = 500;

/** The final answer, asserted into view at the end. */
const FINAL = "这是最后的答案。";

/**
 * A long first reply, so the list overflows the pane and the scrollbar is real.
 *
 * Repeated rather than one long paragraph: a wall of text with no break is one huge line box
 * in a 860px column, and the point is height.
 */
const FILLER = "这一段只是用来把消息列表撑得比视口更高，好让滚动条真的存在。\n".repeat(40);

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

/** The scroller's position, as the browser reports it. */
async function metrics(page: Page): Promise<{
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}> {
  return page.getByTestId("messages").evaluate((el) => ({
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
}

/** How far the end of the list is from the viewport — zero with it parked at the bottom. */
async function distanceFromBottom(page: Page): Promise<number> {
  const m = await metrics(page);
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

test("scrolling up during a reply keeps the reader there, and the way back is offered", async ({
  page,
  request,
}) => {
  await scriptLlm(request, {
    title: "边写边读",
    turns: [
      // The first exchange, complete. Its only job is to make the list taller than the pane.
      { content: FILLER },
      // Then a turn that keeps growing after the reader has taken over: a preamble, a tool
      // card, and only later the answer. Each of those is a height change the list used to be
      // dragged to the end of.
      {
        content: "我先看看工作区里有什么。",
        reasoning: "先列一下文件。",
        toolCalls: [{ id: "call_1", name: "list_files", args: {} }],
        holdMs: HELD_MS,
      },
      { content: FINAL, holdMs: HELD_MS },
    ],
  });

  await page.goto("/");
  await createAndEnter(page, `滚动 ${Date.now()}`);

  await page.getByTestId("composer-input").fill("先随便写点长的");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-assistant").first()).toBeVisible();
  await expect(page.getByTestId("composer-send")).toBeVisible();

  // The precondition the whole spec rests on: there is somewhere to scroll to. Asserted
  // rather than assumed, because a shorter reply would leave the scrollbar absent and every
  // assertion below would pass while testing nothing.
  const first = await metrics(page);
  expect(
    first.scrollHeight,
    "the first reply does not overflow the pane — there is no scroll to test",
  ).toBeGreaterThan(first.clientHeight + 100);

  await page.getByTestId("composer-input").fill("再写一轮");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("message-user").last()).toContainText("再写一轮");

  // A wheel gesture, not an assignment to `scrollTop`: the release hangs off the scroll event,
  // and the point is that the gesture a reader actually makes is the one that reaches it.
  const messages = page.getByTestId("messages");
  await messages.hover();
  await page.mouse.wheel(0, -4000);

  // The control is rendered from the released state, so it appearing is the signal that the
  // gesture was seen — no sleep needed to wait for the scroll event.
  const jump = page.getByTestId("jump-to-latest");
  await expect(jump).toBeVisible();
  expect((await metrics(page)).scrollTop, "the wheel did not reach the top").toBe(0);

  // The reply keeps arriving from here on. The tool card is the tallest of those steps.
  await expect(page.getByTestId("tool-call").first()).toBeVisible();
  expect(
    (await metrics(page)).scrollTop,
    "a growth after the reader scrolled up dragged the viewport back down",
  ).toBe(0);

  await expect(page.getByTestId("message-assistant").last()).toContainText(FINAL);
  expect((await metrics(page)).scrollTop).toBe(0);
  expect(await distanceFromBottom(page), "the reader was moved off the top").toBeGreaterThan(100);

  // And the way back. One click, and the follow is live again rather than merely recorded —
  // which is why the control has to be gone afterwards.
  await jump.click();
  await expect(jump).toHaveCount(0);
  await expect(page.getByTestId("message-assistant").last()).toBeInViewport();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(1);
});
