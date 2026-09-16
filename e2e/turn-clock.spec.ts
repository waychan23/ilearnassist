import { expect, test, type APIRequestContext } from "./fixtures";
import { FAKE_LLM, scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

/**
 * What the model is told about the time, through a real browser.
 *
 * The unit tests hold the formatting (`agent/clock.test.ts`) and the wiring
 * (`chat-sse.test.ts`) to their halves; what only a browser can answer is the *whole* chain at
 * once — that Chromium's own zone is what reaches the server, that the server's own zone is not
 * quietly substituted for it, and that a real turn carries the result.
 *
 * That first link is the reason this is a browser spec rather than another route test: nothing
 * below the browser can prove that the client sends the zone, and a client that stopped sending
 * one would still pass every server-side test while every user saw the server's clock.
 */

/** The last chat (streaming) request the fake LLM received, as parsed JSON. */
async function lastTurn(request: APIRequestContext): Promise<{ messages: { content: unknown }[] }> {
  const sent = (await (await request.get(`${FAKE_LLM}/__requests`)).json()) as { stream?: boolean }[];
  const turn = sent.find((r) => r.stream === true);
  expect(turn, "no streamed turn was recorded").toBeTruthy();
  return turn as { messages: { content: unknown }[] };
}

/** Send one message and wait for the turn to settle. */
async function say(page: import("@playwright/test").Page, text: string): Promise<void> {
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  await page.getByTestId("message-assistant").last().locator(".actions").waitFor();
}

/*
 * A zone with a whole-hour offset and no daylight saving since 1991, so the expected string is
 * the same in every month. Pinned on the *browser* with `timezoneId`, which is the only way to
 * make this deterministic: the suite otherwise inherits the machine's zone, and an assertion
 * written against that passes where it was written and nowhere else.
 */
test.use({ timezoneId: "Asia/Shanghai" });

test("the turn states the browser's own date, time and zone", async ({ page, request }) => {
  await scriptLlm(request, { turns: [{ content: "好的。" }] });
  await page.goto("/");
  await enterWorkspace(page);
  await say(page, "现在几点了？");

  const system = JSON.stringify((await lastTurn(request)).messages[0]!.content);

  // The zone the browser reported, and not the server's — the two are the same machine here, so
  // the assertion is on the exact label rather than on "some zone made it".
  expect(system).toContain("Asia/Shanghai, UTC+08:00");

  /*
   * And the date is *today's*, computed here rather than written out. This is the assertion the
   * whole feature exists for: a model asked about "today" without a date answers from its
   * training data, so what has to be true is that the day on the wire is the day it is — a
   * prompt that stated a fixed or stale date would satisfy every string check above and fail
   * this one.
   */
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  expect(system).toContain(today);

  // The time as well as the date, in a shape a model cannot misread as day-month. Asserted as a
  // shape because the minute is whatever it is when the turn ran.
  expect(system).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});

test("the zone travels on a turn that has nothing to do with time", async ({ page, request }) => {
  /*
   * The instruction is unconditional on purpose. The failure being fixed is a model that does
   * not know it should have checked the date, so a prompt that only mentioned time when asked
   * about it would arrive after the answer had already been written.
   */
  await scriptLlm(request, { turns: [{ content: "好的。" }] });
  await page.goto("/");
  await enterWorkspace(page);
  await say(page, "帮我把这段话润色一下。");

  expect(JSON.stringify((await lastTurn(request)).messages[0]!.content)).toContain(
    "Asia/Shanghai, UTC+08:00"
  );
});
