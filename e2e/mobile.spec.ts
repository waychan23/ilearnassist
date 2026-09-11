import { expect, test } from "@playwright/test";
import { scriptLlm } from "./llm";
import { enterWorkspace } from "./workspaces";

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
  await enterWorkspace(page);
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

test("layout: the sidebar is a drawer, and the pane gets the whole width", async ({
  page,
  request,
}) => {
  // The measured failure this exists for: at 375px the sidebar took 272px of it and the chat
  // pane was 103px, so a user's message rendered one character per line.
  await converse(page, request, "你好");

  const sidebar = page.getByTestId("sidebar");
  const pane = page.locator(".main");

  await expect(sidebar).toBeHidden();
  expect((await pane.boundingBox())?.width).toBeCloseTo(412, 0);

  await page.getByTestId("nav-toggle").tap();
  await expect(sidebar).toBeVisible();
  await expect(page.getByTestId("drawer-backdrop")).toBeVisible();

  await page.getByTestId("drawer-backdrop").tap({ position: { x: 380, y: 400 } });
  await expect(sidebar).toBeHidden();
});

test("layout: focus enters the drawer and comes back to the toggle", async ({ page, request }) => {
  await converse(page, request, "你好");

  const toggle = page.getByTestId("nav-toggle");
  await toggle.tap();

  expect(
    await page.evaluate(() => document.activeElement?.closest(".sidebar") !== null),
  ).toBe(true);

  // Escape is the keyboard path out — there is no close button in the drawer.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar")).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe(
    "nav-toggle",
  );
});

test("layout: one Escape closes the confirm prompt, not the drawer under it", async ({
  page,
  request,
}) => {
  // Both `ConfirmDialog` and the drawer listen on `window` for Escape. Without the guard in
  // `App.vue` a single press closes both: the prompt disappears and the thing that asked for
  // it slides away underneath.
  await converse(page, request, "你好");

  await page.getByTestId("nav-toggle").tap();
  await page.getByTestId("sidebar").locator(".session-item .icon-btn.danger").first().tap();

  const prompt = page.locator("body > .modal-overlay");
  await expect(prompt).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId("sidebar")).toBeVisible();
});

test("layout: the closed drawer is not reachable by keyboard", async ({ page, request }) => {
  // `visibility: hidden` on the closed panel is what keeps its back-to-workspaces row, its
  // glyph buttons, every session row and the settings entry out of the tab order. Without it
  // they are focusable and announced while off-screen.
  await converse(page, request, "你好");
  await expect(page.getByTestId("sidebar")).toBeHidden();

  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(
      () => document.activeElement?.closest(".sidebar") !== null,
    );
    expect(inside, `focus entered the closed drawer after ${i + 1} tabs`).toBe(false);
  }
});

test("layout: nothing overflows the phone, even with the widest controls open", async ({
  page,
  request,
}) => {
  await converse(page, request, "你好");

  const overflow = async () =>
    page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));

  expect(await overflow()).toEqual({ scroll: 412, client: 412 });

  // The three fixed-width offenders: a 280px menu, a 220px model button and a 260px popover,
  // all anchored `right: 0` upward.
  await page.locator(".model-btn").tap();
  await expect(page.locator(".overlay-popover.menu")).toBeVisible();
  expect(await overflow(), "the model menu overflows").toEqual({ scroll: 412, client: 412 });

  await page.locator(".topbar").tap();
  await page.locator(".token-btn").tap();
  await expect(page.locator(".overlay-popover.popover")).toBeVisible();
  expect(await overflow(), "the token popover overflows").toEqual({ scroll: 412, client: 412 });
});

test("layout: a dialog opened from the drawer covers the whole screen", async ({
  page,
  request,
}) => {
  // The teleport check. The sidebar is `position: fixed` inside a `transform`, and a fixed
  // element whose ancestor is transformed is positioned against that ancestor — so a
  // `.modal-overlay` left inside the sidebar would be laid out in the off-canvas drawer and
  // render off-screen. Asserting the parent is `body` is the actual invariant.
  await converse(page, request, "你好");

  await page.getByTestId("nav-toggle").tap();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.getByTestId("open-settings").tap();

  const dialog = page.locator("body > .modal-overlay");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("sidebar")).toBeHidden();

  // Fits inside the viewport. It is *not* full width yet — the base `.modal` keeps its
  // `max-width: calc(100vw - 40px)` — which is the narrow-screen polish, not this step.
  const box = await page.locator("body > .modal-overlay .modal").boundingBox();
  expect(box?.width).toBeLessThanOrEqual(412);
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
});

test("narrow: the composer keeps the whole row reachable", async ({ page, request }) => {
  // Five controls on one line no longer fit, and the reflow must not push the send button
  // below the fold or shrink it out of reach.
  await converse(page, request, "你好");

  const input = page.getByTestId("composer-input");
  const send = page.getByTestId("composer-send");

  for (const [name, locator] of [
    ["composer-input", input],
    ["composer-send", send],
  ] as const) {
    const box = await locator.boundingBox();
    expect(box, `${name} is not laid out`).not.toBeNull();
    expect(box!.y + box!.height, `${name} is below the fold`).toBeLessThanOrEqual(839);
    expect(box!.x, `${name} starts off-screen`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${name} runs off the right edge`).toBeLessThanOrEqual(412);
  }

  // 44px, because sending is the one control the whole screen exists for.
  const sendBox = (await send.boundingBox())!;
  expect(sendBox.width).toBeGreaterThanOrEqual(44);
  expect(sendBox.height).toBeGreaterThanOrEqual(44);
});

test("narrow: dialogs become bottom sheets", async ({ page, request }) => {
  await converse(page, request, "你好");

  // Settings lives in the sidebar, which is a drawer at this width.
  await page.getByTestId("nav-toggle").tap();
  await page.getByTestId("open-settings").tap();

  const modal = page.locator("body > .modal-overlay .modal");
  await expect(modal).toBeVisible();

  const box = (await modal.boundingBox())!;
  // Full width, and flush to the bottom edge rather than centred.
  expect(box.width).toBeCloseTo(412, 0);
  expect(box.y + box.height).toBeCloseTo(839, 0);
});

test("narrow: a popover becomes a sheet instead of hanging off the edge", async ({
  page,
  request,
}) => {
  // Anchored `right: 0` above a control near the right edge, the 280px menu has nowhere to
  // go at this width — so it stops being anchored at all.
  await converse(page, request, "你好");

  await page.locator(".model-btn").tap();
  const menu = page.locator(".overlay-popover.menu");
  await expect(menu).toBeVisible();

  const box = (await menu.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(412);
});

test("layout: a resize back to desktop restores the inline sidebar", async ({ page, request }) => {
  // Layout state that is only read once would leave the drawer semantics in place on a wide
  // screen — a hidden sidebar and a toggle for a drawer nobody needs.
  await converse(page, request, "你好");
  await expect(page.getByTestId("nav-toggle")).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 800 });

  await expect(page.getByTestId("nav-toggle")).toBeHidden();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  expect((await page.getByTestId("sidebar").boundingBox())?.width).toBeCloseTo(272, 0);
});
