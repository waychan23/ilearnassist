import { expect, test } from "@playwright/test";
import { scriptLlm } from "./llm";

/**
 * The phone. Runs under the `mobile` project — a Pixel 7 viewport with `hasTouch` and
 * `isMobile`, which is what turns on meta-viewport emulation and so what actually drives the
 * responsive CSS. The three desktop specs ignore this file by name.
 *
 * What is asserted here is what only a browser can answer: whether a rule *won*, whether the
 * page overflows once the real content is in it, and what the compositor did with a tap. The
 * source-level halves live in `style.test.ts` and `composables/breakpoints.test.ts`.
 */

/** Send one message and wait for the turn to settle. */
async function converse(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  text: string,
) {
  await scriptLlm(request, { turns: [{ content: "好的。" }] });
  await page.goto("/");
  await page.getByTestId("composer-input").fill(text);
  await page.getByTestId("composer-send").click();
  await page.getByTestId("message-assistant").last().locator(".actions").waitFor();
}

test("touch: the message actions are visible without a hover", async ({ page, request }) => {
  // They are revealed by `.msg:hover`, which never fires on a touch screen — so on a phone
  // the copy button, the only way to get a reply's text out, was permanently invisible.
  await converse(page, request, "你好");

  const actions = page.getByTestId("message-assistant").last().locator(".actions");
  await expect(actions).toHaveCSS("opacity", "1");
});

test("touch: one tap opens the token popover, and it stays open", async ({ page, request }) => {
  // The regression this exists for: `@mouseenter` set `open` true and the `@click` on the
  // same element immediately set it back, so a tap opened and shut it in one gesture and
  // there was no `mouseleave` on a touch screen to reset the state either. The popover could
  // never be seen at all.
  await converse(page, request, "你好");

  const popover = page.locator(".overlay-popover.popover");
  const button = page.getByTestId("composer-input").locator("xpath=../../..").locator(".token-btn");

  await expect(popover).toBeHidden();
  await button.tap();
  await expect(popover).toBeVisible();

  // Tapping elsewhere dismisses it — the touch equivalent of moving the mouse away.
  await page.locator(".topbar").tap();
  await expect(popover).toBeHidden();
});
